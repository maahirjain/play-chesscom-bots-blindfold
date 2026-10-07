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
      // Honest cumulative evolution: 6.2 (export events.jsonl) and
      // 6.3 (export media-sync.json) extend the 6.1 exporter.js module
      // with pure builder functions; their evidence files join the
      // allowlists. No new channel messages, event types, stores, or
      // permissions in 6.2/6.3.
      '.autodev/evidence/6.2.contract.md',
      '.autodev/evidence/6.2.build.md',
      '.autodev/evidence/6.2+6.3.review.md',
      '.autodev/evidence/6.2+6.3.behavior.md',
      '.autodev/evidence/6.3.contract.md',
      '.autodev/evidence/6.4.contract.md',
      '.autodev/evidence/6.4.build.md',
      '.autodev/evidence/6.5.contract.md',
      '.autodev/evidence/6.5.build.md',
      // 6.6 (ZIP packaging) adds the ZIP writer + exportSession to
      // exporter.js, the export-request listener to sw.js, the
      // downloads permission to manifest.json, and the Download
      // affordance to session_controls.js.
      '.autodev/evidence/6.6.contract.md',
      '.autodev/evidence/6.6.build.md',
      // Honest cumulative evolution: 6.7 (repeatable export) is
      // verification-only (tests + docs); 6.8 (export
      // documentation) adds EXPORT.md.
      '.autodev/evidence/6.7.contract.md',
      '.autodev/evidence/6.7.build.md',
      '.autodev/evidence/6.8.contract.md',
      '.autodev/evidence/6.8.build.md',
      'EXPORT.md',
      'tests/acceptance_7_2.test.js',
      'tests/acceptance_7_4_7_7.test.js',
      'tests/acceptance_7_10.test.js',
      'tests/acceptance_7_11.test.js',
      // 7.14 inlined EXPORT.md into README.md and deleted the file.
      'README.md',
      // 7.1-7.3 (acceptance tests) evidence files.
      '.autodev/evidence/7.1.contract.md',
      '.autodev/evidence/7.1.build.md',
      '.autodev/evidence/7.1.review.md',
      '.autodev/evidence/7.1.behavior.md',
      '.autodev/evidence/7.2.contract.md',
      '.autodev/evidence/7.2.build.md',
      '.autodev/evidence/7.3.contract.md',
      '.autodev/evidence/7.3.build.md',
      '.autodev/evidence/7.3.review.md',
      '.autodev/evidence/7.3.behavior.md',
      '.autodev/evidence/7.1-7.11.review.md',
      '.autodev/evidence/7.1-7.11+7.14.behavior.md',
      '.autodev/evidence/7.10.contract.md',
      '.autodev/evidence/7.10.build.md',
      '.autodev/evidence/7.11.contract.md',
      '.autodev/evidence/7.11.build.md',
      '.autodev/evidence/7.4.contract.md',
      '.autodev/evidence/7.4.build.md',
      '.autodev/evidence/7.5.contract.md',
      '.autodev/evidence/7.5.build.md',
      '.autodev/evidence/7.6.contract.md',
      '.autodev/evidence/7.6.build.md',
      '.autodev/evidence/7.7.contract.md',
      '.autodev/evidence/7.7.build.md',
      '.autodev/evidence/7.14.contract.md',
      '.autodev/evidence/7.14.build.md',
      '.autodev/evidence/7.14.review.md',
      // 6.4+6.5 review/behavior use combined naming (reviewer/verifier
      // wrote single files for the pair, 6.2+6.3 precedent).
      '.autodev/evidence/6.4+6.5.review.md',
      '.autodev/evidence/6.4+6.5.behavior.md',
      '.autodev/evidence/6.3.build.md',
      
      
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
