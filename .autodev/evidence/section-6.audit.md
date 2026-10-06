# Section 6 milestone audit — "Export a self-contained raw-data bundle"

**Auditor:** independent (did not plan, build, review, or verify any 6.x task).
**Date:** 2026-10-06. **Branch:** `autodev/logging-instrumentation`.
**Scope:** PLAN.md §6 (tasks 6.1–6.8), "Export a self-contained raw-data bundle".
**Tree:** committed through `dbd2b2e` (record tasks 6.7 and 6.8 state); working tree clean.

## Verdict: PASS_WITH_GAPS — 0 blockers, 1 SHOULD_FIX (mechanical pin maintenance)

No PLAN §6 numbered requirement (6.1–6.8) is unimplemented. Every task has
contract/build/review/behavior evidence, every review verdict is APPROVE, and
every behavior verdict is VERIFIED. The auditor's independent V1 re-run is
**1436/1437**; the single failure is the 6.7/6.8 AC6 diff-discipline pin
expecting uncommitted working-tree files on a now-clean tree — a mechanical
end-of-section artifact, not a functional defect (see §6). The one SHOULD_FIX
is that pin update, which the coordinator (not an auditor) should apply.

## 1. Evidence completeness

All evidence files exist. Three task pairs use combined review/behavior files
(6.2+6.3, 6.4+6.5, 6.7+6.8), following the established precedent:

| Task | contract | build | review | behavior |
|------|----------|-------|--------|----------|
| 6.1 | ✓ | ✓ | ✓ | ✓ |
| 6.2 | ✓ | ✓ | ✓ (combined) | ✓ (combined) |
| 6.3 | ✓ | ✓ | ✓ (combined) | ✓ (combined) |
| 6.4 | ✓ | ✓ | ✓ (combined) | ✓ (combined) |
| 6.5 | ✓ | ✓ | ✓ (combined) | ✓ (combined) |
| 6.6 | ✓ | ✓ | ✓ | ✓ |
| 6.7 | ✓ | ✓ | ✓ (combined) | ✓ (combined) |
| 6.8 | ✓ | ✓ | ✓ (combined) | ✓ (combined) |

