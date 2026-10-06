// tests/game_records.test.js
//
// V1 verification for task 1.4 (PLAN.md §1.4.1–§1.4.5) per
// .autodev/evidence/1.4.contract.md. Covers acceptance criteria
// AC1–AC14, AC16, AC18–AC19, AC21–AC23.
//
// Design/process criteria (documented, not mechanically verified):
// - AC13 (fold semantics): the contract pins revision fold semantics
//   declaratively (§2.5.2/§2.9) — this task ships NO stream-fold helper
//   (a reconstructor would be a PLAN-§1-excluded "reconstruction-test
//   interface"). The test below documents the fold in comments and
//   verifies revision construction never mutates the original
//   move_confirmed payloads (never-rewrite semantics).
// - AC15: marker-first ordering and never-rewrite semantics are
//   documented for §3.1 in the contract (§2.5) and the module header;
//   there is nothing in this task to delete or mutate (factories only).
// - AC17: the position_checkpoint strict gate is documented in the
//   module header (§2.6) and the contract; no code path in this task
//   emits checkpoints (emission is §3.1's). The gate must never be read
//   as permission for routine checkpoint use.
// - AC20: the 9 termination reasons are each PLAN/chess-rules grounded
//   (contract §2.7); unclassifiable endings are recorded as
//   terminationReason null + raw observedText, never stretched into a
//   category.
// - AC24: the vocabulary-table extension (contract §2.10.1) is a
//   coordinator process criterion; the test asserts the six event-type
//   constants and payload shapes are exactly as specified.
//
// Deferred (explicit dependencies — recorded, never claimed early):
// actual starting-FEN capture at game detection (→ §3.5.2/§5.x);
// DOM move observation and SAN→coordinate conversion (→ §3.1);
// batch/recovery marking in live reloads (→ §3.1/§2.7); game-end
// detection from Chess.com UI (→ §3.5.3); manual completion UI
// (→ §5.4/§3.5.4); envelope assembly with createEvent (→ §3.x);
// storage/appendSeq (→ §2.4); export denormalization (→ §6.1);
// §7.2/§7.4/§7.5 behavioral reconstruction (V3, real bot games).
//
// AC9 note: the vendored chess.min.js is required here ONLY as a
// test-time replay oracle (chess.js-derived SANs from starting FEN +
// MovePayloads). game_records.js itself never loads it — a static test
// below enforces that.
//
// Run: node --test tests/game_records.test.js   (from repo root)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const BlindfoldSession = require('../game_records.js');
// event_envelope.js is loaded at TEST time only for the vocabulary-syntax
// cross-check (all six 1.4 types must pass isEventType). The module under
// test reads no other module's exports at load time and stays
// load-order independent.
const Envelope = require('../event_envelope.js');
const SOURCE_PATH = path.join(REPO_ROOT, 'game_records.js');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

// Strip line and block comments so static checks see code tokens only.
const codeOnly = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const EP_FEN = 'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3';

// Deterministic UUID v4 fixtures (version nibble 4, variant nibble 8-b).
const ID14 = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const ID15 = 'b1f2a345-6c78-4d9e-8f01-23456789abcd';

describe('game_started — 1.4.1 (AC1–AC4)', () => {
  it('AC1: createGameStartedPayload returns exactly {fen} (one key)', () => {
    const p = BlindfoldSession.createGameStartedPayload({ fen: START_FEN });
    assert.deepEqual(p, { fen: START_FEN });
    assert.deepEqual(Object.keys(p), ['fen']);
    BlindfoldSession.requireValidGameStartedPayload(p);
  });

  it('AC1: accepts a mid-game FEN with an en-passant square', () => {
    const p = BlindfoldSession.createGameStartedPayload({ fen: EP_FEN });
    assert.equal(p.fen, EP_FEN);
  });

  it('AC4: payload is frozen and survives a JSON round-trip', () => {
    const p = BlindfoldSession.createGameStartedPayload({ fen: START_FEN });
    assert.ok(Object.isFrozen(p));
    assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
  });

  it('AC4: GAME_STARTED_EVENT_TYPE passes isEventType', () => {
    assert.equal(BlindfoldSession.GAME_STARTED_EVENT_TYPE, 'game_started');
    assert.ok(Envelope.isEventType(BlindfoldSession.GAME_STARTED_EVENT_TYPE));
  });

  it('AC1: malformed inputs are rejected', () => {
    assert.throws(() => BlindfoldSession.createGameStartedPayload(null), TypeError);
    assert.throws(() => BlindfoldSession.createGameStartedPayload('nope'), TypeError);
    assert.throws(() => BlindfoldSession.createGameStartedPayload({}), TypeError);
    assert.throws(() => BlindfoldSession.createGameStartedPayload({ fen: 'bad' }), RangeError);
    // Factories build a fresh record from whitelisted fields (the 1.1/1.3
    // convention, e.g. createClockAnchor) — unknown input keys are ignored,
    // never recorded. (1.2's createInitialConditions instead rejects extra
    // input keys — a documented 1.2 deviation; lenient-on-input/strict-on-
    // record is the majority convention.) The validator rejects extra keys
    // on the record itself.
    const extra = BlindfoldSession.createGameStartedPayload({ fen: START_FEN, extra: 1 });
    assert.deepEqual(extra, { fen: START_FEN });
    assert.throws(
      () => BlindfoldSession.requireValidGameStartedPayload({ fen: START_FEN, extra: 1 }),
      TypeError
    );
  });

  it('SF-2: factories trim-and-store FENs (no whitespace-padded records)', () => {
    const padded = '  ' + START_FEN + '  ';
    const gs = BlindfoldSession.createGameStartedPayload({ fen: padded });
    assert.strictEqual(gs.fen, START_FEN, 'game_started stored dirty FEN');
    const cp = BlindfoldSession.createPositionCheckpointPayload({
      fen: padded, reason: 'unreconciled_history', fenSource: 'manual'
    });
    assert.strictEqual(cp.fen, START_FEN, 'position_checkpoint stored dirty FEN');
  });
});

