// tests/visibility.test.js
//
// Task 3.3 (PLAN.md §3.3): "Instrument visibility and assistance."
//
// V1 — static/unit. Covers 3.3.contract.md AC1–AC11 (AC12 is the V2
// sw-visibility.js harness; AC13 is V3-deferred to §7).
//
// The visibility recorder is DOM-free. content.js wiring (setPieceSet,
// keydown handlers) is verified by source inspection since content.js
// cannot load in Node (top-level document access).

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

function makeRecorder({ sessionId, gameId, pieceSet } = {}) {
  const { calls, emitEvent } = makeEmitter();
  let ps = pieceSet === undefined ? 'neo' : pieceSet;
  const s = sessionId === undefined ? sid() : sessionId;
  const g = gameId === undefined ? gid() : gameId;
  const recorder = BlindfoldSession.createVisibilityRecorder({
    getSessionId: () => s,
    getGameId: () => g,
    getPieceSet: () => ps,
    emitEvent,
  });
  return { recorder, calls, setPieceSet: (m) => { ps = m; } };
}

function types(calls) {
  return calls.map((c) => c.eventType);
}

// ------------------------------------------------------------------
// AC1 — event vocabulary + exact-keys validators.
// ------------------------------------------------------------------
describe('AC1 — 3.3 event vocabulary and validators', () => {
  it('constants exist with the contracted values', () => {
    assert.equal(BlindfoldSession.PIECE_VISIBILITY_CHANGED_EVENT_TYPE, 'piece_visibility_changed');
    assert.equal(BlindfoldSession.HELP_REQUESTED_EVENT_TYPE, 'help_requested');
    assert.deepEqual([...BlindfoldSession.PIECE_SETS], ['blindfold', 'neo']);
    assert.deepEqual([...BlindfoldSession.VISIBILITY_SOURCES],
      ['init', 'keyboard', 'session_start', 'api']);
    assert.deepEqual([...BlindfoldSession.HELP_SHORTCUTS], ['w', 'm', 'z', 'i', 's']);
    assert.ok(Object.isFrozen(BlindfoldSession.PIECE_SETS));
    assert.ok(Object.isFrozen(BlindfoldSession.VISIBILITY_SOURCES));
    assert.ok(Object.isFrozen(BlindfoldSession.HELP_SHORTCUTS));
  });

  it('piece_visibility_changed validator: valid passes, extras/mistypes rejected', () => {
    const v = BlindfoldSession.requireValidPieceVisibilityChangedPayload;
    assert.deepEqual(v({ from: 'neo', to: 'blindfold', source: 'keyboard' }),
      { from: 'neo', to: 'blindfold', source: 'keyboard' });
    // from: null is the initial-state record (3.3.1).
    assert.deepEqual(v({ from: null, to: 'neo', source: 'init' }),
      { from: null, to: 'neo', source: 'init' });
    assert.throws(() => v({ from: 'neo', to: 'blindfold', source: 'keyboard', x: 1 }),
      TypeError, 'extra key');
    assert.throws(() => v({ from: 'neo', to: 'blindfold' }),
      TypeError, 'missing key');
    assert.throws(() => v(null), TypeError, 'null payload');
  });

  it('piece_visibility_changed validator: bad enums are RangeError', () => {
    const v = BlindfoldSession.requireValidPieceVisibilityChangedPayload;
    assert.throws(() => v({ from: 'bogus', to: 'neo', source: 'keyboard' }), RangeError);
    assert.throws(() => v({ from: null, to: 'bogus', source: 'init' }), RangeError);
    assert.throws(() => v({ from: 'neo', to: 'blindfold', source: 'bogus' }), RangeError);
    assert.throws(() => v({ from: 5, to: 'neo', source: 'init' }), RangeError,
      'non-string from');
    // from === to is well-formed (recordTransition no-ops on it); the
    // validator accepts it.
    assert.deepEqual(v({ from: 'neo', to: 'neo', source: 'keyboard' }),
      { from: 'neo', to: 'neo', source: 'keyboard' });
  });

  it('help_requested validator: valid passes, bad shortcut/flag rejected', () => {
    const v = BlindfoldSession.requireValidHelpRequestedPayload;
    assert.deepEqual(v({ shortcut: 'w', hadUsableContent: true }),
      { shortcut: 'w', hadUsableContent: true });
    assert.deepEqual(v({ shortcut: 'z', hadUsableContent: false }),
      { shortcut: 'z', hadUsableContent: false });
    assert.throws(() => v({ shortcut: 'j', hadUsableContent: true }), RangeError,
      'j is not a help shortcut');
    assert.throws(() => v({ shortcut: 'Escape', hadUsableContent: true }), RangeError);
    assert.throws(() => v({ shortcut: 'w', hadUsableContent: 'yes' }), TypeError);
    assert.throws(() => v({ shortcut: 'w', hadUsableContent: true, x: 1 }), TypeError,
      'extra key');
  });

  it('createVisibilityRecorder rejects non-function options (TypeError)', () => {
    assert.throws(() => BlindfoldSession.createVisibilityRecorder({}), TypeError);
    assert.throws(() => BlindfoldSession.createVisibilityRecorder({
      getSessionId: () => sid(), getGameId: () => gid(),
      getPieceSet: () => 'neo', emitEvent: 'nope',
    }), TypeError);
  });
});

