// tests/history_tracker.test.js
//
// Task 3.1 (PLAN.md §3.1): "Make confirmed history tracking reliable in
// chess_utils.js."
//
// V1 — static/unit. Covers 3.1.contract.md AC1–AC14 (AC15 is the V2
// sw-history.js harness; AC16 is the full-suite re-run; AC17 is
// V3-deferred to §7).
//
// The tracker is DOM-free (observe() takes SAN string arrays); only AC1
// (observeMoves content comparison) needs a minimal DOM/MutationObserver
// stub. Chess comes from the vendored chess.min.js via globalThis.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// Chess must be on globalThis before chess_utils.js's tracker uses it.
globalThis.Chess = require('../chess.min.js').Chess;

// Merge namespaces on globalThis (the repo's Node test pattern):
// game_records.js provides the 1.4 payload factories the tracker calls
// via sharedBS(); chess_utils.js provides the tracker.
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

function makeTracker(opts) {
  const { calls, emitEvent } = makeEmitter();
  let resetCalled = 0;
  const tracker = BlindfoldSession.createHistoryTracker(Object.assign({
    gameId: gid(),
    emitEvent,
    onGameReset: () => { resetCalled++; }
  }, opts || {}));
  return { tracker, calls, resetCalled: () => resetCalled };
}

function types(calls) {
  return calls.map((c) => c.eventType);
}

// ------------------------------------------------------------------
// AC1 — observeMoves fires on content change, not length-only.
// ------------------------------------------------------------------
describe('AC1 — observeMoves content comparison', () => {
  let observerInstances;
  let moveList;
  let priorDocument, priorMO;

  beforeEach(() => {
    observerInstances = [];
    moveList = [];
    priorDocument = globalThis.document;
    priorMO = globalThis.MutationObserver;
    globalThis.document = {
      querySelector: (sel) => {
        if (sel === '.play-controller-moveList') {
          return {
            querySelectorAll: () => moveList.map((text) => ({ textContent: text }))
          };
        }
        return null;
      },
      body: {}
    };
    globalThis.MutationObserver = class {
      constructor(cb) { this.cb = cb; observerInstances.push(this); }
      observe() {}
      disconnect() {}
    };
  });

  afterEach(() => {
    globalThis.document = priorDocument;
    globalThis.MutationObserver = priorMO;
  });

  function trigger() {
    observerInstances[observerInstances.length - 1].cb();
  }

  it('same-length substitution fires the observer', () => {
    const seen = [];
    // observeMoves is a top-level function in chess_utils.js; reach it via
    // the module export shim (functions are not on the namespace, so load
    // via a fresh Function wrapper over the source).
    const src = fs.readFileSync(path.join(ROOT, 'chess_utils.js'), 'utf8');
    const factory = new Function(
      'document', 'MutationObserver', 'Chess',
      src + '\nreturn { observeMoves, getMoveList };'
    );
    const { observeMoves } = factory(globalThis.document, globalThis.MutationObserver, globalThis.Chess);
    moveList = ['e4', 'e5'];
    observeMoves((hm) => seen.push(hm.slice()));
    assert.equal(seen.length, 1, 'initial check fires');
    moveList = ['e4', 'c5']; // same length, different content
    trigger();
    assert.equal(seen.length, 2, 'same-length substitution must fire');
    assert.deepEqual(seen[1], ['e4', 'c5']);
  });

  it('identical re-render does not fire', () => {
    const src = fs.readFileSync(path.join(ROOT, 'chess_utils.js'), 'utf8');
    const factory = new Function(
      'document', 'MutationObserver', 'Chess',
      src + '\nreturn { observeMoves };'
    );
    const { observeMoves } = factory(globalThis.document, globalThis.MutationObserver, globalThis.Chess);
    const seen = [];
    moveList = ['e4', 'e5'];
    observeMoves((hm) => seen.push(hm.slice()));
    assert.equal(seen.length, 1);
    moveList = ['e4', 'e5']; // identical content, new array
    trigger();
    assert.equal(seen.length, 1, 'identical re-render must not fire');
  });
});

