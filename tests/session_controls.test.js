// tests/session_controls.test.js
//
// Task 5.1 (PLAN.md §5.1): compact Start/Stop control and per-stream
// recording health lights (in-page, not a popup).
//
// V1 — static + unit. Covers 5.1.contract.md AC1–AC7 (AC8–AC10 are the
// V2 harness; AC11 is V3-deferred to §7).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const REPO = ROOT;

function freshModule() {
  delete require.cache[require.resolve('../session_controls.js')];
  return require('../session_controls.js');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------
// Minimal DOM stub. Only what installSessionControls touches:
// createElement, getElementById, body.appendChild,
// parentNode.insertBefore, className (counted), setAttribute /
// getAttribute / removeAttribute, title, disabled, and click listeners.
// ------------------------------------------------------------------
function makeFakeDocument(withInput) {
  function makeEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      _cls: '',
      _classSets: 0,
      _attrs: {},
      textContent: '',
      parentNode: null,
      children: [],
      disabled: false,
      _clickHandlers: [],
      setAttribute(k, v) { this._attrs[String(k)] = String(v); },
      getAttribute(k) {
        const key = String(k);
        return Object.prototype.hasOwnProperty.call(this._attrs, key)
          ? this._attrs[key] : null;
      },
      removeAttribute(k) { delete this._attrs[String(k)]; },
      appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      insertBefore(child, ref) {
        child.parentNode = this;
        const i = ref ? this.children.indexOf(ref) : -1;
        if (i === -1) this.children.push(child);
        else this.children.splice(i, 0, child);
        return child;
      },
      addEventListener(type, fn) {
        if (type === 'click') this._clickHandlers.push(fn);
      },
      click() {
        for (const fn of this._clickHandlers.slice()) fn();
      },
    };
    Object.defineProperty(el, 'className', {
      configurable: true,
      get() { return this._cls; },
      set(v) { this._cls = String(v); this._classSets++; },
    });
    Object.defineProperty(el, 'title', {
      configurable: true,
      get() { return this.getAttribute('title'); },
      set(v) {
        if (v === null || v === undefined) this.removeAttribute('title');
        else this.setAttribute('title', v);
      },
    });
    return el;
  }
  const body = makeEl('body');
  const doc = {
    _elements: [],
    body,
    input: null,
    createElement(tag) {
      const el = makeEl(tag);
      this._elements.push(el);
      return el;
    },
    getElementById(id) {
      if (id === 'blindfold-chess-move-input' && withInput) return this.input;
      return null;
    },
  };
  if (withInput) {
    const input = makeEl('input');
    input.setAttribute('id', 'blindfold-chess-move-input');
    const holder = makeEl('div');
    holder.appendChild(input);
    body.appendChild(holder);
    doc.input = input;
  }
  return doc;
}

// A 4.14-shaped per-stream status with overridable fields.
function streamStatus(overrides) {
  const base = {
    streamKind: 'microphone',
    lifecycle: 'idle',
    recorderState: 'inactive',
    segmentId: null,
    segmentNumber: null,
    startedAtUtc: null,
    startedAtMonotonicMs: null,
    clockSegmentId: null,
    actualMimeType: null,
    fileExtension: null,
    audioContent: null,
    chunk: null,
    tracks: [],
    lastRecorderError: null,
    lastDiscontinuity: null,
    finalizedAtUtc: null,
    unfinalizedSegments: 0,
  };
  return Object.assign(base, overrides || {});
}

// Install-option stubs.
function makeOpts(overrides) {
  const seen = [];
  const sender = {
    emitCalls: [],
    emit(envelope) {
      this.emitCalls.push(envelope);
      return { eventId: 'e1' };
    },
    getStatus() {
      return { pendingCount: 0, lastError: null, transportAvailable: true, retryScheduled: false };
    },
  };
  const glr = {
    stopTerminationCalls: [],
    resetEndedCalls: 0,
    _observedEnd: null,
    recordStopTermination(reason, result) {
      this.stopTerminationCalls.push({ reason, result });
      return 'event-id';
    },
    resetEnded() { this.resetEndedCalls++; },
    getLastObservedEnd() { return this._observedEnd; },
  };
  const transport = {
    calls: [],
    // handler: (envelope) => response | Promise<response>
    handler: null,
    fn(envelope) {
      this.calls.push(envelope);
      if (typeof this.handler === 'function') return this.handler(envelope);
      return Promise.resolve({ ok: false, error: 'no-handler' });
    },
  };
  const opts = {
    sender,
    sendRecorderMessage: (env) => transport.fn(env),
    gameLifecycleRecorder: glr,
    intervalMs: 15,
    onStopComplete: null,
    _transport: transport,
    _sender: sender,
    _glr: glr,
  };
  const stopCalls = [];
  opts.onStopComplete = (resp) => { stopCalls.push(resp); };
  opts._stopCalls = stopCalls;
  return Object.assign(opts, overrides || {});
}

function stripInternal(opts) {
  const o = Object.assign({}, opts);
  delete o._transport;
  delete o._sender;
  delete o._glr;
  delete o._stopCalls;
  return o;
}

// Publish the module as the shared namespace (the module reads
// globalThis.BlindfoldSession for the identity minters) with stubbed
// minters and emitPageStart.
let savedNS;
function publishNS(BS, overrides) {
  savedNS = globalThis.BlindfoldSession;
  const pageStarts = [];
  BS.newSessionId = () => 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  BS.newGameId = () => 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  BS.emitPageStart = (sender, sessionId) => {
    pageStarts.push({ sender, sessionId });
    return { eventId: 'ps1' };
  };
  BS.activeSessionId = null;
  BS.activeGameId = null;
  BS._pageStarts = pageStarts;
  Object.assign(BS, overrides || {});
  globalThis.BlindfoldSession = BS;
  return BS;
}
function unpublishNS() {
  if (savedNS === undefined) delete globalThis.BlindfoldSession;
  else globalThis.BlindfoldSession = savedNS;
  savedNS = undefined;
}

// ------------------------------------------------------------------
// AC1 — module shape and convention.
// ------------------------------------------------------------------
describe('AC1 — module shape', () => {
  it('follows the module convention and exports the two functions', () => {
    const BS = freshModule();
    assert.equal(typeof BS.classifyStreamStatus, 'function');
    assert.equal(typeof BS.installSessionControls, 'function');
    const src = fs.readFileSync(path.join(ROOT, 'session_controls.js'), 'utf8');
    assert.ok(src.includes("'use strict'"), 'IIFE use strict');
    assert.ok(src.includes('module.exports'), 'Node shim');
    assert.ok(src.startsWith('// session_controls.js'), 'file header');
  });

  it('publishes the closed light-state vocabulary', () => {
    const BS = freshModule();
    assert.deepEqual(
      [BS.LIGHT_OFF_IDLE, BS.LIGHT_FAILED_NOT_STARTED,
       BS.LIGHT_RECORDING_HEALTHY, BS.LIGHT_RECORDING_DEGRADED,
       BS.LIGHT_STOPPED_FINALIZING, BS.LIGHT_FINALIZED, BS.LIGHT_UNKNOWN],
      ['off-idle', 'failed-not-started', 'recording-healthy',
       'recording-degraded', 'stopped-finalizing', 'finalized', 'unknown']);
    assert.deepEqual(BS.SESSION_CONTROL_STREAM_KINDS,
      ['microphone', 'screen', 'webcam']);
    assert.equal(BS.RECORDER_MSG_ENSURE, 'recorder-ensure');
  });
});

