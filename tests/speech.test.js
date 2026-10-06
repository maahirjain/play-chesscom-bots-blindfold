// tests/speech.test.js
//
// Task 3.4 (PLAN.md §3.4): "Instrument speech in sounds.js."
//
// V1 — static/unit. Covers 3.4.contract.md AC1–AC11 (AC12 is the V2
// sw-speech.js harness; AC13 is V3-deferred to §7).
//
// The speech tracker is DOM-free via injected speech primitives.
// sounds.js wiring (speakText/speakTextAsync/stopAllSpeech threading)
// is verified by source inspection since sounds.js cannot fully load
// its speech functions in Node (window/speechSynthesis guards).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// Merge namespaces on globalThis (the repo's Node test pattern).
// event_envelope.js provides BlindfoldSession.newEventId (1.3's single
// UUID source); sounds.js provides the 3.4 factory/validators.
const Envelope = require('../event_envelope.js');
const Sounds = require('../sounds.js');
const merged = Object.assign({}, Envelope, Sounds);
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
function mid() { return testUuid(); }
function hid() { return testUuid(); }

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

// Fake speech primitives: the test drives callbacks manually.
function makeFakeSpeech() {
  const spoken = [];
  let cancelCalls = 0;
  return {
    spoken,
    get cancelCalls() { return cancelCalls; },
    speak: (u) => { spoken.push(u); },
    cancel: () => { cancelCalls++; },
    getVoices: () => [{ name: 'Fake Voice' }, { name: 'Other Voice' }],
    newUtterance: (text) => ({
      text, rate: 1, pitch: 1, volume: 1, voice: null,
      onend: null, onerror: null, onstart: null,
    }),
  };
}

function makeTracker(opts) {
  const { calls, emitEvent } = makeEmitter();
  const fake = makeFakeSpeech();
  const s = (opts && opts.sessionId !== undefined) ? opts.sessionId : sid();
  const g = (opts && opts.gameId !== undefined) ? opts.gameId : gid();
  const tracker = BlindfoldSession.createSpeechTracker(Object.assign({
    getSessionId: () => s,
    getGameId: () => g,
    emitEvent,
    speak: fake.speak,
    cancel: fake.cancel,
    getVoices: fake.getVoices,
    newUtterance: fake.newUtterance,
  }, (opts && opts.trackerOpts) || {}));
  return { tracker, calls, fake };
}

function types(calls) {
  return calls.map((c) => c.eventType);
}

function lastOfType(calls, t) {
  const found = calls.filter((c) => c.eventType === t);
  return found[found.length - 1];
}