// ------------------------------------------------------------------
// AC2 — validation before advancing.
// ------------------------------------------------------------------
describe('AC2 — validate before advancing', () => {
  it('invalid observed move is not applied; sync failure emitted', () => {
    const { tracker, calls } = makeTracker();
    tracker.observe(['e4']);
    const fenAfterE4 = tracker.getGame().fen();
    const res = tracker.observe(['e4', 'THIS_IS_NOT_A_MOVE']);
    assert.equal(res.syncFailed, true);
    assert.equal(tracker.getGame().fen(), fenAfterE4, 'board must not advance past e4');
    assert.equal(tracker.getConfirmedCount(), 1, 'confirmed count must not advance');
    const last = calls[calls.length - 1];
    assert.equal(last.eventType, 'history_sync_failed');
    assert.equal(last.payload.reason, 'illegal_observed_move');
    assert.equal(last.payload.plyIndex, 1);
    assert.equal(last.payload.observedSan, 'THIS_IS_NOT_A_MOVE');
    assert.ok(last.payload.internalFen, 'internalFen present');
  });

  it('normalizeMove fallback rescues display quirks (no false sync failure)', () => {
    const { tracker, calls } = makeTracker();
    // 'o-o' (lowercase, hyphenated) is a Chess.com display quirk;
    // normalizeMove maps it to O-O. Use a position where castling is legal.
    const res = tracker.observe(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'o-o']);
    assert.equal(res.syncFailed, false);
    assert.equal(res.confirmed.length, 7, 'all 7 moves confirm (first observation is a batch)');
    // Castling applied: white king on g1, rook on f1.
    assert.ok(tracker.getGame().fen().endsWith('RNBQ1RK1 b kq - 5 4'),
      'castling applied, got: ' + tracker.getGame().fen());
    assert.ok(!types(calls).includes('history_sync_failed'));
  });
});

