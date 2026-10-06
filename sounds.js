let last_spoken_move_text = null;
let speech_timestamp = 0;
let current_utterance = null;

const illegal_move_audio = new Audio(chrome.runtime.getURL("illegal_move.wav"));
illegal_move_audio.preload = "auto";

function playIllegalMoveSound() {
  illegal_move_audio.currentTime = 0;
  illegal_move_audio.play().catch(() => {});
}

function speakText(text, { interrupt = true, rate = 1 } = {}) {
  if (!("speechSynthesis" in window)) return;
  if (!text) return;
  if (interrupt) speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  current_utterance = utterance;

  utterance.rate = rate;
  utterance.pitch = 1;
  utterance.volume = 1;

  speechSynthesis.speak(utterance);
}

function speakTextAsync(text, { interrupt = false, rate = 1 } = {}) {
  return new Promise((resolve) => {
    if (!text) return resolve();
    if (interrupt) speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(String(text));
    current_utterance = utterance;
    utterance.rate = rate;

    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();

    speechSynthesis.speak(utterance);
  });
}

function announceResultIfOver() {
  const text = getResultAnnouncement(game);
  if (!text) return;
  speakText(text, { interrupt: false });
}

function getResultAnnouncement(game) {
  if (!game.game_over()) return null;

  if (game.in_checkmate()) {
    const winner = game.turn() === "w" ? "Black" : "White";
    return `Checkmate. ${winner} wins.`;
  }

  if (game.in_stalemate()) return "Draw by stalemate.";
  if (game.in_threefold_repetition()) return "Draw by threefold repetition.";
  if (game.insufficient_material()) return "Draw by insufficient material.";

  if (game.in_draw()) return "Draw.";
  return "Game over.";
}

function sayMove(game_before_move, san_move) {
  if (!san_move) return;
  const spoken_move_text = sanToSpeech(game_before_move, san_move);
  if (!spoken_move_text) return;
  last_spoken_move_text = spoken_move_text;
  speakText(spoken_move_text, { interrupt: true });
}

function sanToSpeech(game_before_move, san_move) {
  if (!san_move) return "";

  const game_copy = new Chess(game_before_move.fen());
  const move = game_copy.move(san_move);

  if (!move) return String(san_move).split("").join(". ");

  if (move.san === "O-O") return "castle king side";
  if (move.san === "O-O-O") return "castle queen side";

  const parts = [];

  const is_capture = !!move.captured;
  const to_sq = squareToSpeech(move.to);

  if (move.piece === "p") {
    if (is_capture) {
      const from_file = move.from[0];
      parts.push(`${from_file}. takes ${to_sq}`);

      if (move.flags && move.flags.includes("e")) {
        parts.push("en passant");
      }
    } else {
      parts.push(`${to_sq}`);
    }
  } else {
    const piece = pieceLetterToName(move.piece);
    const disambiguation = getDisambiguation(move);

    if (is_capture) parts.push(`${piece} ${disambiguation}takes ${to_sq}`);
    else parts.push(`${piece} ${disambiguation}to ${to_sq}`);
  }

  if (move.promotion) {
    const promo = pieceLetterToName(move.promotion);
    parts.push(`promotes to ${promo}`);
  }

  if (move.san.includes("#")) parts.push("checkmate");
  else if (move.san.includes("+")) parts.push("check");

  return parts.join(", ").replace(/\s+/g, " ").trim();
}

function pieceLetterToName(letter) {
  switch (letter) {
    case "p":
      return "pawn";
    case "n":
      return "knight";
    case "b":
      return "bishop";
    case "r":
      return "rook";
    case "q":
      return "queen";
    case "k":
      return "king";
    default:
      return "piece";
  }
}

function squareToSpeech(square) {
  if (!square || square.length !== 2) return String(square || "");
  return `${square[0]}. ${square[1]}`;
}

