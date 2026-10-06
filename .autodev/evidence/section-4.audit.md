# Section 4 milestone audit — checkpoint-04 prerequisite

**Auditor:** independent (did not plan, build, review, or verify any 4.x task).
**Date:** 2026-10-06. **Branch:** `autodev/logging-instrumentation`.
**Scope:** PLAN.md §4 (tasks 4.1–4.14), "Add synchronized recording".

## Verdict: PASS_WITH_GAPS — 0 blockers, 2 mechanical gaps requiring repair before checkpoint-04

No PLAN §4 requirement is unimplemented. Every task has contract/build/review/behavior
evidence, every review verdict is APPROVE (all SHOULD_FIX items repaired with evidence),
and every behavior verdict is BEHAVIOR_VERIFIED (the 4.4 headline BEHAVIOR_FAIL was a
purely mechanical allowlist-pin issue, repaired on the tree with 739/739 and recorded
as BEHAVIOR_VERIFIED in its repair note — the 2.7 precedent). The two gaps are both
mechanical and both have established repair precedents; they are repair-and-reverify,
not re-plan.

**Gap 1 (suite red on the committed tree):** auditor's independent re-run of
`node --test tests/*.test.js` = **1094/1095, 1 failure**:
`tests/stream_status.test.js:749` — "pipeline modules are untouched except the
additive getStreamHealth". The test asserts `git status --porcelain` lists the four
4.14 product files as changed. The coordinator committed 4.14 (4543204), so the
working tree is clean and the assertion fails. This is exactly the 4.5 SF-1 pattern
(post-commit empty diff; repaired by making the pin conditional on a non-empty
diff — the 2.8/4.4 precedent). No implementation or functional test is implicated.
**Repair (coordinator, mechanical):** make the 4.14 diff-discipline pin tolerate the
post-commit clean tree (conditional on non-empty status; the content pins elsewhere
carry the change durably), then re-run the suite to 1095/1095.

**Gap 2 (uncommitted 4.14 builder change):** `git status` shows one uncommitted
modification: `tests/finalizer.test.js` — the 4.14 builder's deliberate evolution
(MSG_* pin 23→24 with `MSG_GET_STATUS`, plus 4.14 allowlist entries in 4.13's diff
discipline), left out of the 4.14 commit. It is 4.14's change (comments say so),
it is correct (matches the 24-message vocabulary and the 4.14 changed-file list),
and the suite currently passes *with* it in the tree. **Repair (coordinator,
mechanical):** commit it (ideally folded into the Gap-1 repair commit), then
re-run the suite.

## 1. Evidence completeness

All 56 evidence files exist (contract/build/review/behavior × 14 tasks):

| Task | contract | build | review | behavior |
|------|----------|-------|--------|----------|
| 4.1 | ✓ | ✓ | ✓ | ✓ |
| 4.2 | ✓ | ✓ | ✓ | ✓ |
| 4.3 | ✓ | ✓ | ✓ | ✓ |
| 4.4 | ✓ | ✓ | ✓ | ✓ (+ mechanical repair note) |
| 4.5 | ✓ | ✓ | ✓ | ✓ |
| 4.6 | ✓ | ✓ | ✓ | ✓ |
| 4.7 | ✓ | ✓ | ✓ | ✓ |
| 4.8 | ✓ | ✓ | ✓ | ✓ |
| 4.9 | ✓ | ✓ | ✓ | ✓ |
| 4.10 | ✓ | ✓ | ✓ | ✓ |
| 4.11 | ✓ | ✓ | ✓ | ✓ |
| 4.12 | ✓ | ✓ | ✓ | ✓ |
| 4.13 | ✓ | ✓ | ✓ | ✓ |
| 4.14 | ✓ | ✓ | ✓ | ✓ |

## 2. Review and behavior verdicts