describe('isFen / requireValidFen — structural only (AC2, AC3)', () => {
  const valid = [
    START_FEN,
    EP_FEN,
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    '8/2P5/8/8/8/1k6/8/4K3 w - - 0 1',
    'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4'
  ];
  for (const fen of valid) {
    it(`AC2: accepts ${fen.slice(0, 24)}…`, () => {
      assert.equal(BlindfoldSession.isFen(fen), true);
      BlindfoldSession.requireValidFen(fen);
    });
  }

  const malformed = [123, null, undefined, {}, [], true, ''];
  for (const v of malformed) {
    it(`AC2: isFen(${JSON.stringify(v)}) is false`, () => {
      assert.equal(BlindfoldSession.isFen(v), false);
    });
    it(`AC2: requireValidFen(${JSON.stringify(v)}) throws TypeError`, () => {
      assert.throws(() => BlindfoldSession.requireValidFen(v), TypeError);
    });
  }

  it('AC2: whitespace-only string throws TypeError (malformed input)', () => {
    assert.equal(BlindfoldSession.isFen('   '), false);
    assert.throws(() => BlindfoldSession.requireValidFen('   '), TypeError);
  });

  const structural = {
    'seven ranks': 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1',
    'nine ranks': 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR/8 w KQkq - 0 1',
    'rank sums to 6': 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKB w KQkq - 0 1',
    'rank sums to 9': 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNRQ w KQkq - 0 1',
    'invalid piece char': 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNX w KQkq - 0 1',
    'digit 9 in rank': 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/9 w KQkq - 0 1',
    'bad side to move': 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1',
    'bad castling field': 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQQ - 0 1',
    'bad ep square chars': 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq z9 0 1',
    'bad ep square rank': 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e4 0 1',
    'ep/side inconsistency (w, rank 3)': 'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d3 0 3',
    'ep/side inconsistency (b, rank 6)': 'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR b KQkq d6 0 3',
    'negative halfmove clock': 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - -1 1',
    'zero fullmove number': 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 0',
    'negative fullmove number': 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 -1',
    'five fields': 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0',
    'consecutive digits in rank': 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQK11R w KQkq - 0 1'
  };
  for (const [label, fen] of Object.entries(structural)) {
    it(`AC2: rejects ${label} with RangeError`, () => {
      assert.equal(BlindfoldSession.isFen(fen), false);
      assert.throws(() => BlindfoldSession.requireValidFen(fen), RangeError);
    });
  }

  it('AC3: structurally valid but chess-impossible FEN is ACCEPTED ' +
     '(no legality check; observations are preserved, not refereed — contract §2.2)', () => {
    // Seventeen queens, no kings, nobody in check that matters: parseable,
    // impossible. A legality-refusing validator would destroy this evidence.
    const impossible = 'QQQQQQQQ/1QQQQQQQ/8/8/8/8/8/8 w - - 0 1';
    assert.equal(BlindfoldSession.isFen(impossible), true);
    BlindfoldSession.requireValidFen(impossible);
    const p = BlindfoldSession.createGameStartedPayload({ fen: impossible });
    assert.equal(p.fen, impossible);
  });
});

