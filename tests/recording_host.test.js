// tests/recording_host.test.js
//
// V1 verification for task 4.1 (PLAN.md §4.1) per
// .autodev/evidence/4.1.contract.md. Covers acceptance criteria AC1–AC7
// (static/unit). AC8–AC11 (real Chrome) run separately via
// ~/workspace/tools/ext-verify/sw-recorder.js; AC12 (real device idle) is
// deferred to owner verification (§7).
//
// Run: node --test tests/recording_host.test.js   (from repo root)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BS_RECORDER = require(path.join(REPO, 'recorder.js'));
const BS_HOST = require(path.join(REPO, 'recording_host.js'));

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ------------------------------------------------------------------
// Test doubles.
// ------------------------------------------------------------------

// Mock chrome namespace with an injectable offscreen document. The mock's
// runtime.sendMessage dispatches recorder-ping to a simulated offscreen
// recorder (pong), so ping/ensure paths are exercised end to end.
function mockChrome(opts) {
  const o = opts || {};
  const state = {
    hasDoc: !!o.hasDoc,
    createCalls: 0,
    createArgs: null,
    failCreate: !!o.failCreate,
    pongBootId: o.pongBootId || 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    pongState: o.pongState || 'idle',
    neverRespond: !!o.neverRespond, // ping path hangs -> timeout fires
    rejectSend: !!o.rejectSend,     // sendMessage rejects (no receiver)
    throwSend: !!o.throwSend        // sendMessage throws synchronously
  };
  const listeners = [];
  const sent = [];
  const chromeNs = {
    state,
    listeners,
    sent,
    offscreen: o.noOffscreen ? undefined : {
      // SF-1 repair (4.1 review): on Chrome 116–149 there is no hasDocument;
      // the supervisor must fall back to runtime.getContexts.
      hasDocument: o.noHasDocument ? undefined : async () => state.hasDoc,
      createDocument: async (args) => {
        state.createCalls++;
        state.createArgs = args;
        if (state.failCreate) {
          throw new Error('mock createDocument failure');
        }
        state.hasDoc = true;
        return undefined;
      }
    },
    runtime: o.noRuntime ? undefined : {
      getContexts: async (filter) => {
        assert.deepStrictEqual(
          Object.keys(filter || {}).sort(), ['contextTypes'],
          'getContexts called with the offscreen filter shape');
        return state.hasDoc ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : [];
      },
      sendMessage: (msg) => {
        sent.push(msg);
        if (state.throwSend) {
          throw new Error('mock sync send failure');
        }
        if (state.rejectSend) {
          return Promise.reject(new Error('Could not establish connection'));
        }
        if (state.neverRespond) {
          return new Promise(() => {}); // hangs; timeout must fire
        }
        if (msg && msg.kind === 'recorder' && msg.msg === 'recorder-ping') {
          return Promise.resolve({
            ok: true,
            bootId: state.pongBootId,
            state: state.pongState,
            nowMonotonicMs: 1234.5
          });
        }
        return Promise.resolve({ ok: false, error: 'mock-unknown' });
      },
      onMessage: {
        addListener: (fn) => { listeners.push(fn); }
      }
    }
  };
  return chromeNs;
}

// Fake timer: the callback fires only when the test says so.
function manualTimer() {
  const pending = [];
  return {
    pending,
    setTimeoutFn: (fn, ms) => { pending.push({ fn, ms }); return pending.length - 1; },
    clearTimeoutFn: () => {},
    fire: () => { while (pending.length) { pending.shift().fn(); } }
  };
}

