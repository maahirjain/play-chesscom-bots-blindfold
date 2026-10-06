// device_selection.js
//
// Task 4.2 (PLAN.md §4.2): microphone selection and permission handling.
// Task 4.4 will reuse this factory for webcam (videoinput) selection.
//
// 4.2 delivers a selected, permitted microphone — NOT a recording:
// device enumeration, user selection among devices, a persisted
// selection, a permission-probe flow (getUserMedia → stop tracks
// immediately), queryable permission state, and durable events for
// selection/permission changes. No open microphone stream is ever
// retained: every probe stream's tracks are stopped before
// requestPermission() resolves. 4.6 re-acquires the stream at Start and
// owns stream lifetime.
//
// All microphone platform APIs (navigator.mediaDevices.enumerateDevices,
// getUserMedia) live ONLY in the offscreen recorder context (4.1's rule):
// recorder.js instantiates this factory; recorder.html loads this file
// before recorder.js. Never in content scripts, never in the service
// worker.
//
// Dependency-free classic script → guarded BlindfoldSession global → IIFE
// 'use strict' → Node module.exports shim (repo house convention).
//
// Error conventions (AGENTS.md): TypeError = wrong type/shape (incl.
// malformed IDs); RangeError = bad domain value; plain Error =
// unavailable platform capability (e.g. no mediaDevices — never a weak
// fallback).
//
// Events (4.2-owned event types; event_envelope.js untouched):
//   microphone_permission_changed
//     { permissionState: 'granted'|'denied'|'prompt'|'unknown',
//       source: 'query'|'request', errorName: string|null }
//   microphone_device_selected
//     { deviceId: string|null, label: string|null,
//       source: 'user'|'restored'|'default'|'invalidated' }
// (kind-generic defaults: 'videoinput' instantiates camera_* types for
// 4.4; 4.2 uses the microphone_* defaults.)

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Constants.
  // ------------------------------------------------------------------

  var KIND_AUDIOINPUT = 'audioinput';
  var KIND_VIDEOINPUT = 'videoinput';

  // Storage keys for the persisted selection, per kind. 5.3 "remember
  // previous selections" reads the mic key; permission state is NEVER
  // persisted (revocable in browser UI at any time; re-derived per
  // query/probe).
  var STORAGE_KEYS = {
    audioinput: 'blindfold.micDeviceId.v1',
    videoinput: 'blindfold.cameraDeviceId.v1'
  };

  // Default event-type names per kind. 4.2 uses the microphone_* pair;
  // 4.4 passes the camera_* pair (or relies on these defaults).
  var EVENT_TYPES = {
    audioinput: {
      permissionChanged: 'microphone_permission_changed',
      deviceSelected: 'microphone_device_selected'
    },
    videoinput: {
      permissionChanged: 'camera_permission_changed',
      deviceSelected: 'camera_device_selected'
    }
  };

  var PERMISSION_STATES = Object.freeze(['granted', 'denied', 'prompt', 'unknown']);
  var PERMISSION_SOURCES = Object.freeze(['query', 'request']);
  var SELECTION_SOURCES = Object.freeze(['user', 'restored', 'default', 'invalidated']);

  var MIC_PERMISSION_QUERY_NAME = 'microphone';
  var CAMERA_PERMISSION_QUERY_NAME = 'camera';

  // ------------------------------------------------------------------
  // Private helpers.
  // ------------------------------------------------------------------

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  // Local exact-keys check (dependency-free; event_envelope.js keeps its
  // own private copy — not imported here).
  function requireExactKeys(obj, keys, what) {
    if (!isPlainObject(obj)) {
      throw new TypeError(what + ' must be an object');
    }
    var actual = Object.keys(obj).sort();
    var expected = keys.slice().sort();
    if (actual.length !== expected.length) {
      throw new TypeError(what + ' must have exactly the keys: ' + keys.join(', '));
    }
    for (var i = 0; i < expected.length; i++) {
      if (actual[i] !== expected[i]) {
        throw new TypeError(what + ' must have exactly the keys: ' + keys.join(', '));
      }
    }
    return obj;
  }

  function requireDeviceId(value, what) {
    if (typeof value !== 'string' || value === '') {
      throw new TypeError(what + ' must be a non-empty string');
    }
    return value;
  }

  function errName(err) {
    return (err && typeof err.name === 'string' && err.name) ? err.name : 'Error';
  }

  // ------------------------------------------------------------------
  // Payload validators (exact keys; TypeError/RangeError per AGENTS.md).
  // Exported on the namespace for tests and for the recorder's defense.
  // ------------------------------------------------------------------

  function requireValidPermissionChangedPayload(payload) {
    requireExactKeys(payload, ['permissionState', 'source', 'errorName'],
      'microphone_permission_changed payload');
    if (PERMISSION_STATES.indexOf(payload.permissionState) === -1) {
      throw new RangeError(
        'microphone_permission_changed payload.permissionState must be one of: ' +
        PERMISSION_STATES.join(', '));
    }
    if (PERMISSION_SOURCES.indexOf(payload.source) === -1) {
      throw new RangeError(
        "microphone_permission_changed payload.source must be 'query' or 'request'");
    }
    if (payload.errorName !== null && typeof payload.errorName !== 'string') {
      throw new TypeError(
        'microphone_permission_changed payload.errorName must be a string or null');
    }
    return payload;
  }

  function requireValidDeviceSelectedPayload(payload) {
    requireExactKeys(payload, ['deviceId', 'label', 'source'],
      'microphone_device_selected payload');
    if (payload.deviceId !== null) {
      requireDeviceId(payload.deviceId, 'microphone_device_selected payload.deviceId');
    }
    if (payload.label !== null && typeof payload.label !== 'string') {
      throw new TypeError(
        'microphone_device_selected payload.label must be a string or null');
    }
    if (SELECTION_SOURCES.indexOf(payload.source) === -1) {
      throw new RangeError(
        'microphone_device_selected payload.source must be one of: ' +
        SELECTION_SOURCES.join(', '));
    }
    return payload;
  }

  BlindfoldSession.requireValidPermissionChangedPayload = requireValidPermissionChangedPayload;
  BlindfoldSession.requireValidDeviceSelectedPayload = requireValidDeviceSelectedPayload;
  BlindfoldSession.DEVICE_SELECTION_PERMISSION_STATES = PERMISSION_STATES;
  BlindfoldSession.DEVICE_SELECTION_SOURCES = SELECTION_SOURCES;

  // ------------------------------------------------------------------
  // createDeviceSelector.
  //
  // DOM-free: every platform surface is injected, so the whole selector
  // is unit-testable in Node.
  //
  // opts:
  //   kind          — 'audioinput' (4.2) or 'videoinput' (4.4).
  //   mediaDevices  — navigator.mediaDevices-shaped { enumerateDevices,
  //                   getUserMedia }. Absence → plain Error on use.
  //   storage       — chrome.storage.local-shaped { get, set, remove }
  //                   (promise form). Absence → plain Error on use.
  //   emitEvent     — (eventType, payload, refs) => event|null. The
  //                   recorder's session-gated emitter; returns null when
  //                   inert (pre-session), so selection works as a setting
  //                   while events stay honest.
  //   getSessionId  — () => string|null (3.x thunk precedent).
  //   getGameId     — () => string|null.
  //   permissions   — navigator.permissions-shaped { query }, optional.
  //                   Absence → advisory query skipped, never an error.
  //   eventTypes    — optional { permissionChanged, deviceSelected }
  //                   override; defaults derive from kind.
  //   nowUtcIso     — () => UTC ISO string for devicesEnumeratedAt.
  //
  // Selection is a setting that works with or without a session; EVENTS
  // are inert until sessionId+gameId are set (3.x precedent): select()
  // persists and responds {ok:true} pre-session, but emits nothing.
  // ------------------------------------------------------------------

  function createDeviceSelector(opts) {
    var o = opts || {};
    var kind = o.kind === undefined ? KIND_AUDIOINPUT : o.kind;
    if (kind !== KIND_AUDIOINPUT && kind !== KIND_VIDEOINPUT) {
      throw new RangeError("createDeviceSelector kind must be 'audioinput' or 'videoinput'");
    }
    var mediaDevices = o.mediaDevices === undefined ? readMediaDevices() : o.mediaDevices;
    var storage = o.storage === undefined ? readStorage() : o.storage;
    var emitEvent = o.emitEvent;
    var getSessionId = o.getSessionId;
    var getGameId = o.getGameId;
    var permissions = o.permissions === undefined ? readPermissions() : o.permissions;
    var nowUtcIso = typeof o.nowUtcIso === 'function' ?
      o.nowUtcIso : function () { return new Date().toISOString(); };
    var eventTypes = o.eventTypes || EVENT_TYPES[kind];

    if (typeof emitEvent !== 'function') {
      throw new TypeError('createDeviceSelector emitEvent must be a function');
    }
    if (typeof getSessionId !== 'function') {
      throw new TypeError('createDeviceSelector getSessionId must be a function');
    }
    if (typeof getGameId !== 'function') {
      throw new TypeError('createDeviceSelector getGameId must be a function');
    }

    var storageKey = STORAGE_KEYS[kind];
    var queryName = kind === KIND_AUDIOINPUT ?
      MIC_PERMISSION_QUERY_NAME : CAMERA_PERMISSION_QUERY_NAME;

    // State. selection: deviceId string or null; selectionSource tracks
    // WHERE the current selection came from so session-activation
    // announcements are honest ('user' vs 'restored'). permissionState:
    // last known, 'unknown' until a query or probe says otherwise.
    // devices: last enumeration (for select() validation).
    // restoredAnnounced: sessionIds for which the current selection was
    // already announced.
    var selection = null;
    var selectionSource = null;
    var devices = null;
    var devicesEnumeratedAt = null;
    var permissionState = 'unknown';
    var inflightPermission = null;
    var restoredAnnounced = {};

    function readMediaDevices() {
      var g = (typeof globalThis !== 'undefined') ? globalThis : null;
      var nav = g ? g.navigator : null;
      return (nav && nav.mediaDevices) || null;
    }

    function readStorage() {
      var g = (typeof globalThis !== 'undefined') ? globalThis : null;
      var chromeNs = g ? g.chrome : null;
      var st = chromeNs ? chromeNs.storage : null;
      return (st && st.local) || null;
    }

    function readPermissions() {
      var g = (typeof globalThis !== 'undefined') ? globalThis : null;
      var nav = g ? g.navigator : null;
      return (nav && nav.permissions) || null;
    }

    function requireMediaDevices() {
      if (!mediaDevices ||
          typeof mediaDevices.enumerateDevices !== 'function' ||
          typeof mediaDevices.getUserMedia !== 'function') {
        throw new Error('device_selection: mediaDevices.enumerateDevices/getUserMedia unavailable');
      }
      return mediaDevices;
    }

    function requireStorage() {
      if (!storage || typeof storage.get !== 'function' ||
          typeof storage.set !== 'function') {
        throw new Error('device_selection: chrome.storage.local unavailable');
      }
      return storage;
    }

    function isActive() {
      var sid = getSessionId();
      var gid = getGameId();
      return typeof sid === 'string' && sid !== '' &&
             typeof gid === 'string' && gid !== '';
    }

    function eventIdOf(result) {
      return (result && typeof result.eventId === 'string') ? result.eventId : null;
    }

    // Chrome withholds device labels until permission has been granted at
    // least once (empty string pre-grant). Map empty → null: honest null,
    // never fabricated.
    function normalizeDevice(d) {
      var label = (d && typeof d.label === 'string' && d.label !== '') ? d.label : null;
      var deviceId = (d && typeof d.deviceId === 'string') ? d.deviceId : '';
      return { deviceId: deviceId, label: label, kind: kind };
    }

    function findDevice(deviceId) {
      if (!devices) {
        return null;
      }
      for (var i = 0; i < devices.length; i++) {
        if (devices[i].deviceId === deviceId) {
          return devices[i];
        }
      }
      return null;
    }

    // Emit a device-selected event. Failure-isolated at the recorder's
    // channel boundary; here a throwing emitEvent propagates to the
    // channel handler which converts it to {ok:false} (3.2 SF-1).
    function emitDeviceSelected(deviceId, label, source) {
      var payload = requireValidDeviceSelectedPayload({
        deviceId: deviceId, label: label, source: source
      });
      if (!isActive()) {
        return null;
      }
      return eventIdOf(emitEvent(eventTypes.deviceSelected, payload, null));
    }

    function emitPermissionChanged(state, source, errorName) {
      var payload = requireValidPermissionChangedPayload({
        permissionState: state, source: source, errorName: errorName
      });
      if (!isActive()) {
        return null;
      }
      return eventIdOf(emitEvent(eventTypes.permissionChanged, payload, null));
    }

    // mic-list-devices: enumerate and map. Never throws for an empty
    // device list (zero microphones is an honest observation). The
    // capability check lives inside the promise so a missing
    // mediaDevices rejects (channel-safe) instead of throwing
    // synchronously.
    function listDevices() {
      return Promise.resolve()
        .then(function () { return requireMediaDevices().enumerateDevices(); })
        .then(function (list) {
          var arr = Array.isArray(list) ? list : [];
          devices = arr
            .filter(function (d) { return d && d.kind === kind; })
            .map(normalizeDevice);
          devicesEnumeratedAt = nowUtcIso();
          return { ok: true, devices: devices.map(function (d) {
            return { deviceId: d.deviceId, label: d.label, kind: d.kind };
          }) };
        });
    }

    // mic-select: validate against the last enumeration (enumerating on
    // demand when nothing is cached), persist, respond. Unknown deviceId
    // → RangeError internally, surfaced as {ok:false, error:
    // 'unknown-device'} by the channel handler (never thrown across the
    // channel). The selection persists pre-session; only the event is
    // inert.
    function select(deviceId) {
      requireDeviceId(deviceId, 'mic-select deviceId');
      return ensureEnumerated().then(function () {
        var found = findDevice(deviceId);
        if (!found) {
          throw new RangeError("mic-select: unknown deviceId '" + deviceId + "'");
        }
        // SF-1 (4.2 review): persist BEFORE the in-memory selection goes
        // live, so a storage failure leaves no phantom selection that the
        // session announcement would then emit.
        return Promise.resolve()
          .then(function () {
            var kv = {};
            kv[storageKey] = found.deviceId;
            return requireStorage().set(kv);
          })
          .then(function () {
            selection = found.deviceId;
            selectionSource = 'user';
            emitDeviceSelected(selection, found.label, 'user');
            return { ok: true, selection: selection };
          });
      });
    }

    function ensureEnumerated() {
      if (devices !== null) {
        return Promise.resolve(devices);
      }
      return listDevices().then(function () { return devices; });
    }

    function stopAllTracks(stream) {
      try {
        var tracks = (stream && typeof stream.getTracks === 'function') ?
          stream.getTracks() : [];
        for (var i = 0; i < tracks.length; i++) {
          try { tracks[i].stop(); } catch (e) { /* one bad track must not block the rest */ }
        }
      } catch (e) { /* a stream we cannot inspect is still dropped */ }
    }

    // Map a getUserMedia failure to (permissionState, staleSelection).
    // NotAllowedError/SecurityError → 'denied'. NotFoundError/
    // OverconstrainedError → the selected device is gone: stale. Anything
    // else → 'unknown' with the raw error name preserved on the event.
    function classifyProbeError(err) {
      var name = errName(err);
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        return { permissionState: 'denied', stale: false };
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        return { permissionState: 'unknown', stale: true };
      }
      return { permissionState: 'unknown', stale: false };
    }

    // mic-request-permission: probe via getUserMedia, stop every track
    // immediately, record the outcome. Concurrent calls share the
    // in-flight probe (contract §6.5, builder's choice — documented).
    // Never throws: the response is always data.
    function requestPermission() {
      if (inflightPermission) {
        return inflightPermission;
      }
      var p = runPermissionProbe();
      inflightPermission = p;
      p.then(function () { inflightPermission = null; },
           function () { inflightPermission = null; });
      return p;
    }

    function runPermissionProbe() {
      var md;
      try {
        md = requireMediaDevices();
      } catch (e) {
        return Promise.resolve({ ok: false, permissionState: 'unknown', errorName: errName(e) });
      }
      var constraints = selection !== null ?
        { audio: { deviceId: { exact: selection } } } :
        { audio: true };
      return Promise.resolve()
        .then(function () { return md.getUserMedia(constraints); })
        .then(function (stream) {
          // No open mic stream is ever retained: stop every track before
          // the probe resolves. 4.6 re-acquires at Start.
          stopAllTracks(stream);
          return onProbeOutcome('granted', 'request', null);
        }, function (err) {
          var name = errName(err);
          var classified = classifyProbeError(err);
          if (classified.stale && selection !== null) {
            return invalidateSelection().then(function () {
              return onProbeOutcome(classified.permissionState, 'request', name);
            });
          }
          return onProbeOutcome(classified.permissionState, 'request', name);
        });
    }

    function onProbeOutcome(state, source, errorName) {
      permissionState = state;
      emitPermissionChanged(state, source, errorName);
      var ok = state === 'granted';
      return { ok: ok, permissionState: state, errorName: errorName };
    }

    // Stale selection (device unplugged): clear to null, drop the stored
    // key, and record the honest 'invalidated' event.
    function invalidateSelection() {
      selection = null;
      selectionSource = null;
      var st = null;
      try { st = requireStorage(); } catch (e) { /* storage loss is not fatal here */ }
      var cleared = st ?
        Promise.resolve().then(function () { return st.remove(storageKey); }) :
        Promise.resolve();
      return cleared.then(function () {
        emitDeviceSelected(null, null, 'invalidated');
      }, function () {
        emitDeviceSelected(null, null, 'invalidated');
      });
    }

    // Advisory permission query (non-invasive). Updates the last-known
    // state and emits on change (source 'query'). Absence of
    // navigator.permissions → skip silently: the query is advisory, the
    // getUserMedia outcome is ground truth.
    //
    // Contract §2.3: a probe-observed 'denied' PERSISTS until a later
    // probe succeeds — an advisory query never clears it (the dismissal
    // was observed ground truth; the query is the known-quirky signal).
    // The query can still move any other state (notably granted→denied
    // on external revocation, which only the query can observe).
    function queryPermission() {
      if (!permissions || typeof permissions.query !== 'function') {
        return Promise.resolve({ ok: true, permissionState: permissionState, advisory: true });
      }
      return Promise.resolve()
        .then(function () { return permissions.query({ name: queryName }); })
        .then(function (status) {
          var s = (status && typeof status.state === 'string') ? status.state : null;
          if (PERMISSION_STATES.indexOf(s) !== -1 && s !== permissionState &&
              permissionState !== 'denied') {
            permissionState = s;
            emitPermissionChanged(s, 'query', null);
          }
          return { ok: true, permissionState: permissionState, advisory: true };
        }, function () {
          // Advisory only: a failed query never changes the state.
          return { ok: true, permissionState: permissionState, advisory: true };
        });
    }

    // mic-get-state: the queryable state 4.14 and 5.6 read. Refreshes via
    // the advisory query first so the response is fresh.
    function getState() {
      return queryPermission().then(function () {
        return {
          ok: true,
          selection: selection,
          permissionState: permissionState,
          devicesEnumeratedAt: devicesEnumeratedAt
        };
      });
    }

    // Boot restore: read the persisted selection; if it appears in a
    // fresh enumeration → selection restored (event iff session active);
    // if absent → selection stays null, no event, no silent default.
    function restoreOnBoot() {
      var st;
      try {
        st = requireStorage();
      } catch (e) {
        return Promise.resolve({ ok: true, restored: false, reason: 'storage-unavailable' });
      }
      return Promise.resolve()
        .then(function () { return st.get(storageKey); })
        .then(function (stored) {
          var id = stored ? stored[storageKey] : null;
          if (typeof id !== 'string' || id === '') {
            return { ok: true, restored: false };
          }
          return listDevices().then(function () {
            var found = findDevice(id);
            if (!found) {
              return { ok: true, restored: false, reason: 'device-absent' };
            }
            selection = found.deviceId;
            selectionSource = 'restored';
            // Announce iff a session is already active and not yet
            // announced (V2 race fix: recorder-set-session may arrive
            // before this async restore completes, or after — the
            // restoredAnnounced dedup makes the pair idempotent either
            // way; handleSetSession calls the same announcer).
            announceSelectionForSession();
            return { ok: true, restored: true, selection: selection };
          });
        });
    }

    // Called by the recorder when recorder-set-session activates a
    // session: announce the current selection once per session so the
    // session's event stream carries the selection state (the boot-time
    // restore and any pre-session user selection were inert by design).
    // The announced source is the selection's ACTUAL source ('user' vs
    // 'restored') — never relabeled. A null selection announces nothing
    // — absence is honest.
    function announceSelectionForSession() {
      var sid = getSessionId();
      if (!isActive() || selection === null || !sid) {
        return null;
      }
      if (restoredAnnounced[sid]) {
        return null;
      }
      restoredAnnounced[sid] = true;
      var found = findDevice(selection);
      return emitDeviceSelected(selection, found ? found.label : null,
        selectionSource || 'restored');
    }

    return {
      kind: function () { return kind; },
      storageKey: function () { return storageKey; },
      listDevices: listDevices,
      select: select,
      requestPermission: requestPermission,
      queryPermission: queryPermission,
      getState: getState,
      restoreOnBoot: restoreOnBoot,
      announceSelectionForSession: announceSelectionForSession,
      isActive: isActive,
      // Introspection for tests/V2 (not a channel message).
      debugState: function () {
        return {
          selection: selection,
          permissionState: permissionState,
          devicesEnumeratedAt: devicesEnumeratedAt,
          deviceCount: devices === null ? null : devices.length
        };
      }
    };
  }

  BlindfoldSession.createDeviceSelector = createDeviceSelector;
  BlindfoldSession.DEVICE_SELECTION_STORAGE_KEYS = STORAGE_KEYS;
  BlindfoldSession.DEVICE_SELECTION_EVENT_TYPES = EVENT_TYPES;
})();

// Node test shim. The offscreen document loads this via <script>; only
// environments that provide CommonJS get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
