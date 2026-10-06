// format_support.js
//
// Task 4.5 (PLAN.md §4.5): recording format verification and the recording
// manifest write API.
//
// 4.5 builds the format-verification machinery and defines the recording
// manifest; it starts no recording. The "actual MIME type" of a segment
// only exists once a MediaRecorder is constructed, which is 4.6's job —
// 4.5 delivers:
//
//   1. verifyFormats(): runtime probing of MediaRecorder.isTypeSupported
//      per stream kind, against frozen prioritized candidate lists.
//      Always re-probed (isTypeSupported is synchronous and cheap) —
//      no cache, no staleness.
//   2. The recording manifest: a new extension-owned IndexedDB store
//      (recording_manifest, keyPath segmentId, bySessionId index — the
//      store spec lives in db.js; DB_VERSION 1 → 2) holding one record
//      per recording segment with the actual negotiated MIME type and
//      the derived file extension.
//   3. recordSegmentFormat(): the manifest write API 4.6 calls at stream
//      start with the real recorder.mimeType.
//
// Recording platform APIs live only in the offscreen document (4.1's
// rule) — MediaRecorder.isTypeSupported is injected for tests and read
// lazily from the real global in the document. This module constructs
// NO MediaRecorder and starts nothing (4.6's boundary).
//
// Dependency-free classic script → guarded BlindfoldSession global → IIFE
// 'use strict' → Node module.exports shim (repo house convention).
//
// Error conventions (AGENTS.md): TypeError = wrong type/shape;
// RangeError = bad domain value; plain Error = unavailable platform
// capability (e.g. no MediaRecorder.isTypeSupported — never a weak
// fallback, never a fabricated list).

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Constants.
  // ------------------------------------------------------------------

  var UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  var MANIFEST_STORE = 'recording_manifest';

  // Stream kinds this task knows. Frozen: adding a kind changes the
  // candidate lists and the manifest validator together.
  var STREAM_KINDS = ['microphone', 'screen', 'webcam'];

  // Frozen, prioritized candidate lists. Probed in order; the first
  // isTypeSupported() === true wins per stream kind. Priority
  // rationale: VP9 (best quality/size, Chrome-native) → VP8 (universal
  // WebM) → H.264 (hardware acceleration, broader player
  // compatibility) → bare container. Audio: Opus in WebM
  // (Chrome-native) → bare container → MP4 fallback.
  //
  // microphone: audio-only. screen: video + tab audio (4.7's feed).
  // webcam: video-only — the face stays separate from the screen.
  var FORMAT_CANDIDATES = {
    microphone: [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4'
    ],
    screen: [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=h264,opus',
      'video/webm'
    ],
    webcam: [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm;codecs=h264',
      'video/webm'
    ]
  };

  // The eight 4.5-owned manifest fields, plus the six 4.6-owned fields
  // (contract §2 field-ownership table; 4.6's deliberate widening per the
  // 4.5 §2 amendment — the manifest record is written at stream start and
  // its keyPath is segmentId, so 4.6 mints it and adds the actual start
  // times). The 4.6 fields are nullable so 4.5's write API keeps its
  // shape; 4.6's stream starter always provides real values (V1-pinned).
  // 4.7 adds the audio-content classifications (screenAudioContent on
  // screen records, micAudioContent on mic records; null elsewhere —
  // the record shape stays uniform, per the 4.6 precedent). 4.10's
  // clockSegmentId link, 4.12 (timecode/offsets), and 4.13 (status,
  // finalizedAtUtc) own their fields and widen this validator when they
  // add them — the exact-keys convention rejects anything else, so the
  // widening is deliberate, not a silent break.
  var MANIFEST_KEYS = [
    'segmentId',
    'sessionId',
    'gameId',
    'streamKind',
    'requestedMimeType',
    'actualMimeType',
    'fileExtension',
    'createdAtUtc',
    // 4.6-owned:
    'streamStartedAtUtc',
    'streamStartedAtMonotonicMs',
    'effectiveDeviceId',
    'audioTrackPresent',
    'videoTrackPresent',
    // 4.7-owned:
    'screenAudioContent',
    'micAudioContent',
    // 4.10-owned:
    'clockSegmentId',
    // 4.13-owned:
    'segmentNumber',
    'finalizedAtUtc'
  ];

  var FILE_EXTENSIONS = ['.webm', '.mp4', '.m4a'];

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

  function requireUuidV4(value, what) {
    if (!isUuidV4(value)) {
      throw new TypeError(what + ' must be a uuid-v4 string');
    }
    return value;
  }

  function requireStreamKind(value) {
    if (STREAM_KINDS.indexOf(value) === -1) {
      throw new RangeError('streamKind must be one of: ' +
        STREAM_KINDS.join(', '));
    }
    return value;
  }

  function requireMimeOrNull(value, what) {
    if (value !== null && typeof value !== 'string') {
      throw new TypeError(what + ' must be a string or null');
    }
    return value;
  }

  function requireExactKeys(obj, keys, what) {
    if (!isPlainObject(obj)) {
      throw new TypeError(what + ' must be a plain object');
    }
    var actual = Object.keys(obj).sort();
    var expected = keys.slice().sort();
    if (actual.length !== expected.length) {
      throw new TypeError(what + ' must have exactly ' + expected.length +
        ' keys, got ' + actual.length);
    }
    for (var i = 0; i < expected.length; i++) {
      if (actual[i] !== expected[i]) {
        throw new TypeError(what + ' must have exactly the keys: ' +
          expected.join(', '));
      }
    }
    return obj;
  }

  // Small 4.6 helpers (AGENTS.md error conventions).
  function requireNonEmptyString(value, what) {
    if (typeof value !== 'string' || value === '') {
      throw new TypeError(what + ' must be a non-empty string');
    }
    return value;
  }

  function requireFiniteNumber(value, what) {
    if (typeof value !== 'number' || !isFinite(value)) {
      throw new TypeError(what + ' must be a finite number');
    }
    return value;
  }

  function requireBoolean(value, what) {
    if (typeof value !== 'boolean') {
      throw new TypeError(what + ' must be a boolean');
    }
    return value;
  }

  // Small 4.13 helper (AGENTS.md error conventions).
  function requirePositiveInt(value, what) {
    if (typeof value !== 'number' || !isFinite(value) ||
        Math.floor(value) !== value || value <= 0) {
      throw new TypeError(what + ' must be a positive integer');
    }
    return value;
  }

  // ------------------------------------------------------------------
  // Pure functions: format verification and MIME → extension.
  // ------------------------------------------------------------------

  // Derive the file extension from the ACTUAL (negotiated) MIME type —
  // never from the requested string. Unknown → null (never fabricated);
  // null means "unknown — §6 must not assume", and media-sync.json
  // carries the MIME type regardless.
  function extensionForMimeType(mimeType) {
    if (typeof mimeType !== 'string') {
      return null;
    }
    var t = mimeType.split(';')[0].trim().toLowerCase();
    if (t.indexOf('video/webm') === 0 || t.indexOf('audio/webm') === 0) {
      return '.webm';
    }
    if (t.indexOf('video/mp4') === 0) {
      return '.mp4';
    }
    if (t.indexOf('audio/mp4') === 0) {
      return '.m4a';
    }
    return null;
  }

  // ------------------------------------------------------------------
  // The format-support instance.
  //
  // opts:
  //   mediaRecorder — the MediaRecorder namespace (injected for tests).
  //                   When absent, read lazily from the real global at
  //                   construction time (the offscreen document).
  //   db            — the DB surface ({put}). When absent, resolved lazily
  //                   from the shared namespace's DB at write time
  //                   (recorder.html loads db.js).
  //   nowUtcIso     — () => UTC ISO string for createdAtUtc (injectable;
  //                   default new Date().toISOString()).
  // ------------------------------------------------------------------

  function createFormatSupport(opts) {
    var o = opts || {};
    var mediaRecorderNs = ('mediaRecorder' in o) ?
      o.mediaRecorder : readMediaRecorder();
    var injectedDb = ('db' in o) ? o.db : null;
    var nowUtcIso = typeof o.nowUtcIso === 'function' ?
      o.nowUtcIso : function () { return new Date().toISOString(); };

    function readMediaRecorder() {
      var g = (typeof globalThis !== 'undefined') ? globalThis : null;
      return g ? (g.MediaRecorder || null) : null;
    }

    function readDb() {
      if (injectedDb) {
        return injectedDb;
      }
      var BS = shared();
      if (!BS || !BS.DB || typeof BS.DB.put !== 'function') {
        throw new Error('format_support: DB is unavailable');
      }
      return BS.DB;
    }

    function supportedChecker() {
      if (!mediaRecorderNs ||
          typeof mediaRecorderNs.isTypeSupported !== 'function') {
        // Unavailable platform capability (AGENTS.md): plain Error, never
        // a weak fallback and never a fabricated candidate list.
        throw new Error(
          'format_support: MediaRecorder.isTypeSupported is unavailable');
      }
      return mediaRecorderNs.isTypeSupported;
    }

    // Probe one stream kind against its frozen candidate list, in
    // priority order. A throwing isTypeSupported is treated as
    // unsupported for that candidate (defensive, not silent — the
    // candidate is simply absent from the result).
    function verifyKind(kind) {
      var isSupported = supportedChecker();
      var list = FORMAT_CANDIDATES[kind];
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var ok = false;
        try {
          ok = isSupported(list[i]) === true;
        } catch (e) {
          ok = false;
        }
        if (ok) {
          out.push(list[i]);
        }
      }
      return out;
    }

    // The supported subset of each frozen candidate list, order
    // preserved. Always re-probed — no cache, no staleness. An empty
    // list for a kind is an honest "nothing supported": 4.6 must refuse
    // to start that stream (4.14 reports it); there is never a silent
    // fallback to an unverified type.
    function verifyFormats() {
      return {
        microphone: verifyKind('microphone'),
        screen: verifyKind('screen'),
        webcam: verifyKind('webcam')
      };
    }

    // ----------------------------------------------------------------
    // The recording manifest writer (4.6 calls this at stream start).
    // ----------------------------------------------------------------

    // Exact-keys validator for a manifest record. Covers the eight
    // 4.5-owned fields plus the six 4.6-owned fields plus the two
    // 4.7-owned audio-content classifications plus the one 4.10-owned
    // clock link plus the two 4.13-owned finalization fields
    // (deliberate widenings — see MANIFEST_KEYS). The
    // 4.6/4.7/4.10/4.13 fields are nullable: recordSegmentFormat derives
    // them only when provided.
    function requireValidManifestRecord(record) {
      requireExactKeys(record, MANIFEST_KEYS, 'recording_manifest record');
      requireUuidV4(record.segmentId, 'segmentId');
      requireUuidV4(record.sessionId, 'sessionId');
      requireUuidV4(record.gameId, 'gameId');
      requireStreamKind(record.streamKind);
      requireMimeOrNull(record.requestedMimeType, 'requestedMimeType');
      requireMimeOrNull(record.actualMimeType, 'actualMimeType');
      if (record.fileExtension !== null &&
          FILE_EXTENSIONS.indexOf(record.fileExtension) === -1) {
        throw new RangeError('fileExtension must be one of: ' +
          FILE_EXTENSIONS.join(', ') + ' or null');
      }
      if (typeof record.createdAtUtc !== 'string' ||
          record.createdAtUtc === '') {
        throw new TypeError('createdAtUtc must be a non-empty string');
      }
      if (record.streamStartedAtUtc !== null &&
          (typeof record.streamStartedAtUtc !== 'string' ||
           record.streamStartedAtUtc === '')) {
        throw new TypeError('streamStartedAtUtc must be a non-empty string or null');
      }
      if (record.streamStartedAtMonotonicMs !== null &&
          (typeof record.streamStartedAtMonotonicMs !== 'number' ||
           !isFinite(record.streamStartedAtMonotonicMs))) {
        throw new TypeError('streamStartedAtMonotonicMs must be a finite number or null');
      }
      if (record.effectiveDeviceId !== null &&
          (typeof record.effectiveDeviceId !== 'string' ||
           record.effectiveDeviceId === '')) {
        throw new TypeError('effectiveDeviceId must be a non-empty string or null');
      }
      if (record.audioTrackPresent !== null &&
          typeof record.audioTrackPresent !== 'boolean') {
        throw new TypeError('audioTrackPresent must be a boolean or null');
      }
      if (record.videoTrackPresent !== null &&
          typeof record.videoTrackPresent !== 'boolean') {
        throw new TypeError('videoTrackPresent must be a boolean or null');
      }
      // 4.7-owned audio-content classifications. The vocabulary lives in
      // audio_policy.js; resolved at call time from the shared namespace
      // (sender.js precedent — this module never carries the policy's
      // exports at load). Absence is a wiring defect: plain Error.
      var ap = audioPolicyValidators();
      ap.requireScreenAudioContent(record.screenAudioContent,
        'screenAudioContent');
      ap.requireMicAudioContent(record.micAudioContent, 'micAudioContent');
      // 4.10-owned: the recording-context clock segment this recording
      // segment is linked to. Nullable (null = the anchor could not be
      // captured — recorded honestly); otherwise a uuid-v4. The linker
      // is identity-only: no other anchor field is stored here.
      if (record.clockSegmentId !== null) {
        requireUuidV4(record.clockSegmentId, 'clockSegmentId');
      }
      // 4.13-owned: chronological 1-based number per (sessionId,
      // streamKind); null until the finalizer assigns it at Stop.
      if (record.segmentNumber !== null &&
          (typeof record.segmentNumber !== 'number' ||
           !isFinite(record.segmentNumber) ||
           Math.floor(record.segmentNumber) !== record.segmentNumber ||
           record.segmentNumber <= 0)) {
        throw new TypeError('segmentNumber must be a positive integer or null');
      }
      // 4.13-owned: ISO timestamp marking the segment's chunk set
      // closed; null while recording.
      if (record.finalizedAtUtc !== null &&
          (typeof record.finalizedAtUtc !== 'string' ||
           record.finalizedAtUtc === '')) {
        throw new TypeError('finalizedAtUtc must be a non-empty string or null');
      }
      return record;
    }

    // Resolve the 4.7 audio-content validators from the shared namespace
    // at call time. recorder.html loads audio_policy.js, so the document
    // always has them; Node tests merge the modules onto
    // globalThis.BlindfoldSession (stream_starter.test.js precedent).
    function audioPolicyValidators() {
      var s = shared();
      var reqScreen = s ? s.requireScreenAudioContent : null;
      var reqMic = s ? s.requireMicAudioContent : null;
      if (typeof reqScreen !== 'function' ||
          typeof reqMic !== 'function') {
        throw new Error('format_support: audio_policy.js is unavailable');
      }
      return {
        requireScreenAudioContent: reqScreen,
        requireMicAudioContent: reqMic
      };
    }

    // Write one manifest record. The fileExtension is derived from the
    // ACTUAL negotiated MIME type (recorder.mimeType as passed in by
    // 4.6), never from the requested string.
    //
    // 4.6's fields (streamStartedAtUtc, streamStartedAtMonotonicMs,
    // effectiveDeviceId, audioTrackPresent, videoTrackPresent) are
    // accepted when provided and default to null otherwise — the
    // deliberate 4.6 widening keeps 4.5's call shape intact.
    //
    // 4.7's fields (screenAudioContent, micAudioContent) are accepted
    // when provided and default to null otherwise — the same deliberate
    // widening pattern. 4.7's stream starter provides the real
    // classifications; null means "not applicable / not observed."
    //
    // 4.10's field (clockSegmentId) is accepted when provided and
    // defaults to null otherwise — the same deliberate widening
    // pattern. The stream starter provides the real link at
    // manifest-write time; null means the anchor could not be captured.
    //
    // 4.13's fields (segmentNumber, finalizedAtUtc) are accepted when
    // provided and default to null otherwise — the same deliberate
    // widening pattern. The finalizer assigns the real values at Stop;
    // null means "not yet finalized" (4.13's contract §2).
    //
    // Pre-session inertness (2.x/3.x/4.2 precedent): null/undefined
    // sessionId or gameId → plain data {ok:false, error:'no-session'},
    // never throws across the channel. Malformed inputs throw
    // TypeError/RangeError per the error conventions (the channel
    // handler converts them to {ok:false}).
    function recordSegmentFormat(input) {
      if (!isPlainObject(input)) {
        return Promise.resolve({ ok: false, error: 'invalid-request' });
      }
      if (input.sessionId === null || input.sessionId === undefined ||
          input.gameId === null || input.gameId === undefined) {
        return Promise.resolve({ ok: false, error: 'no-session' });
      }
      var record;
      try {
        // The 4.7 validators come from audio_policy.js (call-time
        // shared-namespace resolution); absence is a wiring defect.
        var ap = audioPolicyValidators();
        record = {
          segmentId: requireUuidV4(input.segmentId, 'segmentId'),
          sessionId: requireUuidV4(input.sessionId, 'sessionId'),
          gameId: requireUuidV4(input.gameId, 'gameId'),
          streamKind: requireStreamKind(input.streamKind),
          requestedMimeType: requireMimeOrNull(
            input.requestedMimeType, 'requestedMimeType'),
          actualMimeType: requireMimeOrNull(
            input.actualMimeType, 'actualMimeType'),
          fileExtension: extensionForMimeType(input.actualMimeType),
          createdAtUtc: nowUtcIso(),
          // 4.6-owned (nullable; 4.6 always provides real values).
          streamStartedAtUtc: (input.streamStartedAtUtc === undefined ||
            input.streamStartedAtUtc === null) ? null :
            requireNonEmptyString(input.streamStartedAtUtc, 'streamStartedAtUtc'),
          streamStartedAtMonotonicMs: (input.streamStartedAtMonotonicMs === undefined ||
            input.streamStartedAtMonotonicMs === null) ? null :
            requireFiniteNumber(input.streamStartedAtMonotonicMs, 'streamStartedAtMonotonicMs'),
          effectiveDeviceId: (input.effectiveDeviceId === undefined ||
            input.effectiveDeviceId === null) ? null :
            requireNonEmptyString(input.effectiveDeviceId, 'effectiveDeviceId'),
          audioTrackPresent: (input.audioTrackPresent === undefined ||
            input.audioTrackPresent === null) ? null :
            requireBoolean(input.audioTrackPresent, 'audioTrackPresent'),
          videoTrackPresent: (input.videoTrackPresent === undefined ||
            input.videoTrackPresent === null) ? null :
            requireBoolean(input.videoTrackPresent, 'videoTrackPresent'),
          // 4.7-owned (nullable; 4.7's stream starter provides the real
          // classifications at manifest-write time; null elsewhere).
          screenAudioContent: ap.requireScreenAudioContent(
            input.screenAudioContent, 'screenAudioContent'),
          micAudioContent: ap.requireMicAudioContent(
            input.micAudioContent, 'micAudioContent'),
          // 4.10-owned (nullable; the stream starter provides the real
          // link at manifest-write time; null when the anchor could
          // not be captured or the linker was unavailable).
          clockSegmentId: (input.clockSegmentId === undefined ||
            input.clockSegmentId === null) ? null :
            requireUuidV4(input.clockSegmentId, 'clockSegmentId'),
          // 4.13-owned (nullable; the finalizer assigns the real values
          // at Stop; null while the segment is open).
          segmentNumber: (input.segmentNumber === undefined ||
            input.segmentNumber === null) ? null :
            requirePositiveInt(input.segmentNumber, 'segmentNumber'),
          finalizedAtUtc: (input.finalizedAtUtc === undefined ||
            input.finalizedAtUtc === null) ? null :
            requireNonEmptyString(input.finalizedAtUtc, 'finalizedAtUtc')
        };
        requireValidManifestRecord(record);
      } catch (e) {
        return Promise.reject(e);
      }
      return Promise.resolve()
        .then(function () { return readDb().put(MANIFEST_STORE, record); })
        .then(function () {
          return {
            ok: true,
            segmentId: record.segmentId,
            fileExtension: record.fileExtension
          };
        });
    }

    // ----------------------------------------------------------------
    // 4.9: manifest read for restart detection (PLAN.md §4.9). Additive:
    // the manifest store and its bySessionId index already exist (4.5).
    // Returns the session's manifest records ([] when none) — unknown
    // is [], never null. recorder.js's start-streams handler calls this
    // BEFORE starting new streams: pre-existing unfinalized records
    // mean a previous document generation died mid-session.
    // ----------------------------------------------------------------

    function getManifestRecordsBySession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new TypeError(
          'format_support: sessionId must be a non-empty string');
      }
      var db = readDb();
      return Promise.resolve()
        .then(function () {
          return db.getAll(MANIFEST_STORE, {
            index: 'bySessionId',
            lower: sessionId,
            upper: sessionId
          });
        })
        .then(function (records) {
          return Array.isArray(records) ? records : [];
        });
    }

    // ----------------------------------------------------------------
    // 4.10: per-segment manifest read (PLAN.md §4.10). Additive: the
    // store's keyPath IS segmentId, so no new index and no schema
    // change. Returns the record or null (unknown is null, never
    // undefined). 4.12/4.14/§6.3 read the clock link through this;
    // 4.13 reads each minted segment's record the same way.
    // ----------------------------------------------------------------

    function getManifestRecord(segmentId) {
      requireUuidV4(segmentId, 'segmentId');
      var db = readDb();
      return Promise.resolve()
        .then(function () { return db.get(MANIFEST_STORE, segmentId); })
        .then(function (record) {
          return (record === undefined || record === null) ? null : record;
        });
    }

    return {
      verifyFormats: verifyFormats,
      recordSegmentFormat: recordSegmentFormat,
      requireValidManifestRecord: requireValidManifestRecord,
      getManifestRecordsBySession: getManifestRecordsBySession,
      getManifestRecord: getManifestRecord
    };
  }

  // Freeze the published constants (shallow is enough: arrays of
  // strings; the candidate lists are replaced wholesale if a kind is
  // ever re-prioritized).
  function freezeConstants() {
    var kinds = Object.keys(FORMAT_CANDIDATES);
    for (var i = 0; i < kinds.length; i++) {
      Object.freeze(FORMAT_CANDIDATES[kinds[i]]);
    }
    Object.freeze(FORMAT_CANDIDATES);
    Object.freeze(STREAM_KINDS);
    Object.freeze(MANIFEST_KEYS);
    Object.freeze(FILE_EXTENSIONS);
  }
  freezeConstants();

  BlindfoldSession.FORMAT_STREAM_KINDS = STREAM_KINDS;
  BlindfoldSession.FORMAT_CANDIDATES = FORMAT_CANDIDATES;
  BlindfoldSession.MANIFEST_STORE_NAME = MANIFEST_STORE;
  BlindfoldSession.MANIFEST_KEYS = MANIFEST_KEYS;
  BlindfoldSession.extensionForMimeType = extensionForMimeType;
  BlindfoldSession.createFormatSupport = createFormatSupport;
})();

// Node test shim. The offscreen document loads this via <script>; only
// environments that provide CommonJS get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
