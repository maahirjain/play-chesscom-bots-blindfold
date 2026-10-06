const BLINDFOLD_PIECESET_BASE = "https://images.chesscomfiles.com/chess-themes/pieces/blindfold/150/";
const NEO_PIECESET_BASE = "https://assets-themes.chess.com/image/ejgfv/150/";

// Task 3.1 (PLAN.md §3.1): the history tracker and its constants live on
// the BlindfoldSession namespace for namespaced access and testability
// (2.x precedent for new APIs). The pre-existing gameplay helpers above
// and below stay as plain functions.
var BlindfoldSession = BlindfoldSession || {};

// §5-owned runtime slot (mirrors 2.7's activeSessionId precedent).
// Declared here next to the tracker; §5 manages it. Null → the tracker
// advances the board but emits no game-scoped events (track-but-don't-emit).
BlindfoldSession.activeGameId = null;

// 3.1-owned event vocabulary (1.3 §2.2: each task owns its vocabulary).
// game_records.js is loaded in the content-script world (manifest) so the
// 1.4 payload factories are available to the tracker.
BlindfoldSession.HISTORY_SYNC_FAILED_EVENT_TYPE = 'history_sync_failed';
BlindfoldSession.SYNC_FAILURE_REASONS = Object.freeze([
  'illegal_observed_move',   // SAN failed validation and the bridge test failed
  'unobservable_promotion',  // promotion-shaped SAN, piece indeterminable (1.4 rule)
  'unreconciled_revision',   // correction replacements failed validation
  'malformed_observation',   // empty/whitespace move-list element
  'internal_desync'          // observed history replays clean but internal board diverged
]);

// 3.2-owned event vocabulary (1.3 §2.2: each task owns its vocabulary).
// move input attempts: submit → dispatch → match/unconfirmed lifecycle.
BlindfoldSession.MOVE_ATTEMPT_EVENT_TYPE = 'move_attempt';
BlindfoldSession.MOVE_DISPATCH_STARTED_EVENT_TYPE = 'move_dispatch_started';
BlindfoldSession.MOVE_DISPATCH_FAILED_EVENT_TYPE = 'move_dispatch_failed';
BlindfoldSession.MOVE_ATTEMPT_MATCHED_EVENT_TYPE = 'move_attempt_matched';
BlindfoldSession.MOVE_ATTEMPT_UNCONFIRMED_EVENT_TYPE = 'move_attempt_unconfirmed';

// 3.2.4: makeMoveOnBoard failure reasons (frozen). Returned instead of
// `false`; the single caller (content.js) records them.
BlindfoldSession.DISPATCH_FAILURE_REASONS = Object.freeze([
  'move_unparsable',          // parseMoveSquares returned null
  'board_not_found',          // getBoardElement() returned null
  'square_coordinates_failed',// squareToXY failed for from or to
  'promotion_window_timeout', // promotion window never became visible
  'promotion_choice_missing'  // promotion window visible but no matching choice
]);

// 3.3-owned event vocabulary (1.3 §2.2: each task owns its vocabulary).
// piece visibility transitions and help-shortcut requests.
BlindfoldSession.PIECE_VISIBILITY_CHANGED_EVENT_TYPE = 'piece_visibility_changed';
BlindfoldSession.HELP_REQUESTED_EVENT_TYPE = 'help_requested';

// 3.3.2: piece-set modes and transition source vocabulary (frozen).
BlindfoldSession.PIECE_SETS = Object.freeze(['blindfold', 'neo']);
BlindfoldSession.VISIBILITY_SOURCES = Object.freeze([
  'init',          // page-load read from localStorage
  'keyboard',      // v-key toggle
  'session_start', // §5 session-start re-record
  'api'            // any programmatic caller (default for bare setPieceSet)
]);

// 3.3.3: spoken-assistance ("help") shortcuts. j (navigation), v
// (visibility), Escape (3.4 speech cancellation) are explicitly excluded.
BlindfoldSession.HELP_SHORTCUTS = Object.freeze(['w', 'm', 'z', 'i', 's']);

// 3.5-owned event vocabulary (1.3 §2.2: each task owns its vocabulary).
// Game/session lifecycle: document visibility + focus, game resets.
// game_ended is 1.4-owned (PLAN §1.4.5; game_records.js) — 3.5 does NOT
// redeclare its event type, payload schema, or termination vocabulary
// (3.5 SF-1 repair: a same-named validator here once shadowed 1.4's on
// the merged namespace).
BlindfoldSession.DOCUMENT_VISIBILITY_CHANGED_EVENT_TYPE = 'document_visibility_changed';
BlindfoldSession.GAME_RESET_EVENT_TYPE = 'game_reset';

// 3.5.4: recorder-internal game_ended source keys (frozen). These are a
// dedup vocabulary only — they are NEVER persisted in an event payload.
// The persisted evidence source is 1.4's EVIDENCE_SOURCES
// ('observed'/'manual'): chess_rules and chesscom_dialog both record
// evidenceSource 'observed' (the dialog additionally carries the raw
// display string in observedText), stop records 'manual'.
BlindfoldSession.GAME_END_SOURCES = Object.freeze([
  'chess_rules',    // internal board reached a terminal state
  'chesscom_dialog',// Chess.com's game-over dialog (§7; unsupported today)
  'stop'            // §5 Stop control with a termination reason
]);

// Cross-module access (Node test pattern): the 1.4 payload factories live
// on the merged globalThis.BlindfoldSession in tests; in the browser the
// module-scoped BlindfoldSession IS the global. Read at call time.
function sharedBS() {
  if (typeof globalThis !== 'undefined' && globalThis.BlindfoldSession &&
      typeof globalThis.BlindfoldSession.createHistoryRecoveredPayload === 'function') {
    return globalThis.BlindfoldSession;
  }
  return BlindfoldSession;
}

