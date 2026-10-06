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

  it('permissions is exactly ["offscreen"]', () => {
    assert.deepStrictEqual(manifest.permissions, ['offscreen']);
  });

  it('no other permission change vs the 4.1 parent commit', () => {
    const headRaw = execSync('git show HEAD:manifest.json', { cwd: REPO }).toString();
    const head = JSON.parse(headRaw);
    assert.ok(!('permissions' in head), 'parent had no permissions key');
    assert.ok(!('host_permissions' in manifest), 'no host_permissions');
    assert.ok(!('host_permissions' in head), 'parent had none either');
  });
});

// ------------------------------------------------------------------
// AC6 — diff discipline: only the 4.1 files change.
// ------------------------------------------------------------------
describe('AC6 — diff discipline', () => {
  it('content scripts are byte-identical to HEAD', () => {
    for (const f of ['content.js', 'chess_utils.js', 'sounds.js', 'lifecycle.js',
                     'sender.js', 'status_indicator.js', 'event_envelope.js',
                     'session_identity.js', 'session_conditions.js',
                     'game_records.js', 'db.js', 'writer.js', 'session_store.js']) {
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
      '.autodev/DECISIONS.md',
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
      'tests/session_store.test.js'
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