Plus `section-6.architecture.md` (section planner's design document).
All 8 tasks committed as feature + state pairs (10 commits);
`git log` confirms the sequence 6.1 → 6.2+6.3 → 6.4+6.5 → 6.6 → 6.7+6.8
with no interleaving.

## 2. Review and behavior verdicts

| Task | Review verdict | Open notes | Behavior verdict |
|------|---------------|------------|------------------|
| 6.1 | APPROVE | N1 (throw-vs-return deviation, documented, 6.6 handles); N2/N3 (lenient nested fields, fail-safe); N4 (exportedAtUtc vs 6.7, resolved by 6.7); N5 (empty gameIds array, honest) | VERIFIED |
| 6.2 | APPROVE | N1 (JSON.stringify undefined-key edge, theoretical) | VERIFIED |
| 6.3 | APPROVE | (Q-probes all pass; no open notes) | VERIFIED |
| 6.4 | APPROVE | N1 (Blob rejection propagates as-is, honest); N2 (split-piece init limitation, documented) | VERIFIED |
| 6.5 | APPROVE | N1 (theoretical duplicate-detection defeat — **repaired** by coordinator: kind-name tiebreaker in `compareSegments`) | VERIFIED |
| 6.6 | APPROVE | D1 (byteLength vs blob.size for offsets — latent, documented); contract deviation (no data descriptors, 6.6 overrode 6.4 §5) | VERIFIED |
| 6.7 | APPROVE | N1 (fake DB chunk read — acceptable); N2 (timestamp format pinned — not a defect) | VERIFIED |
| 6.8 | APPROVE | N1 (~/Downloads hint); N2 (omits stop-verdict-unavailable edge — reasonable) | VERIFIED |

Every NOTE raised in Section 6 is closed, documented as a non-defect, or
explicitly carried forward with a resolution. The 6.5 N1 theoretical issue
was repaired in code (not just documented).

## 3. PLAN requirement coverage (actual text, task by task)

- **6.1** — metadata.json from stored context + completion status:
  `exporter.js::buildMetadataJson` (pure; IDs, category, versions,
  training fields from conditions, verbatim initialConditions,
  per-game gameStartingFen (null where unknown), completion from 5.10
  verdict (absent → 'unknown', 'failed' → throws), media inventory,
  coverage counts, labeled exportedAtUtc). Byte-stable output. ✓
- **6.2** — events.jsonl in persistent append order:
  `exporter.js::buildEventsJsonl` (pure; sorts by appendSeq ascending;
  verbatim passthrough — adds nothing, strips nothing; corrupt/
  duplicate appendSeq → TypeError). game_reset boundaries preserved
  (no event-type filtering anywhere in exporter.js). ✓
- **6.3** — media-sync.json with filenames/formats/anchors/offsets/gaps:
  `exporter.js::buildMediaSyncJson` (pure; verbatim manifest facts;
  ONE computed value `mediaStartWallUtcMs` via timecode.js canonical
  formula, never rounded, null when unusable; two-layer known gaps —
  session echoes 5.10 warnings verbatim, per-segment fixed vocabulary;
  deterministic ordering). ✓
- **6.4** — assemble chunks without transcoding:
  `exporter.js::assembleSegmentChunks` (pure async; byte-concatenation
  in input order; zero transcoding — original Blob references, not
  copies; incremental CRC-32; O(largest chunk) heap; gaps honest;
  fail-closed on duplicates/missing data). ✓
- **6.5** — numbered files for interrupted recordings:
  `exporter.js::nameSegmentFiles` (pure sync; `{streamKind}-{NNN}{ext}`,
  min 3 digits, per-kind; 4.13's segmentNumber verbatim; nulls get
  smallest unused integers in deterministic order; extension from
  fileExtension → MIME mapping → TypeError; export-time labels only).
  Plus the auditor-confirmed `compareSegments` kind-name tiebreaker
  hardening. ✓
- **6.6** — ZIP packaging with category/date/game-ID path, streaming:
  `exporter.js::buildZipParts` (hand-rolled STORE-only; no data
  descriptors — 6.6 overrode 6.4 §5's flag-bit-3 design; verified with
  system `unzip`), `exportSession` 16-step orchestration (readonly
  with before/after count proof → `store-changed-during-export`;
  honest failure mapping incl. `session-not-complete` catch of 6.1's
  throw); `sw.js` export-request listener (first chrome.runtime.onMessage;
  kind:'export' isolated from recorder channel); `manifest.json`
  "downloads" permission (sole delta); `session_controls.js` Download
  button (idle + verdict-gated, "Exporting…" transitional,
  `export-failed:<error>` detail, stays enabled for re-export). ✓
- **6.7** — repeatable export from retained data:
  verification-only (zero product-code changes); exportedAtUtc
  documented as the labeled byte-identity exception (two exports
  differ only in the timestamp; fixed clock → fully byte-identical,
  pinned by V1 with system unzip). ✓
- **6.8** — export documentation: `EXPORT.md` (repo root; download
  location, extraction into experiment directory, bundle contents,
  re-export, explicit non-goals; 7.14 will integrate into README). ✓

Spot-traces (auditor-verified in the current tree):
- 6.1→6.6 failed-verdict: `exporter.js:199` throws
  `session-not-complete`; `exporter.js:1573-1579` catches and maps to
  `fail('session-not-complete')` (6.1 reviewer N1 coordination satisfied).
- 6.5→6.3 wiring: `exporter.js:1545` — `segmentFiles = ctx.naming.bySegmentId`
  (6.5's mapping feeds 6.3's input).
- 6.4→6.6 CRC: 6.4 returns incremental `crc32`; 6.6's `buildZipParts`
  consumes precomputed CRCs (no re-read; no data descriptors per 6.6 §2.3).
- Readonly: zero `DB.put`/`DB.delete`/write patterns in `exporter.js`
  (source scan); before/after count proof in orchestration.
- 5.10→6.6 verdict flow: `session_controls.js:764-775` Download button;
  `sessionId` from retained verdict (6.6-added field); raw
  `{kind:'export',...}` envelope via existing `sendRecorderMessage`.
- Multi-game: `exporter.js:1070` — `<category>/<YYYY-MM-DD>_session-<sessionId>/`
  (Flow rule; media once, never duplicated).

## 4. Cross-task coherence — one complete export pipeline

Download click (6.6: idle + verdict-gated → "Exporting…" →
`export-request` {sessionId, stopVerdict}) → SW `exportSession`
(validate → snapshot counts → read metadata/conditions/events/manifest
→ extract clockAnchors/gameStartingFens from events → 6.5 `nameSegmentFiles`
→ per-segment 6.4 `assembleSegmentChunks` (+ chunkStats) → 6.1/6.2/6.3
builders → 6.6 `buildZipParts` → re-count (mismatch → abort, no download)
→ Blob → `chrome.downloads.download` → revoke → `{ok:true,...}`) →
user extracts ZIP into experiment directory (6.8) → re-export any time
(6.7: byte-identical except exportedAtUtc).

The pipeline hangs together; no dangling seams found. The 6.1–6.5 pure
builders compose through 6.6's orchestration exactly as the architecture
specified.

## 5. Discipline checks

- `git diff main -- PLAN.md` — empty ✓ (PLAN.md unmodified across §6)
- `main` branch — untouched ✓ (verified: `git branch --show-current` =
  `autodev/logging-instrumentation`; no commits on main)
- `exporter.js` — new file on this branch (6.1); §6's only product-code
  home for 6.1–6.5 + 6.6's ZIP writer/orchestration ✓
- New event types in §6 — **zero** ✓ (architecture §6: "One new event
  type: none"; 5.8's `moment_marker` was the last)
- New IndexedDB stores in §6 — **zero** ✓
- New permissions — exactly one: `"downloads"` (6.6's specified
  deliverable; V1-pinned as the sole manifest delta) ✓
- New channel messages — exactly one: SW-side `export-request`
  (`{kind:'export', v:1}`; offscreen MSG_* vocabulary untouched) ✓
- Main-origin file deletions in §6's range (`27351da..HEAD`): two
  line-replacements, both specified —
  (a) `manifest.json` permissions line (adds "downloads"),
  (b) `sw.js` importScripts line (adds exporter.js).
  Neither is a content loss. (Pre-§6 deletions in chess_utils.js/
  content.js/sounds.js are from §§1–5, accepted at their checkpoints.)
- Suite — auditor's independent re-run: **1436/1437** (see §6) ✓
- All 8 tasks committed as feature + state pairs; working tree clean ✓

## 6. Gaps

### SHOULD_FIX 1 — 6.7/6.8 AC6 pin expects uncommitted files on a clean tree (mechanical)

**Severity:** SHOULD_FIX (coordinator pin maintenance; not a functional defect).

**Evidence:** `tests/exporter.test.js:296` (`only 6.1 files appear in git
status`) expects the 6.7/6.8 working-tree file list (evidence files,
EXPORT.md, DECISIONS.md, 29 pin files), but the tree is clean after
commit `9150f38`/`dbd2b2e`. Result: 1 failing test on an otherwise green
suite (1436/1437).

**Why not a blocker:** The pin is a diff-discipline assertion about the
*working tree*, not about the implementation. All 6.7/6.8 functionality
is verified; the pin simply wasn't updated to post-commit form (expecting
`[]`) because 6.7+6.8 was the last task in the section — there was no
"next task" to evolve it. This is the established end-of-section pattern.

**Recommendation:** The coordinator should update the pin's expected list
to `[]` (with a comment noting 6.7/6.8 committed) before the Section 6
audit is considered fully clean. One-line mechanical fix; no re-review needed.

### Notes (non-blocking, for §7 awareness)

- **N1 — Stale comment at `exporter.js:831`:** "Exported for 6.6's ZIP
  writer (streaming data descriptors)" — but 6.6's contract §2.3 (and the
  implementation at `exporter.js:1134`) uses NO data descriptors (flag
  bit 3 NOT set; sizes/CRCs known upfront). The CRC is still exported and
  consumed, just not via data descriptors. Comment-only staleness; the
  code is correct per 6.6's contract which explicitly overrode 6.4 §5.
