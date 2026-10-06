// exporter.js — SW-side export bundle builders (PLAN.md §6).
//
// 6.1: pure buildMetadataJson. Takes the session's stored records plus
// 5.10's stop verdict and returns the exact metadata.json string for
// the bundle. No I/O, no IndexedDB reads (6.6's orchestration reads the
// stores and passes plain records in), no ID minting. The one clock read
// is the explicitly labeled exportedAtUtc (injected nowUtcIso for
// testability).
//
// Raw-data discipline: every value is copied from the inputs or derived
// by counting. Nothing is inferred, computed, or fabricated. Unknown is
// null; absent stop verdict degrades to 'unknown', never 'complete'.
//
// Conventions: dependency-free classic script → guarded BlindfoldSession
// global → IIFE 'use strict' → Node module.exports shim.
// TypeError = wrong type/shape; RangeError = bad domain;
// plain Error = unavailable capability / refused operation.
var BlindfoldSession = BlindfoldSession || {};
(function () {
  'use strict';

  // The §5 required set, mirrored locally so this module stays
  // dependency-free and Node-testable without importScripts order
  // coupling (chunk_writer.js owns the canonical list).
  var STREAM_KINDS = Object.freeze(['microphone', 'screen', 'webcam']);

  var CONDITION_FIELDS = Object.freeze([
    'trainingApproach',
    'verbalScaffolding',
    'botName',
    'botDisplayedRating',
    'playerColor',
    'timeControl',
    'assistanceSettings'
  ]);

  var COMPLETION_VERDICTS = Object.freeze([
    'complete',
    'complete-with-warnings',
    'unknown'
  ]);

  var UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  function isUuidV4(s) {
    return typeof s === 'string' && UUID_V4_RE.test(s);
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function defaultNowUtcIso() {
    return new Date().toISOString();
  }

  // --- input validation (TypeError on malformed input, never silent defaults) ---

  function requireValidMetadata(metadata) {
    if (!isPlainObject(metadata)) {
      throw new TypeError('exporter: metadata must be a session metadata object');
    }
    if (!isUuidV4(metadata.sessionId)) {
      throw new TypeError('exporter: metadata.sessionId must be a uuid-v4 string');
    }
    if (!Array.isArray(metadata.gameIds) ||
        !metadata.gameIds.every(isUuidV4)) {
      throw new TypeError('exporter: metadata.gameIds must be an array of uuid-v4 strings');
    }
    if (typeof metadata.schemaVersion !== 'string' || metadata.schemaVersion === '') {
      throw new TypeError('exporter: metadata.schemaVersion must be a non-empty string');
    }
    if (typeof metadata.extensionVersion !== 'string' ||
        metadata.extensionVersion.trim() === '') {
      throw new TypeError('exporter: metadata.extensionVersion must be a non-empty string');
    }
    if (metadata.protocolVersion !== null &&
        typeof metadata.protocolVersion !== 'string') {
      throw new TypeError('exporter: metadata.protocolVersion must be a string or null');
    }
    if (typeof metadata.sessionCategory !== 'string' || metadata.sessionCategory === '') {
      throw new TypeError('exporter: metadata.sessionCategory must be a non-empty string');
    }
  }

  function requireValidConditions(conditions) {
    if (conditions === null || conditions === undefined) {
      return null;
    }
    if (!isPlainObject(conditions)) {
      throw new TypeError('exporter: conditions must be an object or null');
    }
    // Verbatim export: the record is copied as stored. Each of the seven
    // fields must be present (1.2's createInitialConditions always writes
    // all seven); a partial record is malformed input, not an excuse to
    // invent the missing fields.
    var i, field;
    for (i = 0; i < CONDITION_FIELDS.length; i++) {
      field = CONDITION_FIELDS[i];
      if (!Object.prototype.hasOwnProperty.call(conditions, field) ||
          !isPlainObject(conditions[field])) {
        throw new TypeError('exporter: conditions.' + field + ' must be a {value, source} object');
      }
    }
    return conditions;
  }

  function requireValidManifestRecords(records) {
    if (!Array.isArray(records)) {
      throw new TypeError('exporter: manifestRecords must be an array');
    }
    var i, r;
    for (i = 0; i < records.length; i++) {
      r = records[i];
      if (!isPlainObject(r) || typeof r.streamKind !== 'string' || r.streamKind === '') {
        throw new TypeError('exporter: manifestRecords[' + i + '] must be a manifest record with streamKind');
      }
    }
    return records;
  }

  function requireValidStopVerdict(stopVerdict) {
    if (stopVerdict === null || stopVerdict === undefined) {
      return null;
    }
    if (!isPlainObject(stopVerdict)) {
      throw new TypeError('exporter: stopVerdict must be an object or null');
    }
    // 'failed' is not malformed — it is a real verdict that the
    // orchestration must refuse. It is handled by the caller path,
    // not treated as unknown.
    if (stopVerdict.verdict !== 'failed' &&
        COMPLETION_VERDICTS.indexOf(stopVerdict.verdict) === -1) {
      throw new TypeError("exporter: stopVerdict.verdict must be 'complete', 'complete-with-warnings', 'failed', or absent");
    }
    if (stopVerdict.warnings !== undefined && !Array.isArray(stopVerdict.warnings)) {
      throw new TypeError('exporter: stopVerdict.warnings must be an array');
    }
    return stopVerdict;
  }

  // --- builders ---

  // Media inventory per stream kind: counts only, no metrics.
  // A kind with zero segments is explicit (missing/failed stream),
  // never omitted. "finalized" counts segments 4.13 numbered at
  // finalize (segmentNumber !== null); formats are the distinct
  // actual mime types observed, sorted for byte-stability.
  function buildMediaInventory(manifestRecords) {
    var inventory = {};
    var k, i, r, formats, seen;
    for (k = 0; k < STREAM_KINDS.length; k++) {
      var kind = STREAM_KINDS[k];
      var segments = 0;
      var finalized = 0;
      seen = {};
      formats = [];
      for (i = 0; i < manifestRecords.length; i++) {
        r = manifestRecords[i];
        if (r.streamKind !== kind) {
          continue;
        }
        segments++;
        if (r.segmentNumber !== null && r.segmentNumber !== undefined) {
          finalized++;
        }
        if (typeof r.actualMimeType === 'string' && r.actualMimeType !== '' &&
            !seen[r.actualMimeType]) {
          seen[r.actualMimeType] = true;
          formats.push(r.actualMimeType);
        }
      }
      formats.sort();
      inventory[kind] = {
        segments: segments,
        finalized: finalized,
        formats: formats
      };
    }
    return inventory;
  }

  // Completion mapping (5.10 → metadata.json). Fail-closed: absent
  // verdict degrades to 'unknown', never 'complete'. 'failed' throws —
  // a bundle must never document a session whose Stop failed; 6.6's
  // orchestration catches this and answers {ok:false,
  // error:'session-not-complete'}.
  function buildCompletion(stopVerdict) {
    if (stopVerdict === null) {
      return {
        verdict: 'unknown',
        warnings: [],
        note: 'stop-verdict-unavailable',
        finalizedAtUtc: null,
        undeliveredEvents: null
      };
    }
    if (stopVerdict.verdict === 'failed') {
      throw new Error('exporter: session-not-complete (stop verdict is failed)');
    }
    var warnings = Array.isArray(stopVerdict.warnings) ?
      stopVerdict.warnings.slice() : [];
    var stopResp = isPlainObject(stopVerdict.stopResp) ? stopVerdict.stopResp : null;
    var flushResult = isPlainObject(stopVerdict.flushResult) ? stopVerdict.flushResult : null;
    var finalizedAtUtc = (stopResp !== null &&
      (typeof stopResp.finalizedAtUtc === 'string' || stopResp.finalizedAtUtc === null)) ?
      stopResp.finalizedAtUtc : null;
    var undeliveredEvents = (flushResult !== null &&
      typeof flushResult.pending === 'number' && flushResult.pending >= 0) ?
      flushResult.pending : null;
    var out = {
      verdict: stopVerdict.verdict,
      warnings: warnings,
      finalizedAtUtc: finalizedAtUtc,
      undeliveredEvents: undeliveredEvents
    };
    return out;
  }

  // Per-game starting FEN, denormalized from the game_started event
  // payloads (game_records.js conflict rule). 6.6's orchestration
  // extracts gameId → fen from the events stream and passes it in as
  // gameStartingFens; this builder never reads events itself.
  // Precedence: provided FEN → null (unknown, never synthesized).
  // Note: the 1.2 conditions record carries no FEN field in the current
  // schema, so there is no conditions-level fallback to apply.
  function buildGameStartingFen(gameIds, gameStartingFens) {
    var out = {};
    var i, gid, fen;
    for (i = 0; i < gameIds.length; i++) {
      gid = gameIds[i];
      fen = (isPlainObject(gameStartingFens) &&
        (typeof gameStartingFens[gid] === 'string' || gameStartingFens[gid] === null)) ?
        gameStartingFens[gid] : null;
      out[gid] = fen;
    }
    return out;
  }

  // The 5.2 training fields live in the 1.2 conditions record (not in
  // the 1.1 metadata record, which carries only identity + versions +
  // category). Exported here as plain values; null when conditions are
  // absent (unknown = unknown).
  function trainingValue(conditions, field) {
    if (conditions === null) {
      return null;
    }
    var entry = conditions[field];
    var v = isPlainObject(entry) ? entry.value : null;
    return (typeof v === 'string' || v === null) ? v : null;
  }

  function copyConditionsVerbatim(conditions) {
    if (conditions === null) {
      return null;
    }
    var out = {};
    var i, field, entry;
    for (i = 0; i < CONDITION_FIELDS.length; i++) {
      field = CONDITION_FIELDS[i];
      entry = conditions[field];
      out[field] = {
        value: isPlainObject(entry) ? entry.value : null,
        source: (isPlainObject(entry) && typeof entry.source === 'string') ?
          entry.source : null
      };
    }
    return out;
  }

  // 6.1: build the exact metadata.json string for the export bundle.
  //
  // args: {
  //   metadata,          // session_metadata record (required)
  //   conditions,        // 1.2 conditions record or null (optional)
  //   manifestRecords,   // recording_manifest rows for the session (required, may be empty)
  //   stopVerdict,       // 5.10 retained {stopResp, flushResult, verdict, warnings} or null (optional)
  //   eventCount,        // number of the session's rows in events (required)
  //   gameStartingFens,  // optional {gameId: fen|null} extracted by 6.6 from game_started events
  //   nowUtcIso          // optional injected clock for exportedAtUtc (test seam)
  // }
  //
  // Returns the pretty-printed (2-space) metadata.json string with
  // stable key order (byte-stable for 6.7's repeatability). Throws
  // TypeError on malformed input; throws plain Error when the stop
  // verdict is 'failed' (orchestration maps to session-not-complete).
  function buildMetadataJson(args) {
    if (!isPlainObject(args)) {
      throw new TypeError('exporter: args must be an object');
    }
    requireValidMetadata(args.metadata);
    var conditions = requireValidConditions(
      args.conditions === undefined ? null : args.conditions);
    var manifestRecords = requireValidManifestRecords(args.manifestRecords);
    var stopVerdict = requireValidStopVerdict(
      args.stopVerdict === undefined ? null : args.stopVerdict);
    if (typeof args.eventCount !== 'number' ||
        Math.floor(args.eventCount) !== args.eventCount ||
        args.eventCount < 0) {
      throw new TypeError('exporter: eventCount must be a non-negative integer');
    }
    var nowUtcIso = args.nowUtcIso === undefined ? defaultNowUtcIso : args.nowUtcIso;
    if (typeof nowUtcIso !== 'function') {
      throw new TypeError('exporter: nowUtcIso must be a function');
    }

    var metadata = args.metadata;
    var exportedAtUtc = nowUtcIso();
    if (typeof exportedAtUtc !== 'string' || exportedAtUtc === '') {
      throw new TypeError('exporter: nowUtcIso must return a non-empty string');
    }

    // Key order below is the contract §3 order — stable for 6.7.
    var doc = {
      sessionId: metadata.sessionId,
      gameIds: metadata.gameIds.slice(),
      sessionCategory: metadata.sessionCategory,
      versions: {
        schemaVersion: metadata.schemaVersion,
        extensionVersion: metadata.extensionVersion,
        protocolVersion: metadata.protocolVersion
      },
      training: {
        trainingApproach: trainingValue(conditions, 'trainingApproach'),
        verbalScaffolding: trainingValue(conditions, 'verbalScaffolding')
      },
      initialConditions: copyConditionsVerbatim(conditions),
      gameStartingFen: buildGameStartingFen(metadata.gameIds, args.gameStartingFens),
      completion: buildCompletion(stopVerdict),
      mediaInventory: buildMediaInventory(manifestRecords),
      coverage: {
        eventsStored: args.eventCount,
        gamesObserved: metadata.gameIds.length
      },
      exportedAtUtc: exportedAtUtc
    };
    return JSON.stringify(doc, null, 2);
  }

  BlindfoldSession.buildMetadataJson = buildMetadataJson;
  // Exported for tests and for 6.6's orchestration (failed-verdict check).
  BlindfoldSession.EXPORTER_STREAM_KINDS = STREAM_KINDS;

  // --- 6.2: events.jsonl ---

  // An event's appendSeq is the persistent append order (PLAN §1.3.4).
  // The 2.4 writer assigns it transactionally on every stored row, so
  // null/non-integer/negative/duplicate values are corrupt data —
  // surfaced as TypeError per the corruption-honesty rule, never
  // silently skipped, reordered, or invented.
  function requireValidAppendSeq(event, index) {
    var label = 'exporter: events[' + index + ']';
    var id = isPlainObject(event) && typeof event.eventId === 'string' ?
      event.eventId : null;
    if (id !== null) {
      label += ' (eventId ' + id + ')';
    }
    if (!isPlainObject(event)) {
      throw new TypeError(label + ' must be an event object');
    }
    var seq = event.appendSeq;
    if (typeof seq !== 'number' || Math.floor(seq) !== seq || seq < 0) {
      throw new TypeError(label + ' has a corrupt appendSeq (must be a non-negative integer)');
    }
    return seq;
  }

  // 6.2: build the exact events.jsonl string for the export bundle.
  //
  // args: { events } — the session's stored event rows (may be empty).
  //
  // Returns one JSON.stringify(event) per line in appendSeq ascending
  // order, joined by '\n' with a trailing '\n' (empty input → empty
  // string). Verbatim passthrough: the builder adds no keys, removes
  // no keys, reorders no keys, and computes no metrics. The envelope
  // key order is stable (event_envelope.js EVENT_KEYS), so output is
  // byte-stable for 6.7's repeatability. Throws TypeError on
  // malformed input (including corrupt/duplicate appendSeq).
  function buildEventsJsonl(args) {
    if (!isPlainObject(args)) {
      throw new TypeError('exporter: args must be an object');
    }
    if (!Array.isArray(args.events)) {
      throw new TypeError('exporter: events must be an array');
    }
    var events = args.events;
    var seqs = new Array(events.length);
    var seen = {};
    var i, seq;
    for (i = 0; i < events.length; i++) {
      seq = requireValidAppendSeq(events[i], i);
      if (seen[seq]) {
        throw new TypeError('exporter: events has a duplicate appendSeq ' + seq);
      }
      seen[seq] = true;
      seqs[i] = seq;
    }
    var order = new Array(events.length);
    for (i = 0; i < order.length; i++) {
      order[i] = i;
    }
    order.sort(function (a, b) { return seqs[a] - seqs[b]; });
    var lines = new Array(events.length);
    for (i = 0; i < order.length; i++) {
      lines[i] = JSON.stringify(events[order[i]]);
    }
    return lines.length === 0 ? '' : lines.join('\n') + '\n';
  }

  BlindfoldSession.buildEventsJsonl = buildEventsJsonl;

  // --- 6.3: media-sync.json ---

  function requireValidClockAnchors(clockAnchors) {
    if (!Array.isArray(clockAnchors)) {
      throw new TypeError('exporter: clockAnchors must be an array');
    }
    var i, a;
    for (i = 0; i < clockAnchors.length; i++) {
      a = clockAnchors[i];
      if (!isPlainObject(a) || typeof a.segmentId !== 'string' ||
          typeof a.utcEpochMs !== 'number' || typeof a.monotonicMs !== 'number') {
        throw new TypeError('exporter: clockAnchors[' + i + '] must be {segmentId, utcEpochMs, monotonicMs}');
      }
    }
    return clockAnchors;
  }

  function requireValidSegmentFiles(segmentFiles) {
    if (segmentFiles === null || segmentFiles === undefined) {
      return null;
    }
    if (!isPlainObject(segmentFiles)) {
      throw new TypeError('exporter: segmentFiles must be a plain object or null');
    }
    var k;
    for (k in segmentFiles) {
      if (Object.prototype.hasOwnProperty.call(segmentFiles, k)) {
        var v = segmentFiles[k];
        if (v !== null && (typeof v !== 'string' || v === '')) {
          throw new TypeError('exporter: segmentFiles[' + k + '] must be a non-empty string or null');
        }
      }
    }
    return segmentFiles;
  }

  function requireValidChunkStats(chunkStats) {
    if (chunkStats === null || chunkStats === undefined) {
      return null;
    }
    if (!isPlainObject(chunkStats)) {
      throw new TypeError('exporter: chunkStats must be a plain object or null');
    }
    var k, e;
    for (k in chunkStats) {
      if (Object.prototype.hasOwnProperty.call(chunkStats, k)) {
        e = chunkStats[k];
        if (!isPlainObject(e)) {
          throw new TypeError('exporter: chunkStats[' + k + '] must be an object');
        }
        if (e.chunkCount !== null && e.chunkCount !== undefined &&
            (typeof e.chunkCount !== 'number' || Math.floor(e.chunkCount) !== e.chunkCount ||
             e.chunkCount < 0)) {
          throw new TypeError('exporter: chunkStats[' + k + '].chunkCount must be a non-negative integer or null');
        }
        if (e.chunksAfterFinalize !== null && e.chunksAfterFinalize !== undefined &&
            (typeof e.chunksAfterFinalize !== 'number' ||
             Math.floor(e.chunksAfterFinalize) !== e.chunksAfterFinalize ||
             e.chunksAfterFinalize < 0)) {
          throw new TypeError('exporter: chunkStats[' + k + '].chunksAfterFinalize must be a non-negative integer or null');
        }
      }
    }
    return chunkStats;
  }

  function isUsableNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function isUsableIso(v) {
    return typeof v === 'string' && v !== '';
  }

  // The ONE computed value in media-sync.json: the wall-clock time of
  // this segment's media-time zero (the 4.6 start() call time, per
  // 4.12 §3.1: timecode 0 ≈ streamStartedAtMonotonicMs). Formula is
  // the timecode.js canonical wallUtcMs:
  //   anchor.utcEpochMs + (streamStartedAtMonotonicMs - anchor.monotonicMs)
  // null when the anchor is missing or either side is unusable —
  // unknown is null, never a guess. Never rounded (rounding is a lossy
  // transformation; analysis code rounds if it wants to).
  function computeMediaStartWallUtcMs(anchor, streamStartedAtMonotonicMs) {
    if (anchor === null || !isUsableNumber(streamStartedAtMonotonicMs)) {
      return null;
    }
    if (!isUsableNumber(anchor.utcEpochMs) || !isUsableNumber(anchor.monotonicMs)) {
      return null;
    }
    return anchor.utcEpochMs + (streamStartedAtMonotonicMs - anchor.monotonicMs);
  }

  // Per-segment known gaps (contract §4.2, fixed vocabulary).
  // flushTimedOut / stream failure are kind-level facts from the stop
  // response — applied to every segment of that kind (labeled by the
  // kind key), never misattributed to a single segment.
  function buildSegmentGaps(record, anchor, streamResults, chunkStatsFor) {
    var gaps = [];
    if (record.segmentNumber === null || record.segmentNumber === undefined) {
      gaps.push('unfinalized');
    }
    var kindResult = isPlainObject(streamResults) && isPlainObject(streamResults[record.streamKind]) ?
      streamResults[record.streamKind] : null;
    if (kindResult !== null) {
      if (kindResult.ok === false) {
        gaps.push('stream-failed');
      } else if (kindResult.flushTimedOut === true) {
        gaps.push('flush-timed-out');
      }
    }
    var caf = chunkStatsFor !== null && isUsableNumber(chunkStatsFor.chunksAfterFinalize) ?
      chunkStatsFor.chunksAfterFinalize : null;
    if (caf !== null && caf > 0) {
      gaps.push('chunks-after-finalize:' + caf);
    }
    if (record.clockSegmentId !== null && record.clockSegmentId !== undefined && anchor === null) {
      gaps.push('missing-clock-anchor');
    }
    if (!isUsableNumber(record.streamStartedAtMonotonicMs)) {
      gaps.push('missing-stream-start-time');
    }
    return gaps;
  }

  function compareSegments(a, b) {
    var ka = STREAM_KINDS.indexOf(a.streamKind);
    var kb = STREAM_KINDS.indexOf(b.streamKind);
    var kaO = ka === -1 ? STREAM_KINDS.length : ka;
    var kbO = kb === -1 ? STREAM_KINDS.length : kb;
    if (kaO !== kbO) {
      return kaO - kbO;
    }
    // Tiebreaker for unknown kinds: group by kind name so
    // nameSegmentFiles' per-kind usedNumbers tracking never resets
    // between segments of the same unknown kind (which would cause
    // filename collisions). Unreachable in practice (chunk_writer
    // validates streamKind at intake), but fail-safe.
    if (ka === -1 && kb === -1 && a.streamKind !== b.streamKind) {
      return a.streamKind < b.streamKind ? -1 : 1;
    }
    var na = (a.segmentNumber === null || a.segmentNumber === undefined) ? null : a.segmentNumber;
    var nb = (b.segmentNumber === null || b.segmentNumber === undefined) ? null : b.segmentNumber;
    if (na === null && nb !== null) {
      return 1;
    }
    if (na !== null && nb === null) {
      return -1;
    }
    if (na !== null && nb !== null && na !== nb) {
      return na - nb;
    }
    if (a.createdAtUtc !== b.createdAtUtc) {
      return a.createdAtUtc < b.createdAtUtc ? -1 : 1;
    }
    if (a.segmentId !== b.segmentId) {
      return a.segmentId < b.segmentId ? -1 : 1;
    }
    return 0;
  }

  function buildSyncSegment(record, anchor, streamResults, segmentFiles, chunkStatsFor) {
    var finalized = record.segmentNumber !== null && record.segmentNumber !== undefined;
    var filename = (segmentFiles !== null &&
      Object.prototype.hasOwnProperty.call(segmentFiles, record.segmentId)) ?
      segmentFiles[record.segmentId] : null;
    if (filename === undefined) {
      filename = null;
    }
    var chunkStatsEntry = chunkStatsFor !== null ? chunkStatsFor : null;
    return {
      segmentId: record.segmentId,
      streamKind: record.streamKind,
      segmentNumber: finalized ? record.segmentNumber : null,
      filename: filename,
      format: isUsableIso(record.actualMimeType) ? record.actualMimeType : null,
      fileExtension: isUsableIso(record.fileExtension) ? record.fileExtension : null,
      finalized: finalized,
      finalizedAtUtc: isUsableIso(record.finalizedAtUtc) ? record.finalizedAtUtc : null,
      createdAtUtc: isUsableIso(record.createdAtUtc) ? record.createdAtUtc : null,
      streamStartedAtUtc: isUsableIso(record.streamStartedAtUtc) ? record.streamStartedAtUtc : null,
      streamStartedAtMonotonicMs: isUsableNumber(record.streamStartedAtMonotonicMs) ?
        record.streamStartedAtMonotonicMs : null,
      clockSegmentId: (typeof record.clockSegmentId === 'string' && record.clockSegmentId !== '') ?
        record.clockSegmentId : null,
      clockAnchor: anchor === null ? null : {
        segmentId: anchor.segmentId,
        utcEpochMs: anchor.utcEpochMs,
        monotonicMs: anchor.monotonicMs
      },
      mediaStartWallUtcMs: computeMediaStartWallUtcMs(anchor, record.streamStartedAtMonotonicMs),
      chunkCount: chunkStatsEntry !== null && isUsableNumber(chunkStatsEntry.chunkCount) ?
        chunkStatsEntry.chunkCount : null,
      chunksAfterFinalize: chunkStatsEntry !== null && isUsableNumber(chunkStatsEntry.chunksAfterFinalize) ?
        chunkStatsEntry.chunksAfterFinalize : null,
      gaps: buildSegmentGaps(record, anchor, streamResults, chunkStatsEntry)
    };
  }

  // 6.3: build the exact media-sync.json string for the export bundle.
  //
  // args: {
  //   manifestRecords,  // recording_manifest rows for the session (required, may be empty)
  //   clockAnchors,     // [{segmentId, utcEpochMs, monotonicMs}] from clock_anchor events (required, may be empty)
  //   stopVerdict,      // 5.10 retained verdict or null (optional; absent → 'unknown', never 'complete')
  //   segmentFiles,     // {segmentId: filename} from 6.5's namer (optional)
  //   chunkStats,       // {segmentId: {chunkCount, chunksAfterFinalize}} from 6.6 (optional)
  //   nowUtcIso         // optional injected clock for exportedAtUtc (test seam)
  // }
  //
  // Returns the pretty-printed (2-space) media-sync.json string with
  // stable key order and deterministic segment ordering (byte-stable
  // for 6.7's repeatability). The ONE computed value is
  // mediaStartWallUtcMs (timecode.js canonical formula); everything
  // else is copied verbatim. Throws TypeError on malformed input;
  // throws plain Error when the stop verdict is 'failed'.
  function buildMediaSyncJson(args) {
    if (!isPlainObject(args)) {
      throw new TypeError('exporter: args must be an object');
    }
    var manifestRecords = requireValidManifestRecords(args.manifestRecords);
    var clockAnchors = requireValidClockAnchors(
      args.clockAnchors === undefined ? [] : args.clockAnchors);
    var stopVerdict = requireValidStopVerdict(
      args.stopVerdict === undefined ? null : args.stopVerdict);
    var segmentFiles = requireValidSegmentFiles(
      args.segmentFiles === undefined ? null : args.segmentFiles);
    var chunkStats = requireValidChunkStats(
      args.chunkStats === undefined ? null : args.chunkStats);
    var nowUtcIso = args.nowUtcIso === undefined ? defaultNowUtcIso : args.nowUtcIso;
    if (typeof nowUtcIso !== 'function') {
      throw new TypeError('exporter: nowUtcIso must be a function');
    }
    var exportedAtUtc = nowUtcIso();
    if (typeof exportedAtUtc !== 'string' || exportedAtUtc === '') {
      throw new TypeError('exporter: nowUtcIso must return a non-empty string');
    }

    // 'failed' is a real verdict the orchestration must refuse, not an
    // unknown — fail-closed like 6.1's session-not-complete.
    if (stopVerdict !== null && stopVerdict.verdict === 'failed') {
      throw new Error('exporter: session-not-complete (stop verdict is failed)');
    }

    var anchorsBySegment = {};
    var i, a;
    for (i = 0; i < clockAnchors.length; i++) {
      a = clockAnchors[i];
      anchorsBySegment[a.segmentId] = a;
    }

    var stopResp = (stopVerdict !== null && isPlainObject(stopVerdict.stopResp)) ?
      stopVerdict.stopResp : null;
    var streamResults = (stopResp !== null && isPlainObject(stopResp.streams)) ?
      stopResp.streams : {};

    var knownGaps;
    var verdictEcho;
    if (stopVerdict === null) {
      knownGaps = ['stop-verdict-unavailable'];
      verdictEcho = 'unknown';
    } else {
      knownGaps = Array.isArray(stopVerdict.warnings) ? stopVerdict.warnings.slice() : [];
      verdictEcho = stopVerdict.verdict;
    }

    var sorted = manifestRecords.slice().sort(compareSegments);
    var segments = new Array(sorted.length);
    var r, anchor, statsFor;
    for (i = 0; i < sorted.length; i++) {
      r = sorted[i];
      anchor = (typeof r.clockSegmentId === 'string' && r.clockSegmentId !== '' &&
        Object.prototype.hasOwnProperty.call(anchorsBySegment, r.clockSegmentId)) ?
        anchorsBySegment[r.clockSegmentId] : null;
      statsFor = (chunkStats !== null &&
        Object.prototype.hasOwnProperty.call(chunkStats, r.segmentId)) ?
        chunkStats[r.segmentId] : null;
      segments[i] = buildSyncSegment(r, anchor, streamResults, segmentFiles, statsFor);
    }

    var doc = {
      segments: segments,
      knownGaps: knownGaps,
      stopVerdict: verdictEcho,
      exportedAtUtc: exportedAtUtc
    };
    return JSON.stringify(doc, null, 2);
  }

  BlindfoldSession.buildMediaSyncJson = buildMediaSyncJson;

  // --- 6.4: chunk assembly ---

  // CRC-32 (ISO 3309, the ZIP/STORE checksum), table-driven.
  // Generated once at module load; the table is constant data.
  var CRC32_TABLE = (function () {
    var table = new Array(256);
    var n, k, c;
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  // Incremental CRC-32 state. `state` is the raw (pre-final-XOR)
  // accumulator: starts at 0xFFFFFFFF, final value is
  // (state ^ 0xFFFFFFFF) >>> 0. Updating per chunk keeps JS-heap at
  // O(largest chunk), never O(file).
  function crc32Update(state, bytes) {
    var c = state >>> 0;
    var i;
    for (i = 0; i < bytes.length; i++) {
      c = CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return c >>> 0;
  }

  function crc32Finalize(state) {
    return ((state ^ 0xFFFFFFFF) >>> 0);
  }

  function isBlobLike(v) {
    return v !== null && (typeof v === 'object' || typeof v === 'function') &&
      typeof v.arrayBuffer === 'function' && typeof v.size === 'number';
  }

  function requireValidChunk(chunk, index) {
    var label = 'exporter: chunks[' + index + ']';
    if (!isPlainObject(chunk)) {
      throw new TypeError(label + ' must be a chunk object');
    }
    var ci = chunk.chunkIndex;
    if (typeof ci === 'number') {
      label += ' (chunkIndex ' + ci + ')';
    }
    if (typeof ci !== 'number' || Math.floor(ci) !== ci || ci < 0) {
      throw new TypeError(label + ' has a corrupt chunkIndex (must be a non-negative integer)');
    }
    if (!isBlobLike(chunk.data)) {
      throw new TypeError(label + ' has missing or non-Blob data');
    }
    return ci;
  }

  // 6.4: assemble one segment's stored chunks into the original-format
  // media file, without transcoding.
  //
  // args: { chunks } — media_chunks rows for ONE segment, in
  // [segmentId, chunkIndex] key order (6.6's orchestration reads them
  // via the compound-key range). May be empty.
  //
  // Returns { parts, byteLength, crc32, chunkCount } where parts is
  // one Blob per chunk (in input order), byteLength is the total
  // bytes, crc32 is the incremental CRC-32 of the concatenated bytes,
  // and chunkCount is chunks.length.
  //
  // Byte-concatenation, zero transcoding: the output bytes are exactly
  // the stored chunk payloads. Gaps in chunkIndex are honest (the
  // 4.8 writer reserves indexes synchronously; a failed write leaves a
  // gap) — concatenated as-is, never invented or re-indexed. The
  // function trusts 6.6's key-order guarantee and processes chunks in
  // input order (documented; AC1 pins this).
  //
  // Async only because Blob.arrayBuffer() is asynchronous — this is
  // data access, not architectural I/O. No IndexedDB, no clock, no
  // ID minting. Throws TypeError on malformed input.
  function assembleSegmentChunks(args) {
    if (!isPlainObject(args)) {
      return Promise.reject(new TypeError('exporter: args must be an object'));
    }
    if (!Array.isArray(args.chunks)) {
      return Promise.reject(new TypeError('exporter: chunks must be an array'));
    }
    var chunks = args.chunks;
    var seen = {};
    var i, ci;
    try {
      for (i = 0; i < chunks.length; i++) {
        ci = requireValidChunk(chunks[i], i);
        if (seen[ci]) {
          throw new TypeError('exporter: chunks has a duplicate chunkIndex ' + ci);
        }
        seen[ci] = true;
      }
    } catch (e) {
      return Promise.reject(e);
    }

    var parts = new Array(chunks.length);
    var state = 0xFFFFFFFF;
    var byteLength = 0;
    var p = Promise.resolve();
    chunks.forEach(function (chunk, idx) {
      p = p.then(function () {
        return chunk.data.arrayBuffer();
      }).then(function (ab) {
        var bytes = new Uint8Array(ab);
        state = crc32Update(state, bytes);
        byteLength += bytes.length;
        // Push the ORIGINAL Blob (not a copy): the bytes live in the
        // browser's blob storage; JS-heap holds only the reference.
        // The ArrayBuffer is released after this tick.
        parts[idx] = chunk.data;
      });
    });
    return p.then(function () {
      return {
        parts: parts,
        byteLength: byteLength,
        crc32: crc32Finalize(state),
        chunkCount: chunks.length
      };
    });
  }

  BlindfoldSession.assembleSegmentChunks = assembleSegmentChunks;
  // Exported for 6.6's ZIP writer (streaming data descriptors) and tests.
  BlindfoldSession.EXPORTER_CRC32_TABLE = CRC32_TABLE;

  // --- 6.5: numbered files ---

  // Extension derivation from actualMimeType, mirroring
  // format_support.js's extensionForMimeType (exporter.js stays
  // dependency-free; chunk_writer.js owns the canonical list).
  function extensionForMimeType(mimeType) {
    if (typeof mimeType !== 'string') {
      return null;
    }
    if (mimeType.indexOf('video/webm') === 0 || mimeType.indexOf('audio/webm') === 0) {
      return '.webm';
    }
    if (mimeType.indexOf('video/mp4') === 0) {
      return '.mp4';
    }
    if (mimeType.indexOf('audio/mp4') === 0) {
      return '.m4a';
    }
    return null;
  }

  function requireValidNamingRecords(records) {
    requireValidManifestRecords(records);
    var seenIds = {};
    var i, r;
    for (i = 0; i < records.length; i++) {
      r = records[i];
      var label = 'exporter: manifestRecords[' + i + ']';
      if (typeof r.segmentId !== 'string' || r.segmentId === '') {
        throw new TypeError(label + ' must have a non-empty string segmentId');
      }
      if (seenIds[r.segmentId]) {
        throw new TypeError(label + ' has a duplicate segmentId ' + r.segmentId);
      }
      seenIds[r.segmentId] = true;
      var sn = r.segmentNumber;
      if (sn !== null && sn !== undefined) {
        if (typeof sn !== 'number' || Math.floor(sn) !== sn || sn <= 0) {
          throw new TypeError(label + ' has a corrupt segmentNumber (must be a positive integer or null)');
        }
      }
    }
    return records;
  }

  function resolveSegmentExtension(record) {
    var label = 'exporter: segment ' + record.segmentId;
    var ext = record.fileExtension;
    if (typeof ext === 'string' && ext.charAt(0) === '.') {
      return ext;
    }
    var derived = extensionForMimeType(record.actualMimeType);
    if (derived !== null) {
      return derived;
    }
    throw new TypeError(label + ' has no usable fileExtension or actualMimeType (format unknowable)');
  }

  function padSegmentNumber(n) {
    var s = String(n);
    while (s.length < 3) {
      s = '0' + s;
    }
    return s;
  }

  // 6.5: assign a deterministic export filename to every manifest segment.
  //
  // args: { manifestRecords } — recording_manifest rows for the
  // session (via bySessionId; 6.6's orchestration reads them). May be
  // empty.
  //
  // Returns { files, bySegmentId } where files is
  // [{segmentId, filename, streamKind, segmentNumber}] in 6.3's
  // deterministic order (grouped by kind), segmentNumber is the
  // EFFECTIVE number used in the filename (real or on-the-fly), and
  // bySegmentId maps segmentId → filename (feeds 6.3's segmentFiles
  // input and 6.6's ZIP entry names).
  //
  // Numbering: {streamKind}-{NNN}{ext}, NNN zero-padded to minimum 3
  // digits, per streamKind. Finalized segments use 4.13's
  // segmentNumber verbatim; unfinalized segments (null) get the
  // smallest unused positive integers in sort order. The on-the-fly
  // numbers are export-time labels only — never persisted (readonly
  // rule). Duplicate finalized numbers within a kind are corrupt
  // (4.13 assigns unique 1-based numbers) → TypeError, never a
  // silent filename collision.
  //
  // Pure and synchronous. No I/O, no clock, no ID minting. Throws
  // TypeError on malformed input.
  function nameSegmentFiles(args) {
    if (!isPlainObject(args)) {
      throw new TypeError('exporter: args must be an object');
    }
    var records = requireValidNamingRecords(args.manifestRecords);

    // 6.3's deterministic order (kind → segmentNumber nulls-last →
    // createdAtUtc → segmentId), so filenames and media-sync.json agree.
    var sorted = records.slice().sort(compareSegments);

    var files = [];
    var bySegmentId = {};
    var i, r, kind;
    var currentKind = null;
    var usedNumbers = {};
    for (i = 0; i < sorted.length; i++) {
      r = sorted[i];
      kind = r.streamKind;
      if (kind !== currentKind) {
        currentKind = kind;
        usedNumbers = {};
      }
      var sn = r.segmentNumber;
      var effective;
      if (sn !== null && sn !== undefined) {
        if (usedNumbers[sn]) {
          throw new TypeError('exporter: duplicate segmentNumber ' + sn +
            ' for streamKind ' + kind + ' (segmentId ' + r.segmentId + ')');
        }
        effective = sn;
      } else {
        effective = 1;
        while (usedNumbers[effective]) {
          effective++;
        }
      }
      usedNumbers[effective] = true;
      var filename = kind + '-' + padSegmentNumber(effective) + resolveSegmentExtension(r);
      files.push({
        segmentId: r.segmentId,
        filename: filename,
        streamKind: kind,
        segmentNumber: effective
      });
      bySegmentId[r.segmentId] = filename;
    }
    return { files: files, bySegmentId: bySegmentId };
  }

  BlindfoldSession.nameSegmentFiles = nameSegmentFiles;
})();

// Node test shim. importScripts() consumers use the BlindfoldSession
// global directly; only environments that provide CommonJS get
// module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
