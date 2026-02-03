const illegal_move_audio = new Audio(chrome.runtime.getURL("illegal_move.wav"));
illegal_move_audio.preload = "auto";

function playIllegalMoveSound() {
    illegal_move_audio.currentTime = 0;
    illegal_move_audio.play().catch(() => {});
}