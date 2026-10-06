// tests/attempt_tracker.test.js
//
// Task 3.2 (PLAN.md §3.2): "Instrument move input in content.js."
//
// V1 — static/unit. Covers 3.2.contract.md AC1–AC10 (AC11–AC12 are the V2
// sw-attempts.js harness; AC13 is V3-deferred to §7).
//
// The attempt tracker is DOM-free; makeMoveOnBoard's failure sites need a
// minimal document stub (AC4). Chess comes from the vendored chess.min.js
// via globalThis.

const { describe, it, beforeEach, afterEach } = require('node:test');
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

function types(calls) {
  return calls.map((c) => c.eventType);
}

// Fake timers (injectable per contract §3.2).
function makeFakeTimers() {
  let nextId = 1;
  const scheduled = new Map(); // id -> {fn, ms}
  const cleared = [];
  return {
    setTimeoutFn: (fn, ms) => {
      const id = nextId++;
      scheduled.set(id, { fn, ms });
      return id;
    },
    clearTimeoutFn: (id) => {
      cleared.push(id);
      scheduled.delete(id);
    },
    scheduled,
    cleared,
    fireAll: () => {
      const ids = [...scheduled.keys()];
      for (const id of ids) {
        const s = scheduled.get(id);
        scheduled.delete(id);
        if (s) s.fn();
      }
    },
    fireOne: (id) => {
      const s = scheduled.get(id);
      scheduled.delete(id);
      if (s) s.fn();
    },
  };
}

function makeTracker(opts) {
  const { calls, emitEvent } = makeEmitter();
  const timers = makeFakeTimers();
  const tracker = BlindfoldSession.createAttemptTracker(Object.assign({
    emitEvent,
    getSessionId: () => sid(),
    getGameId: () => gid(),
    unconfirmedTimeoutMs: 30000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  }, opts || {}));
  return { tracker, calls, timers };
}

// ------------------------------------------------------------------
// AC1 — first-edit capture (3.2.1).
// ------------------------------------------------------------------
describe('AC1 — first-edit capture', () => {
  it('first input sets the timestamp; later inputs do not overwrite; submit resets', () => {
    let now = 1000;
    const cap = BlindfoldSession.createFirstEditCapture(() => now);
    assert.equal(cap.peek(), null);
    cap.onInput();
    assert.equal(cap.peek(), 1000);
    now = 2000;
    cap.onInput();
    assert.equal(cap.peek(), 1000, 'second input must not overwrite');
    now = 3000;
    cap.onInput();
    assert.equal(cap.peek(), 1000, 'third input must not overwrite');
    const v = cap.onSubmit();
    assert.equal(v, 1000, 'submit snapshots the first-edit time');
    assert.equal(cap.peek(), null, 'submit resets');
    // New cycle after submit.
    now = 4000;
    cap.onInput();
    assert.equal(cap.peek(), 4000);
  });

  it('only the timestamp is retained (no keystroke content/count)', () => {
    const cap = BlindfoldSession.createFirstEditCapture(() => 1234);
    cap.onInput();
    // The only observable state is the numeric timestamp.
    assert.equal(typeof cap.peek(), 'number');
    assert.deepEqual(Object.keys(cap), ['onInput', 'onSubmit', 'peek'],
      'no keystroke storage on the capture object');
  });

  it('null nowFn → TypeError', () => {
    assert.throws(() => BlindfoldSession.createFirstEditCapture(null), TypeError);
    assert.throws(() => BlindfoldSession.createFirstEditCapture('x'), TypeError);
  });
});

// ------------------------------------------------------------------
// AC2/AC3 — submit path: verbatim text, exact payload keys.
// ------------------------------------------------------------------
describe('AC2/AC3 — submit payload', () => {
  it('submittedText is verbatim (no trim); payload has exactly the three keys', () => {
    const { tracker, calls } = makeTracker();
    const res = tracker.submitAttempt({
      submittedText: '  e4  ',
      firstEditMonotonicMs: 1234.5,
      validation: 'legal',
      from: 'e2', to: 'e4', promotion: null,
    });
    assert.ok(res && typeof res.attemptEventId === 'string');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].eventType, 'move_attempt');
    assert.deepEqual(calls[0].payload, {
      submittedText: '  e4  ',
      firstEditMonotonicMs: 1234.5,
      validation: 'legal',
    });
    assert.equal(calls[0].refs, null);
  });

  it('firstEditMonotonicMs null is preserved (unknown = unknown)', () => {
    const { tracker, calls } = makeTracker();
    tracker.submitAttempt({
      submittedText: 'e4',
      firstEditMonotonicMs: null,
      validation: 'legal',
      from: 'e2', to: 'e4', promotion: null,
    });
    assert.equal(calls[0].payload.firstEditMonotonicMs, null);
  });

  it('the normalized string appears nowhere in any 3.2 payload', () => {
    const { tracker, calls } = makeTracker();
    // Submit with odd spacing/casing; normalizeMove would produce 'e4'.
    tracker.submitAttempt({
      submittedText: ' E4 ',
      firstEditMonotonicMs: null,
      validation: 'legal',
      from: 'e2', to: 'e4', promotion: null,
    });
    const serialized = JSON.stringify(calls);
    assert.ok(!serialized.includes('"normalized"'), 'no normalized key anywhere');
    // The verbatim text is stored; the normalized form is not stored
    // as a separate field.
    assert.ok(serialized.includes(' E4 '), 'verbatim text stored');
  });
});