function observeMoves(onMoveListChange) {
    let last_half_moves = null;

    // 3.1.1: compare move-list contents, not just length. A same-length
    // substitution (takeback + different move) must fire the observer.
    const halfMovesEqual = (a, b) => {
        if (a === b) return true;
        if (!a || !b || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    };

    const checkMoves = () => {
        const half_moves = getMoveList();
        if (!halfMovesEqual(half_moves, last_half_moves)) {
            last_half_moves = half_moves.slice();
            onMoveListChange(half_moves);
        }
    }

    const observer = new MutationObserver(checkMoves);
    observer.observe(document.body, { childList: true, subtree: true });

    checkMoves();

    return observer;
}

function getMoveList() {
    const move_list_container = document.querySelector(".play-controller-moveList");
    
    if (!move_list_container) {
        return [];
    }

    const half_moves = [];
    const half_move_spans = move_list_container.querySelectorAll(".node.main-line-ply .node-highlight-content");

    for (const half_move_span of half_move_spans) {
        half_moves.push(half_move_span.textContent.trim());
    }

    return half_moves;
}

function normalizeMove(game, move) {
  if (move == null) return "";

  let normalized = String(move).trim().replace(/\s+/g, "");
  if (!normalized) return normalized;

  const lower = normalized.toLowerCase();

  if (lower === "oo" || lower === "o-o" || lower == "c" || normalized === "00" || normalized === "0-0") return "O-O";
  if (lower === "ooo" || lower === "o-o-o" || lower == "cl" || normalized === "000" || normalized === "0-0-0") return "O-O-O";

  let first = normalized[0];
  if ("rnqk".includes(first)) {
    normalized = first.toUpperCase() + normalized.slice(1);
  }

  if (normalized.length > 1 && normalized[0].toLowerCase() === "p" && normalized[1] >= "a" && normalized[1] <= "h") {
    normalized = normalized.slice(1);
  }

  normalized = normalized.replace(/=([nbrq])/g, (_, promo) => "=" + promo.toUpperCase());

  normalized = normalized.replace(/([a-h][18])([nbrq])$/i, (_, square, promo) => {
    return square + "=" + promo.toUpperCase();
  });
  
  normalized = normalized.replace(/([a-h][18])([nbrq])([+#])$/i, (_, square, promo, suffix) => {
    return square + "=" + promo.toUpperCase() + suffix;
  });

  normalized = normalized.replace(/([+#])[+#]+$/g, "$1");

  first = normalized[0];
  if (first == "b" && !isMoveLegal(game, normalized)) {
    normalized = first.toUpperCase() + normalized.slice(1);
  }

  return normalized;
}

function isMoveLegal(game, move) {
    if (!move) return false;
    const game_copy = new Chess(game.fen());
    return game_copy.move(move) != null;
}

async function makeMoveOnBoard(game, move) {
    // 3.2.4: returns true on success, otherwise a member of
    // BlindfoldSession.DISPATCH_FAILURE_REASONS. Single caller: content.js.
    var REASONS = BlindfoldSession.DISPATCH_FAILURE_REASONS;
    const move_squares = parseMoveSquares(game, move);
    if (!move_squares) return REASONS[0]; // 'move_unparsable'

    const board = getBoardElement();
    if (!board) return REASONS[1]; // 'board_not_found'

    const fromXY = squareToXY(board, move_squares.from);
    const toXY = squareToXY(board, move_squares.to);
    if (!fromXY || !toXY) return REASONS[2]; // 'square_coordinates_failed'

    const moving_color = game.turn();

    clickElementAt(board, fromXY.x, fromXY.y);
    await sleep(30);
    clickElementAt(board, toXY.x, toXY.y);

    if (move_squares.promotion) {
        const promotion_outcome = await handlePromotionIfNeeded(move_squares.promotion, moving_color);
        if (promotion_outcome !== true) return promotion_outcome;
    }

    return true;
}

// Exported for testability (3.2.4 failure-reason contract); content.js
// keeps calling the module-local binding.
BlindfoldSession.makeMoveOnBoard = makeMoveOnBoard;

function parseMoveSquares(game, move) {
    const game_copy = new Chess(game.fen());
    const move_obj = game_copy.move(move);
    if (!move_obj) return null;

    return {
        from: move_obj.from,
        to: move_obj.to,
        promotion: move_obj.promotion || null
    };
}

function squareToFileRank(square) {
  const file_char = square[0];
  const rank_char = square[1];
  const file = "abcdefgh".indexOf(file_char) + 1;
  const rank = Number(rank_char);
  if (file < 1 || file > 8 || rank < 1 || rank > 8) return null;
  return { file, rank };
}

function squareToXY(board, square) {
    const file_rank = squareToFileRank(square);
    if (!file_rank) return null;

    const board_rect = board.getBoundingClientRect();
    const square_size = board_rect.width / 8;

    const flipped = board.classList.contains("flipped");

    const file_index = file_rank.file - 1;
    const rank_index = file_rank.rank - 1;

    let x_index, y_index;

    if (!flipped) {
        x_index = file_index;
        y_index = 7 - rank_index;
    } else {
        x_index = 7 - file_index;
        y_index = rank_index;
    }

    return {
        x: board_rect.left + (x_index + 0.5) * square_size,
        y: board_rect.top + (y_index + 0.5) * square_size
    };
}

function clickElementAt(element, x, y) {
    const opts = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        button: 0,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true
    };

    element.dispatchEvent(new PointerEvent("pointerdown", opts));
    element.dispatchEvent(new PointerEvent("pointerup", opts));
    element.dispatchEvent(new MouseEvent("click", opts));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function handlePromotionIfNeeded(promotion_letter, moving_color) {
    // 3.2.4: returns true on success, otherwise the specific
    // DISPATCH_FAILURE_REASON. Single caller: makeMoveOnBoard.
    if (!promotion_letter) return true;

    const promotion_window = await waitForVisiblePromotionWindow();
    if (!promotion_window) return BlindfoldSession.DISPATCH_FAILURE_REASONS[3]; // 'promotion_window_timeout'

    const piece_class = moving_color + promotion_letter;
    const choice = promotion_window.querySelector(`.promotion-piece.${piece_class}`);
    if (!choice) return BlindfoldSession.DISPATCH_FAILURE_REASONS[4]; // 'promotion_choice_missing'

    const choice_rect = choice.getBoundingClientRect();
    const x = choice_rect.left + choice_rect.width / 2;
    const y = choice_rect.top + choice_rect.height / 2;
    clickElementAt(choice, x, y);

    return true;
}

async function waitForVisiblePromotionWindow(timeout_ms = 500) {
  const start = performance.now();

  while (performance.now() - start < timeout_ms) {
    const promotion_window = document.querySelector(".promotion-window.promotion-window--visible");
    if (promotion_window) return promotion_window;
    await sleep(16);
  }

  return null;
}

function getPieceClassFromPieceElement(piece_element) {
    for (const cls of piece_element.classList) {
        if (cls.length === 2 && (cls[0] === "w" || cls[0] === "b")) return cls;
    }

    return null;
}

function applyPieceSet(base_url) {
  const board = getBoardElement();
  if (!board) return;

  for (const piece_element of board.querySelectorAll(".piece")) {
    const piece_class = getPieceClassFromPieceElement(piece_element);
    if (!piece_class) continue;
    piece_element.style.backgroundImage = `url("${base_url}${piece_class}.png")`;
  }
}

function observePieceRenders(onChange) {
  const board = getBoardElement();
  if (!board) return null;

  const observer = new MutationObserver(() => onChange(board));
  observer.observe(board, { childList: true, subtree: true })

  return observer;
}

function getBoardElement() {
    return document.querySelector("wc-chess-board");
}

// 3.3.3: board readability is the `s`-shortcut's "usable content" test.
// Exported for content.js (makeMoveOnBoard 3.2 precedent); the module-local
// binding keeps working for the existing callers.
BlindfoldSession.getBoardElement = getBoardElement;

// ------------------------------------------------------------------
// Task 3.1: createHistoryTracker — reliable confirmed-history tracking.
//
// Owns one stable internal Chess instance (created once; rewound via
// reset() + replay, never replaced), the confirmed move sequence with
// eventIds, and suspect/desync state. observe(halfMoves) is DOM-free and
// synchronous; it returns {confirmed, revised, recovered, syncFailed,
// reset}.
//
// Event/timing semantics (repo convention): payloads carry no time
// fields; the sender stamps observation time on the envelope. Batch and
// recovered moves are marked via history_recovered (marker-first);
// never backdated.
// ------------------------------------------------------------------

var UUID_V4_RE_31 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function createHistoryTracker(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createHistoryTracker options must be an object');
  }

  var gameId = options.gameId === undefined ? null : options.gameId;
  if (gameId !== null && (typeof gameId !== 'string' || !UUID_V4_RE_31.test(gameId))) {
    throw new TypeError('gameId must be a uuid-v4 string or null');
  }

  var emitEvent = options.emitEvent;
  if (typeof emitEvent !== 'function') {
    throw new TypeError('emitEvent must be a function');
  }

  var onGameReset = options.onGameReset;
  if (typeof onGameReset !== 'function') {
    throw new TypeError('onGameReset must be a function');
  }

  var suspectThreshold = options.suspectThreshold === undefined ? 3 : options.suspectThreshold;
  var desyncThreshold = options.desyncThreshold === undefined ? 5 : options.desyncThreshold;
  if (!Number.isInteger(suspectThreshold) || suspectThreshold < 1) {
    throw new TypeError('suspectThreshold must be a positive integer');
  }
  if (!Number.isInteger(desyncThreshold) || desyncThreshold < 1) {
    throw new TypeError('desyncThreshold must be a positive integer');
  }

  // Bind the namespace with the 1.4 factories (sharedBS, see above).
  var BS = sharedBS();

  // Stable internal board: rewound via reset() + replay, never replaced,
  // so hosts can hold one binding (content.js `game`, sounds.js).
  var game = new Chess();

  // Confirmed sequence: [{san, from, to, promotion, eventId, preFen}].
  // san is the raw observed string (preserved); from/to/promotion are
  // canonical from the chess.js move object. preFen is the in-memory
  // pre-move FEN for sayMove — never persisted.
  var confirmed = [];

  var ended = false;
  var suspectCount = 0;
  var desyncCount = 0;
  var checkpointEmitted = false;
  var everObserved = false;

  // Game-scoped events require a non-null gameId (1.4). With a null
  // gameId the tracker advances the board but emits nothing.
  function emitGameEvent(eventType, payload, refs) {
    if (gameId === null) {
      return null;
    }
    return emitEvent(eventType, payload, refs === undefined ? null : refs);
  }

  function emitSyncFailed(reason, plyIndex, observedSan) {
    // Exact keys per contract §2.7 (3.1-owned type; no 1.4 factory).
    emitGameEvent(
      BS.HISTORY_SYNC_FAILED_EVENT_TYPE,
      {
        reason: reason,
        plyIndex: plyIndex,
        observedSan: observedSan,
        internalFen: game.fen()
      },
      null
    );
  }

  function getState() {
    if (ended) return 'ended';
    if (desyncCount > 0) return 'desynced';
    if (suspectCount > 0) return 'suspect';
    return 'tracking';
  }

  // Rewind the internal game and replay the confirmed sequence using
  // canonical from/to/promotion (not raw SAN — reliable by construction).
  function replayConfirmed() {
    game.reset();
    for (var i = 0; i < confirmed.length; i++) {
      var c = confirmed[i];
      game.move({ from: c.from, to: c.to, promotion: c.promotion });
    }
  }

  // 3.1.2: try the raw observed SAN first (preserve original
  // observations), then normalizeMove as a display-quirk fallback.
  // Returns {move, preFen} on success, null on failure. Never throws;
  // never mutates the game on failure.
  function tryApplyMove(targetGame, rawSan) {
    var preFen = targetGame.fen();
    var move = null;
    try {
      move = targetGame.move(rawSan);
    } catch (e) {
      move = null;
    }
    if (move) {
      return { move: move, preFen: preFen };
    }
    var normalized = null;
    try {
      normalized = normalizeMove(targetGame, rawSan);
    } catch (e) {
      normalized = null;
    }
    if (normalized && normalized !== rawSan) {
      try {
        move = targetGame.move(normalized);
      } catch (e) {
        move = null;
      }
      if (move) {
        return { move: move, preFen: preFen };
      }
    }
    return null;
  }

  // Promotion-shaped SAN with no determinable piece (1.4 rule): never
  // guess — the emitter treats it as a synchronization failure.
  function isPromotionShaped(san) {
    var stripped = san.replace(/[+#]+$/, '');
    return /[a-h][18]=?$/.test(stripped);
  }

  // Bridge test (§2.7): replay the entire observed list from the initial
  // position on a scratch board. Success ⇒ the observation is
  // self-consistent and the internal board is stale. Failure at a ply ⇒
  // the observation is genuinely inconsistent.
  function bridgeTest(halfMoves) {
    var scratch = new Chess();
    for (var i = 0; i < halfMoves.length; i++) {
      if (!tryApplyMove(scratch, halfMoves[i])) {
        return { success: false, failPly: i, failSan: halfMoves[i] };
      }
    }
    return { success: true };
  }

  function onDesyncFailure() {
    desyncCount++;
    // 1.4 strict gate, leg 1+2: a sync failure was recorded, and the gap
    // is unbridgeable (bridgeTest failed on desyncThreshold consecutive
    // observations). Leg 3: last-known-good FEN, honestly labeled.
    if (gameId !== null && desyncCount >= desyncThreshold && !checkpointEmitted) {
      var cpPayload = BS.createPositionCheckpointPayload({
        fen: game.fen(),
        reason: 'unreconciled_history',
        fenSource: 'observed'
      });
      emitGameEvent(
        BS.POSITION_CHECKPOINT_EVENT_TYPE,
        cpPayload,
        null
      );
      checkpointEmitted = true;
    }
  }

  function clearWatchCounters() {
    suspectCount = 0;
    desyncCount = 0;
  }

  // Confirm one validated move: emit move_confirmed and record it.
  // Returns the confirmed entry.
  function confirmMove(applied, refs) {
    var movePayload = BS.createMovePayload({
      from: applied.move.from,
      to: applied.move.to,
      promotion: applied.move.promotion || null
    });
    var emitResult = emitGameEvent(
      BS.MOVE_CONFIRMED_EVENT_TYPE,
      movePayload,
      refs
    );
    var entry = {
      san: applied.san,
      from: applied.move.from,
      to: applied.move.to,
      promotion: applied.move.promotion || null,
      eventId: (emitResult && emitResult.eventId) ? emitResult.eventId : null,
      preFen: applied.preFen
    };
    confirmed.push(entry);
    return entry;
  }

  // Validate + apply each SAN in sans (in order) to the game. Returns
  // {applied: [...]} on success; on the first failure rolls back any
  // partial application and returns {failIndex, failSan}.
  function validateBatch(sans) {
    var applied = [];
    for (var i = 0; i < sans.length; i++) {
      var r = tryApplyMove(game, sans[i]);
      if (!r) {
        for (var u = 0; u < applied.length; u++) {
          game.undo();
        }
        return { failIndex: i, failSan: sans[i] };
      }
      applied.push({ move: r.move, preFen: r.preFen, san: sans[i] });
    }
    return { applied: applied };
  }

  // Handle a validation failure: bridge test, then adopt or desync.
  // ctx: {kind: 'append'|'correction', prefixLen, isBatch, wasFirstObservation}
  function handleBridge(halfMoves, failPly, failSan, reason, ctx, result) {
    var bridge = bridgeTest(halfMoves);
    if (!bridge.success) {
      emitSyncFailed(reason, failPly, failSan);
      result.syncFailed = true;
      onDesyncFailure();
      return result;
    }

    // Bridge succeeded: the observation is self-consistent; the internal
    // board was stale. Record the desync, adopt the observed history.
    emitSyncFailed('internal_desync', failPly, failSan);
    result.syncFailed = true;

    var P = ctx.prefixLen;
    var oldConfirmed = confirmed.slice();

    // Divergent adoption needs the revision marker (marker-first).
    var revisionEventId = null;
    if (ctx.kind === 'correction') {
      var retractedIds = [];
      for (var ri = P; ri < oldConfirmed.length; ri++) {
        if (oldConfirmed[ri].eventId) retractedIds.push(oldConfirmed[ri].eventId);
      }
      if (gameId !== null && retractedIds.length > 0) {
        var revPayload = BS.createHistoryRevisedPayload({
          revisionKind: 'correction',
          retractedMoveEventIds: retractedIds,
          observedHistoryLength: halfMoves.length,
          expectedMoveCount: halfMoves.length - P
        });
        var revResult = emitGameEvent(
          BS.HISTORY_REVISED_EVENT_TYPE,
          revPayload,
          null
        );
        result.revised = true;
        if (revResult && revResult.eventId) revisionEventId = revResult.eventId;
      }
    }

    // Batch adoption gets the recovery marker (marker-first).
    var recoveryEventId = null;
    if (ctx.kind === 'append' && ctx.isBatch) {
      var recPayload = BS.createHistoryRecoveredPayload({
        recoveryReason: ctx.wasFirstObservation ? 'page_reload' : 'late_attachment',
        expectedMoveCount: halfMoves.length - P
      });
      var recResult = emitGameEvent(
        BS.HISTORY_RECOVERED_EVENT_TYPE,
        recPayload,
        null
      );
      result.recovered = true;
      if (recResult && recResult.eventId) recoveryEventId = recResult.eventId;
    }

    // Rebuild from the adopted observation. The bridge validated every
    // SAN, so this replay cannot fail; prefix entries keep their eventIds.
    game.reset();
    confirmed = [];
    for (var i = 0; i < halfMoves.length; i++) {
      var san = halfMoves[i];
      var preFen = game.fen();
      var mv = game.move(san);
      if (!mv) {
        var norm = normalizeMove(game, san);
        if (norm && norm !== san) mv = game.move(norm);
      }
      var refs = null;
      var eventId = null;
      if (i < P) {
        eventId = oldConfirmed[i].eventId;
      } else {
        if (revisionEventId) refs = { revisionEventId: revisionEventId };
        else if (recoveryEventId) refs = { recoveryEventId: recoveryEventId };
        var er = emitGameEvent(
          BS.MOVE_CONFIRMED_EVENT_TYPE,
          BS.createMovePayload({
            from: mv.from,
            to: mv.to,
            promotion: mv.promotion || null
          }),
          refs
        );
        eventId = (er && er.eventId) ? er.eventId : null;
      }
      var entry = {
        san: san,
        from: mv.from,
        to: mv.to,
        promotion: mv.promotion || null,
        eventId: eventId,
        preFen: preFen
      };
      confirmed.push(entry);
      if (i >= P) result.confirmed.push(entry);
    }

    clearWatchCounters();
    return result;
  }

  function handleAppend(halfMoves, wasFirstObservation, result) {
    var newSans = halfMoves.slice(confirmed.length);
    var isBatch = newSans.length > 1 || (wasFirstObservation && newSans.length > 0);

    var v = validateBatch(newSans);
    if (v.failIndex !== undefined) {
      var failPly = confirmed.length + v.failIndex;
      if (isPromotionShaped(v.failSan)) {
        emitSyncFailed('unobservable_promotion', failPly, v.failSan);
        result.syncFailed = true;
        onDesyncFailure();
        return result;
      }
      return handleBridge(halfMoves, failPly, v.failSan, 'illegal_observed_move',
        { kind: 'append', prefixLen: confirmed.length, isBatch: isBatch,
          wasFirstObservation: wasFirstObservation }, result);
    }

    clearWatchCounters();

    var recoveryEventId = null;
    if (isBatch) {
      var recPayload = BS.createHistoryRecoveredPayload({
        recoveryReason: wasFirstObservation ? 'page_reload' : 'late_attachment',
        expectedMoveCount: newSans.length
      });
      var recResult = emitGameEvent(
        BS.HISTORY_RECOVERED_EVENT_TYPE,
        recPayload,
        null
      );
      result.recovered = true;
      if (recResult && recResult.eventId) recoveryEventId = recResult.eventId;
    }

    for (var j = 0; j < v.applied.length; j++) {
      var refs = recoveryEventId ? { recoveryEventId: recoveryEventId } : null;
      result.confirmed.push(confirmMove(v.applied[j], refs));
    }
    return result;
  }

  function handleTakeback(halfMoves, prefixLen, result) {
    // O is a strict non-empty prefix of C: previously validated, so no
    // re-validation — rewind the board and truncate.
    var retractedIds = [];
    for (var i = prefixLen; i < confirmed.length; i++) {
      if (confirmed[i].eventId) retractedIds.push(confirmed[i].eventId);
    }
    if (gameId !== null && retractedIds.length > 0) {
      var payload = BS.createHistoryRevisedPayload({
        revisionKind: 'takeback',
        retractedMoveEventIds: retractedIds,
        observedHistoryLength: halfMoves.length,
        expectedMoveCount: 0
      });
      emitGameEvent(BS.HISTORY_REVISED_EVENT_TYPE, payload, null);
      result.revised = true;
    }
    confirmed = confirmed.slice(0, prefixLen);
    replayConfirmed();
    clearWatchCounters();
    return result;
  }

  function handleCorrection(halfMoves, prefixLen, result) {
    // O diverges at prefixLen. Rewind to the prefix, validate the rest.
    var savedConfirmed = confirmed.slice();
    confirmed = confirmed.slice(0, prefixLen);
    replayConfirmed();

    var newSans = halfMoves.slice(prefixLen);
    var v = validateBatch(newSans);
    if (v.failIndex !== undefined) {
      // Roll back to the pre-correction state.
      for (var u = 0; u < (v.applied ? v.applied.length : 0); u++) {
        game.undo();
      }
      confirmed = savedConfirmed;
      replayConfirmed();
      var failPly = prefixLen + v.failIndex;
      if (isPromotionShaped(v.failSan)) {
        emitSyncFailed('unobservable_promotion', failPly, v.failSan);
        result.syncFailed = true;
        onDesyncFailure();
        return result;
      }
      return handleBridge(halfMoves, failPly, v.failSan, 'unreconciled_revision',
        { kind: 'correction', prefixLen: prefixLen }, result);
    }

    var retractedIds = [];
    for (var i = 0; i < savedConfirmed.length - prefixLen; i++) {
      var eid = savedConfirmed[prefixLen + i].eventId;
      if (eid) retractedIds.push(eid);
    }
    var revisionEventId = null;
    if (gameId !== null && retractedIds.length > 0) {
      var payload = BS.createHistoryRevisedPayload({
        revisionKind: 'correction',
        retractedMoveEventIds: retractedIds,
        observedHistoryLength: halfMoves.length,
        expectedMoveCount: newSans.length
      });
      var revResult = emitGameEvent(
        BS.HISTORY_REVISED_EVENT_TYPE,
        payload,
        null
      );
      result.revised = true;
      if (revResult && revResult.eventId) revisionEventId = revResult.eventId;
    }

    for (var j = 0; j < v.applied.length; j++) {
      var refs = revisionEventId ? { revisionEventId: revisionEventId } : null;
      result.confirmed.push(confirmMove(v.applied[j], refs));
    }
    clearWatchCounters();
    return result;
  }

  function handleSuspect(result) {
    // Ambiguous: empty list with confirmed history, or a shorter list
    // that is not a strict prefix. Wait silently; a reconciling
    // observation clears the count with no event.
    suspectCount++;
    if (suspectCount >= suspectThreshold) {
      game.reset();
      // 3.5.2: capture the count before clearing — onGameReset receives
      // it for the game_reset record. Existing () => {...} stubs keep
      // working (extra argument ignored).
      var resetMoveCount = confirmed.length;
      confirmed = [];
      suspectCount = 0;
      desyncCount = 0;
      onGameReset({ confirmedMoveCount: resetMoveCount });
      result.reset = true;
      if (gameId !== null) {
        // A genuine reset is a session boundary once game identities
        // exist (§5 owns what follows); halt until §5 creates a tracker
        // for the new game.
        ended = true;
      }
      // 3.1 review SF-1: with gameId === null (interim, pre-§5) there is
      // no identity to protect and nothing was emitted, so restart
      // tracking in place instead of halting — otherwise a new game that
      // doesn't reload the page would freeze the board/speech at the
      // initial position (gameplay regression vs the old updateGame).
    }
    return result;
  }

  function observe(halfMoves) {
    if (!Array.isArray(halfMoves)) {
      throw new TypeError('observe: halfMoves must be an array');
    }
    for (var i = 0; i < halfMoves.length; i++) {
      if (typeof halfMoves[i] !== 'string') {
        throw new TypeError('observe: halfMoves[' + i + '] must be a string');
      }
    }

    var result = {
      confirmed: [],
      revised: false,
      recovered: false,
      syncFailed: false,
      reset: false
    };

    if (ended) {
      result.reset = true;
      return result;
    }

    var wasFirstObservation = !everObserved;
    everObserved = true;

    // Empty/whitespace elements are observation anomalies, not caller
    // errors (contract §2.2).
    for (var m = 0; m < halfMoves.length; m++) {
      if (halfMoves[m].trim() === '') {
        emitSyncFailed('malformed_observation', m, halfMoves[m]);
        result.syncFailed = true;
        onDesyncFailure();
        return result;
      }
    }

    // Longest common prefix by SAN string equality.
    var prefixLen = 0;
    while (prefixLen < halfMoves.length &&
           prefixLen < confirmed.length &&
           halfMoves[prefixLen] === confirmed[prefixLen].san) {
      prefixLen++;
    }

    var C = confirmed.length;
    var O = halfMoves.length;

    // No-op: nothing observed and nothing confirmed, or identical.
    if ((O === 0 && C === 0) || (O === C && prefixLen === C)) {
      clearWatchCounters();
      return result;
    }

    // Clean append.
    if (prefixLen === C && O > C) {
      return handleAppend(halfMoves, wasFirstObservation, result);
    }

    // Takeback: strict non-empty prefix (immediate per §2.4 rationale).
    if (prefixLen < C && O === prefixLen && O > 0) {
      return handleTakeback(halfMoves, prefixLen, result);
    }

    // Correction: diverges at prefixLen, and O is not shorter than C
    // (a complete alternative history). Shorter-divergent is ambiguous
    // → suspect (step 6).
    if (prefixLen < C && O > prefixLen && O >= C) {
      return handleCorrection(halfMoves, prefixLen, result);
    }

    // Otherwise ambiguous (empty O with history, or shorter-divergent):
    // suspect window, not an event.
    return handleSuspect(result);
  }

  return {
    observe: observe,
    getGame: function () { return game; },
    getConfirmedCount: function () { return confirmed.length; },
    getState: getState
  };
}

BlindfoldSession.createHistoryTracker = createHistoryTracker;

// ------------------------------------------------------------------
// Task 3.2: 3.2-owned payload validators (exact keys, per 1.3 §2.2).
// TypeError = wrong type/shape; RangeError = bad domain value.
// ------------------------------------------------------------------

function requireExactKeys(obj, keys, what) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new TypeError(what + ' must be a plain object');
  }
  var actual = Object.keys(obj).sort();
  var expected = keys.slice().sort();
  if (actual.length !== expected.length ||
      actual.some(function (k, i) { return k !== expected[i]; })) {
    throw new TypeError(what + ' must have exactly the keys: ' + expected.join(', '));
  }
  return obj;
}

function requireUuidV4(value, what) {
  if (typeof value !== 'string' || !UUID_V4_RE_31.test(value)) {
    throw new TypeError(what + ' must be a uuid-v4 string');
  }
  return value;
}

function requireValidMoveAttemptPayload(payload) {
  requireExactKeys(payload, ['submittedText', 'firstEditMonotonicMs', 'validation'],
    'move_attempt payload');
  if (typeof payload.submittedText !== 'string') {
    throw new TypeError('move_attempt payload.submittedText must be a string');
  }
  if (payload.firstEditMonotonicMs !== null &&
      typeof payload.firstEditMonotonicMs !== 'number') {
    throw new TypeError('move_attempt payload.firstEditMonotonicMs must be a number or null');
  }
  if (payload.validation !== 'legal' && payload.validation !== 'illegal') {
    throw new RangeError("move_attempt payload.validation must be 'legal' or 'illegal'");
  }
  return payload;
}

function requireValidDispatchFailedPayload(payload) {
  requireExactKeys(payload, ['failureReason'], 'move_dispatch_failed payload');
  if (BlindfoldSession.DISPATCH_FAILURE_REASONS.indexOf(payload.failureReason) === -1) {
    throw new RangeError('move_dispatch_failed payload.failureReason must be a member of DISPATCH_FAILURE_REASONS');
  }
  return payload;
}

function requireValidDispatchStartedRefs(refs) {
  requireExactKeys(refs, ['attemptEventId'], 'move_dispatch_started refs');
  requireUuidV4(refs.attemptEventId, 'move_dispatch_started refs.attemptEventId');
  return refs;
}

function requireValidDispatchFailedRefs(refs) {
  requireExactKeys(refs, ['attemptEventId', 'dispatchStartedEventId'],
    'move_dispatch_failed refs');
  requireUuidV4(refs.attemptEventId, 'move_dispatch_failed refs.attemptEventId');
  // dispatchStartedEventId may be null when the start event itself could
  // not be emitted (dormant tracker); otherwise a uuid-v4 string.
  if (refs.dispatchStartedEventId !== null) {
    requireUuidV4(refs.dispatchStartedEventId,
      'move_dispatch_failed refs.dispatchStartedEventId');
  }
  return refs;
}

function requireValidAttemptMatchedRefs(refs) {
  requireExactKeys(refs, ['attemptEventId', 'confirmedMoveEventId'],
    'move_attempt_matched refs');
  requireUuidV4(refs.attemptEventId, 'move_attempt_matched refs.attemptEventId');
  requireUuidV4(refs.confirmedMoveEventId,
    'move_attempt_matched refs.confirmedMoveEventId');
  return refs;
}

function requireValidAttemptUnconfirmedPayload(payload) {
  requireExactKeys(payload, ['reason'], 'move_attempt_unconfirmed payload');
  if (payload.reason !== 'timeout' && payload.reason !== 'pagehide' &&
      payload.reason !== 'game_reset') {
    throw new RangeError("move_attempt_unconfirmed payload.reason must be 'timeout', 'pagehide', or 'game_reset'");
  }
  return payload;
}

function requireValidAttemptUnconfirmedRefs(refs) {
  requireExactKeys(refs, ['attemptEventId'], 'move_attempt_unconfirmed refs');
  requireUuidV4(refs.attemptEventId, 'move_attempt_unconfirmed refs.attemptEventId');
  return refs;
}

BlindfoldSession.requireValidMoveAttemptPayload = requireValidMoveAttemptPayload;
BlindfoldSession.requireValidDispatchFailedPayload = requireValidDispatchFailedPayload;
BlindfoldSession.requireValidDispatchStartedRefs = requireValidDispatchStartedRefs;
BlindfoldSession.requireValidDispatchFailedRefs = requireValidDispatchFailedRefs;
BlindfoldSession.requireValidAttemptMatchedRefs = requireValidAttemptMatchedRefs;
BlindfoldSession.requireValidAttemptUnconfirmedPayload = requireValidAttemptUnconfirmedPayload;
BlindfoldSession.requireValidAttemptUnconfirmedRefs = requireValidAttemptUnconfirmedRefs;

// 3.3.1/3.3.2 validators: piece_visibility_changed payload. `from` is null
// only on the initial-state record (3.3.1); transitions require from !== to.
function requireValidPieceVisibilityChangedPayload(payload) {
  requireExactKeys(payload, ['from', 'to', 'source'],
    'piece_visibility_changed payload');
  if (payload.from !== null &&
      BlindfoldSession.PIECE_SETS.indexOf(payload.from) === -1) {
    throw new RangeError("piece_visibility_changed payload.from must be 'blindfold', 'neo', or null");
  }
  if (BlindfoldSession.PIECE_SETS.indexOf(payload.to) === -1) {
    throw new RangeError("piece_visibility_changed payload.to must be 'blindfold' or 'neo'");
  }
  // Note: from === to is accepted here (well-formed); recordTransition
  // treats it as a no-op returning null — no state change, no event.
  if (BlindfoldSession.VISIBILITY_SOURCES.indexOf(payload.source) === -1) {
    throw new RangeError('piece_visibility_changed payload.source must be a member of VISIBILITY_SOURCES');
  }
  return payload;
}

// 3.3.3 validator: help_requested payload. Refs are always null.
function requireValidHelpRequestedPayload(payload) {
  requireExactKeys(payload, ['shortcut', 'hadUsableContent'],
    'help_requested payload');
  if (BlindfoldSession.HELP_SHORTCUTS.indexOf(payload.shortcut) === -1) {
    throw new RangeError('help_requested payload.shortcut must be a member of HELP_SHORTCUTS');
  }
  if (typeof payload.hadUsableContent !== 'boolean') {
    throw new TypeError('help_requested payload.hadUsableContent must be a boolean');
  }
  return payload;
}

BlindfoldSession.requireValidPieceVisibilityChangedPayload = requireValidPieceVisibilityChangedPayload;
BlindfoldSession.requireValidHelpRequestedPayload = requireValidHelpRequestedPayload;

// ------------------------------------------------------------------
// Task 3.2: createFirstEditCapture — 3.2.1 first-edit timestamp.
//
// One monotonic timestamp per submit attempt: the first `input` event
// sets it; later inputs before submit do not overwrite; submit snapshots
// and resets. Only the timestamp is retained — no keystroke contents,
// counts, or inter-key timings. DOM-free; content.js wires it to the
// input listener.
// ------------------------------------------------------------------

function createFirstEditCapture(nowFn) {
  if (typeof nowFn !== 'function') {
    throw new TypeError('createFirstEditCapture nowFn must be a function');
  }
  var firstEdit = null;
  return {
    onInput: function () {
      if (firstEdit === null) {
        firstEdit = nowFn();
      }
    },
    onSubmit: function () {
      var v = firstEdit;
      firstEdit = null;
      return v;
    },
    peek: function () {
      return firstEdit;
    }
  };
}

BlindfoldSession.createFirstEditCapture = createFirstEditCapture;

// ------------------------------------------------------------------
// Task 3.2: createAttemptTracker — move-input attempt lifecycle.
//
// DOM-free state machine: submitAttempt → pending → noteConfirmedMoves
// matches it to a 3.1 confirmed move (move_attempt_matched), or the
// attempt goes unconfirmed (timeout / pagehide / game_reset), or it is
// terminal at birth (illegal at submit, unparsable, dispatch failed).
//
// Emission gate (2.7/3.1 §5-seam precedent): every emit path requires
// getSessionId() and getGameId() to return non-empty strings; otherwise
// the tracker is inert (no events, no timers). Thunks (not
// construction-time values) so §5 can set the IDs later without
// recreating the tracker.
//
// Matching is FIFO on (from, to, promotion) against the 3.1 tracker's
// confirmed entries; entries with null eventId cannot be linked honestly
// and are skipped. Absence of confirmation is never recorded as illegal
// (3.2.6).
// ------------------------------------------------------------------

function createAttemptTracker(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createAttemptTracker options must be an object');
  }
  var emitEvent = options.emitEvent;
  if (typeof emitEvent !== 'function') {
    throw new TypeError('createAttemptTracker emitEvent must be a function');
  }
  var getSessionId = options.getSessionId;
  if (typeof getSessionId !== 'function') {
    throw new TypeError('createAttemptTracker getSessionId must be a function');
  }
  var getGameId = options.getGameId;
  if (typeof getGameId !== 'function') {
    throw new TypeError('createAttemptTracker getGameId must be a function');
  }
  var unconfirmedTimeoutMs = options.unconfirmedTimeoutMs === undefined
    ? 30000 : options.unconfirmedTimeoutMs;
  if (!Number.isInteger(unconfirmedTimeoutMs) || unconfirmedTimeoutMs < 1) {
    throw new TypeError('createAttemptTracker unconfirmedTimeoutMs must be a positive integer');
  }
  var setTimeoutFn = options.setTimeoutFn === undefined
    ? function (fn, ms) { return globalThis.setTimeout(fn, ms); }
    : options.setTimeoutFn;
  var clearTimeoutFn = options.clearTimeoutFn === undefined
    ? function (id) { return globalThis.clearTimeout(id); }
    : options.clearTimeoutFn;
  if (typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') {
    throw new TypeError('createAttemptTracker setTimeoutFn/clearTimeoutFn must be functions');
  }

  var BS = BlindfoldSession;

  // Pending attempts, FIFO by submission order.
  // {attemptEventId, from, to, promotion, timerId}
  var pending = [];

  function isActive() {
    var sid = getSessionId();
    var gid = getGameId();
    return typeof sid === 'string' && sid !== '' &&
           typeof gid === 'string' && gid !== '';
  }

  function eventIdOf(result) {
    return (result && typeof result.eventId === 'string') ? result.eventId : null;
  }

  function findPending(attemptEventId) {
    for (var i = 0; i < pending.length; i++) {
      if (pending[i].attemptEventId === attemptEventId) return i;
    }
    return -1;
  }

  function dropPending(attemptEventId) {
    var i = findPending(attemptEventId);
    if (i === -1) return null;
    var p = pending[i];
    pending.splice(i, 1);
    try {
      clearTimeoutFn(p.timerId);
    } catch (e) {
      // Timer cleanup is best-effort; the attempt is dropped regardless.
    }
    return p;
  }

  function submitAttempt(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('submitAttempt input must be an object');
    }
    var submittedText = input.submittedText;
    var firstEditMonotonicMs = input.firstEditMonotonicMs === undefined
      ? null : input.firstEditMonotonicMs;
    var validation = input.validation;
    var from = input.from === undefined ? null : input.from;
    var to = input.to === undefined ? null : input.to;
    var promotion = input.promotion === undefined ? null : input.promotion;

    if (typeof submittedText !== 'string') {
      throw new TypeError('submitAttempt submittedText must be a string');
    }
    if (firstEditMonotonicMs !== null && typeof firstEditMonotonicMs !== 'number') {
      throw new TypeError('submitAttempt firstEditMonotonicMs must be a number or null');
    }
    if (validation !== 'legal' && validation !== 'illegal') {
      throw new RangeError("submitAttempt validation must be 'legal' or 'illegal'");
    }
    for (var k = 0; k < 3; k++) {
      var sq = [from, to, promotion][k];
      if (sq !== null && typeof sq !== 'string') {
        throw new TypeError('submitAttempt from/to/promotion must be strings or null');
      }
    }

    if (!isActive()) {
      return null;
    }

    var payload = requireValidMoveAttemptPayload({
      submittedText: submittedText,
      firstEditMonotonicMs: firstEditMonotonicMs,
      validation: validation
    });
    var attemptEventId = eventIdOf(emitEvent(BS.MOVE_ATTEMPT_EVENT_TYPE, payload, null));

    // Terminal at birth (3.2.6): illegal-at-submit and unparsable
    // attempts have known outcomes — no timer, no unconfirmed event.
    if (validation === 'legal' && from !== null && to !== null) {
      var timerId = setTimeoutFn(function () {
        onAttemptTimeout(attemptEventId);
      }, unconfirmedTimeoutMs);
      pending.push({
        attemptEventId: attemptEventId,
        from: from,
        to: to,
        promotion: promotion,
        timerId: timerId
      });
    }
    return { attemptEventId: attemptEventId };
  }

  function onAttemptTimeout(attemptEventId) {
    var p = dropPending(attemptEventId);
    if (p === null) {
      return;
    }
    if (!isActive()) {
      return;
    }
    emitEvent(
      BS.MOVE_ATTEMPT_UNCONFIRMED_EVENT_TYPE,
      requireValidAttemptUnconfirmedPayload({ reason: 'timeout' }),
      requireValidAttemptUnconfirmedRefs({ attemptEventId: attemptEventId })
    );
  }

  function noteDispatchStarted(attemptEventId) {
    if (typeof attemptEventId !== 'string') {
      throw new TypeError('noteDispatchStarted attemptEventId must be a string');
    }
    if (!isActive()) {
      return null;
    }
    var dispatchEventId = eventIdOf(emitEvent(
      BS.MOVE_DISPATCH_STARTED_EVENT_TYPE,
      {},
      requireValidDispatchStartedRefs({ attemptEventId: attemptEventId })
    ));
    return { dispatchEventId: dispatchEventId };
  }

  function noteDispatchFailed(attemptEventId, dispatchEventId, failureReason) {
    if (typeof attemptEventId !== 'string') {
      throw new TypeError('noteDispatchFailed attemptEventId must be a string');
    }
    if (BS.DISPATCH_FAILURE_REASONS.indexOf(failureReason) === -1) {
      throw new RangeError('noteDispatchFailed failureReason must be a member of DISPATCH_FAILURE_REASONS');
    }
    // Terminal: the attempt leaves pending (3.2.6) — the failure is the
    // known outcome, not an unconfirmed limbo.
    dropPending(attemptEventId);
    if (!isActive()) {
      return null;
    }
    var failedEventId = eventIdOf(emitEvent(
      BS.MOVE_DISPATCH_FAILED_EVENT_TYPE,
      requireValidDispatchFailedPayload({ failureReason: failureReason }),
      requireValidDispatchFailedRefs({
        attemptEventId: attemptEventId,
        dispatchStartedEventId: dispatchEventId === undefined ? null : dispatchEventId
      })
    ));
    return { eventId: failedEventId };
  }

  function noteConfirmedMoves(confirmedEntries) {
    if (!Array.isArray(confirmedEntries)) {
      throw new TypeError('noteConfirmedMoves confirmedEntries must be an array');
    }
    var matched = [];
    if (!isActive()) {
      return matched;
    }
    for (var i = 0; i < confirmedEntries.length; i++) {
      var entry = confirmedEntries[i];
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      // Null eventId: cannot link honestly (3.2.5) — skip.
      if (entry.eventId === null || entry.eventId === undefined) {
        continue;
      }
      for (var j = 0; j < pending.length; j++) {
        var p = pending[j];
        if (p.from === entry.from && p.to === entry.to &&
            p.promotion === entry.promotion) {
          dropPending(p.attemptEventId);
          emitEvent(
            BS.MOVE_ATTEMPT_MATCHED_EVENT_TYPE,
            {},
            requireValidAttemptMatchedRefs({
              attemptEventId: p.attemptEventId,
              confirmedMoveEventId: entry.eventId
            })
          );
          matched.push({
            attemptEventId: p.attemptEventId,
            confirmedMoveEventId: entry.eventId
          });
          break;
        }
      }
    }
    return matched;
  }

  function markPendingUnconfirmed(reason) {
    var marked = [];
    while (pending.length > 0) {
      var p = pending.shift();
      try {
        clearTimeoutFn(p.timerId);
      } catch (e) {
        // Best-effort.
      }
      marked.push(p.attemptEventId);
      if (isActive()) {
        try {
          emitEvent(
            BS.MOVE_ATTEMPT_UNCONFIRMED_EVENT_TYPE,
            requireValidAttemptUnconfirmedPayload({ reason: reason }),
            requireValidAttemptUnconfirmedRefs({ attemptEventId: p.attemptEventId })
          );
        } catch (e) {
          // 3.2 review SF-1 (NOTE-5): an emit throw must not abort the
          // loop — remaining pending attempts still get marked.
        }
      }
    }
    return marked;
  }

  function handleGameReset() {
    return markPendingUnconfirmed('game_reset');
  }

  function handlePageHide() {
    // Best-effort (2.7 philosophy): never throws into page code.
    try {
      return markPendingUnconfirmed('pagehide');
    } catch (e) {
      return [];
    }
  }

  function pendingCount() {
    return pending.length;
  }

  return {
    submitAttempt: submitAttempt,
    noteDispatchStarted: noteDispatchStarted,
    noteDispatchFailed: noteDispatchFailed,
    noteConfirmedMoves: noteConfirmedMoves,
    handleGameReset: handleGameReset,
    handlePageHide: handlePageHide,
    pendingCount: pendingCount
  };
}

BlindfoldSession.createAttemptTracker = createAttemptTracker;

// ------------------------------------------------------------------
// Task 3.3: createVisibilityRecorder — 3.3.1/3.3.2 piece-visibility
// transitions and 3.3.3 help-shortcut requests.
//
// DOM-free; content.js wires it to setPieceSet and the w/m/z/i/s key
// handlers. Emission is gated on non-empty sessionId AND gameId via
// thunks (2.7/3.1/3.2 §5-seam precedent) — pre-§5 the recorder is inert:
// no events, no throw. The returned eventIds are the stable references
// 3.4.1 will link utterances to.
function createVisibilityRecorder(options) {
  var opts = options || {};
  var getSessionId = opts.getSessionId;
  var getGameId = opts.getGameId;
  var getPieceSet = opts.getPieceSet;
  var emitEvent = opts.emitEvent;
  var BS = BlindfoldSession;
  if (typeof getSessionId !== 'function') {
    throw new TypeError('createVisibilityRecorder getSessionId must be a function');
  }
  if (typeof getGameId !== 'function') {
    throw new TypeError('createVisibilityRecorder getGameId must be a function');
  }
  if (typeof getPieceSet !== 'function') {
    throw new TypeError('createVisibilityRecorder getPieceSet must be a function');
  }
  if (typeof emitEvent !== 'function') {
    throw new TypeError('createVisibilityRecorder emitEvent must be a function');
  }

  function isActive() {
    var sid = getSessionId();
    var gid = getGameId();
    return typeof sid === 'string' && sid !== '' &&
           typeof gid === 'string' && gid !== '';
  }

  function eventIdOf(result) {
    return (result && typeof result.eventId === 'string') ? result.eventId : null;
  }

  // 3.3.2: a reveal/hide transition. from === to is a no-op returning
  // null: no state change, no event (a same-mode setPieceSet call emits
  // nothing; the observePieceRenders re-application path never calls
  // setPieceSet at all).
  function recordTransition(from, to, source) {
    var payload = requireValidPieceVisibilityChangedPayload({
      from: from, to: to, source: source
    });
    if (from === to) {
      return null;
    }
    if (!isActive()) {
      return null;
    }
    return eventIdOf(emitEvent(BS.PIECE_VISIBILITY_CHANGED_EVENT_TYPE, payload, null));
  }

  // 3.3.1: the initial-state record. from is null by contract; the
  // current piece set is read at call time.
  function recordInitial(source) {
    return recordTransition(null, getPieceSet(), source);
  }

  // 3.3.3: a spoken-assistance shortcut request. Records the request
  // itself (content-less requests record hadUsableContent: false — the
  // request happened; the absence of content is the honest record). The
  // utterance lifecycle is 3.4's scope.
  function recordHelpRequest(shortcut, hadUsableContent) {
    var payload = requireValidHelpRequestedPayload({
      shortcut: shortcut, hadUsableContent: hadUsableContent
    });
    if (!isActive()) {
      return null;
    }
    return eventIdOf(emitEvent(BS.HELP_REQUESTED_EVENT_TYPE, payload, null));
  }

  return {
    recordTransition: recordTransition,
    recordInitial: recordInitial,
    recordHelpRequest: recordHelpRequest,
    isActive: isActive
  };
}

BlindfoldSession.createVisibilityRecorder = createVisibilityRecorder;

// ------------------------------------------------------------------
// 3.5 payload/refs validators (exact keys; TypeError/RangeError per
// the AGENTS.md convention).
// ------------------------------------------------------------------

// 3.5.1: raw document state only. The honest naming (document state, not
// a claim about the player's state of mind) is the mechanism for
// "without treating them as proof of a cognitive pause" — see the
// recorder docs below.
function requireValidDocumentVisibilityChangedPayload(payload) {
  requireExactKeys(payload, ['visibilityState', 'focused'],
    'document_visibility_changed payload');
  if (payload.visibilityState !== 'visible' && payload.visibilityState !== 'hidden') {
    throw new RangeError("document_visibility_changed payload.visibilityState must be 'visible' or 'hidden'");
  }
  if (typeof payload.focused !== 'boolean') {
    throw new TypeError('document_visibility_changed payload.focused must be a boolean');
  }
  return payload;
}

// 3.5.2: the 3.1 suspect-threshold detection, now recorded.
function requireValidGameResetPayload(payload) {
  requireExactKeys(payload, ['detection', 'confirmedMoveCount'],
    'game_reset payload');
  if (payload.detection !== 'suspect_threshold') {
    throw new RangeError("game_reset payload.detection must be 'suspect_threshold'");
  }
  if (!Number.isInteger(payload.confirmedMoveCount) || payload.confirmedMoveCount < 0) {
    throw new RangeError('game_reset payload.confirmedMoveCount must be an integer >= 0');
  }
  return payload;
}

// 3.5.3/3.5.4: game endings live in 1.4's game_ended schema
// ({result, terminationReason, evidenceSource, observedText},
// game_records.js). 3.5 must NOT define its own game_ended payload
// validator here — a same-named requireValidGameEndedPayload once
// shadowed 1.4's on the merged namespace (3.5 SF-1, repaired). The
// recorder binds 1.4's factory via sharedBS() (3.1 precedent).

// Sparse refs: exactly one terminalMoveEventId, or null refs when there
// is no confirmed move to link (e.g. Stop before any move). Refs are an
// envelope (1.3) concept, not part of 1.4's payload schema.
function requireValidGameEndedRefs(refs) {
  if (refs === null || refs === undefined) {
    return null;
  }
  requireExactKeys(refs, ['terminalMoveEventId'], 'game_ended refs');
  requireUuidV4(refs.terminalMoveEventId, 'game_ended refs.terminalMoveEventId');
  return refs;
}

BlindfoldSession.requireValidDocumentVisibilityChangedPayload = requireValidDocumentVisibilityChangedPayload;
BlindfoldSession.requireValidGameResetPayload = requireValidGameResetPayload;
BlindfoldSession.requireValidGameEndedRefs = requireValidGameEndedRefs;

// 3.5.3 (chess_rules source): map the internal board's terminal state to
// 1.4's TERMINATION_REASONS vocabulary (game_records.js). Mirrors
// getResultAnnouncement's conditions (sounds.js); in_draw() with
// stalemate/threefold/insufficient excluded is the fifty-move rule by
// elimination. Returns null when the game is not over. Covered by 3.4.4's
// SPEECH_LOGIC_VERSION bump rule: these conditions are the same
// derivation getResultAnnouncement versions.
function chessRulesTermination(game) {
  if (!game || typeof game.game_over !== 'function' || !game.game_over()) {
    return null;
  }
  if (game.in_checkmate()) return 'checkmate';
  if (game.in_stalemate()) return 'stalemate';
  if (game.in_threefold_repetition()) return 'draw_threefold';
  if (game.insufficient_material()) return 'draw_insufficient_material';
  if (game.in_draw()) return 'draw_fifty_move';
  // Defensive: chess.js enumerates its terminal states; reaching here
  // means an unrecognized terminal state. The caller records 1.4's
  // honest unknown record (result '*', terminationReason null).
  return null;
}

BlindfoldSession.chessRulesTermination = chessRulesTermination;

// 3.5.3 (chess_rules source): PGN result from the terminal board.
// Mirrors getResultAnnouncement's winner logic (sounds.js): checkmate
// with the side to move mated means the other side won.
function chessRulesResult(game) {
  if (game.in_checkmate()) {
    return game.turn() === 'w' ? '0-1' : '1-0';
  }
  return '1/2-1/2';
}

BlindfoldSession.chessRulesResult = chessRulesResult;

// ------------------------------------------------------------------
// Task 3.5: createGameLifecycleRecorder — 3.5.1 document visibility/focus,
// 3.5.2 game resets, 3.5.3/3.5.4 game endings in 1.4's game_ended schema
// (game_records.js; 3.5 SF-1: this recorder does not own game_ended).
//
// DOM-free; content.js wires it to visibilitychange/focus/blur listeners,
// 3.1's onGameReset, and the observeMoves callback region (chess_rules
// source). Emission is gated on non-empty sessionId AND gameId via thunks
// (2.7/3.1/3.2/3.3 §5-seam precedent) — pre-§5 the recorder is inert: no
// events, no throw. All recorder calls from DOM listeners must be wrapped
// in try/catch by the caller (3.2 SF-1 precedent): instrumentation must
// never break the page.
//
// Explicitly NOT duplicated here (contract §1): page_start/page_end_clean
// (2.7), history_revised takebacks/corrections (3.1.4), page reloads (2.7).
//
// 3.5.1 honesty: these events record DOCUMENT STATE ONLY. They do not
// imply, and must not be interpreted as, a cognitive pause, attention
// shift, or player absence.
// ------------------------------------------------------------------
function createGameLifecycleRecorder(options) {
  var opts = options || {};
  var getSessionId = opts.getSessionId;
  var getGameId = opts.getGameId;
  var emitEvent = opts.emitEvent;
  var BS = BlindfoldSession;
  if (typeof getSessionId !== 'function') {
    throw new TypeError('createGameLifecycleRecorder getSessionId must be a function');
  }
  if (typeof getGameId !== 'function') {
    throw new TypeError('createGameLifecycleRecorder getGameId must be a function');
  }
  if (typeof emitEvent !== 'function') {
    throw new TypeError('createGameLifecycleRecorder emitEvent must be a function');
  }

  // 1.4 owns the game_ended schema (game_records.js): bind its factory
  // at creation time (sharedBS, 3.1 precedent). The 3.5 recorder never
  // redefines the schema — a same-named validator here once shadowed
  // 1.4's on the merged namespace (3.5 SF-1, repaired).
  var NS14 = sharedBS();

  // Per-source idempotency for this recorder instance (§5 creates one
  // recorder per session; resetEnded() re-arms for a new game). Multiple
  // game_ended events per game are permitted ACROSS sources (1.4's
  // consumer contract: consumers take the latest by occurrence time);
  // each source records at most once per game.
  var endedBySource = { chess_rules: false, chesscom_dialog: false, stop: false };

  function isActive() {
    var sid = getSessionId();
    var gid = getGameId();
    return typeof sid === 'string' && sid !== '' &&
           typeof gid === 'string' && gid !== '';
  }

  function eventIdOf(result) {
    return (result && typeof result.eventId === 'string') ? result.eventId : null;
  }

  // 3.5.1: record raw document state at emit time. No debouncing, no
  // aggregation — raw observations only.
  function recordVisibilityChange(visibilityState, focused) {
    var payload = requireValidDocumentVisibilityChangedPayload({
      visibilityState: visibilityState, focused: focused
    });
    if (!isActive()) {
      return null;
    }
    return eventIdOf(emitEvent(BS.DOCUMENT_VISIBILITY_CHANGED_EVENT_TYPE, payload, null));
  }

  // 3.5.2: the 3.1 detection, now recorded. Called from 3.1's
  // onGameReset (which receives { confirmedMoveCount }).
  function recordGameReset(confirmedMoveCount) {
    var payload = requireValidGameResetPayload({
      detection: 'suspect_threshold', confirmedMoveCount: confirmedMoveCount
    });
    if (!isActive()) {
      return null;
    }
    return eventIdOf(emitEvent(BS.GAME_RESET_EVENT_TYPE, payload, null));
  }

  // 3.5.3/3.5.4: record a game ending in 1.4's game_ended schema.
  // source: recorder-internal dedup key ('chess_rules' |
  // 'chesscom_dialog' | 'stop'; never persisted). input: 1.4's payload
  // shape ({result, terminationReason, evidenceSource, observedText}),
  // validated by 1.4's factory (fail-fast, 3.3 precedent — validation
  // runs even when this source already ended the game or the recorder is
  // inert). terminalMoveEventId links the last confirmed move (null
  // refs when there is none).
  function recordGameEnded(source, input, terminalMoveEventId) {
    if (BS.GAME_END_SOURCES.indexOf(source) === -1) {
      throw new RangeError(
        "recordGameEnded source must be one of: 'chess_rules', 'chesscom_dialog', 'stop'");
    }
    var payload = NS14.createGameEndedPayload(input || {});
    var refs = (terminalMoveEventId === null || terminalMoveEventId === undefined)
      ? null
      : requireValidGameEndedRefs({ terminalMoveEventId: terminalMoveEventId });
    if (endedBySource[source]) {
      return null;
    }
    if (!isActive()) {
      return null;
    }
    var id = eventIdOf(emitEvent(NS14.GAME_ENDED_EVENT_TYPE, payload, refs));
    if (id !== null) {
      endedBySource[source] = true;
    }
    return id;
  }

  // 3.5.3 (chess_rules source): derive the 1.4 game_ended input from the
  // terminal board. Returns null when the game is not over (nothing to
  // record). An unrecognized terminal state records 1.4's honest unknown
  // record (result '*', terminationReason null).
  function recordChessRulesEnded(game, terminalMoveEventId) {
    if (!game || typeof game.game_over !== 'function' || !game.game_over()) {
      return null;
    }
    var termination = chessRulesTermination(game);
    var input = termination === null
      ? { result: '*', terminationReason: null,
          evidenceSource: 'observed', observedText: null }
      : { result: chessRulesResult(game), terminationReason: termination,
          evidenceSource: 'observed', observedText: null };
    return recordGameEnded('chess_rules', input, terminalMoveEventId);
  }

  // 3.5.3 (chesscom_dialog source, §7): Chess.com's game-over dialog.
  // Designed but unwired — no verified selector today (3.3.4 precedent).
  // evidenceSource is forced to 'observed'; observedText carries the raw
  // evidence (the exact string Chess.com displayed, per 1.4.5's design).
  function recordDialogEnded(input, terminalMoveEventId) {
    var full = Object.assign({}, input || {}, { evidenceSource: 'observed' });
    return recordGameEnded('chesscom_dialog', full, terminalMoveEventId);
  }

  // 3.5.4: §5 Stop seam. reason: 1.4 TERMINATION_REASONS member or null
  // (null = unknown, 1.2's unknown convention; PLAN §7 suggests
  // 'abandoned'/'resignation'). result: PGN result or '*' (default '*').
  // evidenceSource is always 'manual'. Subject to per-source idempotency:
  // a manual Stop completion is a SEPARATE game_ended from an earlier
  // auto-detection (1.4's consumer contract: multiple permitted, latest
  // by occurrence time wins).
  function recordStopTermination(reason, result) {
    return recordGameEnded('stop', {
      result: (result === undefined || result === null) ? '*' : result,
      terminationReason: (reason === undefined) ? null : reason,
      evidenceSource: 'manual',
      observedText: null
    }, null);
  }

  // Re-arm per-source idempotency for a new game (§5 calls this when it
  // mints a new game identity).
  function resetEnded() {
    endedBySource.chess_rules = false;
    endedBySource.chesscom_dialog = false;
    endedBySource.stop = false;
  }

  return {
    recordVisibilityChange: recordVisibilityChange,
    recordGameReset: recordGameReset,
    recordGameEnded: recordGameEnded,
    recordChessRulesEnded: recordChessRulesEnded,
    recordDialogEnded: recordDialogEnded,
    recordStopTermination: recordStopTermination,
    resetEnded: resetEnded,
    isActive: isActive
  };
}

BlindfoldSession.createGameLifecycleRecorder = createGameLifecycleRecorder;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}