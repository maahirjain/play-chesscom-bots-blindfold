# Section 5 milestone audit — "Add minimal session controls"

**Auditor:** independent (did not plan, build, review, or verify any 5.x task).
**Date:** 2026-10-06. **Branch:** `autodev/logging-instrumentation`.
**Scope:** PLAN.md §5 (tasks 5.1–5.10), "Add minimal session controls".
**Tree:** committed through `27351da` (record task 5.10 state); working tree clean.

## Verdict: PASS_WITH_GAPS — 0 blockers, 1 SHOULD_FIX requiring owner decision before §7

No PLAN §5 numbered requirement (5.1–5.10) is unimplemented. Every task has
contract/build/review/behavior evidence, every review verdict is APPROVE, and
every behavior verdict is VERIFIED/BEHAVIOR_VERIFIED. The auditor's independent
V1 re-run is **1337/1337**. The one SHOULD_FIX is a deferred owner decision from
5.1 (manual termination-reason entry, PLAN §(c) step 7) that no §5 task owned;
it does not block §6 (export) but should be decided before §7 owner-device work.

## 1. Evidence completeness

All 40 evidence files exist (contract/build/review/behavior × 10 tasks):

| Task | contract | build | review | behavior |
|------|----------|-------|--------|----------|
| 5.1 | ✓ | ✓ | ✓ | ✓ |
| 5.2 | ✓ | ✓ | ✓ | ✓ |
| 5.3 | ✓ | ✓ | ✓ | ✓ |
| 5.4 | ✓ | ✓ | ✓ | ✓ |
| 5.5 | ✓ | ✓ | ✓ | ✓ |
| 5.6 | ✓ | ✓ | ✓ | ✓ |
| 5.7 | ✓ | ✓ | ✓ | ✓ |
| 5.8 | ✓ | ✓ | ✓ | ✓ |
| 5.9 | ✓ | ✓ | ✓ | ✓ |
| 5.10 | ✓ | ✓ | ✓ | ✓ |

All 10 tasks committed as feature + state pairs (20 commits);
`git log` confirms the sequence 5.1→5.10 with no interleaving.

## 2. Review and behavior verdicts

| Task | Review verdict | SHOULD_FIX status | Behavior verdict |
|------|---------------|-------------------|------------------|
| 5.1 | APPROVE (0 blockers, 6 NOTEs) | none open | BEHAVIOR_VERIFIED |
| 5.2 | APPROVE (0 blockers, 5 NOTEs) | none open | BEHAVIOR_VERIFIED |
| 5.3 | APPROVE (0 blockers, 4 NOTEs) | none open | BEHAVIOR_VERIFIED |
| 5.4 | APPROVE (0 blockers, 4 NOTEs) | none open | BEHAVIOR_VERIFIED |
| 5.5 | APPROVE | N1 (stale doc claim — REPAIRED in DECISIONS.md); N2 (fields-malformed localAbortStart — REPAIRED in code) | VERIFIED |
| 5.6 | APPROVE | N1 (4-param deviation — documented, sound) | VERIFIED |
| 5.7 | APPROVE | none (zero product-code changes, pinning task) | VERIFIED |
| 5.8 | APPROVE | N1 (note: marker input cleared on abort — specified behavior) | VERIFIED |
| 5.9 | APPROVE | none open | VERIFIED |
| 5.10 | APPROVE | none open | VERIFIED |

Every SHOULD_FIX/NOTE raised in Section 5 is closed or explicitly documented
as a non-defect in the current tree.

## 3. PLAN requirement coverage (actual text, task by task)

- **5.1** — compact Start/Stop control + recording/saving health indicator:
  `session_controls.js` (in-page cluster, 4 lights, 2 s poll while active,
  UUID-v4 minting, recorder-ensure → set-session → start-streams → slots +
  emitPageStart + poll; Stop via recordStopTermination → stop-streams →
  5.10 seam). One new SW-side message `recorder-ensure`; `ownerTabId`
  capture in recorder.js. ✓
- **5.2** — baseline/training/evaluation + training approach + verbal
  scaffolding: `session_fields.js` (three fields, metadata-first identity);
  SW-side `session-save` (validates before either save); five 1.2 fields
  as `{value:null, source:'manual'}` placeholders. ✓
- **5.3** — remembered selections without silent change:
  `selection_memory.js` (`blindfold.sessionSelection.v1` in
  chrome.storage.local); capture only after successful Start; four-part
  no-silent-change invariant. ✓
- **5.4** — detected conditions + manual completion: `detected_conditions.js`
  (playerColor verified via wc-chess-board; botName/botDisplayedRating/
  timeControl/assistanceSettings manual-only); fresh detection merged at
  Start, manual-dirty wins. ✓
