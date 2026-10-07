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

---

## Session Recording (Logging Instrumentation)

The extension can record blindfold training sessions — microphone, screen,
and webcam — alongside a raw event log, and export everything as a
self-contained ZIP bundle for later analysis. Recording is opt-in per
session: nothing is captured unless you press **Start**.

### Setup

1. Open `chrome://extensions`, enable **Developer mode**, and **Load
   unpacked** this repository's root directory.
2. Grant the permissions Chrome requests when you start your first
   recording:
   - **Microphone** and **camera** (device selection on first use).
   - **Screen capture** — pick the Chess.com tab when the picker appears.
3. The extension requests these Chrome permissions (see `manifest.json`):
   `offscreen`, `tabCapture`, `storage`, `downloads`, plus host access to
   `https://www.chess.com/*`.
4. Open a bot game at `https://www.chess.com/play/computer*`. The
   recording controls appear as an in-page cluster on that page.

### Recording controls

The in-page cluster (visible on the Chess.com bot-game page):

- **Session category** (`baseline`, `training`, `evaluation`) — required
  before Start. Your last-used selections are remembered and pre-filled.
- **Training approach** and **verbal scaffolding** — optional training
  fields, also remembered.
- **Conditions panel** — bot name, displayed rating, time control, and
  assistance settings are entered manually (no verified source exists on
  the page); player color is detected from the board orientation.
  Editing a field marks it manual — manual input always wins over
  detection.
- **Health lights** — microphone, screen, webcam, and saving indicators
  show per-stream recording status while active.
- **Readiness badge** — shows `Waiting for recording…` until all three
  streams are healthy *and* the first storage write is confirmed, then
  flips to ready. The badge is informational only: it never blocks Start
  and never gates Stop.
- **Start / Stop** — Start begins all three streams and the event log;
  Stop finalizes the media, drains the event queue, and presents the
  completion state. A second Start while a session is active is refused
  honestly (`session-active`); starting a new game mid-session starts a
  new game ID under the same session without stopping the recording.
- **Moment marker** — optional note field (max 500 characters) + **Mark**
  button, enabled only while recording. Drops a timestamped
  `moment_marker` event into the log; the input clears on success.
- **Download** — appears after Stop completes (see Export below).

### Export

After Stop completes, click **Download** in the session controls. The
browser's download manager saves a single ZIP to your configured download
location (usually `~/Downloads`). The button shows **Exporting…** while
the bundle is built, then returns to **Download**.

**If the download is interrupted** (you cancel it, the browser crashes,
the disk fills up): click **Download** again. The export is rebuilt from
scratch using the retained local data — nothing is lost, and no cleanup
is needed. Every export is a complete, independent build. Two exports of
the same session are byte-identical except for the `exportedAtUtc`
timestamps in `metadata.json` and `media-sync.json` (which honestly record
when each export ran).

**You** extract the ZIP into your experiment directory — the folder where
you keep your blindfold-chess experiment data. The extension does not do
this for you.

The extension **never writes to arbitrary filesystem paths**. It has no
filesystem access beyond offering a download through the browser's
download manager. It cannot choose where the ZIP lands, create
directories, or write anywhere else on your system.

The ZIP contains a single top-level directory:

```
<category>/<YYYY-MM-DD>_<gameId>/
```

For sessions with multiple games (you started a new game before
stopping), the directory is named for the session instead:

```
<category>/<YYYY-MM-DD>_session-<sessionId>/
```

The media is stored once and shared across games — it is never
duplicated.

**Bundle contents:**

| File | Contents |
|------|----------|
| `metadata.json` | Session identity (session/game IDs), category, training fields, the verbatim initial conditions, per-game starting positions (where known), completion status (`complete`, `complete-with-warnings`, or `unknown`), and a media inventory. |
| `events.jsonl` | The full event stream in persistent append order — one JSON object per line. This is the raw observation log: moves, game boundaries, lifecycle events, markers, clock anchors. No computed metrics. |
| `media-sync.json` | Media filenames, formats, clock anchors, per-segment timing offsets (for aligning media with events), and known gaps (e.g. a stream whose final flush timed out, undelivered events). |
| `microphone-NNN.webm` | Assembled microphone audio, original format, no transcoding. |
| `screen-NNN.webm` | Assembled screen recording, original format, no transcoding. |
| `webcam-NNN.webm` | Assembled webcam recording, original format, no transcoding. |

