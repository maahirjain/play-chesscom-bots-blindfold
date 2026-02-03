const game = new Chess();
let game_half_move_count = 0;

const PIECESET_KEY = "blindfold_chess_piece_set";
let piece_set = localStorage.getItem(PIECESET_KEY) || "neo";

applyCurrentPieceSet();

observeMoves((half_moves) => {
  sayMove(game, half_moves[game_half_move_count]);
  game_half_move_count = updateGame(game, game_half_move_count, half_moves);
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
    speakText(turn === "w" ? "White's turn" : "Black's turn");
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "m" || e.key === "M") {
    e.preventDefault();

    const text = getResultAnnouncement(game);
    speakText(text || "Game not over.");
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

function applyCurrentPieceSet() {
    const base_url = piece_set === "blindfold" ? BLINDFOLD_PIECESET_BASE : NEO_PIECESET_BASE;
    applyPieceSet(base_url);
}

function setPieceSet(mode) {
    piece_set = mode;
    localStorage.setItem(PIECESET_KEY, piece_set);
    applyCurrentPieceSet();
}