- **5.5** — duplicate-Start guard: atomic guard in recorder.js
  `handleSetSession` (sessionId-equality discriminator, synchronous
  check-and-set); content-side pre-check after ensure/before mint;
  `localAbortStart` (avoids cross-tab wipe via Stop-clear); refusal
  `{ok:false,error:'session-active'}` with no detail leak. ✓
- **5.6** — readiness only after required streams + storage write:
  pure `computeReadiness()` (all three streams `recording-healthy` AND
  ≥1 acked event via observed-emission + drained queue); latched badge
  (waiting → ready, no flap); honest not-ready reasons; presentation-only,
  never gates session/Stop. ✓
- **5.7** — record through game end until Stop: zero product-code changes
  (no auto-stop existed); 8 V1 pins (static no-path-to-stop + behavioral
  game-end-during-active-session); 5.9 boundary preserved (ended-state
  untouched). ✓
- **5.8** — optional timestamped moment marker: one new event type
  `moment_marker` (`{note: string|null}`, 500-char max, RangeError never
  truncates); input + Mark button, disabled unless ACTIVE; emits via
  sender; failure preserves text (3.2 SF-1). ✓
- **5.9** — new game before Stop: `handleGameReset()` (mint → metadata +
  session-save → recorder re-set same-sessionId/new-gameId →
  slots → new tracker → resetEnded); `game_reset` under old gameId is
  the boundary; `metadata.gameIds.length > 1` flags shared session;
  fail-closed (old gameId stays on any failure). ✓
- **5.10** — await final acks + finalization before complete:
  `sender.flush()` after stop response → pure `computeCompletion()`
  (`complete` vs `complete-with-warnings` naming `flushTimedOut`
  per-stream and undelivered-event counts) → enriched
  `lastStopResponse` retained for §6; button shows "Finalizing…" then
  idle with warnings as detail. ✓

Spot-traces (auditor-verified in the current tree):
- 5.5 guard: `recorder.js:1522` — `if (isSessionActive() && sid !== null
  && sid !== sessionId)`; synchronous check-and-set confirmed; sole
  writer to sessionId/gameId/ownerTabId/sessionCategory is
  `handleSetSession`.
- 5.9 re-set vs 5.5 guard: `session_controls.js:1567` sends
  `{sessionId: sid, gameId: newGameId}` (same sessionId → guard allows);
  TOCTOU refusal handled (old gameId stays).
- 5.6 latch vs 5.9: `handleGameReset` does NOT call `resetReadiness`
  (badge stays latched per session, per contract).
- 5.10 flushTimedOut: `session_controls.js:492` —
  `st.flushTimedOut === true` → `kind + '-flush-timed-out'` warning;
  enriched verdict retained at `session_controls.js:1700`.
- 5.2 session-save ordering: metadata → `MSG_SESSION_SAVE` →
  `MSG_SET_SESSION` → `MSG_START_STREAMS` (verified at
  `session_controls.js:1378-1404`); save failure aborts before the
  recorder sees the session.
- 5.7/5.9 boundary: `chess_utils.js` byte-identical re 5.7;
  `resetEnded()` called once per successful 5.9 transition
  (`content.js:64`) and at Start (`session_controls.js:1429`).

## 4. Cross-task coherence — one complete session lifecycle

Start click (5.1: interlock → 5.5 pre-check → mint → 5.2 session-save →
set-session → start-streams → slots + emitPageStart + 5.6 badge
"Waiting…") → polling (5.1 lights + 5.6 readiness → "Ready — recording"
when healthy + stored) → play (5.8 markers attach to active gameId;
5.9 mints new gameId on genuine reset with game_reset boundary) →
game end (5.7: nothing stops; reflection window preserved) →
Stop click (5.1: recordStopTermination → stop-streams → 5.10:
Finalizing… → sender.flush() → computeCompletion → enriched verdict
→ idle with warnings) → §6 consumes (metadata.gameIds, events by
gameId, enriched stop verdict).

The pipeline hangs together; no dangling seams found.

## 5. Discipline checks

- `git diff main -- PLAN.md` — empty ✓ (PLAN.md unmodified across §5)
- `main` branch — untouched ✓
- Offscreen channel vocabulary — 24 messages (5.1's `recorder-ensure`
  and 5.2's `session-save` are SW-side, not offscreen; 5.8's reviewer
  confirmed MSG_ identifier count unchanged at 26) ✓