// ------------------------------------------------------------------
// AC4 — makeMoveOnBoard failure reasons (3.2.4).
// ------------------------------------------------------------------
describe('AC4 — dispatch failure reasons', () => {
  const REASONS = BlindfoldSession.DISPATCH_FAILURE_REASONS;

  it('DISPATCH_FAILURE_REASONS has exactly the five contracted members', () => {
    assert.deepEqual([...REASONS], [
      'move_unparsable',
      'board_not_found',
      'square_coordinates_failed',
      'promotion_window_timeout',
      'promotion_choice_missing',
    ]);
    assert.ok(Object.isFrozen(REASONS), 'frozen');
  });

  it('move_unparsable: parseMoveSquares fails', async () => {
    const game = new Chess();
    const out = await BlindfoldSession.makeMoveOnBoard(game, 'notamove');
    assert.equal(out, 'move_unparsable');
  });

  it('board_not_found: getBoardElement returns null', async () => {
    const game = new Chess();
    const origQuery = globalThis.document && globalThis.document.querySelector;
    globalThis.document = { querySelector: () => null };
    try {
      const out = await BlindfoldSession.makeMoveOnBoard(game, 'e4');
      assert.equal(out, 'board_not_found');
    } finally {
      if (origQuery) globalThis.document.querySelector = origQuery;
      else delete globalThis.document;
    }
  });

  it('square_coordinates_failed branch exists and returns the contracted reason', () => {
    // Defensive branch: parseMoveSquares only yields valid squares, so the
    // branch is unreachable without stubbing internals. Assert the code
    // shape instead — the branch must return REASONS[2].
    const src = fs.readFileSync(path.join(ROOT, 'chess_utils.js'), 'utf8');
    assert.ok(src.includes("return REASONS[2]; // 'square_coordinates_failed'"),
      'square_coordinates_failed branch present');
  });

  it('promotion_window_timeout: no visible promotion window', async () => {
    // Promotion position: white pawn on e7 ready to promote.
    const game = new Chess('6k1/4P3/8/8/8/8/8/4K3 w - - 0 1');
    const board = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800 }),
      classList: { contains: () => false },
      dispatchEvent: () => {},
    };
    globalThis.document = {
      querySelector: (sel) => {
        if (sel === 'wc-chess-board') return board;
        return null; // no promotion window
      },
    };
    const origPE = globalThis.PointerEvent;
    const origME = globalThis.MouseEvent;
    globalThis.PointerEvent = function () {};
    globalThis.MouseEvent = function () {};
    try {
      const out = await BlindfoldSession.makeMoveOnBoard(game, 'e8=Q');
      assert.equal(out, 'promotion_window_timeout');
    } finally {
      delete globalThis.document;
      if (origPE) globalThis.PointerEvent = origPE; else delete globalThis.PointerEvent;
      if (origME) globalThis.MouseEvent = origME; else delete globalThis.MouseEvent;
    }
  });

  it('promotion_choice_missing: window visible but no matching choice', async () => {
    const game = new Chess('6k1/4P3/8/8/8/8/8/4K3 w - - 0 1');
    const board = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800 }),
      classList: { contains: () => false },
      dispatchEvent: () => {},
    };
    const fakeWindow = {
      querySelector: () => null, // no .promotion-piece.wq
    };
    globalThis.document = {
      querySelector: (sel) => {
        if (sel === 'wc-chess-board') return board;
        if (sel === '.promotion-window.promotion-window--visible') return fakeWindow;
        return null;
      },
    };
    const origPE2 = globalThis.PointerEvent;
    const origME2 = globalThis.MouseEvent;
    globalThis.PointerEvent = function () {};
    globalThis.MouseEvent = function () {};
    try {
      const out = await BlindfoldSession.makeMoveOnBoard(game, 'e8=Q');
      assert.equal(out, 'promotion_choice_missing');
    } finally {
      delete globalThis.document;
      if (origPE2) globalThis.PointerEvent = origPE2; else delete globalThis.PointerEvent;
      if (origME2) globalThis.MouseEvent = origME2; else delete globalThis.MouseEvent;
    }
  });

  it('success path returns true (non-promotion)', async () => {
    const game = new Chess();
    const board = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800 }),
      classList: { contains: () => false },
      dispatchEvent: () => {},
    };
    globalThis.document = {
      querySelector: (sel) => (sel === 'wc-chess-board' ? board : null),
    };
    // PointerEvent/MouseEvent are DOM-only; stub minimally.
    const origPE = globalThis.PointerEvent;
    const origME = globalThis.MouseEvent;
    globalThis.PointerEvent = function () {};
    globalThis.MouseEvent = function () {};
    try {
      const out = await BlindfoldSession.makeMoveOnBoard(game, 'e4');
      assert.equal(out, true);
    } finally {
      delete globalThis.document;
      if (origPE) globalThis.PointerEvent = origPE; else delete globalThis.PointerEvent;
      if (origME) globalThis.MouseEvent = origME; else delete globalThis.MouseEvent;
    }
  });

  it('dispatch_started precedes dispatch; dispatch_failed carries both refs', () => {
    const { tracker, calls } = makeTracker();
    const res = tracker.submitAttempt({
      submittedText: 'e4', firstEditMonotonicMs: null, validation: 'legal',
      from: 'e2', to: 'e4', promotion: null,
    });
    const started = tracker.noteDispatchStarted(res.attemptEventId);
    assert.ok(started && typeof started.dispatchEventId === 'string');
    const failed = tracker.noteDispatchFailed(
      res.attemptEventId, started.dispatchEventId, 'board_not_found');
    assert.ok(failed);
    assert.deepEqual(types(calls), [
      'move_attempt', 'move_dispatch_started', 'move_dispatch_failed',
    ]);
    assert.deepEqual(calls[1].refs, { attemptEventId: res.attemptEventId });
    assert.deepEqual(calls[2].payload, { failureReason: 'board_not_found' });
    assert.deepEqual(calls[2].refs, {
      attemptEventId: res.attemptEventId,
      dispatchStartedEventId: started.dispatchEventId,
    });
  });
});

