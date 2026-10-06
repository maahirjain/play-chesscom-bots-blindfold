// tests/capture_selection.test.js
//
// V1 verification for task 4.3 (PLAN.md §4.3) per
// .autodev/evidence/4.3.contract.md. Covers acceptance criteria AC1–AC8
// (static/unit). AC9–AC11 (real Chrome) run separately via
// ~/workspace/tools/ext-verify/sw-screencapture.js; AC12 (real game-tab
// capture) is deferred to owner verification (§7).
//
// Run: node --test tests/capture_selection.test.js   (from repo root)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BS_ENV = require(path.join(REPO, 'event_envelope.js'));
const BS_DEV = require(path.join(REPO, 'device_selection.js'));
const BS_CAP = require(path.join(REPO, 'capture_selection.js'));
const BS_BROKER = require(path.join(REPO, 'capture_broker.js'));
const BS_REC = require(path.join(REPO, 'recorder.js'));

// The Node test harness publishes the merged namespace on
// globalThis (sender.js precedent): the recorder resolves
// createDeviceSelector/createCaptureSelector/createEvent/captureClockAnchor
// through shared().
const BS = Object.assign({}, BS_ENV, BS_DEV, BS_CAP, BS_BROKER, BS_REC);
globalThis.BlindfoldSession = BS;

const SID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const GID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

// ------------------------------------------------------------------
// Test doubles.
// ------------------------------------------------------------------

function fakeTrack(log) {
  return {
    stopped: false,
    stop() { this.stopped = true; log.push(this); }
  };
}

// Scriptable mediaDevices fake. opts:
//   gumImpl: (constraints) => Promise<stream> | throws
//   gumError: Error to throw from getUserMedia (when gumImpl absent)
//   hasDisplayMedia: whether getDisplayMedia exists (screen availability)
function fakeMediaDevices(opts) {
  const o = opts || {};
  const state = { constraintsSeen: [], gumCalls: 0 };
  const md = {
    state,
    getUserMedia: async (constraints) => {
      state.gumCalls++;
      state.constraintsSeen.push(constraints);
      if (typeof o.gumImpl === 'function') {
        return o.gumImpl(constraints);
      }
      if (o.gumError) {
        throw o.gumError;
      }
      const log = [];
      return {
        getTracks: () => [fakeTrack(log), fakeTrack(log)],
        getAudioTracks: () => [fakeTrack(log)],
        _stopLog: log
      };
    }
  };
  if (o.hasDisplayMedia !== false) {
    md.getDisplayMedia = async () => { throw new Error('must not be called in 4.3'); };
  }
  return md;
}

function fakeStorage(initial) {
  const store = Object.assign({}, initial);
  return {
    _store: store,
    get: async (k) => ({ [k]: store[k] }),
    set: async (kv) => { Object.assign(store, kv); },
    remove: async (k) => { delete store[k]; }
  };
}

// Scriptable SW-broker fake. opts:
//   tab: { tabId, tabTitle } | null (null → no-target-tab)
//   permissionState: 'granted' | 'denied'
//   streamId: string returned by getStreamId
//   streamIdError: Error thrown by getStreamId
function fakeBroker(opts) {
  const o = opts || {};
  const state = {
    resolveCalls: 0,
    queryCalls: 0,
    streamIdCalls: 0,
    tabIdsSeen: []
  };
  return {
    state,
    resolveTargetTab: async () => {
      state.resolveCalls++;
      if (o.tab === undefined || o.tab === null) {
        return { ok: true, tabId: null, tabTitle: null, reason: 'no-target-tab' };
      }
      return { ok: true, tabId: o.tab.tabId, tabTitle: o.tab.tabTitle };
    },
    queryCapturePermission: async () => {
      state.queryCalls++;
      return { ok: true, permissionState: o.permissionState || 'granted' };
    },
    getStreamId: async (tabId) => {
      state.streamIdCalls++;
      state.tabIdsSeen.push(tabId);
      if (o.streamIdError) {
        throw o.streamIdError;
      }
      return { ok: true, streamId: o.streamId || 'fake-stream-id-1' };
    }
  };
}

