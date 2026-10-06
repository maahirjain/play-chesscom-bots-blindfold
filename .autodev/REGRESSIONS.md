# REGRESSIONS.md

Behaviors and invariants discovered during development that future tasks must
preserve. Newest first.

## Baseline invariants (from preflight code inspection, 2026-10-06)

- Hotkeys: `j` focus move input; `Enter` submit; `v` toggle blindfold pieces;
  `w` speak turn; `z` repeat last move; `i` speak full move list; `s` speak
  position; `m` speak result; `Esc` stop speech. Letters chosen to avoid
  collision with move-input letters (e.g. `r` for rook).
- Move input accepts: case-insensitive SAN (`Nf3`/`nf3`); `b` pawn vs `B`
  bishop disambiguation when both `bxc3`/`Bxc3` legal; promotions without `=`
  (`fxe8n`, `fxe8=N`); castling aliases (`c`, `oo`, `00`, `o-o`, `0-0`, `O-O`
  kingside; `cl`, `ooo`, `000`, `o-o-o`, `0-0-0`, `O-O-O` queenside); optional
  leading `p` for pawn moves; trailing `+`/`#` ignored; disambiguation
  required (`Nbd7`); captures require `x`.
- Illegal keyboard input: red border + illegal-move sound; no board effect.
- Legal keyboard input: green border; move dispatched via synthetic
  pointer/click events on `wc-chess-board`; promotion picker handled when it
  appears.
- Mouse moves (drag/click) work through Chess.com natively and are observed
  via the move list DOM (`.play-controller-moveList .node.main-line-ply
  .node-highlight-content`).
- New moves spoken automatically; result announced automatically at game end.
- Piece set stored in `localStorage["blindfold_chess_piece_set"]`
  (`"neo"` default / `"blindfold"`); applied by rewriting `.piece` background
  images; re-applied on piece renders and move observations. Not synced with
  Chess.com settings.
- Speech uses browser default voice; `speechSynthesis.cancel()` semantics for
  interrupt.
