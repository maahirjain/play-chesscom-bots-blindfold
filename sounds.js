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