function namedError(name) {
  const e = new Error(name + ': scripted');
  e.name = name;
  return e;
}

function makeSelector(overrides) {
  const o = overrides || {};
  const emitted = [];
  const sess = { sid: o.sessionId === undefined ? SID : o.sessionId,
                 gid: o.gameId === undefined ? GID : o.gameId };
  const sel = BS.createCaptureSelector({
    mediaDevices: ('mediaDevices' in o) ? o.mediaDevices : fakeMediaDevices(),
    storage: ('storage' in o) ? o.storage : fakeStorage(),
    broker: ('broker' in o) ? o.broker : fakeBroker({ tab: { tabId: 42, tabTitle: 'Chess Game' } }),
    emitEvent: (eventType, payload, refs) => {
      emitted.push({ eventType, payload, refs: refs === undefined ? null : refs });
      return { eventId: 'event-' + emitted.length };
    },
    getSessionId: () => sess.sid,
    getGameId: () => sess.gid,
    nowUtcIso: () => '2026-10-06T00:00:00.000Z'
  });
  return { sel, emitted, sess };
}

// ------------------------------------------------------------------
// AC1: module loads via the shim; the factory constructs.
// ------------------------------------------------------------------

describe('AC1 — module and factory', () => {
  it('loads in Node via the shim and exposes the factory + validators', () => {
    assert.equal(typeof BS.createCaptureSelector, 'function');
    assert.equal(typeof BS.requireValidScreenCapturePermissionChangedPayload, 'function');
    assert.equal(typeof BS.requireValidScreenCaptureSelectedPayload, 'function');
    assert.deepEqual(BS.CAPTURE_MODES.slice(), ['tab', 'screen']);
  });

  it('constructs with injected fakes and exposes the 4.3 surface', () => {
    const { sel } = makeSelector();
    for (const m of ['listModes', 'select', 'requestPermission', 'getState',
                     'restoreOnBoot', 'announceSelectionForSession']) {
      assert.equal(typeof sel[m], 'function', m + ' must exist');
    }
    assert.equal(sel.storageKey(), 'blindfold.captureMode.v1');
  });

  it('rejects missing emitEvent/thunks', () => {
    assert.throws(() => BS.createCaptureSelector({}), TypeError);
    assert.throws(() => BS.createCaptureSelector({
      emitEvent: () => {}, getSessionId: () => SID
    }), TypeError);
  });

  it('the broker interface is the documented three-method split', () => {
    // Guards the contract §2 split: resolveTargetTab / queryCapturePermission
    // / getStreamId — the only chrome.* surface the selector may touch.
    const b = fakeBroker({});
    for (const m of ['resolveTargetTab', 'queryCapturePermission', 'getStreamId']) {
      assert.equal(typeof b[m], 'function');
    }
  });
});

// ------------------------------------------------------------------
// Validators.
// ------------------------------------------------------------------

describe('payload validators', () => {
  it('accepts the exact 4.3 event shapes', () => {
    assert.doesNotThrow(() => BS.requireValidScreenCapturePermissionChangedPayload({
      captureMode: 'tab', permissionState: 'granted', source: 'request', errorName: null
    }));
    assert.doesNotThrow(() => BS.requireValidScreenCaptureSelectedPayload({
      captureMode: 'tab', tabId: 42, tabTitle: 'Chess Game', source: 'user'
    }));
    assert.doesNotThrow(() => BS.requireValidScreenCaptureSelectedPayload({
      captureMode: null, tabId: null, tabTitle: null, source: 'invalidated'
    }));
  });

  it('rejects extra keys, bad enums, and wrong types', () => {
    assert.throws(() => BS.requireValidScreenCapturePermissionChangedPayload({
      captureMode: 'tab', permissionState: 'granted', source: 'request',
      errorName: null, extra: 1
    }), TypeError);
    assert.throws(() => BS.requireValidScreenCapturePermissionChangedPayload({
      captureMode: 'tab', permissionState: 'maybe', source: 'request', errorName: null
    }), RangeError);
    assert.throws(() => BS.requireValidScreenCaptureSelectedPayload({
      captureMode: 'desktop', tabId: null, tabTitle: null, source: 'user'
    }), RangeError);
    assert.throws(() => BS.requireValidScreenCaptureSelectedPayload({
      captureMode: 'tab', tabId: '42', tabTitle: null, source: 'user'
    }), TypeError);
  });
});

