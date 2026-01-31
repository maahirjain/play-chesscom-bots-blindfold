console.log("Blindfolded chess")

if (!document.getElementById("blindfold-chess-move-input")) {
    const move_input = document.createElement("input");
    move_input.id = "blindfold-chess-move-input";
    move_input.type = "text";
    move_input.autocomplete = "off";
    move_input.spellcheck = false;

    const player_bottom = document.getElementById("player-bottom");
    const player_bottom_row_component = player_bottom.querySelector(".player-row-component");
    player_bottom_row_component.appendChild(move_input);
}

document.addEventListener("keydown", (e) => {
    if (e.key == "s" || e.key == "S") {
        e.preventDefault();
        
        const move_input = document.getElementById("blindfold-chess-move-input");
        move_input.focus();
    }
})