describe('move_confirmed — 1.4.2 (AC5–AC10)', () => {
  it('AC5: createMovePayload returns exactly {from, to, promotion}; promotion defaults to null', () => {
    const p = BlindfoldSession.createMovePayload({ from: 'e2', to: 'e4' });
    assert.deepEqual(p, { from: 'e2', to: 'e4', promotion: null });
    assert.deepEqual(Object.keys(p), ['from', 'to', 'promotion']);
    assert.ok(Object.isFrozen(p));
  });

  it('AC5: explicit promotion values are preserved', () => {
    const p = BlindfoldSession.createMovePayload({ from: 'c7', to: 'c8', promotion: 'q' });
    assert.equal(p.promotion, 'q');
  });

  it('AC4/AC23: MOVE_CONFIRMED_EVENT_TYPE passes isEventType', () => {
    assert.equal(BlindfoldSession.MOVE_CONFIRMED_EVENT_TYPE, 'move_confirmed');
    assert.ok(Envelope.isEventType(BlindfoldSession.MOVE_CONFIRMED_EVENT_TYPE));
  });

  it('AC6: square validation', () => {
    for (const sq of ['e2', 'a1', 'h8']) {
      assert.equal(BlindfoldSession.isSquare(sq), true, sq);
    }
    for (const sq of ['e9', 'i1', 'E2', '', 'e', 'e22']) {
      assert.equal(BlindfoldSession.isSquare(sq), false, sq);
    }
    assert.equal(BlindfoldSession.isSquare(12), false);
    assert.equal(BlindfoldSession.isSquare(null), false);
    assert.throws(
      () => BlindfoldSession.createMovePayload({ from: 'e9', to: 'e4' }),
      RangeError
    );
    assert.throws(
      () => BlindfoldSession.createMovePayload({ from: 12, to: 'e4' }),
      TypeError
    );
  });

  it('AC6: from === to throws RangeError (a move cannot start and end on one square)', () => {
    assert.throws(
      () => BlindfoldSession.createMovePayload({ from: 'e2', to: 'e2' }),
      RangeError
    );
  });

  it('AC7: promotion validation — null/q/r/b/n pass', () => {
    assert.equal(BlindfoldSession.isPromotion(null), true);
    for (const piece of ['q', 'r', 'b', 'n']) {
      assert.equal(BlindfoldSession.isPromotion(piece), true, piece);
      const p = BlindfoldSession.createMovePayload({ from: 'a7', to: 'a8', promotion: piece });
      assert.equal(p.promotion, piece);
    }
  });

  it('AC7: undefined promotion throws TypeError (explicit-null convention)', () => {
    assert.equal(BlindfoldSession.isPromotion(undefined), false);
    assert.throws(
      () => BlindfoldSession.createMovePayload({ from: 'a7', to: 'a8', promotion: undefined }),
      TypeError
    );
  });

  it('AC7: other promotion values throw RangeError', () => {
    for (const piece of ['Q', 'p', 'k', '']) {
      assert.equal(BlindfoldSession.isPromotion(piece), false, JSON.stringify(piece));
      assert.throws(
        () => BlindfoldSession.createMovePayload({ from: 'a7', to: 'a8', promotion: piece }),
        RangeError
      );
    }
  });

  it('AC8: no timestamp fields exist on the payload (exactly 3 keys)', () => {
    const p = BlindfoldSession.createMovePayload({ from: 'e2', to: 'e4', promotion: null });
    assert.deepEqual(Object.keys(p).sort(), ['from', 'promotion', 'to']);
    // The observation timestamp is the 1.3 envelope's (clockSegmentId,
    // monotonicMs) — nothing time-shaped may be smuggled into payloads.
    for (const key of Object.keys(p)) {
      assert.ok(!/time|date|clock|stamp|ms|seq/i.test(key), 'time-shaped key: ' + key);
    }
  });

  it('AC8/AC10: every 1.4 payload creator emits zero time/derived keys', () => {
    const payloads = [
      BlindfoldSession.createGameStartedPayload({ fen: START_FEN }),
      BlindfoldSession.createMovePayload({ from: 'e2', to: 'e4' }),
      BlindfoldSession.createHistoryRecoveredPayload({ recoveryReason: 'page_reload', expectedMoveCount: 3 }),
      BlindfoldSession.createHistoryRevisedPayload({
        revisionKind: 'takeback',
        retractedMoveEventIds: [ID14, ID15],
        observedHistoryLength: 13,
        expectedMoveCount: 0
      }),
      BlindfoldSession.createPositionCheckpointPayload({ fen: START_FEN, reason: 'unreconciled_history', fenSource: 'observed' }),
      BlindfoldSession.createGameEndedPayload({ result: '1-0', terminationReason: 'checkmate', evidenceSource: 'observed', observedText: 'White won by checkmate' })
    ];
    for (const p of payloads) {
      for (const key of Object.keys(p)) {
        assert.ok(!/time|date|clock|stamp|ms|seq|number/i.test(key), 'time/derived key: ' + key);
      }
    }
  });

  it('AC10: no moveNumber, san, or per-move FEN anywhere in the module (static)', () => {
    // "san" is matched as an identifier, not inside words; comments are
    // already stripped (the header discusses why SAN is excluded).
    assert.ok(!/\bsan\b/i.test(codeOnly), 'found a san reference in code');
    assert.ok(!/\bmoveNumber\b/.test(codeOnly), 'found a moveNumber reference in code');
    assert.ok(!/\bpayloadFen\b|\bmoveFen\b|\bafterFen\b/i.test(codeOnly), 'found a per-move FEN reference');
  });

  it('AC9: chess.js replay oracle (TEST-ONLY): starting FEN + MovePayloads ' +
     'replay with zero illegal-move rejections, incl. castling, promotion, en passant', () => {
    // The vendored chess.js is a test-only oracle here: it proves the
    // record shape (starting FEN + confirmed coordinate moves) suffices
    // for reconstruction (§7.2 groundwork) without shipping a reconstructor.
    const Chess = require('../chess.min.js').Chess;

    const game = new Chess();
    const script = [
      ['e2', 'e4', null, 'e4'],
      ['e7', 'e5', null, 'e5'],
      ['g1', 'f3', null, 'Nf3'],
      ['b8', 'c6', null, 'Nc6'],
      ['f1', 'c4', null, 'Bc4'],
      ['f8', 'c5', null, 'Bc5'],
      ['e1', 'g1', null, 'O-O'] // kingside castling: king's from/to
    ];
    const moves = script.map(([from, to, promotion]) =>
      BlindfoldSession.createMovePayload({ from, to, promotion })
    );
    const applied = [];
    for (const m of moves) {
      const result = game.move({ from: m.from, to: m.to, promotion: m.promotion });
      assert.ok(result, `chess.js rejected a legal move: ${m.from}→${m.to}`);
      applied.push(result.san);
    }
    assert.deepEqual(applied, script.map(s => s[3]));

    // Queenside castling.
    const qside = new Chess();
    const qscript = [
      ['d2', 'd4', null, 'd4'], ['d7', 'd5', null, 'd5'],
      ['c1', 'f4', null, 'Bf4'], ['c8', 'f5', null, 'Bf5'],
      ['d1', 'd2', null, 'Qd2'], ['d8', 'd7', null, 'Qd7'],
      ['b1', 'c3', null, 'Nc3'], ['b8', 'c6', null, 'Nc6'],
      ['e1', 'c1', null, 'O-O-O']
    ];
    for (const [from, to, promotion, san] of qscript) {
      const m = BlindfoldSession.createMovePayload({ from, to, promotion });
      const result = qside.move({ from: m.from, to: m.to, promotion: m.promotion });
      assert.ok(result, `chess.js rejected a legal move: ${from}→${to}`);
      assert.equal(result.san, san);
    }

    // Promotion (lowercase piece in the payload, matching the chess.js
    // verbose-move encoding).
    const promo = new Chess('8/2P5/8/8/8/1k6/8/4K3 w - - 0 1');
    const pm = BlindfoldSession.createMovePayload({ from: 'c7', to: 'c8', promotion: 'q' });
    const pr = promo.move({ from: pm.from, to: pm.to, promotion: pm.promotion });
    assert.ok(pr);
    assert.equal(pr.san, 'c8=Q');

    // En passant (pawn's from/to).
    const ep = new Chess(EP_FEN);
    const em = BlindfoldSession.createMovePayload({ from: 'e5', to: 'd6' });
    const er = ep.move({ from: em.from, to: em.to, promotion: em.promotion });
    assert.ok(er);
    assert.equal(er.san, 'exd6');
  });
});

