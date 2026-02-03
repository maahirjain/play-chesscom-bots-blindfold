const illegal_move_audio = new Audio(chrome.runtime.getURL("illegal_move.wav"));
illegal_move_audio.preload = "auto";

function playIllegalMoveSound() {
    illegal_move_audio.currentTime = 0;
    illegal_move_audio.play().catch(() => {});
}

function speakText(text) {
  if (!("speechSynthesis" in window)) return;

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.volume = 1;

  window.speechSynthesis.speak(utterance);
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

function announceResultIfOver() {
    const text = getResultAnnouncement(game);
    if (!text) return;
    speakText(text);
}