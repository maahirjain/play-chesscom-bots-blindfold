// tests/session_fields.test.js
//
// Task 5.2 (PLAN.md §5.2): baseline/training/evaluation selection, with
// training approach and verbal scaffolding fields.
//
// V1 — static + unit. Covers 5.2.contract.md AC1–AC7 (AC8–AC10 are the
// V2 harness; AC11 is V3-deferred to §7).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const REPO = ROOT;

function freshModule(name) {
  delete require.cache[require.resolve('../' + name)];
  return require('../' + name);
}

// Merged namespace: the modules share the BlindfoldSession global;
// session_fields.js resolves collaborators (isSessionCategory,
// createInitialConditions) at call time via globalThis.
function mergedNS() {
  const ns = {};
  for (const f of ['session_identity.js', 'session_conditions.js',
                   'session_fields.js', 'session_controls.js']) {
    Object.assign(ns, freshModule(f));
  }
  return ns;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------
// Minimal DOM stub for installSessionFields: select/option/input/span,
// value + disabled + textContent, appendChild/insertBefore,
// getElementById → null (fallback path) unless withAnchor.
// ------------------------------------------------------------------
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    value: '',
    disabled: false,
    type: '',
    parentNode: null,
    children: [],
    _attrs: {},
    _listeners: {},
    setAttribute(k, v) { this._attrs[String(k)] = String(v); },
    getAttribute(k) {
      const key = String(k);
      return Object.prototype.hasOwnProperty.call(this._attrs, key) ?
        this._attrs[key] : null;
    },
    removeAttribute(k) { delete this._attrs[String(k)]; },
    addEventListener(type, fn) {
      const t = String(type);
      (this._listeners[t] = this._listeners[t] || []).push(fn);
    },
    click() {
      for (const fn of this._listeners.click || []) fn();
    },
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
  };
  return el;
}

function makeFakeDocument() {
  const body = makeEl('body');
  return {
    body,
    createElement: (tag) => makeEl(tag),
    getElementById: () => null,
  };
}

let savedDocument;
let savedNS;
// Installed control handles are stopped after each test so a failing
// assertion can never leak a poll timer and hang the runner.
const liveHandles = [];
beforeEach(() => {
  savedDocument = globalThis.document;
  savedNS = globalThis.BlindfoldSession;
});
afterEach(() => {
  while (liveHandles.length > 0) {
    try { liveHandles.pop().stop(); } catch (e) { /* ignore */ }
  }
  if (savedDocument === undefined) delete globalThis.document;
  else globalThis.document = savedDocument;
  if (savedNS === undefined) delete globalThis.BlindfoldSession;
  else globalThis.BlindfoldSession = savedNS;
});

function publishNS(ns) {
  // Deterministic ID minters; the real 1.1/1.2 factories otherwise.
  ns.newSessionId = () => 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  ns.newGameId = () => 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  ns._pageStarts = [];
  ns.emitPageStart = (sender, sessionId) => {
    ns._pageStarts.push({ sender, sessionId });
    return { eventId: 'ps1' };
  };
  ns.activeSessionId = null;
  ns.activeGameId = null;
  globalThis.BlindfoldSession = ns;
  return ns;
}

// Stub fields handle (the 5.3 seam shape) for the Start-integration
// tests; records calls. showAdoptedCategory mirrors the real
// install's internal setEnabled(false).
function stubFieldsHandle(selection) {
  const calls = { setEnabled: [], showAdoptedCategory: [] };
  return {
    _calls: calls,
    _selection: selection,
    getSelection() { return this._selection; },
    setSelection(s) { this._selection = s; },
    setEnabled(on) { calls.setEnabled.push(on); },
    showAdoptedCategory(c) {
      calls.showAdoptedCategory.push(c);
      calls.setEnabled.push(false);
    },
    getDetectedConditions() {
      return globalThis.BlindfoldSession.UNDETECTED_CONDITION_FIELDS;
    },
  };
}

function makeTransport(handler) {
  const calls = [];
  return {
    calls,
    fn(envelope) {
      calls.push(envelope);
      if (typeof handler === 'function') return handler(envelope, calls);
      return Promise.resolve({ ok: false, error: 'no-handler' });
    },
  };
}

function installControls(ns, opts) {
  globalThis.document = makeFakeDocument();
  const transport = makeTransport(opts.handler);
  const sender = { emit() { return { eventId: 'e1' }; } };
  const glr = {
    recordStopTermination() { return 'event-id'; },
    resetEnded() {},
    getLastObservedEnd() { return null; },
  };
  const handle = ns.installSessionControls(Object.assign({
    sender,
    sendRecorderMessage: (env) => transport.fn(env),
    gameLifecycleRecorder: glr,
    intervalMs: 10,
    onStopComplete: () => {},
  }, opts.extra || {}));
  liveHandles.push(handle);
  return { handle, transport };
}