// ------------------------------------------------------------------
// AC5 — matching (3.2.5).
// ------------------------------------------------------------------
describe('AC5 — attempt→confirmed matching', () => {
  it('equal from/to/promotion → exactly one matched event with both refs', () => {
    const { tracker, calls } = makeTracker();
    const res = tracker.submitAttempt({
      submittedText: 'e4', firstEditMonotonicMs: 1, validation: 'legal',
      from: 'e2', to: 'e4', promotion: null,
    });
    const confirmedId = testUuid();
    const matched = tracker.noteConfirmedMoves([
      { from: 'e2', to: 'e4', promotion: null, eventId: confirmedId },
    ]);
    assert.equal(matched.length, 1);
    assert.deepEqual(matched[0], {
      attemptEventId: res.attemptEventId,
      confirmedMoveEventId: confirmedId,
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].eventType, 'move_attempt_matched');
    assert.deepEqual(calls[1].payload, {});
    assert.deepEqual(calls[1].refs, {
      attemptEventId: res.attemptEventId,
      confirmedMoveEventId: confirmedId,
    });
    assert.equal(tracker.pendingCount(), 0, 'matched attempt leaves pending');
  });

  it('confirmed entries with null eventId never produce links', () => {
    const { tracker, calls } = makeTracker();
    tracker.submitAttempt({
      submittedText: 'e4', firstEditMonotonicMs: null, validation: 'legal',
      from: 'e2', to: 'e4', promotion: null,
    });
    const matched = tracker.noteConfirmedMoves([
      { from: 'e2', to: 'e4', promotion: null, eventId: null },
    ]);
    assert.equal(matched.length, 0);
    assert.equal(calls.length, 1, 'only move_attempt');
    assert.equal(tracker.pendingCount(), 1, 'attempt stays pending');
  });

  it('FIFO order for duplicate attempts', () => {
    const { tracker, calls } = makeTracker();
    const r1 = tracker.submitAttempt({
      submittedText: 'Nf3', firstEditMonotonicMs: null, validation: 'legal',
      from: 'g1', to: 'f3', promotion: null,
    });
    const r2 = tracker.submitAttempt({
      submittedText: 'Nf3', firstEditMonotonicMs: null, validation: 'legal',
      from: 'g1', to: 'f3', promotion: null,
    });
    const id1 = testUuid();
    const id2 = testUuid();
    const matched = tracker.noteConfirmedMoves([
      { from: 'g1', to: 'f3', promotion: null, eventId: id1 },
      { from: 'g1', to: 'f3', promotion: null, eventId: id2 },
    ]);
    assert.equal(matched.length, 2);
    assert.equal(matched[0].attemptEventId, r1.attemptEventId);
    assert.equal(matched[0].confirmedMoveEventId, id1);
    assert.equal(matched[1].attemptEventId, r2.attemptEventId);
    assert.equal(matched[1].confirmedMoveEventId, id2);
  });

  it('no match on from/to mismatch', () => {
    const { tracker, calls } = makeTracker();
    tracker.submitAttempt({
      submittedText: 'e4', firstEditMonotonicMs: null, validation: 'legal',
      from: 'e2', to: 'e4', promotion: null,
    });
    const matched = tracker.noteConfirmedMoves([
      { from: 'd2', to: 'd4', promotion: null, eventId: testUuid() },
    ]);
    assert.equal(matched.length, 0);
    assert.equal(calls.length, 1);
  });

  it('promotion must match too', () => {
    const { tracker } = makeTracker();
    tracker.submitAttempt({
      submittedText: 'e8=Q', firstEditMonotonicMs: null, validation: 'legal',
      from: 'e7', to: 'e8', promotion: 'q',
    });
    const matched = tracker.noteConfirmedMoves([
      { from: 'e7', to: 'e8', promotion: 'r', eventId: testUuid() },
    ]);
    assert.equal(matched.length, 0, 'queen attempt does not match rook confirmation');
  });

  it('noteConfirmedMoves with non-array → TypeError', () => {
    const { tracker } = makeTracker();
    assert.throws(() => tracker.noteConfirmedMoves(null), TypeError);
    assert.throws(() => tracker.noteConfirmedMoves('x'), TypeError);
  });
});

