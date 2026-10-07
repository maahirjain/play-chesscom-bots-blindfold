# Termination-reason build report

**Date:** 2026-10-06. **Branch:** `autodev/logging-instrumentation`.
**Scope:** Owner decision (Option A) for PLAN §(c) step 7 and §3.5.4.
**Status:** BUILD COMPLETE. PLAN.md unmodified (0 diff lines).
STATE.json untouched (coordinator-owned).

## 1. What was built

**Owner decision:** Add a small optional text field when stopping. If the
game ending is unknown, the user can type a brief reason (e.g., "abandoned",
"resigned", "browser crashed"). This becomes part of the exported metadata.

### 1.1 `normalizeManualTerminationReason(text)` (chess_utils.js)

Pure function mapping free-text manual input to the 1.4
`TERMINATION_REASONS` vocabulary:
- Exact (case-insensitive) vocabulary match → returns the member.
- `'resigned'` → `'resignation'` (common phrasing).
- Otherwise → `null` (raw text preserved in verdict/metadata, not in game_ended).
- `TypeError` on non-string input.

Local vocabulary copy (deliberate duplication over load-order coupling,
1.3 §2.10 precedent). Exported on the gameLifecycleRecorder namespace.

### 1.2 UI input (session_controls.js)

Text `<input>` in the controls cluster, following the 5.8 moment-marker precedent:
- `className: 'blindfold-termination-input'`
- `placeholder: 'Reason (optional)'`
- Enabled only during ACTIVE phase (via `setTerminationEnabled`).
- Cleared when disabled (for next session).
- Never focused automatically, no hotkey, never blocks Stop.

### 1.3 Stop-time logic (onStopClick)

1. Read input, trim. Empty → `null`.
2. If observed ending exists → use observed reason/result; manual input ignored.
3. If no observed ending and manual text present:
   - Map to vocabulary via `normalizeManualTerminationReason` for game_ended event.
   - Store raw trimmed text in `manualTerminationReason` variable.
4. Pass mapped reason to `recordStopTermination`.

### 1.4 Stop verdict enrichment

The enriched verdict gains `manualTerminationReason: <string|null>`:
```js
var enriched = {
  sessionId: activeSessionId,
  stopResp: stopResp,
  flushResult: ...,
  verdict: completion.verdict,
  warnings: completion.warnings,
  manualTerminationReason: manualTerminationReason  // NEW
};
```

### 1.5 Export to metadata.json (exporter.js)

`buildCompletion` adds:
```js
manualTerminationReason: (typeof stopVerdict.manualTerminationReason === 'string')
  ? stopVerdict.manualTerminationReason
  : null
```

The `completion` section of metadata.json now includes `manualTerminationReason`.

## 2. Verification

### V1 — static/unit

- **AC1:** `normalizeManualTerminationReason('abandoned')` → `'abandoned'`. ✓
- **AC2:** `normalizeManualTerminationReason('resigned')` → `'resignation'`. ✓
- **AC3:** `normalizeManualTerminationReason('browser crashed')` → `null`. ✓
- **AC4:** Non-string input → `TypeError`. ✓
- **AC5:** Observed ending wins over manual input (code inspection + logic). ✓
- **AC6:** Empty input → null; Stop proceeds normally. ✓
- **AC7:** `buildCompletion` includes `manualTerminationReason` in output. ✓
- **AC8:** Diff discipline — only chess_utils.js, session_controls.js,
  exporter.js, tests, evidence, DECISIONS.md modified. No new event types,
  stores, permissions, or channel messages. PLAN.md unmodified. ✓

**V1: 1492/1492 pass** (7 new tests: 5 for mapper, 2 for exporter).

### V2 — integration (deferred)

- **AC9:** Real Stop flow with typed reason → verdict → metadata.json.
  Deferred to owner device testing.

## 3. Files changed

**Product code:**
- `chess_utils.js` — `normalizeManualTerminationReason` function + export (+38 lines)
- `session_controls.js` — UI input, `setTerminationEnabled`, Stop-time logic,
  verdict enrichment (+~60 lines)
- `exporter.js` — `buildCompletion` adds `manualTerminationReason` (+5 lines)

**Tests:**
- `tests/game_lifecycle.test.js` — 5 new mapper tests
- `tests/exporter.test.js` — 2 new exporter tests + pin evolutions
- ~25 other test files — pin allowlist evolutions (additive only)

**Evidence:**
- `.autodev/evidence/termination-reason.contract.md` (new)
- `.autodev/evidence/termination-reason.build.md` (this file)
- `.autodev/DECISIONS.md` — termination-reason entry (to be added)

## 4. Design decisions

1. **Free text, not dropdown:** Owner explicitly requested free text
   ("browser crashed" is not in the vocabulary).
2. **Observed wins:** If a game ending was observed (checkmate, etc.), the
   manual input is ignored. The observed ending is ground truth.
3. **Vocabulary mapping is conservative:** Only exact matches and the
   'resigned'→'resignation' alias. Unmappable text → null in game_ended,
   but raw text preserved in metadata.json.
4. **Never blocks Stop:** Input is optional; empty means unknown (null).
5. **Follows 5.8 precedent:** UI pattern matches the moment-marker input.

## 5. Non-goals (not implemented)

- Changing the `TERMINATION_REASONS` vocabulary.
- Dropdown/autocomplete UI.
- Requiring the reason.
- Overriding observed endings.