// ------------------------------------------------------------------
// AC2: capture-list-modes.
// ------------------------------------------------------------------

describe('AC2 — capture-list-modes', () => {
  it('reports both modes with honest available/permissionState', async () => {
    const { sel } = makeSelector();
    const res = await sel.listModes();
    assert.equal(res.ok, true);
    assert.equal(res.modes.length, 2);
    const tab = res.modes[0];
    assert.equal(tab.mode, 'tab');
    assert.equal(tab.available, true);
    assert.equal(tab.permissionState, 'granted');
    assert.deepEqual(tab.targetTab, { tabId: 42, tabTitle: 'Chess Game' });
    const screen = res.modes[1];
    assert.equal(screen.mode, 'screen');
    assert.equal(screen.available, true);
    assert.equal(screen.permissionState, 'prompt');
  });

  it('tab mode without a matching game tab reports tabId:null, no-target-tab', async () => {
    const { sel } = makeSelector({ broker: fakeBroker({ tab: null }) });
    const res = await sel.listModes();
    const tab = res.modes[0];
    assert.deepEqual(tab.targetTab,
      { tabId: null, tabTitle: null, reason: 'no-target-tab' });
  });

  it('a revoked tabCapture permission surfaces as denied', async () => {
    const { sel } = makeSelector({
      broker: fakeBroker({ tab: { tabId: 7, tabTitle: 't' }, permissionState: 'denied' })
    });
    const res = await sel.listModes();
    assert.equal(res.modes[0].permissionState, 'denied');
  });

  it('screen mode is unavailable when getDisplayMedia is absent', async () => {
    const { sel } = makeSelector({
      mediaDevices: fakeMediaDevices({ hasDisplayMedia: false })
    });
    const res = await sel.listModes();
    assert.equal(res.modes[1].available, false);
  });
});

// ------------------------------------------------------------------
// AC3: capture-select.
// ------------------------------------------------------------------

describe('AC3 — capture-select', () => {
  it('selects tab mode: persists and emits source user with the target tab', async () => {
    const storage = fakeStorage();
    const { sel, emitted } = makeSelector({ storage });
    const res = await sel.select('tab');
    assert.deepEqual(res, { ok: true, selection: 'tab' });
    assert.equal(storage._store['blindfold.captureMode.v1'], 'tab');
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].eventType, 'screen_capture_selected');
    assert.deepEqual(emitted[0].payload,
      { captureMode: 'tab', tabId: 42, tabTitle: 'Chess Game', source: 'user' });
  });

  it('selects screen mode with tabId/tabTitle null', async () => {
    const storage = fakeStorage();
    const { sel, emitted } = makeSelector({ storage });
    const res = await sel.select('screen');
    assert.deepEqual(res, { ok: true, selection: 'screen' });
    assert.deepEqual(emitted[0].payload,
      { captureMode: 'screen', tabId: null, tabTitle: null, source: 'user' });
  });

  it('unknown mode throws RangeError internally (channel maps to unknown-mode)', () => {
    const { sel } = makeSelector();
    // Synchronous validation (4.2 precedent); the recorder channel defers
    // it into a rejection and maps it to {ok:false, error:'unknown-mode'}.
    assert.throws(() => sel.select('desktop'), RangeError);
  });

  it('storage failure leaves no phantom selection and emits nothing (4.2 SF-1)', async () => {
    const storage = fakeStorage();
    storage.set = async () => { throw new Error('mock storage failure'); };
    const { sel, emitted } = makeSelector({ storage });
    await assert.rejects(() => sel.select('tab'), /storage/);
    const st = await sel.getState();
    assert.equal(st.captureMode, null, 'no live mode after persist failure');
    assert.equal(emitted.length, 0, 'no capture-selected event for a failed persist');
  });

  it('selection works pre-session as a setting; only the event is inert', async () => {
    const storage = fakeStorage();
    const { sel, emitted } = makeSelector({ storage, sessionId: null, gameId: null });
    const res = await sel.select('tab');
    assert.deepEqual(res, { ok: true, selection: 'tab' });
    assert.equal(storage._store['blindfold.captureMode.v1'], 'tab');
    assert.equal(emitted.length, 0, 'no session, no emission');
  });
});

