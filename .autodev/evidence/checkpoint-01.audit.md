# Section 1 Milestone Audit — checkpoint-01-data-contract

**Auditor:** fresh Section 1 milestone auditor (did not build, review, or verify any 1.x task).
**Date:** 2026-10-06. **Branch audited:** `autodev/logging-instrumentation` @ `a343ae6`.
**Scope:** PLAN.md §1.1–§1.4 (raw-data contract). Method: read PLAN §1 fully,
all four contracts, all four modules and test suites line-by-line, all
evidence files, STATE.json/DECISIONS.md/REGRESSIONS.md; re-ran the full
accumulated suite (217/217 pass, confirmed); grepped for scope/derivable-data
violations; verified `git diff main..HEAD` is additions-only.

## Git integrity

- `git diff main..HEAD --stat`: 34 files changed, 8726 insertions, **0 deletions**.
- No existing file touched: `content.js`, `chess_utils.js`, `sounds.js`,
  `manifest.json`, `PLAN.md`, `chess.min.js` all byte-identical to `main`.
- `main` itself untouched; all work on `autodev/logging-instrumentation`.
- Feature commits are clean and ordered: `4ea52c7` (1.1), `0774fc4` (1.2),
  `d72aa68` (1.3), `9ddaccf` (1.4), plus state/evidence commits.

## Per-task coverage

### 1.1 — session/game identity (commit 4ea52c7) — COVERED
- 1.1.1: `newSessionId()` (uuid-v4, crypto-throw-no-fallback); Start-click
  wiring deferred → 5.1/5.5 (AC4), honest.
- 1.1.2: `newGameId()` + `addGameToSession` append-only; one-game normal
  workflow implicit; detection wiring deferred → 3.1/3.5 (AC8), honest.
- 1.1.3: exactly the six metadata keys (`sessionId`, `gameIds`,
  `schemaVersion`, `extensionVersion`, `protocolVersion`, `sessionCategory`).
- AC14 (no derived extras), AC15 (unknown→null), AC16 (JSON/clone safe),
  AC17 (plain-script pattern) all verified in code and tests (30/30 pass,
  re-run confirmed). Repair-review: APPROVE. Retro behavioral: 29/29 PASS.

### 1.2 — session conditions (commit 0774fc4) — COVERED
- 1.2.1: `createInitialConditions` once-per-session record (Start wiring
  deferred → 5.1/5.5, honest).
- 1.2.2: exactly seven `{value, source}` fields; provenance mandatory.
- 1.2.3: unknown is `null` everywhere; free-form approach strings, no
  invented taxonomy; label-text time control; `{}` vs `null` assistance
  distinction.
- 1.2.4: `createConditionChange` carries only changed fields; pure
  `applyConditionChange` fold.
- 47/47 pass (re-run confirmed). Repair-review: APPROVE. Retro behavioral:
  25/25 PASS. Documented deviation (extra-input-key strictness) reviewed and
  approved; see NOTE-1.

### 1.3 — event identity and time (commit d72aa68) — COVERED
- 1.3.1: exactly 11-key envelope; flat snake_case types; three source
  contexts.
- 1.3.2: clock-anchor triple; capture order `performance.now()` →
  `Date.now()`; per-context capture wiring deferred → 2.3/2.6/2.7/4.1, honest.
- 1.3.3: caller-supplied `monotonicMs` + `clockSegmentId`, stored verbatim.
- 1.3.4: `appendSeq` null at creation; assignment deferred → 2.4 (AC18),
  honest; source times never rewritten.
- 1.3.5: `refs` null-or-flat `{roleId: uuid}` map; concrete roles deferred →
  3.2/3.4/4.10 (AC20), honest; 1.4 contributes exactly two roles.
- 47/47 pass (re-run confirmed). Adversarial review's five findings all
  repaired; retro targeted re-review: APPROVE. Retro behavioral: 34/34 PASS.

### 1.4 — game reconstruction records (commit 9ddaccf) — COVERED
- 1.4.1: `game_started` payload exactly `{fen}`; starting FEN once per game.
- 1.4.2: `move_confirmed` exactly `{from, to, promotion}`; no timestamps on
  payloads (observation time from the 1.3 envelope).
- 1.4.3: marker-first `history_recovered`/`history_revised`; original stream
  never rewritten; suffix-retraction semantics; expected-move-count
  truncation detection.
- 1.4.4: `position_checkpoint` behind a documented strict gate
  (unreconciled_history only; recorded sync failure + unbridgeable gap +
  stated FEN); cannot be read as routine permission.
- 1.4.5: `game_ended` with PGN result vocabulary, 9 grounded termination
  reasons + null, observed/manual evidence source, raw observedText;
  unknown/manual completion allowed.