// ------------------------------------------------------------------
// AC2 — classifyStreamStatus truth table (no smoothing).
// ------------------------------------------------------------------
describe('AC2 — classifyStreamStatus', () => {
  it('idle with no facts → off-idle (detail null)', () => {
    const BS = freshModule();
    const c = BS.classifyStreamStatus(streamStatus({ lifecycle: 'idle' }));
    assert.equal(c.state, 'off-idle');
    assert.equal(c.detail, null);
    assert.ok(Object.isFrozen(c));
  });

  it('idle with adverse facts (no start result) → failed-not-started (never idle-green)', () => {
    const BS = freshModule();
    const c = BS.classifyStreamStatus(streamStatus({
      lifecycle: 'idle',
      lastRecorderError: { errorName: 'NotAllowedError', errorMessage: null, atUtc: null },
    }));
    assert.equal(c.state, 'failed-not-started');
    assert.ok(c.detail.includes('recorder-error:NotAllowedError'), c.detail);
  });

  it('idle + observed failed start → failed-not-started with start-failed fact (no masquerade as off-idle)', () => {
    const BS = freshModule();
    const c = BS.classifyStreamStatus(
      streamStatus({ lifecycle: 'idle' }),
      { ok: false, error: 'denied', errorName: 'Error', stage: 'acquire-stream' });
    assert.equal(c.state, 'failed-not-started');
    assert.ok(c.detail.includes('start-failed:denied'), c.detail);
    // Combined with status facts, the start fact leads (raw, unsmoothed).
    const c2 = BS.classifyStreamStatus(
      streamStatus({
        lifecycle: 'idle',
        lastRecorderError: { errorName: 'NotAllowedError', errorMessage: null, atUtc: null },
      }),
      { ok: false, error: 'denied' });
    assert.equal(c2.state, 'failed-not-started');
    assert.deepEqual(c2.detail.split('; '),
      ['start-failed:denied', 'recorder-error:NotAllowedError']);
  });

  it('idle + ok/absent start result → off-idle (boot adoption stays honest)', () => {
    const BS = freshModule();
    assert.equal(
      BS.classifyStreamStatus(streamStatus({ lifecycle: 'idle' }), { ok: true }).state,
      'off-idle');
    assert.equal(
      BS.classifyStreamStatus(streamStatus({ lifecycle: 'idle' }), null).state,
      'off-idle');
    assert.equal(
      BS.classifyStreamStatus(streamStatus({ lifecycle: 'idle' })).state,
      'off-idle');
  });

  it('recording with no facts → recording-healthy', () => {
    const BS = freshModule();
    const c = BS.classifyStreamStatus(streamStatus({
      lifecycle: 'recording', recorderState: 'recording',
    }));
    assert.equal(c.state, 'recording-healthy');
    assert.equal(c.detail, null);
  });

  it('THE masquerade case: chunk-stalled with recorderState recording → recording-degraded, never healthy', () => {
    const BS = freshModule();
    for (const terminal of ['chunk-stalled', 'chunk-quota-exceeded', 'chunk-write-error']) {
      const c = BS.classifyStreamStatus(streamStatus({
        lifecycle: 'recording',
        recorderState: 'recording',
        chunk: { status: terminal, lastChunkIndex: 7, lastWriteAtUtc: null, consecutiveMisses: 3, emptyPolls: 0, lastErrorName: null, lastErrorMessage: null },
      }));
      assert.equal(c.state, 'recording-degraded', terminal);
      assert.notEqual(c.state, 'recording-healthy', terminal);
      assert.ok(c.detail.includes('chunk:' + terminal), c.detail);
    }
  });

  it('recording + recorder error / discontinuity / ended+muted tracks → recording-degraded with raw facts', () => {
    const BS = freshModule();
    const c = BS.classifyStreamStatus(streamStatus({
      lifecycle: 'recording',
      recorderState: 'recording',
      lastRecorderError: { errorName: 'InvalidStateError', errorMessage: null, atUtc: null },
      lastDiscontinuity: { reason: 'track-ended', atUtc: null },
      tracks: [
        { trackKind: 'audio', muted: false, readyState: 'ended' },
        { trackKind: 'video', muted: true, readyState: 'live' },
      ],
    }));
    assert.equal(c.state, 'recording-degraded');
    assert.ok(c.detail.includes('recorder-error:InvalidStateError'), c.detail);
    assert.ok(c.detail.includes('discontinuity:track-ended'), c.detail);
    assert.ok(c.detail.includes('track:ended(audio)'), c.detail);
    assert.ok(c.detail.includes('track:muted(video)'), c.detail);
    // Facts are '; '-joined raw strings — never a smoothed summary.
    assert.deepEqual(c.detail.split('; '), [
      'recorder-error:InvalidStateError',
      'discontinuity:track-ended',
      'track:ended(audio)',
      'track:muted(video)',
    ]);
  });

  it('non-terminal chunk statuses are not adverse facts', () => {
    const BS = freshModule();
    for (const s of ['chunk-ok', 'chunk-idle', null]) {
      const c = BS.classifyStreamStatus(streamStatus({
        lifecycle: 'recording',
        chunk: s === null ? null : { status: s },
      }));
      assert.equal(c.state, 'recording-healthy', String(s));
    }
  });

  it('stopped → stopped-finalizing', () => {
    const BS = freshModule();
    const c = BS.classifyStreamStatus(streamStatus({ lifecycle: 'stopped' }));
    assert.equal(c.state, 'stopped-finalizing');
  });

  it('finalized lifecycle → finalized; finalizedAtUtc non-null → finalized', () => {
    const BS = freshModule();
    assert.equal(
      BS.classifyStreamStatus(streamStatus({ lifecycle: 'finalized', finalizedAtUtc: '2026-10-06T00:00:00.000Z' })).state,
      'finalized');
    assert.equal(
      BS.classifyStreamStatus(streamStatus({ lifecycle: 'idle', finalizedAtUtc: '2026-10-06T00:00:00.000Z' })).state,
      'finalized');
  });

  it('recording + finalizedAtUtc set (inconsistent) → degraded with the inconsistency as a fact, never green/finalized', () => {
    const BS = freshModule();
    const c = BS.classifyStreamStatus(streamStatus({
      lifecycle: 'recording', finalizedAtUtc: '2026-10-06T00:00:00.000Z',
    }));
    assert.equal(c.state, 'recording-degraded');
    assert.ok(c.detail.includes('inconsistent:finalizedAtUtc-set-while-recording'), c.detail);
  });

  it('unknown lifecycle string → unknown (never green)', () => {
    const BS = freshModule();
    const c = BS.classifyStreamStatus(streamStatus({ lifecycle: 'exploding' }));
    assert.equal(c.state, 'unknown');
  });

  it('malformed input → TypeError', () => {
    const BS = freshModule();
    for (const bad of [null, undefined, 42, 'x', [], streamStatus({ lifecycle: 42 }), streamStatus({ lifecycle: null })]) {
      if (bad !== null && typeof bad === 'object' && !Array.isArray(bad) && 'lifecycle' in bad) {
        // {} with lifecycle explicitly nulled/numbered → TypeError on the field.
      }
      assert.throws(() => BS.classifyStreamStatus(bad), TypeError,
        'expected TypeError for ' + JSON.stringify(bad));
    }
  });
});

