# Section 2 milestone audit — checkpoint-02

**Auditor:** independent (did not implement, review, or verify any 2.x task).
**Date:** 2026-10-06. **Branch:** `autodev/logging-instrumentation`.
**Scope:** PLAN.md §2 (tasks 2.1–2.9), "Add persistent event storage".

## Verdict: SECTION-2-COMPLETE — 0 blockers

## 1. Evidence completeness

All 36 evidence files exist (contract/build/review/behavior × 9 tasks):

| Task | contract | build | review | behavior |
|------|----------|-------|--------|----------|
| 2.1 | ✓ | ✓ | ✓ | ✓ |
| 2.2 | ✓ | ✓ | ✓ | ✓ |
| 2.3 | ✓ | ✓ | ✓ | ✓ |
| 2.4 | ✓ | ✓ | ✓ | ✓ |
| 2.5 | ✓ | ✓ | ✓ | ✓ |
| 2.6 | ✓ | ✓ | ✓ (+ SF-1 repair re-review) | ✓ |
| 2.7 | ✓ | ✓ | ✓ | ✓ (+ coordinator repair note) |
| 2.8 | ✓ | ✓ | ✓ | ✓ |
| 2.9 | ✓ | ✓ | ✓ | ✓ |

## 2. Review and behavior verdicts

| Task | Review verdict | SHOULD_FIX status | Behavior verdict |
|------|---------------|-------------------|------------------|
| 2.1 | APPROVE (0 blockers) | none | PASS |
| 2.2 | APPROVE_WITH_DEFECTS (0 blockers) | 1 doc-only — FIXED (sw.js header reworded; verified in current sw.js) | BEHAVIOR_VERIFIED |
| 2.3 | APPROVE (0 blockers) | none | BEHAVIOR_VERIFIED |
| 2.4 | APPROVE_WITH_DEFECTS (0 blockers) | SF-1 allowlist (mechanical precedent) — handled; SF-2 header misattribution — FIXED (no "2.6 restart" text remains in writer.js) | BEHAVIOR_VERIFIED |
| 2.5 | APPROVE (0 blockers) | none | BEHAVIOR_VERIFIED |
| 2.6 | APPROVE_WITH_DEFECTS (0 blockers) | SF-1 (writer silent renumber) — REPAIRED, targeted re-review APPROVE | BEHAVIOR_VERIFIED |
| 2.7 | APPROVE (0 blockers) | none | BEHAVIOR_VERIFIED on repaired tree (headline BEHAVIOR_FAIL was 4 mechanical git-status pins; coordinator repair note appended; no impl change) |
| 2.8 | APPROVE (0 blockers) | none | BEHAVIOR_VERIFIED |
| 2.9 | APPROVE_WITH_DEFECTS (0 blockers) | SF-1 (scan coverage) — REPAIRED by coordinator (derived load-surface list + meta-assertion) | BEHAVIOR_VERIFIED |

Every SHOULD_FIX ever raised in Section 2 is closed with evidence.

## 3. Full suite (re-run by auditor)

`node --test tests/*.test.js`: **424 tests, 424 pass, 0 fail.**

Per-file: db 20, writer 29, sender 38, session_store 31, lifecycle 40,
status_indicator 21, retention 9 (+ Section 1 suites).

## 4. PLAN.md §2 requirement mapping

