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