function getDisambiguation(move) {
  if (!move || !move.from || !move.to || !move.san) return "";

  const from_file = move.from[0];
  const from_rank = move.from[1];

  let raw = move.san;

  raw = raw.replace(/[+#]$/, "");
  raw = raw.replace(/=[NBRQ]/, "");
  raw = raw.replace(/x/g, "");
  raw = raw.replace(/^[NBRQK]/, "");
  raw = raw.replace(move.to, "");

  if (raw === from_file) return `${from_file} `;
  if (raw === from_rank) return `${from_rank} `;
  if (raw === from_file + from_rank) return `${from_file} ${from_rank} `;
  return "";
}

async function speakFullMoveList(half_moves) {
  if (!half_moves || half_moves.length === 0) {
    speakText("No moves yet.", { interrupt: true });
    return;
  }

  speech_timestamp = speech_timestamp + 1;
  const timestamp = speech_timestamp;

  const temp_game = new Chess();
  const lines = ["Move list:"];

  for (let i = 0; i < half_moves.length; i += 2) {
    const move_num = Math.floor(i / 2) + 1;

    const white_move = half_moves[i];
    const white_move_text = white_move
      ? sanToSpeech(temp_game, white_move)
      : "";
    if (white_move) temp_game.move(white_move);

    const black_move = half_moves[i + 1];
    const black_move_text = black_move
      ? sanToSpeech(temp_game, black_move)
      : "";
    if (black_move) temp_game.move(black_move);

    let line = `${move_num}. ${white_move_text}.`;
    if (black_move) {
      line += `. ${black_move_text}.`;
    }
    lines.push(line);
  }

  await speakTextAsync(lines[0], { interrupt: true, rate: 0.9 });
  if (timestamp !== speech_timestamp) return;

  for (let i = 1; i < lines.length; i++) {
    await speakTextAsync(lines[i], { interrupt: false, rate: 0.9 });
    if (timestamp !== speech_timestamp) return;
  }
}

function stopAllSpeech() {
  speech_timestamp = speech_timestamp + 1;
  speechSynthesis.cancel();
}
function getPieceCodeFromClassList(class_list) {
  for (const c of class_list) {
    if (/^[wb][prnbqk]$/.test(c)) return c;
  }
  return null;
}

function getSquareClassFromClassList(class_list) {
  for (const c of class_list) {
    if (/^square-\d\d$/.test(c)) return c;
  }
  return null;
}

function squareClassToSquare(square_class) {
  const square_match = /^square-(\d)(\d)$/.exec(square_class);
  if (!square_match) return null;
  const file = digitToFile(square_match[1]);
  const rank = square_match[2];
  return file + rank;
}

function digitToFile(digit) {
  return "abcdefgh"[Number(digit) - 1] || "?";
}

function getSquaresSpokenText(squares) {
  const spoken_squares = squares.map(squareToSpeech);
  if (spoken_squares.length == 0) return "";
  if (spoken_squares.length == 1) return spoken_squares[0];
  if (spoken_squares.length == 2) return `${spoken_squares[0]} and ${spoken_squares[1]}`;
  return `${spoken_squares.slice(0, -1).join(", ")}, and ${spoken_squares[spoken_squares.length - 1]}`
}

function pluralizePiece(name, count) {
  if (count == 1) return name;
  return `${name}s`;
}

function readPiecesFromBoardDOM() {
  let board = document.querySelector("#board-primary");
  if (!board) board = document.querySelector("#board-play-computer");
  if (!board) return null;

  const piece_elements = board.querySelectorAll(".piece");

  const piece_squares = {
    w: { k: [], p: [], n: [], b: [], r: [], q: [] },
    b: { k: [], p: [], n: [], b: [], r: [], q: [] }
  };

  for (const piece_element of piece_elements) {
    const piece_code = getPieceCodeFromClassList(piece_element.classList);
    const square_class = getSquareClassFromClassList(piece_element.classList);
    if (!piece_code || !square_class) continue;

    const color = piece_code[0];
    const type = piece_code[1];
    const square = squareClassToSquare(square_class);
    if (!square) continue;

    piece_squares[color][type].push(square);
  }

  for (const color of ["w", "b"]) {
    for (const type of Object.keys(piece_squares[color])) {
      piece_squares[color][type].sort();
    }
  }

  return piece_squares;
}

function piecesToSpeechText(side_piece_squares, side) {
  const pieces = ["k", "p", "n", "b", "r", "q"];
  const parts = [];

  for (const piece of pieces) {
    const squares = side_piece_squares[piece];
    if (!squares || squares.length === 0) continue;

    const piece_name = pieceLetterToName(piece);
    const pluralized_piece_name = pluralizePiece(piece_name, squares.length);
    parts.push(`${pluralized_piece_name} on ${getSquaresSpokenText(squares)}`);
  }

  if (parts.length === 0) return `${side} pieces: None.`;
  return `${side} pieces: ${parts.join("; ")}`;
}

function positionToSpeechText() {
  const data = readPiecesFromBoardDOM();
  if (!data) return "Board not found.";

  const white_pieces_speech = piecesToSpeechText(data.w, "White");
  const black_pieces_speech = piecesToSpeechText(data.b, "Black");

  return `${black_pieces_speech}. ${white_pieces_speech}`;
}

function speakPosition() {
  speakText(positionToSpeechText(), { interrupt: true, rate: 0.7 });
}