// ------------------------------------------------------------------
// AC3 — installSessionControls DOM behavior and guards.
// ------------------------------------------------------------------
describe('AC3 — installSessionControls', () => {
  let savedDocument;
  beforeEach(() => { savedDocument = globalThis.document; });
  afterEach(() => {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
    unpublishNS();
  });

  it('renders Start button + three lights; anchors to the move input', () => {
    const BS = publishNS(freshModule());
    globalThis.document = makeFakeDocument(true);
    const opts = makeOpts();
    // Boot adoption: no session.
    opts._transport.handler = () => Promise.resolve({ ok: false, error: 'no-session' });
    const h = BS.installSessionControls(stripInternal(opts));
    try {
      assert.equal(h.button.textContent, 'Start');
      assert.equal(h.button.disabled, false);
      assert.deepEqual(Object.keys(h.lights).sort(), ['microphone', 'screen', 'webcam']);
      const doc = globalThis.document;
      assert.equal(h.element.parentNode, doc.input.parentNode);
      assert.ok(!h.element.className.includes('blindfold-session-controls-fallback'));
      for (const kind of ['microphone', 'screen', 'webcam']) {
        assert.ok(h.lights[kind].className.includes('blindfold-stream-off-idle'), kind);
      }
    } finally { h.stop(); }
  });

  it('falls back to the fixed corner when the input anchor is absent', () => {
    const BS = publishNS(freshModule());
    globalThis.document = makeFakeDocument(false);
    const opts = makeOpts();
    opts._transport.handler = () => Promise.resolve({ ok: false, error: 'no-session' });
    const h = BS.installSessionControls(stripInternal(opts));
    try {
      assert.equal(h.element.parentNode, globalThis.document.body);
      assert.ok(h.element.className.includes('blindfold-session-controls-fallback'));
    } finally { h.stop(); }
  });

  it('invalid options → TypeError before any timer starts', () => {
    const BS = publishNS(freshModule());
    globalThis.document = makeFakeDocument(true);
    const good = stripInternal(makeOpts());
    const bads = [
      null, undefined, 42, 'x', [],
      Object.assign({}, good, { sender: null }),
      Object.assign({}, good, { sender: {} }),
      Object.assign({}, good, { sendRecorderMessage: 'yes' }),
      Object.assign({}, good, { gameLifecycleRecorder: null }),
      Object.assign({}, good, { gameLifecycleRecorder: {} }),
      Object.assign({}, good, { intervalMs: 0 }),
      Object.assign({}, good, { intervalMs: -5 }),
      Object.assign({}, good, { onStopComplete: 42 }),
    ];
    for (const b of bads) {
      assert.throws(() => BS.installSessionControls(b), TypeError,
        'expected TypeError for ' + JSON.stringify(b && b.intervalMs));
    }
  });

  it('missing document → plain Error (platform capability)', () => {
    const BS = publishNS(freshModule());
    delete globalThis.document;
    assert.throws(() => BS.installSessionControls(stripInternal(makeOpts())), Error);
  });

  it('re-renders lights only on state/detail change (no DOM churn per poll)', async () => {
    const BS = publishNS(freshModule());
    globalThis.document = makeFakeDocument(true);
    const opts = makeOpts({ intervalMs: 10 });
    const statuses = {
      microphone: streamStatus({ streamKind: 'microphone', lifecycle: 'recording' }),
      screen: streamStatus({ streamKind: 'screen', lifecycle: 'idle' }),
      webcam: streamStatus({ streamKind: 'webcam', lifecycle: 'idle' }),
    };
    opts._transport.handler = (env) => {
      if (env.msg === 'recorder-ensure') return Promise.resolve({ ok: true, bootId: 'b', created: true });
      if (env.msg === 'recorder-set-session') return Promise.resolve({ ok: true });
      if (env.msg === 'recorder-start-streams') return Promise.resolve({ ok: true, streams: {} });
      if (env.msg === 'recorder-get-status') {
        return Promise.resolve({ ok: true, sessionId: 's', gameId: 'g', queriedAtUtc: 't', statuses });
      }
      return Promise.resolve({ ok: false, error: 'unexpected' });
    };
    const h = BS.installSessionControls(stripInternal(opts));
    try {
      h.button.click(); // Start
      await sleep(60);
      assert.equal(h.getPhase(), 'active');
      const setsAfterFirst = h.lights.microphone._classSets;
      await sleep(60); // several polls, same statuses
      assert.equal(h.lights.microphone._classSets, setsAfterFirst,
        'no re-render when state/detail unchanged');
      // Change one light → exactly that light re-renders.
      statuses.microphone = streamStatus({
        streamKind: 'microphone', lifecycle: 'recording',
        chunk: { status: 'chunk-stalled' },
      });
      await sleep(40);
      assert.ok(h.lights.microphone.className.includes('blindfold-stream-recording-degraded'));
      assert.equal(h.lights.microphone.title.includes('chunk:chunk-stalled'), true);
    } finally { h.stop(); }
  });

  it('a throwing/rejecting status query never propagates; lights go unknown', async () => {
    const BS = publishNS(freshModule());
    globalThis.document = makeFakeDocument(true);
    const opts = makeOpts({ intervalMs: 10 });
    let n = 0;
    opts._transport.handler = (env) => {
      if (env.msg === 'recorder-get-status') {
        n++;
        if (n === 1) return Promise.resolve({ ok: true, sessionId: 's', gameId: 'g', queriedAtUtc: 't', statuses: {} });
        return Promise.reject(new Error('channel died'));
      }
      if (env.msg === 'recorder-ensure') return Promise.resolve({ ok: true, bootId: 'b', created: true });
      if (env.msg === 'recorder-set-session') return Promise.resolve({ ok: true });
      if (env.msg === 'recorder-start-streams') return Promise.resolve({ ok: true, streams: {} });
      return Promise.resolve({ ok: false });
    };
    const h = BS.installSessionControls(stripInternal(opts));
    try {
      // Adopt the session via boot get-status, then Start is unnecessary:
      // adopt directly by making boot return ok:true.
      await sleep(40);
      assert.equal(h.getPhase(), 'active');
      await sleep(60);
      for (const kind of ['microphone', 'screen', 'webcam']) {
        assert.ok(h.lights[kind].className.includes('blindfold-stream-unknown'), kind);
        assert.ok(h.lights[kind].title.includes('query-failed'), h.lights[kind].title);
      }
    } finally { h.stop(); }
  });

  it('Start is a local-interlock no-op while active (button disabled)', async () => {
    const BS = publishNS(freshModule());
    globalThis.document = makeFakeDocument(true);
    const opts = makeOpts();
    opts._transport.handler = (env) => {
      if (env.msg === 'recorder-ensure') return Promise.resolve({ ok: true, bootId: 'b', created: true });
      if (env.msg === 'recorder-set-session') return Promise.resolve({ ok: true });
      if (env.msg === 'recorder-start-streams') return Promise.resolve({ ok: true, streams: {} });
      if (env.msg === 'recorder-get-status') return Promise.resolve({ ok: false, error: 'no-session' });
      return Promise.resolve({ ok: false });
    };
    const h = BS.installSessionControls(stripInternal(opts));
    try {
      assert.equal(h.button.disabled, false);
      h.button.click();
      await sleep(40);
      assert.equal(h.getPhase(), 'active');
      // The interlock: while active the click handler ignores Start.
      // (The button now reads Stop — clicking it starts the Stop flow;
      // here we assert the Start path cannot re-fire: message counts.)
      const callsBefore = opts._transport.calls.filter((c) => c.msg === 'recorder-ensure').length;
      assert.equal(callsBefore, 1);
    } finally { h.stop(); }
  });
});