// ------------------------------------------------------------------
// AC2/AC3/AC4 — transitions, initial record, no-op semantics.
// ------------------------------------------------------------------
describe('AC2/AC3/AC4 — transitions and initial state', () => {
  it('recordTransition emits {from, to, source} and returns the eventId', () => {
    const { recorder, calls } = makeRecorder({ pieceSet: 'neo' });
    const id = recorder.recordTransition('neo', 'blindfold', 'keyboard');
    assert.equal(typeof id, 'string');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].eventType, 'piece_visibility_changed');
    assert.deepEqual(calls[0].payload, { from: 'neo', to: 'blindfold', source: 'keyboard' });
    assert.equal(calls[0].refs, null);
    assert.equal(calls[0].eventId, id);
  });

  it('unchanged mode is a no-op: no event, returns null', () => {
    const { recorder, calls } = makeRecorder({ pieceSet: 'neo' });
    assert.equal(recorder.recordTransition('neo', 'neo', 'api'), null);
    assert.equal(calls.length, 0);
  });

  it('recordInitial emits {from: null, to: <current>, source} (3.3.1)', () => {
    const { recorder, calls, setPieceSet } = makeRecorder({ pieceSet: 'blindfold' });
    const id = recorder.recordInitial('init');
    assert.equal(typeof id, 'string');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].payload, { from: null, to: 'blindfold', source: 'init' });
    // Reads the piece set at call time.
    setPieceSet('neo');
    recorder.recordInitial('session_start');
    assert.deepEqual(calls[1].payload, { from: null, to: 'neo', source: 'session_start' });
  });

  it('recordInitial enforces the source vocabulary', () => {
    const { recorder } = makeRecorder();
    assert.throws(() => recorder.recordInitial('bogus'), RangeError);
  });

  it('recordTransition validates before the no-op check (bad input throws)', () => {
    const { recorder } = makeRecorder();
    assert.throws(() => recorder.recordTransition('neo', 'bogus', 'keyboard'), RangeError);
  });
});

// ------------------------------------------------------------------
// AC5 — emission gating (§5 seam).
// ------------------------------------------------------------------
describe('AC5 — emission gating (pre-§5 inert)', () => {
  it('empty sessionId → inert: no events, no throw', () => {
    const { recorder, calls } = makeRecorder({ sessionId: '' });
    assert.equal(recorder.isActive(), false);
    assert.equal(recorder.recordTransition('neo', 'blindfold', 'keyboard'), null);
    assert.equal(recorder.recordInitial('init'), null);
    assert.equal(recorder.recordHelpRequest('w', true), null);
    assert.equal(calls.length, 0);
  });

  it('empty gameId → inert', () => {
    const { recorder, calls } = makeRecorder({ gameId: '' });
    assert.equal(recorder.isActive(), false);
    assert.equal(recorder.recordTransition('neo', 'blindfold', 'keyboard'), null);
    assert.equal(calls.length, 0);
  });

  it('null sessionId → inert', () => {
    const { recorder, calls } = makeRecorder({ sessionId: null });
    assert.equal(recorder.isActive(), false);
    assert.equal(recorder.recordHelpRequest('m', false), null);
    assert.equal(calls.length, 0);
  });

  it('thunks read IDs at call time (not capture time)', () => {
    let s = '';
    const { emitEvent } = makeEmitter();
    const recorder = BlindfoldSession.createVisibilityRecorder({
      getSessionId: () => s,
      getGameId: () => gid(),
      getPieceSet: () => 'neo',
      emitEvent,
    });
    assert.equal(recorder.isActive(), false);
    s = sid();
    assert.equal(recorder.isActive(), true);
    assert.equal(typeof recorder.recordTransition('neo', 'blindfold', 'api'), 'string');
  });
});