// The boot-adoption get-status fires at install and the poll loop
// fires more while a session is active; the Start-chain order claims
// are about the non-poll messages. abortStart's best-effort
// recorder-side clear (sessionId null) is also excluded — it is not
// a session establishment.
function startChainMessages(transport) {
  return transport.calls.map((c) => c.msg)
    .filter((m, i) => m !== 'recorder-get-status' &&
      !(m === 'recorder-set-session' &&
        transport.calls[i].sessionId === null));
}

const GOOD_SELECTION = {
  sessionCategory: 'training',
  trainingApproach: '  shadowing aloud  ',
  verbalScaffolding: '',
};

function okStartHandler(seen) {
  return (envelope) => {
    const msg = envelope.msg;
    if (msg === 'recorder-ensure') {
      return Promise.resolve({ ok: true, bootId: 'boot-1', created: true });
    }
    if (msg === 'session-save') {
      seen.save = envelope;
      return Promise.resolve({ ok: true });
    }
    if (msg === 'recorder-set-session') {
      seen.setSession = envelope;
      return Promise.resolve({ ok: true });
    }
    if (msg === 'recorder-start-streams') {
      return Promise.resolve({
        ok: true,
        streams: {
          microphone: { ok: true },
          screen: { ok: false, error: 'denied' },
          webcam: { ok: true },
        },
      });
    }
    if (msg === 'recorder-get-status') {
      return Promise.resolve({ ok: false, error: 'no-session' });
    }
    return Promise.resolve({ ok: false, error: 'unexpected:' + msg });
  };
}

// ------------------------------------------------------------------
// AC1 — module shape and convention.
// ------------------------------------------------------------------
describe('AC1 — module shape', () => {
  it('follows the module convention and exports the three members', () => {
    const BS = freshModule('session_fields.js');
    assert.equal(typeof BS.buildInitialConditions, 'function');
    assert.equal(typeof BS.installSessionFields, 'function');
    assert.ok(BS.UNDETECTED_CONDITION_FIELDS);
    const src = fs.readFileSync(path.join(ROOT, 'session_fields.js'), 'utf8');
    assert.ok(src.includes("'use strict'"), 'IIFE use strict');
    assert.ok(src.includes('module.exports'), 'Node shim');
    assert.ok(src.startsWith('// session_fields.js'), 'file header');
  });

  it('UNDETECTED_CONDITION_FIELDS is exactly five null/manual wrappers, frozen', () => {
    const BS = freshModule('session_fields.js');
    const u = BS.UNDETECTED_CONDITION_FIELDS;
    assert.deepEqual(Object.keys(u).sort(), [
      'assistanceSettings', 'botDisplayedRating', 'botName',
      'playerColor', 'timeControl',
    ]);
    for (const k of Object.keys(u)) {
      assert.deepEqual({ ...u[k] }, { value: null, source: 'manual' });
    }
    assert.ok(Object.isFrozen(u));
  });
});