| Task | Review verdict | SHOULD_FIX status | Behavior verdict |
|------|---------------|-------------------|------------------|
| 4.1 | APPROVE_WITH_DEFECTS (0 blockers) | SF-1 (Chrome 150+ `hasDocument` floor → `getContexts` fallback) — REPAIRED, verified in recording_host.js:130-132; SF-2 (swallowed start failures) — REPAIRED (console.warn diagnostic) | BEHAVIOR_VERIFIED |
| 4.2 | APPROVE_WITH_DEFECTS (0 blockers) | SF-1 (in-memory selection before persist) — REPAIRED (persist-before-live in select(), device_selection.js:370-386) | BEHAVIOR_VERIFIED |
| 4.3 | APPROVE_WITH_DEFECTS (0 blockers) | SF-1 (write-only `tabPermissionState`) — REPAIRED (variable deleted; re-derive design stands) | BEHAVIOR_VERIFIED |
| 4.4 | APPROVE (0 blockers) | none | BEHAVIOR_VERIFIED (headline BEHAVIOR_FAIL was 14 mechanical git-status pins; repaired with 739/739) |
| 4.5 | APPROVE_WITH_DEFECTS (0 blockers) | SF-1 (db.js pin fails post-commit) — REPAIRED (conditional hunk check, tests/sender.test.js:466-475) | BEHAVIOR_VERIFIED |
| 4.6 | APPROVE_WITH_DEFECTS (0 blockers) | SF-1 (DECISIONS.md entry missing) — REPAIRED (## 4.6 section present) | BEHAVIOR_VERIFIED |
| 4.7 | APPROVE (0 blockers) | none | BEHAVIOR_VERIFIED |
| 4.8 | APPROVE (0 blockers) | none | BEHAVIOR_VERIFIED |
| 4.9 | APPROVE (0 blockers) | none | BEHAVIOR_VERIFIED |
| 4.10 | APPROVE (0 blockers) | none | BEHAVIOR_VERIFIED |
| 4.11 | APPROVE (0 blockers) | none | BEHAVIOR_VERIFIED |
| 4.12 | APPROVE (0 blockers) | none | BEHAVIOR_VERIFIED |
| 4.13 | APPROVE (0 blockers) | none (7 NOTEs) | BEHAVIOR_VERIFIED |
| 4.14 | APPROVE (0 blockers) | none (6 NOTEs) | BEHAVIOR_VERIFIED |

Every SHOULD_FIX ever raised in Section 4 is closed with evidence in the current tree.

## 3. PLAN requirement coverage (actual text, task by task)

- **4.1** — dedicated recording context alive across page refreshes: `recording_host.js`
  (offscreen document, idempotent ensure) ✓
- **4.2** — microphone selection + permission handling: `device_selection.js` ✓
- **4.3** — screen/tab capture selection + permission handling: `capture_selection.js`
  + `capture_broker.js` ✓
- **4.4** — webcam selection + permission handling, face saved separately:
  `camdevices` path (sw-camdevices harness) ✓
- **4.5** — runtime format verification; actual MIME type/file extension in manifest:
  `format_support.js`, `recording_manifest` store, DB v2 ✓
- **4.6** — separate mic/screen/webcam streams, actual (not assumed simultaneous)
  start times: `stream_starter.js` ✓
- **4.7** — screen audio classification by construction; no mic mixing; device
  limitations + acoustic bleed documented: `audio_policy.js` ✓
- **4.8** — incremental chunk saving to extension-owned storage:
  `chunk_writer.js`, `CHUNK_POLL_MS = 5000` ±10% (verified at chunk_writer.js:62,423) ✓
- **4.9** — track mute/end, recorder errors, explicit discontinuities logged:
  `track_monitor.js`, exactly 3 event types (verified at track_monitor.js:51-53) ✓
- **4.10** — segment IDs linked to clock anchors: `clock_link.js`; identity-only,
  no offset arithmetic ✓
- **4.11** — visible/audible sync markers at start AND stop, source timestamps
  saved: `sync_marker.js`, `sync_flash.js`, deterministic `sync_beep.wav`,
  `sync_marker` events ✓
- **4.12** — timecode/offset library; chunk-arrival time never treated as frame
  time: pure `timecode.js` (9 functions); no new derived offsets persisted ✓
- **4.13** — finalize available chunks on Stop; discontinuous/restarted recordings
  as separate numbered segments: `finalizer.js` ✓
- **4.14** — per-stream status so no single failure masquerades as complete
  recording: `stream_status.js` (read-only, verified zero write-surface hits),
  `recorder-get-status` channel message ✓

Spot-traces (principled sample, all confirmed in the current tree):
- 4.6 failure isolation: five-stage per-stream pipeline; one stream's failure never
  blocks the others; partial tracks stopped; manifest-write failure stops the live
  recorder (DECISIONS.md ## 4.6; stream_starter.js).
- 4.8 polling: `CHUNK_POLL_MS = 5000` with jitter at chunk_writer.js:423.
- 4.11→4.13 stop-marker wiring: `emitStopMarker()` called at finalizer.js:764,
  followed by the once-global 1000 ms wait (finalizer.js:771) before any
  `recorder.stop()` — 4.11's forward requirement is connected, not mechanism-only.
- 4.13 numbering: per (sessionId, streamKind), chronological by
  (createdAtUtc, segmentId), 1-based, idempotent (finalizer.js:620).
- 4.14 read-only: zero hits for chrome./document./indexedDB/write vocabulary in
  stream_status.js (comment-only matches).
- 4.9→4.13 finalized field: `MANIFEST_FINALIZED_FIELD = 'finalizedAtUtc'`
  completes 4.9's reservation (finalizer.js:71); 4.9's
  `isManifestRecordFinalized` exclusion works with no other 4.9 change.
- Lazy seams wired: `getFinalizer()` and `getStreamStatusReader()` defined in
  recorder.js (1007, 1051) and consumed at 1317/1346.

## 4. Cross-task coherence — one complete lifecycle

start (4.6 mints uuid-v4 segmentIds, writes manifest records at stream start with
actual start times) → chunks (4.8 polls `requestData()` into the `media_chunks`
compound-key store) → health (4.9's track listeners emit the three event types to
the SW log; 4.14's additive `getStreamHealth` mirrors per-kind health in-memory)
→ clock links (4.10 links each segmentId to the current clock anchor, identity-only)
→ markers (4.11 emits start marker after ≥1 stream starts; 4.13 calls
`emitStopMarker()` before stopping) → stop/finalize (4.13's 11-step sequence:
marker → 1000 ms wait → chunker stop → recorder.stop() → bounded flush await →
monitor detach before track stop → track release → registry discard → finalize
pass with atomic splits, per-kind numbering, `finalizedAtUtc`) → status query
(4.14's `recorder-get-status` returns the 17-key per-stream status over registry,
chunk state, live tracks, health mirror, manifest). The pipeline hangs together;
no dangling seams found.

"Finalize ≠ file" reading confirmed faithful: PLAN line 179 says "Finalize
available chunks on Stop; keep discontinuous or restarted recordings as separate
numbered segments." File assembly is §6.4/§6.5's work; 4.13 numbers segments,
§6 assembles files. (This was the inaccurate brief wording the 4.13 reviewer
caught; the contract's segment/file boundary stands.)

## 5. Discipline checks

- `git diff main -- PLAN.md` — empty ✓ (PLAN.md unmodified)
- `main` branch — untouched (local ref still at 19dbe4c, the remote start SHA) ✓
- content scripts/gameplay — all content.js changes are from §2/§3 tasks
  (2.3, 2.7, 2.8, 3.1–3.5); **zero §4 changes** to content.js (verified: no diff
  vs checkpoint-03 `eca2d9a`); 4.11 added the new `sync_flash.js` content script
  with content.js byte-identical ✓
- `MANIFEST_KEYS` — 18 (8 base + 5×4.6 + 2×4.7 + 1×4.10 + 2×4.13) ✓
- `DB_VERSION` — 2 ✓
- Channel vocabulary — 24 distinct messages (23→24 with 4.14's
  `recorder-get-status`; `RECORDER_MSG_KIND` is a field-name constant, not a
  message) ✓
- Suite — auditor's independent re-run: **1094/1095** (Gap 1, mechanical,
  post-commit; STATE.json records 1095/1095 from the pre-commit builder tree)
- All 14 tasks committed as feature + state pairs (28 commits); current HEAD
  `da5a050` (record task 4.14 state); working tree has exactly one uncommitted
  file (Gap 2)

## 6. Carry-forward list (§5/§6/§7 handoff)

**For §5 (session controls):**
1. "Required streams" policy is §5's, not 4.14's (4.14 reports facts; §5 applies
   its required-set) — answers the 4.6 carry-forward; §5.6 readiness gating
   ("show readiness only after required media streams have started and an
   initial storage write has succeeded") consumes 4.14's status.
2. `flushTimedOut` is response-only, not persisted, and 4.14's status does NOT
   surface it — §5's Stop flow (§5.10: "await final storage acknowledgments
   and media finalization before presenting export as complete") must surface
   it. Recorded as a gap for §5, not a §4 defect.
3. `recorder-get-status` is §5.1's health-indicator query surface; 4.13's stop
   response (markerId, finalizedAtUtc, per-stream results) is §5.10's seam.
4. 4.6's already-started registry guard is §5.5's duplicate-Start seam; 4.9's
   game-boundary events + 4.13's segment machinery are §5.9's.
5. 4.14 NOTEs: `nowUtcIso` opt currently unused; `chunk:null` ambiguous on
   chunker-start failure (wiring-defect-only case); superseded generations are
   counted in `unfinalizedSegments` (honest); lazy status construction in the
   read path is a deliberate tradeoff.

**For §6 (export):**
6. §6.3's `media-sync.json` reads: 4.14's status shape, 4.10's clockSegmentIds,
   4.12's timecode library, 4.11's `sync_marker` events, 4.13's
   `segmentNumber`/`finalizedAtUtc`.
7. §6.4/§6.5 assemble 4.13's finalized, numbered segments into original-format
   files with numbered filenames; §6.6 ZIPs; §6.7 needs repeatable export.
   4.14 NOTE: late-chunk-after-finalize handling is §6's concern.
8. Export must use readonly reads and prove identical store counts
   before/after (standing rule carried from mission brief).

**For §7 / owner device (V3):**
9. Stop double-beep audibility *in the recordings* (4.13 AC11; §7.9 "markers
   align with event timestamps at both ends").
10. Visible flash on a real Chess.com page (V2 honestly recorded `skipped` —
    no target tab).
11. Real headed `getDisplayMedia` picker transient activation (4.6's
    `picker-unavailable` degradation is V1-pinned; real behavior unknown).
12. Physical mute/unplug/recorder-error behavior (V1/V2-pinned or synthetic).
13. Tab-audio capture content: V1-pinned (tab capture failed honestly in the
    sandbox; 4.7 classifies by construction only).
14. Mid-segment discontinuity splits: V1-pinned (post-gap media not forceable
    headless).
15. Real-device split/restart reality; real Chrome timecode characterization
    (4.12's observed series are run-specific, not spec).
16. 4.1: `getContexts` fallback covers Chrome 116–149 (owner device is 154).
17. Chess.com result-dialog/reconnect observation remains unsupported (§3
    carry-forward — do not fabricate observers).

## 7. Auditor's final note

Section 4 is substantively complete and coherent. The only work standing between
this audit and checkpoint-04 is the two mechanical repairs in the verdict above
(post-commit pin tolerance + commit the leftover test evolution), followed by a
green 1095/1095 re-run. No PLAN requirement is missing, weakened, or
reinterpreted; the anti-masquerade core of §4.14 and the finalize-not-file
boundary of §4.13 were both traced against actual code and hold.