describe('history_recovered — 1.4.3 (AC11)', () => {
  it('AC11: createHistoryRecoveredPayload returns exactly {recoveryReason, expectedMoveCount}', () => {
    const p = BlindfoldSession.createHistoryRecoveredPayload({
      recoveryReason: 'page_reload',
      expectedMoveCount: 3
    });
    assert.deepEqual(p, { recoveryReason: 'page_reload', expectedMoveCount: 3 });
    assert.ok(Object.isFrozen(p));
    BlindfoldSession.requireValidHistoryRecoveredPayload(p);
  });

  it('AC11: expectedMoveCount 0 is legal (recovery observed, stream verified complete)', () => {
    const p = BlindfoldSession.createHistoryRecoveredPayload({
      recoveryReason: 'late_attachment',
      expectedMoveCount: 0
    });
    assert.equal(p.expectedMoveCount, 0);
  });

  it('AC11: reasons outside the closed vocabulary throw RangeError; non-strings throw TypeError', () => {
    assert.throws(
      () => BlindfoldSession.createHistoryRecoveredPayload({ recoveryReason: 'crash', expectedMoveCount: 1 }),
      RangeError
    );
    assert.throws(
      () => BlindfoldSession.createHistoryRecoveredPayload({ recoveryReason: 5, expectedMoveCount: 1 }),
      TypeError
    );
    assert.throws(
      () => BlindfoldSession.createHistoryRecoveredPayload({ recoveryReason: 'page_reload', expectedMoveCount: -1 }),
      RangeError
    );
    assert.throws(
      () => BlindfoldSession.createHistoryRecoveredPayload({ recoveryReason: 'page_reload', expectedMoveCount: 1.5 }),
      RangeError
    );
    assert.throws(
      () => BlindfoldSession.createHistoryRecoveredPayload({ recoveryReason: 'page_reload', expectedMoveCount: '3' }),
      TypeError
    );
  });
});