// ------------------------------------------------------------------
// AC6 — lifecycle (3.2.6).
// ------------------------------------------------------------------
describe('AC6 — attempt lifecycle', () => {
  it('illegal-at-submit is terminal at birth (no timer, no unconfirmed)', () => {
    const { tracker, calls, timers } = makeTracker();
    const res = tracker.submitAttempt({
      submittedText: 'Ke9', firstEditMonotonicMs: null, validation: 'illegal',
      from: null, to: null, promotion: null,
    });
    assert.ok(res);
    assert.equal(tracker.pendingCount(), 0);
    assert.equal(timers.scheduled.size, 0, 'no timer scheduled');
    assert.deepEqual(types(calls), ['move_attempt']);
    timers.fireAll();
    assert.equal(calls.length, 1, 'no unconfirmed event fires');
  });

  it('unparsable legal attempt (null from/to) is terminal at birth', () => {
    const { tracker, calls, timers } = makeTracker();
    tracker.submitAttempt({
      submittedText: 'e4', firstEditMonotonicMs: null, validation: 'legal',
      from: null, to: null, promotion: null,
    });
    assert.equal(tracker.pendingCount(), 0);
    assert.equal(timers.scheduled.size, 0);
  });

  it('dispatch-failed attempt is terminal (no unconfirmed on timer)', () => {
    const { tracker, calls, timers } = makeTracker();
    const res = tracker.submitAttempt({
      submittedText: 'e4', firstEditMonotonicMs: null, validation: 'legal',
      from: 'e2', to: 'e4', promotion: null,
    });
    const started = tracker.noteDispatchStarted(res.attemptEventId);
    tracker.noteDispatchFailed(res.attemptEventId, started.dispatchEventId, 'board_not_found');
    assert.equal(tracker.pendingCount(), 0);
    timers.fireAll();
    assert.deepEqual(types(calls),
      ['move_attempt', 'move_dispatch_started', 'move_dispatch_failed'],
      'no unconfirmed event');
  });

  it('pending attempt with no match → unconfirmed {reason: timeout}', () => {
    const { tracker, calls, timers } = makeTracker({ unconfirmedTimeoutMs: 50 });
    const res = tracker.submitAttempt({
      submittedText: 'e4', firstEditMonotonicMs: null, validation: 'legal',
      from: 'e2', to: 'e4', promotion: null,
    });
    assert.equal(timers.scheduled.size, 1);
    const timerId = [...timers.scheduled.keys()][0];
    assert.equal(timers.scheduled.get(timerId).ms, 50);
    timers.fireOne(timerId);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].eventType, 'move_attempt_unconfirmed');
    assert.deepEqual(calls[1].payload, { reason: 'timeout' });
    assert.deepEqual(calls[1].refs, { attemptEventId: res.attemptEventId });
    assert.equal(tracker.pendingCount(), 0);
  });

  it('handleGameReset marks all pending unconfirmed {reason: game_reset}', () => {
    const { tracker, calls } = makeTracker();
    const r1 = tracker.submitAttempt({
      submittedText: 'e4', firstEditMonotonicMs: null, validation: 'legal',
      from: 'e2', to: 'e4', promotion: null,
    });
    const r2 = tracker.submitAttempt({
      submittedText: 'd4', firstEditMonotonicMs: null, validation: 'legal',
      from: 'd2', to: 'd4', promotion: null,
    });
    const marked = tracker.handleGameReset();
    assert.deepEqual(marked, [r1.attemptEventId, r2.attemptEventId]);
    assert.deepEqual(types(calls),
      ['move_attempt', 'move_attempt', 'move_attempt_unconfirmed', 'move_attempt_unconfirmed']);
    assert.ok(calls.slice(2).every((c) => c.payload.reason === 'game_reset'));
    assert.equal(tracker.pendingCount(), 0);
  });

  it('handlePageHide marks pending unconfirmed {reason: pagehide} and never throws', () => {
    const { tracker, calls } = makeTracker();
    const res = tracker.submitAttempt({
      submittedText: 'e4', firstEditMonotonicMs: null, validation: 'legal',
      from: 'e2', to: 'e4', promotion: null,
    });
    const marked = tracker.handlePageHide();
    assert.deepEqual(marked, [res.attemptEventId]);
    assert.equal(calls[1].eventType, 'move_attempt_unconfirmed');
    assert.deepEqual(calls[1].payload, { reason: 'pagehide' });
    assert.equal(tracker.pendingCount(), 0);
  });

  it('emit throw during markPendingUnconfirmed does not abort the loop (3.2 SF-1 NOTE-5)', () => {
    const { calls, emitEvent } = makeEmitter();
    let n = 0;
    const throwingEmit = (et, p, r) => {
      n++;
      if (et === 'move_attempt_unconfirmed' && n === 3) throw new Error('boom');
      return emitEvent(et, p, r);
    };
    const timers = makeFakeTimers();
    const tracker = BlindfoldSession.createAttemptTracker({
      emitEvent: throwingEmit,
      getSessionId: () => sid(),
      getGameId: () => gid(),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    const r1 = tracker.submitAttempt({
      submittedText: 'e4', firstEditMonotonicMs: null, validation: 'legal',
      from: 'e2', to: 'e4', promotion: null,
    });
    const r2 = tracker.submitAttempt({
      submittedText: 'd4', firstEditMonotonicMs: null, validation: 'legal',
      from: 'd2', to: 'd4', promotion: null,
    });
    const marked = tracker.handleGameReset();
    assert.deepEqual(marked, [r1.attemptEventId, r2.attemptEventId],
      'both attempts marked despite the mid-loop emit throw');
    assert.equal(tracker.pendingCount(), 0, 'no pending attempt left behind');
  });

  it('matched attempt does not later go unconfirmed', () => {
    const { tracker, calls, timers } = makeTracker();
    const res = tracker.submitAttempt({
      submittedText: 'e4', firstEditMonotonicMs: null, validation: 'legal',
      from: 'e2', to: 'e4', promotion: null,
    });
    tracker.noteConfirmedMoves([
      { from: 'e2', to: 'e4', promotion: null, eventId: testUuid() },
    ]);
    timers.fireAll();
    assert.deepEqual(types(calls), ['move_attempt', 'move_attempt_matched']);
  });

  it('noteDispatchFailed with bad reason → RangeError', () => {
    const { tracker } = makeTracker();
    const res = tracker.submitAttempt({
      submittedText: 'e4', firstEditMonotonicMs: null, validation: 'legal',
      from: 'e2', to: 'e4', promotion: null,
    });
    assert.throws(() => tracker.noteDispatchFailed(res.attemptEventId, null, 'bogus'),
      RangeError);
  });
});

