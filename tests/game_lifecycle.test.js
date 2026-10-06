// tests/game_lifecycle.test.js
//
// Task 3.5 (PLAN.md §3.5): "Instrument lifecycle events."
//
// V1 — static/unit. Covers 3.5.contract.md AC1–AC11 (AC12 is the V2
// sw-lifecycle-game.js harness; AC13 is V3-deferred to §7).
//
// The game lifecycle recorder is DOM-free. content.js wiring (visibility
// listeners, onGameReset, observeMoves callback) is verified by source
// inspection since content.js cannot load in Node (top-level document
// access).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// Chess must be on globalThis before chess_utils.js uses it.
globalThis.Chess = require('../chess.min.js').Chess;

// Merge namespaces on globalThis (the repo's Node test pattern).
const GameRecords = require('../game_records.js');
const ChessUtils = require('../chess_utils.js');
const merged = Object.assign({}, GameRecords, ChessUtils);
globalThis.BlindfoldSession = merged;
const BlindfoldSession = merged;

// Deterministic uuid-v4 fixtures.
let uuidCounter = 0;
function testUuid() {
  uuidCounter++;
  const h = uuidCounter.toString(16).padStart(12, '0');
  return `11111111-2222-4333-8444-${h}`;
}
function sid() { return testUuid(); }
function gid() { return testUuid(); }

// Capturing emitEvent stub. Returns envelopes with uuid eventIds.
function makeEmitter() {
  const calls = [];
  const emitEvent = (eventType, payload, refs) => {
    const envelope = { eventId: testUuid(), eventType };
    calls.push({ eventType, payload, refs, eventId: envelope.eventId });
    return envelope;
  };
  return { calls, emitEvent };
}

function makeRecorder({ sessionId, gameId } = {}) {
  const { calls, emitEvent } = makeEmitter();
  const s = sessionId === undefined ? sid() : sessionId;
  const g = gameId === undefined ? gid() : gameId;
  const recorder = BlindfoldSession.createGameLifecycleRecorder({
    getSessionId: () => s,
    getGameId: () => g,
    emitEvent,
  });
  return { recorder, calls };
}

function types(calls) {
  return calls.map((c) => c.eventType);
}

// ------------------------------------------------------------------
// AC0 — contract surface: constants, validators, factory exist.
// ------------------------------------------------------------------
describe('AC0 — 3.5 namespace surface', () => {
  it('event-type constants and frozen vocabularies exist', () => {
    assert.equal(BlindfoldSession.DOCUMENT_VISIBILITY_CHANGED_EVENT_TYPE, 'document_visibility_changed');
    assert.equal(BlindfoldSession.GAME_RESET_EVENT_TYPE, 'game_reset');
    // game_ended is 1.4-owned (PLAN §1.4.5); 3.5 must not redeclare it.
    assert.equal(BlindfoldSession.GAME_ENDED_EVENT_TYPE, 'game_ended');
    // 1.4's termination vocabulary (9), owned by game_records.js.
    assert.deepEqual([...BlindfoldSession.TERMINATION_REASONS], [
      'checkmate', 'stalemate', 'resignation', 'timeout', 'draw_agreed',
      'draw_insufficient_material', 'draw_fifty_move', 'draw_threefold',
      'abandoned',
    ]);
    // 3.5's recorder-internal source keys (dedup only; never persisted).
    assert.deepEqual([...BlindfoldSession.GAME_END_SOURCES],
      ['chess_rules', 'chesscom_dialog', 'stop']);
    assert.ok(Object.isFrozen(BlindfoldSession.GAME_END_SOURCES));
  });

  it('3.5 ships no forked game_ended schema (SF-1 repair)', () => {
    // The 3.5 TERMINATIONS fork is gone.
    assert.equal(BlindfoldSession.TERMINATIONS, undefined,
      'no 3.5 TERMINATIONS fork on the namespace');
    // The merged namespace's requireValidGameEndedPayload must be 1.4's:
    // 1.4-shaped payloads are accepted, 3.5-shaped payloads rejected.
    // (3.5 once shadowed 1.4's validator; this is the regression pin.)
    assert.doesNotThrow(() => BlindfoldSession.requireValidGameEndedPayload({
      result: '1-0', terminationReason: 'checkmate',
      evidenceSource: 'observed', observedText: null,
    }));
    assert.throws(() => BlindfoldSession.requireValidGameEndedPayload({
      termination: 'checkmate', source: 'chess_rules', speechLogicVersion: '1',
    }), TypeError);
  });

  it('factory requires function options (TypeError otherwise)', () => {
    assert.throws(() => BlindfoldSession.createGameLifecycleRecorder({}),
      TypeError);
    assert.throws(() => BlindfoldSession.createGameLifecycleRecorder({
      getSessionId: 'x', getGameId: () => gid(), emitEvent: () => ({}),
    }), TypeError);
  });

  it('pre-§5 inertness: null/empty ids → null, no throw, no emit', () => {
    for (const ids of [{ sessionId: null, gameId: gid() },
                       { sessionId: '', gameId: gid() },
                       { sessionId: sid(), gameId: null }]) {
      const { recorder, calls } = makeRecorder(ids);
      assert.equal(recorder.recordVisibilityChange('visible', true), null);
      assert.equal(recorder.recordGameReset(3), null);
      assert.equal(recorder.recordGameEnded('chess_rules', {
        result: '1-0', terminationReason: 'checkmate',
        evidenceSource: 'observed', observedText: null,
      }, testUuid()), null);
      assert.equal(recorder.recordStopTermination(null), null);
      assert.equal(calls.length, 0, 'nothing emitted while inert');
      assert.equal(recorder.isActive(), false);
    }
  });
});

