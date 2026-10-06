BlindfoldSession.sender = BlindfoldSession.createSender();
BlindfoldSession.installPageEndHook(BlindfoldSession.sender);

// Task 3.1 (PLAN.md §3.1): confirmed-history tracker. Owns the stable
// Chess instance (sounds.js's bare `game` references keep working via
// getGame()). Until §5 mints game identities, activeGameId is null →
// track-but-don't-emit: gameplay works, recording waits for §5.
const historyTracker = BlindfoldSession.createHistoryTracker({
  gameId: BlindfoldSession.activeGameId || null,
  emitEvent: (eventType, payload, refs) =>
    BlindfoldSession.sender.emit({
      eventType,
      sessionId: BlindfoldSession.activeSessionId,
      gameId: BlindfoldSession.activeGameId,
      payload,
      refs: refs || null,
    }),
  onGameReset: () => { /* §5: mint new game identity + install new tracker */ },
});
const game = historyTracker.getGame();
let latest_half_moves = [];

const PIECESET_KEY = "blindfold_chess_piece_set";
let piece_set = localStorage.getItem(PIECESET_KEY) || "neo";

applyCurrentPieceSet();

observeMoves((half_moves) => {
  latest_half_moves = half_moves;
  const result = historyTracker.observe(half_moves);
  // Speak each newly confirmed move in order (interrupt keeps the latest
  // audible). preFen is the in-memory pre-move FEN — never persisted.
  for (const m of result.confirmed) {
    sayMove(new Chess(m.preFen), m.san);
  }
  applyCurrentPieceSet();
  announceResultIfOver();
});

observePieceRenders(() => {
  applyCurrentPieceSet();
});

if (!document.getElementById("blindfold-chess-move-input")) {
    const move_input = document.createElement("input");
    move_input.id = "blindfold-chess-move-input";
    move_input.type = "text";
    move_input.autocomplete = "off";
    move_input.spellcheck = false;

    const player_bottom = document.getElementById("player-bottom");
    const player_bottom_row_component = player_bottom.querySelector(".player-row-component");
    player_bottom_row_component.appendChild(move_input);

    move_input.addEventListener("keydown", (e) => {
        if (e.key == "Enter") {
            const move = normalizeMove(game, move_input.value);
            move_input.value = "";

            if (isMoveLegal(game, move)) {
                move_input.style.borderColor = "green";
                makeMoveOnBoard(game, move);
            } else {
                move_input.style.borderColor = "red";
                playIllegalMoveSound();
            }
        }
    })

    move_input.addEventListener("input", () => {
        move_input.style.borderColor = "";
    })
}

// Task 2.8 (PLAN.md §2.8): recorder-health indicator. Installed after the
// move input exists so it anchors adjacent to it (fixed-corner fallback
// otherwise). Never throws into page code.
BlindfoldSession.installStatusIndicator(BlindfoldSession.sender);

document.addEventListener("keydown", (e) => {
    if (e.key == "j" || e.key == "J") {
        e.preventDefault();

        const move_input = document.getElementById("blindfold-chess-move-input");
        if (!move_input) return;
        
        move_input.focus();
        move_input.style.borderColor = "";
    }
})

document.addEventListener("keydown", (e) => {
    if (e.key == "v" || e.key == "V") {
        e.preventDefault();
        setPieceSet(piece_set === "blindfold" ? "neo" : "blindfold");
    }
})

document.addEventListener("keydown", (e) => {
  if (e.key === "w" || e.key === "W") {
    e.preventDefault();

    const turn = game.turn();
    speakText(turn === "w" ? "White's turn" : "Black's turn", { interrupt: true });
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "m" || e.key === "M") {
    e.preventDefault();

    const text = getResultAnnouncement(game);
    speakText(text || "Game not over.", { interrupt: false });
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "z" || e.key === "Z") {
    e.preventDefault();

    if (last_spoken_move_text) {
      speakText(`Last move: ${last_spoken_move_text}`, { interrupt: true });
    }
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "i" || e.key === "I") {
    e.preventDefault();
    speakFullMoveList(latest_half_moves);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    stopAllSpeech();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "s" || e.key === "S") {
    e.preventDefault();
    speakPosition();
  }
});

function applyCurrentPieceSet() {
    const base_url = piece_set === "blindfold" ? BLINDFOLD_PIECESET_BASE : NEO_PIECESET_BASE;
    applyPieceSet(base_url);
}

function setPieceSet(mode) {
    piece_set = mode;
    localStorage.setItem(PIECESET_KEY, piece_set);
    applyCurrentPieceSet();
}