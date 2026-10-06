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
})();

// Node test shim. importScripts() consumers use the BlindfoldSession
// global directly; only environments that provide CommonJS get
// module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
