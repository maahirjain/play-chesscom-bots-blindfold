// recording_host.js
//
// Task 4.1 (PLAN.md §4.1): service-worker side supervision of the
// dedicated recording context (the MV3 offscreen document recorder.html).
//
// Imported by sw.js via importScripts(). Owns:
//   - idempotent, retry-safe ensureRecordingContext() — hasDocument() first,
//     collapsing concurrent creates onto one in-flight creation;
//   - the recorder-channel ping with injectable timeout
//     (Error('recorder-unreachable') on timeout);
//   - the SW-side recorder-ready listener (re-syncs in-memory state after
//     an SW restart; detects a fresh document vs a surviving one);
//   - SW-startup wiring that never throws.
//
// The offscreen document itself (recorder.js) is the ONLY place recording
// platform APIs may live; this module touches chrome.offscreen /
// chrome.runtime only. DOM-free: the chrome namespace is injected, so the
// whole module is unit-testable in Node with a mock.
//
// Lifecycle (contract §2):
//   - Survives Chess.com page refresh: the document is extension-owned and
//     independent of every content tab.
//   - Survives SW restart: the document keeps running; on SW startup this
//     module re-discovers it via hasDocument() and re-syncs via ping.
//   - Recreatable when lost: the next ensure()/ping recreates it; the gap
//     is detectable (lastKnownBootId vs fresh boot) for 4.9's discontinuity
//     logging. 4.1 only guarantees the loss is detectable.
//
// Error conventions (AGENTS.md): TypeError = wrong type/shape;
// RangeError = bad domain value; plain Error = unavailable platform
// capability.

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Constants.
  // ------------------------------------------------------------------

  var RECORDER_OFFSCREEN_URL = 'recorder.html';

  // Full Section-4 reason set, declared once up front: there is exactly one
  // offscreen document per extension and it hosts all of Section 4
  // (contract §1). 4.1 performs no capture itself.
  var RECORDER_REASONS = ['USER_MEDIA', 'DISPLAY_MEDIA', 'AUDIO_PLAYBACK'];

  var RECORDER_JUSTIFICATION =
    'Dedicated recording context for synchronized blindfold-chess research ' +
    'sessions: microphone, screen/tab, and webcam capture with event-time ' +
    'alignment (PLAN.md section 4).';

  var DEFAULT_PING_TIMEOUT_MS = 5000;

  // ------------------------------------------------------------------
  // Private helpers.
  // ------------------------------------------------------------------

  function shared() {
    if (typeof globalThis !== 'undefined' && globalThis.BlindfoldSession) {
      return globalThis.BlindfoldSession;
    }
    return BlindfoldSession;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function isRecorderEnvelope(m) {
    // Local envelope check (not via recorder.js: the SW never loads the
    // offscreen module; this file must stay self-sufficient).
    return isPlainObject(m) &&
      m.kind === 'recorder' &&
      typeof m.msg === 'string';
  }

  // ------------------------------------------------------------------
  // Recording host factory.
  //
  // chromeNs — the chrome namespace (injected; required).
  // opts:
  //   setTimeoutFn — (fn, ms) => id; injectable for Node tests.
  //   clearTimeoutFn — (id) => void; injectable for Node tests.
  //   pingTimeoutMs — default 5000 (contract §3).
  // ------------------------------------------------------------------
  function createRecordingHost(chromeNs, opts) {
    if (!isPlainObject(chromeNs)) {
      throw new TypeError('chromeNs must be an object');
    }
    var o = opts || {};
    var setTimeoutFn = typeof o.setTimeoutFn === 'function' ?
      o.setTimeoutFn : function (fn, ms) { return setTimeout(fn, ms); };
    var clearTimeoutFn = typeof o.clearTimeoutFn === 'function' ?
      o.clearTimeoutFn : function (id) { clearTimeout(id); };
    var pingTimeoutMs = o.pingTimeoutMs === undefined ?
      DEFAULT_PING_TIMEOUT_MS : o.pingTimeoutMs;

    var lastKnownBootId = null;
    var inflightEnsure = null;
    var createDocumentCalls = 0;
    var ensureCalls = 0;

    function offscreenNs() {
      return chromeNs.offscreen || null;
    }

    function runtimeNs() {
      return chromeNs.runtime || null;
    }

    // SF-1 repair (4.1 review): chrome.offscreen.hasDocument() is Chrome 150+,
    // while chrome.runtime.getContexts() is Chrome 116+. Prefer hasDocument
    // when present; fall back to getContexts otherwise. Documents the real
    // floor as Chrome 116+ (see DECISIONS.md §4.1).
    function offscreenAvailable() {
      var off = offscreenNs();
      if (!off || typeof off.createDocument !== 'function') {
        return false;
      }
      if (typeof off.hasDocument === 'function') {
        return true;
      }
      var runtime = runtimeNs();
      return !!runtime && typeof runtime.getContexts === 'function';
    }

    // Liveness probe for "does the offscreen document exist", using
    // whichever detection API the platform offers (see offscreenAvailable).
    function hasRecordingDocument() {
      var off = offscreenNs();
      if (off && typeof off.hasDocument === 'function') {
        return Promise.resolve().then(function () { return off.hasDocument(); });
      }
      var runtime = runtimeNs();
      if (runtime && typeof runtime.getContexts === 'function') {
        return Promise.resolve()
          .then(function () {
            return runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
          })
          .then(function (contexts) {
            return Array.isArray(contexts) && contexts.length > 0;
          });
      }
      return Promise.reject(
        new Error('recording_host: no offscreen document detection API available'));
    }

    // Liveness probe. Resolves the recorder-pong; rejects with a plain
    // Error('recorder-unreachable') when the document is gone (timeout or
    // send failure) so callers can treat "document gone" as a normal
    // branch, not an exception storm. Throws plain Error when the message
    // API itself is unavailable (unavailable platform capability).
    function pingRecorder(pingOpts) {
      var po = pingOpts || {};
      var timeoutMs = po.timeoutMs === undefined ? pingTimeoutMs : po.timeoutMs;
      var BS = shared();
      var runtime = runtimeNs();
      if (!runtime || typeof runtime.sendMessage !== 'function') {
        return Promise.reject(
          new Error('recording_host: extension runtime.sendMessage is unavailable'));
      }
      var v = (BS && typeof BS.RECORDER_PROTOCOL_V === 'number') ?
        BS.RECORDER_PROTOCOL_V : 1;
      var settled = false;
      var timerId = null;
      return new Promise(function (resolve, reject) {
        function done(fn, value) {
          if (settled) { return; }
          settled = true;
          if (timerId !== null) {
            try { clearTimeoutFn(timerId); } catch (e) { /* ignore */ }
          }
          fn(value);
        }
        try {
          timerId = setTimeoutFn(function () {
            done(reject, new Error('recorder-unreachable'));
          }, timeoutMs);
        } catch (e) {
          done(reject, new Error('recorder-unreachable'));
          return;
        }
        var sendResult;
        try {
          sendResult = runtime.sendMessage({
            kind: 'recorder',
            msg: 'recorder-ping',
            v: v
          });
        } catch (e) {
          // No receiver (document gone) — the normal "gone" branch.
          done(reject, new Error('recorder-unreachable'));
          return;
        }
        Promise.resolve(sendResult).then(function (pong) {
          if (!isPlainObject(pong) || pong.ok !== true) {
            done(reject, new Error('recorder-unreachable'));
            return;
          }
          done(resolve, pong);
        }, function () {
          // "Could not establish connection" and friends: document gone.
          done(reject, new Error('recorder-unreachable'));
        });
      });
    }

    // Idempotent, retry-safe ensure. Concurrent calls collapse onto one
    // in-flight creation (guard flag); every fresh call re-checks
    // hasDocument() first. On a platform without chrome.offscreen, reports
    // {ok:false, reason:'offscreen-unavailable'} as plain data — never throws
    // (contract §1: honest degradation, Chrome 116+ requirement documented
    // in DECISIONS.md).
    function ensureRecordingContext() {
      ensureCalls++;
      if (inflightEnsure) {
        return inflightEnsure;
      }
      inflightEnsure = runEnsure();
      // Clear the guard when the run settles (both outcomes), without
      // swallowing the result.
      var p = inflightEnsure.then(function (r) {
        inflightEnsure = null;
        return r;
      }, function (e) {
        inflightEnsure = null;
        throw e;
      });
      return p;
    }

    function runEnsure() {
      if (!offscreenAvailable()) {
        return Promise.resolve({ ok: false, reason: 'offscreen-unavailable' });
      }
      return Promise.resolve()
        .then(function () { return hasRecordingDocument(); })
        .then(function (has) {
          if (has) {
            return { created: false };
          }
          return createSingleDocument().then(function () {
            return { created: true };
          });
        })
        .then(function (outcome) {
          // Re-sync in-memory state with the live document (covers both a
          // surviving document after SW restart and a just-created one).
          return pingRecorder({}).then(function (pong) {
            lastKnownBootId = pong.bootId || null;
            return {
              ok: true,
              bootId: lastKnownBootId,
              created: outcome.created
            };
          }, function () {
            return { ok: false, reason: 'recorder-unreachable' };
          });
        });
    }

    // createDocument, hardened against the SW-may-die-during-create hazard:
    // if creation fails because a document appeared concurrently (or the SW
    // died mid-call and a retry re-enters), re-check hasDocument() and treat
    // a present document as the winner instead of failing.
    function createSingleDocument() {
      createDocumentCalls++;
      return Promise.resolve()
        .then(function () {
          return offscreenNs().createDocument({
            url: RECORDER_OFFSCREEN_URL,
            reasons: RECORDER_REASONS.slice(),
            justification: RECORDER_JUSTIFICATION
          });
        })
        .then(null, function (createErr) {
          return Promise.resolve()
            .then(function () { return hasRecordingDocument(); })
            .then(function (has) {
              if (has) {
                return null; // a concurrent creation won; adopt it
              }
              throw createErr;
            });
        });
    }

    // SW-side recorder-channel listener. Records recorder-ready (re-syncs
    // in-memory state; a bootId differing from lastKnownBootId marks a
    // fresh document — the detectable gap 4.9 will log). Ignores unknown
    // kinds/msgs (lenient-on-input); rejects unknown protocol versions with
    // {ok:false} — never throws.
    function onRuntimeMessage(message, sender, sendResponse) {
      if (!isRecorderEnvelope(message)) {
        return false; // not ours: ignore, no response
      }
      var BS = shared();
      var v = (BS && typeof BS.RECORDER_PROTOCOL_V === 'number') ?
        BS.RECORDER_PROTOCOL_V : 1;
      if (message.v !== v) {
        try {
          sendResponse({ ok: false, error: 'unsupported-protocol-version' });
        } catch (e) { /* channel closed; nothing more to do */ }
        return false;
      }
      if (message.msg === 'recorder-ready') {
        if (typeof message.bootId === 'string' && message.bootId) {
          lastKnownBootId = message.bootId;
        }
        return false; // announcement needs no ack
      }
      return false; // unknown msg: ignore, no response
    }

    function installRecorderListener() {
      var runtime = runtimeNs();
      var onMessage = runtime ? runtime.onMessage : null;
      if (!onMessage || typeof onMessage.addListener !== 'function') {
        return false;
      }
      onMessage.addListener(onRuntimeMessage);
      return true;
    }

    // SW-startup wiring. Installs the listener, then ensures the context
    // lazily in the background. NEVER throws: a failed ensure is a normal
    // branch the caller retries on demand (contract §2.4). SF-2 (4.1 review):
    // swallowed failures get a console.warn diagnostic trace — silent only
    // in the throw sense, never silent in the observability sense.
    function start() {
      try {
        installRecorderListener();
      } catch (e) {
        try { console.warn('[recording_host] listener install failed', e); } catch (w) { /* ignore */ }
      }
      try {
        var p = ensureRecordingContext();
        if (p && typeof p.catch === 'function') {
          p.catch(function (err) {
            try { console.warn('[recording_host] background ensure failed; retried on demand', err); } catch (w) { /* ignore */ }
          });
        }
      } catch (e) {
        try { console.warn('[recording_host] background ensure threw synchronously', e); } catch (w) { /* ignore */ }
      }
    }

    return {
      ensureRecordingContext: ensureRecordingContext,
      pingRecorder: pingRecorder,
      installRecorderListener: installRecorderListener,
      onRuntimeMessage: onRuntimeMessage,
      start: start,
      getLastKnownBootId: function () { return lastKnownBootId; },
      stats: function () {
        return {
          ensureCalls: ensureCalls,
          createDocumentCalls: createDocumentCalls
        };
      }
    };
  }

  // ------------------------------------------------------------------
  // Exports.
  // ------------------------------------------------------------------

  BlindfoldSession.RECORDER_OFFSCREEN_URL = RECORDER_OFFSCREEN_URL;
  BlindfoldSession.RECORDER_REASONS = RECORDER_REASONS;
  BlindfoldSession.RECORDER_JUSTIFICATION = RECORDER_JUSTIFICATION;
  BlindfoldSession.DEFAULT_PING_TIMEOUT_MS = DEFAULT_PING_TIMEOUT_MS;
  BlindfoldSession.createRecordingHost = createRecordingHost;
})();

// Node test shim. Loaded via importScripts() in the MV3 service worker;
// only environments that provide CommonJS get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