// ------------------------------------------------------------------
// AC1 — utterance IDs and link refs.
// ------------------------------------------------------------------
describe('AC1 — utterance IDs and link refs', () => {
  it('every utterance gets a uuid-v4 utteranceId', () => {
    const { tracker, fake } = makeTracker();
    const id1 = tracker.speak('hello', { link: { trigger: 'move', moveEventId: mid() } });
    const id2 = tracker.speak('world', { link: { trigger: 'move', moveEventId: mid() } });
    assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(id2, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(id1, id2, 'utteranceIds are unique');
    assert.equal(fake.spoken.length, 2, 'both utterances spoken');
  });

  it('utterance_started carries exactly one link ref (moveEventId)', () => {
    const { tracker, calls } = makeTracker();
    const moveId = mid();
    tracker.speak('e4', { link: { trigger: 'move', moveEventId: moveId } });
    const started = lastOfType(calls, 'utterance_started');
    assert.deepEqual(started.refs, { moveEventId: moveId }); // sparse: sender rejects null ref values
    assert.equal(started.payload.trigger, 'move');
  });

  it('utterance_started carries exactly one link ref (helpRequestEventId)', () => {
    const { tracker, calls } = makeTracker();
    const helpId = hid();
    tracker.speak('your turn', { link: { trigger: 'help-request', helpRequestEventId: helpId } });
    const started = lastOfType(calls, 'utterance_started');
    assert.deepEqual(started.refs, { helpRequestEventId: helpId }); // sparse
    assert.equal(started.payload.trigger, 'help-request');
  });

  it("game-result utterances link the terminal move's moveEventId", () => {
    const { tracker, calls } = makeTracker();
    const terminalId = mid();
    tracker.speak('Checkmate. White wins.',
      { link: { trigger: 'game-result', moveEventId: terminalId } });
    const started = lastOfType(calls, 'utterance_started');
    assert.equal(started.payload.trigger, 'game-result');
    assert.deepEqual(started.refs, { moveEventId: terminalId }); // sparse
  });

  it('unlinked utterance: spoken and tracked, but no utterance_started', () => {
    const { tracker, calls, fake } = makeTracker();
    const id = tracker.speak('unlinked', {});
    assert.equal(fake.spoken.length, 1, 'still spoken');
    assert.ok(!types(calls).includes('utterance_started'), 'no started event without a link');
    // Cancel correlation still works for the unlinked utterance.
    tracker.cancelRequested('user');
    assert.ok(types(calls).includes('utterance_cancel_requested'));
    fake.spoken[0].onend();
    const ended = lastOfType(calls, 'utterance_ended');
    assert.equal(ended, undefined, 'no ended without a preceding started');
    assert.equal(tracker.inFlightCount(), 0);
    assert.match(id, /^[0-9a-f]{8}-/);
  });
});

// ------------------------------------------------------------------
// AC2 — utterance_started payload shape.
// ------------------------------------------------------------------
describe('AC2 — utterance_started payload', () => {
  it('has exactly the contracted keys with version and per-utterance settings', () => {
    const { tracker, calls } = makeTracker();
    tracker.speak('e4', { rate: 0.9, link: { trigger: 'move', moveEventId: mid() } });
    const started = lastOfType(calls, 'utterance_started');
    assert.deepEqual(Object.keys(started.payload).sort(), [
      'pitch', 'rate', 'speechLogicVersion', 'text', 'trigger',
      'utteranceId', 'voiceName', 'volume',
    ]);
    assert.equal(started.payload.speechLogicVersion, BlindfoldSession.SPEECH_LOGIC_VERSION);
    assert.equal(started.payload.speechLogicVersion, '1');
    assert.equal(started.payload.rate, 0.9);
    assert.equal(started.payload.pitch, 1);
    assert.equal(started.payload.volume, 1);
    assert.equal(started.payload.voiceName, null, 'default voice: name unknown');
    assert.equal(started.payload.text, null, '3.4.4: no opt-in → null');
  });
});

// ------------------------------------------------------------------
// AC3 — onend without cancel → completed.
// ------------------------------------------------------------------
describe('AC3 — clean end', () => {
  it('onend without cancel → utterance_ended {completed}', () => {
    const { tracker, calls, fake } = makeTracker();
    const id = tracker.speak('e4', { link: { trigger: 'move', moveEventId: mid() } });
    fake.spoken[0].onend();
    const ended = lastOfType(calls, 'utterance_ended');
    assert.deepEqual(ended.payload, {
      utteranceId: id, outcome: 'completed', cancelSource: null, errorName: null,
    });
    assert.equal(ended.refs, null);
    assert.equal(tracker.inFlightCount(), 0);
  });
});

// ------------------------------------------------------------------
// AC4 — cancel requests.
// ------------------------------------------------------------------
describe('AC4 — cancel requests', () => {
  it('cancel() with N in-flight → N utterance_cancel_requested with source', () => {
    const { tracker, calls, fake } = makeTracker();
    const id1 = tracker.speak('one', { link: { trigger: 'move', moveEventId: mid() } });
    const id2 = tracker.speak('two', { link: { trigger: 'move', moveEventId: mid() } });
    tracker.cancelRequested('user');
    const reqs = calls.filter((c) => c.eventType === 'utterance_cancel_requested');
    assert.equal(reqs.length, 2);
    assert.deepEqual(reqs.map((r) => r.payload.utteranceId).sort(), [id1, id2].sort());
    assert.ok(reqs.every((r) => r.payload.source === 'user'));
    assert.equal(fake.cancelCalls, 1, 'cancel primitive invoked once');
  });

  it("interrupt-replace source on preemption; callbacks correlate to 'cancelled'", () => {
    const { tracker, calls, fake } = makeTracker();
    const id1 = tracker.speak('one', { link: { trigger: 'move', moveEventId: mid() } });
    tracker.cancelRequested('interrupt-replace');
    tracker.speak('two', { link: { trigger: 'move', moveEventId: mid() } });
    // The preempted utterance's late onend → cancelled, not completed.
    fake.spoken[0].onend();
    const ended = calls.filter((c) => c.eventType === 'utterance_ended');
    assert.equal(ended.length, 1);
    assert.equal(ended[0].payload.utteranceId, id1);
    assert.equal(ended[0].payload.outcome, 'cancelled');
    assert.equal(ended[0].payload.cancelSource, 'interrupt-replace');
    assert.equal(ended[0].payload.errorName, null);
  });

  it('cancel with nothing in-flight → no events, cancel primitive still invoked', () => {
    const { tracker, calls, fake } = makeTracker();
    tracker.cancelRequested('user');
    assert.ok(!types(calls).includes('utterance_cancel_requested'));
    assert.equal(fake.cancelCalls, 1);
  });
});

// ------------------------------------------------------------------
// AC5 — error correlation (requested vs observed).
// ------------------------------------------------------------------
describe('AC5 — error correlation', () => {
  it('onerror without cancel request → {error, raw name}', () => {
    const { tracker, calls, fake } = makeTracker();
    const id = tracker.speak('e4', { link: { trigger: 'move', moveEventId: mid() } });
    fake.spoken[0].onerror({ error: 'synthesis-failed' });
    const ended = lastOfType(calls, 'utterance_ended');
    assert.deepEqual(ended.payload, {
      utteranceId: id, outcome: 'error', cancelSource: null, errorName: 'synthesis-failed',
    });
  });

  it("onerror after cancel request → 'cancelled' (requested, not observed error)", () => {
    const { tracker, calls, fake } = makeTracker();
    const id = tracker.speak('e4', { link: { trigger: 'move', moveEventId: mid() } });
    tracker.cancelRequested('user');
    // Chrome fires onerror({error:'canceled'}) after cancel() — the
    // correlation must report the REQUEST, not the callback name.
    fake.spoken[0].onerror({ error: 'canceled' });
    const ended = calls.filter((c) => c.eventType === 'utterance_ended');
    assert.equal(ended.length, 1);
    assert.equal(ended[0].payload.outcome, 'cancelled');
    assert.equal(ended[0].payload.cancelSource, 'user');
    assert.equal(ended[0].payload.errorName, null);
  });

  it('onerror with no error field → unknown-error', () => {
    const { tracker, calls, fake } = makeTracker();
    tracker.speak('e4', { link: { trigger: 'move', moveEventId: mid() } });
    fake.spoken[0].onerror({});
    const ended = lastOfType(calls, 'utterance_ended');
    assert.equal(ended.payload.outcome, 'error');
    assert.equal(ended.payload.errorName, 'unknown-error');
  });
});

// ------------------------------------------------------------------
// AC6 — 3.4.4 text-saving rule.
// ------------------------------------------------------------------
describe('AC6 — text-saving rule', () => {
  it('text is null for move/result/help utterances (reproducible)', () => {
    const { tracker, calls } = makeTracker();
    tracker.speak('e4', { link: { trigger: 'move', moveEventId: mid() } });
    tracker.speak('Checkmate.', { link: { trigger: 'game-result', moveEventId: mid() } });
    tracker.speak('your turn', { link: { trigger: 'help-request', helpRequestEventId: hid() } });
    const started = calls.filter((c) => c.eventType === 'utterance_started');
    assert.equal(started.length, 3);
    assert.ok(started.every((s) => s.payload.text === null));
  });

  it('opt-in saveText is stored verbatim ("Board not found." case)', () => {
    const { tracker, calls } = makeTracker();
    tracker.speak('Board not found.', {
      link: { trigger: 'help-request', helpRequestEventId: hid() },
      saveText: 'Board not found.',
    });
    const started = lastOfType(calls, 'utterance_started');
    assert.equal(started.payload.text, 'Board not found.');
  });

  it('the opt-in site list is pinned: exactly one production saveText site', () => {
    // speakPosition is the only production call site passing saveText.
    // If this fails, the 3.4.4 table in the contract must be updated.
    const src = fs.readFileSync(path.join(ROOT, 'sounds.js'), 'utf8');
    const saveTextSites = src.split('\n').filter((l) => l.includes('saveText:') && !l.trim().startsWith('//'));
    // One in speakPosition's speakText call, one in the tracker's
    // payload construction (o.saveText read). Both are expected.
    assert.ok(saveTextSites.some((l) => l.includes('boardMissing ? text : null')),
      'speakPosition must be the opt-in site');
  });
});

// ------------------------------------------------------------------
// AC7 — speech_settings baseline, exactly once.
// ------------------------------------------------------------------
describe('AC7 — speech_settings baseline', () => {
  it('emitted exactly once, at the first utterance', () => {
    const { tracker, calls } = makeTracker();
    tracker.speak('one', { link: { trigger: 'move', moveEventId: mid() } });
    tracker.speak('two', { link: { trigger: 'move', moveEventId: mid() } });
    tracker.speak('three', { link: { trigger: 'move', moveEventId: mid() } });
    const settings = calls.filter((c) => c.eventType === 'speech_settings');
    assert.equal(settings.length, 1);
    assert.deepEqual(settings[0].payload, {
      voiceName: null, voiceCount: 2, rate: 1, pitch: 1, volume: 1,
    });
    assert.equal(settings[0].refs, null);
    // It precedes the first utterance_started.
    assert.equal(calls[0].eventType, 'speech_settings');
    assert.equal(calls[1].eventType, 'utterance_started');
  });
});

// ------------------------------------------------------------------
// AC8 — speakTextAsync promise semantics preserved.
// ------------------------------------------------------------------
describe('AC8 — onDone / promise semantics', () => {
  it('onDone fires on completed', () => {
    const { tracker, fake } = makeTracker();
    const outcomes = [];
    tracker.speak('x', { link: { trigger: 'move', moveEventId: mid() }, onDone: (o) => outcomes.push(o) });
    fake.spoken[0].onend();
    assert.deepEqual(outcomes, ['completed']);
  });

  it('onDone fires on error and on cancelled (promise always resolves)', () => {
    const { tracker, fake } = makeTracker();
    const outcomes = [];
    tracker.speak('x', { link: { trigger: 'move', moveEventId: mid() }, onDone: (o) => outcomes.push(o) });
    fake.spoken[0].onerror({ error: 'synthesis-failed' });
    const { tracker: t2, fake: f2 } = makeTracker();
    t2.speak('y', { link: { trigger: 'move', moveEventId: mid() }, onDone: (o) => outcomes.push(o) });
    t2.cancelRequested('user');
    f2.spoken[0].onend();
    assert.deepEqual(outcomes, ['error', 'cancelled']);
  });

  it('double callback (onend after onerror) finishes once', () => {
    const { tracker, calls, fake } = makeTracker();
    tracker.speak('x', { link: { trigger: 'move', moveEventId: mid() } });
    fake.spoken[0].onerror({ error: 'synthesis-failed' });
    fake.spoken[0].onend();
    const ended = calls.filter((c) => c.eventType === 'utterance_ended');
    assert.equal(ended.length, 1, 'second callback is a no-op');
    assert.equal(tracker.inFlightCount(), 0);
  });
});

// ------------------------------------------------------------------
// AC9 — pre-§5 inertness and failure isolation.
// ------------------------------------------------------------------
describe('AC9 — inertness and failure isolation', () => {
  it('null sessionId → speech works, zero events', () => {
    const { tracker, calls, fake } = makeTracker({ sessionId: null });
    const id = tracker.speak('hello', { link: { trigger: 'move', moveEventId: mid() } });
    assert.equal(fake.spoken.length, 1, 'speech proceeds');
    assert.equal(calls.length, 0, 'no events when inert');
    assert.match(id, /^[0-9a-f]{8}-/, 'utteranceId still assigned');
    fake.spoken[0].onend();
    assert.equal(calls.length, 0, 'no ended event when inert');
    assert.equal(tracker.inFlightCount(), 0);
  });

  it('empty gameId → inert', () => {
    const { tracker, calls, fake } = makeTracker({ gameId: '' });
    tracker.speak('hello', { link: { trigger: 'move', moveEventId: mid() } });
    assert.equal(fake.spoken.length, 1);
    assert.equal(calls.length, 0);
  });

  it('throwing emitEvent never breaks speak()', () => {
    const fake = makeFakeSpeech();
    const tracker = BlindfoldSession.createSpeechTracker({
      getSessionId: () => sid(),
      getGameId: () => gid(),
      emitEvent: () => { throw new Error('boom'); },
      speak: fake.speak,
      cancel: fake.cancel,
      getVoices: fake.getVoices,
      newUtterance: fake.newUtterance,
    });
    const id = tracker.speak('hello', { link: { trigger: 'move', moveEventId: mid() } });
    assert.equal(fake.spoken.length, 1, 'utterance still spoken');
    assert.match(id, /^[0-9a-f]{8}-/);
    tracker.cancelRequested('user'); // must not throw
    assert.equal(fake.cancelCalls, 1);
  });

  it('throwing speak primitive → in-flight set cannot leak', () => {
    const fake = makeFakeSpeech();
    fake.speak = () => { throw new Error('speak broke'); };
    const { tracker, calls } = makeTracker({ trackerOpts: { speak: fake.speak } });
    const id = tracker.speak('hello', { link: { trigger: 'move', moveEventId: mid() } });
    assert.equal(tracker.inFlightCount(), 0, 'finished as error, no leak');
    const ended = lastOfType(calls, 'utterance_ended');
    assert.equal(ended.payload.outcome, 'error');
    assert.equal(ended.payload.errorName, 'speak-threw');
    assert.match(id, /^[0-9a-f]{8}-/);
  });

  it('bad options types → TypeError (programmer errors)', () => {
    assert.throws(() => BlindfoldSession.createSpeechTracker(null), TypeError);
    assert.throws(() => BlindfoldSession.createSpeechTracker({}), TypeError);
    assert.throws(() => BlindfoldSession.createSpeechTracker({
      getSessionId: () => sid(), getGameId: () => gid(), emitEvent: 'x',
    }), TypeError);
  });

  it('cancelRequested with bad source → RangeError', () => {
    const { tracker } = makeTracker();
    assert.throws(() => tracker.cancelRequested('bogus'), RangeError);
  });
});

// ------------------------------------------------------------------
// AC10 — validators, untouched files.
// ------------------------------------------------------------------
describe('AC10 — validators and scope', () => {
  it('started payload validator: exact keys, enums, uuid', () => {
    const v = BlindfoldSession.requireValidUtteranceStartedPayload;
    const good = {
      utteranceId: testUuid(), trigger: 'move', speechLogicVersion: '1',
      rate: 1, pitch: 1, volume: 1, voiceName: null, text: null,
    };
    assert.deepEqual(v(good), good);
    assert.throws(() => v(Object.assign({}, good, { extra: 1 })), TypeError);
    assert.throws(() => v(Object.assign({}, good, { trigger: 'bogus' })), RangeError);
    assert.throws(() => v(Object.assign({}, good, { utteranceId: 'x' })), TypeError);
    assert.throws(() => v(Object.assign({}, good, { rate: 0 })), RangeError);
    assert.throws(() => v(Object.assign({}, good, { text: 42 })), TypeError);
    assert.throws(() => v(null), TypeError);
  });

  it('started refs validator: exactly one link ref', () => {
    const v = BlindfoldSession.requireValidUtteranceStartedRefs;
    const moveId = testUuid();
    // Sparse single-key form (contract §2.2): the sender's requireRefs
    // rejects null ref values, so exactly-one-link means exactly one key.
    assert.deepEqual(v({ moveEventId: moveId }), { moveEventId: moveId });
    const helpId = testUuid();
    assert.deepEqual(v({ helpRequestEventId: helpId }), { helpRequestEventId: helpId });
    assert.throws(() => v({ moveEventId: testUuid(), helpRequestEventId: testUuid() }), TypeError);
    assert.throws(() => v({}), TypeError);
    assert.throws(() => v({ moveEventId: null }), TypeError);
    assert.throws(() => v({ moveEventId: 'bad' }), TypeError);
    assert.throws(() => v({ otherId: moveId }), TypeError);
  });

  it('ended payload validator', () => {
    const v = BlindfoldSession.requireValidUtteranceEndedPayload;
    const good = { utteranceId: testUuid(), outcome: 'completed', cancelSource: null, errorName: null };
    assert.deepEqual(v(good), good);
    assert.throws(() => v(Object.assign({}, good, { outcome: 'bogus' })), RangeError);
    assert.throws(() => v(Object.assign({}, good, { cancelSource: 'bogus' })), RangeError);
    assert.throws(() => v(Object.assign({}, good, { errorName: 42 })), TypeError);
    assert.throws(() => v({ utteranceId: testUuid() }), TypeError);
  });

  it('cancel_requested and speech_settings validators', () => {
    const vc = BlindfoldSession.requireValidUtteranceCancelRequestedPayload;
    const goodC = { utteranceId: testUuid(), source: 'user' };
    assert.deepEqual(vc(goodC), goodC);
    assert.throws(() => vc({ utteranceId: testUuid(), source: 'bogus' }), RangeError);
    const vs = BlindfoldSession.requireValidSpeechSettingsPayload;
    const goodS = { voiceName: null, voiceCount: 2, rate: 1, pitch: 1, volume: 1 };
    assert.deepEqual(vs(goodS), goodS);
    assert.throws(() => vs(Object.assign({}, goodS, { voiceCount: -1 })), RangeError);
    assert.throws(() => vs(Object.assign({}, goodS, { voiceName: 42 })), TypeError);
  });

  it('event_envelope.js untouched by 3.4', () => {
    const head = execSync('git show HEAD:event_envelope.js', { cwd: ROOT, stdio: 'pipe' }).toString();
    const current = fs.readFileSync(path.join(ROOT, 'event_envelope.js'), 'utf8');
    assert.strictEqual(current, head, 'event_envelope.js must be byte-identical to HEAD');
  });

  it('playIllegalMoveSound untouched in behavior (still non-speech audio)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'sounds.js'), 'utf8');
    assert.ok(src.includes('function playIllegalMoveSound()'), 'function still exists');
    // The audio path never touches the tracker: slice just the function.
    const start = src.indexOf('function playIllegalMoveSound()');
    const end = src.indexOf('\n}\n', start);
    const audioFn = src.slice(start, end);
    assert.ok(!audioFn.includes('tracker'), 'playIllegalMoveSound has no tracker reference');
    assert.ok(!audioFn.includes('utterance'), 'playIllegalMoveSound has no utterance reference');
  });
});

