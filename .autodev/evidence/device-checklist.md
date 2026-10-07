# Device Verification Checklist

**Mission:** Chess.com bot logging instrumentation (PLAN.md)
**Branch:** `autodev/logging-instrumentation`
**Date:** 2026-10-06
**Status:** All cloud work complete (V1: 1492/1492, all reviews APPROVE). The following require your actual device.

---

## Prerequisites

- [ ] Load the extension unpacked in Chrome (chrome://extensions → Developer mode → Load unpacked → select repo root)
- [ ] Grant permissions when prompted: microphone, camera, screen capture
- [ ] Sign in to Chess.com as `BlindfoldVision` (credentials in Secure Vault)
- [ ] Navigate to https://www.chess.com/play/computer

---

## 7.8 — Media devices on actual hardware

**PLAN:** "Verify microphone, screen, webcam, and game audio on the actual computer/browser setup."

- [ ] Start a session (select `baseline` category)
- [ ] Confirm all three health lights turn green (microphone, screen, webcam)
- [ ] Speak into microphone — confirm audio level indicator moves
- [ ] Confirm screen capture shows the Chess.com board
- [ ] Confirm webcam shows your camera feed
- [ ] Play a few moves — confirm game audio (move sounds) is captured if enabled
- [ ] Stop the session — confirm all three streams finalize without errors

**Expected:** All devices record. If any device fails, the failure is explicit (not silent).

---

## 7.9 — Marker alignment

**PLAN:** "Verify visible/audible markers align with event timestamps at both ends of a recording."

- [ ] Start a session
- [ ] Click the "Mark" button (moment marker) at the start
- [ ] Play 5-10 moves
- [ ] Click "Mark" again at the end
- [ ] Stop the session and export the ZIP
- [ ] Extract the ZIP and open `media-sync.json`
- [ ] Verify the two `moment_marker` events in `events.jsonl` have timestamps
- [ ] Open the screen recording — verify the visual marker (if any) appears at approximately the right time

**Expected:** Markers in events align with media within reasonable tolerance (±2 seconds).

---

## 7.12 — Realistic-length recording

**PLAN:** "Run a realistic-length disposable recording and confirm bounded memory use and successful export."

- [ ] Start a session
- [ ] Play a full bot game (or at least 15 minutes of recording)
- [ ] Monitor Chrome's memory usage for the extension (chrome://extensions → Details → Inspect views)
- [ ] Stop the session
- [ ] Click Download — confirm the ZIP downloads successfully
- [ ] Verify the ZIP is not corrupt (open it, check file listing)

**Expected:** Memory stays bounded (no runaway growth). Export succeeds. ZIP is valid.

---

## 7.13 — Media playback and game reconstruction

**PLAN:** "Open each exported media file and reconstruct the game from exported raw moves as a collection correctness check, not a shipped analysis command."

- [ ] Extract the ZIP from 7.12
- [ ] Open each media file (microphone-001.webm, screen-001.webm, webcam-001.webm) — confirm they play
- [ ] Open `events.jsonl` — find all `move_confirmed` events
- [ ] Reconstruct the game score from the confirmed moves (manually or with a chess tool)
- [ ] Verify the reconstructed game matches what you actually played

**Expected:** All media files play. Reconstructed game is accurate.

---

## Termination reason (new feature)

**PLAN §(c) step 7:** "If the ending is unknown, supply a brief reason such as abandoned or resigned."

- [ ] Start a session
- [ ] Confirm the termination-reason text input is visible and enabled during recording
- [ ] Type "abandoned" in the field
- [ ] Stop the session (without completing the game)
- [ ] Export the ZIP and check `metadata.json` → `completion.manualTerminationReason` = "abandoned"
- [ ] Start another session, leave the field empty, stop — confirm `manualTerminationReason` is `null`
- [ ] (Optional) Type "browser crashed" — confirm it's preserved as raw text even though it's not in the vocabulary

**Expected:** Optional field works, observed endings override manual input, empty = null.

---

## Interrupted download re-export (6.7)

- [ ] After a successful session, click Download
- [ ] Cancel the download mid-way (or simulate interruption)
- [ ] Click Download again — confirm it works (button stays enabled)
- [ ] Verify the second ZIP is byte-identical to a fresh download (except `exportedAtUtc`)

**Expected:** Re-export works from retained data. No data loss.

---

## Multi-game session (5.9 + 6.6)

- [ ] Start a session
- [ ] Play a bot game, then start a new bot game (without stopping the session)
- [ ] Confirm the session continues (game boundary recorded, not a new session)
- [ ] Stop and export
- [ ] Verify the ZIP has the `_session-<id>` directory format (not per-game)
- [ ] Verify `metadata.json` lists both game IDs

**Expected:** Multi-game sessions export as a single ZIP with shared media.

---

## Sign-off

Once all items pass (or failures are documented):

- [ ] All checkboxes complete
- [ ] Any failures documented with details
- [ ] Ready for `autodev/checkpoint-05-device-verified` tag

**Note:** If any item fails, do NOT mark it complete. Document the failure — the mission preserves actual observations, including failures.
