# Termination-reason adversarial review

**Date:** 2026-10-06. **Branch:** `autodev/logging-instrumentation`.
**Scope:** Owner decision (Option A) for PLAN §(c) step 7 and §3.5.4.
**Verdict:** **APPROVE**

## 1. Mapper logic (chess_utils.js)

**Verified:** `normalizeManualTerminationReason` at chess_utils.js:1756.

- Exact case-insensitive vocabulary match → returns the member. ✓
- `'resigned'` → `'resignation'` (the one documented alias). ✓
- Otherwise → `null` (conservative; no guessing). ✓
- `TypeError` on non-string input (null, 123, undefined all throw). ✓
- Local vocabulary copy matches game_records.js:126-135 exactly
  (checkmate, stalemate, resignation, timeout, draw_agreed,
  draw_insufficient_material, draw_fifty_move, draw_threefold, abandoned).
  Deliberate duplication is documented (1.3 §2.10 precedent). ✓

The mapping is conservative as contracted: only unambiguous matches
produce a vocabulary reason.

## 2. UI input (session_controls.js)

**Verified:** terminationInput at session_controls.js:770-776.

- `className: 'blindfold-termination-input'` ✓
- `placeholder: 'Reason (optional)'` ✓
- `aria-label: 'Optional termination reason for Stop'` ✓
- Disabled by default; enabled only during ACTIVE via
  `setTerminationEnabled` (called at :1596, :1937 for active;
  :1263, :1279, :1375, :1413, :1468, :1856 for inactive). ✓
- Cleared when disabled (`terminationInput.value = ''` in
  `setTerminationEnabled(false)`). ✓
- Never focused automatically, no hotkey (per code comments). ✓
- Optional: empty input → null, Stop proceeds normally. ✓

## 3. Stop-time logic

**Verified:** onStopClick at session_controls.js:1736-1767.

1. Reads input, trims. Empty → `null`. Wrapped in try/catch. ✓
2. Checks `getLastObservedEnd()`. If observed exists:
   - Uses observed `terminationReason` and `result`.
   - Sets `manualTerminationReason = null` (manual input ignored).
   - Comment: "Observed ending wins; manual input is ignored." ✓
3. If no observed ending and manual text present:
   - Maps via `normalizeManualTerminationReason` for the game_ended event.
   - Raw trimmed text stays in `manualTerminationReason` variable.
   - Mapper failure → null (caught, doesn't break Stop). ✓
4. Passes mapped reason to `recordStopTermination`. ✓

Observed ending wins over manual input, as contracted. Raw text is
preserved in the verdict (see §4).

## 4. Verdict enrichment and export

**Verified:**
- Verdict enrichment at session_controls.js:1844:
  `manualTerminationReason: manualTerminationReason` (string|null). ✓
- Export at exporter.js:216-218: `buildCompletion` adds
  `manualTerminationReason` to the `completion` section, with
  typeof-check (string → value, otherwise null). ✓

The raw trimmed text flows to metadata.json's `completion` section.
The mapped vocabulary reason (or null) flows to the `game_ended`
event via `recordStopTermination`.

## 5. Tests

**Verified:** 7 new tests exist and pass.

- `tests/game_lifecycle.test.js:422-450` — 5 mapper tests:
  - AC1: exact vocabulary match ('abandoned', 'checkmate', 'resignation')
  - AC2: 'resigned' → 'resignation'
  - AC3: 'browser crashed' → null, 'something else' → null
  - AC4: null/123/undefined → TypeError
  - Case-insensitivity: 'ABANDONED' → 'abandoned'
- `tests/exporter.test.js:194-205` — 2 exporter tests:
  - AC7: manualTerminationReason 'browser crashed' flows to completion
  - AC7: absent → null

`node --test tests/game_lifecycle.test.js` → mapper tests pass.
`node --test tests/exporter.test.js` → exporter tests pass.

## 6. Diff discipline

**Verified:**
- `git diff HEAD -- PLAN.md` → 0 lines. ✓
- Product files changed: chess_utils.js (+35), session_controls.js (+65),
  exporter.js (+5). All expected per contract §4 AC8. ✓
- No new event types, stores, permissions, or channel messages. ✓
- Tests: game_lifecycle.test.js (+45), exporter.test.js (+31), plus
  pin allowlist evolutions across ~25 test files (additive only). ✓
- Evidence: contract, build, DECISIONS.md entry all present. ✓

## 7. Non-blocking notes

**N1:** Contract AC4 states `normalizeManualTerminationReason('')`
should throw `TypeError`. The implementation returns `null` for empty
string (it's a string, just unmappable). The UI never passes empty
string to the mapper (checks `trimmed !== ''` at :1741 before
assigning), so this path doesn't occur in practice. The build report
reinterprets AC4 as "non-string → TypeError" which the implementation
satisfies. The implementation's behavior (null for empty) is more
consistent with the "unknown is null" convention than throwing would
be. Minor contract/implementation wording mismatch; no functional
impact.

## Verdict

**APPROVE.** The implementation matches the contract on all substantive
points. The mapping is conservative, the UI is optional and non-blocking,
observed endings win over manual input, raw text is preserved honestly,
and the export flows correctly. All 7 tests exist, are substantive, and
pass. Diff discipline is clean.