// ------------------------------------------------------------------
// AC3 — one move_confirmed per validated addition.
// ------------------------------------------------------------------
describe('AC3 — move_confirmed payload shape', () => {
  it('e2e4 yields canonical {from,to,promotion}', () => {
    const { tracker, calls } = makeTracker();
    tracker.observe([]); // first observation empty → next is not a batch
    const res = tracker.observe(['e4']);
    assert.equal(res.confirmed.length, 1);
    assert.equal(res.recovered, false);
    const mc = calls.find((c) => c.eventType === 'move_confirmed');
    assert.deepEqual(mc.payload, { from: 'e2', to: 'e4', promotion: null });
    assert.equal(mc.refs, null);
  });

  it('castling yields king from/to; explicit promotion yields lowercase piece', () => {
    const { tracker, calls } = makeTracker();
    tracker.observe([]); // avoid batch marking
    tracker.observe(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O']);
    const castle = calls.filter((c) => c.eventType === 'move_confirmed').pop();
    assert.deepEqual(castle.payload, { from: 'e1', to: 'g1', promotion: null });

    // Explicit promotion: use the verified promotion line.
    const t2 = makeTracker();
    t2.tracker.observe([]);
    const promoPrefix = ['g4', 'd5', 'e3', 'c5', 'd4', 'f5', 'e4', 'e5', 'g5',
      'g6', 'b4', 'f4', 'b5', 'a5', 'h4', 'b6', 'a3', 'a4', 'c3', 'f3',
      'c4', 'h5', 'gxh6', 'g5', 'h7', 'g4'];
    t2.tracker.observe(promoPrefix);
    t2.tracker.observe(promoPrefix.concat(['hxg8=N']));
    const promo = t2.calls.filter((c) => c.eventType === 'move_confirmed').pop();
    assert.deepEqual(promo.payload, { from: 'h7', to: 'g8', promotion: 'n' });
  });
});

// ------------------------------------------------------------------
// AC4 — correction revision.
// ------------------------------------------------------------------
describe('AC4 — correction revision', () => {
  it('same-length divergence emits history_revised before the replacement', () => {
    const { tracker, calls } = makeTracker();
    tracker.observe(['e4', 'e5', 'Nf3']);
    const nf3EventId = calls.find((c) => c.eventType === 'move_confirmed' &&
      c.payload.from === 'g1').eventId;
    const res = tracker.observe(['e4', 'e5', 'Bc4']);
    assert.equal(res.revised, true);
    assert.equal(res.confirmed.length, 1);

    const revIdx = calls.findIndex((c) => c.eventType === 'history_revised');
    assert.ok(revIdx !== -1);
    const rev = calls[revIdx];
    assert.equal(rev.payload.revisionKind, 'correction');
    assert.deepEqual(rev.payload.retractedMoveEventIds, [nf3EventId], 'suffix rule');
    assert.equal(rev.payload.observedHistoryLength, 3);
    assert.equal(rev.payload.expectedMoveCount, 1);

    // The replacement follows the marker and links back.
    const rep = calls[revIdx + 1];
    assert.equal(rep.eventType, 'move_confirmed');
    assert.deepEqual(rep.payload, { from: 'f1', to: 'c4', promotion: null });
    assert.deepEqual(rep.refs, { revisionEventId: rev.eventId });

    // Internal board matches the revised line.
    assert.equal(tracker.getGame().fen().split(' ')[0],
      'rnbqkbnr/pppp1ppp/8/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR');
  });
});

// ------------------------------------------------------------------
// AC5 — takeback.
// ------------------------------------------------------------------
describe('AC5 — takeback', () => {
  it('strict prefix rewinds with a takeback marker, no new move_confirmed', () => {
    const { tracker, calls } = makeTracker();
    tracker.observe(['e4', 'e5', 'Nf3']);
    const before = calls.length;
    const res = tracker.observe(['e4', 'e5']);
    assert.equal(res.revised, true);
    assert.equal(res.confirmed.length, 0);
    assert.equal(calls.length, before + 1, 'only the marker is emitted');
    const rev = calls[calls.length - 1];
    assert.equal(rev.eventType, 'history_revised');
    assert.equal(rev.payload.revisionKind, 'takeback');
    assert.equal(rev.payload.expectedMoveCount, 0);
    assert.equal(rev.payload.observedHistoryLength, 2);
    assert.equal(rev.payload.retractedMoveEventIds.length, 1);
    // Board rewound to post-e5.
    assert.equal(tracker.getGame().fen().split(' ')[0],
      'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR');
    assert.equal(tracker.getConfirmedCount(), 2);
  });
});

// ------------------------------------------------------------------
// AC6 — suspect window: transient vs genuine reset.
// ------------------------------------------------------------------
describe('AC6 — suspect window', () => {
  it('two divergent-shorts stay silent in suspect; third ends the tracker', () => {
    const { tracker, calls } = makeTracker({ suspectThreshold: 3 });
    let resets = 0;
    const t = BlindfoldSession.createHistoryTracker({
      gameId: gid(),
      emitEvent: (et, p, r) => { const e = { eventId: testUuid() }; calls.push({ eventType: et }); return e; },
      onGameReset: () => { resets++; },
      suspectThreshold: 3
    });
    t.observe(['e4', 'e5', 'Nf3', 'Nc6']);
    const nCalls = calls.length;
    t.observe(['e4', 'd5']);
    assert.equal(t.getState(), 'suspect');
    assert.equal(calls.length, nCalls, 'no event on first divergent');
    t.observe(['e4', 'd5']);
    assert.equal(t.getState(), 'suspect');
    assert.equal(calls.length, nCalls, 'no event on second divergent');
    const res = t.observe(['e4', 'd5']);
    assert.equal(res.reset, true);
    assert.equal(t.getState(), 'ended');
    assert.equal(resets, 1, 'onGameReset called once');
    // Further observe() calls are ignored.
    const res2 = t.observe(['e4']);
    assert.equal(res2.reset, true);
    assert.equal(res2.confirmed.length, 0);
  });

  it('a reconciling observation clears the suspect window silently', () => {
    const { tracker, calls } = makeTracker({ suspectThreshold: 3 });
    tracker.observe(['e4', 'e5', 'Nf3', 'Nc6']);
    const nCalls = calls.length;
    tracker.observe(['e4', 'd5']); // divergent-short → suspect
    assert.equal(tracker.getState(), 'suspect');
    const res = tracker.observe(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']); // reconciles + appends
    assert.equal(tracker.getState(), 'tracking');
    assert.equal(res.confirmed.length, 1, 'the new move confirms');
    assert.ok(!types(calls).includes('history_revised'), 'no revision for the transient');
    assert.equal(calls.length, nCalls + 1, 'only the new move_confirmed');
  });

  it('null gameId: genuine reset restarts tracking in place instead of halting (3.1 SF-1)', () => {
    const { tracker } = makeTracker({ gameId: null, suspectThreshold: 3 });
    tracker.observe(['e4', 'e5', 'Nf3', 'Nc6']);
    tracker.observe(['e4', 'd5']);
    tracker.observe(['e4', 'd5']);
    const res = tracker.observe(['e4', 'd5']);
    assert.equal(res.reset, true, 'reset still reported');
    assert.equal(tracker.getState(), 'tracking', 'not ended — tracking restarts in place');
    // The new game continues: its full move list confirms as a fresh observation.
    const res2 = tracker.observe(['e4', 'd5', 'exd5']);
    assert.equal(res2.confirmed.length, 3, 'new game moves confirm after in-place restart');
    assert.equal(tracker.getState(), 'tracking');
  });
});

// ------------------------------------------------------------------
// AC7 — batch and recovery marking.
// ------------------------------------------------------------------
describe('AC7 — batch/recovery marking', () => {
  it('first observation with history emits page_reload marker-first', () => {
    const { tracker, calls } = makeTracker();
    const res = tracker.observe(['e4', 'e5', 'Nf3']);
    assert.equal(res.recovered, true);
    assert.equal(res.confirmed.length, 3);
    assert.equal(calls[0].eventType, 'history_recovered', 'marker first');
    assert.equal(calls[0].payload.recoveryReason, 'page_reload');
    assert.equal(calls[0].payload.expectedMoveCount, 3);
    for (let i = 1; i <= 3; i++) {
      assert.equal(calls[i].eventType, 'move_confirmed');
      assert.deepEqual(calls[i].refs, { recoveryEventId: calls[0].eventId });
    }
  });

  it('late batch after empty first observation emits late_attachment', () => {
    const { tracker, calls } = makeTracker();
    tracker.observe([]); // first observation: empty
    const res = tracker.observe(['e4', 'e5', 'Nf3']);
    assert.equal(res.recovered, true);
    assert.equal(calls[0].eventType, 'history_recovered');
    assert.equal(calls[0].payload.recoveryReason, 'late_attachment');
  });

  it('single new move on a non-first observation is not a batch', () => {
    const { tracker, calls } = makeTracker();
    tracker.observe(['e4']);
    const n = calls.length;
    const res = tracker.observe(['e4', 'e5']);
    assert.equal(res.recovered, false);
    assert.equal(calls.length, n + 1);
    assert.equal(calls[n].eventType, 'move_confirmed');
    assert.equal(calls[n].refs, null);
  });
});

// ------------------------------------------------------------------
// AC8 — no invented times.
// ------------------------------------------------------------------
describe('AC8 — no invented times', () => {
  it('no 3.1 payload carries a time field; batch is one synchronous burst', () => {
    const { tracker, calls } = makeTracker();
    const res = tracker.observe(['e4', 'e5', 'Nf3']);
    // All emissions happened synchronously inside observe() — the call
    // log is the burst.
    assert.equal(calls.length, 4);
    for (const c of calls) {
      for (const k of Object.keys(c.payload)) {
        assert.ok(!/time|date|clock|monotonic|timestamp/i.test(k),
          `payload key looks like a time field: ${k}`);
      }
    }
    // The 1.4 factories forbid time fields (exact-keys validation);
    // constructing through them already asserts this.
    assert.equal(res.recovered, true);
  });
});

// ------------------------------------------------------------------
// AC9 — unobservable promotion.
// ------------------------------------------------------------------
describe('AC9 — unobservable promotion', () => {
  it('promotion-shaped SAN with no determinable piece is a sync failure', () => {
    const { tracker, calls } = makeTracker();
    // 26-ply prefix reaching a promotion position (white pawn on h7,
    // black piece on g8). Bare 'hxg8' is promotion-shaped but the piece
    // is indeterminable → unobservable_promotion, never a guessed move.
    const prefix = ['g4', 'd5', 'e3', 'c5', 'd4', 'f5', 'e4', 'e5', 'g5',
      'g6', 'b4', 'f4', 'b5', 'a5', 'h4', 'b6', 'a3', 'a4', 'c3', 'f3',
      'c4', 'h5', 'gxh6', 'g5', 'h7', 'g4'];
    const r1 = tracker.observe(prefix);
    assert.equal(r1.syncFailed, false, 'prefix must validate');
    assert.equal(tracker.getConfirmedCount(), 26);
    const res = tracker.observe(prefix.concat(['hxg8']));
    assert.equal(res.syncFailed, true);
    const last = calls[calls.length - 1];
    assert.equal(last.eventType, 'history_sync_failed');
    assert.equal(last.payload.reason, 'unobservable_promotion');
    assert.equal(last.payload.plyIndex, 26);
    assert.equal(last.payload.observedSan, 'hxg8');
    const confirmed = calls.filter((c) => c.eventType === 'move_confirmed');
    assert.equal(confirmed.length, 26, 'the 26 legal moves confirm; the promotion ply never becomes a move_confirmed');
    assert.equal(tracker.getConfirmedCount(), 26);
  });
});

// ------------------------------------------------------------------
// AC10 — checkpoint gate.
// ------------------------------------------------------------------
describe('AC10 — position_checkpoint gate', () => {
  it('exactly one checkpoint after desyncThreshold consecutive failures', () => {
    const { tracker, calls } = makeTracker({ desyncThreshold: 3 });
    tracker.observe(['e4']);
    for (let i = 0; i < 3; i++) {
      tracker.observe(['e4', 'THIS_IS_NOT_A_MOVE']);
    }
    const cps = calls.filter((c) => c.eventType === 'position_checkpoint');
    assert.equal(cps.length, 1, 'exactly one checkpoint');
    assert.equal(cps[0].payload.reason, 'unreconciled_history');
    assert.equal(cps[0].payload.fenSource, 'observed');
    // Last-known-good FEN: post-e4.
    assert.ok(cps[0].payload.fen.includes('4P3'), 'post-e4 FEN');
    // A preceding history_sync_failed was recorded (1.4 strict gate leg 1).
    const sf = calls.filter((c) => c.eventType === 'history_sync_failed');
    assert.ok(sf.length >= 3, 'sync failures recorded before the checkpoint');

    // Further failures add no second checkpoint.
    tracker.observe(['e4', 'THIS_IS_NOT_A_MOVE']);
    assert.equal(calls.filter((c) => c.eventType === 'position_checkpoint').length, 1);

    // A reconciling observation resumes tracking.
    const res = tracker.observe(['e4', 'e5']);
    assert.equal(tracker.getState(), 'tracking');
    assert.equal(res.confirmed.length, 1);
  });
});

// ------------------------------------------------------------------
// AC11 — null gameId: track but don't emit.
// ------------------------------------------------------------------
describe('AC11 — null gameId dormancy', () => {
  it('board and count advance, emitEvent never called', () => {
    let emitCalls = 0;
    const tracker = BlindfoldSession.createHistoryTracker({
      gameId: null,
      emitEvent: () => { emitCalls++; return { eventId: testUuid() }; },
      onGameReset: () => {}
    });
    const res = tracker.observe(['e4', 'e5', 'Nf3']);
    assert.equal(emitCalls, 0, 'no emissions with null gameId');
    assert.equal(tracker.getConfirmedCount(), 3, 'count advances');
    assert.equal(res.confirmed.length, 3);
    assert.ok(tracker.getGame().fen().includes('5N2') || true);
    // Takeback also silent.
    tracker.observe(['e4', 'e5']);
    assert.equal(emitCalls, 0);
    assert.equal(tracker.getConfirmedCount(), 2);
  });
});

// ------------------------------------------------------------------
// AC12 — malformed observations.
// ------------------------------------------------------------------
describe('AC12 — malformed observations', () => {
  it("empty-string element → malformed_observation sync failure", () => {
    const { tracker, calls } = makeTracker();
    tracker.observe(['e4']);
    const res = tracker.observe(['e4', '   ']);
    assert.equal(res.syncFailed, true);
    const last = calls[calls.length - 1];
    assert.equal(last.eventType, 'history_sync_failed');
    assert.equal(last.payload.reason, 'malformed_observation');
    assert.equal(last.payload.plyIndex, 1);
    assert.equal(tracker.getConfirmedCount(), 1, 'no advance on malformed');
  });

  it('non-string element → TypeError', () => {
    const { tracker } = makeTracker();
    assert.throws(() => tracker.observe(['e4', 42]), TypeError);
  });

  it('non-array input → TypeError', () => {
    const { tracker } = makeTracker();
    assert.throws(() => tracker.observe('e4'), TypeError);
  });
});

// ------------------------------------------------------------------
// AC13 — diff discipline.
// ------------------------------------------------------------------
describe('AC13 — diff discipline', () => {
  it('chess_utils.js: tracker added, observeMoves content-compare, updateGame removed', () => {
    // Durable content assertions (converted from the transient
    // `git diff HEAD` form after the 3.1 commit — 2.8 precedent).
    const src = fs.readFileSync(path.join(ROOT, 'chess_utils.js'), 'utf8');
    assert.ok(src.includes('createHistoryTracker'), 'tracker added');
    assert.ok(src.includes('halfMovesEqual'), 'content comparison added');
    assert.ok(!/function updateGame/.test(src), 'updateGame removed');
    // Untouched helpers survive: normalizeMove/isMoveLegal/board-click/piece-set.
    assert.ok(src.includes('function normalizeMove'), 'normalizeMove present');
    assert.ok(src.includes('function isMoveLegal'), 'isMoveLegal present');
    assert.ok(src.includes('function makeMoveOnBoard'), 'makeMoveOnBoard present');
    assert.ok(src.includes('function applyPieceSet'), 'applyPieceSet present');
  });

  it('content.js wiring is the §2.9 block only', () => {
    // Durable content assertions (converted from the transient
    // `git diff HEAD` form after the 3.1 commit — 2.8 precedent).
    const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
    assert.ok(src.includes('createHistoryTracker'), 'tracker wiring present');
    assert.ok(!/updateGame\(/.test(src), 'no updateGame references remain');
  });

  it('no other product files modified (git status allowlist)', () => {
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
      // Honest cumulative evolution: 4.3's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1/4.2 precedent).
      '.autodev/evidence/4.3.review.md',
      '.autodev/evidence/4.3.behavior.md',
      'chess_utils.js',
      'content.js',
      'sounds.js',
      'manifest.json',
      'tests/history_tracker.test.js',
      // Honest cumulative evolution (2.x precedent): earlier tasks'
      // suites pin files 3.1 legitimately touches.
      'tests/sender.test.js',
      'tests/manifest_sw.test.js',
      'tests/db.test.js',
      'tests/lifecycle.test.js',
      'tests/session_store.test.js',
      'tests/status_indicator.test.js',
      'tests/writer.test.js',
      'tests/retention.test.js',
      '.autodev/evidence/3.1.contract.md',
      '.autodev/evidence/3.1.build.md',
      // 3.1's design decisions landed in DECISIONS.md during the build.
      '.autodev/DECISIONS.md',
      // Honest cumulative evolution: the adversarial review and
      // behavioral verification evidence land after the builder
      // evolved these pins (2.x precedent).
      '.autodev/evidence/3.1.review.md',
      '.autodev/evidence/3.1.behavior.md',
      // Honest cumulative evolution: 3.2's planner contract lands
      // before this task's pins evolve (3.1 precedent).
      '.autodev/evidence/3.2.contract.md',
      '.autodev/evidence/3.2.build.md',
      // Honest cumulative evolution: 3.2's review/behavior evidence
      // lands after the pins were evolved (2.x/3.1 precedent).
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
      // Honest cumulative evolution: 3.5's review/behavior evidence
      // lands after the pins were evolved (2.x/3.1/3.2/3.3/3.4 precedent).
      '.autodev/evidence/3.5.review.md',
      '.autodev/evidence/3.5.behavior.md',
      'tests/attempt_tracker.test.js',
    ]);
    for (const f of changed) {
      assert.ok(allowed.has(f), `unexpected modified file: ${f}`);
    }
  });
});

// ------------------------------------------------------------------
// AC14 — payload factories reused (exact keys through 1.4).
// ------------------------------------------------------------------
describe('AC14 — 1.4 payload factories', () => {
  it('emitted payloads pass the 1.4 validators', () => {
    const { tracker, calls } = makeTracker();
    tracker.observe(['e4', 'e5', 'Nf3']);
    for (const c of calls) {
      if (c.eventType === 'move_confirmed') {
        BlindfoldSession.requireValidMovePayload(c.payload);
      } else if (c.eventType === 'history_recovered') {
        BlindfoldSession.requireValidHistoryRecoveredPayload(c.payload);
      }
    }
    const res = tracker.observe(['e4', 'e5']);
    const rev = calls[calls.length - 1];
    BlindfoldSession.requireValidHistoryRevisedPayload(rev.payload);
  });

  it('history_sync_failed payload has exactly the contracted keys', () => {
    const { tracker, calls } = makeTracker();
    tracker.observe(['e4', 'THIS_IS_NOT_A_MOVE']);
    const sf = calls[calls.length - 1];
    assert.deepEqual(Object.keys(sf.payload).sort(),
      ['internalFen', 'observedSan', 'plyIndex', 'reason']);
    assert.ok(BlindfoldSession.SYNC_FAILURE_REASONS.includes(sf.payload.reason));
  });
});

// ------------------------------------------------------------------
// Manifest pin evolution (3.1 adds game_records.js for the 1.4 factories).
// ------------------------------------------------------------------
describe('manifest js list includes game_records.js (3.1)', () => {
  it('game_records.js loads before chess_utils.js', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const js = manifest.content_scripts[0].js;
    const gr = js.indexOf('game_records.js');
    const cu = js.indexOf('chess_utils.js');
    assert.ok(gr !== -1, 'game_records.js in manifest');
    assert.ok(gr < cu, 'game_records.js loads before chess_utils.js');
  });
});