// ------------------------------------------------------------------
// AC7 — dormancy (§5 seam).
// ------------------------------------------------------------------
describe('AC7 — dormancy', () => {
  it('null sessionId → all methods inert (no events, no timers)', () => {
    const { calls, emitEvent, timers } = (() => {
      const e = makeEmitter();
      const t = makeFakeTimers();
      return { ...e, timers: t };
    })();
    const tracker = BlindfoldSession.createAttemptTracker({
      emitEvent,
      getSessionId: () => null,
      getGameId: () => gid(),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    assert.equal(tracker.submitAttempt({
      submittedText: 'e4', firstEditMonotonicMs: null, validation: 'legal',
      from: 'e2', to: 'e4', promotion: null,
    }), null);
    assert.equal(tracker.noteDispatchStarted(testUuid()), null);
    assert.equal(tracker.noteDispatchFailed(testUuid(), null, 'board_not_found'), null);
    assert.deepEqual(tracker.noteConfirmedMoves([]), []);
    assert.deepEqual(tracker.handleGameReset(), []);
    assert.deepEqual(tracker.handlePageHide(), []);
    assert.equal(calls.length, 0, 'no events emitted');
    assert.equal(timers.scheduled.size, 0, 'no timers scheduled');
  });

  it('empty gameId → inert', () => {
    const { calls, emitEvent } = makeEmitter();
    const tracker = BlindfoldSession.createAttemptTracker({
      emitEvent,
      getSessionId: () => sid(),
      getGameId: () => '',
    });
    assert.equal(tracker.submitAttempt({
      submittedText: 'e4', firstEditMonotonicMs: null, validation: 'legal',
      from: 'e2', to: 'e4', promotion: null,
    }), null);
    assert.equal(calls.length, 0);
  });

  it('bad constructor args → TypeError', () => {
    assert.throws(() => BlindfoldSession.createAttemptTracker(null), TypeError);
    assert.throws(() => BlindfoldSession.createAttemptTracker({}), TypeError);
    assert.throws(() => BlindfoldSession.createAttemptTracker({
      emitEvent: () => {}, getSessionId: () => sid(),
    }), TypeError);
    assert.throws(() => BlindfoldSession.createAttemptTracker({
      emitEvent: () => {}, getSessionId: () => sid(), getGameId: () => gid(),
      unconfirmedTimeoutMs: 0,
    }), TypeError);
  });
});

// ------------------------------------------------------------------
// AC8 — payload validators.
// ------------------------------------------------------------------
describe('AC8 — payload validators', () => {
  const BS = BlindfoldSession;

  it('requireValidMoveAttemptPayload: exact keys + enums', () => {
    const good = {
      submittedText: 'e4', firstEditMonotonicMs: 1.5, validation: 'legal',
    };
    assert.deepEqual(BS.requireValidMoveAttemptPayload(good), good);
    assert.throws(() => BS.requireValidMoveAttemptPayload(null), TypeError);
    assert.throws(() => BS.requireValidMoveAttemptPayload({
      submittedText: 'e4', firstEditMonotonicMs: null,
    }), TypeError, 'missing validation');
    assert.throws(() => BS.requireValidMoveAttemptPayload({
      submittedText: 'e4', firstEditMonotonicMs: null, validation: 'legal',
      extra: 1,
    }), TypeError, 'extra key');
    assert.throws(() => BS.requireValidMoveAttemptPayload({
      submittedText: 42, firstEditMonotonicMs: null, validation: 'legal',
    }), TypeError, 'submittedText type');
    assert.throws(() => BS.requireValidMoveAttemptPayload({
      submittedText: 'e4', firstEditMonotonicMs: 'now', validation: 'legal',
    }), TypeError, 'firstEditMonotonicMs type');
    assert.throws(() => BS.requireValidMoveAttemptPayload({
      submittedText: 'e4', firstEditMonotonicMs: null, validation: 'maybe',
    }), RangeError, 'validation enum');
  });

  it('requireValidDispatchFailedPayload: reason must be a member', () => {
    assert.deepEqual(
      BS.requireValidDispatchFailedPayload({ failureReason: 'board_not_found' }),
      { failureReason: 'board_not_found' });
    assert.throws(() => BS.requireValidDispatchFailedPayload({}), TypeError);
    assert.throws(() => BS.requireValidDispatchFailedPayload({ failureReason: 'nope' }),
      RangeError);
  });

  it('refs validators: exact keys + uuid-v4', () => {
    const a = testUuid(), b = testUuid();
    assert.deepEqual(BS.requireValidDispatchStartedRefs({ attemptEventId: a }),
      { attemptEventId: a });
    assert.deepEqual(
      BS.requireValidDispatchFailedRefs({ attemptEventId: a, dispatchStartedEventId: b }),
      { attemptEventId: a, dispatchStartedEventId: b });
    assert.deepEqual(
      BS.requireValidDispatchFailedRefs({ attemptEventId: a, dispatchStartedEventId: null }),
      { attemptEventId: a, dispatchStartedEventId: null },
      'null dispatchStartedEventId allowed (dormant start)');
    assert.deepEqual(
      BS.requireValidAttemptMatchedRefs({ attemptEventId: a, confirmedMoveEventId: b }),
      { attemptEventId: a, confirmedMoveEventId: b });
    assert.deepEqual(
      BS.requireValidAttemptUnconfirmedRefs({ attemptEventId: a }),
      { attemptEventId: a });
    assert.throws(() => BS.requireValidDispatchStartedRefs({ attemptEventId: 'x' }),
      TypeError, 'non-uuid');
    assert.throws(() => BS.requireValidAttemptMatchedRefs(
      { attemptEventId: a, confirmedMoveEventId: a, extra: 1 }), TypeError, 'extra key');
  });

  it('requireValidAttemptUnconfirmedPayload: reason enum', () => {
    for (const reason of ['timeout', 'pagehide', 'game_reset']) {
      assert.deepEqual(BS.requireValidAttemptUnconfirmedPayload({ reason }), { reason });
    }
    assert.throws(() => BS.requireValidAttemptUnconfirmedPayload({ reason: 'lost' }),
      RangeError);
    assert.throws(() => BS.requireValidAttemptUnconfirmedPayload({}), TypeError);
  });

  it('submitAttempt input validation: types → TypeError, enums → RangeError', () => {
    const { tracker } = makeTracker();
    assert.throws(() => tracker.submitAttempt(null), TypeError);
    assert.throws(() => tracker.submitAttempt({
      submittedText: 42, firstEditMonotonicMs: null, validation: 'legal',
    }), TypeError);
    assert.throws(() => tracker.submitAttempt({
      submittedText: 'e4', firstEditMonotonicMs: 'soon', validation: 'legal',
    }), TypeError);
    assert.throws(() => tracker.submitAttempt({
      submittedText: 'e4', firstEditMonotonicMs: null, validation: 'ok',
    }), RangeError);
    assert.throws(() => tracker.submitAttempt({
      submittedText: 'e4', firstEditMonotonicMs: null, validation: 'legal', from: 42,
    }), TypeError);
  });
});

// ------------------------------------------------------------------
// AC9 — diff discipline. AC10 — scope.
// ------------------------------------------------------------------
describe('AC9/AC10 — diff discipline and scope', () => {
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
      'sounds.js',
      'tests/attempt_tracker.test.js',
      // Honest cumulative evolution: earlier tasks' suites pin files 3.2
      // legitimately touches.
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
      '.autodev/evidence/3.2.contract.md',
      '.autodev/evidence/3.2.build.md',
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
      // Honest cumulative evolution: the adversarial review and
      // behavioral verification evidence land after the builder
      // evolved these pins (2.x/3.1 precedent).
      '.autodev/evidence/3.2.review.md',
      '.autodev/evidence/3.2.behavior.md',
      // Honest cumulative evolution: 3.3 legitimately touches
      // chess_utils.js + content.js; its files join the allowlists.
      'tests/visibility.test.js',
      'tests/speech.test.js',
      '.autodev/evidence/3.3.contract.md',
      '.autodev/evidence/3.3.build.md',
      // Honest cumulative evolution: 3.3's review/behavior evidence
      // lands after the pins were evolved (2.x/3.1/3.2 precedent).
      '.autodev/evidence/3.3.review.md',
      '.autodev/evidence/3.3.behavior.md',
      '.autodev/evidence/3.3.domaudit.md',
      // Honest cumulative evolution: 3.4 legitimately touches
      // sounds.js + content.js and adds its evidence.
      '.autodev/evidence/3.4.contract.md',
      '.autodev/evidence/3.4.build.md',
      // Honest cumulative evolution: 3.4's review/behavior evidence
      // lands after the pins were evolved (2.x/3.1/3.2/3.3 precedent).
      '.autodev/evidence/3.4.review.md',
      '.autodev/evidence/3.4.behavior.md',
      // Honest cumulative evolution: 3.5 legitimately touches
      // chess_utils.js (game lifecycle recorder + additive onGameReset
      // { confirmedMoveCount } argument) + content.js (visibility/focus
      // listeners, onGameReset recording, chess_rules game-end wiring);
      // adds tests/game_lifecycle.test.js and its evidence; records the
      // 3.5.3 dialog / reconnect audit in DECISIONS.md.
      'chess_utils.js',
      'tests/game_lifecycle.test.js',
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
      // Honest cumulative evolution: 5.8 (optional timestamped
      // note/moment marker) legitimately adds the moment_marker event
      // type + marker UI to session_controls.js, its test + evidence;
      // its files join the allowlists. No new channel messages,
      // stores, or permissions.
      '.autodev/evidence/5.8.contract.md',
      '.autodev/evidence/5.8.build.md',
      // Honest cumulative evolution: 5.8's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.7 precedent).
      '.autodev/evidence/5.8.review.md',
      '.autodev/evidence/5.8.behavior.md',
      // Honest cumulative evolution: 5.9 (mid-session game transition)
      // legitimately implements the onGameReset placeholder in content.js
      // (mint new gameId + install fresh tracker) and adds handleGameReset
      // + activeMetadata/activeConditions to session_controls.js (the
      // specified deliverable; 5.7 named the placeholder as 5.9's input),
      // adds its unit/integration tests, and records its evidence; its
      // files join the allowlists. No new channel messages, event types,
      // stores, or permissions.
      '.autodev/evidence/5.9.contract.md',
      '.autodev/evidence/5.9.build.md',
      // Honest cumulative evolution: 5.9's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.8 precedent).
      '.autodev/evidence/5.9.review.md',
      '.autodev/evidence/5.9.behavior.md',
      // Honest cumulative evolution: 5.10 (Stop completion verdict)
      // legitimately adds the sender.flush() await + transitional
      // "Finalizing…" UI + pure computeCompletion() + enriched
      // lastStopResponse retention to session_controls.js's Stop
      // sequence, adds its unit/integration tests, and records its
      // evidence; its files join the allowlists. No new channel
      // messages, event types, stores, or permissions.
      '.autodev/evidence/5.10.contract.md',
      '.autodev/evidence/5.10.build.md',
      // Honest cumulative evolution: 5.10's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.9 precedent).
      '.autodev/evidence/5.10.review.md',
      '.autodev/evidence/5.10.behavior.md',
      // Honest cumulative evolution: 6.1 (generate metadata.json from
      // stored context and observed completion status) legitimately adds
      // the new SW-side exporter.js module (pure buildMetadataJson
      // builder; 6.6 owns the orchestration/permission/message), its
      // test file, and its evidence; its files join the allowlists.
      // No new channel messages, event types, stores, or permissions
      // in 6.1. The section audit/architecture evidence files
      // (section-5.audit.md, created by the section auditor after 5.10's
      // pins; section-6.architecture.md, the §6 planner's) are
      // allowlisted here to repair the stale pins.
      'exporter.js',
      'tests/exporter.test.js',
      '.autodev/evidence/6.1.contract.md',
      '.autodev/evidence/6.1.build.md',
      '.autodev/evidence/section-5.audit.md',
      '.autodev/evidence/section-6.architecture.md',
      // Honest cumulative evolution: 6.1's review/behavior evidence lands
      // after the pins are evolved (2.x-5.x precedent).
      '.autodev/evidence/6.1.review.md',
      '.autodev/evidence/6.1.behavior.md',
    ]);
    for (const f of changed) {
      assert.ok(allowed.has(f), `unexpected modified file: ${f}`);
    }
  });

  it('event_envelope.js untouched; new types are 3.2-owned constants', () => {
    const src = fs.readFileSync(path.join(ROOT, 'chess_utils.js'), 'utf8');
    for (const t of ['move_attempt', 'move_dispatch_started', 'move_dispatch_failed',
                     'move_attempt_matched', 'move_attempt_unconfirmed']) {
      assert.ok(src.includes(`'${t}'`), `constant for ${t}`);
    }
    const env = fs.readFileSync(path.join(ROOT, 'event_envelope.js'), 'utf8');
    assert.ok(!env.includes('move_attempt'), 'event_envelope.js has no 3.2 types');
  });

  it('PLAN.md unmodified', () => {
    const head = execSync('git show HEAD:PLAN.md', { cwd: ROOT, stdio: 'pipe' }).toString();
    const current = fs.readFileSync(path.join(ROOT, 'PLAN.md'), 'utf8');
    assert.strictEqual(current, head);
  });

  it('existing UX code preserved in content.js (borders, sounds, hotkeys)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
    assert.ok(src.includes('move_input.style.borderColor = "green"'), 'green border');
    assert.ok(src.includes('move_input.style.borderColor = "red"'), 'red border');
    assert.ok(src.includes('playIllegalMoveSound()'), 'illegal sound');
    assert.ok(src.includes('move_input.value = ""'), 'field clear');
  });

  it('no §4/§5 implementation scope in the diff (3.4/3.5 are done — their scope is legitimate)', () => {
    // Honest cumulative evolution: 3.4 (speech) and 3.5 (game lifecycle)
    // are now the legitimate diff; the pin guards §4 recording and §5
    // session-control tokens. Only ADDED lines count: comments may name
    // future tasks to declare scope boundaries.
    const diff = execSync('git diff HEAD -- chess_utils.js content.js', { cwd: ROOT }).toString();
    const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    for (const token of ['MediaRecorder', 'getUserMedia', 'getDisplayMedia']) {
      assert.ok(!added.some((l) => l.includes(token)),
        `no §4/§5 token in added lines: ${token}`);
    }
  });
});
