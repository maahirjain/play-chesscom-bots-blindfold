// game_records.js
//
// Task 1.4 (PLAN.md §1.4.1–§1.4.5): game reconstruction record shapes.
//
// Dependency-free plain script. Loads as a content-script global, via
// importScripts() in a future MV3 service worker, or under Node via the
// module.exports shim at the end. Platform-independent by design: no
// browser-extension APIs, no DOM, no storage, no chess engine — factories,
// validators, and constants only.
//
// This task defines record SHAPES, not behavior. It does not observe the
// DOM (§3.1), detect game starts/ends (§3.5), assemble envelopes
// (§3.x emitters own that via 1.3's createEvent), store anything (§2),
// export anything (§6), or reconstruct games (no stream-fold helper —
// PLAN §1 explicitly excludes a reconstruction-test interface; the
// revision semantics below are declarative only, pinned for §7.2/§7.4).
//
// Design decisions (from .autodev/evidence/1.4.contract.md §2):
//
// - Starting FEN lives in the game_started event payload ({fen}), not on
//   the 1.1 game identity (deliberately a bare UUID). §6.1's export
//   denormalizes it into metadata.json's "game starting FEN"; CONFLICT
//   RULE: if metadata.json's FEN ever disagrees with the game_started
//   event, the event wins — events.jsonl is the raw store.
// - Timestamps live on the 1.3 envelope (clockSegmentId, monotonicMs).
//   Payloads carry NO time fields: duplicating time would create a
//   two-clocks-disagree hazard and violate "no duplicated persisted data".
// - FEN validation is STRUCTURAL ONLY — never a legality check. A
//   structurally valid but chess-impossible position from Chess.com is
//   still the observed evidence; rejecting it would destroy data
//   ("preserve original observations"). Validation is caller-error
//   detection (malformed input throws), not data cleaning: real observed
//   FENs come from the internal chess.js board's canonical fen() (§3.1).
// - No move numbers, no SAN, no per-move FEN, no durations: all derivable
//   from event order + chess.js replay (§7.2 groundwork; test-only oracle
//   proves it — chess.js is NOT a runtime dependency of this module).
// - Move encoding: confirmed moves are exactly {from, to, promotion}.
//   Castling is the king's from/to (e1→g1); en passant the pawn's
//   from/to (e5→d6); promotion is lowercase q/r/b/n or explicit null.
//   A promotion whose piece is unobservable is NOT a confirmed move:
//   the emitter (§3.1) must treat it as a synchronization failure
//   (3.1.7), never as move_confirmed with a guessed or null promotion.
// - Recovery/revision: marker-first, uniform move stream. Recovered and
//   replacement moves are ordinary move_confirmed events; the
//   history_recovered / history_revised marker events are emitted FIRST
//   (sourceSeq k, batch moves at k+1…k+N) and batch moves link back via
//   1.3 refs ({recoveryEventId} / {revisionEventId}). The original stream
//   is never rewritten or deleted. marker-first (not marker-last) lets
//   forward-scan consumers meet the explanation before the data it
//   explains, and expectedMoveCount — not derivable after an interrupted
//   batch — lets consumers detect truncation.
// - 1.4 defines exactly two refs roles (1.3 AC20 inventory):
//   'recoveryEventId' and 'revisionEventId'. No other roles invented here.
// - Revision fold semantics (declarative, no code): current move list =
//   confirmed moves in occurrence order, minus any eventId named in any
//   history_revised.retractedMoveEventIds, plus replacement moves in
//   their occurrence order. Retraction is monotonic: a retracted event
//   ID is never un-retracted. Contract-layer validation is shape-only;
//   the suffix rule (retracted IDs must be a suffix of the confirmed
//   move sequence from the first changed ply) is §3.1's to enforce.
// - POSITION CHECKPOINT — STRICT GATE (data-quality flag, not a routine
//   mechanism; emission is §3.1's job, nothing in this task emits one):
//   1. A synchronization failure was observed AND recorded (3.1.7) — a
//      checkpoint without a recorded sync failure is a defect, not a
//      recovery.
//   2. The gap is genuinely unbridgeable: replaying the observed history
//      from the game_started FEN AND from the last checkpoint both fail
//      to reconcile — a checkpoint must never paper over a bridgeable gap.
//   3. The emitter can state a current-position FEN (best-effort
//      observed or manual); it never invents one.
//   Consequence: any export containing a position_checkpoint with
//   reason 'unreconciled_history' MUST surface it in §6.1's collection
//   coverage/completeness as a defect flag. Frequent checkpoints indicate
//   an instrumentation bug (escalate per the 3-repair rule), not normal
//   operation.
// - All six event types are game-scoped: emitters must attach a non-null
//   gameId (1.3 permits null gameId only for session-scoped events; these
//   six are never session-scoped).
// - game_ended: the PGN result vocabulary (incl. '*' = unknown); the 9
//   grounded termination reasons or null (null = unknown, 1.2's unknown
//   convention); observedText is raw evidence (exact string Chess.com
//   displayed, or null) — never stretched taxonomy. Multiple game_ended
//   events per game are permitted (observed auto-detection + later manual
//   Stop completion); consumers take the latest by occurrence time.
//   Recording does not stop at game end (§5.7).
//
// Error conventions (mirror 1.1/1.2/1.3):
// - TypeError  = wrong type/shape, including non-string FENs, malformed
//   UUID strings, non-array retractedMoveEventIds, undefined promotion,
//   missing required keys, extra payload keys.
// - RangeError = value outside the allowed domain: structurally invalid
//   FEN fields, bad squares, from === to, bad vocabulary values,
//   negative/non-integer counts, duplicate retracted IDs.
// - plain Error = unavailable platform capability. None is needed in this
//   task (no ID generation, no randomness); kept as the convention only.
//
// Load-order independence: UUID v4 checking is a private internal
// function (1.3 §2.10 precedent). This module reads no other module's
// exports at load time — including BlindfoldSession.isEventType, which
// tests use at test time only.

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Event-type constants. Each task owns its vocabulary (1.3 §2.2).
  // ------------------------------------------------------------------

  var GAME_STARTED_EVENT_TYPE = 'game_started';
  var MOVE_CONFIRMED_EVENT_TYPE = 'move_confirmed';
  var HISTORY_RECOVERED_EVENT_TYPE = 'history_recovered';
  var HISTORY_REVISED_EVENT_TYPE = 'history_revised';
  var POSITION_CHECKPOINT_EVENT_TYPE = 'position_checkpoint';
  var GAME_ENDED_EVENT_TYPE = 'game_ended';

  // ------------------------------------------------------------------
  // Closed vocabularies (all frozen).
  // ------------------------------------------------------------------

  var RECOVERY_REASONS = Object.freeze(['page_reload', 'late_attachment']);
  var REVISION_KINDS = Object.freeze(['takeback', 'correction']);
  var CHECKPOINT_REASONS = Object.freeze(['unreconciled_history']);
  var GAME_RESULTS = Object.freeze(['1-0', '0-1', '1/2-1/2', '*']);
  var TERMINATION_REASONS = Object.freeze([
    'checkmate',
    'stalemate',
    'resignation',
    'timeout',
    'draw_agreed',
    'draw_insufficient_material',
    'draw_fifty_move',
    'draw_threefold',
    'abandoned'
  ]);
  var EVIDENCE_SOURCES = Object.freeze(['observed', 'manual']);
  // Local copy of the 1.2 provenance convention (deliberate duplication
  // over load-order coupling, 1.3 §2.10 precedent).
  var FEN_SOURCES = Object.freeze(['observed', 'manual']);
  var PROMOTION_PIECES = Object.freeze(['q', 'r', 'b', 'n']);

  // ------------------------------------------------------------------
  // Private helpers.
  // ------------------------------------------------------------------

  // Private UUID v4 check — deliberately not shared with
  // session_identity.js so neither module depends on the other's load order.
  var UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  var SQUARE_RE = /^[a-h][1-8]$/;
  var FEN_RANK_CHARS_RE = /^[pnbrqkPNBRQK1-8]+$/;
  var FEN_CASTLING_RE = /^(KQ?k?q?|Qk?q?|kq?|q|-)$/;
  var FEN_EP_SQUARE_RE = /^[a-h][36]$/;
  var NON_NEGATIVE_INTEGER_RE = /^\d+$/;

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function requireObject(v, name) {
    if (!isPlainObject(v)) {
      throw new TypeError(name + ' must be an object');
    }
  }

  function requireExactKeys(obj, keys, name) {
    var actual = Object.keys(obj);
    if (actual.length !== keys.length) {
      throw new TypeError(
        name + ' must have exactly ' + keys.length + ' keys, got ' + actual.length
      );
    }
    for (var i = 0; i < keys.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(obj, keys[i])) {
        throw new TypeError(name + ' is missing required key: ' + keys[i]);
      }
    }
  }

  function requireNonNegativeInteger(value, name) {
    if (typeof value !== 'number') {
      throw new TypeError(name + ' must be a number');
    }
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(name + ' must be an integer >= 0');
    }
  }

  function requireVocabulary(value, vocabulary, name) {
    if (typeof value !== 'string') {
      throw new TypeError(name + ' must be a string');
    }
    if (vocabulary.indexOf(value) === -1) {
      throw new RangeError(
        name + " must be one of: '" + vocabulary.join("', '") + "'"
      );
    }
  }

  function requireUuidV4(value, name) {
    // Malformed ID (including a non-string) is a caller shape error —
    // mirrors 1.1/1.3's convention.
    if (typeof value !== 'string' || !UUID_V4_RE.test(value)) {
      throw new TypeError(name + ' must be a uuid-v4 string');
    }
  }

  // ------------------------------------------------------------------
  // FEN: structural validation only (no legality check — see header).
  //
  // Mirrors the vendored chess.js validate_fen field-1/4 rules without
  // depending on it: exactly six fields; eight ranks summing to 8 with
  // piece/digit chars only; w|b side to move; standard castling field;
  // '-' or [a-h][36] en-passant square with the side-to-move consistency
  // rule (side w → ep rank 6; side b → ep rank 3); non-negative halfmove
  // clock; positive fullmove number.
  // ------------------------------------------------------------------

  function isFen(s) {
    if (typeof s !== 'string') {
      return false;
    }
    var trimmed = s.trim();
    if (trimmed === '') {
      return false;
    }
    var fields = trimmed.split(/\s+/);
    if (fields.length !== 6) {
      return false;
    }
    var ranks = fields[0].split('/');
    if (ranks.length !== 8) {
      return false;
    }
    for (var i = 0; i < ranks.length; i++) {
      var rank = ranks[i];
      if (rank === '' || !FEN_RANK_CHARS_RE.test(rank)) {
        return false;
      }
      // No two consecutive digits: the vendored chess.js validate_fen
      // rejects them, and new Chess() silently misloads such a rank as an
      // empty board. (e.g. 'RNBQK11R' is not a FEN.)
      if (/[1-8]{2}/.test(rank)) {
        return false;
      }
      var sum = 0;
      for (var j = 0; j < rank.length; j++) {
        var ch = rank.charAt(j);
        if (ch >= '1' && ch <= '8') {
          sum += ch.charCodeAt(0) - '0'.charCodeAt(0);
        } else {
          sum += 1;
        }
      }
      if (sum !== 8) {
        return false;
      }
    }
    var side = fields[1];
    if (side !== 'w' && side !== 'b') {
      return false;
    }
    if (!FEN_CASTLING_RE.test(fields[2])) {
      return false;
    }
    var ep = fields[3];
    if (ep !== '-') {
      if (!FEN_EP_SQUARE_RE.test(ep)) {
        return false;
      }
      // The en-passant target square must be reachable by the side that
      // just moved: white to move ⇒ black pawn leapt ⇒ ep rank 6;
      // black to move ⇒ white pawn leapt ⇒ ep rank 3.
      if ((side === 'w' && ep.charAt(1) !== '6') ||
          (side === 'b' && ep.charAt(1) !== '3')) {
        return false;
      }
    }
    if (!NON_NEGATIVE_INTEGER_RE.test(fields[4])) {
      return false;
    }
    if (!NON_NEGATIVE_INTEGER_RE.test(fields[5])) {
      return false;
    }
    if (Number(fields[5]) < 1) {
      return false;
    }
    return true;
  }

  function requireValidFen(s) {
    // Malformed input (non-string, empty/whitespace) is a caller shape
    // error; a non-empty string that fails the structural checks is a
    // value outside the FEN domain.
    if (typeof s !== 'string' || s.trim() === '') {
      throw new TypeError('fen must be a non-empty string');
    }
    if (!isFen(s)) {
      throw new RangeError('fen is not a structurally valid FEN string');
    }
  }

  // ------------------------------------------------------------------
  // Squares and promotions.
  // ------------------------------------------------------------------

  function isSquare(s) {
    return typeof s === 'string' && SQUARE_RE.test(s);
  }

  function requireSquare(value, name) {
    if (typeof value !== 'string') {
      throw new TypeError(name + ' must be a square string like "e2"');
    }
    if (!isSquare(value)) {
      throw new RangeError(name + ' must be a square string like "e2"');
    }
  }

  function isPromotion(p) {
    return p === null || PROMOTION_PIECES.indexOf(p) !== -1;
  }

  function requirePromotion(value) {
    // undefined is a shape error (explicit-null convention, cf. 1.3's
    // gameId null handling); a non-lowercase or unknown piece char is a
    // domain error. An unobservable promotion piece must NOT be recorded
    // as null — that records a non-promotion. §3.1 treats it as a
    // synchronization failure instead.
    if (value === null) {
      return;
    }
    if (value === undefined || typeof value !== 'string') {
      throw new TypeError('promotion must be null or one of "q", "r", "b", "n"');
    }
    if (PROMOTION_PIECES.indexOf(value) === -1) {
      throw new RangeError('promotion must be one of "q", "r", "b", "n"');
    }
  }

  // ------------------------------------------------------------------
  // game_started — 1.4.1. Payload is exactly {fen}.
  // ------------------------------------------------------------------

  var GAME_STARTED_KEYS = ['fen'];

  function createGameStartedPayload(input) {
    requireObject(input, 'GameStartedPayload input');
    // Trim-and-store: isFen tolerates surrounding whitespace for the check,
    // but the stored record must be canonical — a dirty FEN is rejected by
    // the vendored validator and silently misloads in chess.js replay.
    var payload = {
      fen: typeof input.fen === 'string' ? input.fen.trim() : input.fen
    };
    requireValidGameStartedPayload(payload);
    return Object.freeze(payload);
  }

  function requireValidGameStartedPayload(p) {
    requireObject(p, 'GameStartedPayload');
    requireExactKeys(p, GAME_STARTED_KEYS, 'GameStartedPayload');
    requireValidFen(p.fen);
  }

  // ------------------------------------------------------------------
  // move_confirmed — 1.4.2. Payload is exactly {from, to, promotion}.
  // No timestamps: the observation time is the 1.3 envelope's
  // (clockSegmentId, monotonicMs).
  // ------------------------------------------------------------------

  var MOVE_KEYS = ['from', 'to', 'promotion'];

  function createMovePayload(input) {
    requireObject(input, 'MovePayload input');
    var promotion = Object.prototype.hasOwnProperty.call(input, 'promotion')
      ? input.promotion
      : null;
    var payload = { from: input.from, to: input.to, promotion: promotion };
    requireValidMovePayload(payload);
    return Object.freeze(payload);
  }

  function requireValidMovePayload(p) {
    requireObject(p, 'MovePayload');
    requireExactKeys(p, MOVE_KEYS, 'MovePayload');
    requireSquare(p.from, 'from');
    requireSquare(p.to, 'to');
    if (p.from === p.to) {
      throw new RangeError('MovePayload "from" and "to" must differ');
    }
    requirePromotion(p.promotion);
  }

  // ------------------------------------------------------------------
  // history_recovered — 1.4.3 (marker-first). Payload is exactly
  // {recoveryReason, expectedMoveCount}. Batch moves follow as ordinary
  // move_confirmed events ref-linked via {recoveryEventId}.
  // ------------------------------------------------------------------

  var HISTORY_RECOVERED_KEYS = ['recoveryReason', 'expectedMoveCount'];

  function createHistoryRecoveredPayload(input) {
    requireObject(input, 'HistoryRecoveredPayload input');
    var payload = {
      recoveryReason: input.recoveryReason,
      expectedMoveCount: input.expectedMoveCount
    };
    requireValidHistoryRecoveredPayload(payload);
    return Object.freeze(payload);
  }

  function requireValidHistoryRecoveredPayload(p) {
    requireObject(p, 'HistoryRecoveredPayload');
    requireExactKeys(p, HISTORY_RECOVERED_KEYS, 'HistoryRecoveredPayload');
    requireVocabulary(p.recoveryReason, RECOVERY_REASONS, 'recoveryReason');
    requireNonNegativeInteger(p.expectedMoveCount, 'expectedMoveCount');
  }

  // ------------------------------------------------------------------
  // history_revised — 1.4.3 (marker-first). Payload is exactly
  // {revisionKind, retractedMoveEventIds, observedHistoryLength,
  // expectedMoveCount}. Contradicted move_confirmed events stay in the
  // stream; replacements follow ref-linked via {revisionEventId}.
  // ------------------------------------------------------------------

  var HISTORY_REVISED_KEYS = [
    'revisionKind',
    'retractedMoveEventIds',
    'observedHistoryLength',
    'expectedMoveCount'
  ];

  function createHistoryRevisedPayload(input) {
    requireObject(input, 'HistoryRevisedPayload input');
    var ids = input.retractedMoveEventIds;
    if (!Array.isArray(ids)) {
      throw new TypeError('retractedMoveEventIds must be a non-empty array of uuid-v4 strings');
    }
    var payload = {
      revisionKind: input.revisionKind,
      retractedMoveEventIds: Object.freeze(ids.slice()),
      observedHistoryLength: input.observedHistoryLength,
      expectedMoveCount: input.expectedMoveCount
    };
    requireValidHistoryRevisedPayload(payload);
    return Object.freeze(payload);
  }

  function requireValidHistoryRevisedPayload(p) {
    requireObject(p, 'HistoryRevisedPayload');
    requireExactKeys(p, HISTORY_REVISED_KEYS, 'HistoryRevisedPayload');
    requireVocabulary(p.revisionKind, REVISION_KINDS, 'revisionKind');
    if (!Array.isArray(p.retractedMoveEventIds)) {
      throw new TypeError('retractedMoveEventIds must be a non-empty array of uuid-v4 strings');
    }
    if (p.retractedMoveEventIds.length === 0) {
      throw new TypeError('retractedMoveEventIds must be non-empty');
    }
    var seen = {};
    for (var i = 0; i < p.retractedMoveEventIds.length; i++) {
      var id = p.retractedMoveEventIds[i];
      requireUuidV4(id, 'retractedMoveEventIds[' + i + ']');
      if (Object.prototype.hasOwnProperty.call(seen, id)) {
        throw new RangeError('retractedMoveEventIds must not contain duplicates');
      }
      seen[id] = true;
    }
    requireNonNegativeInteger(p.observedHistoryLength, 'observedHistoryLength');
    requireNonNegativeInteger(p.expectedMoveCount, 'expectedMoveCount');
  }

  // ------------------------------------------------------------------
  // position_checkpoint — 1.4.4. Payload is exactly
  // {fen, reason, fenSource}. Emission is §3.1's, behind the strict gate
  // documented in the module header; nothing in this task emits one.
  // ------------------------------------------------------------------

  var POSITION_CHECKPOINT_KEYS = ['fen', 'reason', 'fenSource'];

  function createPositionCheckpointPayload(input) {
    requireObject(input, 'PositionCheckpointPayload input');
    // Trim-and-store (see createGameStartedPayload): the stored FEN must be
    // canonical, never whitespace-padded.
    var payload = {
      fen: typeof input.fen === 'string' ? input.fen.trim() : input.fen,
      reason: input.reason,
      fenSource: input.fenSource
    };
    requireValidPositionCheckpointPayload(payload);
    return Object.freeze(payload);
  }

  function requireValidPositionCheckpointPayload(p) {
    requireObject(p, 'PositionCheckpointPayload');
    requireExactKeys(p, POSITION_CHECKPOINT_KEYS, 'PositionCheckpointPayload');
    requireValidFen(p.fen);
    requireVocabulary(p.reason, CHECKPOINT_REASONS, 'reason');
    requireVocabulary(p.fenSource, FEN_SOURCES, 'fenSource');
  }

  // ------------------------------------------------------------------
  // game_ended — 1.4.5. Payload is exactly {result, terminationReason,
  // evidenceSource, observedText}. terminationReason and observedText are
  // nullable: null terminationReason + '*' result is the valid
  // unknown-ending record; observedText is raw evidence (the exact string
  // Chess.com displayed), never stretched taxonomy.
  // ------------------------------------------------------------------

  var GAME_ENDED_KEYS = ['result', 'terminationReason', 'evidenceSource', 'observedText'];

  function normalizeObservedText(value) {
    if (value === null) {
      return null;
    }
    if (typeof value !== 'string') {
      throw new TypeError('observedText must be a string or null');
    }
    return value.trim() === '' ? null : value;
  }

  function requireValidObservedText(value) {
    if (value === null) {
      return;
    }
    if (typeof value !== 'string') {
      throw new TypeError('observedText must be a string or null');
    }
    if (value.trim() === '') {
      throw new TypeError('observedText must be non-empty after trimming, or null');
    }
  }

  function createGameEndedPayload(input) {
    requireObject(input, 'GameEndedPayload input');
    var terminationReason = Object.prototype.hasOwnProperty.call(input, 'terminationReason')
      ? input.terminationReason
      : null;
    var observedText = Object.prototype.hasOwnProperty.call(input, 'observedText')
      ? normalizeObservedText(input.observedText)
      : null;
    var payload = {
      result: input.result,
      terminationReason: terminationReason,
      evidenceSource: input.evidenceSource,
      observedText: observedText
    };
    requireValidGameEndedPayload(payload);
    return Object.freeze(payload);
  }

  function requireValidGameEndedPayload(p) {
    requireObject(p, 'GameEndedPayload');
    requireExactKeys(p, GAME_ENDED_KEYS, 'GameEndedPayload');
    requireVocabulary(p.result, GAME_RESULTS, 'result');
    if (p.terminationReason === null) {
      // null = unknown, per 1.2's unknown convention.
    } else if (typeof p.terminationReason === 'undefined' ||
               (typeof p.terminationReason !== 'string')) {
      throw new TypeError('terminationReason must be a vocabulary string or null');
    } else if (TERMINATION_REASONS.indexOf(p.terminationReason) === -1) {
      throw new RangeError(
        "terminationReason must be one of: '" +
        TERMINATION_REASONS.join("', '") + "' or null"
      );
    }
    requireVocabulary(p.evidenceSource, EVIDENCE_SOURCES, 'evidenceSource');
    requireValidObservedText(p.observedText);
  }

  // ------------------------------------------------------------------
  // Exports.
  // ------------------------------------------------------------------

  BlindfoldSession.GAME_STARTED_EVENT_TYPE = GAME_STARTED_EVENT_TYPE;
  BlindfoldSession.MOVE_CONFIRMED_EVENT_TYPE = MOVE_CONFIRMED_EVENT_TYPE;
  BlindfoldSession.HISTORY_RECOVERED_EVENT_TYPE = HISTORY_RECOVERED_EVENT_TYPE;
  BlindfoldSession.HISTORY_REVISED_EVENT_TYPE = HISTORY_REVISED_EVENT_TYPE;
  BlindfoldSession.POSITION_CHECKPOINT_EVENT_TYPE = POSITION_CHECKPOINT_EVENT_TYPE;
  BlindfoldSession.GAME_ENDED_EVENT_TYPE = GAME_ENDED_EVENT_TYPE;

  BlindfoldSession.RECOVERY_REASONS = RECOVERY_REASONS;
  BlindfoldSession.REVISION_KINDS = REVISION_KINDS;
  BlindfoldSession.CHECKPOINT_REASONS = CHECKPOINT_REASONS;
  BlindfoldSession.GAME_RESULTS = GAME_RESULTS;
  BlindfoldSession.TERMINATION_REASONS = TERMINATION_REASONS;
  BlindfoldSession.EVIDENCE_SOURCES = EVIDENCE_SOURCES;
  BlindfoldSession.FEN_SOURCES = FEN_SOURCES;
  BlindfoldSession.PROMOTION_PIECES = PROMOTION_PIECES;

  BlindfoldSession.isFen = isFen;
  BlindfoldSession.requireValidFen = requireValidFen;
  BlindfoldSession.isSquare = isSquare;
  BlindfoldSession.isPromotion = isPromotion;

  BlindfoldSession.createGameStartedPayload = createGameStartedPayload;
  BlindfoldSession.requireValidGameStartedPayload = requireValidGameStartedPayload;
  BlindfoldSession.createMovePayload = createMovePayload;
  BlindfoldSession.requireValidMovePayload = requireValidMovePayload;
  BlindfoldSession.createHistoryRecoveredPayload = createHistoryRecoveredPayload;
  BlindfoldSession.requireValidHistoryRecoveredPayload = requireValidHistoryRecoveredPayload;
  BlindfoldSession.createHistoryRevisedPayload = createHistoryRevisedPayload;
  BlindfoldSession.requireValidHistoryRevisedPayload = requireValidHistoryRevisedPayload;
  BlindfoldSession.createPositionCheckpointPayload = createPositionCheckpointPayload;
  BlindfoldSession.requireValidPositionCheckpointPayload = requireValidPositionCheckpointPayload;
  BlindfoldSession.createGameEndedPayload = createGameEndedPayload;
  BlindfoldSession.requireValidGameEndedPayload = requireValidGameEndedPayload;
})();

// Node test shim. Content-script and importScripts() consumers use the
// BlindfoldSession global directly; only environments that provide CommonJS
// get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
