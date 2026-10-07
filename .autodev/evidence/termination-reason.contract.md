# Termination-reason contract — Manual reason at Stop

**Date:** 2026-10-06. **Branch:** `autodev/logging-instrumentation`.
**Scope:** Owner decision (Option A) for PLAN §(c) step 7 and §3.5.4.
**Status:** CONTRACT ONLY. No implementation code written. PLAN.md unmodified.
STATE.json untouched (coordinator-owned).

## 1. Scope

PLAN §(c) step 7: "Click Stop. If the ending is unknown, supply a brief
reason such as abandoned or resigned."

PLAN §3.5.4: "Allow a termination reason at Stop when the ending is
unknown, such as abandonment."

**What this does:** Add a small optional text input to the session
controls cluster. When the user clicks Stop, if no game ending was
observed (no `game_ended` from chess_rules or chesscom_dialog), the
typed reason is recorded. It flows to the exported metadata.json.

**What this does NOT do:** It does not change the `game_ended` event
schema (vocabulary is fixed). It does not block Stop. It does not
override an observed ending. It does not add new event types, stores,
or permissions.

## 2. Design

### 2.1 UI placement

A text `<input>` in the controls cluster, following the 5.8 moment-marker
precedent:
- `className: 'blindfold-termination-input'`
- `placeholder: 'Reason (optional)'`
- `aria-label: 'Optional termination reason for Stop'`
- Enabled only during ACTIVE phase (like the marker input).
- Cleared after Stop completes (for the next session).
- Never focused automatically, never prompts, no hotkey.

### 2.2 Stop-time logic

In `onStopClick`, before calling `recordStopTermination`:

1. Read the input value, trim. Empty string → `null` (unknown means unknown).
2. Check for observed ending via `getLastObservedEnd()`:
   - **If observed exists:** Use the observed `terminationReason` and `result`.
     The manual input is ignored (observed is ground truth).
   - **If no observed ending and manual text present:**
     - Map the text to vocabulary (see §2.3) for the `game_ended` event.
     - Store the raw trimmed text in the stop verdict.
   - **If no observed ending and no manual text:** Both are null (unknown).

### 2.3 Vocabulary mapping

The `game_ended` event's `terminationReason` must be a
`TERMINATION_REASONS` member or null (game_records.js enforces this).

`normalizeManualTerminationReason(text)`:
- Input: trimmed string (non-empty).
- Lowercase the input.
- If it exactly matches a `TERMINATION_REASONS` member → return it.
- If it is `'resigned'` → return `'resignation'` (common phrasing).
- Otherwise → return `null` (the game_ended event records unknown;
  the raw text is still preserved in the verdict/metadata).

This is honest: we only claim a vocabulary reason when the mapping is
unambiguous.

### 2.4 Stop verdict enrichment

The enriched verdict in `finalizeStop` gains one field:
```js
var enriched = {
  sessionId: activeSessionId,
  stopResp: stopResp,
  flushResult: ...,
  verdict: completion.verdict,
  warnings: completion.warnings,
  manualTerminationReason: <string|null>  // NEW
};
```
- `manualTerminationReason` is the raw trimmed text, or null.
- It is set from the input value captured at Stop time (before the
  async flush; the input is cleared after).

### 2.5 Export to metadata.json

`buildCompletion` in exporter.js adds:
```js
manualTerminationReason: (typeof stopVerdict.manualTerminationReason === 'string')
  ? stopVerdict.manualTerminationReason
  : null
```

The `completion` section of metadata.json gains `manualTerminationReason`.

`requireValidStopVerdict` is already lenient on extra keys (it only
validates `verdict` and `warnings`), so no change needed there.

## 3. Error conventions

- `normalizeManualTerminationReason`: `TypeError` if input is not a string.
  Returns null for unmappable text (not an error — unknown is null).
- UI code: never throws into page code (3.2 SF-1 precedent). All
  input reads are wrapped in try/catch.

## 4. Acceptance criteria

### V1 — static/unit (Node, no browser)

- [ ] **AC1.** `normalizeManualTerminationReason('abandoned')` → `'abandoned'`.
- [ ] **AC2.** `normalizeManualTerminationReason('resigned')` → `'resignation'`.
- [ ] **AC3.** `normalizeManualTerminationReason('browser crashed')` → `null`
      (raw text preserved in verdict, not in game_ended).
- [ ] **AC4.** `normalizeManualTerminationReason('')` → throws `TypeError`
      (caller trims first; empty is not a valid input to the mapper).
- [ ] **AC5.** Stop-time precedence: observed ending wins over manual input.
- [ ] **AC6.** Empty input → null manual reason; Stop proceeds normally.
- [ ] **AC7.** `buildCompletion` includes `manualTerminationReason` in output.
- [ ] **AC8.** Diff discipline: only session_controls.js, exporter.js,
      chess_utils.js (if mapper lives there), tests, evidence, DECISIONS.md.
      No new event types/stores/permissions. PLAN.md unmodified.

### V2 — integration (deferred)

- [ ] **AC9.** Real Stop flow with typed reason → verdict contains it →
      metadata.json contains it.

## 5. Explicit non-goals

- Changing the `TERMINATION_REASONS` vocabulary.
- A dropdown or autocomplete (free text per owner decision).
- Requiring the reason (always optional).
- Showing the input when idle (only during ACTIVE).
- Overriding observed endings with manual text.