// ------------------------------------------------------------------
// AC4: tab-mode probe — granted; tracks stopped; audioIncluded.
// ------------------------------------------------------------------

describe('AC4 — capture-request-permission (tab, granted)', () => {
  it('grants, stops every probe track, retains no stream, records audioIncluded', async () => {
    const md = fakeMediaDevices();
    const broker = fakeBroker({ tab: { tabId: 42, tabTitle: 'Chess Game' } });
    const { sel, emitted } = makeSelector({ mediaDevices: md, broker });
    const res = await sel.requestPermission('tab');
    assert.equal(res.ok, true);
    assert.equal(res.permissionState, 'granted');
    assert.equal(res.audioIncluded, true);
    assert.equal(res.errorName, null);
    // The probe consumed the SW-supplied streamId via the chromeMediaSource
    // constraints — the declared BLOCKER surface is exercised, not bypassed.
    assert.equal(md.state.gumCalls, 1);
    const c = md.state.constraintsSeen[0];
    assert.equal(c.video.mandatory.chromeMediaSource, 'tab');
    assert.equal(c.video.mandatory.chromeMediaSourceId, 'fake-stream-id-1');
    assert.equal(c.audio.mandatory.chromeMediaSource, 'tab');
    assert.equal(c.audio.mandatory.chromeMediaSourceId, 'fake-stream-id-1');
    assert.equal(broker.state.streamIdCalls, 1);
    assert.deepEqual(broker.state.tabIdsSeen, [42]);
    // Every probe track stopped before the probe resolved.
    assert.ok(c);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].eventType, 'screen_capture_permission_changed');
    assert.deepEqual(emitted[0].payload,
      { captureMode: 'tab', permissionState: 'granted', source: 'request', errorName: null });
  });

  it('concurrent probes share the in-flight request', async () => {
    const md = fakeMediaDevices();
    const { sel } = makeSelector({ mediaDevices: md });
    const [a, b] = await Promise.all([
      sel.requestPermission('tab'), sel.requestPermission('tab')
    ]);
    assert.equal(a.permissionState, 'granted');
    assert.equal(b.permissionState, 'granted');
    assert.equal(md.state.gumCalls, 1, 'one probe for two concurrent callers');
  });
});

// ------------------------------------------------------------------
// AC5: denied; vanished target.
// ------------------------------------------------------------------