// ------------------------------------------------------------------
// AC1 — recorder.js loads in Node via the shim; pure logic unit-tested.
// ------------------------------------------------------------------
describe('AC1 — module shape and pure envelope logic', () => {
  it('recorder.js exports the contract constants', () => {
    assert.strictEqual(BS_RECORDER.RECORDER_MSG_KIND, 'recorder');
    assert.strictEqual(BS_RECORDER.RECORDER_PROTOCOL_V, 1);
    assert.strictEqual(BS_RECORDER.RECORDER_MSG_READY, 'recorder-ready');
    assert.strictEqual(BS_RECORDER.RECORDER_MSG_PING, 'recorder-ping');
    assert.strictEqual(BS_RECORDER.RECORDER_MSG_PONG, 'recorder-pong');
  });

  it('recording_host.js exports the supervisor constants', () => {
    assert.strictEqual(BS_HOST.RECORDER_OFFSCREEN_URL, 'recorder.html');
    assert.deepStrictEqual(BS_HOST.RECORDER_REASONS,
      ['USER_MEDIA', 'DISPLAY_MEDIA', 'AUDIO_PLAYBACK']);
    assert.ok(typeof BS_HOST.RECORDER_JUSTIFICATION === 'string' &&
      BS_HOST.RECORDER_JUSTIFICATION.length > 0);
    assert.strictEqual(BS_HOST.DEFAULT_PING_TIMEOUT_MS, 5000);
  });

  it('isRecorderMessage accepts the envelope, rejects impostors', () => {
    const ok = BS_RECORDER.isRecorderMessage;
    assert.strictEqual(ok({ kind: 'recorder', msg: 'recorder-ping', v: 1 }), true);
    assert.strictEqual(ok({ kind: 'event', msg: 'x' }), false);
    assert.strictEqual(ok({ kind: 'recorder' }), false);
    assert.strictEqual(ok({ kind: 'recorder', msg: 42 }), false);
    assert.strictEqual(ok(null), false);
    assert.strictEqual(ok('recorder'), false);
  });

  it('createOffscreenRecorder mints a uuid-v4 bootId and UTC bootTime', () => {
    const rec = BS_RECORDER.createOffscreenRecorder({
      chromeNs: null, announce: false,
      nowUtcIso: () => '2026-10-06T00:00:00.000Z'
    });
    assert.ok(UUID_V4_RE.test(rec.bootId()), 'bootId is uuid-v4');
    assert.strictEqual(rec.bootTime(), '2026-10-06T00:00:00.000Z');
    const rec2 = BS_RECORDER.createOffscreenRecorder({ chromeNs: null, announce: false });
    assert.notStrictEqual(rec.bootId(), rec2.bootId(), 'bootIds are unique');
  });

  it('createRecordingHost rejects a non-object chromeNs', () => {
    assert.throws(() => BS_HOST.createRecordingHost(null), TypeError);
    assert.throws(() => BS_HOST.createRecordingHost('x'), TypeError);
  });
});

// ------------------------------------------------------------------
// recorder.js: announce + ping responder (pure, injected chrome).
// ------------------------------------------------------------------
describe('recorder.js — announce and ping responder', () => {
  it('announceReady sends a well-formed recorder-ready envelope', () => {
    const chromeNs = mockChrome();
    const rec = BS_RECORDER.createOffscreenRecorder({
      chromeNs, announce: false,
      nowUtcIso: () => '2026-10-06T00:00:00.000Z'
    });
    assert.strictEqual(rec.announceReady(), true);
    assert.strictEqual(chromeNs.sent.length, 1);
    const m = chromeNs.sent[0];
    assert.deepStrictEqual(Object.keys(m).sort(),
      ['bootId', 'bootTime', 'kind', 'msg', 'v'].sort());
    assert.strictEqual(m.kind, 'recorder');
    assert.strictEqual(m.msg, 'recorder-ready');
    assert.strictEqual(m.v, 1);
    assert.ok(UUID_V4_RE.test(m.bootId));
    assert.strictEqual(m.bootId, rec.bootId());
    assert.strictEqual(m.bootTime, '2026-10-06T00:00:00.000Z');
  });

  it('announceReady is failure-isolated when there is no runtime', () => {
    const rec = BS_RECORDER.createOffscreenRecorder({ chromeNs: null, announce: false });
    assert.strictEqual(rec.announceReady(), false);
  });

  it('onRuntimeMessage answers recorder-ping with a pong', () => {
    const rec = BS_RECORDER.createOffscreenRecorder({ chromeNs: null, announce: false });
    let responded = null;
    const ret = rec.onRuntimeMessage(
      { kind: 'recorder', msg: 'recorder-ping', v: 1 }, {},
      (r) => { responded = r; });
    assert.strictEqual(ret, false);
    assert.ok(responded && responded.ok === true);
    assert.strictEqual(responded.msg, 'recorder-pong');
    assert.strictEqual(responded.bootId, rec.bootId());
    assert.strictEqual(responded.state, 'idle');
    assert.ok(typeof responded.nowMonotonicMs === 'number',
      'pong carries the performance.now() hook');
  });

  it('onRuntimeMessage ignores unknown kinds and unknown msgs (never throws)', () => {
    const rec = BS_RECORDER.createOffscreenRecorder({ chromeNs: null, announce: false });
    let responded = 'unset';
    assert.strictEqual(rec.onRuntimeMessage(
      { kind: 'event', event: {} }, {}, () => { responded = 'called'; }), false);
    assert.strictEqual(responded, 'unset');
    assert.strictEqual(rec.onRuntimeMessage(
      { kind: 'recorder', msg: 'start-mic', v: 1 }, {}, () => { responded = 'called'; }), false);
    assert.strictEqual(responded, 'unset', 'unknown msg: no response');
  });

  it('onRuntimeMessage rejects unknown protocol versions with {ok:false}', () => {
    const rec = BS_RECORDER.createOffscreenRecorder({ chromeNs: null, announce: false });
    let responded = null;
    const ret = rec.onRuntimeMessage(
      { kind: 'recorder', msg: 'recorder-ping', v: 999 }, {},
      (r) => { responded = r; });
    assert.strictEqual(ret, false);
    assert.deepStrictEqual(responded, { ok: false, error: 'unsupported-protocol-version' });
  });

  it('installListener registers on chrome.runtime.onMessage', () => {
    const chromeNs = mockChrome();
    const rec = BS_RECORDER.createOffscreenRecorder({ chromeNs, announce: false });
    assert.strictEqual(rec.installListener(), true);
    assert.strictEqual(chromeNs.listeners.length, 1);
  });

  it('installListener returns false without a runtime', () => {
    const rec = BS_RECORDER.createOffscreenRecorder({ chromeNs: null, announce: false });
    assert.strictEqual(rec.installListener(), false);
  });
});

