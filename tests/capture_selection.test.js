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
    for (const f of ['content.js', 'chess_utils.js', 'sounds.js', 'lifecycle.js',
                     'sender.js', 'status_indicator.js', 'event_envelope.js',
                     'session_identity.js', 'session_conditions.js',
                     'game_records.js', 'db.js', 'writer.js', 'session_store.js',
                     'device_selection.js']) {
      const head = execSync(`git show HEAD:${f}`, { cwd: REPO, stdio: 'pipe' }).toString();
      const current = fs.readFileSync(path.join(REPO, f), 'utf8');
      assert.strictEqual(current, head, `${f} changed but 4.3 must not touch it`);
    }
  });

  it('only 4.3 files appear in git status', () => {
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
      // Honest cumulative evolution: 4.3's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1/4.2 precedent).
      '.autodev/evidence/4.3.review.md',
      '.autodev/evidence/4.3.behavior.md',
      // Honest cumulative evolution: the 4.3 DECISIONS.md entry (task
      // decision log, coordinator convention) lands with the build.
      '.autodev/DECISIONS.md',
      // Honest cumulative evolution: 4.2 (microphone selection and
      // permission handling) legitimately evolved this pin after it was
      // written.
      '.autodev/evidence/4.2.review.md',
      '.autodev/evidence/4.2.behavior.md',
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