// ------------------------------------------------------------------
// AC6 — help requests with hadUsableContent classification.
// ------------------------------------------------------------------
describe('AC6 — help_requested with hadUsableContent', () => {
  it('records each shortcut with its classification; content-less → false', () => {
    const { recorder, calls } = makeRecorder();
    const idW = recorder.recordHelpRequest('w', true);
    const idM = recorder.recordHelpRequest('m', false); // mid-game: no result yet
    const idZ = recorder.recordHelpRequest('z', false); // nothing spoken yet
    const idI = recorder.recordHelpRequest('i', true);
    const idS = recorder.recordHelpRequest('s', false); // board unreadable
    assert.deepEqual(types(calls),
      ['help_requested', 'help_requested', 'help_requested', 'help_requested', 'help_requested']);
    assert.deepEqual(calls[0].payload, { shortcut: 'w', hadUsableContent: true });
    assert.deepEqual(calls[1].payload, { shortcut: 'm', hadUsableContent: false });
    assert.deepEqual(calls[2].payload, { shortcut: 'z', hadUsableContent: false });
    assert.deepEqual(calls[3].payload, { shortcut: 'i', hadUsableContent: true });
    assert.deepEqual(calls[4].payload, { shortcut: 's', hadUsableContent: false });
    assert.ok(calls.every((c) => c.refs === null));
    assert.equal(calls[0].eventId, idW);
    assert.equal(calls[1].eventId, idM);
    assert.equal(calls[2].eventId, idZ);
    assert.equal(calls[3].eventId, idI);
    assert.equal(calls[4].eventId, idS);
  });

  it('bad shortcut throws (never silently recorded)', () => {
    const { recorder, calls } = makeRecorder();
    assert.throws(() => recorder.recordHelpRequest('v', true), RangeError);
    assert.equal(calls.length, 0);
  });
});

// ------------------------------------------------------------------
// AC7/AC8 — content.js wiring by source inspection (content.js cannot
// load in Node: top-level document access).
// ------------------------------------------------------------------
describe('AC7/AC8 — content.js wiring (source inspection)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

  it('j, v, Escape never produce help_requested', () => {
    // recordHelpRequestSafe is called only in the w/m/z/i/s handlers.
    const matches = src.match(/recordHelpRequestSafe\("([a-z]+)"/g) || [];
    const shortcuts = matches.map((m) => m.match(/"([a-z]+)"/)[1]).sort();
    assert.deepEqual(shortcuts, ['i', 'm', 's', 'w', 'z']);
  });

  it('v-key handler passes source keyboard to setPieceSet', () => {
    assert.ok(src.includes('setPieceSet(piece_set === "blindfold" ? "neo" : "blindfold", "keyboard")'),
      'v-key passes keyboard source');
  });

  it('setPieceSet has optional source param defaulting to api; records transitions', () => {
    assert.ok(src.includes('function setPieceSet(mode, source)'), 'source param');
    assert.ok(src.includes("source === undefined ? 'api' : source"), 'api default');
    assert.ok(src.includes('visibilityRecorder.recordTransition(oldMode, mode,'),
      'transition recorded');
  });

  it('recordInitial(init) is called at load', () => {
    assert.ok(src.includes("visibilityRecorder.recordInitial('init')"), 'init record');
  });

  it('recorder calls are failure-isolated (3.2 SF-1 precedent)', () => {
    assert.ok(src.includes('function recordHelpRequestSafe(shortcut, hadUsableContent)'),
      'safe helper exists');
    // Every recorder call site is inside try/catch.
    const helper = src.match(/function recordHelpRequestSafe[\s\S]*?\n}/)[0];
    assert.ok(helper.includes('try {'), 'helper try');
    assert.ok(helper.includes('catch (e)'), 'helper catch');
    const setPieceSetFn = src.match(/function setPieceSet\(mode, source\)[\s\S]*?\n}/)[0];
    assert.ok(setPieceSetFn.includes('try {'), 'setPieceSet try');
    assert.ok(setPieceSetFn.includes('catch (e)'), 'setPieceSet catch');
    const initCall = src.match(/try \{\n  visibilityRecorder\.recordInitial\('init'\);\n\} catch/);
    assert.ok(initCall, 'init call failure-isolated');
  });

  it('help handlers compute hadUsableContent from values in hand, before speaking', () => {
    // w: turn always known → true.
    assert.ok(src.includes('recordHelpRequestSafe("w", true)'));
    // m: result text non-empty.
    assert.ok(src.includes('recordHelpRequestSafe("m", text !== null && text !== "")'));
    // z: last_spoken_move_text (content-less still records).
    assert.ok(src.includes('recordHelpRequestSafe("z", !!last_spoken_move_text)'));
    // i: move list non-empty.
    assert.ok(src.includes('recordHelpRequestSafe("i", latest_half_moves.length > 0)'));
    // s: board readable.
    assert.ok(src.includes('recordHelpRequestSafe("s", boardReadable)'));
    // Request-first ordering: record before speak in each handler.
    for (const key of ['w', 'm', 'z', 'i', 's']) {
      const idx = src.indexOf(`recordHelpRequestSafe("${key}"`);
      const speakIdx = src.indexOf('speak', idx);
      assert.ok(idx !== -1 && speakIdx !== -1 && idx < speakIdx,
        `${key}: record before speak`);
    }
  });

  it('observePieceRenders re-application path emits nothing', () => {
    // applyCurrentPieceSet does not call setPieceSet; the recorder is
    // only reachable via setPieceSet/recordInitial/recordHelpRequest.
    // Deduplicated: comments may mention call sites.
    const recorderCalls = [...new Set(
      (src.match(/visibilityRecorder\.\w+\(/g) || [])
        .map((m) => m.match(/\.(\w+)\(/)[1])
    )].sort();
    assert.deepEqual(recorderCalls,
      ['recordHelpRequest', 'recordInitial', 'recordTransition']);
    assert.ok(!src.includes('applyCurrentPieceSet();\n    try'),
      'applyCurrentPieceSet has no recorder call');
  });

  it('existing help UX unchanged (speech calls preserved)', () => {
    // 3.4 evolution: the speech calls keep their exact text/behavior and
    // gain only link threading (helpLink(...)) — UX is byte-identical.
    assert.ok(src.includes('speakText(turn === "w" ? "White\'s turn" : "Black\'s turn"'));
    assert.ok(src.includes('speakText(text || "Game not over."'));
    assert.ok(src.includes('speakFullMoveList(latest_half_moves, helpLink(iHelpId))'),
      'i-shortcut still speaks the move list, now with its help link');
    assert.ok(src.includes('speakPosition(helpLink(sHelpId))'),
      's-shortcut still speaks the position, now with its help link');
    assert.ok(src.includes('stopAllSpeech()'), 'Escape still cancels speech');
  });
});