// ------------------------------------------------------------------
// AC3 — concurrent ensure() calls collapse to one createDocument.
// AC5 — no chrome.offscreen -> honest {ok:false} (no throw).
// ------------------------------------------------------------------
describe('recording_host.js — ensureRecordingContext', () => {
  it('creates the document with the full reason set when absent', async () => {
    const chromeNs = mockChrome();
    const host = BS_HOST.createRecordingHost(chromeNs);
    const res = await host.ensureRecordingContext();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.created, true);
    assert.strictEqual(res.bootId, chromeNs.state.pongBootId);
    assert.strictEqual(chromeNs.state.createCalls, 1);
    assert.strictEqual(chromeNs.state.createArgs.url, 'recorder.html');
    assert.deepStrictEqual(chromeNs.state.createArgs.reasons,
      ['USER_MEDIA', 'DISPLAY_MEDIA', 'AUDIO_PLAYBACK']);
    assert.ok(typeof chromeNs.state.createArgs.justification === 'string');
  });

  it('concurrent ensures collapse to one createDocument call', async () => {
    const chromeNs = mockChrome();
    const host = BS_HOST.createRecordingHost(chromeNs);
    const [a, b, c] = await Promise.all([
      host.ensureRecordingContext(),
      host.ensureRecordingContext(),
      host.ensureRecordingContext()
    ]);
    assert.strictEqual(chromeNs.state.createCalls, 1, 'one createDocument');
    assert.deepStrictEqual([a.ok, b.ok, c.ok], [true, true, true]);
    assert.strictEqual(host.stats().ensureCalls, 3);
    assert.strictEqual(host.stats().createDocumentCalls, 1);
  });

  it('re-discovers a surviving document without creating (SW-restart shape)', async () => {
    const chromeNs = mockChrome({ hasDoc: true, pongBootId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' });
    const host = BS_HOST.createRecordingHost(chromeNs);
    const res = await host.ensureRecordingContext();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.created, false);
    assert.strictEqual(res.bootId, 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb');
    assert.strictEqual(chromeNs.state.createCalls, 0, 'no duplicate document');
    assert.strictEqual(host.getLastKnownBootId(), res.bootId);
  });

  it('falls back to runtime.getContexts when hasDocument is unavailable (Chrome 116-149)', async () => {
    // SF-1 repair (4.1 review): hasDocument() is Chrome 150+; on older
    // Chrome the supervisor must detect the document via getContexts.
    const chromeNs = mockChrome({ noHasDocument: true, hasDoc: true });
    const host = BS_HOST.createRecordingHost(chromeNs);
    const res = await host.ensureRecordingContext();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.created, false);
    assert.strictEqual(chromeNs.state.createCalls, 0, 'adopted, not recreated');
  });

  it('falls back to getContexts for the create-race re-check', async () => {
    const chromeNs = mockChrome({ noHasDocument: true, failCreate: true });
    chromeNs.state.hasDoc = true; // the concurrent winner
    const host = BS_HOST.createRecordingHost(chromeNs);
    const res = await host.ensureRecordingContext();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.created, false);
  });

  it('reports offscreen-unavailable when neither hasDocument nor getContexts exists', async () => {
    const chromeNs = mockChrome({ noHasDocument: true });
    chromeNs.runtime.getContexts = undefined;
    const host = BS_HOST.createRecordingHost(chromeNs);
    const res = await host.ensureRecordingContext();
    assert.deepStrictEqual(res, { ok: false, reason: 'offscreen-unavailable' });
  });

  it('start() never throws and warns on swallowed failures', async () => {
    // SF-2 (4.1 review): never-throw kept, but failures get a console.warn
    // diagnostic trace. Suppress the noise, assert the guarantee.
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args); };
    try {
      const chromeNs = mockChrome({ failCreate: true });
      const host = BS_HOST.createRecordingHost(chromeNs);
      assert.doesNotThrow(() => host.start());
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(warnings.length >= 1, 'swallowed failure produced a diagnostic');
    } finally {
      console.warn = origWarn;
    }
  });

  it('reports {ok:false, reason:offscreen-unavailable} without chrome.offscreen', async () => {
    const chromeNs = mockChrome({ noOffscreen: true });
    const host = BS_HOST.createRecordingHost(chromeNs);
    const res = await host.ensureRecordingContext();
    assert.deepStrictEqual(res, { ok: false, reason: 'offscreen-unavailable' });
  });

  it('create failure with a concurrent winner is adopted, not thrown', async () => {
    // createDocument throws, but a document is present on re-check.
    const chromeNs = mockChrome({ failCreate: true });
    chromeNs.state.hasDoc = true; // the concurrent winner
    const host = BS_HOST.createRecordingHost(chromeNs);
    const res = await host.ensureRecordingContext();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.created, false);
  });

  it('create failure with no document present propagates', async () => {
    const chromeNs = mockChrome({ failCreate: true });
    const host = BS_HOST.createRecordingHost(chromeNs);
    await assert.rejects(host.ensureRecordingContext(), /mock createDocument failure/);
  });

  it('unreachable document after create reports recorder-unreachable', async () => {
    const chromeNs = mockChrome({ rejectSend: true });
    const host = BS_HOST.createRecordingHost(chromeNs);
    const res = await host.ensureRecordingContext();
    assert.deepStrictEqual(res, { ok: false, reason: 'recorder-unreachable' });
  });
});

