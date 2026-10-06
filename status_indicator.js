// status_indicator.js
//
// Task 2.8 (PLAN.md §2.8): surface write failures and storage-capacity
// problems in the session status indicator.
//
// A minimal in-page health light for the content-script sender's recorder
// health — one element, one of four states, the raw failure code as a
// tooltip. NOT a dashboard: no counts, no history, no metrics, no user
// interaction (PLAN forbids dashboards; raw-data collection scope only).
//
// Classification is a pure function (classifySenderStatus) separate from
// DOM rendering, so it is independently unit-testable. sender.js is
// untouched: getStatus() already exposes pendingCount, lastError,
// transportAvailable, retryScheduled.
//
// Failure taxonomy (closed — the sender only produces these lastError
// shapes; see sender.js recordAckFailure and the pump):
//   transient family:  'send-timeout', 'no-ack', 'transport-error:<name>'
//   persistent family:  any 'write-failed:<code>' (writer rejected the
//     write; the head event never dequeues, so this latches)
//   storage-capacity:   'write-failed:QuotaExceededError' — the writer's
//     toWriteFailed already propagates the DOMException name via
//     errorName, so quota failures arrive with this exact code today.
//     Deliberately reactive-only: no navigator.storage.estimate() polling
//     (new timer, new failure modes, weaker signal than the ground-truth
//     write failure).
// Fail-closed rule: any non-null lastError outside the transient family
// is persistent. A failure we do not understand must never be presented
// as "will recover." Note '' (empty string) is fail-closed to persistent:
// the sender never produces it (lastError is null or a non-empty string),
// so seeing one means something is wrong, not something is fine.
//
// Dependency-free plain script. Loads as a content-script global (via the
// manifest js list, before content.js) or under Node via the
// module.exports shim at the end. No chrome.* APIs — DOM + sender only,
// by design; document access is guarded so the module loads in Node.
//
// Error conventions (AGENTS.md): TypeError = wrong type/shape;
// plain Error = unavailable platform capability.

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // Closed health-state set.
  var STATE_HEALTHY = 'healthy';
  var STATE_DEGRADED = 'degraded-retrying';
  var STATE_FAILED = 'failed-persistent';
  var STATE_STORAGE_FULL = 'failed-storage-full';

  var DEFAULT_POLL_INTERVAL_MS = 2000;

  var TRANSIENT_TIMEOUT = 'send-timeout';
  var TRANSIENT_NO_ACK = 'no-ack';
  var TRANSIENT_TRANSPORT_PREFIX = 'transport-error:';
  var WRITE_FAILED_PREFIX = 'write-failed:';
  var QUOTA_CODE = 'write-failed:QuotaExceededError';

  // Pure classification. Input: the object returned by sender.getStatus().
  // Output: frozen {state, detail} — detail is the raw lastError string,
  // or null when healthy. Throws TypeError on malformed input.
  function classifySenderStatus(status) {
    if (status === null || typeof status !== 'object' || Array.isArray(status)) {
      throw new TypeError('status must be a sender status object');
    }
    if (typeof status.pendingCount !== 'number' || !isFinite(status.pendingCount)) {
      throw new TypeError('status.pendingCount must be a finite number');
    }
    if (status.lastError !== null && typeof status.lastError !== 'string') {
      throw new TypeError('status.lastError must be a string or null');
    }
    if (typeof status.transportAvailable !== 'boolean') {
      throw new TypeError('status.transportAvailable must be a boolean');
    }
    if (typeof status.retryScheduled !== 'boolean') {
      throw new TypeError('status.retryScheduled must be a boolean');
    }

    var lastError = status.lastError;
    var state;
    if (lastError === null) {
      // A non-empty queue with no failure is normal draining (including
      // the pre-transport "waiting for SW" state) — never cry wolf.
      state = STATE_HEALTHY;
    } else if (lastError === TRANSIENT_TIMEOUT ||
               lastError === TRANSIENT_NO_ACK ||
               (lastError.indexOf(TRANSIENT_TRANSPORT_PREFIX) === 0)) {
      state = STATE_DEGRADED;
    } else if (lastError === QUOTA_CODE) {
      state = STATE_STORAGE_FULL;
    } else {
      // Any other non-null lastError — every 'write-failed:<code>' and
      // anything unrecognized — is persistent. Fail-closed.
      state = STATE_FAILED;
    }
    return Object.freeze({ state: state, detail: lastError });
  }

  // Creates the indicator element, attaches it near the extension's own
  // move-input UI (fixed-corner fallback when the anchor is absent), and
  // polls sender.getStatus() on an injectable interval, re-rendering only
  // on state/detail change.
  //
  // sender: the object returned by BlindfoldSession.createSender()
  //   (must expose getStatus()). options: {intervalMs} (default 2000).
  // Returns {element, stop}. Never throws into the caller after install:
  // poll errors are swallowed and the indicator keeps its last state.
  // Invalid sender/options throw TypeError synchronously, before any
  // timer starts. Missing document is a platform capability problem and
  // throws plain Error.
  function installStatusIndicator(sender, options) {
    if (sender === null || typeof sender !== 'object' ||
        typeof sender.getStatus !== 'function') {
      throw new TypeError('sender must expose getStatus()');
    }
    var opts = options === undefined || options === null ? {} : options;
    if (typeof opts !== 'object' || Array.isArray(opts)) {
      throw new TypeError('options must be an object');
    }
    var intervalMs = opts.intervalMs === undefined
      ? DEFAULT_POLL_INTERVAL_MS : opts.intervalMs;
    if (typeof intervalMs !== 'number' || !isFinite(intervalMs) ||
        intervalMs <= 0) {
      throw new TypeError('options.intervalMs must be a positive finite number');
    }

    var doc = (typeof document !== 'undefined') ? document : null;
    if (doc === null) {
      throw new Error('status indicator requires a document');
    }

    var el = doc.createElement('span');
    el.className = 'blindfold-status-indicator blindfold-status-healthy';
    el.setAttribute('aria-hidden', 'true');
    el.textContent = '●';

    // Anchor: the extension's own move-input UI. Never touches chess.com
    // layout beyond our own element; fixed-corner fallback when absent.
    var usedFallback = false;
    var anchor = doc.getElementById('blindfold-chess-move-input');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(el, anchor.nextSibling);
    } else {
      usedFallback = true;
      el.className += ' blindfold-status-fallback';
      doc.body.appendChild(el);
    }

    var lastRendered = null; // {state, detail} or null
    var timerId = null;
    var stopped = false;

    function render(classified) {
      if (lastRendered !== null &&
          lastRendered.state === classified.state &&
          lastRendered.detail === classified.detail) {
        return; // no DOM churn per poll
      }
      lastRendered = classified;
      var base = 'blindfold-status-indicator blindfold-status-' + classified.state;
      if (usedFallback) {
        base += ' blindfold-status-fallback';
      }
      el.className = base;
      if (classified.detail === null) {
        el.removeAttribute('title');
      } else {
        el.setAttribute('title', classified.detail);
      }
    }

    function tick() {
      if (stopped) return;
      try {
        render(classifySenderStatus(sender.getStatus()));
      } catch (pollErr) {
        // A throwing getStatus (or anything else) never propagates into
        // page code; the indicator keeps its last rendered state.
      }
      var setTimeoutFn = globalThis.setTimeout;
      timerId = setTimeoutFn(tick, intervalMs);
    }

    // First render runs inside the same swallowed-error path as every
    // poll: a throwing getStatus on the first call degrades to an
    // unrendered-but-present indicator, never to a throw.
    tick();

    return {
      element: el,
      stop: function () {
        stopped = true;
        if (timerId !== null) {
          globalThis.clearTimeout(timerId);
          timerId = null;
        }
      }
    };
  }

  BlindfoldSession.STATUS_HEALTHY = STATE_HEALTHY;
  BlindfoldSession.STATUS_DEGRADED_RETRYING = STATE_DEGRADED;
  BlindfoldSession.STATUS_FAILED_PERSISTENT = STATE_FAILED;
  BlindfoldSession.STATUS_FAILED_STORAGE_FULL = STATE_STORAGE_FULL;
  BlindfoldSession.STATUS_POLL_INTERVAL_MS = DEFAULT_POLL_INTERVAL_MS;
  BlindfoldSession.classifySenderStatus = classifySenderStatus;
  BlindfoldSession.installStatusIndicator = installStatusIndicator;
})();

// Node test shim. Content-script consumers use the BlindfoldSession global
// directly; only environments that provide CommonJS get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