- **N2 — 6.6 reviewer D1 (carried):** `buildZipParts` uses declared
  `f.byteLength` for central-directory offset tracking rather than
  summing `blob.size`. In 6.6's orchestration the values always agree
  (6.4 provides both), and V1 validates with real `unzip` — but a future
  caller passing mismatched values would silently corrupt the ZIP.
  Documented latent risk; consider a hardening assertion in a future task.
- **N3 — 6.4 contract §5 vs 6.6 contract §2.3:** 6.4's contract specified
  data descriptors (flag bit 3); 6.6's contract overrode to no-data-descriptor
  with precomputed headers. The implementation follows 6.6 (the later,
  more specific contract). The 6.4 contract was not amended — a minor
  documentation inconsistency, not a code defect.

## 7. Carry-forward list (§7 handoff)

**§5 carry-forwards — all closed:**
1. ✅ `metadata.gameIds` array (5.9) → 6.1 exports the full array verbatim;
   multi-game ZIP uses `_session-<sessionId>/` directory (Flow rule).
2. ✅ Enriched `lastStopResponse` (5.10) → travels in the `export-request`
   message; 6.1/6.3 consume `verdict`/`warnings`/`stopResp`/`flushResult`.
3. ✅ `flushTimedOut` (response-only) → 6.3 reads it from
   `stopVerdict.stopResp.streams[kind].flushTimedOut`, never from a store;
   surfaced in `knownGaps` + per-segment `gaps`.