- **2.1.** "Add the smallest required extension background/service-worker entry to the manifest." → `manifest.json` gains exactly `"background": {"service_worker": "sw.js"}`; sw.js initially inert, no permissions/CSP/host changes. ✓
- **2.2.** "Create an extension-owned IndexedDB database for metadata, events, and media chunks; do not use Chess.com's localStorage for experiment records." → `db.js`: database `blindfold-experiment`, stores `events`/`session_metadata`/`conditions`/`sequence_state`/`media_chunks`. Retention test + reviewer confirm zero experiment-data localStorage use (only pre-existing gameplay piece-set key). ✓
- **2.3.** "Add a content-script event sender that timestamps and queues observations immediately." → `sender.js`: observation-time timestamps, per-session lazy clock_anchor, in-memory FIFO, stop-and-wait delivery. ✓
- **2.4.** "Add a transactional event writer that deduplicates by event ID and acknowledges durable writes." → `writer.js`: one raw IDB transaction per write, per-session appendSeq, dedup by eventId (idempotent same-content / mismatch error), ack only after `transaction.oncomplete`. ✓
- **2.5.** "Retry unacknowledged events while the originating context remains available." → `sender.js`: 10s per-attempt timeout, 5s fixed retry interval, uniform retry for transport/timeout/malformed-ack/writer-rejection; no unload flush. ✓
- **2.6.** "Restore session metadata and stored sequence state after background-worker restart." → `session_store.js` (save/restore/peek); writer needs no in-memory restore (re-reads sequence_state per transaction); two-launch real-Chrome proof (gapless 0–9 across restart); SF-1 repair makes corrupt-counter handling honest on both sides. ✓
- **2.7.** "Record page/context start and clean-end events; mark an unclean discontinuity when recovery detects a missing end." → `lifecycle.js`: `page_start`/`page_end_clean`/`page_discontinuity`; detection on committed page_start; no unload flush (2.5 tension resolved); real-Chrome harness 25/25. ✓
- **2.8.** "Surface write failures and storage-capacity problems in the session status indicator." → `status_indicator.js`: in-page health light (green/amber/red + raw code tooltip); pure classifier; transient vs persistent vs storage-full; fail-closed; real-Chrome harness 35/35 including the real `write-failed:CorruptSequenceState` path. ✓
- **2.9.** "Keep saved records until deliberate deletion; export must not delete the originals." → `tests/retention.test.js` 9/9: zero deletion primitives across the full derived load surface; closeDatabase connection-only; no retention metadata; binding §6 export constraint in DECISIONS.md (readonly reads; identical counts before/after). ✓

No weakening, reinterpretation, or omission found. V3 items (2.6 AC13, 2.7 AC18, 2.8 AC15, 2.9 AC6) are explicitly deferred to §7/owner device in their contracts — honest deferral, not omission.

## 5. Scope check (standing prohibitions)

Grep for transcription/engine-analysis/stockfish/charts/dashboards/metrics across product code: the single hit is a `status_indicator.js` comment explicitly stating it is NOT a dashboard (no counts/history/metrics/interaction). No analysis commands, transcription, engine analysis, charts, dashboards, reconstruction-test interfaces, or unrelated gameplay refactors. ✓

## 6. Diff discipline

- `main` untouched (local HEAD `19dbe4c`, the recorded baseline; zero diff).
- `git diff main..HEAD`: 21,791 insertions, **1 deletion** — the single deleted line is `manifest.json`'s `js` array line, replaced by its strict superset (all four original entries preserved, four instrumentation entries added). Strictly this is 1 deletion on a main-origin file; substantively it is purely additive — no main-origin functionality, entry, or behavior was removed. `content.js` and `overlay.css` diffs are pure additions (0 deletions). New product modules are new files.
- Working tree clean; `PLAN.md` byte-identical to main.

## 7. Chess.com constraints

Grep for password/passwd/secret/api-key patterns: zero hits. The only account-name mention is `.autodev/STATE.json`'s operational note recording the authenticated test session (`BlindfoldVision`) — a name, not a credential; no password, secret, or key exists anywhere in the repo, evidence, or agent context. No live/rated human play, no messaging, no purchases (per mission records; nothing in the codebase contradicts this).

## 8. Carry-forwards to later sections (not blockers)

- 2.8 reviewer NOTEs: install idempotency, setTimeout guard, quota on future §5 metadata saves, fallback z-index (V3 visual check).
- 2.7 review NOTE: §5 must decide session scoping across tabs (controls discontinuity-marker noise); spurious-marker rate unmeasured until V3.
- 2.6/2.9 NOTEs: §6.1 must handle the 8-field stored conditions form; §6 export must satisfy the readonly + identical-counts constraint.
- Lifecycle promise-chain rejection protection is incidental, not explicit — flagged for any future refactor.

**Verdict: SECTION-2-COMPLETE. 0 blockers. Section 2 is done; the mission may proceed to Section 3.**