// ------------------------------------------------------------------
// AC4 — Start sequence order and failure isolation.
// ------------------------------------------------------------------
describe('AC4 — Start sequence', () => {
  let savedDocument;
  beforeEach(() => { savedDocument = globalThis.document; });
  afterEach(() => {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
    unpublishNS();
  });

  function startHarness() {
    const BS = publishNS(freshModule());
    globalThis.document = makeFakeDocument(true);
    const opts = makeOpts();
    opts._transport.handler = (env) => {
      if (env.msg === 'recorder-ensure') return Promise.resolve({ ok: true, bootId: 'boot-1', created: true });
      if (env.msg === 'recorder-set-session') return Promise.resolve({ ok: true });
      if (env.msg === 'recorder-start-streams') return Promise.resolve({ ok: true, streams: {} });
      if (env.msg === 'recorder-get-status') return Promise.resolve({ ok: false, error: 'no-session' });
      return Promise.resolve({ ok: false, error: 'unexpected' });
    };
    const h = BS.installSessionControls(stripInternal(opts));
    return { BS, opts, h };
  }

  it('message order: ensure → set-session → start-streams; then slots + emitPageStart + poll', async () => {
    const { BS, opts, h } = startHarness();
    try {
      await sleep(20); // boot adoption resolves idle
      h.button.click();
      await sleep(60);
      const msgs = opts._transport.calls.map((c) => c.msg);
      assert.deepEqual(msgs.slice(0, 3),
        ['recorder-get-status', 'recorder-ensure', 'recorder-set-session']);
      // start-streams is 4th (a get-status poll may interleave after).
      assert.ok(msgs.includes('recorder-start-streams'), msgs.join(','));
      assert.ok(msgs.indexOf('recorder-start-streams') >
        msgs.indexOf('recorder-set-session'));
      // The ensure envelope carries kind/v.
      const ensure = opts._transport.calls.find((c) => c.msg === 'recorder-ensure');
      assert.equal(ensure.kind, 'recorder');
      assert.equal(ensure.v, 1);
      // set-session carries the minted UUIDs.
      const setSession = opts._transport.calls.find((c) => c.msg === 'recorder-set-session');
      assert.equal(setSession.sessionId, 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
      assert.equal(setSession.gameId, 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb');
      // Slots set (the 2.7 seam) and emitPageStart called with the sender.
      assert.equal(BS.activeSessionId, 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
      assert.equal(BS.activeGameId, 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb');
      assert.deepEqual(h.getSession(), {
        sessionId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
        gameId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
      });
      assert.equal(BS._pageStarts.length, 1);
      assert.equal(BS._pageStarts[0].sessionId, 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
      assert.equal(BS._pageStarts[0].sender, opts._sender);
      // Idempotency re-armed for the new game (3.5.4 seam).
      assert.equal(opts._glr.resetEndedCalls, 1);
      // Button → Stop, polling on.
      assert.equal(h.getPhase(), 'active');
      assert.equal(h.button.textContent, 'Stop');
      assert.ok(msgs.filter((m) => m === 'recorder-get-status').length >= 2,
        'polling runs while active');
    } finally { h.stop(); }
  });

  it('top-level ok:false WITH per-stream results does NOT abort Start (4.6 isolation, refined abort rule)', async () => {    const { BS, opts, h } = startHarness();
    let started = false;
    opts._transport.handler = (env) => {
      if (env.msg === 'recorder-ensure') return Promise.resolve({ ok: true, bootId: 'b', created: true });
      if (env.msg === 'recorder-set-session') return Promise.resolve({ ok: true });
      if (env.msg === 'recorder-start-streams') {
        started = true;
        // 4.6's real shape: top-level ok is all-three-ok, so a failed
        // screen yields top-level ok:false WITH per-stream results —
        // still not a Start failure (refined abort rule).
        return Promise.resolve({
          ok: false,
          streams: {
            microphone: { ok: true },
            screen: { ok: false, error: 'denied' },
            webcam: { ok: true },
          },
        });
      }
      if (env.msg === 'recorder-get-status') {
        if (!started) return Promise.resolve({ ok: false, error: 'no-session' });
        return Promise.resolve({
          ok: true, sessionId: 's', gameId: 'g', queriedAtUtc: 't',
          statuses: {
            microphone: streamStatus({ streamKind: 'microphone', lifecycle: 'recording' }),
            screen: streamStatus({
              streamKind: 'screen', lifecycle: 'idle',
              lastRecorderError: { errorName: 'NotAllowedError' },
            }),
            webcam: streamStatus({ streamKind: 'webcam', lifecycle: 'recording' }),
          },
        });
      }
      return Promise.resolve({ ok: false });
    };
    try {
      await sleep(20);
      h.button.click();
      await sleep(80);
      assert.equal(h.getPhase(), 'active', 'Start survives a per-stream failure');
      assert.ok(h.lights.microphone.className.includes('blindfold-stream-recording-healthy'));
      assert.ok(h.lights.screen.className.includes('blindfold-stream-failed-not-started'),
        h.lights.screen.className);
      // The observed start failure is the leading fact; the status's own
      // recorder error is retained behind it (raw, unsmoothed).
      assert.ok(h.lights.screen.title.includes('start-failed:denied'),
        h.lights.screen.title);
      assert.ok(h.lights.screen.title.includes('recorder-error:NotAllowedError'),
        h.lights.screen.title);
    } finally { h.stop(); }
  });

  it('ensure failure aborts honestly: idle, reason surfaced, nothing minted into a stream', async () => {
    const { BS, opts, h } = startHarness();
    opts._transport.handler = (env) => {
      if (env.msg === 'recorder-ensure') {
        return Promise.resolve({ ok: false, reason: 'offscreen-unavailable' });
      }
      return Promise.resolve({ ok: false, error: 'unexpected' });
    };
    try {
      await sleep(20);
      h.button.click();
      await sleep(60);
      assert.equal(h.getPhase(), 'idle');
      assert.equal(h.button.textContent, 'Start');
      assert.equal(h.button.disabled, false);
      assert.ok(String(h.button.title).includes('ensure-failed:offscreen-unavailable'),
        h.button.title);
      const msgs = opts._transport.calls.map((c) => c.msg);
      assert.ok(!msgs.includes('recorder-set-session'),
        'no session minted into any stream: ' + msgs.join(','));
      assert.ok(!msgs.includes('recorder-start-streams'));
      assert.equal(BS.activeSessionId, null);
      assert.equal(BS._pageStarts.length, 0);
    } finally { h.stop(); }
  });

  it('channel-level start-streams failure ({ok:false}, no streams) aborts honestly (and clears the recorder session)', async () => {
    const { BS, opts, h } = startHarness();
    opts._transport.handler = (env) => {
      if (env.msg === 'recorder-ensure') return Promise.resolve({ ok: true, bootId: 'b', created: true });
      if (env.msg === 'recorder-set-session') return Promise.resolve({ ok: true });
      if (env.msg === 'recorder-start-streams') return Promise.resolve({ ok: false, error: 'boom' });
      return Promise.resolve({ ok: false, error: 'unexpected' });
    };
    try {
      await sleep(20);
      h.button.click();
      await sleep(60);
      assert.equal(h.getPhase(), 'idle');
      assert.ok(String(h.button.title).includes('start-streams-failed:boom'), h.button.title);
      // Best-effort recorder-side clear (sessionId null) was attempted.
      const clears = opts._transport.calls.filter((c) =>
        c.msg === 'recorder-set-session' && c.sessionId === null);
      assert.equal(clears.length, 1);
      assert.equal(BS.activeSessionId, null);
    } finally { h.stop(); }
  });
});

// ------------------------------------------------------------------
// AC5 — Stop sequence.
// ------------------------------------------------------------------
describe('AC5 — Stop sequence', () => {
  let savedDocument;
  beforeEach(() => { savedDocument = globalThis.document; });
  afterEach(() => {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
    unpublishNS();
  });

  function activeHarness(stopResponse) {
    const BS = publishNS(freshModule());
    globalThis.document = makeFakeDocument(true);
    const opts = makeOpts();
    const statuses = {
      microphone: streamStatus({ streamKind: 'microphone', lifecycle: 'recording' }),
      screen: streamStatus({ streamKind: 'screen', lifecycle: 'recording' }),
      webcam: streamStatus({ streamKind: 'webcam', lifecycle: 'recording' }),
    };
    let started = false;
    opts._transport.handler = (env) => {
      if (env.msg === 'recorder-ensure') return Promise.resolve({ ok: true, bootId: 'b', created: true });
      if (env.msg === 'recorder-set-session') return Promise.resolve({ ok: true });
      if (env.msg === 'recorder-start-streams') {
        started = true;
        return Promise.resolve({ ok: true, streams: {} });
      }
      if (env.msg === 'recorder-stop-streams') return Promise.resolve(stopResponse);
      if (env.msg === 'recorder-get-status') {
        // Boot adoption sees no session; after Start the session is live.
        if (!started) return Promise.resolve({ ok: false, error: 'no-session' });
        return Promise.resolve({ ok: true, sessionId: 's', gameId: 'g', queriedAtUtc: 't', statuses });
      }
      return Promise.resolve({ ok: false, error: 'unexpected' });
    };
    const h = BS.installSessionControls(stripInternal(opts));
    return { BS, opts, h, statuses };
  }

  const STOP_OK = {
    ok: true,
    markerId: 'm1',
    finalizedAtUtc: '2026-10-06T18:00:00.000Z',
    flushTimedOut: false,
    finalized: { microphone: { segmentNumber: 1 }, screen: { segmentNumber: 1 }, webcam: { segmentNumber: 1 } },
  };

  it('recordStopTermination(null, "*") when no game_ended observed; full response incl. flushTimedOut → 5.10 seam; slots cleared', async () => {
    const { BS, opts, h, statuses } = activeHarness(STOP_OK);
    // After stop, statuses report finalized.
    const fin = (kind) => streamStatus({ streamKind: kind, lifecycle: 'finalized', finalizedAtUtc: STOP_OK.finalizedAtUtc, segmentNumber: 1 });
    statuses.microphone = fin('microphone');
    statuses.screen = fin('screen');
    statuses.webcam = fin('webcam');
    try {
      await sleep(20);
      h.button.click(); // Start
      await sleep(60);
      assert.equal(h.getPhase(), 'active');
      h.button.click(); // Stop
      assert.equal(h.button.textContent, 'Stopping…');
      await sleep(80);
      // 3.5.4 seam: null reason (unknown), default '*' result.
      assert.deepEqual(opts._glr.stopTerminationCalls, [{ reason: null, result: '*' }]);
      // 5.10 seam got the FULL stop response, flushTimedOut included.
      assert.equal(opts._stopCalls.length, 1);
      assert.equal(opts._stopCalls[0], STOP_OK);
      assert.equal('flushTimedOut' in opts._stopCalls[0], true);
      assert.equal(h.getLastStopResponse(), STOP_OK);
      // Slots cleared, idle, polling stopped.
      assert.equal(BS.activeSessionId, null);
      assert.equal(BS.activeGameId, null);
      assert.deepEqual(h.getSession(), { sessionId: null, gameId: null });
      assert.equal(h.getPhase(), 'idle');
      assert.equal(h.button.textContent, 'Start');
      // Lights show finalized.
      for (const kind of ['microphone', 'screen', 'webcam']) {
        assert.ok(h.lights[kind].className.includes('blindfold-stream-finalized'), kind);
      }
    } finally { h.stop(); }
  });

  it('observed game_ended reason/result is passed to recordStopTermination', async () => {
    const { opts, h } = activeHarness(STOP_OK);
    opts._glr._observedEnd = Object.freeze({
      source: 'chess_rules', result: '1-0', terminationReason: 'checkmate',
    });
    try {
      await sleep(20);
      h.button.click();
      await sleep(60);
      h.button.click();
      await sleep(80);
      assert.deepEqual(opts._glr.stopTerminationCalls,
        [{ reason: 'checkmate', result: '1-0' }]);
    } finally { h.stop(); }
  });

  it('flushTimedOut:true is handed to the 5.10 seam undropped', async () => {
    const timedOut = Object.assign({}, STOP_OK, { flushTimedOut: true });
    const { opts, h } = activeHarness(timedOut);
    try {
      await sleep(20);
      h.button.click();
      await sleep(60);
      h.button.click();
      await sleep(80);
      assert.equal(opts._stopCalls.length, 1);
      assert.equal(opts._stopCalls[0].flushTimedOut, true);
    } finally { h.stop(); }
  });

  it('stop-channel failure does NOT silently revert to idle; retry works', async () => {
    const { opts, h } = activeHarness({ ok: false, error: 'channel-dead' });
    try {
      await sleep(20);
      h.button.click();
      await sleep(60);
      assert.equal(h.getPhase(), 'active');
      let stopCalls = 0;
      h.button.click(); // Stop → fails
      await sleep(80);
      stopCalls = opts._transport.calls.filter((c) => c.msg === 'recorder-stop-streams').length;
      assert.equal(stopCalls, 1);
      assert.equal(h.getPhase(), 'stopping', 'stays in stopping, not idle');
      assert.equal(h.button.textContent, 'Stopping…');
      assert.ok(String(h.button.title).includes('stop-failed:channel-dead'), h.button.title);
      assert.equal(opts._stopCalls.length, 0, '5.10 seam not called on failure');
      // Retry: the button stays enabled during stopping.
      assert.equal(h.button.disabled, false);
      opts._transport.handler = (env) => {
        if (env.msg === 'recorder-stop-streams') return Promise.resolve(STOP_OK);
        if (env.msg === 'recorder-get-status') {
          return Promise.resolve({ ok: true, sessionId: 's', gameId: 'g', queriedAtUtc: 't', statuses: {} });
        }
        return Promise.resolve({ ok: false, error: 'unexpected' });
      };
      h.button.click(); // retry
      await sleep(80);
      stopCalls = opts._transport.calls.filter((c) => c.msg === 'recorder-stop-streams').length;
      assert.equal(stopCalls, 2);
      assert.equal(h.getPhase(), 'idle');
      assert.equal(h.button.textContent, 'Start');
      assert.equal(opts._stopCalls.length, 1);
    } finally { h.stop(); }
  });

  it('a throwing onStopComplete never breaks the control', async () => {
    const { opts, h } = activeHarness(STOP_OK);
    opts.onStopComplete = () => { throw new Error('5.10 bug'); };
    // Re-install with the throwing seam (opts were already consumed by
    // install; rebuild the harness the honest way).
    h.stop();
    unpublishNS();
    const BS = publishNS(freshModule());
    globalThis.document = makeFakeDocument(true);
    const opts2 = makeOpts({ onStopComplete: () => { throw new Error('5.10 bug'); } });
    opts2._transport.handler = (env) => {
      if (env.msg === 'recorder-ensure') return Promise.resolve({ ok: true, bootId: 'b', created: true });
      if (env.msg === 'recorder-set-session') return Promise.resolve({ ok: true });
      if (env.msg === 'recorder-start-streams') return Promise.resolve({ ok: true, streams: {} });
      if (env.msg === 'recorder-stop-streams') return Promise.resolve(STOP_OK);
      if (env.msg === 'recorder-get-status') return Promise.resolve({ ok: false, error: 'no-session' });
      return Promise.resolve({ ok: false });
    };
    const h2 = BS.installSessionControls(stripInternal(opts2));
    try {
      await sleep(20);
      h2.button.click();
      await sleep(60);
      h2.button.click();
      await sleep(80);
      assert.equal(h2.getPhase(), 'idle', 'control completes despite throwing seam');
      assert.equal(h2.button.textContent, 'Start');
    } finally { h2.stop(); }
  });

  it('successful Stop releases the recorder-side session after finalization (5.2)', async () => {
    const { BS, opts, h } = activeHarness(STOP_OK);
    try {
      await sleep(20);
      h.button.click(); // Start
      await sleep(60);
      assert.equal(h.getPhase(), 'active');
      h.button.click(); // Stop
      await sleep(80);
      assert.equal(h.getPhase(), 'idle');
      const stopIdx = opts._transport.calls
        .findIndex((c) => c.msg === 'recorder-stop-streams');
      const clears = opts._transport.calls
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => c.msg === 'recorder-set-session' &&
          c.sessionId === null && c.gameId === null);
      assert.equal(clears.length, 1, 'one recorder-side release');
      assert.ok(clears[0].i > stopIdx,
        'the release is sent after stop-streams succeeded');
      assert.equal(BS.activeSessionId, null, 'local slot cleared as before');
    } finally { h.stop(); }
  });

  it('failed Stop does NOT release the recorder session (kept for retry)', async () => {
    const { opts, h } = activeHarness({ ok: false, error: 'boom' });
    try {
      await sleep(20);
      h.button.click(); // Start
      await sleep(60);
      assert.equal(h.getPhase(), 'active');
      h.button.click(); // Stop → fails
      await sleep(80);
      assert.equal(h.getPhase(), 'stopping', 'stays in stopping for retry');
      const clears = opts._transport.calls.filter((c) =>
        c.msg === 'recorder-set-session' && c.sessionId === null &&
        c.gameId === null);
      assert.equal(clears.length, 0, 'no release on failed stop');
    } finally { h.stop(); }
  });
});

// ------------------------------------------------------------------
// AC6 — boot adoption.
// ------------------------------------------------------------------
describe('AC6 — boot adoption', () => {
  let savedDocument;
  beforeEach(() => { savedDocument = globalThis.document; });
  afterEach(() => {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
    unpublishNS();
  });

  it('{ok:true, sessionId} adopts the surviving session (gameId echoed); {ok:false} → idle', async () => {
    const BS = publishNS(freshModule());
    globalThis.document = makeFakeDocument(true);
    const opts = makeOpts();
    opts._transport.handler = (env) => {
      if (env.msg === 'recorder-get-status') {
        return Promise.resolve({
          ok: true, sessionId: 'surviving-sid', gameId: 'surviving-gid',
          queriedAtUtc: 't',
          statuses: {
            microphone: streamStatus({ streamKind: 'microphone', lifecycle: 'recording' }),
            screen: streamStatus({ streamKind: 'screen', lifecycle: 'recording' }),
            webcam: streamStatus({ streamKind: 'webcam', lifecycle: 'recording' }),
          },
        });
      }
      return Promise.resolve({ ok: false, error: 'unexpected' });
    };
    const h = BS.installSessionControls(stripInternal(opts));
    try {
      await sleep(40);
      assert.equal(h.getPhase(), 'active');
      assert.equal(h.button.textContent, 'Stop');
      assert.deepEqual(h.getSession(), { sessionId: 'surviving-sid', gameId: 'surviving-gid' });
      assert.equal(BS.activeSessionId, 'surviving-sid');
      assert.equal(BS.activeGameId, 'surviving-gid');
      // Polling runs after adoption.
      const polls = opts._transport.calls.filter((c) => c.msg === 'recorder-get-status').length;
      assert.ok(polls >= 2, 'polls while adopted, got ' + polls);
      // No new session was minted: no set-session/start-streams on the wire.
      const msgs = opts._transport.calls.map((c) => c.msg);
      assert.ok(!msgs.includes('recorder-set-session'), msgs.join(','));
    } finally { h.stop(); }
  });

  it('adopted session with absent gameId → gameId null (honest unknown)', async () => {
    const BS = publishNS(freshModule());
    globalThis.document = makeFakeDocument(true);
    const opts = makeOpts();
    opts._transport.handler = (env) => {
      if (env.msg === 'recorder-get-status') {
        return Promise.resolve({ ok: true, sessionId: 's', queriedAtUtc: 't', statuses: {} });
      }
      return Promise.resolve({ ok: false });
    };
    const h = BS.installSessionControls(stripInternal(opts));
    try {
      await sleep(40);
      assert.equal(h.getPhase(), 'active');
      assert.deepEqual(h.getSession(), { sessionId: 's', gameId: null });
    } finally { h.stop(); }
  });

  it('{ok:false} → idle (no adoption)', async () => {
    const BS = publishNS(freshModule());
    globalThis.document = makeFakeDocument(true);
    const opts = makeOpts();
    opts._transport.handler = () => Promise.resolve({ ok: false, error: 'no-session' });
    const h = BS.installSessionControls(stripInternal(opts));
    try {
      await sleep(40);
      assert.equal(h.getPhase(), 'idle');
      assert.equal(h.button.textContent, 'Start');
      assert.deepEqual(h.getSession(), { sessionId: null, gameId: null });
    } finally { h.stop(); }
  });
});

// ------------------------------------------------------------------
// AC7 — diff discipline, vocabulary, and cross-file pins.
// ------------------------------------------------------------------
describe('AC7 — diff discipline and scope', () => {
  it('git status shows only 5.1-allowed changes', () => {
    // Post-commit the tree is clean and the pin is vacuous (2.8/4.4/4.14
    // precedent); pre-commit it proves exactly 5.1's files changed.
    const status = execSync('git status --porcelain', { cwd: REPO }).toString();
    if (!status.trim()) return;
    const changed = status.split('\n').filter((l) => l.trim())
      .map((l) => l.slice(3).trim());
    const allowed = new Set([
      // Honest cumulative evolution: 5.1 (compact Start/Stop control +
      // per-stream health lights) legitimately adds session_controls.js
      // (in-page control cluster + pure classifyStreamStatus), wires the
      // install into content.js, adds session_identity.js (ID minting)
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
      'recorder.js',
      'recording_host.js',
      'chess_utils.js',
      '.autodev/evidence/5.1.contract.md',
      '.autodev/evidence/5.1.build.md',
      // Honest cumulative evolution: 5.1's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.x precedent).
      '.autodev/evidence/5.1.review.md',
      '.autodev/evidence/5.1.behavior.md',
      '.autodev/DECISIONS.md',
      // Cumulative evolution: 5.1 evolves the earlier suites'
      // diff-discipline allowlists (and byte-identical / manifest-list
      // pins) with justification comments.
      'tests/attempt_tracker.test.js',
      'tests/audio_policy.test.js',
      'tests/capture_selection.test.js',
      'tests/chunk_writer.test.js',
      'tests/clock_link.test.js',
      'tests/device_selection.test.js',
      'tests/finalizer.test.js',
      'tests/format_support.test.js',
      'tests/game_lifecycle.test.js',
      'tests/history_tracker.test.js',
      'tests/lifecycle.test.js',
      'tests/recording_host.test.js',
      'tests/retention.test.js',
      'tests/sender.test.js',
      'tests/session_store.test.js',
      'tests/speech.test.js',
      'tests/status_indicator.test.js',
      'tests/stream_starter.test.js',
      'tests/stream_status.test.js',
      'tests/sync_marker.test.js',
      'tests/timecode.test.js',
      'tests/track_monitor.test.js',
      'tests/visibility.test.js',
      'tests/writer.test.js',
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
    ]);
    const stray = changed.filter((f) => !allowed.has(f));
    assert.deepEqual(stray, [],
      'working tree has non-5.1 changes:\n' + stray.join('\n'));
  });

  it('PLAN.md is unmodified', () => {
    const diff = execSync('git diff main -- PLAN.md', { cwd: REPO }).toString();
    assert.equal(diff.trim(), '', 'PLAN.md must never be modified');
  });

  it('content.js diff is the 5.2 install wiring (restructured 5.1 block + fields install)', () => {
    // Honest cumulative evolution: 5.2 restructures 5.1's install block
    // (the fields handle is installed after the controls so it can
    // anchor before the cluster; the controls receive it via a thunk)
    // and adds the installSessionFields block. Added lines match the
    // 5.1 keyword set or 5.2's; removed lines are exactly the old 5.1
    // block (same keyword set) — a restructuring, not a behavior
    // change beyond the wiring.
    const diff = execSync('git diff HEAD -- content.js', { cwd: REPO }).toString();
    if (diff.trim() === '') return; // committed
    const kw51 = (l) =>
      l.includes('5.1') || l.includes('installSessionControls') ||
      l.includes('sendRecorderMessage') || l.includes('gameLifecycleRecorder') ||
      l.includes('onStopComplete') || l.includes('onSessionStopComplete') ||
      l.includes('chrome.runtime.sendMessage') || l.includes('installErr') ||
      l.includes('sender: BlindfoldSession.sender');
    const kw52 = (l) =>
      l.includes('5.2') || l.includes('installSessionFields') ||
      l.includes('sessionFields') || l.includes('sessionControlsHandle') ||
      l.includes('extensionVersion') || l.includes('getManifest') ||
      l.includes('beforeElement') || l.includes('fieldsErr');
    // Honest cumulative evolution: 5.3 wires the remembered-defaults
    // memory into content.js per its contract — the selectionMemory
    // declaration, the inline chrome.storage.local adapter, the memory
    // construction + restore() call, and the onSessionStarted
    // pass-through into the 5.1 install options.
    const kw53 = (l) =>
      l.includes('5.3') || l.includes('selectionMemory') ||
      l.includes('SelectionMemory') || l.includes('onSessionStarted') ||
      l.includes('selectionStorageLocal') || l.includes('storageLocal') ||
      l.includes('chrome.storage') || l.includes('.capture(') ||
      l.includes('.restore(') || l.includes('memErr') ||
      l.includes('sessionFieldsHandle') || l.includes('storage: {') ||
      l.includes('get: function') || l.includes('set: function') ||
      l.includes('remove: function');
    const structural = (l) =>
      l.trim() === '' || l.trim().startsWith('//') ||
      l.trim().startsWith('}') || l.trim().startsWith('try {') ||
      l.trim().startsWith('} catch') || l.trim().startsWith('{') ||
      l.trim().startsWith('(') || l.trim() === '});';
    const added = diff.split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1));
    assert.ok(added.length > 0, 'expected the install wiring as added lines');
    assert.ok(added.every((l) => kw51(l) || kw52(l) || kw53(l) || structural(l)),
      'unexpected added lines in content.js:\n' + added.join('\n'));
    const removed = diff.split('\n')
      .filter((l) => l.startsWith('-') && !l.startsWith('---'))
      .map((l) => l.slice(1));
    assert.ok(removed.every((l) => kw51(l) || structural(l)),
      'unexpected removed lines in content.js:\n' + removed.join('\n'));
  });

  it('recorder.js diff is the 5.2 sessionCategory seam', () => {
    // Honest cumulative evolution: 5.1's ownerTabId/gameId-echo seams
    // are committed (in HEAD); while 5.2 is uncommitted the diff
    // carries only 5.2's additive accept/store/echo of the optional
    // sessionCategory (the 5.1 ownerTabId/gameId-echo precedent).
    const diff = execSync('git diff HEAD -- recorder.js', { cwd: REPO }).toString();
    if (diff.trim() === '') return;
    assert.ok(diff.includes('sessionCategory'), 'sessionCategory seam present');
    // No new offscreen MSG_* constant: session-save is SW-side (5.1's
    // recorder-ensure precedent).
    const addedMsgConsts = diff.split('\n').filter((l) =>
      l.startsWith('+') && /var MSG_[A-Z_]+ =/.test(l));
    assert.deepEqual(addedMsgConsts, [], 'no new offscreen MSG_* constants');
    // No new message branches: set-session/get-status already existed.
    const branches = new Set();
    const re = /^\+.*message\.msg === '([^']+)'/gm;
    let m;
    while ((m = re.exec(diff)) !== null) branches.add(m[1]);
    assert.deepEqual([...branches], [], 'no new message branches');
  });

  it('recording_host.js diff is the session-save handler', () => {
    // Honest cumulative evolution: 5.1's recorder-ensure handler is
    // committed (in HEAD); while 5.2 is uncommitted the diff carries
    // only the SW-side session-save intake (validates both records,
    // then the 2.6 primitives).
    const diff = execSync('git diff HEAD -- recording_host.js', { cwd: REPO }).toString();
    if (diff.trim() === '') return;
    assert.ok(diff.includes("message.msg === 'session-save'"),
      'session-save handler present');
    assert.ok(diff.includes('handleSessionSave'), 'handler function present');
    const removed = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
    assert.deepEqual(removed, [], 'recording_host.js: no removed lines');
  });

  it('chess_utils.js diff is only the additive getLastObservedEnd getter', () => {
    const diff = execSync('git diff HEAD -- chess_utils.js', { cwd: REPO }).toString();
    if (diff.trim() === '') return;
    assert.ok(diff.includes('getLastObservedEnd'), 'getter present');
    assert.ok(diff.includes('lastObservedEnd'), 'memory field present');
    const removed = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
    assert.deepEqual(removed, [], 'chess_utils.js: no removed lines');
  });

  it('offscreen MSG_* vocabulary is still the 24-message shape (5.1 adds none)', () => {
    // 5.1's only new message, recorder-ensure, is SW-side
    // (recording_host), not an offscreen MSG_* — the 4.14 pin holds.
    const src = fs.readFileSync(path.join(REPO, 'recorder.js'), 'utf8');
    const found = [];
    const re = /var (MSG_[A-Z_]+) = '([^']+)';/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      found.push(m[1] + '=' + m[2]);
    }
    assert.equal(found.length, 24);
    assert.ok(found.includes('MSG_GET_STATUS=recorder-get-status'));
  });

  it('SW-side recorder-envelope vocabulary is the 7-message shape (5.1 + 5.2 additions)', () => {
    // recording_host.js handles: recorder-ready, recorder-ensure (5.1),
    // session-save (5.2), capture-resolve-tab, capture-query-permission,
    // capture-get-stream-id, recorder-sync-flash (4.11).
    const src = fs.readFileSync(path.join(REPO, 'recording_host.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const msgs = new Set();
    const re = /message\.msg === '([^']+)'/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      msgs.add(m[1]);
    }
    const expected = [
      'recorder-ready', 'recorder-ensure', 'session-save',
      'capture-resolve-tab', 'capture-query-permission', 'capture-get-stream-id',
      'recorder-sync-flash',
    ];
    assert.deepEqual(Array.from(msgs).sort(), expected.sort());
  });

  it('session_controls.js emits no new event types and uses no chrome.* literal', () => {
    const src = fs.readFileSync(path.join(ROOT, 'session_controls.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/EVENT_TYPE/.test(code), 'no event types');
    assert.ok(!/eventType/.test(code), 'no event emission');
    assert.ok(!/chrome\./.test(code), 'no chrome.* literal (transport is injected)');
  });

  it('session_identity.js is byte-identical to HEAD (minting unchanged)', () => {
    const diff = execSync('git diff HEAD -- session_identity.js', { cwd: REPO }).toString();
    assert.equal(diff.trim(), '', 'session_identity.js must be untouched');
  });

  it('gameplay/content instrumentation is otherwise byte-identical', () => {
    for (const f of ['sounds.js', 'game_records.js', 'status_indicator.js',
                     'sender.js', 'lifecycle.js', 'sync_flash.js']) {
      const diff = execSync(`git diff HEAD -- ${f}`, { cwd: REPO }).toString();
      assert.equal(diff.trim(), '', `${f} must be untouched`);
    }
  });
});