Numbered files (`-001`, `-002`, …) correspond to recording segments.
If a recording was interrupted, every segment is still listed — the
numbering reflects what was actually captured, and `media-sync.json`
documents any gaps honestly.

**What the extension does NOT do:**

- **No arbitrary filesystem writes.** The only output is the browser
  download.
- **No deletion on export.** Exporting never deletes or modifies the
  stored recording data. The local copy remains until the extension's
  retention policy removes it.
- **No upload, sync, or backup.** The bundle never leaves your machine
  through the extension. Copy the ZIP to your backup location yourself.
- **No transcoding.** Media files are byte-concatenations of the
  originally recorded chunks.
- **No analysis.** The bundle contains raw observations only — no
  metrics, no transcripts, no engine evaluations. Analysis happens in
  your own tools, outside the extension.

### Verified coverage and limitations

The logging pipeline was verified in layers. This section records what
was proven where, and what still needs the physical device. Update the
device-only items after running them.

**Verified in automated testing (V1 static/unit + V2 headless Chrome):**

- Event capture: legal/illegal/ambiguous/repeated move submissions
  produce distinct correct records; promotions, castling, and en passant
  are captured; mouse-accepted moves are captured without a keyboard
  attempt; batched DOM updates and history revisions never duplicate
  moves; takebacks, new games, reloads, and late attachment never
  fabricate timings.
- Stream pipeline: per-stream health reporting, mid-segment split and
  restart handling, bounded final-flush with honest `flushTimedOut`,
  readonly export with before/after store-count proof.
- Session controls: duplicate-Start guard, readiness badge transitions,
  no-auto-stop invariant, moment markers, mid-session game-change
  boundary, Stop completion verdict (`complete` /
  `complete-with-warnings` / `failed`).
- Export: `metadata.json` / `events.jsonl` / `media-sync.json` schemas,
  chunk assembly byte-identity, numbered filenames, ZIP validity
  (verified with `unzip`), streaming assembly (no full-recording
  buffering), repeatable export (byte-identical modulo `exportedAtUtc`).
- Failure honesty: permission denial, device loss, storage failure, and
  interrupted sessions produce explicit incomplete status; undelivered
  events and flush timeouts are named in the completion warnings and in
  `media-sync.json` known gaps.

**Requires the physical device (V3/V4 — not yet run):**

- Microphone, screen, webcam, and game-audio capture on the real
  computer/browser setup (PLAN §7.8).
- Visible flash and stop double-beep audibility *in the recordings*,
  aligned with event timestamps at both ends (PLAN §7.9).
- Page refresh during recording: the independent recording context must
  survive (PLAN §7.10).
- Realistic-length disposable recording: bounded memory use and
  successful export (PLAN §7.12).
- Open each exported media file and reconstruct the game from the
  exported raw moves as a collection correctness check (PLAN §7.13).
- Physical mute/unplug behavior against the health lights and readiness
  badge; real `getDisplayMedia` picker behavior from the in-page Start
  click.
- Chess.com result-dialog/reconnect observation remains unsupported by
  design (no fabricated observers); bot name, rating, and time control
  depend on honest manual input.

**Known honest limitations (by design, not defects):**

- Game audio capture depends on the platform: tab-audio capture failed
  honestly in the headless sandbox and is classified by construction.
- A recording that never finalizes exports its segments with on-the-fly
  numbering, marked `unfinalized` in `media-sync.json` — raw data is raw
  data.
- If the ending is unknown at Stop, the termination reason stays unknown
  unless supplied (see `.autodev/evidence/section-5.audit.md` SHOULD_FIX
  1 — owner decision pending).