// ------------------------------------------------------------------
// AC1/AC2 — document_visibility_changed.
// ------------------------------------------------------------------
describe('AC1/AC2 — document_visibility_changed', () => {
  it('records both fields at emit time', () => {
    const { recorder, calls } = makeRecorder();
    const id = recorder.recordVisibilityChange('hidden', false);
    assert.ok(id, 'returns eventId');
    assert.deepEqual(types(calls), ['document_visibility_changed']);
    assert.deepEqual(calls[0].payload, { visibilityState: 'hidden', focused: false });
    assert.equal(calls[0].refs, null);
    recorder.recordVisibilityChange('visible', true);
    assert.deepEqual(calls[1].payload, { visibilityState: 'visible', focused: true });
  });

  it('validators reject bad shapes (TypeError) and bad domains (RangeError)', () => {
    const { recorder } = makeRecorder();
    assert.throws(() => recorder.recordVisibilityChange('away', true), RangeError);
    assert.throws(() => recorder.recordVisibilityChange('visible', 'yes'), TypeError);
    assert.throws(() => BlindfoldSession.requireValidDocumentVisibilityChangedPayload(
      { visibilityState: 'visible', focused: true, extra: 1 }), TypeError);
  });

  it('content.js wires visibilitychange + focus + blur via a failure-isolated handler', () => {
    const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
    assert.ok(src.includes("document.addEventListener('visibilitychange', recordVisibilitySafe)"),
      'visibilitychange listener');
    assert.ok(src.includes("window.addEventListener('focus', recordVisibilitySafe)"),
      'focus listener');
    assert.ok(src.includes("window.addEventListener('blur', recordVisibilitySafe)"),
      'blur listener');
    assert.ok(src.includes('document.visibilityState, document.hasFocus()'),
      'both values captured at emit time');
    // Failure isolation (3.2 SF-1 precedent).
    const handler = src.match(/function recordVisibilitySafe\(\) \{[\s\S]*?\n\}/);
    assert.ok(handler && handler[0].includes('try {'),
      'recordVisibilitySafe wraps the recorder call in try/catch');
  });
});

// ------------------------------------------------------------------
// AC3 — no cognitive-pause interpretation.
// ------------------------------------------------------------------
describe('AC3 — honest naming', () => {
  it('3.5 code/docs carry the disclaimer and no pause/attention/away tokens', () => {
    const src = fs.readFileSync(path.join(ROOT, 'chess_utils.js'), 'utf8');
    // The disclaimer must exist (it honestly names what the events are not).
    assert.ok(src.includes('must not be interpreted as'),
      'epistemic disclaimer present in chess_utils.js');
    // Strip the disclaimer sentences, then assert the forbidden tokens do
    // not appear as standalone words in the 3.5 sections.
    const stripped = src
      .split('\n')
      .filter((l) => !l.includes('must not be interpreted as') &&
                     !l.includes('cognitive pause') &&
                     !l.includes('attention shift') &&
                     !l.includes('player absence'))
      .join('\n');
    for (const tok of ['pause', 'attention', 'away']) {
      const re = new RegExp(`\\b${tok}\\b`, 'i');
      assert.ok(!re.test(stripped),
        `forbidden token '${tok}' must not appear in 3.5 code outside the disclaimer`);
    }
    // The event type and payload keys themselves are document-state terms.
    assert.ok(!/pause|attention|away/i.test(
      BlindfoldSession.DOCUMENT_VISIBILITY_CHANGED_EVENT_TYPE));
  });
});

// ------------------------------------------------------------------
// AC4 — game_reset from 3.1's onGameReset.
// ------------------------------------------------------------------
describe('AC4 — game_reset', () => {
  it('recordGameReset emits {detection, confirmedMoveCount}', () => {
    const { recorder, calls } = makeRecorder();
    const id = recorder.recordGameReset(7);
    assert.ok(id);
    assert.deepEqual(types(calls), ['game_reset']);
    assert.deepEqual(calls[0].payload,
      { detection: 'suspect_threshold', confirmedMoveCount: 7 });
    assert.throws(() => recorder.recordGameReset(-1), RangeError);
    assert.throws(() => recorder.recordGameReset(1.5), RangeError);
  });

  it("3.1's onGameReset receives { confirmedMoveCount } (additive)", () => {
    let received = 'not-called';
    const { calls, emitEvent } = makeEmitter();
    const tracker = BlindfoldSession.createHistoryTracker({
      gameId: null, // restart-in-place path; the arg is passed either way
      emitEvent,
      onGameReset: (info) => { received = info; },
      suspectThreshold: 3,
    });
    tracker.observe(['e4', 'e5', 'Nf3', 'Nc6']);
    tracker.observe(['d4']);
    tracker.observe(['c4']);
    const res = tracker.observe(['d4']);
    assert.equal(res.reset, true);
    assert.deepEqual(received, { confirmedMoveCount: 4 },
      'count captured before confirmed was cleared');
  });

  it('existing () => {} stubs keep working (extra arg ignored)', () => {
    let fired = 0;
    const { emitEvent } = makeEmitter();
    const tracker = BlindfoldSession.createHistoryTracker({
      gameId: gid(),
      emitEvent,
      onGameReset: () => { fired++; },
      suspectThreshold: 2,
    });
    tracker.observe(['e4', 'e5']);
    tracker.observe(['d4']);
    tracker.observe(['c4']);
    assert.equal(fired, 1, 'nullary stub still fires');
  });
});