describe('history_revised — 1.4.3 (AC12, AC13, AC14)', () => {
  function makeTakeback() {
    return BlindfoldSession.createHistoryRevisedPayload({
      revisionKind: 'takeback',
      retractedMoveEventIds: [ID14, ID15],
      observedHistoryLength: 13,
      expectedMoveCount: 0
    });
  }

  it('AC12: createHistoryRevisedPayload returns exactly the 4-key shape', () => {
    const p = makeTakeback();
    assert.deepEqual(Object.keys(p).sort(), [
      'expectedMoveCount', 'observedHistoryLength', 'retractedMoveEventIds', 'revisionKind'
    ]);
    assert.deepEqual(p.retractedMoveEventIds, [ID14, ID15]);
    assert.equal(p.observedHistoryLength, 13);
    assert.equal(p.expectedMoveCount, 0);
    assert.ok(Object.isFrozen(p));
    assert.ok(Object.isFrozen(p.retractedMoveEventIds));
    BlindfoldSession.requireValidHistoryRevisedPayload(p);
  });

  it('AC12: revisionKind outside the vocabulary throws RangeError; non-string throws TypeError', () => {
    const base = {
      revisionKind: 'undo',
      retractedMoveEventIds: [ID14],
      observedHistoryLength: 13,
      expectedMoveCount: 0
    };
    assert.throws(() => BlindfoldSession.createHistoryRevisedPayload(base), RangeError);
    assert.throws(
      () => BlindfoldSession.createHistoryRevisedPayload(Object.assign({}, base, { revisionKind: 7 })),
      TypeError
    );
  });

  it('AC12: retractedMoveEventIds shape errors', () => {
    const base = {
      revisionKind: 'takeback',
      retractedMoveEventIds: [ID14],
      observedHistoryLength: 13,
      expectedMoveCount: 0
    };
    // Not an array, empty array, malformed UUID, non-string element → TypeError.
    for (const bad of ['nope', [], ['not-a-uuid'], [123], [null]]) {
      assert.throws(
        () => BlindfoldSession.createHistoryRevisedPayload(
          Object.assign({}, base, { retractedMoveEventIds: bad })
        ),
        TypeError,
        JSON.stringify(bad)
      );
    }
    // Duplicates → RangeError (uniqueness domain violation).
    assert.throws(
      () => BlindfoldSession.createHistoryRevisedPayload(
        Object.assign({}, base, { retractedMoveEventIds: [ID14, ID14] })
      ),
      RangeError
    );
  });

  it('AC12: caller-side array is defensively copied (no aliasing)', () => {
    const ids = [ID14, ID15];
    const p = BlindfoldSession.createHistoryRevisedPayload({
      revisionKind: 'takeback',
      retractedMoveEventIds: ids,
      observedHistoryLength: 13,
      expectedMoveCount: 0
    });
    ids.push('x');
    assert.deepEqual(p.retractedMoveEventIds, [ID14, ID15]);
  });

  it('AC12: observedHistoryLength / expectedMoveCount must be integers >= 0', () => {
    const base = {
      revisionKind: 'takeback',
      retractedMoveEventIds: [ID14],
      expectedMoveCount: 0
    };
    assert.throws(
      () => BlindfoldSession.createHistoryRevisedPayload(
        Object.assign({}, base, { observedHistoryLength: -1 })
      ),
      RangeError
    );
    assert.throws(
      () => BlindfoldSession.createHistoryRevisedPayload(
        Object.assign({}, base, { observedHistoryLength: '13' })
      ),
      TypeError
    );
  });

  it('AC13: takeback example validates (list shrank 15→13: retract last two, no replacements)', () => {
    // Fold semantics (declarative — no fold helper exists in this task, §2.9):
    // current move list = confirmed moves in occurrence order, MINUS any
    // eventId named in any history_revised.retractedMoveEventIds, PLUS
    // replacement moves (ref-linked via revisionEventId) in occurrence
    // order. Retraction is monotonic: a retracted event ID is never
    // un-retracted. The original move_confirmed events stay in the stream;
    // reconstruction = FEN₀ + moves 1…13.
    const p = makeTakeback();
    BlindfoldSession.requireValidHistoryRevisedPayload(p);
  });

  it('AC13: same-length correction validates (suffix retraction + replacements)', () => {
    // Ply 7 changed in a 20-ply list: moves 8…20 were converted through
    // the old board state, so the suffix id7…id20 is retracted and 14
    // replacement move_confirmed events (expectedMoveCount: 14) follow,
    // each carrying refs { revisionEventId: <marker eventId> }.
    const suffixIds = [];
    for (let i = 0; i < 14; i++) {
      suffixIds.push('00000000-0000-4000-8000-' + String(7 + i).padStart(12, '0'));
    }
    const p = BlindfoldSession.createHistoryRevisedPayload({
      revisionKind: 'correction',
      retractedMoveEventIds: suffixIds,
      observedHistoryLength: 20,
      expectedMoveCount: 14
    });
    BlindfoldSession.requireValidHistoryRevisedPayload(p);
  });

  it('AC13: revision construction never mutates the original move_confirmed payloads', () => {
    // Marker-first, never-rewrite: revision factories only build marker
    // records; the contradicted move_confirmed events pass through
    // untouched (no mutation — §2.5.2).
    const m1 = BlindfoldSession.createMovePayload({ from: 'e2', to: 'e4' });
    const m2 = BlindfoldSession.createMovePayload({ from: 'e7', to: 'e5' });
    const before1 = JSON.parse(JSON.stringify(m1));
    const before2 = JSON.parse(JSON.stringify(m2));
    makeTakeback(); // constructing the revision marker
    assert.deepEqual(JSON.parse(JSON.stringify(m1)), before1);
    assert.deepEqual(JSON.parse(JSON.stringify(m2)), before2);
    assert.ok(Object.isFrozen(m1));
    assert.ok(Object.isFrozen(m2));
  });

  it('AC14: recoveryEventId and revisionEventId satisfy the 1.3 role pattern; no other roles invented', () => {
    // 1.4 defines exactly two refs roles (contract §2.5.3, fulfills 1.3 AC20):
    // recoveryEventId → their history_recovered marker; revisionEventId →
    // their history_revised marker. Both match /^[a-z][a-zA-Z0-9]*Id$/.
    const REF_ROLE_RE = /^[a-z][a-zA-Z0-9]*Id$/;
    assert.ok(REF_ROLE_RE.test('recoveryEventId'));
    assert.ok(REF_ROLE_RE.test('revisionEventId'));
    assert.deepEqual(BlindfoldSession.RECOVERY_REASONS, ['page_reload', 'late_attachment']);
    assert.deepEqual(BlindfoldSession.REVISION_KINDS, ['takeback', 'correction']);
    // No other EventId-suffixed identifier appears anywhere in the module.
    const tokens = new Set((source.match(/\b[a-z][a-zA-Z0-9]*EventId\b/g) || []));
    assert.deepEqual([...tokens].sort(), ['recoveryEventId', 'revisionEventId']);
  });

  it('HISTORY_RECOVERED/HISTORY_REVISED types pass isEventType', () => {
    assert.equal(BlindfoldSession.HISTORY_RECOVERED_EVENT_TYPE, 'history_recovered');
    assert.equal(BlindfoldSession.HISTORY_REVISED_EVENT_TYPE, 'history_revised');
    assert.ok(Envelope.isEventType(BlindfoldSession.HISTORY_RECOVERED_EVENT_TYPE));
    assert.ok(Envelope.isEventType(BlindfoldSession.HISTORY_REVISED_EVENT_TYPE));
  });
});

