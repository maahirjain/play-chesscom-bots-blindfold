const game = new Chess();
let game_half_move_count = 0;

observeMoves((half_moves) => {
  game_half_move_count = updateGame(game, game_half_move_count, half_moves);
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
            const move = normalizeMove(move_input.value);
            move_input.value = "";
            if (!move) return;

            if (isMoveLegal(game, move)) {
                move_input.style.borderColor = "green";
                makeMoveOnBoard(game, move);
            } else {
                move_input.style.borderColor = "red";
            }
        }
    })

    move_input.addEventListener("input", () => {
        move_input.style.borderColor = "";
    })
}

document.addEventListener("keydown", (e) => {
    if (e.key == "s" || e.key == "S") {
        e.preventDefault();

        const move_input = document.getElementById("blindfold-chess-move-input");
        if (!move_input) return;
        
        move_input.focus();
        move_input.style.borderColor = "";
    }
})