// ------------------------------------------------------------------
// AC5 — no duplication of 2.7 / 3.1.
// ------------------------------------------------------------------
describe('AC5 — no duplication', () => {
  it('3.5 adds no takeback, reload, or page-context handlers', () => {
    const chessSrc = fs.readFileSync(path.join(ROOT, 'chess_utils.js'), 'utf8');
    const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
    // The 3.5 recorder section must not reference the owned-elsewhere types.
    const rec35 = chessSrc.slice(chessSrc.indexOf('Task 3.5: createGameLifecycleRecorder'));
    for (const t of ['history_revised', 'page_start', 'page_end_clean', 'page_discontinuity']) {
      assert.ok(!rec35.includes(`'${t}'`), `3.5 recorder must not emit ${t}`);
    }
    // content.js 3.5 wiring adds no takeback/reload listeners.
    assert.ok(!/addEventListener\(['"]beforeunload/.test(contentSrc),
      'no unload handler (2.5/2.7 tension unchanged)');
  });
});

// ------------------------------------------------------------------
// AC6 — chess-rules game end (in 1.4's game_ended schema).
// ------------------------------------------------------------------
describe('AC6 — chessRulesTermination/chessRulesResult + game_ended (chess_rules)', () => {
  function matedGame() {
    const g = new globalThis.Chess();
    for (const san of ['f3', 'e5', 'g4', 'Qh4#']) g.move(san);
    return g;
  }

  it('maps terminal states to 1.4 TERMINATION_REASONS; null when not over', () => {
    assert.equal(BlindfoldSession.chessRulesTermination(matedGame()), 'checkmate');
    const stale = new globalThis.Chess('7k/5Q2/8/8/8/8/8/7K b - - 0 1');
    assert.equal(BlindfoldSession.chessRulesTermination(stale), 'stalemate');
    const rep = new globalThis.Chess();
    for (const san of ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']) rep.move(san);
    assert.equal(BlindfoldSession.chessRulesTermination(rep), 'draw_threefold');
    const bare = new globalThis.Chess('8/8/8/8/8/8/8/k6K w - - 0 1');
    assert.equal(BlindfoldSession.chessRulesTermination(bare), 'draw_insufficient_material');
    const fifty = new globalThis.Chess('7k/8/8/8/8/8/5R2/7K w - - 100 1');
    assert.equal(BlindfoldSession.chessRulesTermination(fifty), 'draw_fifty_move');
    assert.equal(BlindfoldSession.chessRulesTermination(new globalThis.Chess()), null);
    assert.equal(BlindfoldSession.chessRulesTermination(null), null);
  });

  it('chessRulesResult derives the PGN result (mirrors getResultAnnouncement)', () => {
    // Fool's mate: black mates with white to move → black wins.
    assert.equal(BlindfoldSession.chessRulesResult(matedGame()), '0-1');
    const whiteMates = new globalThis.Chess();
    for (const san of ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']) whiteMates.move(san);
    // Scholar's mate: white mates with black to move → white wins.
    assert.equal(BlindfoldSession.chessRulesResult(whiteMates), '1-0');
    const stale = new globalThis.Chess('7k/5Q2/8/8/8/8/8/7K b - - 0 1');
    assert.equal(BlindfoldSession.chessRulesResult(stale), '1/2-1/2');
  });

  it('recordChessRulesEnded emits the 1.4 payload with sparse refs', () => {
    const { recorder, calls } = makeRecorder();
    const moveId = testUuid();
    const id = recorder.recordChessRulesEnded(matedGame(), moveId);
    assert.ok(id);
    assert.deepEqual(types(calls), ['game_ended']);
    assert.deepEqual(calls[0].payload, {
      result: '0-1', terminationReason: 'checkmate',
      evidenceSource: 'observed', observedText: null,
    });
    assert.deepEqual(calls[0].refs, { terminalMoveEventId: moveId });
  });

  it('recordChessRulesEnded returns null when the game is not over', () => {
    const { recorder, calls } = makeRecorder();
    assert.equal(recorder.recordChessRulesEnded(new globalThis.Chess(), null), null);
    assert.equal(recorder.recordChessRulesEnded(null, null), null);
    assert.equal(calls.length, 0);
  });

  it('null terminalMoveEventId → null refs', () => {
    const { recorder, calls } = makeRecorder();
    recorder.recordChessRulesEnded(matedGame(), null);
    assert.equal(calls[0].refs, null);
  });

  it('recordGameEnded validates: bad source → RangeError; bad 1.4 input → TypeError/RangeError', () => {
    const { recorder } = makeRecorder();
    const good = {
      result: '1-0', terminationReason: 'checkmate',
      evidenceSource: 'observed', observedText: null,
    };
    assert.throws(() => recorder.recordGameEnded('television', good, null), RangeError);
    assert.throws(() => recorder.recordGameEnded('chess_rules',
      { ...good, terminationReason: 'checkmate!' }, null), RangeError);
    assert.throws(() => recorder.recordGameEnded('chess_rules',
      { termination: 'checkmate', source: 'chess_rules', speechLogicVersion: '1' }, null),
      TypeError, 'old 3.5-shaped payloads are rejected by 1.4\'s validator');
    assert.throws(() => BlindfoldSession.requireValidGameEndedRefs(
      { terminalMoveEventId: null }), TypeError);
    assert.throws(() => BlindfoldSession.requireValidGameEndedRefs(
      { terminalMoveEventId: testUuid(), extra: 1 }), TypeError);
  });

  it('recordDialogEnded (§7) forces evidenceSource observed and keeps observedText', () => {
    const { recorder, calls } = makeRecorder();
    const id = recorder.recordDialogEnded({
      result: '0-1', terminationReason: 'resignation',
      evidenceSource: 'manual', // caller error: dialog is observed by definition
      observedText: 'White resigns',
    }, null);
    assert.ok(id);
    assert.deepEqual(calls[0].payload, {
      result: '0-1', terminationReason: 'resignation',
      evidenceSource: 'observed', observedText: 'White resigns',
    });
  });
});

// ------------------------------------------------------------------
// AC7 — chesscom_dialog audit: explicit unsupported marking.
// ------------------------------------------------------------------
describe('AC7 — dialog observation unsupported (honest marking)', () => {
  it('DECISIONS.md marks chesscom_dialog unsupported; no observer fabricated', () => {
    const decisions = fs.readFileSync(path.join(ROOT, '.autodev', 'DECISIONS.md'), 'utf8');
    assert.ok(decisions.includes('chesscom_dialog'),
      'DECISIONS.md must address the dialog source');
    assert.ok(/unsupported/i.test(decisions),
      'explicit unsupported-coverage marking');
    const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
    assert.ok(!/game-over-modal|board-modal-container|data-testid/.test(contentSrc),
      'no fabricated dialog observer in content.js');
  });
});

// ------------------------------------------------------------------
// AC8 — recordStopTermination (§5 seam).
// ------------------------------------------------------------------
describe('AC8 — recordStopTermination', () => {
  it('emits game_ended with evidenceSource manual; validates reason/result', () => {
    const { recorder, calls } = makeRecorder();
    const id = recorder.recordStopTermination('abandoned');
    assert.ok(id);
    assert.deepEqual(types(calls), ['game_ended']);
    assert.deepEqual(calls[0].payload, {
      result: '*', terminationReason: 'abandoned',
      evidenceSource: 'manual', observedText: null,
    });
    assert.equal(calls[0].refs, null);
    // Reason vocabulary is 1.4's TERMINATION_REASONS: the old 3.5
    // 'abandonment'/'unknown' members are rejected (SF-1 vocabulary
    // reconciliation).
    assert.throws(() => recorder.recordStopTermination('abandonment'), RangeError);
    assert.throws(() => recorder.recordStopTermination('sleeping'), RangeError);
    // null reason = unknown (1.2's unknown convention); explicit result ok.
    const { recorder: r2, calls: c2 } = makeRecorder();
    r2.recordStopTermination(null);
    assert.deepEqual(c2[0].payload.terminationReason, null);
    assert.equal(c2[0].payload.result, '*');
    const { recorder: r3, calls: c3 } = makeRecorder();
    r3.recordStopTermination('resignation', '0-1');
    assert.deepEqual(c3[0].payload, {
      result: '0-1', terminationReason: 'resignation',
      evidenceSource: 'manual', observedText: null,
    });
    assert.throws(() => r3.recordStopTermination('resignation', '2-0'), RangeError);
  });

  it('exposed for §5 on the namespace (source inspection)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
    assert.ok(src.includes('BlindfoldSession.gameLifecycleRecorder = gameLifecycleRecorder;'),
      '§5 seam: recorder exposed on BlindfoldSession');
    assert.ok(src.includes('recordStopTermination(reason, result)'),
      '§5 seam documented at the exposure site');
  });
});
// ------------------------------------------------------------------
// AC9 — per-source idempotency (SF-1 dedup resolution).
//
// 1.4's consumer contract: multiple game_ended events per game are
// permitted (observed auto-detection + later manual Stop completion);
// consumers take the latest by occurrence time. The 3.5 recorder
// therefore dedups per SOURCE (each source records at most once per
// game) rather than suppressing later sources entirely.
// ------------------------------------------------------------------
describe('AC9 — per-source idempotency', () => {
  function chessRulesInput() {
    return {
      result: '0-1', terminationReason: 'checkmate',
      evidenceSource: 'observed', observedText: null,
    };
  }

  it('chess_rules then stop → two game_ended (manual supersedes)', () => {
    const { recorder, calls } = makeRecorder();
    recorder.recordGameEnded('chess_rules', chessRulesInput(), testUuid());
    const second = recorder.recordStopTermination('abandoned');
    assert.ok(second, 'Stop completion is not suppressed by auto-detection');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].payload.evidenceSource, 'observed');
    assert.equal(calls[1].payload.evidenceSource, 'manual');
    assert.equal(calls[1].payload.terminationReason, 'abandoned');
  });

  it('stop then chess_rules → two game_ended (order preserved)', () => {
    const { recorder, calls } = makeRecorder();
    recorder.recordStopTermination(null);
    const id = recorder.recordGameEnded('chess_rules', chessRulesInput(), null);
    assert.ok(id);
    assert.equal(calls.length, 2);
  });

  it('same source twice → one game_ended (per-source idempotency)', () => {
    const { recorder, calls } = makeRecorder();
    recorder.recordGameEnded('chess_rules', chessRulesInput(), null);
    assert.equal(recorder.recordGameEnded('chess_rules', chessRulesInput(), null), null);
    assert.equal(calls.length, 1, 'only the first chess_rules emission stands');
  });

  it('resetEnded() re-arms all sources for a new game', () => {
    const { recorder, calls } = makeRecorder();
    recorder.recordGameEnded('chess_rules', chessRulesInput(), null);
    recorder.recordStopTermination('abandoned');
    recorder.resetEnded();
    const id = recorder.recordGameEnded('chess_rules', chessRulesInput(), null);
    assert.ok(id, 'new game may record its ending');
    assert.equal(calls.length, 3);
  });

  it('suppressed (same-source) calls still validate (fail-fast)', () => {
    const { recorder } = makeRecorder();
    recorder.recordGameEnded('chess_rules', chessRulesInput(), null);
    assert.throws(() => recorder.recordGameEnded('chess_rules',
      { ...chessRulesInput(), terminationReason: 'bogus' }, null), RangeError);
  });
});


// ------------------------------------------------------------------
// AC10 — failure isolation.
// ------------------------------------------------------------------
describe('AC10 — failure isolation', () => {
  it('recorder never throws from emit (caller wraps); inert → null', () => {
    const { recorder, calls } = makeRecorder({ sessionId: null });
    // Inert: validators still run (fail-fast), but no emit happens.
    assert.throws(() => recorder.recordVisibilityChange('bogus', true), RangeError);
    assert.equal(recorder.recordVisibilityChange('visible', true), null);
    assert.equal(calls.length, 0);
  });

  it('content.js wraps every 3.5 recorder call site in try/catch', () => {
    const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
    // recordChessRulesEnded call site (3.5.3 wiring in observeMoves).
    const ended = src.match(/gameLifecycleRecorder\.recordChessRulesEnded\([\s\S]*?\n {4}\} catch/);
    assert.ok(ended, 'recordChessRulesEnded call site is try/catch-wrapped');
    // onGameReset call site.
    const reset = src.match(/gameLifecycleRecorder\.recordGameReset\([\s\S]*?\} catch/);
    assert.ok(reset, 'recordGameReset call site is try/catch-wrapped');
  });
});

// ------------------------------------------------------------------
// AC11 — diff discipline.
// ------------------------------------------------------------------
describe('AC11 — diff discipline', () => {
  it('only chess_utils.js and content.js differ among product files', () => {
    const status = execSync('git status --porcelain', { cwd: ROOT }).toString();
    const changed = status.split('\n').filter((l) => l.trim()).map((l) => l.slice(3).trim());
    const allowed = new Set([
      // Honest cumulative evolution: 4.1 (dedicated recording context)
      // legitimately adds recorder.html/recorder.js/recording_host.js,
      // the "offscreen" manifest permission, and the sw.js supervisor
      // wiring; its files join the allowlists.
      'recorder.html',
      'recorder.js',
      'recording_host.js',
      'manifest.json',
      'sw.js',
      'tests/recording_host.test.js',
      'tests/manifest_sw.test.js',
      '.autodev/evidence/4.1.contract.md',
      '.autodev/evidence/4.1.build.md',
      // Honest cumulative evolution: 4.1's review/behavior
      // evidence lands after the pins were evolved (2.x/3.x precedent).
      '.autodev/evidence/4.1.review.md',
      '.autodev/evidence/4.1.behavior.md',
      // Honest cumulative evolution: 4.2 (microphone selection and
      // permission handling) legitimately adds device_selection.js, routes
      // the five mic commands through recorder.js/recorder.html, and adds
      // its test + evidence; its files join the allowlists.
      'device_selection.js',
      'tests/device_selection.test.js',
      '.autodev/evidence/4.2.contract.md',
      '.autodev/evidence/4.2.build.md',
      // Honest cumulative evolution: 4.2's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1 precedent).
      '.autodev/evidence/4.2.review.md',
      '.autodev/evidence/4.2.behavior.md',
      // Honest cumulative evolution: 4.3 (screen/tab capture selection
      // and permission handling) legitimately adds capture_selection.js
      // (offscreen side) + capture_broker.js (SW side), routes the four
      // capture commands plus the three SW-leg broker messages, adds the
      // tabCapture permission + host_permissions, and adds its tests +
      // evidence; its files join the allowlists.
      'capture_selection.js',
      'capture_broker.js',
      'tests/capture_selection.test.js',
      'tests/capture_broker.test.js',
      'tests/manifest_sw.test.js',
      '.autodev/evidence/4.3.contract.md',
      '.autodev/evidence/4.3.build.md',
      // Honest cumulative evolution: 4.4 (webcam selection and
      // permission handling) modifies device_selection.js (video
      // probe kind-branch + validator messages) and recorder.js
      // (camera selector + cam-* channel), and repairs
      // restoreDevices() to await all selector restores.
      '.autodev/evidence/4.4.contract.md',
      '.autodev/evidence/4.4.build.md',
      // Honest cumulative evolution: 4.4's review/behavior
      // evidence lands after the pins were evolved (2.x/3.x/4.1-4.3 precedent).
      '.autodev/evidence/4.4.review.md',
      '.autodev/evidence/4.4.behavior.md',
      // Honest cumulative evolution: 4.5 (recording format
      // verification + recording manifest) legitimately adds
      // format_support.js, routes recorder-get-formats through
      // recorder.js/recorder.html (which now also load db.js),
      // bumps db.js to version 2 with the recording_manifest
      // store, and adds its test + evidence; its files join
      // the allowlists.
      'format_support.js',
      'db.js',
      'tests/format_support.test.js',
      '.autodev/evidence/4.5.contract.md',
      '.autodev/evidence/4.5.build.md',
      // Honest cumulative evolution: 4.5's review/behavior
      // evidence lands after the pins were evolved (2.x/3.x/4.1-4.4 precedent).
      '.autodev/evidence/4.5.review.md',
      '.autodev/evidence/4.5.behavior.md',
      // Honest cumulative evolution: 4.6 (stream start plumbing)
      // legitimately adds stream_starter.js, routes
      // recorder-start-streams through recorder.js/recorder.html, adds
      // device_selection.recordDefault, widens format_support.js's
      // recording-manifest fields, and adds its test + evidence; its
      // files join the allowlists.
      'stream_starter.js',
      'device_selection.js',
      'format_support.js',
      'recorder.js',
      'recorder.html',
      'tests/stream_starter.test.js',
      '.autodev/evidence/4.6.contract.md',
      '.autodev/evidence/4.6.build.md',
      // Honest cumulative evolution: 4.6's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.5 precedent).
      '.autodev/evidence/4.6.review.md',
      '.autodev/evidence/4.6.behavior.md',
      // Honest cumulative evolution: 4.7 (audio-content policy)
      // legitimately adds audio_policy.js, wires the classifications
      // into stream_starter.js's manifest-write stage, widens
      // format_support.js's manifest validator 13 → 15, loads the new
      // module in recorder.html, resolves it in recorder.js, records
      // the ## 4.7 decisions, and adds its test + evidence; its files
      // join the allowlists.
      'audio_policy.js',
      'tests/audio_policy.test.js',
      '.autodev/evidence/4.7.contract.md',
      '.autodev/evidence/4.7.build.md',
      // Honest cumulative evolution: 4.7's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.6 precedent).
      '.autodev/evidence/4.7.review.md',
      '.autodev/evidence/4.7.behavior.md',
      // Honest cumulative evolution: 4.8 (incremental chunk extraction)
      // legitimately adds chunk_writer.js, wires the automatic chunking
      // kickoff into recorder.js's recorder-start-streams handler, loads
      // the new module in recorder.html, records the ## 4.8 decisions,
      // and adds its test + evidence; its files join the allowlists.
      'chunk_writer.js',
      'tests/chunk_writer.test.js',
      '.autodev/evidence/4.8.contract.md',
      '.autodev/evidence/4.8.build.md',
      // Honest cumulative evolution: 4.8's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.7 precedent).
      '.autodev/evidence/4.8.review.md',
      '.autodev/evidence/4.8.behavior.md',
      // Honest cumulative evolution: 4.9 (track/error/discontinuity
      // monitoring) legitimately adds track_monitor.js, wires it into
      // recorder.js's recorder-start-streams handler (restart pre-check,
      // attach, restart events), adds the onTerminalState seam to
      // chunk_writer.js, the getManifestRecordsBySession read to
      // format_support.js, the script tag in recorder.html, records the
      // ## 4.9 decisions, and adds its test + evidence; its files join
      // the allowlists.
      'track_monitor.js',
      'tests/track_monitor.test.js',
      'tests/timecode.test.js',
      '.autodev/evidence/4.9.contract.md',
      '.autodev/evidence/4.9.build.md',
      // Honest cumulative evolution: 4.9's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.8 precedent).
      '.autodev/evidence/4.9.review.md',
      '.autodev/evidence/4.9.behavior.md',
      // Honest cumulative evolution: 4.10 (clock-segment linking)
      // legitimately adds clock_link.js, wires the link into the
      // stream starter's manifest-write stage, widens MANIFEST_KEYS
      // 15 → 16 with the 4.10-owned clockSegmentId field, adds the
      // getManifestRecord read, loads the new module in
      // recorder.html, exposes getClockLink in recorder.js (the
      // 4.13 seam), records the ## 4.10 decisions, and adds its
      // test + evidence; its files join the allowlists.
      'clock_link.js',
      'tests/clock_link.test.js',
      // 4.10 also modifies the manifest-write stage (stream_starter.js),
      // the manifest writer (format_support.js), the wiring
      // (recorder.js) and the module list (recorder.html); already
      // listed by earlier tasks where applicable — the Set dedupes.
      'stream_starter.js',
      'format_support.js',
      'recorder.js',
      'recorder.html',
      '.autodev/evidence/4.10.contract.md',
      '.autodev/evidence/4.10.build.md',
      // Honest cumulative evolution: 4.10's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.9 precedent).
      '.autodev/evidence/4.10.review.md',
      '.autodev/evidence/4.10.behavior.md',
      // Honest cumulative evolution: 4.11 (audible/visible sync
      // markers) legitimately adds sync_marker.js (offscreen audible
      // marker + SW flash-relay request), sync_flash.js (content-script
      // visible flash), sync_beep.wav (880 Hz beep asset), wires the
      // start marker into recorder.js's start-streams final .then, adds
      // the SW flash-relay leg to recording_host.js, the MSG_SYNC_FLASH
      // vocabulary entry, the script tag in recorder.html, the content
      // script in manifest.json, records the ## 4.11 decisions, and adds
      // its test + evidence; its files join the allowlists.
      'sync_marker.js',
      'sync_flash.js',
      'sync_beep.wav',
      'tests/sync_marker.test.js',
      // 4.11 also touches recorder.js, recording_host.js, recorder.html
      // and manifest.json; already listed by earlier tasks where
      // applicable — the Set dedupes.
      'recorder.js',
      'recording_host.js',
      'recorder.html',
      'manifest.json',
      '.autodev/evidence/4.11.contract.md',
      '.autodev/evidence/4.11.build.md',
      // Honest cumulative evolution: 4.11's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.10 precedent).
      '.autodev/evidence/4.11.review.md',
      '.autodev/evidence/4.11.behavior.md',
      // Honest cumulative evolution: 4.12 (recording timecode/offset
      // arithmetic) legitimately adds timecode.js (the pure nine-function
      // alignment library — media→clock→wall conversions, marker
      // disambiguation, continuity rule), persists nothing new
      // (MANIFEST_KEYS stays 16, DB_VERSION stays 2, no recorder.html
      // wiring — a library, not a pipeline stage), records the ## 4.12
      // decisions, and adds its test + evidence; its files join the
      // allowlists.
      'timecode.js',
      'tests/timecode.test.js',
      '.autodev/evidence/4.12.contract.md',
      '.autodev/evidence/4.12.build.md',
      // Honest cumulative evolution: 4.12's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.11 precedent).
      '.autodev/evidence/4.12.review.md',
      '.autodev/evidence/4.12.behavior.md',
      // Honest cumulative evolution: 4.3's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1/4.2 precedent).
      '.autodev/evidence/4.3.review.md',
      '.autodev/evidence/4.3.behavior.md',
      'chess_utils.js',
      'content.js',
      'tests/game_lifecycle.test.js',
      // Honest cumulative evolution: earlier tasks' suites pin files 3.5
      // legitimately touches.
      'tests/speech.test.js',
      'tests/visibility.test.js',
      'tests/attempt_tracker.test.js',
      'tests/history_tracker.test.js',
      'tests/lifecycle.test.js',
      'tests/retention.test.js',
      'tests/sender.test.js',
      'tests/session_store.test.js',
      'tests/status_indicator.test.js',
      'tests/writer.test.js',
      'tests/db.test.js',
      'tests/event_envelope.test.js',
      'tests/game_records.test.js',
      'tests/manifest_sw.test.js',
      'tests/session_identity.test.js',
      '.autodev/evidence/3.5.contract.md',
      '.autodev/evidence/3.5.build.md',
      // Honest cumulative evolution: 3.5's rereview/behavior
      // evidence lands after the pins were evolved (2.x/3.x precedent).
      '.autodev/evidence/3.5.rereview.md',
      '.autodev/evidence/3.5.behavior.md',
      '.autodev/DECISIONS.md',
      // Honest cumulative evolution: 4.13 (finalize recordings at Stop)
      // legitimately adds finalizer.js (the Stop sequence: stop-marker
      // wait, recorder stop, bounded final-flush await, device release,
      // discontinuous-segment splits, per-(sessionId, streamKind)
      // numbering, finalizedAtUtc mark), widens MANIFEST_KEYS 16 -> 18
      // with the 4.13-owned segmentNumber + finalizedAtUtc fields, adds
      // the MSG_STOP_STREAMS vocabulary entry, wires the
      // recorder-stop-streams handler into recorder.js, adds the
      // discardActiveStream seam to stream_starter.js, loads the new
      // module in recorder.html, records the ## 4.13 decisions, and adds
      // its test + evidence; its files join the allowlists.
      'finalizer.js',
      'tests/finalizer.test.js',
      'format_support.js',
      'recorder.js',
      'stream_starter.js',
      'recorder.html',
      '.autodev/evidence/4.13.contract.md',
      '.autodev/evidence/4.13.build.md',
      // Honest cumulative evolution: 4.13's review evidence lands after
      // the pins were evolved (2.x/3.x/4.1-4.12 precedent).
      '.autodev/evidence/4.13.review.md',
      // Honest cumulative evolution: 3.5's review/behavior evidence
      // lands after the pins were evolved (2.x/3.1/3.2/3.3/3.4 precedent).
      '.autodev/evidence/3.5.review.md',
      '.autodev/evidence/3.5.behavior.md',
      // Honest cumulative evolution: 4.14 (report per-stream
      // recording status) legitimately adds stream_status.js (the
      // read-only per-stream status query over the registry, chunk
      // state, live tracks, health mirror, and manifest — no writes,
      // no events, no UI), the additive track_monitor.getStreamHealth
      // seam (+ the health mirror, nowUtcIso opt, and retention
      // calls), the recorder-get-status channel message + lazy
      // status-reader getter in recorder.js, the script tag in
      // recorder.html, records the ## 4.14 decisions, and adds its
      // test + evidence; its files join the allowlists.
      'stream_status.js',
      'tests/stream_status.test.js',
      // timecode pins tracked diffs only; track_monitor.js is the
      // tracked 4.14-modified file.
      'track_monitor.js',
      '.autodev/evidence/4.14.contract.md',
      '.autodev/evidence/4.14.build.md',
      // Honest cumulative evolution: 4.14's review/behavior evidence
      // lands after the pins were evolved (2.x/3.x/4.1-4.13 precedent).
      '.autodev/evidence/4.14.review.md',
      '.autodev/evidence/4.14.behavior.md',
      // Honest cumulative evolution: 5.1 (compact Start/Stop control +
      // per-stream health lights) legitimately adds session_controls.js
      // (the in-page control cluster + pure classifyStreamStatus), wires
      // the install into content.js, adds session_identity.js (ID minting)
      // and session_controls.js to the manifest content_scripts list,
      // captures ownerTabId + echoes gameId in recorder.js, adds the
      // SW-side recorder-ensure handler to recording_host.js, adds the
      // additive getLastObservedEnd getter to chess_utils.js (the Stop
      // seam for the observed game_ended reason), adds additive classes
      // to overlay.css, records the ## 5.1 decisions, and adds its test
      // + evidence; its files join the allowlists.
      'session_controls.js',
      'tests/session_controls.test.js',
      'manifest.json',
      'content.js',
      'overlay.css',
      'chess_utils.js',
      'recorder.js',
      'recording_host.js',
      '.autodev/evidence/5.1.contract.md',
      '.autodev/evidence/5.1.build.md',
      // Honest cumulative evolution: 5.1's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.x precedent).
      '.autodev/evidence/5.1.review.md',
      '.autodev/evidence/5.1.behavior.md',
      // Honest cumulative evolution: 5.2 (baseline/training/evaluation
      // selection + training approach and verbal scaffolding fields)
      // legitimately adds session_fields.js (pure buildInitialConditions +
      // UNDETECTED_CONDITION_FIELDS placeholders + installSessionFields
      // with the 5.3/5.4 seams), amends session_controls.js's Start
      // sequence (metadata-first minting, session-save, category echo,
      // category-required abort), adds the SW-side session-save handler
      // to recording_host.js, accepts/stores/echoes sessionCategory in
      // recorder.js, wires the fields install into content.js (+
      // extensionVersion pass-through), adds session_fields.js to the
      // manifest content_scripts list, adds additive classes to
      // overlay.css, records the ## 5.2 decisions, and adds its test +
      // evidence; its files join the allowlists.
      'session_fields.js',
      'tests/session_fields.test.js',
      'session_controls.js',
      'recorder.js',
      'recording_host.js',
      'content.js',
      'manifest.json',
      'overlay.css',
      '.autodev/evidence/5.2.contract.md',
      '.autodev/evidence/5.2.build.md',
      // Honest cumulative evolution: 5.2's review/behavior evidence
      // lands after the pins were evolved (2.x/3.x/4.x/5.1 precedent).
      '.autodev/evidence/5.2.review.md',
      '.autodev/evidence/5.2.behavior.md',
      // Honest cumulative evolution: 5.3 (remember previous selections
      // without silently changing a game's recorded conditions)
      // legitimately adds selection_memory.js (createSelectionMemory +
      // validateRememberedSelection, chrome.storage.local-backed
      // remembered defaults, no record-write path), adds the optional
      // onSessionStarted hook to session_controls.js (fired once at the
      // phase → 'active' point, guarded in try/catch), wires the memory
      // construction + restore + onSessionStarted pass-through into
      // content.js, adds the "storage" permission and selection_memory.js
      // to manifest.json, records the ## 5.3 decisions, and adds its test
      // + evidence; its files join the allowlists. (session_controls.js,
      // content.js, manifest.json and .autodev/DECISIONS.md are already
      // allowlisted from 5.1/5.2.)
      'selection_memory.js',
      'tests/selection_memory.test.js',
      // 5.3 also evolves the exact-permissions pins in these suites
      // (they carry no git-status allowlist of their own, so they join
      // here).
      'tests/db.test.js',
      'tests/manifest_sw.test.js',
      // 5.3 also evolves the working-tree diff pins in these suites.
      'tests/clock_link.test.js',
      'tests/timecode.test.js',
      '.autodev/evidence/5.3.contract.md',
      '.autodev/evidence/5.3.build.md',
      // Honest cumulative evolution: 5.3's review/behavior evidence
      // lands after the pins are evolved (2.x/3.x/4.x/5.1/5.2 precedent).
      '.autodev/evidence/5.3.review.md',
      '.autodev/evidence/5.3.behavior.md',
      // Honest cumulative evolution: 5.4 (show detected game conditions
      // and allow manual completion of unavailable fields before
      // recording) legitimately adds detected_conditions.js
      // (detectGameConditions + CONDITION_PROBES + installConditionsPanel
      // + attachConditionsPanel; playerColor detected via the verified
      // wc-chess-board/flipped probe, the other four fields manual-only),
      // wires the panel install + getDetectedConditions plug-in +
      // attachConditionsPanel composite into content.js, adds
      // detected_conditions.js to manifest.json, adds additive panel
      // classes to overlay.css, records the ## 5.4 decisions, and adds
      // its test + evidence; its files join the allowlists.
      // (content.js, manifest.json, overlay.css and .autodev/DECISIONS.md
      // are already allowlisted from 5.1/5.2/5.3.)
      'detected_conditions.js',
      'tests/detected_conditions.test.js',
      '.autodev/evidence/5.4.contract.md',
      '.autodev/evidence/5.4.build.md',
      '.autodev/evidence/5.4.review.md',
      '.autodev/evidence/5.4.behavior.md',
      // 5.4 also evolves the cumulative pins in these suites (each
      // carries its own git-status allowlist, so they join here).
      'tests/attempt_tracker.test.js',
      'tests/audio_policy.test.js',
      'tests/capture_selection.test.js',
      'tests/chunk_writer.test.js',
      'tests/device_selection.test.js',
      'tests/finalizer.test.js',
      'tests/format_support.test.js',
      'tests/game_lifecycle.test.js',
      'tests/history_tracker.test.js',
      'tests/lifecycle.test.js',
      'tests/recording_host.test.js',
      'tests/retention.test.js',
      'tests/selection_memory.test.js',
      'tests/sender.test.js',
      'tests/session_controls.test.js',
      'tests/session_fields.test.js',
      'tests/session_store.test.js',
      'tests/speech.test.js',
      'tests/status_indicator.test.js',
      'tests/stream_starter.test.js',
      'tests/stream_status.test.js',
      'tests/sync_marker.test.js',
      'tests/track_monitor.test.js',
      'tests/visibility.test.js',
      'tests/writer.test.js',
      // 5.4 also evolves the working-tree diff pins in these suites.
      'tests/clock_link.test.js',
      'tests/timecode.test.js',
      // Honest cumulative evolution: 5.5 (prevent a duplicate Start
      // from creating overlapping recording sessions) legitimately adds
      // the atomic duplicate-Start guard to recorder.js's
      // handleSetSession (sessionId-equality discriminator, synchronous
      // check-and-set, nothing overwritten on refusal), adds the
      // content-side pre-check + mint reorder + localAbortStart +
      // refusal-detail mapping to session_controls.js, records the
      // ## 5.5 decisions, and adds its test + evidence; its files join
      // the allowlists. No new channel messages, events, stores, or
      // permissions.
      'recorder.js',
      'session_controls.js',
      'tests/duplicate_start.test.js',
      '.autodev/DECISIONS.md',
      '.autodev/evidence/5.5.contract.md',
      '.autodev/evidence/5.5.build.md',
      // Honest cumulative evolution: 5.5's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.4 precedent).
      '.autodev/evidence/5.5.review.md',
      '.autodev/evidence/5.5.behavior.md',
      // 5.5 also evolves the cumulative pins in these suites (each
      // carries its own git-status allowlist, so they join here).
      'tests/attempt_tracker.test.js',
      'tests/audio_policy.test.js',
      'tests/capture_selection.test.js',
      'tests/chunk_writer.test.js',
      'tests/device_selection.test.js',
      'tests/finalizer.test.js',
      'tests/format_support.test.js',
      'tests/game_lifecycle.test.js',
      'tests/history_tracker.test.js',
      'tests/lifecycle.test.js',
      'tests/recording_host.test.js',
      'tests/retention.test.js',
      'tests/selection_memory.test.js',
      'tests/sender.test.js',
      'tests/session_controls.test.js',
      'tests/session_fields.test.js',
      'tests/session_store.test.js',
      'tests/speech.test.js',
      'tests/status_indicator.test.js',
      'tests/stream_starter.test.js',
      'tests/stream_status.test.js',
      'tests/sync_marker.test.js',
      'tests/track_monitor.test.js',
      'tests/visibility.test.js',
      'tests/writer.test.js',
      // 5.5 also evolves the working-tree diff pins in these suites.
      'tests/clock_link.test.js',
      'tests/timecode.test.js',
      // Honest cumulative evolution: 5.6 (show readiness only after
      // required media streams have started and an initial storage
      // write has succeeded) legitimately adds the pure
      // computeReadiness() policy function + readiness badge
      // presentation + poll-loop wiring to session_controls.js, adds
      // its unit/integration tests, and records its evidence; its
      // files join the allowlists. No new channel messages, events,
      // stores, or permissions.
      '.autodev/evidence/5.6.contract.md',
      '.autodev/evidence/5.6.build.md',
      // Honest cumulative evolution: 5.6's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.5 precedent).
      '.autodev/evidence/5.6.review.md',
      '.autodev/evidence/5.6.behavior.md',
      // Honest cumulative evolution: 5.7 (keep recording through game
      // end until the user clicks Stop) is primarily a pinning task —
      // it adds no product-code changes, only the 5.7 no-auto-stop
      // tests to tests/session_controls.test.js, and records its
      // evidence; its files join the allowlists. No new channel
      // messages, events, stores, or permissions.
      '.autodev/evidence/5.7.contract.md',
      '.autodev/evidence/5.7.build.md',
      // Honest cumulative evolution: 5.7's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.6 precedent).
      '.autodev/evidence/5.7.review.md',
      '.autodev/evidence/5.7.behavior.md',
    ]);
    for (const f of changed) {
      assert.ok(allowed.has(f), `unexpected modified file: ${f}`);
    }
  });

  it('event_envelope.js, lifecycle.js, sounds.js byte-identical to HEAD', () => {
    for (const f of ['event_envelope.js', 'lifecycle.js', 'sounds.js']) {
      const head = execSync(`git show HEAD:${f}`, { cwd: ROOT, stdio: 'pipe' }).toString();
      const current = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.strictEqual(current, head, `${f} changed but 3.5 must not touch it`);
    }
  });

  it('PLAN.md unmodified; no §4 recording or §5 UI tokens', () => {
    const head = execSync('git show HEAD:PLAN.md', { cwd: ROOT, stdio: 'pipe' }).toString();
    const current = fs.readFileSync(path.join(ROOT, 'PLAN.md'), 'utf8');
    assert.strictEqual(current, head, 'PLAN.md is human-owned and must not change');
    const chessSrc = fs.readFileSync(path.join(ROOT, 'chess_utils.js'), 'utf8');
    const rec35 = chessSrc.slice(chessSrc.indexOf('Task 3.5: createGameLifecycleRecorder'));
    assert.ok(!/MediaRecorder|getUserMedia|getDisplayMedia/.test(rec35),
      'no §4 recording tokens in the 3.5 recorder');
  });
});