describe('AC5 — capture-request-permission (denied / vanished target)', () => {
  it('NotAllowedError → denied state with the raw error name', async () => {
    const md = fakeMediaDevices({ gumError: namedError('NotAllowedError') });
    const { sel, emitted } = makeSelector({ mediaDevices: md });
    const res = await sel.requestPermission('tab');
    assert.equal(res.ok, true);
    assert.equal(res.permissionState, 'denied');
    assert.equal(res.errorName, 'NotAllowedError');
    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0].payload,
      { captureMode: 'tab', permissionState: 'denied', source: 'request',
        errorName: 'NotAllowedError' });
  });

  it('vanished target tab → invalidated, tab binding cleared, no silent fallback', async () => {
    const storage = fakeStorage();
    const broker = fakeBroker({ tab: null });
    const { sel, emitted } = makeSelector({ storage, broker });
    await sel.select('tab');
    emitted.length = 0;
    const res = await sel.requestPermission('tab');
    assert.equal(res.ok, false);
    assert.equal(res.errorName, 'no-target-tab');
    const st = await sel.getState();
    assert.equal(st.tabId, null, 'tab binding cleared');
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].eventType, 'screen_capture_selected');
    assert.deepEqual(emitted[0].payload,
      { captureMode: 'tab', tabId: null, tabTitle: null, source: 'invalidated' });
  });

  it('tab gone mid-probe (NotFoundError) invalidates the target', async () => {
    const md = fakeMediaDevices({ gumError: namedError('NotFoundError') });
    const { sel, emitted } = makeSelector({ mediaDevices: md });
    const res = await sel.requestPermission('tab');
    assert.equal(res.permissionState, 'unknown');
    const invalidated = emitted.filter(
      (e) => e.eventType === 'screen_capture_selected' &&
             e.payload.source === 'invalidated');
    assert.equal(invalidated.length, 1, 'the vanished target is invalidated');
    assert.deepEqual(invalidated[0].payload,
      { captureMode: null, tabId: null, tabTitle: null, source: 'invalidated' });
  });
});

// ------------------------------------------------------------------
// AC6: boot restore.
// ------------------------------------------------------------------

describe('AC6 — restoreOnBoot', () => {
  it("stored 'tab' + matching game tab → source restored", async () => {
    const storage = fakeStorage({ 'blindfold.captureMode.v1': 'tab' });
    const { sel, emitted } = makeSelector({ storage });
    const res = await sel.restoreOnBoot();
    assert.deepEqual(res, { ok: true, selection: 'tab', source: 'restored' });
    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0].payload,
      { captureMode: 'tab', tabId: 42, tabTitle: 'Chess Game', source: 'restored' });
  });

  it("stored 'screen' restores as-is (no target to validate)", async () => {
    const storage = fakeStorage({ 'blindfold.captureMode.v1': 'screen' });
    const { sel, emitted } = makeSelector({ storage });
    const res = await sel.restoreOnBoot();
    assert.deepEqual(res, { ok: true, selection: 'screen', source: 'restored' });
    assert.deepEqual(emitted[0].payload,
      { captureMode: 'screen', tabId: null, tabTitle: null, source: 'restored' });
  });

  it('stored tab with no matching game tab → invalidated, no active-tab fallback', async () => {
    const storage = fakeStorage({ 'blindfold.captureMode.v1': 'tab' });
    const { sel, emitted } = makeSelector({
      storage, broker: fakeBroker({ tab: null })
    });
    const res = await sel.restoreOnBoot();
    assert.deepEqual(res, { ok: true, selection: 'tab', source: 'invalidated' });
    assert.deepEqual(emitted[0].payload,
      { captureMode: 'tab', tabId: null, tabTitle: null, source: 'invalidated' });
  });

  it('no stored mode → null, silent', async () => {
    const { sel, emitted } = makeSelector();
    const res = await sel.restoreOnBoot();
    assert.equal(res, null);
    assert.equal(emitted.length, 0);
  });
});

// ------------------------------------------------------------------
// AC7: screen mode — no media call, prompt state.
// ------------------------------------------------------------------

describe('AC7 — screen mode permission is inherently prompt', () => {
  it('performs NO media call and reports prompt + picker-at-start', async () => {
    const md = fakeMediaDevices();
    const { sel, emitted } = makeSelector({ mediaDevices: md });
    const res = await sel.requestPermission('screen');
    assert.deepEqual(res, {
      ok: true, permissionState: 'prompt', note: 'picker-at-start', errorName: null
    });
    assert.equal(md.state.gumCalls, 0, 'no getUserMedia for screen mode');
    assert.equal(emitted.length, 0, 'no permission event for the prompt state');
  });
});

// ------------------------------------------------------------------
// Recorder channel routing + session announcement.
// ------------------------------------------------------------------