describe('position_checkpoint — 1.4.4 (AC16)', () => {
  it('AC16: createPositionCheckpointPayload returns exactly {fen, reason, fenSource}', () => {
    const p = BlindfoldSession.createPositionCheckpointPayload({
      fen: EP_FEN,
      reason: 'unreconciled_history',
      fenSource: 'observed'
    });
    assert.deepEqual(p, { fen: EP_FEN, reason: 'unreconciled_history', fenSource: 'observed' });
    assert.ok(Object.isFrozen(p));
    BlindfoldSession.requireValidPositionCheckpointPayload(p);
  });

  it('AC16: reason outside [unreconciled_history] throws RangeError; fenSource outside observed/manual throws RangeError', () => {
    const base = { fen: START_FEN, reason: 'unreconciled_history', fenSource: 'observed' };
    assert.throws(
      () => BlindfoldSession.createPositionCheckpointPayload(
        Object.assign({}, base, { reason: 'convenience' })
      ),
      RangeError
    );
    assert.throws(
      () => BlindfoldSession.createPositionCheckpointPayload(
        Object.assign({}, base, { fenSource: 'auto' })
      ),
      RangeError
    );
    assert.throws(
      () => BlindfoldSession.createPositionCheckpointPayload(
        Object.assign({}, base, { reason: 7 })
      ),
      TypeError
    );
  });

  it('AC16: fen is validated by requireValidFen', () => {
    const base = { reason: 'unreconciled_history', fenSource: 'observed' };
    assert.throws(
      () => BlindfoldSession.createPositionCheckpointPayload(
        Object.assign({}, base, { fen: 'not-a-fen' })
      ),
      RangeError
    );
    assert.throws(
      () => BlindfoldSession.createPositionCheckpointPayload(
        Object.assign({}, base, { fen: null })
      ),
      TypeError
    );
  });

  it('AC16: POSITION_CHECKPOINT_EVENT_TYPE passes isEventType', () => {
    assert.equal(BlindfoldSession.POSITION_CHECKPOINT_EVENT_TYPE, 'position_checkpoint');
    assert.ok(Envelope.isEventType(BlindfoldSession.POSITION_CHECKPOINT_EVENT_TYPE));
  });

  // AC17 (design criterion): the strict gate — (1) a synchronization
  // failure observed AND recorded (3.1.7), (2) genuinely unbridgeable gap
  // (replay from game_started FEN and from the last checkpoint both fail),
  // (3) emitter can state a current-position FEN without inventing it —
  // is documented in the module header. No code path in this task emits
  // checkpoints (emission is §3.1's), and exports containing a checkpoint
  // must surface it in §6.1 coverage as a defect flag. Reviewer confirms
  // the gate cannot be read as permission for routine use.
  it('AC17: strict gate is documented in the module header', () => {
    assert.ok(source.includes('STRICT GATE'), 'module header must document the strict gate');
    assert.ok(source.includes('recorded (3.1.7)'), 'gate must cite the recorded-sync-failure rule');
  });
});

