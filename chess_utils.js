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
    const move_squares = parseMoveSquares(game, move);
    if (!move_squares) return false;

    const board = getBoardElement();
    if (!board) return false;

    const fromXY = squareToXY(board, move_squares.from);
    const toXY = squareToXY(board, move_squares.to);
    if (!fromXY || !toXY) return false;

    const moving_color = game.turn();

    clickElementAt(board, fromXY.x, fromXY.y);
    await sleep(30);
    clickElementAt(board, toXY.x, toXY.y);

    if (move_squares.promotion) {
        const promotion_handled = await handlePromotionIfNeeded(move_squares.promotion, moving_color);
        if (!promotion_handled) return false;
    }

    return true;
}

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
    if (!promotion_letter) return true;

    const promotion_window = await waitForVisiblePromotionWindow();
    if (!promotion_window) return false;

    const piece_class = moving_color + promotion_letter;
    const choice = promotion_window.querySelector(`.promotion-piece.${piece_class}`);
    if (!choice) return false;

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
      confirmed = [];
      suspectCount = 0;
      desyncCount = 0;
      onGameReset();
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}