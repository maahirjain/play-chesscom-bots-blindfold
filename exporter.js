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
      undeliveredEvents: undeliveredEvents,
      manualTerminationReason: (typeof stopVerdict.manualTerminationReason === 'string')
        ? stopVerdict.manualTerminationReason
        : null
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

  // --- 6.6: ZIP packaging (STORE method, streaming) ---

  // ZIP signatures (little-endian).
  var ZIP_SIG_LOCAL = 0x04034b50;
  var ZIP_SIG_CENTRAL = 0x02014b50;
  var ZIP_SIG_END = 0x06054b50;
  // Version-needed 2.0 (STORE needs nothing newer); version-made-by 6.3/Unix.
  var ZIP_VERSION_NEEDED = 20;
  var ZIP_VERSION_MADE_BY = 0x0300 | 63;
  // Flag bit 11: filename is UTF-8. Method 0: STORE (no compression).
  var ZIP_FLAG_UTF8 = 0x0800;
  var ZIP_METHOD_STORE = 0;

  function utf8Bytes(str) {
    // TextEncoder is available in SW, content, and Node 18+.
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(str);
    }
    // Fallback: manual UTF-8 encoding (ASCII-superset safe).
    var out = [];
    var i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return new Uint8Array(out);
  }

  function writeU16LE(view, offset, value) {
    view.setUint16(offset, value >>> 0, true);
  }

  function writeU32LE(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }

  // MSDOS date/time from an ISO-8601 UTC string. Returns
  // {dosDate, dosTime}. Unparseable input → the MSDOS epoch
  // (1980-01-01 00:00:00); never the wall clock silently (contract §2.5).
  function dosDateTimeFromIso(isoString) {
    var ms = Date.parse(isoString);
    var d;
    if (typeof isoString !== 'string' || isNaN(ms)) {
      d = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));
    } else {
      d = new Date(ms);
    }
    var year = d.getUTCFullYear();
    // Clamp to the DOS-representable range (1980–2107).
    if (year < 1980) { year = 1980; }
    if (year > 2107) { year = 2107; }
    var dosDate = ((year - 1980) << 9) |
      ((d.getUTCMonth() + 1) << 5) |
      d.getUTCDate();
    var dosTime = (d.getUTCHours() << 11) |
      (d.getUTCMinutes() << 5) |
      Math.floor(d.getUTCSeconds() / 2);
    return { dosDate: dosDate >>> 0, dosTime: dosTime >>> 0 };
  }

  // Sanitize a session category for ZIP-path safety. The 5.2 categories
  // are short controlled strings; anything outside [A-Za-z0-9_-] is a
  // corrupt category → TypeError (fail-closed; must not produce a
  // corrupt path or escape the directory).
  function sanitizeCategoryForPath(category) {
    if (typeof category !== 'string' || category === '' ||
        !/^[A-Za-z0-9_-]+$/.test(category)) {
      throw new TypeError(
        'exporter: sessionCategory is not ZIP-path-safe: ' +
        JSON.stringify(category));
    }
    return category;
  }

  // Validate a ZIP-internal path: non-empty, forward slashes only, no
  // leading slash, no '..' segments. Violation → TypeError naming it.
  function requireValidZipPath(path) {
    if (typeof path !== 'string' || path === '') {
      throw new TypeError('exporter: ZIP path must be a non-empty string');
    }
    if (path.charAt(0) === '/' || path.indexOf('\\') !== -1 ||
        /(^|\/)\.\.(\/|$)/.test(path)) {
      throw new TypeError('exporter: invalid ZIP path: ' + JSON.stringify(path));
    }
    return path;
  }

  // 6.6: build the bundle directory per PLAN §6.6 "category/date/game-ID
  // path". Single-game: <category>/<YYYY-MM-DD>_<gameId>/; multi-game:
  // <category>/<YYYY-MM-DD>_session-<sessionId>/ (Flow rule — media once).
  //
  // args: {sessionCategory, dateIso, gameIds, sessionId} where dateIso
  // is the session-start ISO string (the orchestration resolves it from
  // the earliest manifest createdAtUtc, or the MSDOS epoch when none
  // exists — the 1.1 metadata record carries no timestamp).
  function buildBundleDir(args) {
    if (!isPlainObject(args)) {
      throw new TypeError('exporter: args must be an object');
    }
    var category = sanitizeCategoryForPath(args.sessionCategory);
    if (typeof args.dateIso !== 'string' || isNaN(Date.parse(args.dateIso))) {
      throw new TypeError('exporter: dateIso must be a valid ISO-8601 string');
    }
    if (!isUuidV4(args.sessionId)) {
      throw new TypeError('exporter: sessionId must be a uuid-v4 string');
    }
    if (!Array.isArray(args.gameIds) || args.gameIds.length === 0 ||
        !args.gameIds.every(isUuidV4)) {
      throw new TypeError('exporter: gameIds must be a non-empty array of uuid-v4 strings');
    }
    var datePart = args.dateIso.slice(0, 10); // YYYY-MM-DD (UTC)
    var idPart = args.gameIds.length === 1 ?
      args.gameIds[0] : 'session-' + args.sessionId;
    return category + '/' + datePart + '_' + idPart + '/';
  }

  // 6.6: the download filename (outside the ZIP):
  // <category>-<YYYY-MM-DD>-<shortId>.zip where shortId is the first 8
  // hex chars of the gameId (single) or sessionId (multi).
  function buildDownloadFilename(args) {
    if (!isPlainObject(args)) {
      throw new TypeError('exporter: args must be an object');
    }
    var category = sanitizeCategoryForPath(args.sessionCategory);
    if (typeof args.dateIso !== 'string' || isNaN(Date.parse(args.dateIso))) {
      throw new TypeError('exporter: dateIso must be a valid ISO-8601 string');
    }
    if (!isUuidV4(args.sessionId)) {
      throw new TypeError('exporter: sessionId must be a uuid-v4 string');
    }
    if (!Array.isArray(args.gameIds) || args.gameIds.length === 0 ||
        !args.gameIds.every(isUuidV4)) {
      throw new TypeError('exporter: gameIds must be a non-empty array of uuid-v4 strings');
    }
    var datePart = args.dateIso.slice(0, 10);
    var shortId = (args.gameIds.length === 1 ?
      args.gameIds[0] : args.sessionId).slice(0, 8);
    return category + '-' + datePart + '-' + shortId + '.zip';
  }

  // 6.6: hand-rolled STORE-method ZIP writer. Pure and synchronous
  // (Blob construction is sync).
  //
  // args: {files: [{path, dataParts, byteLength, crc32}], dosDateTime}
  // where each file has the ZIP-internal path, an array of Blobs (media:
  // 6.4's chunk Blobs; JSON: single-element [new Blob([string])]),
  // and the precomputed byteLength/crc32. dosDateTime is
  // {dosDate, dosTime} from dosDateTimeFromIso (one timestamp for the
  // whole bundle — the session start).
  //
  // Returns {parts, byteLength, fileCount} where parts is the ordered
  // Blob array for new Blob(parts, {type:'application/zip'}).
  //
  // No data descriptors (flag bit 3 NOT set): all sizes/CRCs are known
  // upfront, keeping the writer simple and maximally compatible.
  function buildZipParts(args) {
    if (!isPlainObject(args)) {
      throw new TypeError('exporter: args must be an object');
    }
    if (!Array.isArray(args.files) || args.files.length === 0) {
      throw new TypeError('exporter: files must be a non-empty array');
    }
    var dos = args.dosDateTime;
    if (!isPlainObject(dos) || typeof dos.dosDate !== 'number' ||
        typeof dos.dosTime !== 'number') {
      throw new TypeError('exporter: dosDateTime must be {dosDate, dosTime}');
    }

    var files = args.files;
    var i, f, pathBytes;
    // Validate all files upfront (fail-closed before emitting anything).
    for (i = 0; i < files.length; i++) {
      f = files[i];
      if (!isPlainObject(f)) {
        throw new TypeError('exporter: files[' + i + '] must be an object');
      }
      requireValidZipPath(f.path);
      if (!Array.isArray(f.dataParts) || f.dataParts.length === 0) {
        throw new TypeError('exporter: files[' + i + '].dataParts must be a non-empty Blob array');
      }
      var j;
      for (j = 0; j < f.dataParts.length; j++) {
        if (!isBlobLike(f.dataParts[j])) {
          throw new TypeError('exporter: files[' + i + '].dataParts[' + j + '] must be a Blob');
        }
      }
      if (typeof f.byteLength !== 'number' || Math.floor(f.byteLength) !== f.byteLength ||
          f.byteLength < 0) {
        throw new TypeError('exporter: files[' + i + '].byteLength must be a non-negative integer');
      }
      if (typeof f.crc32 !== 'number' || Math.floor(f.crc32) !== f.crc32 ||
          f.crc32 < 0 || f.crc32 > 0xFFFFFFFF) {
        throw new TypeError('exporter: files[' + i + '].crc32 must be a uint32');
      }
    }

    var parts = [];
    var centralEntries = [];
    var offset = 0;
    var totalDataBytes = 0;

    for (i = 0; i < files.length; i++) {
      f = files[i];
      pathBytes = utf8Bytes(f.path);

      // Local file header: 30 bytes fixed + path.
      var lh = new Uint8Array(30 + pathBytes.length);
      var lv = new DataView(lh.buffer);
      writeU32LE(lv, 0, ZIP_SIG_LOCAL);
      writeU16LE(lv, 4, ZIP_VERSION_NEEDED);
      writeU16LE(lv, 6, ZIP_FLAG_UTF8);
      writeU16LE(lv, 8, ZIP_METHOD_STORE);
      writeU16LE(lv, 10, dos.dosTime);
      writeU16LE(lv, 12, dos.dosDate);
      writeU32LE(lv, 14, f.crc32);
      writeU32LE(lv, 18, f.byteLength);
      writeU32LE(lv, 22, f.byteLength);
      writeU16LE(lv, 26, pathBytes.length);
      writeU16LE(lv, 28, 0); // extra length
      lh.set(pathBytes, 30);
      var lhBlob = new Blob([lh]);

      parts.push(lhBlob);
      var dataOffset = offset + lhBlob.size;
      var k;
      for (k = 0; k < f.dataParts.length; k++) {
        parts.push(f.dataParts[k]);
      }
      centralEntries.push({
        pathBytes: pathBytes,
        crc32: f.crc32,
        byteLength: f.byteLength,
        localOffset: offset
      });
      offset = dataOffset + f.byteLength;
      totalDataBytes += f.byteLength;
    }

    // Central directory.
    var centralStart = offset;
    var centralParts = [];
    var centralSize = 0;
    for (i = 0; i < centralEntries.length; i++) {
      var e = centralEntries[i];
      var ch = new Uint8Array(46 + e.pathBytes.length);
      var cv = new DataView(ch.buffer);
      writeU32LE(cv, 0, ZIP_SIG_CENTRAL);
      writeU16LE(cv, 4, ZIP_VERSION_MADE_BY);
      writeU16LE(cv, 6, ZIP_VERSION_NEEDED);
      writeU16LE(cv, 8, ZIP_FLAG_UTF8);
      writeU16LE(cv, 10, ZIP_METHOD_STORE);
      writeU16LE(cv, 12, dos.dosTime);
      writeU16LE(cv, 14, dos.dosDate);
      writeU32LE(cv, 16, e.crc32);
      writeU32LE(cv, 20, e.byteLength);
      writeU32LE(cv, 24, e.byteLength);
      writeU16LE(cv, 28, e.pathBytes.length);
      writeU16LE(cv, 30, 0); // extra length
      writeU16LE(cv, 32, 0); // comment length
      writeU16LE(cv, 34, 0); // disk number start
      writeU16LE(cv, 36, 0); // internal attributes
      writeU32LE(cv, 38, 0); // external attributes
      writeU32LE(cv, 42, e.localOffset);
      ch.set(e.pathBytes, 46);
      var chBlob = new Blob([ch]);
      centralParts.push(chBlob);
      centralSize += chBlob.size;
    }
    for (i = 0; i < centralParts.length; i++) {
      parts.push(centralParts[i]);
    }
    offset = centralStart + centralSize;

    // End of central directory: 22 bytes.
    var er = new Uint8Array(22);
    var ev = new DataView(er.buffer);
    writeU32LE(ev, 0, ZIP_SIG_END);
    writeU16LE(ev, 4, 0); // disk number
    writeU16LE(ev, 6, 0); // central dir start disk
    writeU16LE(ev, 8, centralEntries.length);
    writeU16LE(ev, 10, centralEntries.length);
    writeU32LE(ev, 12, centralSize);
    writeU32LE(ev, 16, centralStart);
    writeU16LE(ev, 20, 0); // comment length
    parts.push(new Blob([er]));

    return {
      parts: parts,
      byteLength: offset + 22,
      fileCount: files.length
    };
  }

  BlindfoldSession.buildZipParts = buildZipParts;
  BlindfoldSession.buildBundleDir = buildBundleDir;
  BlindfoldSession.buildDownloadFilename = buildDownloadFilename;
  BlindfoldSession.dosDateTimeFromIso = dosDateTimeFromIso;

  // --- 6.6: export orchestration ---

  // Store names (mirroring db.js; the orchestration reads via deps.db).
  var EXPORT_EVENTS_STORE = 'events';
  var EXPORT_CHUNKS_STORE = 'media_chunks';
  var EXPORT_MANIFEST_STORE = 'recording_manifest';
  var EXPORT_METADATA_STORE = 'session_metadata';
  var EXPORT_CONDITIONS_STORE = 'conditions';
  var EXPORT_BY_SESSION_INDEX = 'bySessionId';

  // The MSDOS epoch ISO string — the honest fallback when no session
  // start time is available (the 1.1 metadata record carries no
  // timestamp; contract §2.5).
  var MSDOS_EPOCH_ISO = '1980-01-01T00:00:00.000Z';

  function requireDeps(deps) {
    if (!isPlainObject(deps)) {
      throw new TypeError('exporter: deps must be an object');
    }
    if (!isPlainObject(deps.db) || typeof deps.db.get !== 'function' ||
        typeof deps.db.getAll !== 'function') {
      throw new TypeError('exporter: deps.db must have get/getAll functions');
    }
    // downloads/createObjectURL/revokeObjectURL are optional in deps:
    // absent → 'downloads-unavailable' at download time (not a throw).
    return deps;
  }

  // Extract clock_anchor payloads from the event stream (6.3's contract:
  // 6.6 extracts these, following 6.1's gameStartingFens precedent).
  function extractClockAnchors(events) {
    var out = [];
    var i, e, p;
    for (i = 0; i < events.length; i++) {
      e = events[i];
      if (!isPlainObject(e) || e.eventType !== 'clock_anchor') {
        continue;
      }
      p = e.payload;
      if (isPlainObject(p) && typeof p.segmentId === 'string' &&
          typeof p.utcEpochMs === 'number' && typeof p.monotonicMs === 'number') {
        out.push({
          segmentId: p.segmentId,
          utcEpochMs: p.utcEpochMs,
          monotonicMs: p.monotonicMs
        });
      }
    }
    return out;
  }

  // Extract gameId → fen from game_started events (6.1's contract,
  // game_records.js denormalization rule).
  function extractGameStartingFens(events) {
    var out = {};
    var i, e, p;
    for (i = 0; i < events.length; i++) {
      e = events[i];
      if (!isPlainObject(e) || e.eventType !== 'game_started') {
        continue;
      }
      if (typeof e.gameId === 'string' && e.gameId !== '') {
        p = e.payload;
        var fen = (isPlainObject(p) &&
          (typeof p.fen === 'string' || p.fen === null)) ? p.fen : null;
        // First game_started per gameId wins (the session's actual start).
        if (!Object.prototype.hasOwnProperty.call(out, e.gameId)) {
          out[e.gameId] = fen;
        }
      }
    }
    return out;
  }

  // Resolve the session-start ISO for the bundle directory and DOS
  // timestamps: the earliest usable manifest createdAtUtc. The 1.1
  // metadata record carries no timestamp, so this is the honest
  // stored-data proxy. None usable → MSDOS epoch (contract §2.5).
  function resolveSessionStartIso(manifestRecords) {
    var earliest = null;
    var i, r, ms;
    for (i = 0; i < manifestRecords.length; i++) {
      r = manifestRecords[i];
      if (!isPlainObject(r) || typeof r.createdAtUtc !== 'string') {
        continue;
      }
      ms = Date.parse(r.createdAtUtc);
      if (isNaN(ms)) {
        continue;
      }
      if (earliest === null || ms < Date.parse(earliest)) {
        earliest = r.createdAtUtc;
      }
    }
    return earliest !== null ? earliest : MSDOS_EPOCH_ISO;
  }

  // 6.6: SW-side export orchestration. Reads the session's stores
  // (readonly), builds the bundle via 6.1–6.5, packages the ZIP, and
  // triggers the download.
  //
  // args: {sessionId, stopVerdict, deps} where deps is
  // {db, downloads?, createObjectURL?, revokeObjectURL?, nowUtcIso?}.
  //
  // Returns {ok:true, filename, bytes, fileCount} |
  //          {ok:false, error} (never throws except TypeError on
  // malformed sessionId/deps).
  function exportSession(args) {
    if (!isPlainObject(args)) {
      return Promise.reject(new TypeError('exporter: args must be an object'));
    }
    if (!isUuidV4(args.sessionId)) {
      return Promise.reject(new TypeError('exporter: sessionId must be a uuid-v4 string'));
    }
    var deps;
    try {
      deps = requireDeps(args.deps);
    } catch (e) {
      return Promise.reject(e);
    }
    var stopVerdict;
    try {
      stopVerdict = requireValidStopVerdict(
        args.stopVerdict === undefined ? null : args.stopVerdict);
    } catch (e) {
      return Promise.reject(e);
    }
    var sessionId = args.sessionId;
    var db = deps.db;
    var nowUtcIso = typeof deps.nowUtcIso === 'function' ?
      deps.nowUtcIso : defaultNowUtcIso;

    function fail(error) {
      return { ok: false, error: error };
    }

    // Step 2: snapshot counts (readonly proof). media_chunks is counted
    // via the session's segmentIds (no bySessionId index on the
    // compound-key store).
    var before;
    return db.getAll(EXPORT_EVENTS_STORE,
      { index: EXPORT_BY_SESSION_INDEX, lower: sessionId, upper: sessionId })
      .then(function (events) {
        return db.getAll(EXPORT_MANIFEST_STORE,
          { index: EXPORT_BY_SESSION_INDEX, lower: sessionId, upper: sessionId })
          .then(function (manifest) {
            before = { events: events.length, manifest: manifest.length, chunks: 0 };
            return { events: events, manifest: manifest };
          });
      })
      .then(function (read) {
        var events = read.events;
        var manifestRecords = read.manifest;
        // Step 3: session metadata.
        return db.get(EXPORT_METADATA_STORE, sessionId).then(function (metadata) {
          if (metadata === undefined || metadata === null) {
            return fail('session-not-found');
          }
          // Step 4: conditions (absent → null; 6.1 handles honestly).
          return db.get(EXPORT_CONDITIONS_STORE, sessionId).then(function (conditions) {
            return {
              metadata: metadata,
              conditions: (conditions === undefined) ? null : conditions,
              events: events,
              manifestRecords: manifestRecords
            };
          });
        });
      })
      .then(function (ctx) {
        if (ctx.ok === false) { return ctx; } // session-not-found
        // Steps 6–7: extract anchors and FENs from the event stream.
        var clockAnchors = extractClockAnchors(ctx.events);
        var gameStartingFens = extractGameStartingFens(ctx.events);
        // Step 8: name the segment files (6.5). Throws TypeError on
        // corrupt manifest → mapped to corrupt-record below.
        var naming;
        try {
          naming = nameSegmentFiles({ manifestRecords: ctx.manifestRecords });
        } catch (e) {
          return fail('corrupt-recording_manifest-record:' + e.message);
        }
        ctx.clockAnchors = clockAnchors;
        ctx.gameStartingFens = gameStartingFens;
        ctx.naming = naming;
        return ctx;
      })
      .then(function (ctx) {
        if (ctx.ok === false) { return ctx; }
        // Step 9: per segment (6.5's files order = 6.3's deterministic
        // order), read chunks via the 4.13 compound-key-range precedent
        // and assemble (6.4). Accumulate chunkStats for 6.3.
        var chunkStats = {};
        var segmentBlobs = {}; // segmentId → {parts, byteLength, crc32}
        var chain = Promise.resolve();
        var countChunks = 0;
        ctx.naming.files.forEach(function (nf) {
          chain = chain.then(function () {
            return db.getAll(EXPORT_CHUNKS_STORE, {
              lower: [nf.segmentId, -1],
              upper: [nf.segmentId, Number.MAX_SAFE_INTEGER]
            });
          }).then(function (chunks) {
            countChunks += chunks.length;
            return assembleSegmentChunks({ chunks: chunks }).then(function (asm) {
              segmentBlobs[nf.segmentId] = asm;
              // chunksAfterFinalize: chunks whose createdAtUtc is after
              // the manifest record's finalizedAtUtc (append-only store;
              // §6 reads the store, not the finalize tally).
              var manifestRec = null;
              var i;
              for (i = 0; i < ctx.manifestRecords.length; i++) {
                if (ctx.manifestRecords[i] &&
                    ctx.manifestRecords[i].segmentId === nf.segmentId) {
                  manifestRec = ctx.manifestRecords[i];
                  break;
                }
              }
              var finalizedMs = (manifestRec !== null &&
                typeof manifestRec.finalizedAtUtc === 'string') ?
                Date.parse(manifestRec.finalizedAtUtc) : NaN;
              var after = 0;
              if (!isNaN(finalizedMs)) {
                for (i = 0; i < chunks.length; i++) {
                  var c = chunks[i];
                  if (isPlainObject(c) && typeof c.createdAtUtc === 'string') {
                    var cms = Date.parse(c.createdAtUtc);
                    if (!isNaN(cms) && cms > finalizedMs) { after++; }
                  }
                }
              }
              chunkStats[nf.segmentId] = {
                chunkCount: asm.chunkCount,
                chunksAfterFinalize: after
              };
            }, function (e) {
              // 6.4's TypeError → honest corrupt-record error.
              throw { exportError: 'corrupt-media_chunks-record:' + e.message };
            });
          });
        });
        return chain.then(function () {
          before.chunks = countChunks;
          ctx.chunkStats = chunkStats;
          ctx.segmentBlobs = segmentBlobs;
          return ctx;
        }, function (e) {
          if (e && e.exportError) { return fail(e.exportError); }
          throw e;
        });
      })
      .then(function (ctx) {
        if (ctx.ok === false) { return ctx; }
        // Steps 10–11: build the three JSON files and the paths.
        var jsonFiles;
        try {
          var metadataJson = buildMetadataJson({
            metadata: ctx.metadata,
            conditions: ctx.conditions,
            manifestRecords: ctx.manifestRecords,
            stopVerdict: stopVerdict,
            eventCount: ctx.events.length,
            gameStartingFens: ctx.gameStartingFens,
            nowUtcIso: nowUtcIso
          });
          var eventsJsonl = buildEventsJsonl({ events: ctx.events });
          var segmentFiles = ctx.naming.bySegmentId;
          var mediaSyncJson = buildMediaSyncJson({
            manifestRecords: ctx.manifestRecords,
            clockAnchors: ctx.clockAnchors,
            stopVerdict: stopVerdict,
            segmentFiles: segmentFiles,
            chunkStats: ctx.chunkStats,
            nowUtcIso: nowUtcIso
          });
          var dateIso = resolveSessionStartIso(ctx.manifestRecords);
          var dirArgs = {
            sessionCategory: ctx.metadata.sessionCategory,
            dateIso: dateIso,
            gameIds: ctx.metadata.gameIds,
            sessionId: ctx.metadata.sessionId
          };
          var dir = buildBundleDir(dirArgs);
          var downloadFilename = buildDownloadFilename(dirArgs);
          var dosDateTime = dosDateTimeFromIso(dateIso);
          jsonFiles = [
            { name: 'metadata.json', text: metadataJson },
            { name: 'events.jsonl', text: eventsJsonl },
            { name: 'media-sync.json', text: mediaSyncJson }
          ];
          ctx.dir = dir;
          ctx.downloadFilename = downloadFilename;
          ctx.dosDateTime = dosDateTime;
          ctx.jsonFiles = jsonFiles;
        } catch (e) {
          // 6.1/6.2/6.3/6.5 builders throw TypeError on corrupt input;
          // 'failed' verdict → plain Error → session-not-complete
          // (reviewer N1 from 6.1).
          if (e instanceof Error && !(e instanceof TypeError) &&
              /session-not-complete/.test(e.message)) {
            return fail('session-not-complete');
          }
          return fail('corrupt-record:' + e.message);
        }
        return ctx;
      })
      .then(function (ctx) {
        if (ctx.ok === false) { return ctx; }
        // Step 12: assemble the ZIP parts (JSON first, then media in
        // 6.5's files order).
        var zipFiles = [];
        var i;
        try {
          for (i = 0; i < ctx.jsonFiles.length; i++) {
            var jf = ctx.jsonFiles[i];
            var jbytes = utf8Bytes(jf.text);
            var state = 0xFFFFFFFF;
            state = crc32Update(state, jbytes);
            zipFiles.push({
              path: ctx.dir + jf.name,
              dataParts: [new Blob([jbytes])],
              byteLength: jbytes.length,
              crc32: crc32Finalize(state)
            });
          }
          for (i = 0; i < ctx.naming.files.length; i++) {
            var nf = ctx.naming.files[i];
            var asm = ctx.segmentBlobs[nf.segmentId];
            zipFiles.push({
              path: ctx.dir + nf.filename,
              dataParts: asm.parts,
              byteLength: asm.byteLength,
              crc32: asm.crc32
            });
          }
          var zip = buildZipParts({ files: zipFiles, dosDateTime: ctx.dosDateTime });
          ctx.zip = zip;
        } catch (e) {
          return fail('corrupt-record:' + e.message);
        }
        return ctx;
      })
      .then(function (ctx) {
        if (ctx.ok === false) { return ctx; }
        // Step 13: re-count stores (the after-proof). Mismatch → honest
        // error, NO download (never deliver a possibly-inconsistent bundle).
        return db.getAll(EXPORT_EVENTS_STORE,
          { index: EXPORT_BY_SESSION_INDEX, lower: sessionId, upper: sessionId })
          .then(function (events) {
            return db.getAll(EXPORT_MANIFEST_STORE,
              { index: EXPORT_BY_SESSION_INDEX, lower: sessionId, upper: sessionId })
              .then(function (manifest) {
                if (events.length !== before.events || manifest.length !== before.manifest) {
                  return fail('store-changed-during-export');
                }
                // Chunk count: recount via the same per-segment reads.
                // (A chunk-count change without a manifest change is
                // still a change — recount cheaply.)
                var recount = Promise.resolve(0);
                ctx.naming.files.forEach(function (nf) {
                  recount = recount.then(function (n) {
                    return db.getAll(EXPORT_CHUNKS_STORE, {
                      lower: [nf.segmentId, -1],
                      upper: [nf.segmentId, Number.MAX_SAFE_INTEGER]
                    }).then(function (chunks) { return n + chunks.length; });
                  });
                });
                return recount.then(function (chunkCount) {
                  if (chunkCount !== before.chunks) {
                    return fail('store-changed-during-export');
                  }
                  return ctx;
                });
              });
          });
      })
      .then(function (ctx) {
        if (ctx.ok === false) { return ctx; }
        // Steps 14–16: download. downloads/createObjectURL absent →
        // 'downloads-unavailable' (not a throw — expected on some surfaces).
        if (!deps.downloads || typeof deps.downloads.download !== 'function' ||
            typeof deps.createObjectURL !== 'function') {
          return fail('downloads-unavailable');
        }
        var blob;
        try {
          blob = new Blob(ctx.zip.parts, { type: 'application/zip' });
        } catch (e) {
          return fail('download-failed:blob-construction:' + e.message);
        }
        var url;
        try {
          url = deps.createObjectURL(blob);
        } catch (e) {
          return fail('download-failed:object-url:' + e.message);
        }
        var done = function (result) {
          try {
            if (typeof deps.revokeObjectURL === 'function') {
              deps.revokeObjectURL(url);
            }
          } catch (e) { /* revoke is best-effort */ }
          return result;
        };
        var downloadResult;
        try {
          downloadResult = deps.downloads.download({
            url: url,
            filename: ctx.downloadFilename,
            saveAs: false
          });
        } catch (e) {
          return done(fail('download-failed:' + e.message));
        }
        return Promise.resolve(downloadResult).then(function () {
          return done({
            ok: true,
            filename: ctx.downloadFilename,
            bytes: ctx.zip.byteLength,
            fileCount: ctx.zip.fileCount
          });
        }, function (e) {
          return done(fail('download-failed:' + (e && e.message ? e.message : e)));
        });
      })
      .catch(function (e) {
        // Unmapped DB/IDB errors → honest failure (stores untouched).
        if (e && e.exportError) { return fail(e.exportError); }
        return fail('export-failed:' + (e && e.message ? e.message : String(e)));
      });
  }

  BlindfoldSession.exportSession = exportSession;
})();

// Node test shim. importScripts() consumers use the BlindfoldSession
// global directly; only environments that provide CommonJS get
// module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