- Event types — exactly one new in §5: `moment_marker` (5.8's specified
  deliverable; 5.7's contract reserved it) ✓
- No new IndexedDB stores in §5 (db.js/sw.js diffs vs main are §2's) ✓
- No new permissions in §5 (manifest permissions are §2/§4's; §5's
  manifest change is the content_scripts js list) ✓
- Suite — auditor's independent re-run: **1337/1337** ✓
- All 10 tasks committed as feature + state pairs; working tree clean ✓

## 6. Gaps

### SHOULD_FIX 1 — Manual termination-reason entry (PLAN §(c) step 7) was deferred for owner decision and never decided

**Severity:** SHOULD_FIX (owner decision required; does not block §6).

**Evidence:** PLAN §(c) step 7: "Click Stop. If the ending is unknown,
supply a brief reason such as abandoned or resigned." The 5.1 contract
§8 records: "Manual termination-reason entry UI: **unassigned by PLAN's
task list** — 5.1 passes null (unknown) per 3.5.4; the contract records
this as a §5 follow-up for owner decision, not a 5.1 defect."

**Finding:** No 5.2–5.10 task implemented it, and no owner decision is
recorded in DECISIONS.md or STATE.json. The current code
(`session_controls.js:1620-1630`) passes `termReason = null` unless a
`game_ended` was observed. There is no UI for the user to supply
"abandoned" or "resigned".

**Why not a blocker:** The numbered requirements 5.1–5.10 do not include
it; the 3.5.4 seam honestly records null (unknown) rather than
fabricating. §6 (export) is unaffected — it exports what was observed.

**Recommendation:** Owner decision before §7 device work: either (a)
build a minimal reason-entry affordance (e.g., optional text field on
the Stop transition, following 5.8's marker pattern), or (b) explicitly
accept null-reason as the standing behavior and amend the §(c) flow
note. Do not silently leave it undecided.

## 7. Carry-forward list (§6/§7 handoff)

**For §6 (export):**
1. `metadata.gameIds` array (5.9): length > 1 implicitly flags a
   shared-recording session (1.1 design). §6's `metadata.json` includes
   the full array; `events.jsonl` partitions by gameId with
   `game_reset` boundaries; media retained once (Flow export-table
   rule).
2. Enriched `lastStopResponse` (5.10): `{stopResp, flushResult, verdict,
   warnings}` retained in-memory via the existing seam. §6's
   `media-sync.json` "known gaps" consumes `warnings`
   (incl. `*-flush-timed-out` and `N-events-undelivered`).
3. `flushTimedOut` is response-only (4.13) and surfaced only in 5.10's
   verdict — §6 must read it from the retained verdict, not from any
   store.
4. `moment_marker` events (5.8) flow through the standard event
   pipeline (no special export handling needed beyond the event type).
5. Export must use readonly reads and prove identical store counts
   before/after (standing rule carried from mission brief and §4
   audit).

**For §7 / owner device (V3):**
6. Real-device verification of all §5 V3 ACs: 5.1 AC11 (control
   cluster on real Chess.com page, capture prompts, refresh adoption),
   5.6 AC10 (waiting → ready with real streams), 5.7 AC10 (post-game
   reflection audio in mic stream), 5.8 AC10 (markers in export with
   aligned timestamps), 5.9 AC11 (two games, unmixed histories, media
   once), 5.10 AC12 (completion presentation timing, undelivered-events
   warning).
7. SHOULD_FIX 1 (manual termination-reason entry) — owner decision
   required before or during §7.
8. Real-device stream health realities: physical mute/unplug behavior
   against 5.1's lights and 5.6's badge (V1/V2-pinned or synthetic
   only); headed `getDisplayMedia` picker transient activation from
   the in-page Start click (5.1's honest caveat).
9. Chess.com result-dialog/reconnect observation remains unsupported
   (§3 carry-forward — do not fabricate observers); 5.4's manual-only
   fields (botName, rating, timeControl) depend on honest user input
   on the device.

## 8. Auditor's final note

Section 5 is substantively complete and coherent. The ten tasks form one
clean session lifecycle with no dangling seams, and the cross-task
interactions the auditor probed (5.5↔5.9 guard/re-set, 5.6↔5.9
latch/game-change, 5.7↔5.9 no-stop/boundary, 5.10↔5.2
save-then-set ordering) all hold in the code, not just in the reports.
The §4 audit's §5 carry-forwards are closed: required-stream policy
lives in 5.6's `computeReadiness`, `flushTimedOut` is surfaced by 5.10's
`computeCompletion`, and the 5.5/5.9 seams the audit named are
implemented as specified.

The only work standing between this audit and a SECTION-5-COMPLETE
verdict is SHOULD_FIX 1 (owner decision on the manual
termination-reason entry). Given it is explicitly an owner decision
(5.1's contract says so) and the numbered requirements are fully met,
the auditor records the section as complete-with-decision-pending
rather than blocked — but the decision should not drift past §7.