describe('game_ended — 1.4.5 (AC18, AC19)', () => {
  it('AC18: createGameEndedPayload returns exactly the 4-key shape', () => {
    const p = BlindfoldSession.createGameEndedPayload({
      result: '1-0',
      terminationReason: 'checkmate',
      evidenceSource: 'observed',
      observedText: 'White won by checkmate'
    });
    assert.deepEqual(p, {
      result: '1-0',
      terminationReason: 'checkmate',
      evidenceSource: 'observed',
      observedText: 'White won by checkmate'
    });
    assert.ok(Object.isFrozen(p));
    BlindfoldSession.requireValidGameEndedPayload(p);
  });

  it('AC18: result outside the PGN vocabulary throws RangeError; null result throws TypeError', () => {
    const base = { terminationReason: 'checkmate', evidenceSource: 'observed', observedText: null };
    assert.throws(
      () => BlindfoldSession.createGameEndedPayload(Object.assign({ result: '2-0' }, base)),
      RangeError
    );
    assert.throws(
      () => BlindfoldSession.createGameEndedPayload(Object.assign({ result: null }, base)),
      TypeError
    );
    assert.deepEqual(BlindfoldSession.GAME_RESULTS, ['1-0', '0-1', '1/2-1/2', '*']);
  });

  it('AC18: null terminationReason + "*" result is the valid unknown-ending record', () => {
    const p = BlindfoldSession.createGameEndedPayload({
      result: '*',
      terminationReason: null,
      evidenceSource: 'observed',
      observedText: 'Game ended'
    });
    assert.equal(p.terminationReason, null);
    assert.equal(p.result, '*');
    BlindfoldSession.requireValidGameEndedPayload(p);
  });

  it('AC18: terminationReason outside the 9-value vocabulary throws RangeError (AC20: no invented taxonomy)', () => {
    // The 9 reasons are each PLAN/chess-rules grounded (contract §2.7):
    // chess-rules endings plus Chess.com-observed endings ('resignation'/
    // 'abandoned' from 3.5.4; 'timeout'/draw variants from 3.5.3). Anything
    // unclassifiable is null + raw observedText, never a stretched category.
    assert.deepEqual(BlindfoldSession.TERMINATION_REASONS, [
      'checkmate', 'stalemate', 'resignation', 'timeout', 'draw_agreed',
      'draw_insufficient_material', 'draw_fifty_move', 'draw_threefold', 'abandoned'
    ]);
    const base = { result: '1/2-1/2', evidenceSource: 'observed', observedText: 'Draw?' };
    assert.throws(
      () => BlindfoldSession.createGameEndedPayload(
        Object.assign({ terminationReason: 'draw_claimed' }, base)
      ),
      RangeError
    );
    assert.throws(
      () => BlindfoldSession.createGameEndedPayload(
        Object.assign({ terminationReason: 3 }, base)
      ),
      TypeError
    );
    // undefined is a shape error (explicit-null convention).
    assert.throws(
      () => BlindfoldSession.createGameEndedPayload(
        Object.assign({ terminationReason: undefined }, base)
      ),
      TypeError
    );
  });

  it('AC18: evidenceSource outside observed/manual throws RangeError', () => {
    const base = { result: '1-0', terminationReason: 'checkmate', observedText: null };
    assert.throws(
      () => BlindfoldSession.createGameEndedPayload(
        Object.assign({ evidenceSource: 'auto' }, base)
      ),
      RangeError
    );
  });

  it('AC18: observedText is string-or-null; empty normalizes to null (1.1/1.2 convention)', () => {
    const base = { result: '1-0', terminationReason: 'checkmate', evidenceSource: 'observed' };
    const empty = BlindfoldSession.createGameEndedPayload(
      Object.assign({ observedText: '' }, base)
    );
    assert.equal(empty.observedText, null);
    const blank = BlindfoldSession.createGameEndedPayload(
      Object.assign({ observedText: '   ' }, base)
    );
    assert.equal(blank.observedText, null);
    const raw = BlindfoldSession.createGameEndedPayload(
      Object.assign({ observedText: 'White won by resignation' }, base)
    );
    assert.equal(raw.observedText, 'White won by resignation'); // raw evidence preserved
    assert.throws(
      () => BlindfoldSession.createGameEndedPayload(
        Object.assign({ observedText: 42 }, base)
      ),
      TypeError
    );
    // The validator rejects whitespace-only strings that bypass create().
    assert.throws(
      () => BlindfoldSession.requireValidGameEndedPayload(
        Object.assign({ result: '1-0', terminationReason: null, evidenceSource: 'observed', observedText: '  ' })
      ),
      TypeError
    );
  });

  it('AC19: manual completion case validates (3.5.4 Stop-time path)', () => {
    const p = BlindfoldSession.createGameEndedPayload({
      result: '*',
      terminationReason: 'abandoned',
      evidenceSource: 'manual',
      observedText: null
    });
    assert.deepEqual(p, {
      result: '*',
      terminationReason: 'abandoned',
      evidenceSource: 'manual',
      observedText: null
    });
    BlindfoldSession.requireValidGameEndedPayload(p);
  });

  it('AC18: optional fields default (terminationReason → null, observedText → null)', () => {
    const p = BlindfoldSession.createGameEndedPayload({
      result: '0-1',
      evidenceSource: 'observed'
    });
    assert.equal(p.terminationReason, null);
    assert.equal(p.observedText, null);
  });

  it('GAME_ENDED_EVENT_TYPE passes isEventType', () => {
    assert.equal(BlindfoldSession.GAME_ENDED_EVENT_TYPE, 'game_ended');
    assert.ok(Envelope.isEventType(BlindfoldSession.GAME_ENDED_EVENT_TYPE));
  });
});

