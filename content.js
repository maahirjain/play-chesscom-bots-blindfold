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
  onGameReset: () => {
    // 3.2.6: a game reset orphans in-flight attempts — mark them
    // unconfirmed rather than leaving them pending forever.
    attemptTracker.handleGameReset();
    /* §5: mint new game identity + install new tracker */
  },
});
const game = historyTracker.getGame();
let latest_half_moves = [];

// Task 3.2 (PLAN.md §3.2): move-input attempt tracker. Records each
// submitted attempt (verbatim text, first-edit time, validation outcome,
// dispatch result) and links attempts to confirmed history moves only
// after acceptance is observed (3.2.5). Emission is gated on non-empty
// sessionId AND gameId — pre-§5 the tracker is inert (no dangling
// half-lifecycles). 3.2.7: rejected *mouse* attempts have no reliable DOM
// signal and stay outside guaranteed coverage; only the move list (3.1)
// observes mouse moves.
const attemptTracker = BlindfoldSession.createAttemptTracker({
  emitEvent: (eventType, payload, refs) =>
    BlindfoldSession.sender.emit({
      eventType,
      sessionId: BlindfoldSession.activeSessionId,
      gameId: BlindfoldSession.activeGameId,
      payload,
      refs: refs || null,
    }),
  getSessionId: () => BlindfoldSession.activeSessionId,
  getGameId: () => BlindfoldSession.activeGameId,
});

// 3.2.1: first-edit timestamp per submit attempt. Only the timestamp is
// retained — no keystroke contents, counts, or inter-key timings.
const firstEditCapture = BlindfoldSession.createFirstEditCapture(() => performance.now());

// 3.2.6: best-effort — attempts still pending at pagehide become
// unconfirmed (never silently dropped). Shares the 2.7 hook philosophy:
// never throws into page code, never flushes.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    try {
      attemptTracker.handlePageHide();
    } catch (e) { /* best-effort */ }
  });
}

const PIECESET_KEY = "blindfold_chess_piece_set";
let piece_set = localStorage.getItem(PIECESET_KEY) || "neo";

applyCurrentPieceSet();

observeMoves((half_moves) => {
  latest_half_moves = half_moves;
  const result = historyTracker.observe(half_moves);
  // 3.2.5: link submitted attempts to confirmed moves — only after the
  // move is observed as accepted in the move list.
  attemptTracker.noteConfirmedMoves(result.confirmed);
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

    move_input.addEventListener("keydown", async (e) => {
        if (e.key == "Enter") {
            // 3.2.2: capture the exact submitted text BEFORE normalization
            // or clearing the field. 3.2.1: snapshot the first-edit time.
            const rawText = move_input.value;
            const firstEdit = firstEditCapture.onSubmit();

            const move = normalizeMove(game, rawText);
            move_input.value = "";

            const legal = isMoveLegal(game, move);
            if (legal) {
                move_input.style.borderColor = "green";
            } else {
                move_input.style.borderColor = "red";
                playIllegalMoveSound();
            }

            // 3.2 instrumentation (UX above is unchanged). The attempt is
            // recorded with its validation outcome; the normalized string
            // is never stored (3.2.3 — derivable from submittedText).
            // 3.2 review SF-1: instrumentation is failure-isolated — a
            // throw in the tracker must never prevent dispatch or reject
            // unhandled. Pre-3.2, dispatch was unconditional for legal moves.
            const squares = legal ? parseMoveSquares(game, move) : null;
            let attempt = null;
            try {
                attempt = attemptTracker.submitAttempt({
                    submittedText: rawText,
                    firstEditMonotonicMs: firstEdit,
                    validation: legal ? 'legal' : 'illegal',
                    from: squares ? squares.from : null,
                    to: squares ? squares.to : null,
                    promotion: squares ? squares.promotion : null,
                });
            } catch (instrErr) { /* instrumentation must never block dispatch */ }
            // 3.2.4: record dispatch start and the actual outcome.
            // 3.2.6: illegal-at-submit attempts are terminal at birth —
            // only legal attempts enter the pending lifecycle.
            if (legal) {
                let dispatchEventId = null;
                if (attempt !== null) {
                    try {
                        const dispatch = attemptTracker.noteDispatchStarted(attempt.attemptEventId);
                        dispatchEventId = dispatch ? dispatch.dispatchEventId : null;
                    } catch (instrErr) { /* instrumentation must never block dispatch */ }
                }
                let outcome;
                try {
                    outcome = await makeMoveOnBoard(game, move);
                } catch (dispatchErr) {
                    // Unexpected dispatch throw: no dispatch outcome is
                    // recorded (do not invent a DISPATCH_FAILURE_REASONS
                    // member). outcome=true skips the failure note below.
                    outcome = true;
                }
                if (attempt !== null && outcome !== true) {
                    try {
                        attemptTracker.noteDispatchFailed(
                            attempt.attemptEventId,
                            dispatchEventId,
                            outcome);
                    } catch (instrErr) { /* instrumentation must never throw into page code */ }
                }
            }
        }
    })

    move_input.addEventListener("input", () => {
        move_input.style.borderColor = "";
        // 3.2.1: first `input` event per submit captures the monotonic
        // timestamp. Programmatic clears (move_input.value = "") do not
        // fire `input`, so the submit clear cannot pollute it.
        firstEditCapture.onInput();
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