- 93/93 pass incl. 2 repair tests (re-run confirmed). Review:
  APPROVE_WITH_DEFECTS → 2 repairs (consecutive-digit FEN rejection,
  trim-and-store) → targeted re-review APPROVE. Independent behavioral
  verifier: BEHAVIOR_VERIFIED (19 checks incl. hand-derived chess.js replay
  proofs for castling/promotion/en passant).

## Cross-cutting findings

### SHOULD_FIX
1. **1.2 STATE.json deferred "AC18 envelope -> 1.3" is stale.** Task 1.3's
   contract is DONE; the real remaining work (emitting `conditions_changed`
   envelopes at runtime) belongs to §3.x/§5.x emitters. Re-point to avoid a
   false "satisfied" reading.
2. **1.4 STATE.json deferred "event-type registration at runtime -> 1.3
   registry" is misworded.** Task 1.3 has no registry — each task's module
   owns its event-type constants and `isEventType` validates at envelope
   assembly. Reword (e.g. "emitter envelope assembly validates via
   isEventType -> 2.3/3.x").

### NOTE
1. **Extra-input-key inconsistency is ACCEPTABLE.** 1.2's factory rejects
   extras (documented, reviewer-approved deviation); 1.1/1.3/1.4 ignore them.
   Record-level integrity holds in all four (exact-key validators; no extra
   key can reach a stored record). Two independent reviewers concurred that
   unification would rewrite locked contracts for no data-integrity benefit.
   Recommendation: record "lenient-on-input / strict-on-record" as the
   convention for future modules (e.g. in REGRESSIONS.md or the §2 contract).
2. **AC9-style replay oracle caveat (carry to §7.2):** the vendored
   `validate_fen` calls a 3-king FEN "valid" while `new Chess()` silently
   drops the extra king — replay proofs are only meaningful on legal
   positions. This validates the structural-only validator design (it
   preserves such observations verbatim). Recorded in 1.4.behavior.md.
3. **Process debt closed honestly.** The retroactive 1.1–1.3 behavioral
   verifiers (88/88) and the 1.3 repair re-review (APPROVE) ran against the
   same committed code that shipped (1.1/1.2/1.3 modules untouched since
   their feature commits — confirmed via git history). Evidence files exist,
   verdicts match claims, and the debt was disclosed as calibration evidence
   rather than hidden.
4. **V2 labeling inconsistency (minor).** 1.1's STATE entry says "V2/V3/V4
   N/A", but the same headless-Chrome smoke harness that gives 1.2–1.4
   "V2 PASS" also exercises 1.1's code (uuidShape, sixKeys, frozen,
   gameAppended, cloneOk — all passed). 1.1's entry under-claims; suggest
   recording V2 PASS for 1.1 as well.

## Non-derivable-data discipline — PASS

- No SAN, PGN (beyond the allowed game-end vocabulary), move numbers,
  per-move FEN, durations, or timestamps on payloads anywhere in the four
  modules (grep-verified; only comments mention the excluded concepts).
- `expectedMoveCount`/`observedHistoryLength` are observed/emitter-stated
  values, not derivations; `deriveWallUtcMs` is a pure function, not
  persisted data; `gameIds.length > 1` implicitly marks shared sessions
  (explicitly derivable, no flag persisted).

## Scope discipline — PASS

- Modules contain factories, validators, constants, and one derivation
  formula only. No `chrome.*`, DOM, storage, analysis, metrics,
  transcription, engine, UI, or gameplay-refactor code (grep-verified; the
  sole `chrome.*` mention is a header comment stating the module uses none).

## Process integrity — PASS

Every task completed planner → builder → mechanical verification →
adversarial reviewer → behavioral verifier → repair/re-review:
- 1.1: contract, build, review (2 defects repaired), targeted re-review
  APPROVE, retro behavioral 29/29 PASS.
- 1.2: contract, build, review (2 defects repaired), targeted re-review
  APPROVE, retro behavioral 25/25 PASS.
- 1.3: contract, build, review (5 defects repaired), retro targeted
  re-review APPROVE, retro behavioral 34/34 PASS.
- 1.4: contract, build, review (2 defects repaired), targeted re-review
  APPROVE, behavioral 19/19 PASS.
All evidence files present and consistent with claims; test counts
re-confirmed by this auditor (217/217 accumulated pass).

## Overall verdict

**SECTION-1-COMPLETE** — 0 blockers, 2 SHOULD_FIX (both are STATE.json
wording/target corrections, no code impact), 4 NOTEs. The §1 raw-data
contract is fully specified, implemented, independently reviewed, and
behaviorally verified at V1+V2, with honest deferrals to owning future tasks.
