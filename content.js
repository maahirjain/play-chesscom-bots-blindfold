const game = new Chess();
let game_half_move_count = 0;

observeMoves((half_moves) => {
  updateGame(half_moves);
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
            const move = move_input.value.trim();
            move_input.value = "";
            if (!move) return;
        }
    })
}

document.addEventListener("keydown", (e) => {
    if (e.key == "s" || e.key == "S") {
        e.preventDefault();

        const move_input = document.getElementById("blindfold-chess-move-input");
        move_input?.focus();
    }
})

function updateGame(half_moves) {
    if (half_moves.length < game_half_move_count) {
        game.reset();
        game_half_move_count = 0;
    }

    for (let half_move_index = game_half_move_count; half_move_index < half_moves.length; half_move_index++) {
        game.move(half_moves[half_move_index], { sloppy: true });
        game_half_move_count++;
    }
}