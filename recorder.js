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
// Dependency-free classic script → guarded BlindfoldSession global → IIFE
// 'use strict' → Node module.exports shim (repo house convention).
//
// Message contract (4.1 owns the channel; later tasks add commands):
//   envelope: { kind: 'recorder', msg: '<name>', v: 1, ...fields }
//   offscreen → SW : 'recorder-ready' { bootId, bootTime }
//   SW → offscreen : 'recorder-ping'  {}
//   offscreen → SW : 'recorder-pong'  { ok, bootId, state, nowMonotonicMs }
// 'recorder-pong'.nowMonotonicMs is a performance.now() reading — the hook
// later tasks (4.10/4.12) use for clock-anchor alignment.
//
// Error conventions (AGENTS.md): TypeError = wrong type/shape;
// RangeError = bad domain value; plain Error = unavailable platform
// capability (e.g. no crypto.randomUUID — never a weak fallback).

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
  function createOffscreenRecorder(opts) {
    var o = opts || {};
    var chromeNs = o.chromeNs === undefined ? readChromeNs() : o.chromeNs;
    var nowUtcIso = typeof o.nowUtcIso === 'function' ?
      o.nowUtcIso : function () { return new Date().toISOString(); };
    var announce = o.announce === undefined ? true : !!o.announce;

    var bootId = newUuidV4();
    var bootTime = nowUtcIso();

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

    if (announce) {
      announceReady();
    }

    return {
      bootId: function () { return bootId; },
      bootTime: function () { return bootTime; },
      announceReady: announceReady,
      installListener: installListener,
      onRuntimeMessage: onRuntimeMessage
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