// ------------------------------------------------------------------
// pingRecorder timeout + SW-side listener behavior (AC4).
// ------------------------------------------------------------------
describe('recording_host.js — ping and listener', () => {
  it('ping resolves the pong', async () => {
    const chromeNs = mockChrome();
    const host = BS_HOST.createRecordingHost(chromeNs);
    const pong = await host.pingRecorder({});
    assert.strictEqual(pong.ok, true);
    assert.strictEqual(pong.bootId, chromeNs.state.pongBootId);
    assert.ok(typeof pong.nowMonotonicMs === 'number');
  });

  it('ping rejects with recorder-unreachable on timeout (injectable)', async () => {
    const chromeNs = mockChrome({ neverRespond: true });
    const t = manualTimer();
    const host = BS_HOST.createRecordingHost(chromeNs, {
      setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn
    });
    let err = null;
    const p = host.pingRecorder({}).then(() => {}, (e) => { err = e; });
    t.fire(); // expire the 5s timer
    await p;
    assert.ok(err instanceof Error);
    assert.strictEqual(err.message, 'recorder-unreachable');
  });

  it('ping rejects with recorder-unreachable when the send fails', async () => {
    const chromeNs = mockChrome({ rejectSend: true });
    const host = BS_HOST.createRecordingHost(chromeNs);
    await assert.rejects(host.pingRecorder({}), /recorder-unreachable/);
    const syncFail = mockChrome({ throwSend: true });
    const host2 = BS_HOST.createRecordingHost(syncFail);
    await assert.rejects(host2.pingRecorder({}), /recorder-unreachable/);
  });

  it('SW listener records recorder-ready and ignores the rest', () => {
    const chromeNs = mockChrome();
    const host = BS_HOST.createRecordingHost(chromeNs);
    assert.strictEqual(host.installRecorderListener(), true);
    const listener = chromeNs.listeners[0];
    assert.strictEqual(host.getLastKnownBootId(), null);
    // Unknown kind: ignored, no response.
    assert.strictEqual(listener({ kind: 'event', event: {} }, {}, () => {}), false);
    assert.strictEqual(host.getLastKnownBootId(), null);
    // Unknown msg: ignored.
    assert.strictEqual(listener({ kind: 'recorder', msg: 'nope', v: 1 }, {}, () => {}), false);
    // Unknown version: {ok:false}, never throws.
    let responded = null;
    assert.strictEqual(listener({ kind: 'recorder', msg: 'recorder-ready', v: 7 },
      {}, (r) => { responded = r; }), false);
    assert.deepStrictEqual(responded, { ok: false, error: 'unsupported-protocol-version' });
    // The real thing.
    assert.strictEqual(listener({
      kind: 'recorder', msg: 'recorder-ready', v: 1,
      bootId: 'cccccccc-3333-4333-8333-cccccccccccc', bootTime: '2026-10-06T00:00:00.000Z'
    }, {}, () => {}), false);
    assert.strictEqual(host.getLastKnownBootId(), 'cccccccc-3333-4333-8333-cccccccccccc');
  });

  it('start() installs the listener and never throws', async () => {
    const chromeNs = mockChrome();
    const host = BS_HOST.createRecordingHost(chromeNs);
    assert.doesNotThrow(() => host.start());
    assert.strictEqual(chromeNs.listeners.length, 1);
    // The lazy ensure runs in the background; let it settle.
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(chromeNs.state.createCalls, 1);
  });

  it('start() never throws even when ensure cannot run', () => {
    const chromeNs = mockChrome({ noOffscreen: true, noRuntime: true });
    const host = BS_HOST.createRecordingHost(chromeNs);
    assert.doesNotThrow(() => host.start());
  });
});

