const illegal_move_audio = new Audio(chrome.runtime.getURL("illegal_move.wav"));
illegal_move_audio.preload = "auto";

function playIllegalMoveSound() {
    illegal_move_audio.currentTime = 0;
    illegal_move_audio.play().catch(() => {});
}

function speakText(text, { interrupt = false } = {}) {
  if (!("speechSynthesis" in window)) return;

  if (interrupt) speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.volume = 1;

  speechSynthesis.speak(utterance);
}

function announceResultIfOver() {
    const text = getResultAnnouncement(game);
    if (!text) return;
    speakText(text);
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
    speakText(spoken_move_text, { interrupt: true });
}

function sanToSpeech(game_before_move, san_move) {
  if (!san_move) return "";

  const game_copy = new Chess(game_before_move.fen());
  const move = game_copy.move(san_move);

  if (!move) return String(san_move).split("").join(" ");

  if (move.san === "O-O") return "castle king side";
  if (move.san === "O-O-O") return "castle queen side";

  const parts = [];

  const is_capture = !!move.captured;
  const to_sq = squareToSpeech(move.to);

  if (move.piece === "p") {
    if (is_capture) {
      const from_file = move.from[0];
      parts.push(`${from_file} takes ${to_sq}`);

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
    case "p": return "pawn";
    case "n": return "knight";
    case "b": return "bishop";
    case "r": return "rook";
    case "q": return "queen";
    case "k": return "king";
    default: return "";
  }
}

function squareToSpeech(square) {
  if (!square || square.length !== 2) return String(square || "");
  return `${square[0]} ${square[1]}`;
}

function getDisambiguation(move) {
    if (!move || !move.from || !move.to || !move.san) return "";

    const from_file = move.from[0];
    const from_rank = move.from[1];

    let raw = move.san;

    raw = raw.replace(/[+#]$/, "");           
    raw = raw.replace(/=[NBRQ]/, "");        
    raw = raw.replace("x", "");              
    raw = raw.replace(/^[NBRQK]/, "");       
    raw = raw.replace(move.to, "");            

    if (raw === from_file) return `${from_file} `;
    if (raw === from_rank) return `${from_rank} `;
    if (raw === from_file + from_rank) return `${from_file} ${from_rank} `;
    return "";
}