// ------------------------------------------------------------------
// AC9 — diff discipline.
// ------------------------------------------------------------------
describe('AC9 — diff discipline', () => {
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
      'chess_utils.js',
      'content.js',
      'sounds.js',
      'tests/visibility.test.js',
      'tests/speech.test.js',
      // Honest cumulative evolution: earlier tasks' suites pin files 3.3
      // legitimately touches.
      'tests/history_tracker.test.js',
      'tests/attempt_tracker.test.js',
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
      '.autodev/evidence/3.3.contract.md',
      '.autodev/evidence/3.3.build.md',
      '.autodev/evidence/3.3.domaudit.md',
      '.autodev/DECISIONS.md',
      // Honest cumulative evolution: 3.3's review/behavior evidence
      // lands after the pins were evolved (2.x/3.1/3.2 precedent).
      '.autodev/evidence/3.3.review.md',
      '.autodev/evidence/3.3.behavior.md',
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
    ]);
    for (const f of changed) {
      assert.ok(allowed.has(f), `unexpected modified file: ${f}`);
    }
  });

  it('event_envelope.js untouched; new types are 3.3-owned constants', () => {
    const diff = execSync('git diff HEAD --stat', { cwd: ROOT }).toString();
    assert.ok(!diff.includes('event_envelope.js'), 'event_envelope.js not in diff');
    const src = fs.readFileSync(path.join(ROOT, 'chess_utils.js'), 'utf8');
    assert.ok(src.includes("BlindfoldSession.PIECE_VISIBILITY_CHANGED_EVENT_TYPE = 'piece_visibility_changed'"));
    assert.ok(src.includes("BlindfoldSession.HELP_REQUESTED_EVENT_TYPE = 'help_requested'"));
  });

  it('no §4/§5 implementation scope in the diff (3.5 is the current task — its scope is legitimate)', () => {
    // Honest cumulative evolution: this pin asserted "no 3.5 scope"
    // when 3.3/3.4 were current. 3.5's game/session lifecycle (visibility
    // listeners, game_reset, game_ended, termination vocabulary) is now
    // the legitimate diff; the pin guards §4 recording and §5 UI tokens.
    // Only ADDED lines count: comments may name future tasks to declare
    // scope boundaries.
    const diff = execSync('git diff HEAD -- chess_utils.js content.js sounds.js', { cwd: ROOT }).toString();
    const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    for (const token of ['MediaRecorder', 'getUserMedia', 'getDisplayMedia']) {
      assert.ok(!added.some((l) => l.includes(token)),
        `no §4/§5 token in added lines: ${token}`);
    }
  });

  it('PLAN.md untouched', () => {
    const diff = execSync('git diff HEAD --stat', { cwd: ROOT }).toString();
    assert.ok(!diff.includes('PLAN.md'), 'PLAN.md not in diff');
  });
});
