// sync_flash.js
//
// Task 4.11 (PLAN.md §4.11): the VISIBLE half of the synchronization
// marker — a brief fullscreen flash on the Chess.com page, captured by
// the screen recording (both tab and screen modes: a page overlay is on
// the captured surface either way).
//
// Loaded as a content script (manifest.json content_scripts). It listens
// for {kind: 'blindfold-sync-flash', markerId, phase, sessionId} from the
// service worker (relayed from the offscreen document's audible marker),
// shows the flash, and emits the visible `sync_marker` event via the
// existing content-script path (BlindfoldSession.sender.emit — the
// 2.3/4.2 precedent) SYNCHRONOUSLY with the flash display, so the
// envelope's monotonicMs + clockSegmentId ARE the flash's source
// timestamps (no derivable values persisted).
//
// Flash spec (contract §3): fixed overlay, #fff, opacity 0→1→0 over
// ~200 ms, pointer-events: none, aria-hidden="true",
// z-index: 2147483647, removed from the DOM after the flash.
// Non-interactive by construction: no focus calls, no event listeners
// on the overlay — it cannot steal focus, receive clicks, or intercept
// keyboard input. The 3.2 move-input path and 3.3 visibility
// instrumentation see 200 ms of photons, not UI.
//
// The event type string: the canonical SYNC_MARKER_EVENT_TYPE constant
// lives in sync_marker.js (the offscreen module, 1.3 convention). This
// content script does not load that module, so it carries the pinned
// literal with a V1 test asserting both files agree.
//
// A marker must never break the page: every path is guarded.

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // Canonical definition: sync_marker.js
  // (BlindfoldSession.SYNC_MARKER_EVENT_TYPE). Pinned literal here so
  // this content script stays self-contained; tests/sync_marker.test.js
  // asserts the two agree.
  var SYNC_MARKER_EVENT_TYPE =
    (typeof globalThis !== 'undefined' && globalThis.BlindfoldSession &&
     typeof globalThis.BlindfoldSession.SYNC_MARKER_EVENT_TYPE === 'string') ?
      globalThis.BlindfoldSession.SYNC_MARKER_EVENT_TYPE :
      'sync_marker';

  var FLASH_MESSAGE_KIND = 'blindfold-sync-flash';
  // ~200 ms total: 60 ms fade-in, 80 ms hold, 60 ms fade-out.
  var FLASH_IN_MS = 60;
  var FLASH_HOLD_MS = 80;
  var FLASH_OUT_MS = 60;

  function getDocument() {
    if (typeof document === 'undefined') {
      return null;
    }
    return document;
  }

  // Show the flash; returns true when the overlay was actually
  // inserted (false → the 'failed' status, e.g. no DOM yet).
  function showFlash() {
    var doc = getDocument();
    if (!doc || !doc.body || typeof doc.createElement !== 'function') {
      return false;
    }
    var el = null;
    try {
      el = doc.createElement('div');
      el.setAttribute('aria-hidden', 'true');
      el.style.position = 'fixed';
      el.style.inset = '0';
      el.style.background = '#fff';
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
      el.style.zIndex = '2147483647';
      el.style.transition = 'opacity ' + FLASH_IN_MS + 'ms linear';
      doc.body.appendChild(el);
      // Force reflow so the transition runs from opacity 0.
      void el.offsetWidth;
      el.style.opacity = '1';
      var outTimer = (typeof setTimeout === 'function') ? setTimeout : null;
      if (outTimer) {
        outTimer(function () {
          try {
            el.style.transition =
              'opacity ' + FLASH_OUT_MS + 'ms linear';
            el.style.opacity = '0';
            outTimer(function () {
              try {
                if (el.parentNode) {
                  el.parentNode.removeChild(el);
                }
              } catch (e) { /* removal is best-effort */ }
            }, FLASH_OUT_MS + 20);
          } catch (e) { /* fade-out is best-effort */ }
        }, FLASH_IN_MS + FLASH_HOLD_MS);
      } else if (el.parentNode) {
        el.parentNode.removeChild(el);
      }
      return true;
    } catch (e) {
      try {
        if (el && el.parentNode) {
          el.parentNode.removeChild(el);
        }
      } catch (w) { /* ignore */ }
      return false;
    }
  }

  function shared() {
    if (typeof globalThis !== 'undefined' && globalThis.BlindfoldSession) {
      return globalThis.BlindfoldSession;
    }
    return BlindfoldSession;
  }

  // The visible event is emitted synchronously with the flash display —
  // the envelope timestamp IS the flash time (contract §3). sessionId
  // arrives in the relay message (the page's activeSessionId is not set
  // pre-§5; the offscreen document's 4.6 no-session guard is the
  // authority at marker time).
  function emitVisibleEvent(message, shown) {
    var BS = shared();
    if (!BS || !BS.sender || typeof BS.sender.emit !== 'function') {
      return;
    }
    var sessionId = (message && typeof message.sessionId === 'string' &&
      message.sessionId) ? message.sessionId :
      (BS.activeSessionId || null);
    try {
      BS.sender.emit({
        eventType: SYNC_MARKER_EVENT_TYPE,
        sessionId: sessionId,
        gameId: null,
        payload: {
          markerId: message.markerId,
          phase: message.phase,
          modality: 'visible',
          status: shown ? 'shown' : 'failed',
          error: null,
          detail: shown ? null : 'no-dom'
        },
        refs: { sessionId: sessionId }
      });
    } catch (e) { /* marker emission must never break the page */ }
  }

  function onRuntimeMessage(message) {
    if (!message || message.kind !== FLASH_MESSAGE_KIND) {
      return;
    }
    if (typeof message.markerId !== 'string' || !message.markerId ||
        (message.phase !== 'start' && message.phase !== 'stop')) {
      return; // malformed relay: ignore (lenient-on-input)
    }
    var shown = showFlash();
    emitVisibleEvent(message, shown);
  }

  function install() {
    var g = (typeof globalThis !== 'undefined') ? globalThis : null;
    var rt = g && g.chrome && g.chrome.runtime;
    if (rt && rt.onMessage &&
        typeof rt.onMessage.addListener === 'function') {
      rt.onMessage.addListener(onRuntimeMessage);
      return true;
    }
    return false;
  }

  install();

  // ------------------------------------------------------------------
  // Exports (tests + the SW relay path's documentation).
  // ------------------------------------------------------------------

  BlindfoldSession.SYNC_FLASH_MESSAGE_KIND = FLASH_MESSAGE_KIND;
  BlindfoldSession.syncFlashListener = onRuntimeMessage;
})();

// Node test shim.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
