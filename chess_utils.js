const BLINDFOLD_PIECESET_BASE = "https://images.chesscomfiles.com/chess-themes/pieces/blindfold/150/";
const NEO_PIECESET_BASE = "https://assets-themes.chess.com/image/ejgfv/150/";

function observeMoves(onMoveListChange) {
    let number_of_half_moves = -1;

    const checkMoves = () => {
        const half_moves = getMoveList();
        if (half_moves.length !== number_of_half_moves) {
            number_of_half_moves = half_moves.length;
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

function updateGame(game, game_half_move_count, half_moves) {
    if (half_moves.length < game_half_move_count) {
        game.reset();
        game_half_move_count = 0;
    }

    for (let half_move_index = game_half_move_count; half_move_index < half_moves.length; half_move_index++) {
        game.move(half_moves[half_move_index]);
        game_half_move_count++;
    }

    return game_half_move_count;
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