# AGENTS.md — play-chesscom-bots-blindfold (autodev/logging-instrumentation)

Orientation for any fresh agent entering this repository during the autonomous
logging-instrumentation mission.

## What this is

A Manifest V3 Chrome extension for playing Chess.com bots blindfolded:
keyboard move input, spoken move announcements, piece-visibility toggle,
spoken help. Content scripts run on `https://www.chess.com/play/computer*`.

## Source of truth

`PLAN.md` is the human-owned specification. Read it fully before changing
application code. Do not modify it without explicit owner approval. Do not
silently weaken, reinterpret, or omit its requirements.

Scope is **raw data collection only**: preserve original observations and
inputs; do not persist derivable values; no analysis, metrics, transcription,
engine analysis, charts, dashboards, or unrelated features.

## Architecture (as of mission start)

- `manifest.json` — MV3, content scripts only (no background/service worker yet;
  Section 2 of PLAN.md adds one).
- `content.js` — UI wiring: move input, hotkeys (j/Enter/v/w/z/i/s/m/Esc),
  piece-set toggle.
- `chess_utils.js` — DOM move-list observation (`observeMoves`, `getMoveList`),
  move normalization/validation, synthetic board clicks, piece-set application.
- `sounds.js` — speech synthesis announcements, illegal-move sound, position
  readout.
- `chess.min.js` — vendored chess.js library (do not hand-edit).
- Piece-set choice persisted in `localStorage` under `blindfold_chess_piece_set`.
- No tests, no build step, no dependencies at mission start.

## Important commands

- `git log --oneline` — local history on `autodev/logging-instrumentation`.
- Node 24 available; `npm` registry reachable.
- Extension behavioral tests: headless Chrome via puppeteer with
  `--load-extension` (see `.autodev/DECISIONS.md`); `tests/` uses `node --test`.
- Never develop on `main`. Never push failed intermediate states for backup.

## Durable project state

`.autodev/` holds mission state — read before starting work, update as you go:

- `MISSION.md` — the autonomous-development rules (condensed from owner prompt).
- `STATE.json` — authoritative task/checkpoint/verification status. Only the
  coordinator updates it.
- `DECISIONS.md` — consequential engineering decisions with reasoning/evidence.
- `REGRESSIONS.md` — invariants future work must preserve.
- `evidence/<task-id>.md` — per-task contract, verification, defects, limits.

Conversation history is not state. Workers return findings to the coordinator;
they do not rewrite global state themselves.

## Development conventions

- One X.X PLAN.md subsection = one task. Smallest coherent change per task.
- Preserve unrelated gameplay behavior; no speculative architecture.
- Event/timing semantics: UTC + monotonic anchors; persistent append sequence;
  never fabricate occurrence times; represent unknown as unknown.
- Verification levels: V1 static+unit, V2 integration/runtime, V3 real
  browser behavior, V4 owner device. Label simulated verification as simulated.
- Credentials: never request, expose, log, copy, or store Chess.com credentials
  in chat, repo files, evidence, or agent context.
- Chess.com testing: bot games and disposable sessions only. No live/rated human
  games, no messaging, no purchases, no unrelated settings changes.