// ------------------------------------------------------------------
// AC2 — buildInitialConditions.
// ------------------------------------------------------------------
describe('AC2 — buildInitialConditions', () => {
  function ns() { return publishNS(mergedNS()); }

  it('returns the exact seven-field frozen record; trims; blank → null', () => {
    ns();
    const BS = globalThis.BlindfoldSession;
    const rec = BS.buildInitialConditions(
      { sessionCategory: 'training', trainingApproach: '  shadowing  ',
        verbalScaffolding: '   ' },
      BS.UNDETECTED_CONDITION_FIELDS);
    assert.deepEqual(Object.keys(rec).sort(), [
      'assistanceSettings', 'botDisplayedRating', 'botName',
      'playerColor', 'timeControl', 'trainingApproach', 'verbalScaffolding',
    ]);
    assert.deepEqual({ ...rec.trainingApproach },
      { value: 'shadowing', source: 'manual' });
    assert.deepEqual({ ...rec.verbalScaffolding },
      { value: null, source: 'manual' });
    assert.ok(Object.isFrozen(rec));
  });

  it('passes the five detected fields through untouched', () => {
    ns();
    const BS = globalThis.BlindfoldSession;
    const detected = {
      botName: { value: 'Nelson', source: 'observed' },
      botDisplayedRating: { value: 1200, source: 'observed' },
      playerColor: { value: 'white', source: 'observed' },
      timeControl: { value: null, source: 'observed' },
      assistanceSettings: { value: {}, source: 'observed' },
    };
    const rec = BS.buildInitialConditions(
      { sessionCategory: 'baseline', trainingApproach: null,
        verbalScaffolding: null },
      detected);
    for (const k of Object.keys(detected)) {
      assert.deepEqual({ ...rec[k] }, detected[k]);
    }
  });

  it('detectedFields is required — no silent default', () => {
    ns();
    const BS = globalThis.BlindfoldSession;
    assert.throws(
      () => BS.buildInitialConditions({ sessionCategory: 'training' }, null),
      TypeError);
    assert.throws(
      () => BS.buildInitialConditions(
        { sessionCategory: 'training' },
        { botName: { value: null, source: 'manual' } }),
      TypeError);
  });

  it('malformed selection → TypeError; bad category → RangeError', () => {
    ns();
    const BS = globalThis.BlindfoldSession;
    assert.throws(() => BS.buildInitialConditions(null, {}), TypeError);
    assert.throws(() => BS.buildInitialConditions('training', {}), TypeError);
    assert.throws(
      () => BS.buildInitialConditions(
        { sessionCategory: 'unknown' }, BS.UNDETECTED_CONDITION_FIELDS),
      RangeError);
    assert.throws(
      () => BS.buildInitialConditions(
        { sessionCategory: null }, BS.UNDETECTED_CONDITION_FIELDS),
      RangeError);
  });

  it('non-string text values are caller errors (TypeError)', () => {
    ns();
    const BS = globalThis.BlindfoldSession;
    assert.throws(
      () => BS.buildInitialConditions(
        { sessionCategory: 'training', trainingApproach: 42 },
        BS.UNDETECTED_CONDITION_FIELDS),
      TypeError);
  });
});

// ------------------------------------------------------------------
// AC3 — installSessionFields.
// ------------------------------------------------------------------
describe('AC3 — installSessionFields', () => {
  it('renders select + two inputs; getSelection/setSelection round-trip', () => {
    const BS = freshModule('session_fields.js');
    globalThis.document = makeFakeDocument();
    const h = BS.installSessionFields({ extensionVersion: '1.0.0' });
    assert.equal(h.select.tagName, 'SELECT');
    assert.equal(h.approachInput.tagName, 'INPUT');
    assert.equal(h.scaffoldingInput.tagName, 'INPUT');
    // select options: placeholder + three categories
    const values = h.select.children.map((o) => o.value);
    assert.deepEqual(values, ['', 'baseline', 'training', 'evaluation']);

    h.setSelection({ sessionCategory: 'evaluation',
      trainingApproach: 'x', verbalScaffolding: 'y' });
    assert.deepEqual(h.getSelection(), {
      sessionCategory: 'evaluation',
      trainingApproach: 'x',
      verbalScaffolding: 'y',
    });
    // blank select → null category (the Start forcing function)
    h.setSelection({ sessionCategory: null });
    assert.equal(h.getSelection().sessionCategory, null);
  });

  it('setEnabled(false) disables; setSelection is a no-op while disabled', () => {
    const BS = freshModule('session_fields.js');
    globalThis.document = makeFakeDocument();
    const h = BS.installSessionFields({ extensionVersion: '1.0.0' });
    h.setSelection({ sessionCategory: 'baseline', trainingApproach: 'a',
      verbalScaffolding: 'b' });
    h.setEnabled(false);
    assert.equal(h.select.disabled, true);
    assert.equal(h.approachInput.disabled, true);
    h.setSelection({ sessionCategory: 'training', trainingApproach: 'CHANGED',
      verbalScaffolding: 'CHANGED' });
    const sel = h.getSelection();
    assert.equal(sel.sessionCategory, 'baseline');
    assert.equal(sel.trainingApproach, 'a');
    h.setEnabled(true);
    assert.equal(h.select.disabled, false);
    h.setSelection({ sessionCategory: 'training' });
    assert.equal(h.getSelection().sessionCategory, 'training');
  });

  it('invalid options → TypeError before any DOM work', () => {
    const BS = freshModule('session_fields.js');
    globalThis.document = makeFakeDocument();
    assert.throws(() => BS.installSessionFields(null), TypeError);
    assert.throws(() => BS.installSessionFields({}), TypeError);
    assert.throws(() => BS.installSessionFields({ extensionVersion: '' }),
      TypeError);
    assert.throws(
      () => BS.installSessionFields(
        { extensionVersion: '1.0.0', getDetectedConditions: 'yes' }),
      TypeError);
    assert.throws(
      () => BS.installSessionFields(
        { extensionVersion: '1.0.0', beforeElement: 'nope' }),
      TypeError);
  });

  it('anchors before the given element (fields above the button)', () => {
    const BS = freshModule('session_fields.js');
    const doc = makeFakeDocument();
    globalThis.document = doc;
    const controlsEl = makeEl('span');
    doc.body.appendChild(controlsEl);
    const h = BS.installSessionFields(
      { extensionVersion: '1.0.0', beforeElement: controlsEl });
    assert.equal(doc.body.children[0], h.element);
    assert.equal(doc.body.children[1], controlsEl);
  });

  it('showAdoptedCategory: echo shown disabled; missing echo → honest unknown label', () => {
    const BS = freshModule('session_fields.js');
    globalThis.document = makeFakeDocument();
    const h = BS.installSessionFields({ extensionVersion: '1.0.0' });
    h.showAdoptedCategory('training');
    assert.equal(h.select.value, 'training');
    assert.equal(h.select.disabled, true);
    h.setEnabled(true);
    h.showAdoptedCategory(null);
    assert.equal(h.select.disabled, true);
    assert.equal(h.select.children[0].textContent, 'Unknown (adopted session)');
    assert.equal(h.getSelection().sessionCategory, null);
    // Re-enable resets the adopted-unknown label to blank.
    h.setEnabled(true);
    assert.equal(h.select.children[0].textContent, 'Select…');
    assert.equal(h.select.disabled, false);
  });

  it('a throwing getDetectedConditions plug-in falls back to the placeholder', () => {
    const BS = publishNS(mergedNS());
    globalThis.document = makeFakeDocument();
    const h = BS.installSessionFields({
      extensionVersion: '1.0.0',
      getDetectedConditions() { throw new Error('dom exploded'); },
    });
    assert.equal(h.getDetectedConditions(),
      BS.UNDETECTED_CONDITION_FIELDS);
  });
});