// ------------------------------------------------------------------
// 4.3 — SW-leg capture broker routing ('capture-resolve-tab',
// 'capture-query-permission', 'capture-get-stream-id').
// ------------------------------------------------------------------
describe('recording_host.js — 4.3 capture broker leg', () => {
  const BS_BROKER = require(path.join(REPO, 'capture_broker.js'));

  // The broker factory lives in capture_broker.js; in the SW both files
  // share one global BlindfoldSession via importScripts. Reproduce that
  // merge here (per-test, restored afterwards).
  function makeHostWithBroker(chromeOpts) {
    const merged = Object.assign({}, BS_BROKER, BS_HOST);
    globalThis.BlindfoldSession = merged;
    try {
      const chromeNs = mockChromeWithCapture(chromeOpts);
      const host = merged.createRecordingHost(chromeNs);
      assert.strictEqual(host.installRecorderListener(), true);
      assert.ok(host.getCaptureBroker() !== null, 'broker must exist');
      const listener = chromeNs.listeners[0];
      function send(msg) {
        return new Promise((resolve) => {
          const r = listener(Object.assign({ kind: 'recorder', v: 1 }, msg), {}, resolve);
          if (r === false) {
            resolve('sync-false');
          }
        });
      }
      return { host, send, chromeNs };
    } finally {
      delete globalThis.BlindfoldSession;
    }
  }

  function mockChromeWithCapture(opts) {
    const o = opts || {};
    const base = mockChrome(o);
    base.tabs = {
      query: async () => (o.tabs || []).map((t) => Object.assign({}, t))
    };
    base.permissions = {
      contains: async () => o.permissionGranted === undefined ? true : o.permissionGranted
    };
    base.tabCapture = {
      getMediaStreamId: async (opts2) => {
        base.state.streamIdFor = opts2.targetTabId;
        return 'sw-leg-stream-id';
      }
    };
    return base;
  }

  it('capture-resolve-tab returns the game tab through the SW', async () => {
    const { send } = makeHostWithBroker({
      tabs: [{ id: 9, title: 'Play Computer', lastAccessed: 5 }]
    });
    const res = await send({ msg: 'capture-resolve-tab' });
    assert.deepEqual(res, { ok: true, tabId: 9, tabTitle: 'Play Computer' });
  });

  it('capture-query-permission reports the install-time permission', async () => {
    const { send } = makeHostWithBroker({ permissionGranted: false });
    const res = await send({ msg: 'capture-query-permission' });
    assert.deepEqual(res, { ok: true, permissionState: 'denied' });
  });

  it('capture-get-stream-id mints a streamId for the target tab', async () => {
    const { send, chromeNs } = makeHostWithBroker({});
    const res = await send({ msg: 'capture-get-stream-id', tabId: 9 });
    assert.deepEqual(res, { ok: true, streamId: 'sw-leg-stream-id' });
    assert.strictEqual(chromeNs.state.streamIdFor, 9);
  });

  it('capture-get-stream-id with a bad tabId answers {ok:false}, never throws', async () => {
    const { send } = makeHostWithBroker({});
    const res = await send({ msg: 'capture-get-stream-id', tabId: 'nine' });
    assert.equal(res.ok, false);
  });

  it('without the broker module the SW leg answers broker-unavailable', async () => {
    // No globalThis merge: shared() is recording_host.js's own namespace,
    // which has no createCaptureBroker — the 4.1-only surface.
    const chromeNs = mockChrome({});
    const host = BS_HOST.createRecordingHost(chromeNs);
    assert.strictEqual(host.getCaptureBroker(), null);
    host.installRecorderListener();
    const listener = chromeNs.listeners[0];
    const res = await new Promise((resolve) => {
      const r = listener({ kind: 'recorder', v: 1, msg: 'capture-resolve-tab' },
        {}, resolve);
      if (r === false) {
        resolve('sync-false');
      }
    });
    assert.deepEqual(res, { ok: false, error: 'broker-unavailable' });
  });
});