describe('recorder channel routing', () => {
  function makeRecorder(overrides) {
    const o = overrides || {};
    const sentToWriter = [];
    const chromeNs = {
      runtime: {
        sendMessage: (msg) => {
          sentToWriter.push(msg);
          return Promise.resolve({ ok: true, eventId: msg.event && msg.event.eventId });
        },
        onMessage: { addListener: () => true }
      }
    };
    const rec = BS.createOffscreenRecorder(Object.assign({
      chromeNs, announce: false,
      mediaDevices: o.mediaDevices || fakeMediaDevices(),
      storage: o.storage || fakeStorage(),
      broker: o.broker || fakeBroker({ tab: { tabId: 42, tabTitle: 'Chess Game' } }),
      selectorClock: () => '2026-10-06T00:00:00.000Z'
    }, o.recorderOpts || {}));
    function send(msg) {
      return new Promise((resolve) => {
        const r = rec.onRuntimeMessage(
          Object.assign({ kind: 'recorder', v: 1 }, msg), {}, resolve);
        if (r === false) {
          resolve('sync-false');
        }
      });
    }
    return { rec, send, sentToWriter };
  }

  it('routes capture-list-modes / capture-select / capture-request-permission / capture-get-state', async () => {
    const { send } = makeRecorder();
    await send({ msg: 'recorder-set-session', sessionId: SID, gameId: GID });
    const list = await send({ msg: 'capture-list-modes' });
    assert.equal(list.ok, true);
    assert.equal(list.modes.length, 2);
    const s = await send({ msg: 'capture-select', captureMode: 'tab' });
    assert.deepEqual(s, { ok: true, selection: 'tab' });
    const p = await send({ msg: 'capture-request-permission', captureMode: 'tab' });
    assert.equal(p.permissionState, 'granted');
    assert.equal(p.audioIncluded, true);
    const st = await send({ msg: 'capture-get-state' });
    assert.deepEqual(st, {
      ok: true, captureMode: 'tab', tabId: 42, tabTitle: 'Chess Game',
      permissionState: 'granted'
    });
  });

  it("capture-select with an unknown mode → {ok:false, error:'unknown-mode'}, never throws", async () => {
    const { send } = makeRecorder();
    const res = await send({ msg: 'capture-select', captureMode: 'desktop' });
    assert.deepEqual(res, { ok: false, error: 'unknown-mode' });
    const res2 = await send({ msg: 'capture-select', captureMode: 42 });
    assert.deepEqual(res2, { ok: false, error: 'unknown-mode' });
  });

  it('session activation announces the capture selection once with its actual source', async () => {
    const storage = fakeStorage({ 'blindfold.captureMode.v1': 'screen' });
    const { rec, send, sentToWriter } = makeRecorder({ storage });
    // Boot restore runs before any session: silent (inert).
    await rec.getCaptureSelector().restoreOnBoot();
    await send({ msg: 'recorder-set-session', sessionId: null, gameId: null });
    const before = sentToWriter.filter(
      (m) => m.event && m.event.eventType === 'screen_capture_selected').length;
    assert.equal(before, 0, 'restore is inert pre-session');
    // Activate a session: the restored selection announces once.
    await send({ msg: 'recorder-set-session', sessionId: SID, gameId: GID });
    const announced = sentToWriter.filter(
      (m) => m.event && m.event.eventType === 'screen_capture_selected');
    assert.equal(announced.length - before, 1, 'exactly one session announcement');
    assert.deepEqual(announced[announced.length - 1].event.payload,
      { captureMode: 'screen', tabId: null, tabTitle: null, source: 'restored' });
    // Re-setting the same session does not re-announce.
    await send({ msg: 'recorder-set-session', sessionId: SID, gameId: GID });
    const after = sentToWriter.filter(
      (m) => m.event && m.event.eventType === 'screen_capture_selected').length;
    assert.equal(after, announced.length, 'no duplicate announcement');
  });

  it('unknown capture msg is ignored, never throws', async () => {
    const { send } = makeRecorder();
    const res = await send({ msg: 'capture-frobnicate' });
    assert.equal(res, 'sync-false');
  });
});

