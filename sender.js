// sender.js — content-script event sender (task 2.3: PLAN.md §2.3).
//
// Timestamps each observation at the moment of observation (1.3 clock),
// builds the frozen 11-key envelope, appends it to an in-memory FIFO queue
// immediately, and pumps the queue to the service worker via one-shot
// chrome.runtime.sendMessage with a stop-and-wait acknowledgment discipline.
//
// Design (see .autodev/evidence/2.3.contract.md):
//   - emit() is synchronous through timestamping and queueing:
//     performance.now() is read FIRST, then the envelope is built and
//     queued, then the async pump is kicked. The envelope's monotonicMs is
//     therefore the observation time, never the send time — even if the
//     service worker is dead and the event sits queued for the page's whole
//     lifetime. The pump never mutates a queued envelope.
//   - The clock anchor is captured at createSender() (context startup = one
//     segment per content-script instance) and emitted lazily as a
//     clock_anchor event (1.3's createAnchorEvent) on first emit() per
//     sessionId, with sourceSeq 0. The counter is per sender instance.
//   - Queue: unbounded in-memory FIFO, context-scoped (page unload discards
//     unacked events; loss is detectable via sourceSeq gaps, not hidden).
//     Stop-and-wait: exactly one event is ever unacknowledged.
//   - Transport: one-shot chrome.runtime.sendMessage (promise form), which
//     wakes an idle service worker. Resolved lazily per send attempt; with
//     no transport, events stay queued and emit() never throws.
//   - Sender -> SW message: { kind: 'event', event: <frozen envelope> }.
//     Expected ack (implemented by §2.4): { ok: true|false, eventId, error? }.
//     Anything but a matching positive ack keeps the head queued, records
//     lastError, and stops the pump. Never dequeue without a matching ack.
//   - flush() runs the pump to completion and reports {delivered, pending}
//     — the primitive §2.5's retry policy will call.
//   - 2.5 retry policy: every send attempt races a send timeout
//     (SENDER_SEND_TIMEOUT_MS); a failed head-of-queue attempt schedules
//     one fixed-interval retry timer (SENDER_RETRY_INTERVAL_MS) while the
//     context lives. Uniform retry — no failure classification; resends
//     are byte-identical and the §2.4 writer dedups by eventId.
//
// Intentionally absent (owned by later PLAN.md tasks):
//   - 2.4: SW intake (onMessage), envelope validation, dedup by eventId,
//     appendSeq assignment, ack responses, commit-awaiting semantics
//   - 2.6: restore after worker restart
//   - 2.7: page/context start and clean-end event types and emission
//     (the clock_anchor here is 1.3's, not 2.7's)
//   - 2.8: status-indicator UI (only getStatus() is provided)
//   - 2.9 / §6: retention and export
//   - queue persistence across page loads (context-scoped by design)
//
// Platform discipline: no chrome.* and no event_envelope.js exports are read
// at load time. chrome.runtime.sendMessage is resolved lazily per send
// attempt (bracket notation keeps the literal "chrome." out of the source so
// static guards can assert no extension-API use outside the resolver).
// event_envelope.js exports are read at CALL time through the shared
// BlindfoldSession namespace (never cached at load), so this module stays
// load-order independent: in classic-script contexts (content script,
// service worker via importScripts) the module binding IS the shared global;
// in Node tests the harness publishes the merged namespace on globalThis.
//
// Error conventions (AGENTS.md): wrong argument shape -> TypeError;
// unavailable performance.now -> plain Error (never a Date.now()
// substitution); transport absence/failure never throws — the event stays
// queued and lastError records it.

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  var SENDER_MESSAGE_KIND = 'event';
  var SOURCE_CONTEXT = 'content_script';

  // Task 2.5 retry policy constants (frozen numbers on the namespace,
  // following the SENDER_MESSAGE_KIND precedent).
  var SENDER_SEND_TIMEOUT_MS = 10000;
  var SENDER_RETRY_INTERVAL_MS = 5000;

  // Resolve the shared BlindfoldSession namespace at call time. Prefers the
  // globalThis-published namespace (Node test harness merges the separately
  // required modules there); falls back to the module-local binding, which
  // IS the shared global in classic-script contexts.
  function shared() {
    if (typeof globalThis !== 'undefined' &&
        globalThis.BlindfoldSession &&
        typeof globalThis.BlindfoldSession.createEvent === 'function') {
      return globalThis.BlindfoldSession;
    }
    return BlindfoldSession;
  }

  function perfNowMs() {
    var g = (typeof globalThis !== 'undefined') ? globalThis : null;
    var perf = g && g.performance;
    if (!perf || typeof perf.now !== 'function') {
      throw new Error('BlindfoldSession: performance.now() is unavailable in this environment');
    }
    return perf.now();
  }

  function resolveTransport(explicitTransport) {
    if (typeof explicitTransport === 'function') {
      return explicitTransport;
    }
    var g = (typeof globalThis !== 'undefined') ? globalThis : null;
    var chromeNs = g && g['chrome'];
    var runtime = chromeNs && chromeNs['runtime'];
    var sendMessage = runtime && runtime['sendMessage'];
    return (typeof sendMessage === 'function') ? sendMessage : null;
  }

  function errName(err) {
    return (err && typeof err.name === 'string' && err.name) ? err.name : 'Error';
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function requirePositiveFiniteNumber(value, name) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new TypeError('createSender options.' + name + ' must be a number');
    }
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError('createSender options.' + name + ' must be a finite number > 0');
    }
  }

  function createSender(options) {
    if (options !== undefined && options !== null && !isPlainObject(options)) {
      throw new TypeError('createSender options must be an object');
    }
    var explicitTransport = options ? options.transport : undefined;
    if (explicitTransport !== undefined && typeof explicitTransport !== 'function') {
      throw new TypeError('createSender options.transport must be a function');
    }
    var sendTimeoutMs = SENDER_SEND_TIMEOUT_MS;
    var retryIntervalMs = SENDER_RETRY_INTERVAL_MS;
    if (options) {
      if (options.sendTimeoutMs !== undefined) {
        requirePositiveFiniteNumber(options.sendTimeoutMs, 'sendTimeoutMs');
        sendTimeoutMs = options.sendTimeoutMs;
      }
      if (options.retryIntervalMs !== undefined) {
        requirePositiveFiniteNumber(options.retryIntervalMs, 'retryIntervalMs');
        retryIntervalMs = options.retryIntervalMs;
      }
    }

    // Anchor captured at construction = context startup. captureClockAnchor
    // throws a plain Error when performance.now is unavailable — honest
    // failure, never a Date.now() substitution (1.3 convention).
    var anchor = shared().captureClockAnchor();

    var queue = [];
    var nextSourceSeq = 0;
    var anchoredSessions = {};
    var lastError = null;
    var pumpPromise = null;
    // Task 2.5: at most one pending retry timer. The timer lives in this
    // context; page unload destroys it together with the queue — retry runs
    // exactly "while the originating context remains available".
    var retryTimerId = null;

    // setTimeout/clearTimeout are resolved from globalThis at call time
    // (matching the transport-lazy pattern), so node:test mock.timers works
    // and no timer handle is cached at load.
    function scheduleRetry() {
      if (queue.length === 0 || retryTimerId !== null) {
        return;
      }
      if (resolveTransport(explicitTransport) === null) {
        return; // nothing to retry with (2.3 no-transport rule)
      }
      var g = (typeof globalThis !== 'undefined') ? globalThis : null;
      var st = g && g.setTimeout;
      if (typeof st !== 'function') {
        return; // no timers: a future emit()/flush() will kick the pump
      }
      retryTimerId = st.call(g, onRetryTimer, retryIntervalMs);
    }

    function onRetryTimer() {
      retryTimerId = null;
      kickPump();
    }

    function clearRetry() {
      if (retryTimerId !== null) {
        var g = (typeof globalThis !== 'undefined') ? globalThis : null;
        var ct = g && g.clearTimeout;
        if (typeof ct === 'function') {
          ct.call(g, retryTimerId);
        }
        retryTimerId = null;
      }
    }

    function isPositiveAck(response, headEventId) {
      return response !== null && typeof response === 'object' &&
        response.ok === true && response.eventId === headEventId;
    }

    function recordAckFailure(response, headEventId) {
      // ok:false with a matching eventId keeps the writer's error string;
      // undefined, shape mismatch, and eventId mismatch are all 'no-ack'.
      if (response !== null && typeof response === 'object' &&
          response.ok === false && response.eventId === headEventId) {
        lastError = (typeof response.error === 'string' && response.error) ?
          response.error : 'write-failed';
      } else {
        lastError = 'no-ack';
      }
    }

    // Single delivery engine shared by the fire-and-forget pump and flush().
    // Resolves (never rejects) with {delivered, pending} when the pump stops:
    // queue drained, no transport, or an attempt failed. Concurrent callers
    // share the in-flight run.
    //
    // Subtlety: the Promise executor runs synchronously, so a run that
    // finishes without awaiting (empty queue, no transport, sync transport
    // failure) calls finish() BEFORE the `pumpPromise = myPromise`
    // assignment below executes — an unconditional `pumpPromise = null`
    // inside finish() would be clobbered by that assignment, leaving a
    // stale resolved promise that later callers would wrongly join. The
    // `finished` flag + identity check close that race: the shared slot is
    // cleared exactly once per run, whichever path finishes it.
    function runPump() {
      if (pumpPromise) {
        return pumpPromise;
      }
      // A new explicit kick supersedes any scheduled retry (2.5).
      clearRetry();
      var delivered = 0;
      var finished = false;
      var myPromise = new Promise(function (resolve) {
        function finish() {
          finished = true;
          var summary = { delivered: delivered, pending: queue.length };
          if (pumpPromise === myPromise) {
            pumpPromise = null;
          }
          resolve(summary);
        }
        // A failed send attempt: record the failure, stop the pump, and
        // schedule one retry (2.5). Uniform retry — no classification of
        // transport errors, timeouts, or writer {ok:false} rejections.
        function failAttempt() {
          finish();
          scheduleRetry();
        }
        function clearSendTimeout(timeoutId) {
          if (timeoutId !== null) {
            var g = (typeof globalThis !== 'undefined') ? globalThis : null;
            var ct = g && g.clearTimeout;
            if (typeof ct === 'function') {
              ct.call(g, timeoutId);
            }
          }
        }
        function step() {
          if (queue.length === 0) {
            finish();
            return;
          }
          var transport = resolveTransport(explicitTransport);
          if (!transport) {
            finish();
            return;
          }
          var head = queue[0];
          var message = { kind: SENDER_MESSAGE_KIND, event: head };
          var result;
          try {
            result = transport(message);
          } catch (err) {
            lastError = 'transport-error:' + errName(err);
            failAttempt();
            return;
          }
          var settled;
          try {
            settled = Promise.resolve(result);
          } catch (err) {
            lastError = 'transport-error:' + errName(err);
            failAttempt();
            return;
          }
          // Race the transport against the per-attempt send timeout. The
          // loser is discarded: a late ack cannot double-dequeue or corrupt
          // pump state, and the losing promise already has handlers attached
          // via the race, so no unhandled rejection can escape. If the late
          // ack was {ok:true}, the event was durably written; the retry's
          // byte-identical resend then receives the idempotent {ok:true}
          // from the writer's eventId dedup — correct, not a bug.
          var timeoutError = new Error('send-timeout');
          var timeoutId = null;
          var timeoutPromise = new Promise(function (_, reject) {
            var g = (typeof globalThis !== 'undefined') ? globalThis : null;
            var st = g && g.setTimeout;
            if (typeof st === 'function') {
              timeoutId = st.call(g, function () { reject(timeoutError); }, sendTimeoutMs);
            } else {
              reject(timeoutError); // no timers: fail fast, still retryable
            }
          });
          Promise.race([settled, timeoutPromise]).then(function (response) {
            clearSendTimeout(timeoutId);
            if (isPositiveAck(response, head.eventId)) {
              queue.shift();
              lastError = null;
              delivered += 1;
              step();
            } else {
              recordAckFailure(response, head.eventId);
              failAttempt();
            }
          }, function (err) {
            clearSendTimeout(timeoutId);
            if (err === timeoutError) {
              lastError = 'send-timeout';
            } else {
              lastError = 'transport-error:' + errName(err);
            }
            failAttempt();
          });
        }
        step();
      });
      pumpPromise = myPromise;
      if (finished) {
        // The run completed synchronously inside the executor (see the
        // note above): leave no stale promise behind for the next caller.
        pumpPromise = null;
      }
      return myPromise;
    }

    function kickPump() {
      // Fire-and-forget: runPump never rejects, so no unhandled rejection
      // can escape the sender.
      runPump();
    }

    function emit(input) {
      // Timestamp FIRST: the observation time, before validation, queueing,
      // or any send attempt.
      var monotonicMs = perfNowMs();
      if (!isPlainObject(input)) {
        throw new TypeError('emit input must be an object');
      }
      var BS = shared();
      var sessionId = input.sessionId;
      var gameId = (input.gameId === undefined) ? null : input.gameId;
      var refs = (input.refs === undefined) ? null : input.refs;

      // Build both envelopes before queueing either, assigning sequence
      // numbers from a candidate base: a validation throw consumes no
      // sourceSeq and leaves the queue untouched.
      var seqBase = nextSourceSeq;
      var needsAnchor = !Object.prototype.hasOwnProperty.call(anchoredSessions, sessionId);
      var toQueue = [];
      if (needsAnchor) {
        toQueue.push(BS.createAnchorEvent({
          sessionId: sessionId,
          sourceContext: SOURCE_CONTEXT,
          sourceSeq: seqBase,
          anchor: anchor
        }));
      }
      toQueue.push(BS.createEvent({
        eventType: input.eventType,
        sessionId: sessionId,
        gameId: gameId,
        sourceContext: SOURCE_CONTEXT,
        sourceSeq: seqBase + (needsAnchor ? 1 : 0),
        clockSegmentId: anchor.segmentId,
        monotonicMs: monotonicMs,
        payload: input.payload,
        refs: refs
      }));
      nextSourceSeq = seqBase + toQueue.length;
      for (var i = 0; i < toQueue.length; i++) {
        queue.push(toQueue[i]);
      }
      anchoredSessions[sessionId] = true;
      kickPump();
      return toQueue[toQueue.length - 1];
    }

    function flush() {
      return runPump();
    }

    function pendingCount() {
      return queue.length;
    }

    function getStatus() {
      return Object.freeze({
        pendingCount: queue.length,
        lastError: lastError,
        transportAvailable: resolveTransport(explicitTransport) !== null,
        // Task 2.5: lets 2.8 distinguish "stalled with recovery scheduled"
        // (working as designed) from "stalled with nothing scheduled".
        retryScheduled: retryTimerId !== null
      });
    }

    var sender = {
      emit: emit,
      flush: flush,
      pendingCount: pendingCount,
      getStatus: getStatus
    };
    Object.defineProperty(sender, 'anchor', {
      get: function () { return anchor; },
      enumerable: true
    });
    return Object.freeze(sender);
  }

  BlindfoldSession.createSender = createSender;
  BlindfoldSession.SENDER_MESSAGE_KIND = SENDER_MESSAGE_KIND;
  BlindfoldSession.SENDER_SEND_TIMEOUT_MS = SENDER_SEND_TIMEOUT_MS;
  BlindfoldSession.SENDER_RETRY_INTERVAL_MS = SENDER_RETRY_INTERVAL_MS;
})();

// Node test shim. importScripts() consumers use the BlindfoldSession global
// directly; only environments that provide CommonJS get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
