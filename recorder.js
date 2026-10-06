// recorder.js
//
// Task 4.1 (PLAN.md §4.1): the extension's dedicated recording context — an
// MV3 offscreen document (recorder.html) supervised by the service worker
// (recording_host.js). This is the ONLY place recording platform APIs
// (MediaRecorder, getUserMedia, getDisplayMedia) may ever live: never in
// content scripts, never in the service worker.
//
// 4.1 boundary: context skeleton only — boot identity, recorder-ready
// announcement, the recorder message envelope validator, and the
// ping/pong responder. NO capture code in 4.1 (4.2–4.4 device selection,
// 4.5 formats, 4.6 streams, 4.7 audio routing, 4.8 chunks, 4.9 track/error
// logging, 4.10 segment IDs, 4.11 sync marker, 4.12 timecode, 4.13 Stop
// finalization, 4.14 per-stream status are later tasks; 5.1 owns the UI).
//
// 4.2 (PLAN.md §4.2): microphone selection and permission handling. The
// recorder instantiates device_selection.js's createDeviceSelector
// (kind 'audioinput'; 4.4 adds kind 'videoinput') and routes five new
// recorder-channel messages to it. The selector is purely reactive — §5's
// UI drives it; recording_host.js gains no 4.2 behavior. The recorder
// also owns the session seam (recorder-set-session) and the session-gated
// event emitter that carries the 4.2 events to the existing writer intake
// ({kind:'event', event} direct from this document — no relay, no new
// pipeline, per 4.1 §3).
//
// Dependency-free classic script → guarded BlindfoldSession global → IIFE
// 'use strict' → Node module.exports shim (repo house convention).
//
// Message contract (4.1 owns the channel; later tasks add commands):
//   envelope: { kind: 'recorder', msg: '<name>', v: 1, ...fields }
//   offscreen → SW : 'recorder-ready' { bootId, bootTime }
//   SW → offscreen : 'recorder-ping'  {}
//   offscreen → SW : 'recorder-pong'  { ok, bootId, state, nowMonotonicMs }
//   SW → offscreen : 'recorder-set-session' { sessionId, gameId }
//                    → { ok } (both null clears; re-arms inertness)
//   SW → offscreen : 'mic-list-devices' {}
//                    → { ok, devices: [{ deviceId, label, kind }] }
//   SW → offscreen : 'mic-select' { deviceId }
//                    → { ok, selection } | { ok:false, error }
//   SW → offscreen : 'mic-request-permission' {}
//                    → { ok, permissionState, errorName }
//   SW → offscreen : 'mic-get-state' {}
//                    → { ok, selection, permissionState, devicesEnumeratedAt }
//   SW → offscreen : 'cam-list-devices' {}
//                    → { ok, devices: [{ deviceId, label, kind }] } (4.4)
//   SW → offscreen : 'cam-select' { deviceId }
//                    → { ok, selection } | { ok:false, error }
//   SW → offscreen : 'cam-request-permission' {}
//                    → { ok, permissionState, errorName }
//   SW → offscreen : 'cam-get-state' {}
//                    → { ok, selection, permissionState, devicesEnumeratedAt }
//   4.3 (PLAN.md §4.3): screen/tab capture selection and permission
//   handling. The recorder instantiates capture_selection.js's
//   createCaptureSelector (deliberately NOT the 4.2 device factory —
//   getDisplayMedia has no stable deviceId) and routes four new
//   recorder-channel messages to it. The selector is purely reactive —
//   §5's UI drives it. The SW-side chrome.* calls (tabs.query,
//   permissions.contains, tabCapture.getMediaStreamId) live in
//   capture_broker.js; the recorder reaches them through a broker client
//   that sends 'capture-resolve-tab' / 'capture-query-permission' /
//   'capture-get-stream-id' to the SW on this same channel (recording_host
//   .js routes them). The streamId travels SW → recorder as a request
//   field, is never persisted, and is single-use.
//   4.4 (PLAN.md §4.4): webcam selection and permission handling. The
//   recorder instantiates a second createDeviceSelector (kind
//   'videoinput') and routes the cam-* message family to it — a
//   near-mechanical reuse of 4.2's factory. Probe-then-stop (no stream
//   retained); "saved separately from the screen" is 4.6's stream
//   wiring, not 4.4's.
//   SW → offscreen : 'capture-resolve-tab' / 'capture-query-permission' /
//                    'capture-get-stream-id' (4.3 SW-leg broker messages)
//   SW → offscreen : 'recorder-get-formats' {}
//                    → { ok, formats: { microphone:[...], screen:[...],
//                       webcam:[...] }, verifiedAtUtc } (4.5)
// Command responses are plain {ok,...} objects (no envelope) — the
// request's sendMessage promise correlates them.
// 'recorder-pong'.nowMonotonicMs is a performance.now() reading — the hook
// later tasks (4.10/4.12) use for clock-anchor alignment.
//
// Error conventions (AGENTS.md): TypeError = wrong type/shape;
// RangeError = bad domain value; plain Error = unavailable platform
// capability (e.g. no crypto.randomUUID — never a weak fallback).
// Channel handlers are failure-isolated (3.2 SF-1 precedent): a throwing
// selector never breaks the message listener and never drops a liveness
// pong — every command answers {ok:false, error} instead of throwing.

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Constants.
  // ------------------------------------------------------------------

  var RECORDER_MSG_KIND = 'recorder';
  var RECORDER_PROTOCOL_V = 1;
  var RECORDER_STATE_IDLE = 'idle';

  // Event names owned by 4.1. Later tasks add their own on this channel.
  var MSG_READY = 'recorder-ready';
  var MSG_PING = 'recorder-ping';
  var MSG_PONG = 'recorder-pong';

  // 4.2 command names (PLAN.md §4.2). 4.4 adds the camera_* set below.
  var MSG_SET_SESSION = 'recorder-set-session';
  var MSG_MIC_LIST = 'mic-list-devices';
  var MSG_MIC_SELECT = 'mic-select';
  var MSG_MIC_PERMISSION = 'mic-request-permission';
  var MSG_MIC_STATE = 'mic-get-state';
  // 4.4 camera-selection commands (§5 drives these). Mirrors the mic-*
  // family exactly; the camera selector is an independent instance of
  // the same device_selection.js factory with kind:'videoinput'.
  var MSG_CAM_LIST = 'cam-list-devices';
  var MSG_CAM_SELECT = 'cam-select';
  var MSG_CAM_PERMISSION = 'cam-request-permission';
  var MSG_CAM_STATE = 'cam-get-state';
  // 4.3 capture-selection commands (§5 drives these).
  var MSG_CAPTURE_LIST = 'capture-list-modes';
  var MSG_CAPTURE_SELECT = 'capture-select';
  var MSG_CAPTURE_PERMISSION = 'capture-request-permission';
  var MSG_CAPTURE_STATE = 'capture-get-state';
  // 4.3 SW-leg messages: the recorder's broker client → SW
  // (recording_host.js routes them to capture_broker.js). Same envelope.
  var MSG_CAPTURE_RESOLVE_TAB = 'capture-resolve-tab';
  var MSG_CAPTURE_QUERY_PERMISSION = 'capture-query-permission';
  var MSG_CAPTURE_GET_STREAM_ID = 'capture-get-stream-id';
  // 4.5 format-verification query (PLAN.md §4.5). Stateless: the probe
  // always re-runs isTypeSupported (synchronous, cheap) — no cache, no
  // staleness. No session gating: device capability, not session data;
  // emits nothing.
  var MSG_FORMATS = 'recorder-get-formats';
  // 4.6 stream start (PLAN.md §4.6). §5 drives it at Start; the response
  // carries per-stream outcomes. Session-gated (no session → no-session).
  var MSG_START_STREAMS = 'recorder-start-streams';
  // 4.11 visible-marker flash relay (PLAN.md §4.11). Offscreen → SW:
  // the SW resolves the target tab (4.3 capture broker) and relays
  // {kind:'blindfold-sync-flash', ...} to the content script. The only
  // deliberate channel-vocabulary addition of 4.11 (contract §7).
  var MSG_SYNC_FLASH = 'recorder-sync-flash';
  // 4.13 stream stop (PLAN.md §4.13). §5 drives it at Stop; the response
  // carries the stop-marker id, the per-stream stop outcomes, the
  // finalized segment numbers, and the finalizedAtUtc mark.
  // Session-gated (no session → no-session). The only deliberate
  // channel-vocabulary addition of 4.13 (contract §7).
  var MSG_STOP_STREAMS = 'recorder-stop-streams';
  // 4.14 per-stream status query (PLAN.md §4.14). SW → offscreen:
  // §5 (session lifecycle / readiness gating) and §6.3
  // (media-sync.json), both SW-side, query offscreen-local live
  // state through this message (the recorder-get-formats precedent —
  // the only way to reach document-local state). Session-gated (no
  // session → no-session). The only deliberate channel-vocabulary
  // addition of 4.14 (contract §3.2).
  var MSG_GET_STATUS = 'recorder-get-status';

  // Source context stamped on every event this document emits (1.3's
  // SOURCE_CONTEXTS already includes 'recording_context').
  var RECORDER_SOURCE_CONTEXT = 'recording_context';

  // Writer-intake message kind (2.3/2.4 contract): { kind:'event', event }.
  var WRITER_MESSAGE_KIND = 'event';

  var UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  // ------------------------------------------------------------------
  // Private helpers.
  // ------------------------------------------------------------------

  // Resolve the shared BlindfoldSession namespace at call time (sender.js /
  // session_store.js / lifecycle.js precedent). Never cached at load: keeps
  // this module independent of importScripts order and loadable in Node.
  function shared() {
    if (typeof globalThis !== 'undefined' && globalThis.BlindfoldSession) {
      return globalThis.BlindfoldSession;
    }
    return BlindfoldSession;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function isUuidV4(s) {
    return typeof s === 'string' && UUID_V4_RE.test(s);
  }

  function newUuidV4() {
    var g = (typeof globalThis !== 'undefined') ? globalThis : null;
    var cryptoNs = g ? g.crypto : null;
    if (!cryptoNs || typeof cryptoNs.randomUUID !== 'function') {
      // Never a weak fallback (repo house convention): the recorder cannot
      // be identified without real uuid-v4.
      throw new Error('recorder: crypto.randomUUID is unavailable');
    }
    return cryptoNs.randomUUID();
  }

  function perfNowMs() {
    var g = (typeof globalThis !== 'undefined') ? globalThis : null;
    var perf = g && g.performance;
    if (!perf || typeof perf.now !== 'function') {
      throw new Error('recorder: performance.now() is unavailable');
    }
    return perf.now();
  }

  // ------------------------------------------------------------------
  // Envelope validation (pure; unit-testable without chrome.*).
  // ------------------------------------------------------------------

  // True when m is a well-formed recorder-channel envelope with a KNOWN
  // protocol version. Unknown kinds fail here; unknown versions do NOT —
  // the version check is the receiver's job (reject with {ok:false}, never
  // throw) so a future v:2 document can be degraded honestly.
  function isRecorderMessage(m) {
    return isPlainObject(m) &&
      m.kind === RECORDER_MSG_KIND &&
      typeof m.msg === 'string';
  }

  // ------------------------------------------------------------------
  // The offscreen recorder instance.
  //
  // DOM-free: everything is injected, so the pure core is unit-testable in
  // Node. In production recorder.html constructs it with the real chrome
  // namespace once; the constructor announces recorder-ready at load.
  // ------------------------------------------------------------------

  // opts:
  //   chromeNs   — the chrome namespace (injected; may be null in Node)
  //   nowUtcIso  — () => UTC ISO string for bootTime (injectable; default
  //                new Date().toISOString())
  //   announce   — default true: send recorder-ready on construction.
  //                Node tests pass false and drive announceReady() manually.
  //   deviceSelector — optional injected microphone selector (4.2). When
  //                absent, the real createDeviceSelector({kind:'audioinput'})
  //                is constructed (Node tests inject a fake to test
  //                routing in isolation).
  //   captureSelector — optional injected capture selector (4.3). When
  //                absent, the real createCaptureSelector() is constructed
  //                (Node tests inject a fake to test routing in isolation).
  //   broker       — optional injected SW-broker client for the capture
  //                selector (4.3). When absent, createBrokerClient() builds
  //                the sendMessage round-trip client (Node tests inject a
  //                fake; production recorder.html always has
  //                chrome.runtime).
  //   mediaDevices / storage / permissions — optional pass-throughs for
  //                the internally constructed selector (4.2 testability;
  //                the selector's own read*() fallbacks apply when
  //                absent).
  //   selectorClock — optional () => UTC ISO string for the selector's
  //                devicesEnumeratedAt (testability; defaults to the real
  //                clock like nowUtcIso).
  function createOffscreenRecorder(opts) {
    var o = opts || {};
    var chromeNs = o.chromeNs === undefined ? readChromeNs() : o.chromeNs;
    var nowUtcIso = typeof o.nowUtcIso === 'function' ?
      o.nowUtcIso : function () { return new Date().toISOString(); };
    var announce = o.announce === undefined ? true : !!o.announce;

    var bootId = newUuidV4();
    var bootTime = nowUtcIso();

    // 4.2 session seam. Set by 'recorder-set-session' (§5 drives it at
    // Start/Stop); both null clears and re-arms inertness. Until a session
    // is set, the 4.2 event emitter is inert (2.x/3.x pre-§5 precedent).
    var sessionId = null;
    var gameId = null;

    // Per-document event emission state: one clock anchor (lazy), one
    // sourceSeq counter, and the set of sessionIds already anchored —
    // the sender.js (2.3) lazy-anchor pattern, minus the queue/retry
    // (4.2's volume is a handful of events per session; sends are
    // ack-observed, never silently dropped).
    var anchor = null;
    var nextSourceSeq = 0;
    var anchoredSessions = {};

    function readChromeNs() {
      var g = (typeof globalThis !== 'undefined') ? globalThis : null;
      return g ? (g.chrome || null) : null;
    }

    function runtimeOf() {
      return chromeNs ? (chromeNs.runtime || null) : null;
    }

    // Best-effort recorder-ready announcement. Failure-isolated: a closed
    // message pipe at document load must never crash the recorder — the
    // SW re-discovers the document via hasDocument() + ping anyway.
    function announceReady() {
      var runtime = runtimeOf();
      if (!runtime || typeof runtime.sendMessage !== 'function') {
        return false;
      }
      try {
        var sent = runtime.sendMessage({
          kind: RECORDER_MSG_KIND,
          msg: MSG_READY,
          v: RECORDER_PROTOCOL_V,
          bootId: bootId,
          bootTime: bootTime
        });
        // Best-effort: a rejected send (no listener yet) is not a failure —
        // the SW re-discovers the document via hasDocument() + ping.
        if (sent && typeof sent.then === 'function') {
          sent.then(function () {}, function () {});
        }
        return true;
      } catch (e) {
        return false;
      }
    }

    // chrome.runtime.onMessage listener for the recorder channel. Ignores
    // (returns false, no response) anything that is not a recorder envelope
    // or names an unknown msg (lenient-on-input). Unknown protocol versions
    // are rejected with {ok:false} — never thrown — so a newer document is
    // degraded honestly, not crashed.
    function onRuntimeMessage(message, sender, sendResponse) {
      if (!isRecorderMessage(message)) {
        return false; // not ours: ignore, no response
      }
      if (message.v !== RECORDER_PROTOCOL_V) {
        try {
          sendResponse({ ok: false, error: 'unsupported-protocol-version' });
        } catch (e) { /* channel closed; nothing more to do */ }
        return false;
      }
      if (message.msg === MSG_PING) {
        var pong = {
          kind: RECORDER_MSG_KIND,
          msg: MSG_PONG,
          v: RECORDER_PROTOCOL_V,
          ok: true,
          bootId: bootId,
          state: RECORDER_STATE_IDLE,
          nowMonotonicMs: null
        };
        try {
          pong.nowMonotonicMs = perfNowMs();
        } catch (e) {
          // Honest unknown: the pong still proves liveness; the monotonic
          // hook is simply absent (4.10/4.12 must treat it as unknown).
          pong.nowMonotonicMs = null;
        }
        try {
          sendResponse(pong);
        } catch (e) { /* channel closed; nothing more to do */ }
        return false; // response already sent synchronously
      }
      // 4.2 commands. Each handler is failure-isolated: a throwing
      // selector becomes {ok:false} data, never a broken listener and
      // never a dropped liveness pong (3.2 SF-1 precedent).
      if (message.msg === MSG_SET_SESSION) {
        return handleSetSession(message, sendResponse);
      }
      if (message.msg === MSG_MIC_LIST ||
          message.msg === MSG_MIC_SELECT ||
          message.msg === MSG_MIC_PERMISSION ||
          message.msg === MSG_MIC_STATE) {
        return handleMicCommand(message, sendResponse);
      }
      // 4.4 commands. Same failure-isolation as 4.2.
      if (message.msg === MSG_CAM_LIST ||
          message.msg === MSG_CAM_SELECT ||
          message.msg === MSG_CAM_PERMISSION ||
          message.msg === MSG_CAM_STATE) {
        return handleCamCommand(message, sendResponse);
      }
      if (message.msg === MSG_CAPTURE_LIST ||
          message.msg === MSG_CAPTURE_SELECT ||
          message.msg === MSG_CAPTURE_PERMISSION ||
          message.msg === MSG_CAPTURE_STATE) {
        return handleCaptureCommand(message, sendResponse);
      }
      // 4.5: format verification. Stateless query — failure-isolated
      // like every other command (3.2 SF-1 precedent).
      if (message.msg === MSG_FORMATS) {
        return handleFormatCommand(message, sendResponse);
      }
      // 4.6: start the three recording streams. Session-gated inside
      // the starter (no session → {ok:false, error:'no-session'}).
      if (message.msg === MSG_START_STREAMS) {
        return handleStartStreams(message, sendResponse);
      }
      // 4.13: stop the recording streams and finalize the segments.
      // Session-gated inside the finalizer (no session →
      // {ok:false, error:'no-session'}).
      if (message.msg === MSG_STOP_STREAMS) {
        return handleStopStreams(message, sendResponse);
      }
      // 4.14: per-stream status query. Session-gated inside the
      // handler (no session → {ok:false, error:'no-session'}).
      if (message.msg === MSG_GET_STATUS) {
        return handleStatusCommand(message, sendResponse);
      }
      return false; // unknown msg: ignore, no response
    }

    function installListener() {
      var runtime = runtimeOf();
      var onMessage = runtime ? runtime.onMessage : null;
      if (!onMessage || typeof onMessage.addListener !== 'function') {
        return false;
      }
      onMessage.addListener(onRuntimeMessage);
      return true;
    }

    // ----------------------------------------------------------------
    // 4.2: session-gated event emission to the existing writer intake.
    // ----------------------------------------------------------------

    function isSessionActive() {
      return typeof sessionId === 'string' && sessionId !== '' &&
             typeof gameId === 'string' && gameId !== '';
    }

    // The clock anchor is captured lazily at first emission (not at
    // construction) so a recorder that never emits never needs the clock
    // — and so 4.1's boot/ping paths stay clock-independent.
    function ensureAnchor() {
      if (anchor === null) {
        var BS = shared();
        if (typeof BS.captureClockAnchor !== 'function') {
          throw new Error('recorder: captureClockAnchor is unavailable');
        }
        anchor = BS.captureClockAnchor();
      }
      return anchor;
    }

    // Send one envelope to the SW's transactional writer intake
    // ({kind:'event', event}, the 2.3/2.4 contract). Ack-observed: a
    // missing or negative ack is console.warned, never thrown and never
    // silently dropped (4.2 has no retry queue — 2.5's lives in the
    // content-script sender; the warn is the observable trace).
    function sendEventMessage(envelope) {
      var runtime = runtimeOf();
      if (!runtime || typeof runtime.sendMessage !== 'function') {
        return false;
      }
      try {
        var sent = runtime.sendMessage({ kind: WRITER_MESSAGE_KIND, event: envelope });
        if (sent && typeof sent.then === 'function') {
          sent.then(function (ack) {
            if (!ack || ack.ok !== true || ack.eventId !== envelope.eventId) {
              try {
                console.warn('[recorder] event not acknowledged by writer',
                  envelope.eventId, ack);
              } catch (w) { /* ignore */ }
            }
          }, function () {
            try {
              console.warn('[recorder] event send to writer failed', envelope.eventId);
            } catch (w) { /* ignore */ }
          });
        }
        return true;
      } catch (e) {
        return false;
      }
    }

    // The emitter the device selector calls: (eventType, payload, refs).
    // Returns the built envelope, or null when inert (no session). Throws
    // on envelope-build failure (e.g. a non-uuid sessionId) — the channel
    // handler converts it to {ok:false}, so the failure is observable,
    // never silent. §5 must mint uuid-v4 session/game ids (3.x
    // carry-forward).
    function emitRecorderEvent(eventType, payload, refs) {
      if (!isSessionActive()) {
        return null;
      }
      var BS = shared();
      var monotonicMs = perfNowMs();
      var a = ensureAnchor();
      if (!anchoredSessions[sessionId]) {
        var anchorEvent = BS.createAnchorEvent({
          sessionId: sessionId,
          sourceContext: RECORDER_SOURCE_CONTEXT,
          sourceSeq: nextSourceSeq++,
          anchor: a
        });
        anchoredSessions[sessionId] = true;
        sendEventMessage(anchorEvent);
      }
      var envelope = BS.createEvent({
        eventType: eventType,
        sessionId: sessionId,
        gameId: gameId,
        sourceContext: RECORDER_SOURCE_CONTEXT,
        sourceSeq: nextSourceSeq++,
        clockSegmentId: a.segmentId,
        monotonicMs: monotonicMs,
        payload: payload,
        refs: (refs === undefined) ? null : refs
      });
      sendEventMessage(envelope);
      return envelope;
    }

    // ----------------------------------------------------------------
    // 4.2: the microphone selector (purely reactive; §5 drives it).
    // ----------------------------------------------------------------

    // Production storage for the selector: the offscreen document's own
    // localStorage, adapted to the chrome.storage.local-shaped
    // {get,set,remove} promise interface the selector injects. Rationale
    // (V2 finding): offscreen documents expose only chrome.runtime —
    // chrome.storage is undefined there even with the "storage" manifest
    // permission — so the persisted selection lives in document
    // localStorage under the same 'blindfold.micDeviceId.v1' key. Same
    // extension origin, survives document kill/recreate; §5's popup
    // (same origin) reads the same store. No manifest change, no DB
    // schema change. Returns null when localStorage is unavailable (the
    // selector then reports the honest plain-Error capability failure).
    function createLocalStorageAdapter() {
      var g = (typeof globalThis !== 'undefined') ? globalThis : null;
      var ls = null;
      try {
        ls = g ? g.localStorage : null;
      } catch (e) {
        ls = null;
      }
      if (!ls) {
        return null;
      }
      function wrap(fn) {
        return function () {
          var args = arguments;
          return new Promise(function (resolve, reject) {
            try {
              resolve(fn.apply(null, args));
            } catch (e) {
              reject(e);
            }
          });
        };
      }
      return {
        get: wrap(function (k) {
          var kv = {};
          var v = ls.getItem(k);
          kv[k] = (v === null) ? undefined : v;
          return kv;
        }),
        set: wrap(function (kv) {
          for (var k in kv) {
            if (!Object.prototype.hasOwnProperty.call(kv, k)) {
              continue;
            }
            if (kv[k] === undefined || kv[k] === null) {
              ls.removeItem(k);
            } else {
              ls.setItem(k, String(kv[k]));
            }
          }
        }),
        remove: wrap(function (k) {
          ls.removeItem(k);
        })
      };
    }

    var micSelector = null;
    function getMicSelector() {
      if (micSelector === null) {
        var BS = shared();
        if (typeof BS.createDeviceSelector !== 'function') {
          throw new Error('recorder: createDeviceSelector is unavailable');
        }
        if (o.deviceSelector !== undefined && o.deviceSelector !== null) {
          micSelector = o.deviceSelector;
        } else {
          micSelector = BS.createDeviceSelector({
            kind: 'audioinput',
            mediaDevices: o.mediaDevices,
            storage: o.storage !== undefined ? o.storage : createLocalStorageAdapter(),
            permissions: o.permissions,
            nowUtcIso: o.selectorClock,
            emitEvent: emitRecorderEvent,
            getSessionId: function () { return sessionId; },
            getGameId: function () { return gameId; }
          });
        }
      }
      return micSelector;
    }

    // ----------------------------------------------------------------
    // 4.4: the webcam selector (purely reactive; §5 drives it).
    // Independent instance of the same factory with kind:'videoinput';
    // "saved separately from the screen" is 4.6's stream wiring, not 4.4's.
    // ----------------------------------------------------------------

    var cameraSelector = null;
    function getCameraSelector() {
      if (cameraSelector === null) {
        var BS = shared();
        if (typeof BS.createDeviceSelector !== 'function') {
          throw new Error('recorder: createDeviceSelector is unavailable');
        }
        if (o.cameraSelector !== undefined && o.cameraSelector !== null) {
          cameraSelector = o.cameraSelector;
        } else {
          cameraSelector = BS.createDeviceSelector({
            kind: 'videoinput',
            mediaDevices: o.mediaDevices,
            storage: o.storage !== undefined ? o.storage : createLocalStorageAdapter(),
            permissions: o.permissions,
            nowUtcIso: o.selectorClock,
            emitEvent: emitRecorderEvent,
            getSessionId: function () { return sessionId; },
            getGameId: function () { return gameId; }
          });
        }
      }
      return cameraSelector;
    }

    // ----------------------------------------------------------------
    // 4.3: the screen/tab capture selector (purely reactive; §5 drives it).
    // ----------------------------------------------------------------

    // The SW-side broker client: sends the SW-leg messages on this same
    // recorder channel and returns the SW's answers as promises. The SW
    // (recording_host.js → capture_broker.js) owns every chrome.* call;
    // this document only ever sees the opaque streamId string.
    function createBrokerClient() {
      var runtime = runtimeOf();
      function call(msg, fields) {
        return new Promise(function (resolve, reject) {
          if (!runtime || typeof runtime.sendMessage !== 'function') {
            reject(new Error('recorder: the SW capture broker is unreachable'));
            return;
          }
          var envelope = { kind: RECORDER_MSG_KIND, msg: msg,
                           v: RECORDER_PROTOCOL_V };
          for (var k in fields) {
            if (Object.prototype.hasOwnProperty.call(fields, k)) {
              envelope[k] = fields[k];
            }
          }
          var sent;
          try {
            sent = runtime.sendMessage(envelope);
          } catch (e) {
            reject(e);
            return;
          }
          Promise.resolve(sent).then(resolve, reject);
        });
      }
      return {
        resolveTargetTab: function () {
          return call(MSG_CAPTURE_RESOLVE_TAB, {});
        },
        queryCapturePermission: function () {
          return call(MSG_CAPTURE_QUERY_PERMISSION, {});
        },
        getStreamId: function (tabId) {
          return call(MSG_CAPTURE_GET_STREAM_ID, { tabId: tabId });
        }
      };
    }

    var captureSelector = null;
    function getCaptureSelector() {
      if (captureSelector === null) {
        var BS = shared();
        if (typeof BS.createCaptureSelector !== 'function') {
          throw new Error('recorder: createCaptureSelector is unavailable');
        }
        if (o.captureSelector !== undefined && o.captureSelector !== null) {
          captureSelector = o.captureSelector;
        } else {
          captureSelector = BS.createCaptureSelector({
            mediaDevices: o.mediaDevices,
            storage: o.storage !== undefined ? o.storage : createLocalStorageAdapter(),
            broker: o.broker !== undefined ? o.broker : createBrokerClient(),
            nowUtcIso: o.selectorClock,
            emitEvent: emitRecorderEvent,
            getSessionId: function () { return sessionId; },
            getGameId: function () { return gameId; }
          });
        }
      }
      return captureSelector;
    }

    // ----------------------------------------------------------------
    // 4.5: format verification + the recording manifest writer.
    //
    // The format-support instance probes MediaRecorder.isTypeSupported
    // per stream kind against the frozen candidate lists. The manifest
    // writer (recordSegmentFormat) is the API 4.6 calls at stream start
    // with the real recorder.mimeType; 4.5 itself constructs no
    // MediaRecorder and starts nothing.
    // ----------------------------------------------------------------

    var formatSupport = null;
    function getFormatSupport() {
      if (formatSupport === null) {
        var BS = shared();
        if (typeof BS.createFormatSupport !== 'function') {
          throw new Error('recorder: createFormatSupport is unavailable');
        }
        if (o.formatSupport !== undefined && o.formatSupport !== null) {
          formatSupport = o.formatSupport;
        } else {
          formatSupport = BS.createFormatSupport({
            // mediaRecorder/db read lazily from the real globals in the
            // document; the manifest write goes direct to the
            // extension-owned IDB (4.1's direct-IDB path).
            nowUtcIso: o.selectorClock
          });
        }
      }
      return formatSupport;
    }

    // ----------------------------------------------------------------
    // 4.7's audio-content policy (PLAN.md §4.7). recorder.js wires it
    // into the stream starter the same way as formatSupport; the policy
    // itself is pure classification (no media APIs), resolved from the
    // shared namespace. Absence is a wiring defect → plain Error, like
    // createFormatSupport.
    // ----------------------------------------------------------------

    var audioPolicy = null;
    function getAudioPolicy() {
      if (audioPolicy === null) {
        var BS = shared();
        if (typeof BS.createAudioPolicy !== 'function') {
          throw new Error('recorder: createAudioPolicy is unavailable');
        }
        if (o.audioPolicy !== undefined && o.audioPolicy !== null) {
          audioPolicy = o.audioPolicy;
        } else {
          audioPolicy = BS.createAudioPolicy();
        }
      }
      return audioPolicy;
    }

    // ----------------------------------------------------------------
    // 4.10's clock linker (PLAN.md §4.10). recorder.js wires it into
    // the stream starter the same way as formatSupport / audioPolicy:
    // lazy, shared-namespace-resolved, test-injectable via o.clockLink.
    // Absence is a wiring defect → plain Error, like
    // createAudioPolicy. The linker is identity-only and can never
    // fail a stream (a missing linker becomes a null link inside the
    // starter). 4.13 calls this same getter for each post-discontinuity
    // segmentId it mints (4.10 owns all linking).
    // ----------------------------------------------------------------

    var clockLink = null;
    function getClockLink() {
      if (clockLink === null) {
        var BS = shared();
        if (typeof BS.createClockLink !== 'function') {
          throw new Error('recorder: createClockLink is unavailable');
        }
        if (o.clockLink !== undefined && o.clockLink !== null) {
          clockLink = o.clockLink;
        } else {
          clockLink = BS.createClockLink();
        }
      }
      return clockLink;
    }

    // 'recorder-get-formats' → { ok, formats, verifiedAtUtc }. The probe
    // always re-runs; an unavailable MediaRecorder becomes {ok:false}
    // data (never a thrown listener break).
    function handleFormatCommand(message, sendResponse) {
      var fs;
      try {
        fs = getFormatSupport();
      } catch (e) {
        try {
          sendResponse({ ok: false, error: 'unavailable' });
        } catch (w) { /* ignore */ }
        return false;
      }
      function deferred(fn) {
        return respondAsync(Promise.resolve().then(fn), sendResponse,
          function (err) {
            if (err instanceof Error &&
                !(err instanceof TypeError) &&
                !(err instanceof RangeError)) {
              return { ok: false, error: 'unavailable' };
            }
            return toChannelError(err);
          });
      }
      return deferred(function () {
        return {
          ok: true,
          formats: fs.verifyFormats(),
          verifiedAtUtc: new Date().toISOString()
        };
      });
    }

    // ----------------------------------------------------------------
    // 4.6: stream starter — acquires and starts the three recording
    // streams (mic, screen/tab, webcam), writing the manifest record per
    // stream with the real negotiated MIME type and actual start times.
    // ----------------------------------------------------------------

    var streamStarter = null;
    function getStreamStarter() {
      if (streamStarter === null) {
        var BS = shared();
        if (typeof BS.createStreamStarter !== 'function') {
          throw new Error('recorder: createStreamStarter is unavailable');
        }
        if (o.streamStarter !== undefined && o.streamStarter !== null) {
          streamStarter = o.streamStarter;
        } else {
          // Media-capture APIs (navigator.mediaDevices.getUserMedia,
          // getDisplayMedia, MediaRecorder) are NOT referenced here:
          // stream_starter.js reads them lazily from the document
          // globals in the offscreen document (the 4.1 boundary —
          // recorder.js and recording_host.js reference no media-capture
          // APIs, V1-pinned). recorder.js wires only selectors, broker,
          // format support, session thunks, clocks, and uuid.
          streamStarter = BS.createStreamStarter({
            micSelector: getMicSelector(),
            cameraSelector: getCameraSelector(),
            captureSelector: getCaptureSelector(),
            broker: o.broker !== undefined ? o.broker : createBrokerClient(),
            formatSupport: getFormatSupport(),
            audioPolicy: getAudioPolicy(),
            // 4.10: the clock linker plus the forced-capture anchor
            // thunk. ensureAnchor() captures the lazy anchor on first
            // use (honest — the document's clock already runs); a
            // throw inside the linker becomes a null link, never a
            // stream failure.
            clockLink: getClockLink(),
            getAnchor: ensureAnchor,
            getSessionId: function () { return sessionId; },
            getGameId: function () { return gameId; },
            nowUtcIso: o.selectorClock,
            perfNowMs: (typeof o.perfNowMs === 'function') ?
              o.perfNowMs : perfNowMs,
            newUuidV4: newUuidV4
          });
        }
      }
      return streamStarter;
    }

    // ----------------------------------------------------------------
    // 4.8: incremental chunk extraction (PLAN.md §4.8). recorder.js wires
    // the chunk writer into the stream starter the same way as
    // formatSupport / audioPolicy: lazy, shared-namespace-resolved,
    // test-injectable via o.chunkWriter. Absence is a wiring defect →
    // plain Error, like createFormatSupport.
    // ----------------------------------------------------------------

    var chunkWriter = null;
    function getChunkWriter() {
      if (chunkWriter === null) {
        var BS = shared();
        if (typeof BS.createChunkWriter !== 'function') {
          throw new Error('recorder: createChunkWriter is unavailable');
        }
        if (o.chunkWriter !== undefined && o.chunkWriter !== null) {
          chunkWriter = o.chunkWriter;
        } else {
          // Timer globals default inside the writer; the DB is read
          // lazily from the shared namespace (format_support precedent)
          // — the chunk writes go direct to the extension-owned IDB
          // from the offscreen document (4.1's direct-IDB path).
          // 4.9: the writer reports its terminal states (chunk-stalled,
          // chunk-quota-exceeded, chunk-write-error) to the track
          // monitor through the optional onTerminalState seam
          // (exact-once per stream; never throws into the chunker).
          chunkWriter = BS.createChunkWriter({
            nowUtcIso: o.selectorClock,
            onTerminalState: function (info) {
              try {
                getTrackMonitor().onChunkTerminalState(info);
              } catch (e) {
                // Monitoring is best-effort; the chunker already
                // recorded its terminal state.
              }
            }
          });
        }
      }
      return chunkWriter;
    }

    // ----------------------------------------------------------------
    // 4.9: track/error/discontinuity monitoring (PLAN.md §4.9). recorder.js
    // wires the track monitor the same way as formatSupport / audioPolicy /
    // chunkWriter: lazy, shared-namespace-resolved, test-injectable via
    // o.trackMonitor. Absence is a wiring defect → plain Error, like
    // createFormatSupport. The monitor observes only (event log); it
    // never fails the streams or the channel response.
    // ----------------------------------------------------------------

    var trackMonitor = null;
    function getTrackMonitor() {
      if (trackMonitor === null) {
        var BS = shared();
        if (typeof BS.createTrackMonitor !== 'function') {
          throw new Error('recorder: createTrackMonitor is unavailable');
        }
        if (o.trackMonitor !== undefined && o.trackMonitor !== null) {
          trackMonitor = o.trackMonitor;
        } else {
          trackMonitor = BS.createTrackMonitor({
            emitEvent: emitRecorderEvent,
            // Lazy: the chunk writer may not exist yet when the monitor
            // is constructed (construction order is monitor-then-writer
            // in the start-streams handler below).
            getChunkState: function (streamKind) {
              return getChunkWriter().getChunkState(streamKind);
            }
          });
        }
      }
      return trackMonitor;
    }

    // ----------------------------------------------------------------
    // 4.11: audible/visible sync markers (PLAN.md §4.11). recorder.js
    // wires the marker the same way as formatSupport / audioPolicy /
    // chunkWriter / trackMonitor: lazy, shared-namespace-resolved,
    // test-injectable via o.syncMarker. Absence is a wiring defect →
    // plain Error, like createTrackMonitor. The marker is auxiliary:
    // it can never fail the streams or the channel response.
    //
    // The audible half plays in this document (AUDIO_PLAYBACK) via
    // HTMLAudioElement only — no AudioContext anywhere (the 4.7
    // code-scan pin passes unmodified). The visible half is relayed
    // to the SW (MSG_SYNC_FLASH), which forwards it to the Chess.com
    // tab's sync_flash.js content script.
    //
    // 4.13's obligation (contract §4): call
    // getSyncMarker().emitStopMarker() BEFORE recorder.stop(), so the
    // stop marker is captured before the final flush. 4.11 defines the
    // seam; 4.13 wires it.
    // ----------------------------------------------------------------

    var syncMarker = null;
    function getSyncMarker() {
      if (syncMarker === null) {
        var BS = shared();
        if (typeof BS.createSyncMarker !== 'function') {
          throw new Error('recorder: createSyncMarker is unavailable');
        }
        if (o.syncMarker !== undefined && o.syncMarker !== null) {
          syncMarker = o.syncMarker;
        } else {
          syncMarker = BS.createSyncMarker({
            emitEvent: emitRecorderEvent,
            getSessionId: function () { return sessionId; },
            sendRelayMessage: sendSyncFlashRelay,
            audioFactory: createMarkerAudio,
            assetUrl: markerAssetUrl(),
            setTimeoutFn: function (fn, ms) { return setTimeout(fn, ms); },
            newUuidV4: newUuidV4
          });
        }
      }
      return syncMarker;
    }

    function markerAssetUrl() {
      var runtime = runtimeOf();
      if (runtime && typeof runtime.getURL === 'function') {
        try {
          return runtime.getURL('sync_beep.wav');
        } catch (e) { /* fall through to the bare name */ }
      }
      return 'sync_beep.wav';
    }

    function createMarkerAudio(url) {
      var g = (typeof globalThis !== 'undefined') ? globalThis : null;
      var ACtor = g ? g.Audio : null;
      if (typeof ACtor !== 'function') {
        return null; // the marker module emits 'failed' honestly
      }
      return new ACtor(url);
    }

    // ----------------------------------------------------------------
    // 4.13: finalize recordings at Stop (PLAN.md §4.13). recorder.js
    // wires the finalizer the same way as formatSupport / audioPolicy /
    // chunkWriter / trackMonitor / syncMarker: lazy,
    // shared-namespace-resolved, test-injectable via o.finalizer.
    // Absence is a wiring defect → plain Error, like
    // createChunkWriter. The finalizer stops every stream, splits
    // discontinuous recordings into numbered pieces, and marks the
    // manifest finalized — but never assembles media files (§6.4).
    // ----------------------------------------------------------------

    var finalizer = null;
    function getFinalizer() {
      if (finalizer === null) {
        var BS = shared();
        if (typeof BS.createFinalizer !== 'function') {
          throw new Error('recorder: createFinalizer is unavailable');
        }
        if (o.finalizer !== undefined && o.finalizer !== null) {
          finalizer = o.finalizer;
        } else {
          finalizer = BS.createFinalizer({
            starter: getStreamStarter(),
            chunkWriter: getChunkWriter(),
            trackMonitor: getTrackMonitor(),
            syncMarker: getSyncMarker(),
            clockLink: getClockLink(),
            getAnchor: ensureAnchor,
            formatSupport: getFormatSupport(),
            // The DB and indexedDB default inside the finalizer
            // (shared-namespace lazy read; the db.js pattern).
            getSessionId: function () { return sessionId; },
            getGameId: function () { return gameId; },
            finalizedField: MANIFEST_FINALIZED_FIELD,
            newUuidV4: newUuidV4
          });
        }
      }
      return finalizer;
    }

    // ----------------------------------------------------------------
    // 4.14: per-stream recording status (PLAN.md §4.14). recorder.js
    // wires the status reader the same way as formatSupport /
    // audioPolicy / chunkWriter / trackMonitor: lazy,
    // shared-namespace-resolved, test-injectable via o.streamStatus.
    // Absence is a wiring defect → plain Error, like
    // createChunkWriter. Read-only by construction: the injected
    // surface contains no writer, and the module never emits,
    // writes, or controls (V1 code-scan pinned). It reports facts
    // per stream so a dead microphone, failed screen capture, or
    // stalled chunk loop cannot masquerade as a complete recording;
    // "required streams" / readiness policy is §5's, not 4.14's.
    // ----------------------------------------------------------------

    var streamStatusReader = null;
    function getStreamStatusReader() {
      if (streamStatusReader === null) {
        var BS = shared();
        if (typeof BS.createStreamStatus !== 'function') {
          throw new Error('recorder: createStreamStatus is unavailable');
        }
        if (o.streamStatus !== undefined && o.streamStatus !== null) {
          streamStatusReader = o.streamStatus;
        } else {
          streamStatusReader = BS.createStreamStatus({
            getStreamRecord: function (streamKind) {
              return getStreamStarter().getStreamRecord(streamKind);
            },
            getChunkState: function (streamKind) {
              return getChunkWriter().getChunkState(streamKind);
            },
            getMonitoredTracks: function (streamKind) {
              return getTrackMonitor().getMonitoredTracks(streamKind);
            },
            getStreamHealth: function (streamKind) {
              return getTrackMonitor().getStreamHealth(streamKind);
            },
            getManifestRecordsBySession: function (sid) {
              return getFormatSupport().getManifestRecordsBySession(sid);
            },
            getSessionId: function () { return sessionId; },
            nowUtcIso: nowUtcIso
          });
        }
      }
      return streamStatusReader;
    }

    // Offscreen → SW flash-relay request (contract §7). Always resolves
    // (never rejects): an unreachable SW becomes data, never a thrown
    // marker failure.
    function sendSyncFlashRelay(fields) {
      var runtime = runtimeOf();
      return new Promise(function (resolve) {
        if (!runtime || typeof runtime.sendMessage !== 'function') {
          resolve({ ok: false, error: 'unreachable' });
          return;
        }
        var envelope = {
          kind: RECORDER_MSG_KIND,
          msg: MSG_SYNC_FLASH,
          v: RECORDER_PROTOCOL_V,
          markerId: fields.markerId,
          phase: fields.phase,
          // Additive to the contract's relay shape: the visible event's
          // envelope requires sessionId, and the page's activeSessionId
          // is not set pre-§5 — the offscreen document's 4.6 no-session
          // guard is the authority at marker time.
          sessionId: fields.sessionId
        };
        var rsp = null;
        try {
          rsp = runtime.sendMessage(envelope);
        } catch (e) {
          resolve({ ok: false, error: 'send-threw' });
          return;
        }
        if (rsp && typeof rsp.then === 'function') {
          rsp.then(function (ans) {
            resolve(ans);
          }, function () {
            resolve({ ok: false, error: 'send-failed' });
          });
        } else {
          resolve({ ok: false, error: 'no-response' });
        }
      });
    }

    // 4.9's finalized-marker exclusion for the restart pre-check. The
    // marker name is 4.13's to define (db.js already anticipates "4.13
    // marks it finalized"); 4.13 defines it as 'finalizedAtUtc' — the
    // ISO timestamp the finalizer writes when a segment's chunk set is
    // closed — so finalized segments are excluded from restart
    // detection and from later finalize passes (idempotence).
    var MANIFEST_FINALIZED_FIELD = 'finalizedAtUtc';
    function isManifestRecordFinalized(record) {
      return MANIFEST_FINALIZED_FIELD !== null &&
        !!record[MANIFEST_FINALIZED_FIELD];
    }

    // 4.9: restart detection. Called BEFORE starter.startStreams():
    // pre-existing unfinalized manifest records for this sessionId mean a
    // previous document generation died mid-session (its recorders died
    // with it; the manifest survived in extension-owned IDB). Returns a
    // map streamKind → [segmentIds] of the superseded generation ({} when
    // none — the first start emits nothing). Best-effort: monitoring
    // never fails the start, so a failed read degrades to "no restart".
    function checkRestartSuperseded() {
      if (!isSessionActive()) {
        return Promise.resolve({});
      }
      var fs;
      try {
        fs = getFormatSupport();
      } catch (e) {
        return Promise.resolve({});
      }
      return Promise.resolve()
        .then(function () { return fs.getManifestRecordsBySession(sessionId); })
        .then(function (records) {
          var map = {};
          for (var i = 0; i < records.length; i++) {
            var r = records[i];
            if (!r || isManifestRecordFinalized(r)) {
              continue;
            }
            var kind = r.streamKind;
            if (typeof kind !== 'string' || kind === '') {
              continue;
            }
            if (!map[kind]) {
              map[kind] = [];
            }
            if (typeof r.segmentId === 'string' &&
                map[kind].indexOf(r.segmentId) === -1) {
              map[kind].push(r.segmentId);
            }
          }
          return map;
        }, function () {
          return {};
        });
    }

    // 4.9: emit one stream_discontinuity {reason:'restart'} per affected
    // kind after the new generation starts. refs.segmentId is the NEW
    // segmentId — null when that kind failed to start (the old
    // generation is dead either way).
    function emitRestartDiscontinuities(monitor, superseded, result) {
      var kinds = Object.keys(superseded);
      for (var i = 0; i < kinds.length; i++) {
        var kind = kinds[i];
        var newSegmentId = null;
        try {
          var per = result && result.streams ? result.streams[kind] : null;
          if (per && per.ok === true && typeof per.segmentId === 'string' &&
              per.segmentId !== '') {
            newSegmentId = per.segmentId;
          }
        } catch (e) { /* ignore */ }
        try {
          monitor.emitRestartDiscontinuity({
            streamKind: kind,
            newSegmentId: newSegmentId,
            supersededSegmentIds: superseded[kind]
          });
        } catch (e) {
          // Tolerated: monitoring never fails the channel response.
        }
      }
    }
    // 'recorder-start-streams' → {ok, streams:{microphone,screen,webcam}}
    // (or top-level {ok:false, error} guards). Failure-isolated like
    // every other command (3.2 SF-1 precedent): the starter returns data,
    // never throws across the channel.
    //
    // 4.8: chunking starts automatically for every successfully started
    // stream — Start implies record; no new channel message. The kickoff
    // is best-effort and wrapped: chunking can never fail the streams or
    // the channel response (the writer's own state exposes any issue to
    // 4.9/4.14).
    //
    // 4.9: the wiring order is (1) restart pre-check → superseded map,
    // (2) starter.startStreams() (unchanged), (3) chunking kickoff (4.8,
    // unchanged — the writer now carries the monitor's onTerminalState),
    // (4) monitor.attachStream for each successfully started kind,
    // (5) pending 'restart' discontinuity events. Steps 3–5 are
    // best-effort and try/catch-wrapped like 4.8's kickoff: monitoring
    // can never fail the streams or the channel response.
    function handleStartStreams(message, sendResponse) {
      var starter;
      try {
        starter = getStreamStarter();
      } catch (e) {
        try {
          sendResponse(toChannelError(e));
        } catch (w) { /* ignore */ }
        return false;
      }
      return respondAsync(Promise.resolve()
        .then(function () { return checkRestartSuperseded(); })
        .then(function (superseded) {
          return starter.startStreams().then(function (result) {
            return { superseded: superseded, result: result };
          });
        })
        .then(function (both) {
          var result = both.result;
          var active = null;
          try {
            active = starter.getActiveStreams();
          } catch (e) { /* ignore */ }
          if (active) {
            // 4.8 chunking kickoff (unchanged): best-effort and wrapped —
            // chunking can never fail the streams or the channel response.
            try {
              var writer = getChunkWriter();
              var kinds = Object.keys(active);
              for (var i = 0; i < kinds.length; i++) {
                var rec = active[kinds[i]];
                if (rec && rec.recorder) {
                  writer.startForStream({
                    streamKind: kinds[i],
                    segmentId: rec.segmentId,
                    recorder: rec.recorder
                  });
                }
              }
            } catch (e) { /* chunking is best-effort; streams are recording */ }
            // 4.9 monitoring attach + restart discontinuities:
            // independently best-effort — monitoring can never fail the
            // streams, the chunking, or the channel response.
            try {
              var monitor = getTrackMonitor();
              var mkeys = Object.keys(active);
              for (var j = 0; j < mkeys.length; j++) {
                var mrec = active[mkeys[j]];
                if (mrec && mrec.recorder) {
                  monitor.attachStream({
                    streamKind: mkeys[j],
                    stream: mrec.stream,
                    recorder: mrec.recorder,
                    segmentId: mrec.segmentId
                  });
                }
              }
              emitRestartDiscontinuities(monitor, both.superseded, result);
            } catch (e) { /* monitoring best-effort; streams are recording */ }
          }
          // 4.11 start marker: iff ≥1 stream started successfully.
          // Fire-and-forget, best-effort — the marker can never delay or
          // fail the channel response (the 4.8/4.9 kickoff precedent).
          // Zero started streams → no marker at all (the per-kind start
          // response is the record — the 4.9 precedent for
          // never-started streams).
          try {
            var resStreams = (both.result && both.result.streams) || {};
            var startedKinds = Object.keys(resStreams).filter(function (k) {
              return resStreams[k] && resStreams[k].ok === true;
            });
            if (startedKinds.length > 0) {
              getSyncMarker().emitStartMarker();
            }
          } catch (e) { /* marker is auxiliary; streams are recording */ }
          return result;
        }), sendResponse, toChannelError);
    }

    // 4.13: stop the recording streams and finalize the segments
    // (PLAN.md §4.13). The finalizer owns the whole sequence: guards,
    // stop-marker + capture window, chunker stop, recorder.stop() per
    // stream, the bounded final-flush await, monitor detach before
    // track stop, device release, registry discard, then the finalize
    // pass (splits → per-(sessionId, streamKind) numbering →
    // finalizedAtUtc). The finalizer never throws into the channel
    // handler: a synchronously-throwing factory becomes {ok:false} here,
    // and a rejected stop becomes {ok:false} via respondAsync.
    function handleStopStreams(message, sendResponse) {
      var fin;
      try {
        fin = getFinalizer();
      } catch (e) {
        try {
          sendResponse(toChannelError(e));
        } catch (w) { /* ignore */ }
        return false;
      }
      return respondAsync(Promise.resolve()
        .then(function () { return fin.stopAndFinalize(); }),
        sendResponse, toChannelError);
    }

    // 4.14: per-stream status query (PLAN.md §4.14).
    // 'recorder-get-status' → {ok, sessionId, queriedAtUtc, statuses}.
    // Session-gated (no session → {ok:false, error:'no-session'} —
    // status is session-scoped; without a session there is nothing
    // to report). The reader never throws into the channel handler:
    // a synchronously-throwing factory becomes {ok:false} here, and
    // a rejected status read becomes {ok:false} via respondAsync
    // (the 3.2 SF-1 precedent).
    function handleStatusCommand(message, sendResponse) {
      if (!isSessionActive()) {
        try {
          sendResponse({ ok: false, error: 'no-session' });
        } catch (w) { /* ignore */ }
        return false;
      }
      var reader;
      try {
        reader = getStreamStatusReader();
      } catch (e) {
        try {
          sendResponse({ ok: false, error: 'unavailable' });
        } catch (w) { /* ignore */ }
        return false;
      }
      return respondAsync(
        Promise.resolve()
          .then(function () { return reader.getAllStreamStatuses(); })
          .then(function (statuses) {
            return {
              ok: true,
              sessionId: sessionId,
              queriedAtUtc: nowUtcIso(),
              statuses: statuses
            };
          }),
        sendResponse, toChannelError);
    }

    function handleCaptureCommand(message, sendResponse) {
      var sel;
      try {
        sel = getCaptureSelector();
      } catch (e) {
        try {
          sendResponse(toCaptureChannelError(e));
        } catch (w) { /* ignore */ }
        return false;
      }
      // Deferred inside the promise: a synchronously-throwing selector
      // becomes a rejection, which respondAsync converts to {ok:false} —
      // the listener never throws (3.2 SF-1 precedent).
      function deferred(fn) {
        return respondAsync(Promise.resolve().then(fn), sendResponse,
                            toCaptureChannelError);
      }
      if (message.msg === MSG_CAPTURE_LIST) {
        return deferred(function () { return sel.listModes(); });
      }
      if (message.msg === MSG_CAPTURE_SELECT) {
        if (message.captureMode !== 'tab' && message.captureMode !== 'screen') {
          try {
            sendResponse({ ok: false, error: 'unknown-mode' });
          } catch (e) { /* ignore */ }
          return false;
        }
        return deferred(function () { return sel.select(message.captureMode); });
      }
      if (message.msg === MSG_CAPTURE_PERMISSION) {
        if (message.captureMode !== 'tab' && message.captureMode !== 'screen') {
          try {
            sendResponse({ ok: false, error: 'unknown-mode' });
          } catch (e) { /* ignore */ }
          return false;
        }
        return deferred(function () { return sel.requestPermission(message.captureMode); });
      }
      if (message.msg === MSG_CAPTURE_STATE) {
        return deferred(function () { return sel.getState(); });
      }
      return false; // unknown msg: ignore, no response (4.1 behavior)
    }

    // Best-effort boot restore of the persisted selections (silent
    // when inert — no session exists yet at boot). Never throws; the
    // recorder's liveness must not depend on storage. 4.4 repair: waits
    // for ALL selector restores (Promise.all), not just the first —
    // otherwise a later selector's restore can still be in flight when
    // the caller proceeds.
    function restoreDevices() {
      var ps = [];
      try {
        ps.push(getMicSelector().restoreOnBoot());
      } catch (e) { /* mic restore must not block the others */ }
      // 4.3: the persisted capture mode restores the same way.
      try {
        ps.push(getCaptureSelector().restoreOnBoot());
      } catch (e) { /* capture restore must not wedge the recorder */ }
      // 4.4: the persisted camera selection restores the same way.
      try {
        ps.push(getCameraSelector().restoreOnBoot());
      } catch (e) { /* camera restore must not wedge the recorder */ }
      return Promise.all(ps.map(function (p) {
        return Promise.resolve(p).then(function () { return null; },
          function () { return null; /* boot restore is best-effort */ });
      }));
    }

    // Map a handler failure to channel data (3.2 SF-1: never throw
    // across the channel). RangeError here means an unknown deviceId
    // (the contract-pinned 'unknown-device'); TypeError means a malformed
    // request.
    function toChannelError(err) {
      return toChannelErrorWith(err, 'unknown-device');
    }

    // 4.3: the capture channel maps RangeError to 'unknown-mode' instead.
    function toCaptureChannelError(err) {
      return toChannelErrorWith(err, 'unknown-mode');
    }

    function toChannelErrorWith(err, rangeErrorCode) {
      if (err instanceof RangeError) {
        return { ok: false, error: rangeErrorCode };
      }
      if (err instanceof TypeError) {
        return { ok: false, error: 'invalid-request' };
      }
      return { ok: false, error: 'internal-error' };
    }

    // Drive a promise-returning handler and answer asynchronously.
    // Returns true (async sendResponse); every rejection becomes data.
    // mapErr selects the channel's error vocabulary (4.2 mic vs 4.3
    // capture).
    function respondAsync(promise, sendResponse, mapErr) {
      var toErr = (typeof mapErr === 'function') ? mapErr : toChannelError;
      Promise.resolve(promise).then(function (result) {
        try {
          sendResponse(isPlainObject(result) ? result : { ok: true, result: result });
        } catch (e) { /* channel closed; nothing more to do */ }
      }, function (err) {
        try {
          sendResponse(toErr(err));
        } catch (e) { /* channel closed; nothing more to do */ }
      });
      return true;
    }

    function handleSetSession(message, sendResponse) {
      var sid = message.sessionId;
      var gid = message.gameId;
      if (!((typeof sid === 'string' && sid !== '') || sid === null) ||
          !((typeof gid === 'string' && gid !== '') || gid === null)) {
        try {
          sendResponse({ ok: false, error: 'invalid-request' });
        } catch (e) { /* ignore */ }
        return false;
      }
      sessionId = sid;
      gameId = gid;
      // A newly activated session announces the current selection once,
      // so the session's event stream carries the selection state (the
      // boot-time restore and any pre-session user selection were inert
      // by design). The announced source is the selection's actual source.
      if (isSessionActive()) {
        try {
          getMicSelector().announceSelectionForSession();
        } catch (e) {
          try {
            sendResponse({ ok: false, error: 'internal-error' });
          } catch (w) { /* ignore */ }
          return false;
        }
        // 4.3: the capture-mode selection announces the same way.
        try {
          getCaptureSelector().announceSelectionForSession();
        } catch (e) {
          try {
            sendResponse({ ok: false, error: 'internal-error' });
          } catch (w) { /* ignore */ }
          return false;
        }
        // 4.4: the camera selection announces the same way.
        try {
          getCameraSelector().announceSelectionForSession();
        } catch (e) {
          try {
            sendResponse({ ok: false, error: 'internal-error' });
          } catch (w) { /* ignore */ }
          return false;
        }
      }
      try {
        sendResponse({ ok: true });
      } catch (e) { /* ignore */ }
      return false;
    }

    function handleMicCommand(message, sendResponse) {
      var sel;
      try {
        sel = getMicSelector();
      } catch (e) {
        try {
          sendResponse(toChannelError(e));
        } catch (w) { /* ignore */ }
        return false;
      }
      // Deferred inside the promise: a synchronously-throwing selector
      // (e.g. unavailable mediaDevices) becomes a rejection, which
      // respondAsync converts to {ok:false} — the listener never throws.
      function deferred(fn) {
        return respondAsync(Promise.resolve().then(fn), sendResponse);
      }
      if (message.msg === MSG_MIC_LIST) {
        return deferred(function () { return sel.listDevices(); });
      }
      if (message.msg === MSG_MIC_SELECT) {
        if (typeof message.deviceId !== 'string' || message.deviceId === '') {
          try {
            sendResponse({ ok: false, error: 'invalid-request' });
          } catch (e) { /* ignore */ }
          return false;
        }
        return deferred(function () { return sel.select(message.deviceId); });
      }
      if (message.msg === MSG_MIC_PERMISSION) {
        return deferred(function () { return sel.requestPermission(); });
      }
      if (message.msg === MSG_MIC_STATE) {
        return deferred(function () { return sel.getState(); });
      }
      return false; // unknown msg: ignore, no response (4.1 behavior)
    }

    // 4.4: camera commands. Mirrors handleMicCommand exactly; the same
    // channel error vocabulary applies (RangeError → 'unknown-device',
    // TypeError → 'invalid-request'), per the 4.4 contract's table.
    function handleCamCommand(message, sendResponse) {
      var sel;
      try {
        sel = getCameraSelector();
      } catch (e) {
        try {
          sendResponse(toChannelError(e));
        } catch (w) { /* ignore */ }
        return false;
      }
      // Deferred inside the promise: a synchronously-throwing selector
      // (e.g. unavailable mediaDevices) becomes a rejection, which
      // respondAsync converts to {ok:false} — the listener never throws.
      function deferred(fn) {
        return respondAsync(Promise.resolve().then(fn), sendResponse);
      }
      if (message.msg === MSG_CAM_LIST) {
        return deferred(function () { return sel.listDevices(); });
      }
      if (message.msg === MSG_CAM_SELECT) {
        if (typeof message.deviceId !== 'string' || message.deviceId === '') {
          try {
            sendResponse({ ok: false, error: 'invalid-request' });
          } catch (e) { /* ignore */ }
          return false;
        }
        return deferred(function () { return sel.select(message.deviceId); });
      }
      if (message.msg === MSG_CAM_PERMISSION) {
        return deferred(function () { return sel.requestPermission(); });
      }
      if (message.msg === MSG_CAM_STATE) {
        return deferred(function () { return sel.getState(); });
      }
      return false; // unknown msg: ignore, no response (4.1 behavior)
    }

    if (announce) {
      announceReady();
    }

    return {
      bootId: function () { return bootId; },
      bootTime: function () { return bootTime; },
      announceReady: announceReady,
      installListener: installListener,
      onRuntimeMessage: onRuntimeMessage,
      // 4.2 surface (Node tests drive these directly).
      getMicSelector: getMicSelector,
      // 4.4 surface (Node tests drive these directly).
      getCameraSelector: getCameraSelector,
      // 4.3 surface (Node tests drive these directly).
      getCaptureSelector: getCaptureSelector,
      createBrokerClient: createBrokerClient,
      // 4.5 surface (Node tests drive these directly; 4.6 calls
      // getFormatSupport().recordSegmentFormat at stream start).
      getFormatSupport: getFormatSupport,
      // 4.7 surface (Node tests drive these directly; 4.7's
      // classifications are wired into the stream starter).
      getAudioPolicy: getAudioPolicy,
      // 4.10 surface (Node tests drive this directly; the stream
      // starter writes the clock link at manifest-write time; 4.13
      // calls getClockLink().linkClockSegment for each
      // post-discontinuity segmentId it mints).
      getClockLink: getClockLink,
      // 4.6 surface (Node tests drive these directly; §5 drives the
      // recorder-start-streams channel message).
      getStreamStarter: getStreamStarter,
      // 4.8 surface (Node tests drive this directly; the
      // recorder-start-streams handler starts chunking automatically for
      // every successfully started stream — no new channel message).
      getChunkWriter: getChunkWriter,
      // 4.9 surface (Node tests drive this directly; the
      // recorder-start-streams handler attaches monitoring for every
      // successfully started stream and emits restart discontinuities).
      getTrackMonitor: getTrackMonitor,
      // 4.11 surface (Node tests drive this directly; the
      // recorder-start-streams handler emits the start marker for every
      // generation with ≥1 started stream; 4.13 calls
      // getSyncMarker().emitStopMarker() BEFORE recorder.stop()).
      getSyncMarker: getSyncMarker,
      // 4.13 surface (Node tests drive this directly; the
      // recorder-stop-streams handler stops the streams and finalizes
      // the segments through the finalizer).
      getFinalizer: getFinalizer,
      // 4.14 surface (Node tests drive this directly; the
      // recorder-get-status handler answers per-stream status through
      // the status reader — read-only, never throws into the
      // channel).
      getStreamStatusReader: getStreamStatusReader,
      restoreDevices: restoreDevices,
      getSession: function () { return { sessionId: sessionId, gameId: gameId }; }
    };
  }

  // ------------------------------------------------------------------
  // Exports.
  // ------------------------------------------------------------------

  BlindfoldSession.RECORDER_MSG_KIND = RECORDER_MSG_KIND;
  BlindfoldSession.RECORDER_PROTOCOL_V = RECORDER_PROTOCOL_V;
  BlindfoldSession.RECORDER_STATE_IDLE = RECORDER_STATE_IDLE;
  BlindfoldSession.RECORDER_MSG_READY = MSG_READY;
  BlindfoldSession.RECORDER_MSG_PING = MSG_PING;
  BlindfoldSession.RECORDER_MSG_PONG = MSG_PONG;
  BlindfoldSession.RECORDER_MSG_SET_SESSION = MSG_SET_SESSION;
  BlindfoldSession.RECORDER_MSG_MIC_LIST = MSG_MIC_LIST;
  BlindfoldSession.RECORDER_MSG_MIC_SELECT = MSG_MIC_SELECT;
  BlindfoldSession.RECORDER_MSG_MIC_PERMISSION = MSG_MIC_PERMISSION;
  BlindfoldSession.RECORDER_MSG_MIC_STATE = MSG_MIC_STATE;
  BlindfoldSession.RECORDER_MSG_CAM_LIST = MSG_CAM_LIST;
  BlindfoldSession.RECORDER_MSG_CAM_SELECT = MSG_CAM_SELECT;
  BlindfoldSession.RECORDER_MSG_CAM_PERMISSION = MSG_CAM_PERMISSION;
  BlindfoldSession.RECORDER_MSG_CAM_STATE = MSG_CAM_STATE;
  BlindfoldSession.RECORDER_MSG_CAPTURE_LIST = MSG_CAPTURE_LIST;
  BlindfoldSession.RECORDER_MSG_CAPTURE_SELECT = MSG_CAPTURE_SELECT;
  BlindfoldSession.RECORDER_MSG_CAPTURE_PERMISSION = MSG_CAPTURE_PERMISSION;
  BlindfoldSession.RECORDER_MSG_CAPTURE_STATE = MSG_CAPTURE_STATE;
  BlindfoldSession.RECORDER_MSG_CAPTURE_RESOLVE_TAB = MSG_CAPTURE_RESOLVE_TAB;
  BlindfoldSession.RECORDER_MSG_CAPTURE_QUERY_PERMISSION = MSG_CAPTURE_QUERY_PERMISSION;
  BlindfoldSession.RECORDER_MSG_CAPTURE_GET_STREAM_ID = MSG_CAPTURE_GET_STREAM_ID;
  BlindfoldSession.RECORDER_MSG_GET_FORMATS = MSG_FORMATS;
  BlindfoldSession.RECORDER_MSG_START_STREAMS = MSG_START_STREAMS;
  BlindfoldSession.RECORDER_MSG_STOP_STREAMS = MSG_STOP_STREAMS;
  BlindfoldSession.RECORDER_MSG_GET_STATUS = MSG_GET_STATUS;
  BlindfoldSession.RECORDER_MSG_SYNC_FLASH = MSG_SYNC_FLASH;
  BlindfoldSession.RECORDER_SOURCE_CONTEXT = RECORDER_SOURCE_CONTEXT;
  BlindfoldSession.isRecorderMessage = isRecorderMessage;
  BlindfoldSession.createOffscreenRecorder = createOffscreenRecorder;
})();