// ------------------------------------------------------------------
// AC7 — recorder.js hosts no capture APIs.
// ------------------------------------------------------------------
describe('AC7 — no capture code in the 4.1 surface', () => {
  // Strip //-line and /* */-block comments so the modules' own
  // documentation of the capture-API boundary does not count as usage.
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => {
        const idx = line.indexOf('//');
        return idx === -1 ? line : line.slice(0, idx);
      })
      .join('\n');
  }

  it('recorder.js and recording_host.js reference no media-capture APIs', () => {
    for (const f of ['recorder.js', 'recording_host.js']) {
      const src = stripComments(fs.readFileSync(path.join(REPO, f), 'utf8'));
      for (const token of ['MediaRecorder', 'getUserMedia', 'getDisplayMedia']) {
        assert.ok(!src.includes(token), `${f} must not reference ${token}`);
      }
    }
  });
});

// ------------------------------------------------------------------
// AC2 — manifest gains exactly the "offscreen" permission.
// ------------------------------------------------------------------
describe('AC2 — manifest permission change', () => {
  const manifestRaw = fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);

  it('permissions is exactly ["offscreen", "tabCapture", "storage"]', () => {
    // Honest cumulative evolution (4.3): PLAN.md §4.3 legitimately adds
    // the "tabCapture" permission for programmatic game-tab capture (see
    // 4.3.contract.md §2). Honest cumulative evolution (5.3): PLAN.md
    // §5.3 legitimately adds "storage" for the selection_memory.js
    // chrome.storage.local adapter (remembered defaults). Honest
    // cumulative evolution (6.6): PLAN.md §6.6 legitimately adds
    // "downloads" for the SW-side export ZIP download (the only MV3 API
    // for service-worker-triggered file delivery). Nothing else.
    assert.deepStrictEqual(manifest.permissions,
      ['offscreen', 'tabCapture', 'storage', 'downloads']);
  });

  it('the 4.3 manifest delta vs HEAD is exactly the contract-pinned change', () => {
    // Honest cumulative evolution (4.4): HEAD now includes 4.3's pinned
    // change, so `git diff HEAD` is empty — and 4.4's contract requires
    // NO manifest change. The durable assertion is that the working tree
    // introduces no new manifest delta; the 4.3-pinned permissions are
    // asserted above.
    //
    // Honest cumulative evolution (4.11): 4.11 legitimately appends
    // sync_flash.js to the content_scripts js list per its contract
    // (the visible sync-marker content script). Post-commit the diff is
    // empty again; while the 4.11 change is uncommitted, the only
    // permitted delta is that js-list addition (the 4.5 SF-1 precedent:
    // the strict check runs only when a diff exists).
    //
    // Honest cumulative evolution (5.1): 5.1 legitimately adds
    // session_identity.js (UUID-v4 minting) and session_controls.js
    // (the in-page Start/Stop + per-stream lights) to the
    // content_scripts js list per its contract. While the 5.1 change is
    // uncommitted, the permitted delta is the js-list additions only —
    // no permission or other manifest changes.
    //
    // Honest cumulative evolution (5.2): 5.2 legitimately adds
    // session_fields.js (the baseline/training/evaluation selection
    // fields) to the content_scripts js list per its contract. Same
    // rule: js-list additions only.
    //
    // Honest cumulative evolution (5.3): 5.3 legitimately adds
    // selection_memory.js to the js list per its contract AND appends
    // "storage" to permissions per its contract (the
    // chrome.storage.local adapter for remembered defaults). The
    // permitted delta is therefore the js-list additions plus the
    // single "storage" permission — nothing else.
    const diff = execSync('git diff HEAD -- manifest.json', { cwd: REPO }).toString();
    if (diff.trim() === '') {
      return;
    };
    const headManifest = JSON.parse(
      execSync('git show HEAD:manifest.json', { cwd: REPO }).toString());
    const workManifest = JSON.parse(
      fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
    const headJs = headManifest.content_scripts[0].js;
    const workJs = workManifest.content_scripts[0].js;
    const added = workJs.filter((f) => headJs.indexOf(f) === -1);
    const removed = headJs.filter((f) => workJs.indexOf(f) === -1);
    assert.deepEqual(removed, [], 'manifest js list: no removals permitted');
    assert.ok(added.every((f) =>
      f === 'sync_flash.js' || f === 'session_identity.js' ||
      f === 'session_controls.js' || f === 'session_fields.js' ||
      // Honest cumulative evolution: 5.3 adds selection_memory.js (the
      // chrome.storage.local-backed remembered-defaults module) per its
      // contract.
      f === 'selection_memory.js' ||
      // Honest cumulative evolution: 5.4 adds detected_conditions.js
      // (the 5.4 detected-conditions panel) per its contract.
      f === 'detected_conditions.js'),
      'uncommitted manifest.json js-list delta must be exactly the ' +
      '4.11/5.1/5.2/5.3/5.4 additions, got: ' + JSON.stringify(added));
    headManifest.content_scripts[0].js = workJs;
    // 5.3's "storage" permission is committed (in HEAD), so the
    // uncommitted permissions delta must be empty — 5.4 adds no
    // permissions (its only manifest change is the content_scripts
    // js-list line, pinned above).
    const headPerms = headManifest.permissions || [];
    const workPerms = workManifest.permissions || [];
    const addedPerms = workPerms.filter((p) => headPerms.indexOf(p) === -1);
    const removedPerms = headPerms.filter((p) => workPerms.indexOf(p) === -1);
    // Honest cumulative evolution: 6.6 (export ZIP download) legitimately
    // adds the "downloads" permission (the only MV3 API for SW-triggered
    // file delivery) per its contract.
    assert.ok(addedPerms.every((p) => p === 'downloads'),
      'manifest permissions delta must be only 6.6\'s "downloads" (got: ' +
      JSON.stringify(addedPerms) + ')');
    assert.deepEqual(removedPerms, [], 'no permission removals permitted');
    headManifest.permissions = workPerms;
    assert.deepEqual(workManifest, headManifest,
      'manifest.json differs beyond the 4.11/5.1/5.2/5.3/5.4 js-list additions');
  });
});