4. ✅ `moment_marker` (5.8) → flows through 6.2's verbatim passthrough;
   no special handling needed.
5. ✅ Readonly export with unchanged store counts → 6.6's before/after
   snapshot + `store-changed-during-export`; zero writes in exporter.js.

**For §7 / owner device (V3):**
6. Real-device export end-to-end: record a bot-game session → Stop →
   Download → extract ZIP → open media files in a player (7.12/7.13);
   verify `mediaStartWallUtcMs` alignment against a sync-marker event
   (6.3 AC10 → 7.9).
7. Realistic-length recording: characterize the Blob-parts memory bound
   on the device (architecture §7: the browser still materializes the
   final Blob for download — 7.12 owns this).
8. Interrupted-download re-export on the device (6.7 AC6).
9. Multi-game session export on the device: two games → one ZIP with
   `_session-<shortId>/` directory, media not duplicated (6.6 AC10 → §7).
10. SHOULD_FIX 1 (the 6.7/6.8 pin) — coordinator mechanical fix, no
    device involvement.
11. §5's SHOULD_FIX 1 (manual termination-reason entry, PLAN §(c) step 7)
    remains open and still requires the owner decision before/during §7.
12. 6.8's EXPORT.md awaits 7.14's README integration.

## 8. Auditor's final note

Section 6 is substantively complete and coherent. The eight tasks form one
clean export pipeline — pure builders (6.1–6.5) composed through a thin
readonly orchestration (6.6), with repeatability proven (6.7) and
documented (6.8). The cross-task interactions the auditor probed
(6.1-throw→6.6-catch, 6.5-naming→6.3-segmentFiles, 6.4-CRC→6.6-ZIP,
5.10-verdict→6.6-message→6.1/6.3-consumers, 6.7←readonly-discipline) all
hold in the code, not just in the reports. The §5 audit's §6 carry-forwards
are closed, every one of them verified against the implementation rather
than taken on trust.

The 6.5 reviewer's theoretical duplicate-detection issue was not merely
documented but repaired in code (the `compareSegments` kind-name
tiebreaker) — the one instance in §6 where a reviewer found something the
builder missed, and it was fixed before commit.

The only work standing between this audit and a SECTION-6-COMPLETE verdict
is SHOULD_FIX 1 (the 6.7/6.8 pin's post-commit update) — a one-line
mechanical fix by the coordinator. Given the numbered requirements are
fully met and the suite is 1436/1437 with the single failure being the pin
itself, the auditor records the section as complete-with-pin-pending rather
than blocked.