// ------------------------------------------------------------------
// AC11 — diff discipline.
// ------------------------------------------------------------------
describe('AC11 — diff discipline', () => {
  it('only sounds.js and content.js differ among product files', () => {
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
      'sounds.js',
      'content.js',
      'tests/speech.test.js',
      // Honest cumulative evolution: earlier tasks' suites pin files 3.4
      // legitimately touches.
      'tests/history_tracker.test.js',
      'tests/attempt_tracker.test.js',
      'tests/visibility.test.js',
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
      '.autodev/evidence/3.4.contract.md',
      '.autodev/evidence/3.4.build.md',
      '.autodev/DECISIONS.md',
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
      '.autodev/evidence/3.5.behavior.md'
    ]);
    for (const f of changed) {
      assert.ok(allowed.has(f), `unexpected modified file: ${f}`);
    }
  });

  it('PLAN.md unmodified', () => {
    const head = execSync('git show HEAD:PLAN.md', { cwd: ROOT, stdio: 'pipe' }).toString();
    const current = fs.readFileSync(path.join(ROOT, 'PLAN.md'), 'utf8');
    assert.strictEqual(current, head, 'PLAN.md must be byte-identical to HEAD');
  });

  it('no §4 recording scope in the diff (3.5 lifecycle scope is now legitimate)', () => {
    // Honest cumulative evolution: 3.5 legitimately wires
    // visibilitychange/focus/blur listeners in content.js (3.5.1); the
    // visibility token is no longer forbidden. §4 recording tokens still are.
    const diff = execSync('git diff HEAD -- sounds.js content.js', { cwd: ROOT }).toString();
    for (const token of ['MediaRecorder', 'getUserMedia', 'getDisplayMedia']) {
      assert.ok(!diff.includes(token), `diff must not contain ${token}`);
    }
  });
});
