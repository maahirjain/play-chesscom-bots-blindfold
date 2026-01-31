function observeMoves(onMoveListChange) {
    let number_of_half_moves = -1;

    const checkMoves = () => {
        const half_moves = getMoveList();
        if (half_moves.length !== number_of_half_moves) {
            number_of_half_moves = half_moves.length;
            onMoveListChange(half_moves);
        } 
    }

    const observer = new MutationObserver(checkMoves);
    observer.observe(document.body, { childList: true, subtree: true });

    checkMoves();
}

function getMoveList() {
    const move_list_container = document.querySelector(".play-controller-moveList");
    
    if (!move_list_container) {
        return [];
    }

    const half_moves = [];
    const half_move_spans = move_list_container.querySelectorAll(".node.main-line-ply .node-highlight-content");

    for (const half_move_span of half_move_spans) {
        half_moves.push(half_move_span.textContent.trim());
    }

    return half_moves;
}

function updateGame(game, game_half_move_count, half_moves) {
    if (half_moves.length < game_half_move_count) {
        game.reset();
        game_half_move_count = 0;
    }

    for (let half_move_index = game_half_move_count; half_move_index < half_moves.length; half_move_index++) {
        game.move(half_moves[half_move_index], { sloppy: true });
        game_half_move_count++;
    }

    return game_half_move_count;
}

function isMoveLegal(game, move) {
    const game_copy = new Chess(game.fen());
    return game_copy.move(move, { sloppy: true }) != null;
}
