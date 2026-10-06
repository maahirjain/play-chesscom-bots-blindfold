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

    // 4.3: the SW-side capture broker (capture_broker.js). Owns every
    // chrome.* call the offscreen capture selector needs (tabs.query,
    // permissions.contains, tabCapture.getMediaStreamId); the SW never
    // touches a MediaStream. Null when capture_broker.js is not loaded
    // (the broker is optional in Node tests of the 4.1 surface).
    var captureBroker = (function () {
      var BS = shared();
      if (BS && typeof BS.createCaptureBroker === 'function') {
        try {
          return BS.createCaptureBroker(chromeNs);
        } catch (e) {
          return null;
        }
      }
      return null;
    })();

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
      // 5.1: SW-side ensure for the Start control. Only the SW can call
      // chrome.offscreen.createDocument; the content script is the Start
      // origin and cannot ensure the document itself. Without this,
      // Start's recorder messages would go to a non-existent listener
      // and fail silently — the exact masquerade §4.14 exists to prevent.
      // Delegates to the existing idempotent ensureRecordingContext():
      // {ok:true, bootId, created} or {ok:false, reason}. Never throws
      // into the listener (3.2 SF-1 precedent).
      if (message.msg === 'recorder-ensure') {
        Promise.resolve()
          .then(function () { return ensureRecordingContext(); })
          .then(function (res) {
            try {
              sendResponse(isPlainObject(res) ? res :
                { ok: false, reason: 'internal-error' });
            } catch (e) { /* channel closed; nothing more to do */ }
          }, function (err) {
            try {
              sendResponse({ ok: false,
                reason: (err && err.message) || 'ensure-failed' });
            } catch (e) { /* channel closed; nothing more to do */ }
          });
        return true; // async sendResponse
      }
      // 4.3 SW-leg: the offscreen capture selector's broker client asks
      // the SW for chrome.* results. Each answers asynchronously with
      // plain data ({ok:true,...} or {ok:false, error}); a missing
      // broker or a throwing broker call becomes data, never a thrown
      // listener error (3.2 SF-1 precedent).
      if (message.msg === 'capture-resolve-tab' ||
          message.msg === 'capture-query-permission' ||
          message.msg === 'capture-get-stream-id') {
        return handleCaptureBrokerMessage(message, sendResponse);
      }
      // 4.11 SW-leg: relay the visible sync-marker flash request to the
      // target tab's sync_flash.js content script. The tab is resolved
      // through the 4.3 capture broker; an unreachable tab is honest
      // data ({ok:true, relayed:false, reason}), never a thrown
      // listener error (3.2 SF-1 precedent).
      if (message.msg === 'recorder-sync-flash') {
        return handleSyncFlashRelay(message, sendResponse);
      }
      return false; // unknown msg: ignore, no response
    }

    function handleCaptureBrokerMessage(message, sendResponse) {
      function answer(promise) {
        Promise.resolve(promise).then(function (result) {
          try {
            sendResponse(isPlainObject(result) ? result :
                         { ok: false, error: 'internal-error' });
          } catch (e) { /* channel closed; nothing more to do */ }
        }, function (err) {
          try {
            sendResponse({ ok: false,
                           error: (err && err.message) || 'internal-error' });
          } catch (e) { /* channel closed; nothing more to do */ }
        });
        return true; // async sendResponse
      }
      if (!captureBroker) {
        try {
          sendResponse({ ok: false, error: 'broker-unavailable' });
        } catch (e) { /* channel closed; nothing more to do */ }
        return false;
      }
      if (message.msg === 'capture-resolve-tab') {
        return answer(captureBroker.resolveTargetTab());
      }
      if (message.msg === 'capture-query-permission') {
        return answer(captureBroker.queryCapturePermission());
      }
      if (message.msg === 'capture-get-stream-id') {
        return answer(captureBroker.getStreamId(message.tabId));
      }
      return false;
    }

    // 4.11: relay the visible sync-marker flash to the target tab.
    // Resolves the tab through the 4.3 capture broker (the currently
    // captured tab when known, else the active Chess.com tab), then
    // chrome.tabs.sendMessage(tabId, {kind:'blindfold-sync-flash',
    // markerId, phase, sessionId}). Every outcome is data: {ok:true,
    // relayed:true} on attempt, {ok:true, relayed:false, reason} when
    // there is no tab or the send fails — the offscreen document turns
    // that into an honest 'skipped' marker event. Only a missing broker
    // is {ok:false} (wiring failure, the 4.3 precedent).
    function handleSyncFlashRelay(message, sendResponse) {
      function answer(result) {
        try {
          sendResponse(isPlainObject(result) ? result :
                       { ok: false, error: 'internal-error' });
        } catch (e) { /* channel closed; nothing more to do */ }
      }
      Promise.resolve()
        .then(function () {
          if (!captureBroker) {
            throw new Error('broker-unavailable');
          }
          return captureBroker.resolveTargetTab();
        })
        .then(function (res) {
          var tabId = (res && res.ok === true &&
                       typeof res.tabId === 'number') ? res.tabId : null;
          if (tabId === null) {
            return { ok: true, relayed: false,
                     reason: (res && typeof res.reason === 'string' &&
                              res.reason) || 'no-target-tab' };
          }
          var tabs = chromeNs.tabs;
          if (!tabs || typeof tabs.sendMessage !== 'function') {
            return { ok: true, relayed: false,
                     reason: 'tabs-unavailable' };
          }
          return Promise.resolve(tabs.sendMessage(tabId, {
            kind: 'blindfold-sync-flash',
            markerId: message.markerId,
            phase: message.phase,
            sessionId: message.sessionId
          })).then(function () {
            return { ok: true, relayed: true };
          }, function () {
            // The tab may have closed between resolve and send (or the
            // content script is absent) — honest data, not a throw.
            return { ok: true, relayed: false, reason: 'send-failed' };
          });
        })
        .then(answer, function (err) {
          answer({ ok: false,
                   error: (err && err.message) || 'internal-error' });
        });
      return true; // async sendResponse
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
      // 4.3 surface (Node tests drive the broker directly).
      getCaptureBroker: function () { return captureBroker; },
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
