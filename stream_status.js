// stream_status.js — task 4.14 (PLAN.md §4.14).
//
// Read-only per-stream recording-status query surface. Answers, per
// streamKind (microphone/screen/webcam), the question PLAN.md poses:
// is this stream's recording actually happening, and if not, what is
// its condition? — so that a dead microphone, a failed screen
// capture, or a stalled chunk loop can never masquerade as a complete
// recording.
//
// Design (contract §1–§3):
// - Reads ONLY: the stream starter's in-memory registry, the chunk
//   writer's poll state, the track monitor's live tracks + in-memory
//   health mirror, and the recording manifest (existing bySessionId
//   index — no new index, no schema change). The SW-side event log is
//   deliberately NOT queried (offscreen-local honesty boundary; §6.3
//   reads the durable log at export time).
// - lifecycle is derived mechanically from the §1.1 truth table:
//   live registry entry → 'recording'; no live entry but unfinalized
//   manifest segments → 'stopped'; no live entry and all segments
//   finalized → 'finalized'; otherwise 'idle'. There is NO 'error'
//   lifecycle — failures surface as facts (chunk.*, lastRecorderError,
//   lastDiscontinuity, tracks[]), never as smoothed state. Smoothing
//   is how failures masquerade; this module does not smooth.
// - Never throws into the channel handler: injected reads are
//   guarded (a throwing read degrades to null); a failed manifest
//   read rejects (the recorder.js wiring maps it to {ok:false}).
// - A V1 code-scan pin forbids write/emit/control vocabulary in this
//   module (put(/add(/delete(/sendMessage/emitEvent/new MediaRecorder/
//   .start(/.stop(/requestData() in executable code).
//
// Repo module pattern: dependency-free classic script → guarded
// BlindfoldSession global → IIFE 'use strict' → Node module.exports
// shim for tests.

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Constants.
  // ------------------------------------------------------------------

  var STREAM_KINDS = ['microphone', 'screen', 'webcam'];

  var LIFECYCLE_IDLE = 'idle';
  var LIFECYCLE_RECORDING = 'recording';
  var LIFECYCLE_STOPPED = 'stopped';
  var LIFECYCLE_FINALIZED = 'finalized';

  // The exact per-stream status shape (contract §1). Exact-keys
  // discipline: requireValidStatus rejects anything else, so the
  // shape can only widen deliberately.
  var STATUS_KEYS = [
    'streamKind',
    'lifecycle',
    'recorderState',
    'segmentId',
    'segmentNumber',
    'startedAtUtc',
    'startedAtMonotonicMs',
    'clockSegmentId',
    'actualMimeType',
    'fileExtension',
    'audioContent',
    'chunk',
    'tracks',
    'lastRecorderError',
    'lastDiscontinuity',
    'finalizedAtUtc',
    'unfinalizedSegments'
  ];

  var UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  function freezeConstants() {
    Object.freeze(STREAM_KINDS);
    Object.freeze(STATUS_KEYS);
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
      throw new TypeError('stream_status: ' + what + ' must be an object');
    }
    var got = Object.keys(obj).sort();
    var want = keys.slice().sort();
    if (got.length !== want.length) {
      throw new TypeError('stream_status: ' + what + ' has ' + got.length +
        ' keys, expected ' + want.length);
    }
    for (var i = 0; i < want.length; i++) {
      if (got[i] !== want[i]) {
        throw new TypeError('stream_status: ' + what + ' key mismatch: ' +
          got[i] + ' !== ' + want[i]);
      }
    }
    return obj;
  }

  function requireStreamKind(value) {
    if (typeof value !== 'string') {
      throw new TypeError('stream_status: streamKind must be a string');
    }
    if (STREAM_KINDS.indexOf(value) === -1) {
      throw new RangeError('stream_status: unknown streamKind: ' + value);
    }
    return value;
  }

  function stringOrNull(v) {
    return (typeof v === 'string' && v !== '') ? v : null;
  }

  function numberOrNull(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  function isUuidV4(s) {
    return typeof s === 'string' && UUID_V4_RE.test(s);
  }

  // ------------------------------------------------------------------
  // The status reader.
  // ------------------------------------------------------------------

  // opts:
  //   getStreamRecord(kind)       — stream_starter.getStreamRecord (or
  //                                 null when the kind was never started)
  //   getChunkState(kind)         — chunk_writer.getChunkState (or null)
  //   getMonitoredTracks(kind)    — track_monitor.getMonitoredTracks →
  //                                 [{trackKind, track}] (raw tracks)
  //   getStreamHealth(kind)       — track_monitor.getStreamHealth →
  //                                 {lastRecorderError, lastDiscontinuity}
  //                                 or null
  //   getManifestRecordsBySession(sessionId) — format_support read
  //                                 (Promise → records[])
  //   getSessionId()              — () => sessionId | null
  //   nowUtcIso                   — optional clock (accepted per the
  //                                 contract signature; the per-stream
  //                                 record carries no wall-clock of its
  //                                 own — the channel envelope stamps
  //                                 queriedAtUtc)
  function createStreamStatus(opts) {
    var o = opts || {};

    function requireFn(name) {
      if (typeof o[name] !== 'function') {
        throw new TypeError('stream_status: ' + name + ' must be a function');
      }
      return o[name];
    }

    var getStreamRecord = requireFn('getStreamRecord');
    var getChunkState = requireFn('getChunkState');
    var getMonitoredTracks = requireFn('getMonitoredTracks');
    var getStreamHealth = requireFn('getStreamHealth');
    var getManifestRecordsBySession = requireFn('getManifestRecordsBySession');
    var getSessionId = requireFn('getSessionId');
    var nowUtcIso = (typeof o.nowUtcIso === 'function') ? o.nowUtcIso :
      function () { return new Date().toISOString(); };

    // A throwing injected read degrades to undefined (the caller maps
    // it to null/[]). Monitoring/registry reads are best-effort: a
    // status query must never fail because a live read did.
    function safeRead(fn) {
      try {
        return fn();
      } catch (e) {
        return undefined;
      }
    }

    // Latest manifest record for ordering: the most recently created
    // generation first (createdAtUtc is stamped at stream start, so it
    // orders generations — including the in-progress one whose
    // segmentNumber is still null), then highest segmentNumber, then
    // segmentId (deterministic tie-break).
    function compareRecords(a, b) {
      var ac = (typeof a.createdAtUtc === 'string') ? a.createdAtUtc : '';
      var bc = (typeof b.createdAtUtc === 'string') ? b.createdAtUtc : '';
      if (ac !== bc) {
        return ac < bc ? -1 : 1;
      }
      var an = numberOrNull(a.segmentNumber);
      var bn = numberOrNull(b.segmentNumber);
      var av = (an === null) ? -1 : an;
      var bv = (bn === null) ? -1 : bn;
      if (av !== bv) {
        return av - bv;
      }
      var as = (typeof a.segmentId === 'string') ? a.segmentId : '';
      var bs = (typeof b.segmentId === 'string') ? b.segmentId : '';
      if (as === bs) {
        return 0;
      }
      return as < bs ? -1 : 1;
    }

    function pickLatest(records) {
      var best = null;
      for (var i = 0; i < records.length; i++) {
        if (best === null || compareRecords(records[i], best) > 0) {
          best = records[i];
        }
      }
      return best;
    }

    function readTracks(rawTracks) {
      if (!Array.isArray(rawTracks)) {
        return [];
      }
      var out = [];
      for (var i = 0; i < rawTracks.length; i++) {
        var t = rawTracks[i] || {};
        var trackKind = (t.trackKind === 'audio' || t.trackKind === 'video') ?
          t.trackKind : null;
        var muted = false;
        var readyState = null;
        try {
          muted = !!(t.track && t.track.muted);
        } catch (e) { /* keep false */ }
        try {
          var rs = t.track ? t.track.readyState : null;
          readyState = (typeof rs === 'string') ? rs : null;
        } catch (e) { /* keep null */ }
        out.push({ trackKind: trackKind, muted: muted, readyState: readyState });
      }
      return out;
    }

    function buildStatus(kind, liveRec, chunkState, rawTracks, health, records) {
      var kindRecords = [];
      for (var i = 0; i < records.length; i++) {
        if (records[i] && records[i].streamKind === kind) {
          kindRecords.push(records[i]);
        }
      }
      var latest = pickLatest(kindRecords);
      var liveSegmentId = (liveRec && typeof liveRec.segmentId === 'string' &&
        liveRec.segmentId !== '') ? liveRec.segmentId : null;
      var liveManifest = null;
      if (liveSegmentId !== null) {
        for (var j = 0; j < kindRecords.length; j++) {
          if (kindRecords[j].segmentId === liveSegmentId) {
            liveManifest = kindRecords[j];
            break;
          }
        }
      }
      var manifestRec = liveManifest || latest;

      var unfinalized = 0;
      for (var k = 0; k < kindRecords.length; k++) {
        if (!kindRecords[k].finalizedAtUtc) {
          unfinalized++;
        }
      }

      // The §1.1 truth table, mechanical. No 'error' lifecycle: a
      // chunk-stalled stream with recorderState 'recording' stays
      // 'recording' — the stall is a fact in chunk.*, not a smoothed
      // state.
      var lifecycle;
      if (liveRec) {
        lifecycle = LIFECYCLE_RECORDING;
      } else if (unfinalized > 0) {
        lifecycle = LIFECYCLE_STOPPED;
      } else if (kindRecords.length > 0) {
        lifecycle = LIFECYCLE_FINALIZED;
      } else {
        lifecycle = LIFECYCLE_IDLE;
      }

      var recorderState = null;
      if (liveRec && liveRec.recorder) {
        try {
          var st = liveRec.recorder.state;
          recorderState = (typeof st === 'string') ? st : null;
        } catch (e) {
          recorderState = null;
        }
      }

      var audioContent = null;
      if (manifestRec) {
        if (kind === 'screen') {
          audioContent = stringOrNull(manifestRec.screenAudioContent);
        } else if (kind === 'microphone') {
          audioContent = stringOrNull(manifestRec.micAudioContent);
        }
      }

      var err = (health && health.lastRecorderError) || null;
      var disc = (health && health.lastDiscontinuity) || null;

      var status = {
        streamKind: kind,
        lifecycle: lifecycle,
        recorderState: recorderState,
        segmentId: liveSegmentId ||
          (manifestRec ? stringOrNull(manifestRec.segmentId) : null),
        segmentNumber: manifestRec ? numberOrNull(manifestRec.segmentNumber) : null,
        startedAtUtc: (liveRec && typeof liveRec.startedAtUtc === 'string') ?
          liveRec.startedAtUtc :
          (manifestRec ? stringOrNull(manifestRec.streamStartedAtUtc) : null),
        startedAtMonotonicMs: (liveRec &&
            typeof liveRec.startedAtMonotonicMs === 'number') ?
          liveRec.startedAtMonotonicMs :
          (manifestRec ? numberOrNull(manifestRec.streamStartedAtMonotonicMs) : null),
        clockSegmentId: manifestRec ? stringOrNull(manifestRec.clockSegmentId) : null,
        actualMimeType: manifestRec ? stringOrNull(manifestRec.actualMimeType) : null,
        fileExtension: manifestRec ? stringOrNull(manifestRec.fileExtension) : null,
        audioContent: audioContent,
        chunk: chunkState ? {
          status: stringOrNull(chunkState.status),
          lastChunkIndex: numberOrNull(chunkState.lastChunkIndex),
          lastWriteAtUtc: stringOrNull(chunkState.lastWriteAtUtc),
          consecutiveMisses: (typeof chunkState.consecutiveMisses === 'number' &&
            isFinite(chunkState.consecutiveMisses)) ? chunkState.consecutiveMisses : 0,
          emptyPolls: (typeof chunkState.emptyPolls === 'number' &&
            isFinite(chunkState.emptyPolls)) ? chunkState.emptyPolls : 0,
          lastErrorName: stringOrNull(chunkState.lastErrorName),
          lastErrorMessage: stringOrNull(chunkState.lastErrorMessage)
        } : null,
        tracks: readTracks(rawTracks),
        lastRecorderError: err ? {
          errorName: stringOrNull(err.errorName),
          errorMessage: stringOrNull(err.errorMessage),
          atUtc: stringOrNull(err.atUtc)
        } : null,
        lastDiscontinuity: disc ? {
          reason: stringOrNull(disc.reason),
          atUtc: stringOrNull(disc.atUtc)
        } : null,
        finalizedAtUtc: manifestRec ? stringOrNull(manifestRec.finalizedAtUtc) : null,
        unfinalizedSegments: unfinalized
      };
      return requireExactKeys(status, STATUS_KEYS, 'stream status');
    }

    // getStreamStatus(kind) → Promise<status>. The manifest read is
    // async (IDB); a failed manifest read rejects (the recorder.js
    // wiring maps it to {ok:false} — failure-isolated, never thrown
    // across the channel).
    function getStreamStatus(streamKind) {
      var kind = requireStreamKind(streamKind);
      var sessionId = safeRead(getSessionId);
      var liveRec = safeRead(function () { return getStreamRecord(kind); }) || null;
      var chunkState = safeRead(function () { return getChunkState(kind); }) || null;
      var rawTracks = safeRead(function () { return getMonitoredTracks(kind); });
      var health = safeRead(function () { return getStreamHealth(kind); }) || null;
      return Promise.resolve()
        .then(function () {
          if (typeof sessionId !== 'string' || sessionId === '') {
            return [];
          }
          return getManifestRecordsBySession(sessionId);
        })
        .then(function (records) {
          if (!Array.isArray(records)) {
            records = [];
          }
          return buildStatus(kind, liveRec, chunkState, rawTracks, health, records);
        });
    }

    function getAllStreamStatuses() {
      return Promise.all([
        getStreamStatus('microphone'),
        getStreamStatus('screen'),
        getStreamStatus('webcam')
      ]).then(function (all) {
        return { microphone: all[0], screen: all[1], webcam: all[2] };
      });
    }

    return {
      getStreamStatus: getStreamStatus,
      getAllStreamStatuses: getAllStreamStatuses
    };
  }

  // ------------------------------------------------------------------
  // Exports.
  // ------------------------------------------------------------------

  BlindfoldSession.STREAM_STATUS_KEYS = STATUS_KEYS;
  BlindfoldSession.STREAM_STATUS_LIFECYCLES = [
    LIFECYCLE_IDLE,
    LIFECYCLE_RECORDING,
    LIFECYCLE_STOPPED,
    LIFECYCLE_FINALIZED
  ];
  BlindfoldSession.STREAM_STATUS_KINDS = STREAM_KINDS;
  BlindfoldSession.createStreamStatus = createStreamStatus;
})();

// Node test shim. The offscreen document consumes the BlindfoldSession
// global directly; only environments that provide CommonJS get
// module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
