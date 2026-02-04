# Play Chess.com Bots Blindfold

A Chrome extension to play bots on Chess.com completely blindfolded.

<img width="1511" height="870" alt="play_chesscom_bots_blindfold_img" src="https://github.com/user-attachments/assets/3cffae85-4a99-4c84-8eb8-89761d25e3b5" />

## Features
- Spoken move announcements
- Keyboard-based move input using algebraic notation
- Blindfold and standard piece set toggling
- Spoken board state, move list, and game result

## Keyboard Shortcuts
- <kbd>j</kbd> / <kbd>J</kbd>  (jump): focus move input
- <kbd>Enter</kbd>: submit move
- <kbd>v</kbd> / <kbd>V</kbd> (visibility): toggle blindfold pieces
- <kbd>w</kbd> / <kbd>W</kbd> (who): speak whose turn it is
- <kbd>z</kbd> / <kbd>Z</kbd> (undo): speak last move
- <kbd>i</kbd> / <kbd>I</kbd> (info): speak full move list
- <kbd>s</kbd> / <kbd>S</kbd> (speak): speak current position
- <kbd>m</kbd> / <kbd>M</kbd> (match): speak game result
- <kbd>Esc</kbd>: stop all current speech

_Note: Hotkey letters were chosen to avoid collisions with letters used elsewhere (for example, `r` for rook)._

## Recommended Chess.com Settings
- Set "Pieces" to "Neo" / "Blindfold".
- Set "Piece notation" to "Text".
- Set "Move Method" to "Drag or Click".
- Activate "Play Sounds".
- Disable premoves.
- Disable auto-promote to queen.
- Choose the "Challenge" option against bots.
- Set the bot time control to "None".

## Move Input
- [Standard algebraic notation](https://en.wikipedia.org/wiki/Algebraic_notation_(chess)) is supported.
- Uppercase is not required (`Nf3` and `nf3` are both valid). Exception: if both `bxc3` and `Bxc3` are legal, lowercase `b` is interpreted as a pawn and uppercase `B` as a bishop.
- Promotions do not require `=` (`fxe8n` and `fxe8=N` are both valid).
- King-side castling may be entered as any of: `c`, `oo`, `00`, `o-o`, `0-0`, `O-O`.
- Queen-side castling may be entered as any of: `cl`, `ooo`, `000`, `o-o-o`, `0-0-0`, `O-O-O`.
- Pawn moves may optionally start with `p` (`pb3` and `b3` are both valid).
- Check (`+`) and checkmate (`#`) markers at the end are ignored.
- Ambiguous moves require disambiguation (`Nbd7` instead of `Nd7`).
- Captures must include `x`.

_Note: Moves may be entered either via the keyboard or using standard drag or click. Illegal moves play an error sound and do not affect the game._

## Speech Behavior

- New moves are spoken automatically as they appear.
- At the end of the game, the result is announced automatically.
- Speech uses the browser’s default voice and language.

## Limitations
- Designed specifically for Chess.com’s current DOM structure.
- Relies on browser speech synthesis availability. If speech behaves unexpectedly, try changing the system or browser voice.
- Piece set changes using <kbd>v</kbd> are not synchronized with Chess.com settings. The selected piece set (Neo or Blindfold) is stored in `localStorage`.

## Disclaimer
This project is not affiliated with Chess.com. Site updates may require maintenance.
