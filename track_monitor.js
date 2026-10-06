// track_monitor.js
//
// Task 4.9 (PLAN.md §4.9): log recording track mute/unmute/end,
// recorder errors, and explicit recording discontinuities.
//
// 4.9 is the observation layer on top of 4.6's streams and 4.8's
// chunker: it attaches track.onmute / onunmute / onended and
// recorder.onerror listeners to every successfully started stream,
// watches chunk-writer terminal transitions via the onTerminalState
// seam, and emits restart discontinuities from recorder.js's manifest
// pre-check. Everything lands in the append-only event log (2.4) as
// three new event types; the manifest gains nothing (§1 of the 4.9
// contract).
//
// Monitoring can never fail the pipeline: every handler body is
// try/catch-guarded, malformed tracks are skipped, and a throwing
// emitEvent is tolerated — a failed observation is dropped, never
// thrown into the recording pipeline (the 4.8 "can never fail the
// streams" precedent).
//
// muted ≠ silent: track.muted is a platform flag; a muted track may
// still yield data. 4.9 logs the flag, never claims silence (the 4.7
// no-content-inference rule, applied to track state). No diagnosis of
// WHY anything happened — what the platform reports is what gets
// logged, error strings verbatim.
//
// Recording platform APIs live only in the offscreen document (4.1's
// rule): this module references no media-capture APIs at module scope —
// tracks and recorders arrive via attachStream(), and everything else
// is injected.
//
// Dependency-free classic script → guarded BlindfoldSession global → IIFE
// 'use strict' → Node module.exports shim (repo house convention).
//
// Error conventions (AGENTS.md): TypeError = wrong type/shape
// (incl. malformed IDs); RangeError = bad domain value; plain Error =
// unavailable platform capability (never a weak fallback).

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Constants.
  // ------------------------------------------------------------------

  // The three 4.9 event types (1.3 convention: each task defines its own
  // *_EVENT_TYPE constants in its own module). Flat snake_case, passing
  // EVENT_TYPE_RE (V1-pinned).
  var EVENT_TRACK_STATE_CHANGED = 'recorder_track_state_changed';
  var EVENT_RECORDER_ERROR = 'recorder_error';
  var EVENT_STREAM_DISCONTINUITY = 'stream_discontinuity';

  var STREAM_KINDS = ['microphone', 'screen', 'webcam'];
  var TRACK_KINDS = ['audio', 'video'];

  // The six discontinuity reasons (§2.3 of the 4.9 contract). The three
  // chunk-* reasons are exactly chunk_writer.js's terminal statuses —
  // the writer's onTerminalState seam reports them and the mapping is
  // the identity, never a re-interpretation.
  var DISCONTINUITY_REASONS = [
    'track-ended',
    'recorder-error',
    'chunk-stalled',
    'chunk-quota-exceeded',
    'chunk-write-error',
    'restart'
  ];
  var CHUNK_TERMINAL_STATES = [
    'chunk-stalled',
    'chunk-quota-exceeded',
    'chunk-write-error'
  ];

  var UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  function freezeConstants() {
    Object.freeze(STREAM_KINDS);
    Object.freeze(TRACK_KINDS);
    Object.freeze(DISCONTINUITY_REASONS);
    Object.freeze(CHUNK_TERMINAL_STATES);
  }
  freezeConstants();

  // ------------------------------------------------------------------
  // Private helpers.
  // ------------------------------------------------------------------

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function requireExactKeys(obj, keys, what) {
    if (!isPlainObject(obj)) {
      throw new TypeError('track_monitor: ' + what + ' must be a plain object');
    }
    var actual = Object.keys(obj).sort();
    var expected = keys.slice().sort();
    if (actual.length !== expected.length) {
      throw new TypeError('track_monitor: ' + what + ' must have exactly ' +
        expected.length + ' keys, got ' + actual.length);
    }
    for (var i = 0; i < expected.length; i++) {
      if (actual[i] !== expected[i]) {
        throw new TypeError('track_monitor: ' + what + ' must have exactly ' +
          'the keys: ' + expected.join(', '));
      }
    }
    return obj;
  }

  function requireStreamKind(value) {
    if (typeof value !== 'string') {
      throw new TypeError('track_monitor: streamKind must be a string');
    }
    if (STREAM_KINDS.indexOf(value) === -1) {
      throw new RangeError('track_monitor: unknown streamKind: ' + value);
    }
    return value;
  }

  function requireTrackKind(value) {
    if (typeof value !== 'string') {
      throw new TypeError('track_monitor: trackKind must be a string');
    }
    if (TRACK_KINDS.indexOf(value) === -1) {
      throw new RangeError('track_monitor: unknown trackKind: ' + value);
    }
    return value;
  }

  function requireBoolean(value, what) {
    if (typeof value !== 'boolean') {
      throw new TypeError('track_monitor: ' + what + ' must be a boolean');
    }
    return value;
  }

  function requireStringOrNull(value, what) {
    if (value !== null && typeof value !== 'string') {
      throw new TypeError('track_monitor: ' + what + ' must be a string or null');
    }
    return value;
  }

  function requireUuidV4(value, what) {
    if (typeof value !== 'string' || !UUID_V4_RE.test(value)) {
      throw new TypeError('track_monitor: ' + what + ' must be a uuid-v4 string');
    }
    return value;
  }

  // ------------------------------------------------------------------
  // Payload constructors (exact keys; TypeError/RangeError per AGENTS.md).
  // Exported for tests and for recorder.js's defense.
  // ------------------------------------------------------------------

  var TRACK_STATE_PAYLOAD_KEYS = ['streamKind', 'trackKind', 'muted', 'ended', 'baseline'];

  // Track mute/unmute/end observation. muted/ended are the values
  // observed at event time; baseline is true only for the single
  // attach-time observation per track.
  function createTrackStatePayload(input) {
    var p = input || {};
    requireExactKeys(p, TRACK_STATE_PAYLOAD_KEYS, 'track-state payload');
    return {
      streamKind: requireStreamKind(p.streamKind),
      trackKind: requireTrackKind(p.trackKind),
      muted: requireBoolean(p.muted, 'muted'),
      ended: requireBoolean(p.ended, 'ended'),
      baseline: requireBoolean(p.baseline, 'baseline')
    };
  }

  var RECORDER_ERROR_PAYLOAD_KEYS = ['streamKind', 'errorName', 'errorMessage', 'recorderState'];

  // MediaRecorder platform error. errorName/errorMessage are the
  // platform's verbatim strings (or null) — never paraphrased, never
  // diagnosed.
  function createRecorderErrorPayload(input) {
    var p = input || {};
    requireExactKeys(p, RECORDER_ERROR_PAYLOAD_KEYS, 'recorder-error payload');
    return {
      streamKind: requireStreamKind(p.streamKind),
      errorName: requireStringOrNull(p.errorName, 'errorName'),
      errorMessage: requireStringOrNull(p.errorMessage, 'errorMessage'),
      recorderState: requireStringOrNull(p.recorderState, 'recorderState')
    };
  }

  var DISCONTINUITY_PAYLOAD_KEYS = [
    'streamKind', 'reason', 'lastChunkIndex', 'supersededSegmentIds', 'detail'
  ];

  // Explicit discontinuity flag. lastChunkIndex is the chunker's
  // last-written index at flag time (null when chunking never started);
  // supersededSegmentIds is non-null only for reason 'restart'; detail
  // is short context (never a diagnosis), null when there is nothing
  // to add.
  function createDiscontinuityPayload(input) {
    var p = input || {};
    requireExactKeys(p, DISCONTINUITY_PAYLOAD_KEYS, 'discontinuity payload');
    var reason = p.reason;
    if (typeof reason !== 'string') {
      throw new TypeError('track_monitor: reason must be a string');
    }
    if (DISCONTINUITY_REASONS.indexOf(reason) === -1) {
      throw new RangeError('track_monitor: unknown discontinuity reason: ' + reason);
    }
    var lastChunkIndex = p.lastChunkIndex;
    if (lastChunkIndex !== null &&
        (typeof lastChunkIndex !== 'number' || !isFinite(lastChunkIndex))) {
      throw new TypeError(
        'track_monitor: lastChunkIndex must be a finite number or null');
    }
    var sup = p.supersededSegmentIds;
    if (sup !== null) {
      if (!Array.isArray(sup)) {
        throw new TypeError(
          'track_monitor: supersededSegmentIds must be an array or null');
      }
      for (var i = 0; i < sup.length; i++) {
        if (typeof sup[i] !== 'string' || sup[i] === '') {
          throw new TypeError('track_monitor: supersededSegmentIds must ' +
            'contain non-empty strings');
        }
      }
    }
    return {
      streamKind: requireStreamKind(p.streamKind),
      reason: reason,
      lastChunkIndex: lastChunkIndex,
      supersededSegmentIds: sup,
      detail: requireStringOrNull(p.detail, 'detail')
    };
  }

  // ------------------------------------------------------------------
  // The track monitor instance.
  //
  // opts:
  //   emitEvent    — (eventType, payload, refs) => envelope|null. Required.
  //                  In the document this is recorder.js's
  //                  emitRecorderEvent (session-gated, clock-stamped);
  //                  a throwing emitEvent is tolerated, never propagated.
  //   getChunkState — (streamKind) => chunk-writer state or null.
  //                  Optional (defaults to () => null); recorder.js
  //                  passes a lazy thunk over its chunk writer.
  // ------------------------------------------------------------------

  function createTrackMonitor(opts) {
    var o = opts || {};
    if (typeof o.emitEvent !== 'function') {
      throw new TypeError('track_monitor: emitEvent must be a function');
    }
    var emitEvent = o.emitEvent;
    var getChunkState = (typeof o.getChunkState === 'function') ?
      o.getChunkState : function () { return null; };
    // 4.14: optional wall-clock for the in-memory health mirror's
    // atUtc stamps (additive; defaults to the real clock).
    var nowUtcIso = (typeof o.nowUtcIso === 'function') ? o.nowUtcIso :
      function () { return new Date().toISOString(); };

    // streamKind → { streamKind, segmentId, tracks: [{track, trackKind,
    // onMute, onUnmute, onEnded, detach}], recorder, recorderOnError }.
    var monitored = {};

    // 4.14: in-memory health mirror — the last observed recorder error
    // and discontinuity per kind, generation-scoped (cleared on
    // attach/detach). The monitor already observes both; retaining the
    // last observation is a query over observed state, not a new
    // pipeline. The SW-side event log remains the durable timeline
    // (§6.3 reads it at export); after a document restart this mirror
    // is empty by construction (the manifest tells the
    // cross-generation story).
    var health = {};

    function clearHealth(kind) {
      if (health[kind]) {
        delete health[kind];
      }
    }

    function healthEntry(kind) {
      if (!health[kind]) {
        health[kind] = { lastRecorderError: null, lastDiscontinuity: null };
      }
      return health[kind];
    }

    function stampUtc() {
      try {
        var s = nowUtcIso();
        return (typeof s === 'string' && s !== '') ? s : null;
      } catch (e) {
        return null;
      }
    }

    // 4.14: retain the last observed recorder error for the kind.
    function retainRecorderError(kind, errorName, errorMessage) {
      var he = healthEntry(kind);
      he.lastRecorderError = {
        errorName: (typeof errorName === 'string' && errorName !== '') ?
          errorName : null,
        errorMessage: (typeof errorMessage === 'string') ? errorMessage : null,
        atUtc: stampUtc()
      };
    }

    // 4.14: retain the last observed discontinuity for the kind.
    function retainDiscontinuity(kind, reason) {
      var hd = healthEntry(kind);
      hd.lastDiscontinuity = {
        reason: (typeof reason === 'string' && reason !== '') ? reason : null,
        atUtc: stampUtc()
      };
    }

    function guarded(fn) {
      try {
        fn();
      } catch (e) {
        // Monitoring never throws into the pipeline: a failed
        // observation is dropped, never propagated.
      }
    }

    function safeEmit(eventType, payload, refs) {
      guarded(function () { emitEvent(eventType, payload, refs); });
    }

    function readMuted(track) {
      try {
        return !!track.muted;
      } catch (e) {
        return false;
      }
    }

    function readEnded(track) {
      try {
        return track.readyState === 'ended';
      } catch (e) {
        return false;
      }
    }

    // The chunker's view of a stream at flag time: last written chunk
    // index and, for write errors, the verbatim error name/message as
    // short context. Unknown is null — never fabricated.
    function chunkSnapshot(kind) {
      var lastChunkIndex = null;
      var detail = null;
      try {
        var s = getChunkState(kind);
        if (s) {
          if (typeof s.lastChunkIndex === 'number' && isFinite(s.lastChunkIndex)) {
            lastChunkIndex = s.lastChunkIndex;
          }
          if (typeof s.lastErrorName === 'string' && s.lastErrorName !== '') {
            detail = s.lastErrorName;
            if (typeof s.lastErrorMessage === 'string' && s.lastErrorMessage !== '') {
              detail += ': ' + s.lastErrorMessage;
            }
          }
        }
      } catch (e) { /* ignore */ }
      return { lastChunkIndex: lastChunkIndex, detail: detail };
    }

    function emitDiscontinuity(entry, reason, overrides) {
      var ov = overrides || {};
      var snap = chunkSnapshot(entry.streamKind);
      var payload = createDiscontinuityPayload({
        streamKind: entry.streamKind,
        reason: reason,
        lastChunkIndex: ('lastChunkIndex' in ov) ?
          ov.lastChunkIndex : snap.lastChunkIndex,
        supersededSegmentIds: ('supersededSegmentIds' in ov) ?
          ov.supersededSegmentIds : null,
        detail: ('detail' in ov) ? ov.detail :
          (reason === 'chunk-write-error' ? snap.detail : null)
      });
      safeEmit(EVENT_STREAM_DISCONTINUITY, payload,
        { segmentId: entry.segmentId });
      // 4.14: retain the discontinuity in the in-memory health mirror.
      retainDiscontinuity(entry.streamKind, reason);
    }

    function attachTrack(entry, track, trackKind) {
      var t = {
        track: track,
        trackKind: trackKind,
        onMute: null,
        onUnmute: null,
        onEnded: null,
        detach: null
      };
      function emitState(baseline) {
        safeEmit(EVENT_TRACK_STATE_CHANGED,
          createTrackStatePayload({
            streamKind: entry.streamKind,
            trackKind: trackKind,
            muted: readMuted(track),
            ended: readEnded(track),
            baseline: baseline
          }),
          { segmentId: entry.segmentId });
      }
      function detach() {
        guarded(function () {
          if (track.onmute === t.onMute) { track.onmute = null; }
          if (track.onunmute === t.onUnmute) { track.onunmute = null; }
          if (track.onended === t.onEnded) { track.onended = null; }
        });
      }
      // Baseline: the single attach-time observation per track, so 4.14
      // knows the starting state (a transition without a baseline is
      // ambiguous). Emitted even if listener installation below fails.
      emitState(true);
      t.onMute = function () {
        guarded(function () { emitState(false); });
      };
      t.onUnmute = function () {
        guarded(function () { emitState(false); });
      };
      t.onEnded = function () {
        guarded(function () {
          // The observation first (ended:true, muted as observed), then
          // the explicit discontinuity flag — the chained emission order
          // different consumers rely on (4.14 status vs 4.13
          // re-segmentation).
          emitState(false);
          detach(); // a dead track produces no further events
          emitDiscontinuity(entry, 'track-ended', {});
        });
      };
      t.detach = detach;
      guarded(function () {
        track.onmute = t.onMute;
        track.onunmute = t.onUnmute;
        track.onended = t.onEnded;
      });
      entry.tracks.push(t);
      return t;
    }

    function attachRecorder(entry, recorder) {
      function onError(event) {
        guarded(function () {
          // MediaRecorder dispatches a MediaRecorderErrorEvent carrying
          // the DOMException on .error; defensively also accept the
          // error itself as the event. Name/message are verbatim.
          var err = (event && typeof event === 'object' &&
                     'error' in event && event.error) ? event.error : null;
          if (!err && event && typeof event === 'object' &&
              (typeof event.name === 'string' ||
               typeof event.message === 'string')) {
            err = event;
          }
          var errorName = (err && typeof err.name === 'string' &&
                           err.name !== '') ? err.name : null;
          var errorMessage = (err && typeof err.message === 'string') ?
            err.message : null;
          var recorderState = null;
          try {
            recorderState = (typeof recorder.state === 'string') ?
              recorder.state : null;
          } catch (e) { /* ignore */ }
          safeEmit(EVENT_RECORDER_ERROR,
            createRecorderErrorPayload({
              streamKind: entry.streamKind,
              errorName: errorName,
              errorMessage: errorMessage,
              recorderState: recorderState
            }),
            { segmentId: entry.segmentId });
          // 4.14: retain the observation in the in-memory health mirror.
          retainRecorderError(entry.streamKind, errorName, errorMessage);
          // Observation first, then the explicit flag (chained order).
          emitDiscontinuity(entry, 'recorder-error', {});
        });
      }
      guarded(function () { recorder.onerror = onError; });
      entry.recorder = recorder;
      entry.recorderOnError = onError;
    }

    // Attach monitoring to one successfully started stream. Re-attach
    // for a kind detaches the old generation first (idempotent; the
    // 4.13 restart path reuses this). Never throws for platform
    // issues — validation errors (caller bugs) are the only throws.
    function attachStream(args) {
      var a = args || {};
      var kind = requireStreamKind(a.streamKind);
      var segmentId = requireUuidV4(a.segmentId, 'segmentId');
      detachStream(kind);
      var entry = {
        streamKind: kind,
        segmentId: segmentId,
        tracks: [],
        recorder: null,
        recorderOnError: null
      };
      monitored[kind] = entry;
      var stream = a.stream;
      var tracks = [];
      try {
        if (stream && typeof stream.getTracks === 'function') {
          var got = stream.getTracks();
          if (Array.isArray(got)) {
            tracks = got;
          }
        }
      } catch (e) {
        tracks = [];
      }
      for (var i = 0; i < tracks.length; i++) {
        var track = tracks[i];
        // Malformed tracks are skipped — monitoring never fails the
        // stream.
        if (!track || typeof track !== 'object') {
          continue;
        }
        var trackKind = null;
        try {
          trackKind = track.kind;
        } catch (e) {
          trackKind = null;
        }
        if (trackKind !== 'audio' && trackKind !== 'video') {
          continue;
        }
        attachTrack(entry, track, trackKind);
      }
      var recorder = a.recorder;
      if (recorder && typeof recorder === 'object') {
        attachRecorder(entry, recorder);
      }
      // 4.14: a successful attach starts a fresh health generation
      // (generation-scoped by detach/attach; the events are separate).
      healthEntry(kind);
      return { ok: true, streamKind: kind, tracks: entry.tracks.length };
    }

    // Detach all monitoring for a kind. Idempotent. 4.14: the
    // in-memory health mirror is generation-scoped, so detaching
    // clears it (a later attach starts a fresh generation).
    function detachStream(streamKind) {
      var kind = requireStreamKind(streamKind);
      clearHealth(kind);
      var entry = monitored[kind];
      if (!entry) {
        return { ok: true, streamKind: kind, wasMonitored: false };
      }
      for (var i = 0; i < entry.tracks.length; i++) {
        try {
          entry.tracks[i].detach();
        } catch (e) { /* ignore */ }
      }
      if (entry.recorder) {
        guarded(function () {
          if (entry.recorder.onerror === entry.recorderOnError) {
            entry.recorder.onerror = null;
          }
        });
      }
      delete monitored[kind];
      return { ok: true, streamKind: kind, wasMonitored: true };
    }

    // The chunk_writer onTerminalState seam target: a chunker terminal
    // transition becomes an explicit stream_discontinuity. The writer
    // guarantees exact-once per stream; unknown states/kinds are
    // ignored, never thrown.
    function onChunkTerminalState(args) {
      var a = args || {};
      var kind = a.streamKind;
      var terminalState = a.terminalState;
      if (STREAM_KINDS.indexOf(kind) === -1) {
        return;
      }
      if (CHUNK_TERMINAL_STATES.indexOf(terminalState) === -1) {
        return;
      }
      var entry = monitored[kind];
      var segmentId = entry ? entry.segmentId : null;
      var snap = chunkSnapshot(kind);
      var payload = createDiscontinuityPayload({
        streamKind: kind,
        // The terminal states ARE the discontinuity reason codes —
        // the mapping is the identity, never a re-interpretation.
        reason: terminalState,
        lastChunkIndex: snap.lastChunkIndex,
        supersededSegmentIds: null,
        detail: terminalState === 'chunk-write-error' ? snap.detail : null
      });
      safeEmit(EVENT_STREAM_DISCONTINUITY, payload,
        segmentId === null ? null : { segmentId: segmentId });
      // 4.14: retain the chunk-terminal discontinuity in the health
      // mirror (the mapping is the identity — terminal state IS the
      // reason code).
      retainDiscontinuity(kind, terminalState);
    }

    // Restart discontinuity (recorder.js's manifest pre-check calls
    // this after the new generation starts). refs.segmentId is the NEW
    // segmentId — null when that kind failed to start (the old
    // generation is dead either way). lastChunkIndex is null: the
    // superseded generation's last chunk index is not observable from
    // the new document — unknown is null, never fabricated.
    function emitRestartDiscontinuity(args) {
      var a = args || {};
      var kind = requireStreamKind(a.streamKind);
      var newSegmentId = (a.newSegmentId === undefined ||
                          a.newSegmentId === null) ? null :
        requireUuidV4(a.newSegmentId, 'newSegmentId');
      var sup = a.supersededSegmentIds;
      if (!Array.isArray(sup) || sup.length === 0) {
        throw new TypeError('track_monitor: supersededSegmentIds must be ' +
          'a non-empty array');
      }
      for (var i = 0; i < sup.length; i++) {
        if (typeof sup[i] !== 'string' || sup[i] === '') {
          throw new TypeError('track_monitor: supersededSegmentIds must ' +
            'contain non-empty strings');
        }
      }
      var payload = createDiscontinuityPayload({
        streamKind: kind,
        reason: 'restart',
        lastChunkIndex: null,
        supersededSegmentIds: sup.slice(),
        detail: null
      });
      safeEmit(EVENT_STREAM_DISCONTINUITY, payload,
        newSegmentId === null ? null : { segmentId: newSegmentId });
      // 4.14: retain the restart discontinuity in the health mirror.
      retainDiscontinuity(kind, 'restart');
    }

    function getMonitoredKinds() {
      return Object.keys(monitored);
    }

    // 4.9/§7 introspection seam: the raw monitored tracks for a kind
    // (the sw-track-monitor V2 harness forces track.stop() on a real
    // track). Test-only; product code never calls this.
    function getMonitoredTracks(streamKind) {
      var kind = requireStreamKind(streamKind);
      var entry = monitored[kind];
      if (!entry) {
        return [];
      }
      return entry.tracks.map(function (t) {
        return { trackKind: t.trackKind, track: t.track };
      });
    }

    // 4.14: the in-memory health mirror for one kind — the last
    // observed recorder error and discontinuity this document
    // generation. null when the kind was never monitored (unknown is
    // null, never fabricated). Additive: no new listeners, no new
    // emissions, monitor behavior otherwise unchanged.
    function getStreamHealth(streamKind) {
      var kind = requireStreamKind(streamKind);
      var h = health[kind];
      if (!h) {
        return null;
      }
      return {
        lastRecorderError: h.lastRecorderError ? {
          errorName: h.lastRecorderError.errorName,
          errorMessage: h.lastRecorderError.errorMessage,
          atUtc: h.lastRecorderError.atUtc
        } : null,
        lastDiscontinuity: h.lastDiscontinuity ? {
          reason: h.lastDiscontinuity.reason,
          atUtc: h.lastDiscontinuity.atUtc
        } : null
      };
    }

    return {
      attachStream: attachStream,
      detachStream: detachStream,
      onChunkTerminalState: onChunkTerminalState,
      emitRestartDiscontinuity: emitRestartDiscontinuity,
      getMonitoredKinds: getMonitoredKinds,
      getMonitoredTracks: getMonitoredTracks,
      getStreamHealth: getStreamHealth
    };
  }

  BlindfoldSession.TRACK_STATE_CHANGED_EVENT_TYPE = EVENT_TRACK_STATE_CHANGED;
  BlindfoldSession.RECORDER_ERROR_EVENT_TYPE = EVENT_RECORDER_ERROR;
  BlindfoldSession.STREAM_DISCONTINUITY_EVENT_TYPE = EVENT_STREAM_DISCONTINUITY;
  BlindfoldSession.TRACK_MONITOR_STREAM_KINDS = STREAM_KINDS;
  BlindfoldSession.TRACK_MONITOR_DISCONTINUITY_REASONS = DISCONTINUITY_REASONS;
  BlindfoldSession.createTrackMonitor = createTrackMonitor;
  BlindfoldSession.createTrackStatePayload = createTrackStatePayload;
  BlindfoldSession.createRecorderErrorPayload = createRecorderErrorPayload;
  BlindfoldSession.createDiscontinuityPayload = createDiscontinuityPayload;
})();

// Node test shim. The offscreen document consumes the BlindfoldSession
// global directly; only environments that provide CommonJS get
// module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