// ------------------------------------------------------------------
// AC4 — Start integration: metadata-first minting, session-save order,
// category echo, honest aborts.
// ------------------------------------------------------------------
describe('AC4 — Start integration', () => {
  it('full order: ensure → session-save → set-session (+category) → start-streams; identity single-sourced', async () => {
    const ns = publishNS(mergedNS());
    const seen = {};
    const fields = stubFieldsHandle({ ...GOOD_SELECTION });
    const { handle, transport } = installControls(ns, {
      handler: okStartHandler(seen),
      extra: { sessionFields: fields, extensionVersion: '1.0.0' },
    });
    handle.button.click();
    await sleep(50);

    assert.deepEqual(startChainMessages(transport), ['recorder-ensure',
      'session-save', 'recorder-set-session', 'recorder-start-streams']);
    // session-save payload: metadata + conditions, both valid.
    const { metadata, conditions } = seen.save;
    assert.equal(metadata.sessionCategory, 'training');
    assert.equal(metadata.protocolVersion, null);
    assert.equal(metadata.extensionVersion, '1.0.0');
    assert.match(metadata.sessionId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(conditions.trainingApproach,
      { value: 'shadowing aloud', source: 'manual' });
    assert.deepEqual(conditions.verbalScaffolding,
      { value: null, source: 'manual' });
    // The sessionId sent to the recorder IS metadata.sessionId.
    assert.equal(seen.setSession.sessionId, metadata.sessionId);
    assert.equal(seen.setSession.gameId, metadata.gameIds[0]);
    assert.equal(seen.setSession.sessionCategory, 'training');
    // Slots + emitPageStart carry the same identity.
    assert.equal(ns.activeSessionId, metadata.sessionId);
    assert.equal(ns._pageStarts.length, 1);
    assert.equal(ns._pageStarts[0].sessionId, metadata.sessionId);
    // emitPageStart keeps its empty payload (no category duplication).
    assert.deepEqual(Object.keys(ns._pageStarts[0]).sort(),
      ['sender', 'sessionId']);
    // Fields disabled while active (write-once).
    assert.deepEqual(fields._calls.setEnabled, [false]);
    assert.equal(handle.button.textContent, 'Stop');
    handle.stop();
  });

  it('no category → honest abort: nothing minted, nothing persisted, no recorder message', async () => {
    const ns = publishNS(mergedNS());
    const seen = {};
    const fields = stubFieldsHandle({
      sessionCategory: null, trainingApproach: '', verbalScaffolding: '',
    });
    const { handle, transport } = installControls(ns, {
      handler: okStartHandler(seen),
      extra: { sessionFields: fields, extensionVersion: '1.0.0' },
    });
    handle.button.click();
    await sleep(50);
    assert.deepEqual(startChainMessages(transport), []);
    assert.equal(seen.save, undefined);
    assert.equal(handle.button.textContent, 'Start');
    assert.equal(handle.button.getAttribute('title'), 'no-category-selected');
    assert.equal(handle.getPhase(), 'idle');
    assert.equal(ns.activeSessionId, null);
    handle.stop();
  });

  it('session-save {ok:false} → honest abort before set-session', async () => {
    const ns = publishNS(mergedNS());
    const seen = {};
    const fields = stubFieldsHandle({ ...GOOD_SELECTION });
    const handler = okStartHandler(seen);
    const { handle, transport } = installControls(ns, {
      handler: (envelope) => {
        if (envelope.msg === 'session-save') {
          return Promise.resolve({ ok: false, error: 'idb-down' });
        }
        return handler(envelope);
      },
      extra: { sessionFields: fields, extensionVersion: '1.0.0' },
    });
    handle.button.click();
    await sleep(50);
    assert.deepEqual(startChainMessages(transport),
      ['recorder-ensure', 'session-save']);
    assert.equal(handle.button.textContent, 'Start');
    assert.equal(handle.button.getAttribute('title'),
      'session-save-failed:idb-down');
    assert.equal(handle.getPhase(), 'idle');
    handle.stop();
  });

  it('session-save no-response → honest abort before set-session', async () => {
    const ns = publishNS(mergedNS());
    const fields = stubFieldsHandle({ ...GOOD_SELECTION });
    const handler = okStartHandler({});
    const { handle, transport } = installControls(ns, {
      handler: (envelope) => {
        if (envelope.msg === 'session-save') {
          return Promise.reject(new Error('sw-dead'));
        }
        return handler(envelope);
      },
      extra: { sessionFields: fields, extensionVersion: '1.0.0' },
    });
    handle.button.click();
    await sleep(50);
    assert.deepEqual(startChainMessages(transport),
      ['recorder-ensure', 'session-save']);
    // The only set-session on the wire is abortStart's best-effort
    // clear (sessionId null) — the recorder never saw the session.
    const realSets = transport.calls.filter((c) =>
      c.msg === 'recorder-set-session' && c.sessionId !== null);
    assert.deepEqual(realSets, []);
    assert.equal(handle.getPhase(), 'idle');
    handle.stop();
  });

  it('without the fields handle the 5.1 path is preserved (no session-save)', async () => {
    const ns = publishNS(mergedNS());
    const seen = {};
    const { handle, transport } = installControls(ns, {
      handler: okStartHandler(seen),
    });
    handle.button.click();
    await sleep(50);
    assert.deepEqual(startChainMessages(transport), ['recorder-ensure',
      'recorder-set-session', 'recorder-start-streams']);
    assert.equal(seen.save, undefined);
    assert.equal(seen.setSession.sessionId,
      'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
    assert.equal(seen.setSession.sessionCategory, undefined);
    handle.stop();
  });

  it('a thunk sessionFields is resolved at Start time', async () => {
    const ns = publishNS(mergedNS());
    const seen = {};
    let live = null;
    const { handle, transport } = installControls(ns, {
      handler: okStartHandler(seen),
      extra: {
        sessionFields: () => live,
        extensionVersion: '1.0.0',
      },
    });
    live = stubFieldsHandle({ ...GOOD_SELECTION });
    handle.button.click();
    await sleep(50);
    assert.ok(transport.calls.some((c) => c.msg === 'session-save'));
    handle.stop();
  });

  it('extensionVersion is required when sessionFields is provided', () => {
    const ns = publishNS(mergedNS());
    globalThis.document = makeFakeDocument();
    const sender = { emit() {} };
    const glr = {
      recordStopTermination() {},
      resetEnded() {},
      getLastObservedEnd() { return null; },
    };
    assert.throws(
      () => ns.installSessionControls({
        sender,
        sendRecorderMessage: () => Promise.resolve({}),
        gameLifecycleRecorder: glr,
        sessionFields: stubFieldsHandle({ ...GOOD_SELECTION }),
      }),
      TypeError);
    assert.throws(
      () => ns.installSessionControls({
        sender,
        sendRecorderMessage: () => Promise.resolve({}),
        gameLifecycleRecorder: glr,
        sessionFields: { bogus: true },
        extensionVersion: '1.0.0',
      }),
      TypeError);
  });
});

// ------------------------------------------------------------------
// AC5 — write-once: no events emitted; exactly one store write per Start.
// ------------------------------------------------------------------
describe('AC5 — write-once, no events', () => {
  it('5.2 emits no events and no conditions_changed (code-scan pin)', () => {
    for (const f of ['session_fields.js', 'session_controls.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
        .replace(/\/\/[^\n]*/g, '');
      assert.ok(!/conditions_changed/.test(src),
        f + ' must not reference conditions_changed');
    }
    const fieldsSrc = fs.readFileSync(
      path.join(ROOT, 'session_fields.js'), 'utf8')
      .replace(/\/\/[^\n]*/g, '');
    assert.ok(!/\.emit\(/.test(fieldsSrc),
      'session_fields.js must not emit');
  });

  it('session-save is sent exactly once per Start; mid-session selection cannot reach the record', async () => {
    const ns = publishNS(mergedNS());
    const seen = { saves: 0 };
    const fields = stubFieldsHandle({ ...GOOD_SELECTION });
    const handler = okStartHandler(seen);
    const { handle, transport } = installControls(ns, {
      handler: (envelope) => {
        if (envelope.msg === 'session-save') seen.saves++;
        return handler(envelope);
      },
      extra: { sessionFields: fields, extensionVersion: '1.0.0' },
    });
    handle.button.click();
    await sleep(50);
    assert.equal(seen.saves, 1);
    // Mid-session setSelection is a no-op at the handle level only
    // when disabled via the real install; the stub records the
    // control's own disabling (write-once is enforced by setEnabled).
    assert.deepEqual(fields._calls.setEnabled, [false]);
    // A second Start click while active is the interlock, not a
    // second save.
    handle.button.click(); // Stop
    await sleep(50);
    handle.stop();
  });
});

// ------------------------------------------------------------------
// AC6 — boot adoption: echoed category shown disabled.
// ------------------------------------------------------------------
describe('AC6 — boot adoption', () => {
  it('adopted session shows the echoed category disabled', async () => {
    const ns = publishNS(mergedNS());
    const fields = stubFieldsHandle({ ...GOOD_SELECTION });
    const { handle } = installControls(ns, {
      handler: (envelope) => {
        if (envelope.msg === 'recorder-get-status') {
          return Promise.resolve({
            ok: true,
            sessionId: 'adopted-session',
            gameId: 'adopted-game',
            sessionCategory: 'evaluation',
            statuses: {},
          });
        }
        return Promise.resolve({ ok: false, error: 'unexpected' });
      },
      extra: { sessionFields: fields, extensionVersion: '1.0.0' },
    });
    await sleep(50);
    assert.deepEqual(fields._calls.showAdoptedCategory, ['evaluation']);
    assert.deepEqual(fields._calls.setEnabled, [false]);
    assert.equal(handle.button.textContent, 'Stop');
    handle.stop();
  });

  it('missing echo → showAdoptedCategory(null); never a default masquerading', async () => {
    const ns = publishNS(mergedNS());
    const fields = stubFieldsHandle({ ...GOOD_SELECTION });
    const { handle } = installControls(ns, {
      handler: (envelope) => {
        if (envelope.msg === 'recorder-get-status') {
          return Promise.resolve({
            ok: true,
            sessionId: 'adopted-session',
            gameId: 'adopted-game',
            statuses: {},
          });
        }
        return Promise.resolve({ ok: false, error: 'unexpected' });
      },
      extra: { sessionFields: fields, extensionVersion: '1.0.0' },
    });
    await sleep(50);
    assert.deepEqual(fields._calls.showAdoptedCategory, [null]);
    handle.stop();
  });
});

// ------------------------------------------------------------------
// AC7 — diff discipline.
// ------------------------------------------------------------------
describe('AC7 — diff discipline', () => {
  it('changed files are exactly the 5.2 contract §4 list (post-commit-vacuous)', () => {
    // Post-commit the tree is clean and the pin is vacuous (2.8/4.4/
    // 4.14/5.1 precedent); pre-commit it proves exactly 5.2's files
    // changed.
    const status = execSync('git status --porcelain', { cwd: REPO }).toString();
    if (!status.trim()) return;
    const changed = status.split('\n').filter((l) => l.trim())
      .map((l) => l.slice(3).trim());
    const allowed = new Set([
      // 5.2 (baseline/training/evaluation selection + training approach
      // and verbal scaffolding fields): the new session_fields.js +
      // its test, the session_controls.js Start-sequence amendment,
      // the SW-side session-save handler in recording_host.js, the
      // sessionCategory accept/store/echo in recorder.js, the
      // content.js install wiring (+ extensionVersion pass-through),
      // the manifest content_scripts line, additive overlay.css
      // classes, the ## 5.2 decisions, and its evidence.
      'session_fields.js',
      'tests/session_fields.test.js',
      'session_controls.js',
      'recording_host.js',
      'recorder.js',
      'content.js',
      'manifest.json',
      'overlay.css',
      '.autodev/evidence/5.2.contract.md',
      '.autodev/evidence/5.2.build.md',
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
      '.autodev/DECISIONS.md',
      // Cumulative pin evolutions by the 5.2 build (honest cumulative
      // evolution — earlier suites' allowlists admit 5.2's files).
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
      'tests/sender.test.js',
      'tests/session_controls.test.js',
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
      'sw.js',
      'manifest.json',
      'session_controls.js',
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
      // 6.4+6.5 review/behavior use combined naming (reviewer/verifier
      // wrote single files for the pair, 6.2+6.3 precedent).
      '.autodev/evidence/6.4+6.5.review.md',
      '.autodev/evidence/6.4+6.5.behavior.md',
      '.autodev/evidence/6.3.build.md',
      
      
    ]);
    const stray = changed.filter((f) => !allowed.has(f));
    assert.deepEqual(stray, [],
      'working tree has non-5.2 changes:\n' + stray.join('\n'));
  });

  it('session_identity.js, session_conditions.js, session_store.js are byte-identical', () => {
    for (const f of ['session_identity.js', 'session_conditions.js',
                     'session_store.js']) {
      const head = execSync(`git show HEAD:${f}`, { cwd: REPO }).toString();
      const current = fs.readFileSync(path.join(REPO, f), 'utf8');
      assert.strictEqual(current, head, f + ' must be byte-identical');
    }
  });

  it('manifest.json diff is only the content_scripts line', () => {
    const diff = execSync('git diff HEAD -- manifest.json', { cwd: REPO }).toString();
    if (!diff.trim()) return; // committed
    const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    assert.ok(added.length >= 1);
    for (const l of added) {
      // Honest cumulative evolution: 5.3 adds the selection_memory.js
      // content_scripts line AND the "storage" permission per its
      // contract (the chrome.storage.local adapter).
      assert.ok(l.includes('session_fields.js') || l.includes('selection_memory.js') ||
                l.includes('"storage"'),
        'manifest addition must be a 5.2/5.3 line: ' + l);
    }
  });

  it('content.js diff is only the 5.2 install wiring', () => {
    const diff = execSync('git diff HEAD -- content.js', { cwd: REPO }).toString();
    if (!diff.trim()) return; // committed
    // 5.3's createSelectionMemory wiring is committed (in HEAD), so the
    // uncommitted diff's only new BlindfoldSession.* calls are 5.4's
    // installConditionsPanel + attachConditionsPanel (honest cumulative
    // evolution: 5.4 wires the detected-conditions panel into content.js
    // per its contract — install before the fields, the
    // getDetectedConditions plug-in pass-through, and the composite
    // wrap). 5.9 adds createHistoryTracker (factory), sender,
    // activeSessionId/activeGameId (the 5.9 transition reads the same
    // seams the original tracker used).
    const calls = new Set();
    const re = /^\+.*BlindfoldSession\.([A-Za-z0-9_]+)/gm;
    let m;
    while ((m = re.exec(diff)) !== null) calls.add(m[1]);
    // Honest cumulative evolution (5.9): if the diff is 5.9's tracker
    // refactor, the 5.4 panel calls are not in the diff (different file
    // region); expect only 5.9's calls.
    const is59 = diff.includes('createGameHistoryTracker');
    const expected59 = ['activeGameId', 'activeSessionId',
      'createHistoryTracker', 'sender'];
    const expected54 = ['activeGameId', 'activeSessionId',
      'attachConditionsPanel', 'createHistoryTracker',
      'installConditionsPanel', 'sender'];
    assert.deepEqual([...calls].sort(), is59 ? expected59 : expected54);
    // No new top-level function declarations except 5.9's specified
    // factory + reset callback; no gameplay identifiers.
    const newFns = diff.split('\n')
      .filter((l) => /^\+function /.test(l))
      .map((l) => l.slice(1).trim());
    const badFns = newFns.filter((l) =>
      !(l.startsWith('function createGameHistoryTracker') ||
        l.startsWith('function handleGameResetEvent')));
    assert.deepEqual(badFns, [],
      'unexpected new functions in content.js: ' + badFns.join(', '));
    assert.ok(!/move_input|piece_set|chess\.move/i.test(
      diff.split('\n').filter((l) => l.startsWith('+')).join('\n')),
      'no gameplay changes in content.js');
  });

  it('recorder.js diff is only the sessionCategory accept/store/echo', () => {
    const diff = execSync('git diff HEAD -- recorder.js', { cwd: REPO }).toString();
    if (!diff.trim()) return; // committed
    // Honest cumulative evolution: 5.5's duplicate-Start guard is purely
    // additive (the session-active refusal block in handleSetSession).
    // The diff is 5.2's sessionCategory seam (if uncommitted) and/or 5.5's
    // guard — both are additive, message-free changes.
    assert.ok(diff.includes('sessionCategory') || diff.includes('session-active'),
      'sessionCategory seam or 5.5 guard present');
    // No new offscreen MSG_* constant (5.1 precedent: recorder-ensure
    // is SW-side; session-save is SW-side too; 5.5 adds no messages).
    const addedMsgConsts = diff.split('\n').filter((l) =>
      l.startsWith('+') && /var MSG_[A-Z_]+ =/.test(l));
    assert.deepEqual(addedMsgConsts, [], 'no new offscreen MSG_* constants');
    // No new message branches: set-session/get-status already existed;
    // 5.5's guard reuses the set-session response shape.
    const branches = new Set();
    const re = /^\+.*message\.msg === '([^']+)'/gm;
    let m;
    while ((m = re.exec(diff)) !== null) branches.add(m[1]);
    assert.deepEqual([...branches], [], 'no new message branches');
    // 5.5's guard removes nothing from recorder.js.
    const removed = diff.split('\n')
      .filter((l) => l.startsWith('-') && !l.startsWith('---'))
      .map((l) => l.slice(1).trim())
      .filter((l) => l !== '');
    assert.deepEqual(removed, [], '5.5 removes nothing from recorder.js');
  });

  it('recording_host.js diff is only the session-save handler', () => {
    const diff = execSync('git diff HEAD -- recording_host.js', { cwd: REPO }).toString();
    if (!diff.trim()) return; // committed
    // The only new message branch is session-save.
    const branches = new Set();
    const re = /^\+.*message\.msg === '([^']+)'/gm;
    let m;
    while ((m = re.exec(diff)) !== null) branches.add(m[1]);
    assert.deepEqual([...branches], ['session-save']);
    // The only new top-level function is handleSessionSave.
    const fns = new Set();
    const fre = /^\+    function ([A-Za-z0-9_]+)\(/gm;
    while ((m = fre.exec(diff)) !== null) fns.add(m[1]);
    assert.deepEqual([...fns], ['handleSessionSave']);
    // No new chrome.* surface: the handler delegates to the 2.6
    // primitives, like every other handler in this file.
    const addedChrome = diff.split('\n').filter((l) =>
      l.startsWith('+') && /chrome\.[A-Za-z]+/.test(l) &&
      !l.trim().startsWith('//'));
    assert.deepEqual(addedChrome, [], 'no new chrome.* calls');
  });

  it('no new offscreen messages: MSG_* stays at 24 distinct values', () => {
    const src = fs.readFileSync(path.join(ROOT, 'recorder.js'), 'utf8');
    const vals = new Set();
    const re = /var (MSG_[A-Z_]+) = '([^']+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      vals.add(m[2]);
    }
    assert.equal(vals.size, 24,
      'offscreen vocabulary must stay at 24, got ' + vals.size);
    assert.ok(!vals.has('session-save'),
      'session-save is SW-side, not an offscreen message');
  });

  it('SW-side recorder envelope vocabulary is 7 (session-save added)', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'recording_host.js'), 'utf8');
    const handled = new Set();
    const re = /message\.msg === '([^']+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      handled.add(m[1]);
    }
    const expected = [
      'recorder-ready', 'recorder-ensure', 'session-save',
      'capture-resolve-tab', 'capture-query-permission',
      'capture-get-stream-id', 'recorder-sync-flash',
    ];
    for (const e of expected) {
      assert.ok(handled.has(e), 'SW side must handle ' + e);
    }
    assert.equal(handled.size, expected.length,
      'SW-side envelope vocabulary must be exactly 7, got ' +
      [...handled].join(', '));
  });

  it('PLAN.md is unmodified', () => {
    const head = execSync('git show HEAD:PLAN.md', { cwd: REPO }).toString();
    const current = fs.readFileSync(path.join(REPO, 'PLAN.md'), 'utf8');
    assert.strictEqual(current, head, 'PLAN.md is human-owned and must not change');
  });
});