describe('cross-cutting (AC21–AC23)', () => {
  it('AC21: 1.1/1.2/1.3 modules byte-identical to HEAD (2.6 export lines committed; 2.7 touches none)', () => {
    // Honest cumulative evolution: the 2.6 "only the export lines" pin
    // was transient (it could only pass pre-commit against the working
    // tree). 2.6 is committed, so the durable invariant is that later
    // tasks leave the Section-1 modules untouched.
    for (const f of ['session_identity.js', 'session_conditions.js',
                     'event_envelope.js']) {
      execSync(`git diff --exit-code -- ${f}`, { cwd: REPO_ROOT, stdio: 'pipe' });
    }
  });

  it('AC22: plain script — no import/export statements', () => {
    assert.ok(!/^\s*(import|export)\b/m.test(source), 'found an import/export statement');
  });

  it('AC22: no chrome.* references', () => {
    assert.ok(!/chrome\./.test(source), 'found a chrome.* reference');
  });

  it('AC22: no Math.random', () => {
    assert.ok(!/Math\.random/.test(source), 'found Math.random usage');
  });

  it('AC22: no load-time chess.js dependency (no require calls, no Chess constructor use)', () => {
    assert.ok(!/\brequire\s*\(/.test(codeOnly), 'found a require() call in the module');
    assert.ok(!/\bnew Chess\b/.test(codeOnly), 'found a Chess constructor use in the module');
    assert.ok(!/\.Chess\b/.test(codeOnly), 'found a .Chess reference in the module');
    assert.ok(!/\bChess\s*\(/.test(codeOnly), 'found a Chess() call in the module');
  });

  it('AC22: exactly one guarded global, shared with the existing modules', () => {
    const matches = source.match(/var BlindfoldSession = BlindfoldSession \|\| \{\};/g) || [];
    assert.equal(matches.length, 1, 'expected exactly one guarded global declaration');
    for (const f of ['session_identity.js', 'session_conditions.js', 'event_envelope.js']) {
      const other = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
      assert.ok(
        /var BlindfoldSession = BlindfoldSession \|\| \{\};/.test(other),
        f + ' does not share the guarded global'
      );
    }
  });

  it('AC22: module pattern — IIFE, use strict, Node shim', () => {
    assert.ok(/\(function\s*\(\)\s*\{/.test(source), 'missing IIFE');
    assert.ok(/'use strict'/.test(source), "missing 'use strict'");
    assert.ok(/module\.exports = BlindfoldSession;/.test(source), 'missing Node module.exports shim');
  });

  it('AC23: all payload shapes are plain-JSON / round-trip safe', () => {
    const payloads = [
      BlindfoldSession.createGameStartedPayload({ fen: START_FEN }),
      BlindfoldSession.createMovePayload({ from: 'e2', to: 'e4' }),
      BlindfoldSession.createMovePayload({ from: 'c7', to: 'c8', promotion: 'q' }),
      BlindfoldSession.createHistoryRecoveredPayload({ recoveryReason: 'page_reload', expectedMoveCount: 3 }),
      BlindfoldSession.createHistoryRevisedPayload({
        revisionKind: 'correction',
        retractedMoveEventIds: [ID14, ID15],
        observedHistoryLength: 20,
        expectedMoveCount: 14
      }),
      BlindfoldSession.createPositionCheckpointPayload({
        fen: EP_FEN, reason: 'unreconciled_history', fenSource: 'manual'
      }),
      BlindfoldSession.createGameEndedPayload({
        result: '*', terminationReason: null, evidenceSource: 'manual', observedText: null
      })
    ];
    for (const p of payloads) {
      assert.ok(Object.isFrozen(p), 'payload not frozen: ' + JSON.stringify(p));
      assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
    }
  });

  it('AC23: all six event types pass isEventType (contract §2.10.1 vocabulary table)', () => {
    // AC24 (process): the vocabulary-table extension is a coordinator
    // checklist item; this asserts the table rows the contract specifies.
    const types = [
      BlindfoldSession.GAME_STARTED_EVENT_TYPE,
      BlindfoldSession.MOVE_CONFIRMED_EVENT_TYPE,
      BlindfoldSession.HISTORY_RECOVERED_EVENT_TYPE,
      BlindfoldSession.HISTORY_REVISED_EVENT_TYPE,
      BlindfoldSession.POSITION_CHECKPOINT_EVENT_TYPE,
      BlindfoldSession.GAME_ENDED_EVENT_TYPE
    ];
    assert.deepEqual(types, [
      'game_started', 'move_confirmed', 'history_recovered',
      'history_revised', 'position_checkpoint', 'game_ended'
    ]);
    for (const t of types) {
      assert.ok(Envelope.isEventType(t), t + ' fails isEventType');
    }
  });

  it('AC23: vocabulary constants are frozen arrays with exact contents', () => {
    const expected = {
      RECOVERY_REASONS: ['page_reload', 'late_attachment'],
      REVISION_KINDS: ['takeback', 'correction'],
      CHECKPOINT_REASONS: ['unreconciled_history'],
      GAME_RESULTS: ['1-0', '0-1', '1/2-1/2', '*'],
      EVIDENCE_SOURCES: ['observed', 'manual'],
      FEN_SOURCES: ['observed', 'manual'],
      PROMOTION_PIECES: ['q', 'r', 'b', 'n']
    };
    for (const [name, values] of Object.entries(expected)) {
      assert.ok(Object.isFrozen(BlindfoldSession[name]), name + ' not frozen');
      assert.deepEqual(BlindfoldSession[name], values, name + ' contents differ');
    }
    assert.ok(Object.isFrozen(BlindfoldSession.TERMINATION_REASONS));
    assert.equal(BlindfoldSession.TERMINATION_REASONS.length, 9);
  });
});