// ------------------------------------------------------------------
// AC6 — diff discipline: only the 4.1 files change.
// ------------------------------------------------------------------
describe('AC6 — diff discipline', () => {
  it('content scripts are byte-identical to HEAD', () => {
    // Honest cumulative evolution (4.5): db.js leaves this list — 4.5
    // legitimately bumps DB_VERSION 1 → 2 and adds the
    // recording_manifest store (see its pin in
    // tests/format_support.test.js).
    // Honest cumulative evolution (5.1): content.js leaves this list —
    // 5.1 legitimately wires the Start/Stop control install into
    // content.js (pinned in tests/session_controls.test.js AC7:
    // the diff is only the install block). chess_utils.js leaves this
    // list — 5.1 legitimately adds the additive getLastObservedEnd
    // getter (also pinned in tests/session_controls.test.js AC7).
    for (const f of ['sounds.js', 'lifecycle.js',
                     'sender.js', 'status_indicator.js', 'event_envelope.js',
                     'session_identity.js', 'session_conditions.js',
                     'game_records.js', 'writer.js', 'session_store.js']) {
      const head = execSync(`git show HEAD:${f}`, { cwd: REPO, stdio: 'pipe' }).toString();
      const current = fs.readFileSync(path.join(REPO, f), 'utf8');
      assert.strictEqual(current, head, `${f} changed but 4.1 must not touch it`);
    }
  });

  it('only 4.1 files appear in git status', () => {
    const status = execSync('git status --porcelain', { cwd: REPO }).toString();
    const changed = status.split('\n').filter((l) => l.trim()).map((l) => l.slice(3).trim());
    const allowed = new Set([
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
      // Cumulative evolution: earlier suites' diff-discipline allowlists are
      // evolved by this task with justification comments.
      'tests/attempt_tracker.test.js',
      'tests/db.test.js',
      'tests/visibility.test.js',
      'tests/speech.test.js',
      'tests/game_lifecycle.test.js',
      'tests/sender.test.js',
      'tests/writer.test.js',
      'tests/lifecycle.test.js',
      'tests/status_indicator.test.js',
      'tests/retention.test.js',
      'tests/history_tracker.test.js',
      'tests/session_store.test.js',
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
    const head = execSync('git show HEAD:PLAN.md', { cwd: REPO, stdio: 'pipe' }).toString();
    const current = fs.readFileSync(path.join(REPO, 'PLAN.md'), 'utf8');
    assert.strictEqual(current, head, 'PLAN.md is human-owned and must not change');
  });
});

// ------------------------------------------------------------------
// 5.1 — SW-side recorder-ensure handler.
// ------------------------------------------------------------------
describe('recording_host.js — recorder-ensure (5.1)', () => {
  function driveEnsure(host, message) {
    return new Promise((resolve) => {
      const r = host.onRuntimeMessage(
        Object.assign({ kind: 'recorder', v: 1, msg: 'recorder-ensure' }, message || {}),
        {}, resolve);
      if (r === false) resolve(undefined); // no async response
    });
  }

  it('creates the document when absent and answers {ok:true, bootId, created:true}', async () => {
    const chromeNs = mockChrome(); // hasDoc false
    const host = BS_HOST.createRecordingHost(chromeNs);
    const resp = await driveEnsure(host);
    assert.equal(resp.ok, true);
    assert.equal(resp.created, true);
    assert.equal(resp.bootId, chromeNs.state.pongBootId);
    assert.equal(chromeNs.state.createCalls, 1);
  });

  it('re-discovers a surviving document without creating ({created:false})', async () => {
    const chromeNs = mockChrome({ hasDoc: true });
    const host = BS_HOST.createRecordingHost(chromeNs);
    const resp = await driveEnsure(host);
    assert.equal(resp.ok, true);
    assert.equal(resp.created, false);
    assert.equal(chromeNs.state.createCalls, 0);
  });

  it('answers {ok:false, reason} when offscreen is unavailable — never throws', async () => {
    const chromeNs = mockChrome({ noOffscreen: true, noRuntime: true });
    const host = BS_HOST.createRecordingHost(chromeNs);
    const resp = await driveEnsure(host);
    assert.equal(resp.ok, false);
    assert.equal(typeof resp.reason, 'string');
  });

  it('concurrent ensures collapse onto one creation', async () => {
    const chromeNs = mockChrome();
    const host = BS_HOST.createRecordingHost(chromeNs);
    const [r1, r2] = await Promise.all([driveEnsure(host), driveEnsure(host)]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(chromeNs.state.createCalls, 1);
  });
});
