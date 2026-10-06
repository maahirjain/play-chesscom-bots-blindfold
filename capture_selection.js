// capture_selection.js
//
// Task 4.3 (PLAN.md §4.3): screen/tab capture selection and permission
// handling. Lives ONLY in the offscreen recording context (recorder.html),
// next to device_selection.js — never in content scripts, never in the
// service worker.
//
// Deliberate divergence from 4.2 (4.2 §1): getDisplayMedia has no stable
// deviceId, so 4.3 does NOT reuse createDeviceSelector. This module has a
// parallel shape (persisted preference, probe, queryable state, events)
// so reviewers can compare the two designs side by side.
//
// 4.3 delivers a selected, permitted capture CONFIGURATION — not a
// recording. Every probe stream's tracks are stopped before
// requestPermission resolves; 4.6 re-acquires at Start and owns stream
// lifetime (the revoked-between-probe-and-Start race is 4.6's case).
//
// The chrome.* split (4.2's empirical finding: offscreen documents expose
// only chrome.runtime): all chrome.* calls (tabs.query, permissions.
// contains, tabCapture.getMediaStreamId) live SW-side in capture_broker.js.
// This module consumes them through the injected `broker` object:
//
//   broker.resolveTargetTab()      → { ok, tabId, tabTitle }
//                                    | { ok, tabId: null, tabTitle: null,
//                                        reason: 'no-target-tab' }
//   broker.queryCapturePermission()→ { ok, permissionState: 'granted'|'denied' }
//   broker.getStreamId(tabId)      → { ok, streamId } | { ok:false, error }
//
// In production recorder.js implements the broker as sendMessage
// round-trips to the SW ('capture-resolve-tab', 'capture-query-permission',
// 'capture-get-stream-id' on the {kind:'recorder'} channel). In Node tests
// it is a fake. The streamId travels SW → recorder as a request field,
// is never persisted, and is single-use.
//
// Dependency-free classic script → guarded BlindfoldSession global → IIFE
// 'use strict' → Node module.exports shim (repo house convention).

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Constants.
  // ------------------------------------------------------------------

  var MODE_TAB = 'tab';
  var MODE_SCREEN = 'screen';
  var CAPTURE_MODES = Object.freeze([MODE_TAB, MODE_SCREEN]);

  // Persisted capture-mode preference. 5.3 "remember previous selections"
  // reads this key. Permission state is NEVER persisted (revocable in
  // browser UI at any time; re-derived per query/probe). Tab ids are
  // re-resolved per boot/Start (never persisted — they are unstable).
  var STORAGE_KEY = 'blindfold.captureMode.v1';

  // 'prompt' is the honest screen-mode state (the picker IS the
  // permission; it happens at Start — 4.6). 'unavailable' covers "the
  // platform lacks the API" (very old Chrome / API removed).
  var PERMISSION_STATES = Object.freeze(
    ['granted', 'denied', 'prompt', 'unknown', 'unavailable']);
  var PERMISSION_SOURCES = Object.freeze(['query', 'request']);
  var SELECTION_SOURCES = Object.freeze(['user', 'restored', 'invalidated']);

  var EVENT_PERMISSION_CHANGED = 'screen_capture_permission_changed';
  var EVENT_CAPTURE_SELECTED = 'screen_capture_selected';

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

  function requireCaptureMode(value, what) {
    if (CAPTURE_MODES.indexOf(value) === -1) {
      throw new RangeError(what + " must be 'tab' or 'screen'");
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

  function requireValidScreenCapturePermissionChangedPayload(payload) {
    requireExactKeys(payload,
      ['captureMode', 'permissionState', 'source', 'errorName'],
      'screen_capture_permission_changed payload');
    if (CAPTURE_MODES.indexOf(payload.captureMode) === -1) {
      throw new RangeError(
        "screen_capture_permission_changed payload.captureMode must be 'tab' or 'screen'");
    }
    if (PERMISSION_STATES.indexOf(payload.permissionState) === -1) {
      throw new RangeError(
        'screen_capture_permission_changed payload.permissionState must be one of: ' +
        PERMISSION_STATES.join(', '));
    }
    if (PERMISSION_SOURCES.indexOf(payload.source) === -1) {
      throw new RangeError(
        "screen_capture_permission_changed payload.source must be 'query' or 'request'");
    }
    if (payload.errorName !== null && typeof payload.errorName !== 'string') {
      throw new TypeError(
        'screen_capture_permission_changed payload.errorName must be a string or null');
    }
    return payload;
  }

  function requireValidScreenCaptureSelectedPayload(payload) {
    requireExactKeys(payload,
      ['captureMode', 'tabId', 'tabTitle', 'source'],
      'screen_capture_selected payload');
    if (payload.captureMode !== null && CAPTURE_MODES.indexOf(payload.captureMode) === -1) {
      throw new RangeError(
        "screen_capture_selected payload.captureMode must be 'tab', 'screen' or null");
    }
    if (payload.tabId !== null &&
        (typeof payload.tabId !== 'number' || payload.tabId < 0)) {
      throw new TypeError(
        'screen_capture_selected payload.tabId must be a non-negative number or null');
    }
    if (payload.tabTitle !== null && typeof payload.tabTitle !== 'string') {
      throw new TypeError(
        'screen_capture_selected payload.tabTitle must be a string or null');
    }
    if (SELECTION_SOURCES.indexOf(payload.source) === -1) {
      throw new RangeError(
        'screen_capture_selected payload.source must be one of: ' +
        SELECTION_SOURCES.join(', '));
    }
    return payload;
  }

  BlindfoldSession.requireValidScreenCapturePermissionChangedPayload =
    requireValidScreenCapturePermissionChangedPayload;
  BlindfoldSession.requireValidScreenCaptureSelectedPayload =
    requireValidScreenCaptureSelectedPayload;
  BlindfoldSession.CAPTURE_MODES = CAPTURE_MODES;
  BlindfoldSession.CAPTURE_PERMISSION_STATES = PERMISSION_STATES;
  BlindfoldSession.CAPTURE_SELECTION_SOURCES = SELECTION_SOURCES;
  BlindfoldSession.SCREEN_CAPTURE_PERMISSION_CHANGED_EVENT_TYPE = EVENT_PERMISSION_CHANGED;
  BlindfoldSession.SCREEN_CAPTURE_SELECTED_EVENT_TYPE = EVENT_CAPTURE_SELECTED;

  // ------------------------------------------------------------------
  // The capture selector factory.
  //
  // opts:
  //   mediaDevices — injected (production: navigator.mediaDevices; the
  //                  probe's getUserMedia lives here, offscreen-doc side)
  //   storage      — promise-shaped {get,set,remove} (production: the
  //                  document-localStorage adapter; 4.2 precedent)
  //   broker       — the SW-side capture broker client:
  //                  { resolveTargetTab(), queryCapturePermission(),
  //                    getStreamId(tabId) } (production: recorder.js
  //                  sendMessage round-trips; tests: fakes)
  //   emitEvent    — (eventType, payload, refs) → envelope|null (the
  //                  recorder's session-gated emitter)
  //   getSessionId / getGameId — thunks (pre-session inertness, 3.x
  //                  precedent: emission gated, selection persists)
  //   nowUtcIso    — () => UTC ISO string (injectable clock)
  // ------------------------------------------------------------------

  function createCaptureSelector(opts) {
    var o = opts || {};
    var mediaDevices = o.mediaDevices;
    var storage = o.storage;
    var broker = o.broker;
    var emitEvent = o.emitEvent;
    var getSessionId = o.getSessionId;
    var getGameId = o.getGameId;
    var nowUtcIso = typeof o.nowUtcIso === 'function' ?
      o.nowUtcIso : function () { return new Date().toISOString(); };

    if (typeof emitEvent !== 'function') {
      throw new TypeError('createCaptureSelector: emitEvent must be a function');
    }
    if (typeof getSessionId !== 'function' || typeof getGameId !== 'function') {
      throw new TypeError('createCaptureSelector: getSessionId/getGameId must be functions');
    }

    // The persisted preference: 'tab' | 'screen' | null. Starts null on
    // every construction; 4.3 never silently defaults — the absence of a
    // mode is honest state until §5's UI or a test sets it.
    var captureMode = null;
    var selectionSource = null;
    // Last resolved target tab (tab mode only). Re-resolved per boot and
    // per call — never persisted.
    var targetTabId = null;
    var targetTabTitle = null;
    // SF-1 (4.3 review): permission state is deliberately NOT cached here.
    // Every consumer re-derives it via the SW broker (queryCapturePermission
    // / probe outcomes), because the browser-side grant is revocable at any
    // time and a cache would invite trusting stale state. Events carry the
    // state at observation time; getState() re-queries on demand.
    var modesListedAt = null;
    var inflightPermission = null;
    var announcedForSession = {};

    function readMediaDevices() {
      var g = (typeof globalThis !== 'undefined') ? globalThis : null;
      var md = mediaDevices !== undefined ? mediaDevices :
        (g && g.navigator ? g.navigator.mediaDevices : undefined);
      return md || null;
    }

    function requireMediaDevices() {
      var md = readMediaDevices();
      if (!md || typeof md.getUserMedia !== 'function') {
        throw new Error('capture_selection: navigator.mediaDevices.getUserMedia is unavailable');
      }
      return md;
    }

    function readStorage() {
      return storage !== undefined ? storage : null;
    }

    function requireStorage() {
      var st = readStorage();
      if (!st || typeof st.get !== 'function' || typeof st.set !== 'function') {
        throw new Error('capture_selection: selection storage is unavailable');
      }
      return st;
    }

    function requireBroker() {
      if (!broker || typeof broker.resolveTargetTab !== 'function' ||
          typeof broker.queryCapturePermission !== 'function' ||
          typeof broker.getStreamId !== 'function') {
        throw new Error('capture_selection: the SW capture broker is unavailable');
      }
      return broker;
    }

    function isActive() {
      var sid = getSessionId();
      var gid = getGameId();
      return typeof sid === 'string' && sid !== '' &&
             typeof gid === 'string' && gid !== '';
    }

    function eventIdOf(result) {
      return result && typeof result.eventId === 'string' ? result.eventId : null;
    }

    // Emit a screen_capture_selected event. Inert pre-session (the
    // selection persists as a setting; only the event is inert — 4.2
    // precedent). A throwing emitEvent propagates to the channel handler
    // which converts it to {ok:false} (3.2 SF-1).
    function emitCaptureSelected(mode, tabId, tabTitle, source) {
      var payload = requireValidScreenCaptureSelectedPayload({
        captureMode: mode, tabId: tabId, tabTitle: tabTitle, source: source
      });
      if (!isActive()) {
        return null;
      }
      return eventIdOf(emitEvent(EVENT_CAPTURE_SELECTED, payload, null));
    }

    function emitPermissionChanged(mode, state, source, errorName) {
      var payload = requireValidScreenCapturePermissionChangedPayload({
        captureMode: mode, permissionState: state, source: source,
        errorName: errorName
      });
      if (!isActive()) {
        return null;
      }
      return eventIdOf(emitEvent(EVENT_PERMISSION_CHANGED, payload, null));
    }

    // Ask the SW broker for the current game-tab target. Never throws:
    // "no target tab" is honest data ({ tabId: null }), and a broker
    // failure degrades to the same shape with reason 'broker-error' so a
    // dead SW leg cannot wedge the selector.
    function currentTargetTab() {
      return Promise.resolve()
        .then(function () { return requireBroker().resolveTargetTab(); })
        .then(function (res) {
          if (res && typeof res.tabId === 'number') {
            return { tabId: res.tabId,
                     tabTitle: (typeof res.tabTitle === 'string') ? res.tabTitle : null,
                     reason: null };
          }
          return { tabId: null, tabTitle: null,
                   reason: (res && res.reason) || 'no-target-tab' };
        }, function () {
          return { tabId: null, tabTitle: null, reason: 'broker-error' };
        });
    }

    function tabModeAvailable() {
      // Tab mode needs the SW broker (chrome.tabCapture leg). The broker
      // client exists in the offscreen document; whether the SW side can
      // actually call chrome.tabCapture is determined at probe time and
      // reported honestly ('unavailable').
      try {
        requireBroker();
        return true;
      } catch (e) {
        return false;
      }
    }

    function screenModeAvailable() {
      var md = readMediaDevices();
      return !!(md && typeof md.getDisplayMedia === 'function');
    }

    // Query the tabCapture permission state via the SW broker. The
    // permissions.query advisory pattern from 4.2 does not apply here —
    // the broker already reports the install-time permission directly.
    function queryTabPermission() {
      return Promise.resolve()
        .then(function () { return requireBroker().queryCapturePermission(); })
        .then(function (res) {
          var state = (res && (res.permissionState === 'granted' ||
                               res.permissionState === 'denied')) ?
            res.permissionState : 'unknown';
          return state;
        }, function () {
          return 'unavailable';
        });
    }

    function permissionStateFor(mode) {
      if (mode === MODE_SCREEN) {
        // By platform design: getDisplayMedia permission cannot be queried
        // or probed without showing the picker. 'prompt' is the honest
        // state, not a gap.
        return Promise.resolve('prompt');
      }
      if (mode === MODE_TAB) {
        return queryTabPermission();
      }
      return Promise.resolve('unknown');
    }

    // capture-list-modes: both modes with honest available/
    // permissionState. Tab mode without a matching game tab reports
    // tabId:null + reason 'no-target-tab' — never a silent fallback to
    // the active tab (that could record the wrong tab).
    function listModes() {
      return Promise.resolve()
        .then(function () { return currentTargetTab(); })
        .then(function (target) {
          return permissionStateFor(MODE_TAB).then(function (tabState) {
            modesListedAt = nowUtcIso();
            return {
              ok: true,
              modes: [
                {
                  mode: MODE_TAB,
                  available: tabModeAvailable(),
                  permissionState: tabModeAvailable() ? tabState : 'unavailable',
                  targetTab: target.tabId === null ?
                    { tabId: null, tabTitle: null, reason: target.reason } :
                    { tabId: target.tabId, tabTitle: target.tabTitle }
                },
                {
                  mode: MODE_SCREEN,
                  available: screenModeAvailable(),
                  permissionState: 'prompt'
                }
              ]
            };
          });
        });
    }

    // Persist the mode BEFORE the in-memory selection goes live (4.2 SF-1
    // precedent): a storage failure leaves no phantom selection that the
    // session announcement would then emit.
    function persistMode(mode) {
      var kv = {};
      kv[STORAGE_KEY] = mode;
      return Promise.resolve().then(function () {
        return requireStorage().set(kv);
      });
    }

    // capture-select: validate, persist, then go live and emit. Unknown
    // mode → RangeError internally, surfaced as {ok:false,
    // error:'unknown-mode'} by the channel handler (never thrown across
    // the channel).
    function select(mode) {
      requireCaptureMode(mode, 'capture-select captureMode');
      return currentTargetTab().then(function (target) {
        return persistMode(mode).then(function () {
          captureMode = mode;
          selectionSource = 'user';
          targetTabId = (mode === MODE_TAB) ? target.tabId : null;
          targetTabTitle = (mode === MODE_TAB) ? target.tabTitle : null;
          emitCaptureSelected(mode, targetTabId, targetTabTitle, 'user');
          return { ok: true, selection: mode };
        });
      });
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

    // Map a tab-probe getUserMedia failure to a permission state.
    // NotAllowedError/SecurityError → 'denied'. NotFoundError/
    // InvalidStateError (tab gone mid-probe) → the target is stale.
    // Anything else → 'unknown' with the raw error name preserved.
    function classifyProbeError(err) {
      var name = errName(err);
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        return { permissionState: 'denied', staleTarget: false };
      }
      if (name === 'NotFoundError' || name === 'InvalidStateError') {
        return { permissionState: 'unknown', staleTarget: true };
      }
      return { permissionState: 'unknown', staleTarget: false };
    }

    function onProbeOutcome(mode, state, source, errorName) {
      emitPermissionChanged(mode, state, source, errorName);
      return { ok: true, permissionState: state, errorName: errorName };
    }

    // Tab-mode probe: SW supplies the streamId; the offscreen document
    // consumes it via getUserMedia with the chromeMediaSource constraints
    // (video + audio; audio presence is recorded for 4.7), then stops
    // every track before resolving — no open capture stream is ever
    // retained. 4.6 re-acquires at Start.
    function runTabProbe() {
      var md;
      try {
        md = requireMediaDevices();
      } catch (e) {
        return Promise.resolve({ ok: false, permissionState: 'unavailable',
                                 errorName: errName(e) });
      }
      return currentTargetTab().then(function (target) {
        if (target.tabId === null) {
          // The target vanished (or never existed): the tab binding is
          // invalidated. The mode preference stands — a new game tab may
          // open later — but the record shows tabId:null.
          targetTabId = null;
          targetTabTitle = null;
          emitCaptureSelected(captureMode, null, null, 'invalidated');
          return { ok: false, permissionState: 'unknown',
                   errorName: 'no-target-tab' };
        }
        targetTabId = target.tabId;
        targetTabTitle = target.tabTitle;
        return Promise.resolve()
          .then(function () { return requireBroker().getStreamId(target.tabId); })
          .then(function (res) {
            if (!res || res.ok !== true || typeof res.streamId !== 'string' ||
                res.streamId === '') {
              throw new Error('capture_selection: the SW broker returned no streamId');
            }
            var constraints = {
              video: { mandatory: { chromeMediaSource: 'tab',
                                   chromeMediaSourceId: res.streamId } },
              audio: { mandatory: { chromeMediaSource: 'tab',
                                   chromeMediaSourceId: res.streamId } }
            };
            return md.getUserMedia(constraints);
          })
          .then(function (stream) {
            var audioIncluded = false;
            try {
              var at = (stream && typeof stream.getAudioTracks === 'function') ?
                stream.getAudioTracks() : [];
              audioIncluded = at.length > 0;
            } catch (e) { /* unknown stays unknown */ }
            // Probe-then-stop: no open capture stream is ever retained.
            stopAllTracks(stream);
            emitPermissionChanged(MODE_TAB, 'granted', 'request', null);
            return { ok: true, permissionState: 'granted',
                     audioIncluded: audioIncluded, errorName: null };
          }, function (err) {
            var name = errName(err);
            var classified = classifyProbeError(err);
            if (classified.staleTarget) {
              targetTabId = null;
              targetTabTitle = null;
              emitCaptureSelected(captureMode, null, null, 'invalidated');
            }
            return onProbeOutcome(MODE_TAB, classified.permissionState,
                                  'request', name);
          });
      });
    }

    // capture-request-permission. Tab mode probes (acquire-then-stop);
    // screen mode performs NO media call and reports 'prompt' with the
    // picker-at-start note (honest, not a gap). Concurrent calls share
    // the in-flight probe (4.2 §6.5 builder's choice — documented here).
    // Never throws: the response is always data.
    function requestPermission(mode) {
      requireCaptureMode(mode, 'capture-request-permission captureMode');
      if (inflightPermission) {
        return inflightPermission;
      }
      var p = (mode === MODE_SCREEN) ?
        Promise.resolve({
          ok: true, permissionState: 'prompt',
          note: 'picker-at-start', errorName: null
        }) :
        runTabProbe();
      inflightPermission = p;
      p.then(function () { inflightPermission = null; },
           function () { inflightPermission = null; });
      return p;
    }

    // capture-get-state: the queryable state 4.14 and 5.6 read.
    // tabTitle is null when unavailable — never fabricated.
    function getState() {
      return currentTargetTab().then(function (target) {
        return permissionStateFor(captureMode).then(function (state) {
          return {
            ok: true,
            captureMode: captureMode,
            tabId: captureMode === MODE_TAB ? target.tabId : null,
            tabTitle: captureMode === MODE_TAB ? target.tabTitle : null,
            permissionState: state
          };
        });
      });
    }

    // Boot restore: read the persisted mode; a stored 'tab' re-validates
    // the target tab (tab ids are unstable across browser restarts); a
    // stored 'screen' restores as-is. A vanished target yields
    // source:'invalidated' with tabId:null — the mode preference stands.
    // Silent when inert (no session yet at boot); never throws.
    function restoreOnBoot() {
      return Promise.resolve()
        .then(function () {
          var st = readStorage();
          if (!st) { return null; }
          return st.get(STORAGE_KEY);
        })
        .then(function (kv) {
          var stored = kv ? kv[STORAGE_KEY] : undefined;
          if (CAPTURE_MODES.indexOf(stored) === -1) {
            return null;
          }
          return currentTargetTab().then(function (target) {
            captureMode = stored;
            if (stored === MODE_TAB && target.tabId === null) {
              selectionSource = 'invalidated';
              targetTabId = null;
              targetTabTitle = null;
            } else {
              selectionSource = 'restored';
              targetTabId = (stored === MODE_TAB) ? target.tabId : null;
              targetTabTitle = (stored === MODE_TAB) ? target.tabTitle : null;
            }
            emitCaptureSelected(captureMode, targetTabId, targetTabTitle,
                                selectionSource);
            return { ok: true, selection: stored, source: selectionSource };
          });
        }, function () {
          return null; // boot restore is best-effort
        });
    }

    // Once-per-session announcement of the current selection (4.2
    // precedent): the session's event stream carries the selection state
    // even when the choice predates the session. The announced source is
    // the selection's actual source — never relabeled (4.2 deviation #2
    // precedent).
    function announceSelectionForSession() {
      var sid = getSessionId();
      if (!isActive() || captureMode === null || announcedForSession[sid]) {
        return null;
      }
      announcedForSession[sid] = true;
      return emitCaptureSelected(captureMode, targetTabId, targetTabTitle,
                                 selectionSource || 'user');
    }

    return {
      kind: function () { return 'capture'; },
      storageKey: function () { return STORAGE_KEY; },
      listModes: listModes,
      select: select,
      requestPermission: requestPermission,
      getState: getState,
      restoreOnBoot: restoreOnBoot,
      announceSelectionForSession: announceSelectionForSession
    };
  }

  BlindfoldSession.createCaptureSelector = createCaptureSelector;
})();

// Node test shim. The offscreen document loads this via <script>; only
// environments that provide CommonJS get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
