// sync_marker.js
//
// Task 4.11 (PLAN.md §4.11): audible and visible synchronization markers
// at session start and stop, with their source timestamps saved.
//
// 4.6 starts each stream at its own actual time (not simultaneous), 4.10
// links every segment to its clock anchor, and 4.12 will compute
// per-stream offsets — but offsets need a shared observable reference
// point. 4.11 inserts one synchronization marker per recording generation
// at start AND at stop: an audible beep played through the speakers
// (captured acoustically by the mic) and a visible flash on the
// Chess.com page (captured by the screen recording). Each modality
// emission is timestamped at its source and saved as a `sync_marker`
// event sharing one markerId, so 4.12 can align each stream's media
// against the event log per modality.
//
// This module owns the AUDIBLE half (it lives in the offscreen document,
// the dedicated recording context with AUDIO_PLAYBACK) plus the relay
// request for the VISIBLE half (sync_flash.js, the content script, shows
// the flash and emits the visible event). It also defines the exact
// `emitStopMarker()` seam 4.13 must call before recorder.stop() — 4.11
// does NOT wire the stop marker itself.
//
// NOT a mixer (4.7 re-pin): the tone is played into the room through the
// speakers — acoustic, like 4.7's bleed reality. Nothing is routed into
// any MediaStream. Implementation uses HTMLAudioElement only: no
// AudioContext, no MediaStreamDestination, no AnalyserNode anywhere in
// this file (the 4.7 code-scan pin passes unmodified).
//
// A marker never fails recording: every path is guarded; a tone that
// cannot play becomes a 'failed' marker event, a flash relay that cannot
// reach a tab becomes a 'skipped' marker event. Streams keep recording.
//
// Dependency-free classic script → guarded BlindfoldSession global → IIFE
// 'use strict' → Node module.exports shim (repo house convention).
//
// Error conventions (AGENTS.md): TypeError = wrong type/shape;
// RangeError = bad domain value; plain Error = unavailable platform
// capability (never a weak fallback).

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Vocabulary (1.3 convention: each task defines its own *_EVENT_TYPE
  // constant(s) in its own module; flat snake_case, EVENT_TYPE_RE).
  // ------------------------------------------------------------------

  var SYNC_MARKER_EVENT_TYPE = 'sync_marker';

  var PHASES = ['start', 'stop'];
  var MODALITIES = ['audible', 'visible'];
  var STATUSES = ['played', 'shown', 'failed', 'skipped'];

  // The beep asset at the extension root (generated deterministically by
  // the 4.11 builder; see the build report for the generation command).
  var BEEP_ASSET = 'sync_beep.wav';
  // Stop-phase double-beep: onset-to-onset gap in ms (contract §2).
  var STOP_BEEP_GAP_MS = 150;

  var SYNC_MARKER_PAYLOAD_KEYS =
    ['markerId', 'phase', 'modality', 'status', 'error', 'detail'];

  var UUID_V4_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function shared() {
    if (typeof globalThis !== 'undefined' && globalThis.BlindfoldSession) {
      return globalThis.BlindfoldSession;
    }
    return BlindfoldSession;
  }

  function requireExactKeys(obj, expected, what) {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new TypeError('sync_marker: ' + what + ' must be an object');
    }
    var actual = Object.keys(obj).sort();
    var want = expected.slice().sort();
    if (actual.length !== want.length) {
      throw new TypeError('sync_marker: ' + what + ' must have exactly ' +
        want.length + ' keys, got ' + actual.length);
    }
    for (var i = 0; i < want.length; i++) {
      if (actual[i] !== want[i]) {
        throw new TypeError('sync_marker: ' + what + ' must have exactly ' +
          'the keys: ' + expected.join(', '));
      }
    }
    return obj;
  }

  function requireUuidV4(value, what) {
    if (typeof value !== 'string' || !UUID_V4_RE.test(value)) {
      throw new TypeError('sync_marker: ' + what +
        ' must be a uuid-v4 string');
    }
    return value;
  }

  function requireEnum(value, allowed, what) {
    if (typeof value !== 'string') {
      throw new TypeError('sync_marker: ' + what + ' must be a string');
    }
    if (allowed.indexOf(value) === -1) {
      throw new RangeError('sync_marker: unknown ' + what + ': ' + value);
    }
    return value;
  }

  function requireStringOrNull(value, what) {
    if (value !== null && typeof value !== 'string') {
      throw new TypeError('sync_marker: ' + what +
        ' must be a string or null');
    }
    return value;
  }

  // Payload constructor (exact keys; TypeError/RangeError per AGENTS.md).
  // Exported for tests and for the content-script half's parity pin.
  function createSyncMarkerPayload(input) {
    var p = input || {};
    requireExactKeys(p, SYNC_MARKER_PAYLOAD_KEYS, 'sync-marker payload');
    return {
      markerId: requireUuidV4(p.markerId, 'markerId'),
      phase: requireEnum(p.phase, PHASES, 'phase'),
      modality: requireEnum(p.modality, MODALITIES, 'modality'),
      status: requireEnum(p.status, STATUSES, 'status'),
      error: requireStringOrNull(p.error, 'error'),
      detail: requireStringOrNull(p.detail, 'detail')
    };
  }

  function verbatimError(err) {
    if (err === null || err === undefined) {
      return null;
    }
    if (typeof err === 'string') {
      return err;
    }
    var name = (typeof err.name === 'string' && err.name) ? err.name : null;
    var msg = (typeof err.message === 'string' && err.message) ?
      err.message : null;
    if (name && msg) {
      return name + ': ' + msg;
    }
    return name || msg || String(err);
  }

  // ------------------------------------------------------------------
  // The sync marker instance.
  //
  // opts:
  //   emitEvent      — (eventType, payload, refs) => envelope|null.
  //                    Required. Already session-gated by the caller
  //                    (recorder.js's emitRecorderEvent).
  //   getSessionId   — () => string|null. Required (refs.sessionId).
  //   sendRelayMessage — ({markerId, phase, sessionId}) =>
  //                    Promise<{ok, relayed, reason?}>. Required. The
  //                    offscreen→SW flash-relay request.
  //   audioFactory   — (url) => HTMLAudioElement-like ({play()}).
  //                    Required in production; injected for tests.
  //   assetUrl       — string URL of sync_beep.wav. Required.
  //   setTimeoutFn   — (fn, ms) => id. Required (stop double-beep gap).
  //   newUuidV4      — () => uuid-v4 string. Required.
  //
  // All platform access is injected: the module never touches chrome.*,
  // document, or Audio directly, so it is fully unit-testable in Node.
  // ------------------------------------------------------------------

  function createSyncMarker(opts) {
    var o = opts || {};
    if (typeof o.emitEvent !== 'function') {
      throw new TypeError('sync_marker: emitEvent is required');
    }
    if (typeof o.getSessionId !== 'function') {
      throw new TypeError('sync_marker: getSessionId is required');
    }
    if (typeof o.sendRelayMessage !== 'function') {
      throw new TypeError('sync_marker: sendRelayMessage is required');
    }
    if (typeof o.audioFactory !== 'function') {
      throw new TypeError('sync_marker: audioFactory is required');
    }
    if (typeof o.assetUrl !== 'string' || o.assetUrl === '') {
      throw new TypeError('sync_marker: assetUrl is required');
    }
    if (typeof o.setTimeoutFn !== 'function') {
      throw new TypeError('sync_marker: setTimeoutFn is required');
    }
    if (typeof o.newUuidV4 !== 'function') {
      throw new TypeError('sync_marker: newUuidV4 is required');
    }

    var emitEvent = o.emitEvent;
    var getSessionId = o.getSessionId;
    var sendRelayMessage = o.sendRelayMessage;
    var audioFactory = o.audioFactory;
    var assetUrl = o.assetUrl;
    var setTimeoutFn = o.setTimeoutFn;
    var newUuidV4 = o.newUuidV4;

    // Guarded emission: a marker event must never throw into the
    // recording pipeline (the 4.9 never-fail-the-pipeline rule).
    function safeEmit(payload) {
      try {
        emitEvent(SYNC_MARKER_EVENT_TYPE, payload,
          { sessionId: getSessionId() });
      } catch (e) { /* marker emission is best-effort */ }
    }

    // Play one beep and emit its audible event SYNCHRONOUSLY with the
    // play() call — no await between, so the envelope's monotonicMs IS
    // the beep time (contract §4). Because play() is async, a later
    // rejection cannot retract the 'played' event: it is the honest
    // record of the attempt (timestamped at the call). A rejection then
    // emits a second event with status 'failed' and the verbatim error
    // — the honest record of the outcome. Both are true observations;
    // events are append-only (2.4), so nothing is rewritten.
    function playBeep(markerId, phase) {
      var audio = null;
      try {
        audio = audioFactory(assetUrl);
      } catch (e) {
        safeEmit(createSyncMarkerPayload({
          markerId: markerId, phase: phase, modality: 'audible',
          status: 'failed', error: verbatimError(e), detail: null
        }));
        return;
      }
      if (!audio || typeof audio.play !== 'function') {
        safeEmit(createSyncMarkerPayload({
          markerId: markerId, phase: phase, modality: 'audible',
          status: 'failed', error: 'audio-unavailable', detail: null
        }));
        return;
      }
      var pr = null;
      try {
        pr = audio.play();
      } catch (e) {
        // Synchronous play() throw (rare; the promise rejection below
        // is the common failure path).
        safeEmit(createSyncMarkerPayload({
          markerId: markerId, phase: phase, modality: 'audible',
          status: 'failed', error: verbatimError(e), detail: null
        }));
        return;
      }
      safeEmit(createSyncMarkerPayload({
        markerId: markerId, phase: phase, modality: 'audible',
        status: 'played', error: null, detail: null
      }));
      if (pr && typeof pr.then === 'function') {
        pr.then(null, function (err) {
          safeEmit(createSyncMarkerPayload({
            markerId: markerId, phase: phase, modality: 'audible',
            status: 'failed', error: verbatimError(err),
            detail: 'play-promise-rejected'
          }));
        });
      }
      return;
    }

    // Request the visible flash via the SW relay. The content script
    // emits the 'shown' event itself (its own clock); this side emits
    // 'skipped' only when the relay honestly reports the flash cannot
    // happen (no target tab / send failed / relay unreachable).
    function requestFlash(markerId, phase) {
      var sessionId = null;
      try {
        sessionId = getSessionId();
      } catch (e) { /* fall through with null */ }
      var p = null;
      try {
        p = sendRelayMessage(
          { markerId: markerId, phase: phase, sessionId: sessionId });
      } catch (e) {
        safeEmit(createSyncMarkerPayload({
          markerId: markerId, phase: phase, modality: 'visible',
          status: 'skipped', error: null, detail: 'relay-threw'
        }));
        return;
      }
      Promise.resolve(p).then(function (ans) {
        if (ans && ans.relayed === true) {
          return; // the content script reports the flash itself
        }
        var reason = (ans && typeof ans.reason === 'string' && ans.reason) ?
          ans.reason : 'relay-failed';
        safeEmit(createSyncMarkerPayload({
          markerId: markerId, phase: phase, modality: 'visible',
          status: 'skipped', error: null, detail: reason
        }));
      }, function () {
        safeEmit(createSyncMarkerPayload({
          markerId: markerId, phase: phase, modality: 'visible',
          status: 'skipped', error: null, detail: 'relay-rejected'
        }));
      });
    }

    // One marker per phase per generation, fresh markerId each time.
    function emitPhaseMarker(phase, beepCount) {
      var markerId = newUuidV4();
      if (beepCount <= 1) {
        playBeep(markerId, phase);
      } else {
        // Stop phase: two beeps, onset-to-onset STOP_BEEP_GAP_MS apart.
        // No waiting for tone completion — alignment uses the marker
        // ONSET; a truncated tail does not invalidate it (contract §4).
        // The two beeps share the markerId; their order is the event
        // log's own sequence (sourceSeq/appendSeq) — no derivable
        // sequence field is persisted.
        playBeep(markerId, phase);
        setTimeoutFn(function () {
          try {
            playBeep(markerId, phase);
          } catch (e) { /* second beep is best-effort */ }
        }, STOP_BEEP_GAP_MS);
      }
      requestFlash(markerId, phase);
      return markerId;
    }

    // Start marker: one beep + flash relay. recorder.js calls this in
    // the start-streams final .then iff ≥1 stream started (contract §4).
    function emitStartMarker() {
      return emitPhaseMarker('start', 1);
    }

    // Stop marker: two beeps 150 ms apart + flash relay. 4.11 defines
    // this seam; 4.13 wires it (call BEFORE recorder.stop(), so the
    // marker is captured before the final flush — contract §4). NOT
    // called by anything in 4.11 (auditor check, not a defect).
    function emitStopMarker() {
      return emitPhaseMarker('stop', 2);
    }

    return {
      emitStartMarker: emitStartMarker,
      emitStopMarker: emitStopMarker,
      // Exposed for tests / the 4.13 seam documentation.
      stopBeepGapMs: function () { return STOP_BEEP_GAP_MS; },
      beepAsset: function () { return BEEP_ASSET; }
    };
  }

  // ------------------------------------------------------------------
  // Exports.
  // ------------------------------------------------------------------

  BlindfoldSession.SYNC_MARKER_EVENT_TYPE = SYNC_MARKER_EVENT_TYPE;
  BlindfoldSession.SYNC_MARKER_PHASES = Object.freeze(PHASES.slice());
  BlindfoldSession.SYNC_MARKER_MODALITIES = Object.freeze(MODALITIES.slice());
  BlindfoldSession.SYNC_MARKER_STATUSES = Object.freeze(STATUSES.slice());
  BlindfoldSession.SYNC_MARKER_PAYLOAD_KEYS =
    Object.freeze(SYNC_MARKER_PAYLOAD_KEYS.slice());
  BlindfoldSession.SYNC_BEEP_ASSET = BEEP_ASSET;
  BlindfoldSession.SYNC_STOP_BEEP_GAP_MS = STOP_BEEP_GAP_MS;
  BlindfoldSession.createSyncMarker = createSyncMarker;
  BlindfoldSession.createSyncMarkerPayload = createSyncMarkerPayload;
})();

// Node test shim. The offscreen document loads this via <script>; only
// environments that provide CommonJS get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