// ------------------------------------------------------------------
// AC8: diff discipline — only 4.3 files; no MediaRecorder; manifest;
// content scripts untouched.
// ------------------------------------------------------------------

describe('AC8 — diff discipline', () => {
  it('content scripts are byte-identical to HEAD', () => {
    // Honest cumulative evolution (4.4): device_selection.js leaves this
    // list — 4.4 legitimately kind-branches the probe constraints and
    // parameterizes the validator messages (see its pin in
    // tests/device_selection.test.js).
    // Honest cumulative evolution (4.5): db.js leaves this list — 4.5
    // legitimately bumps DB_VERSION 1 → 2 and adds the
    // recording_manifest store (see its pin in
    // tests/format_support.test.js).
    // Honest cumulative evolution (5.1): content.js + chess_utils.js leave
    // this list — 5.1 legitimately wires the Start/Stop install into
    // content.js and adds the additive getLastObservedEnd getter to
    // chess_utils.js (pinned in tests/session_controls.test.js AC7).
    for (const f of ['sounds.js', 'lifecycle.js',
                     'sender.js', 'status_indicator.js', 'event_envelope.js',
                     'session_identity.js', 'session_conditions.js',
                     'game_records.js', 'writer.js', 'session_store.js']) {
      const head = execSync(`git show HEAD:${f}`, { cwd: REPO, stdio: 'pipe' }).toString();
      const current = fs.readFileSync(path.join(REPO, f), 'utf8');
      assert.strictEqual(current, head, `${f} changed but 4.4 must not touch it`);
    }
  });

  it('only 4.3/4.4 files appear in git status', () => {
    const status = execSync('git status --porcelain', { cwd: REPO }).toString();
    const changed = status.split('\n').filter((l) => l.trim()).map((l) => l.slice(3).trim());
    const allowed = new Set([
      'capture_selection.js',
      'capture_broker.js',
      'recorder.js',
      'recorder.html',
      'recording_host.js',
      'sw.js',
      'manifest.json',
      // Honest cumulative evolution: 4.4 legitimately modifies
      // device_selection.js (video probe kind-branch + validator
      // messages), pinned by its own suite's diff-discipline test.
      'device_selection.js',
      'tests/capture_selection.test.js',
      'tests/capture_broker.test.js',
      'tests/manifest_sw.test.js',
      'tests/recording_host.test.js',
      'tests/device_selection.test.js',
      // Honest cumulative evolution: this task's pin evolution touches the
      // other suites' diff-discipline allowlists with justification
      // comments (2.x/3.x/4.1/4.2 precedent).
      'tests/attempt_tracker.test.js',
      'tests/db.test.js',
      'tests/game_lifecycle.test.js',
      'tests/history_tracker.test.js',
      'tests/lifecycle.test.js',
      'tests/retention.test.js',
      'tests/sender.test.js',
      'tests/session_store.test.js',
      'tests/speech.test.js',
      'tests/status_indicator.test.js',
      'tests/visibility.test.js',
      'tests/writer.test.js',
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
      // Honest cumulative evolution: the 4.3 DECISIONS.md entry (task
      // decision log, coordinator convention) lands with the build.
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
      // Honest cumulative evolution: 4.2 (microphone selection and
      // permission handling) legitimately evolved this pin after it was
      // written.
      '.autodev/evidence/4.2.review.md',
      '.autodev/evidence/4.2.behavior.md',
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
      '.autodev/evidence/6.3.build.md',
      
      
    ]);
    for (const f of changed) {
      assert.ok(allowed.has(f), `unexpected modified file: ${f}`);
    }
  });

  it('no MediaRecorder token in product code (4.3 boundary)', () => {
    // Comments stripped first so boundary-documenting mentions do not
    // count as functional code (4.1/4.2 precedent).
    for (const f of ['capture_selection.js', 'capture_broker.js', 'recorder.js',
                     'recording_host.js']) {
      const src = fs.readFileSync(path.join(REPO, f), 'utf8')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      assert.ok(!/MediaRecorder/.test(src), `${f} must not reference MediaRecorder`);
    }
  });
});