// Auto-boot in a real document context (the offscreen document): construct
// the recorder (announces recorder-ready) and install the ping responder.
// Skipped in Node (the module.exports shim below claims the file) and in
// the service worker (no document there — recording_host.js supervises).
if ((typeof module === 'undefined' || !module.exports) &&
    typeof document !== 'undefined') {
  (function () {
    'use strict';
    var BS = (typeof globalThis !== 'undefined' && globalThis.BlindfoldSession) ?
      globalThis.BlindfoldSession : BlindfoldSession;
    var g = (typeof globalThis !== 'undefined') ? globalThis : null;
    var hasRuntime = g && g.chrome && g.chrome.runtime &&
      typeof g.chrome.runtime.onMessage !== 'undefined';
    if (!hasRuntime || typeof BS.createOffscreenRecorder !== 'function') {
      return;
    }
    try {
      var recorder = BS.createOffscreenRecorder({ chromeNs: g.chrome });
      recorder.installListener();
      // 4.2: best-effort boot restore of the persisted mic selection.
      // Silent when inert (no session yet); never throws.
      recorder.restoreDevices();
      // 4.9 V2 introspection seam: the sw-track-monitor harness reaches
      // the recorder's getTrackMonitor() through this handle to force
      // track.stop() on a real track and observe the resulting events.
      // Test-only; product code never reads this.
      g.__blindfoldRecorderForTests = recorder;
    } catch (e) {
      // A recorder that cannot boot must not take the document down with
      // an uncaught error; the SW re-discovers via hasDocument() + ping.
    }
  })();
}

// Node test shim. The offscreen document loads this via <script>; only
// environments that provide CommonJS get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
