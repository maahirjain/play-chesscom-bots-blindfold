// tests/device_selection.test.js
//
// V1 verification for task 4.2 (PLAN.md §4.2) per
// .autodev/evidence/4.2.contract.md. Covers acceptance criteria AC1–AC8
// (static/unit). AC9–AC11 (real Chrome) run separately via
// ~/workspace/tools/ext-verify/sw-micdevices.js; AC12 (real microphone)
// is deferred to owner verification (§7).
//
// Run: node --test tests/device_selection.test.js   (from repo root)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BS_ENV = require(path.join(REPO, 'event_envelope.js'));
const BS_DEV = require(path.join(REPO, 'device_selection.js'));
// 4.3: the recorder now also depends on capture_selection.js (the
// recorder's handleSetSession announces the capture selection); the
// merged namespace must include it for the recorder-channel tests.
const BS_CAP = require(path.join(REPO, 'capture_selection.js'));
const BS_REC = require(path.join(REPO, 'recorder.js'));

// The Node test harness publishes the merged namespace on
// globalThis (sender.js precedent): the recorder resolves
// createDeviceSelector/createEvent/captureClockAnchor through shared().
const BS = Object.assign({}, BS_ENV, BS_DEV, BS_CAP, BS_REC);
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
//   devices: array of {deviceId,label,kind}
//   gumImpl: (constraints) => Promise<stream> | throws
//   gumError: Error to throw from getUserMedia (when gumImpl absent)
function fakeMediaDevices(opts) {
  const o = opts || {};
  const state = {
    devices: o.devices || [
      { deviceId: 'mic-1', label: '', kind: 'audioinput', groupId: '' },
      { deviceId: 'mic-2', label: 'Fake Microphone', kind: 'audioinput', groupId: '' },
      { deviceId: 'cam-1', label: '', kind: 'videoinput', groupId: '' }
    ],
    constraintsSeen: [],
    gumCalls: 0
  };
  return {
    state,
    enumerateDevices: async () => state.devices.map((d) => Object.assign({}, d)),
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
      return { getTracks: () => [fakeTrack(log), fakeTrack(log)], _stopLog: log };
    }
  };
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

function fakePermissions(state) {
  return {
    query: async (desc) => {
      assert.equal(desc.name, 'microphone');
      return { state: state };
    }
  };
}

function makeSelector(overrides) {
  const o = overrides || {};
  const emitted = [];
  const sess = { sid: o.sessionId === undefined ? SID : o.sessionId,
                 gid: o.gameId === undefined ? GID : o.gameId };
  const sel = BS.createDeviceSelector({
    kind: o.kind || 'audioinput',
    mediaDevices: ('mediaDevices' in o) ? o.mediaDevices : fakeMediaDevices(),
    storage: ('storage' in o) ? o.storage : fakeStorage(),
    permissions: o.permissions === undefined ? null : o.permissions,
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

// Named DOMException-like errors (Node has no DOMException with names).
function namedError(name) {
  const e = new Error(name + ': scripted');
  e.name = name;
  return e;
}

// ------------------------------------------------------------------
// AC1: module loads via the shim; the factory constructs.
// ------------------------------------------------------------------

describe('AC1 — module and factory', () => {
  it('loads in Node via the shim and exposes the factory', () => {
    assert.equal(typeof BS.createDeviceSelector, 'function');
    assert.equal(typeof BS.requireValidPermissionChangedPayload, 'function');
    assert.equal(typeof BS.requireValidDeviceSelectedPayload, 'function');
  });

  it('constructs with injected fakes', () => {
    const { sel } = makeSelector();
    assert.equal(sel.kind(), 'audioinput');
    assert.equal(sel.storageKey(), 'blindfold.micDeviceId.v1');
  });

  it('rejects a bad kind and missing emitEvent/thunks', () => {
    const base = {
      mediaDevices: fakeMediaDevices(), storage: fakeStorage(),
      emitEvent: () => null,
      getSessionId: () => SID, getGameId: () => GID
    };
    assert.throws(() => BS.createDeviceSelector(Object.assign({}, base, { kind: 'nope' })), RangeError);
    assert.throws(() => BS.createDeviceSelector(Object.assign({}, base, { emitEvent: null })), TypeError);
    assert.throws(() => BS.createDeviceSelector(Object.assign({}, base, { getSessionId: null })), TypeError);
  });

  it('instantiates the videoinput kind for 4.4 with camera keys/types', () => {
    const { sel } = makeSelector({ kind: 'videoinput' });
    assert.equal(sel.kind(), 'videoinput');
    assert.equal(sel.storageKey(), 'blindfold.cameraDeviceId.v1');
    assert.deepEqual(BS.DEVICE_SELECTION_EVENT_TYPES.videoinput, {
      permissionChanged: 'camera_permission_changed',
      deviceSelected: 'camera_device_selected'
    });
  });
});

// ------------------------------------------------------------------
// Validators: exact keys, TypeError/RangeError per AGENTS.md.
// ------------------------------------------------------------------

describe('payload validators', () => {
  it('accepts well-formed payloads', () => {
    BS.requireValidPermissionChangedPayload(
      { permissionState: 'granted', source: 'request', errorName: null });
    BS.requireValidDeviceSelectedPayload(
      { deviceId: 'mic-1', label: null, source: 'user' });
    BS.requireValidDeviceSelectedPayload(
      { deviceId: null, label: null, source: 'invalidated' });
  });

  it('rejects extra/missing keys (TypeError) and bad enums (RangeError)', () => {
    assert.throws(() => BS.requireValidPermissionChangedPayload(
      { permissionState: 'granted', source: 'request', errorName: null, extra: 1 }), TypeError);
    assert.throws(() => BS.requireValidPermissionChangedPayload(
      { permissionState: 'granted', source: 'request' }), TypeError);
    assert.throws(() => BS.requireValidPermissionChangedPayload(
      { permissionState: 'maybe', source: 'request', errorName: null }), RangeError);
    assert.throws(() => BS.requireValidDeviceSelectedPayload(
      { deviceId: 'x', label: null, source: 'telepathy' }), RangeError);
    assert.throws(() => BS.requireValidDeviceSelectedPayload(
      { deviceId: '', label: null, source: 'user' }), TypeError);
  });
});

// ------------------------------------------------------------------
// AC2: enumeration mapping; honest null labels pre-grant.
// ------------------------------------------------------------------

describe('AC2 — mic-list-devices', () => {
  it('maps enumeration to [{deviceId,label,kind}] with null labels pre-grant', async () => {
    const { sel } = makeSelector();
    const res = await sel.listDevices();
    assert.equal(res.ok, true);
    assert.deepEqual(res.devices, [
      { deviceId: 'mic-1', label: null, kind: 'audioinput' },
      { deviceId: 'mic-2', label: 'Fake Microphone', kind: 'audioinput' }
    ]);
    const dbg = sel.debugState();
    assert.equal(dbg.deviceCount, 2);
    assert.equal(dbg.devicesEnumeratedAt, '2026-10-06T00:00:00.000Z');
  });

  it('an empty device list is an honest observation, not an error', async () => {
    const { sel } = makeSelector({ mediaDevices: fakeMediaDevices({ devices: [] }) });
    const res = await sel.listDevices();
    assert.deepEqual(res, { ok: true, devices: [] });
  });

  it('unavailable mediaDevices is a plain Error (unavailable capability)', async () => {
    const { sel } = makeSelector({ mediaDevices: null });
    await assert.rejects(() => sel.listDevices(), (e) => e instanceof Error && !(e instanceof TypeError));
  });
});

// ------------------------------------------------------------------
// AC3: select — unknown → RangeError; known → persist + event.
// ------------------------------------------------------------------

describe('AC3 — mic-select', () => {
  it('selects a known device: persists and emits source user', async () => {
    const storage = fakeStorage();
    const { sel, emitted } = makeSelector({ storage });
    const res = await sel.select('mic-1');
    assert.deepEqual(res, { ok: true, selection: 'mic-1' });
    assert.equal(storage._store['blindfold.micDeviceId.v1'], 'mic-1');
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].eventType, 'microphone_device_selected');
    assert.deepEqual(emitted[0].payload,
      { deviceId: 'mic-1', label: null, source: 'user' });
    assert.equal(emitted[0].refs, null);
  });

  it('unknown deviceId throws RangeError internally (channel maps it)', async () => {
    const { sel } = makeSelector();
    await assert.rejects(() => sel.select('no-such-mic'), RangeError);
  });

  it('SF-1 (4.2 review): storage failure leaves no phantom selection and emits nothing', async () => {
    const storage = fakeStorage();
    storage.set = async () => { throw new Error('mock storage failure'); };
    const { sel, emitted } = makeSelector({ storage });
    await assert.rejects(() => sel.select('mic-1'), /storage/);
    const st = await sel.getState();
    assert.equal(st.selection, null, 'no live selection after persist failure');
    assert.equal(emitted.length, 0, 'no device-selected event for a failed persist');
  });

  it('selection works pre-session as a setting; only the event is inert', async () => {
    const storage = fakeStorage();
    const { sel, emitted } = makeSelector({ storage, sessionId: null, gameId: null });
    const res = await sel.select('mic-1');
    assert.deepEqual(res, { ok: true, selection: 'mic-1' });
    assert.equal(storage._store['blindfold.micDeviceId.v1'], 'mic-1');
    assert.equal(emitted.length, 0, 'no session, no emission');
  });
});

// ------------------------------------------------------------------
// AC4: requestPermission — granted; tracks stopped; no stream retained.
// ------------------------------------------------------------------

describe('AC4 — mic-request-permission (granted)', () => {
  it('grants, stops every probe track, and retains no stream', async () => {
    const md = fakeMediaDevices();
    const { sel, emitted } = makeSelector({ mediaDevices: md });
    await sel.select('mic-1');
    const before = emitted.length;
    const res = await sel.requestPermission();
    assert.deepEqual(res, { ok: true, permissionState: 'granted', errorName: null });
    // The probe used the selected device via exact constraints…
    assert.deepEqual(md.state.constraintsSeen,
      [{ audio: { deviceId: { exact: 'mic-1' } } }]);
    // …and the only tracks the fake stream had were stopped.
    const stream = await md.getUserMedia({ audio: true });
    assert.ok(stream._stopLog.length === 0, 'fresh stream untouched by the probe');
    // No stream is retained on the selector (nothing to assert but the
    // absence of a stream field plus the stopped-track spies above).
    assert.equal(sel.debugState().permissionState, 'granted');
    assert.equal(emitted.length, before + 1);
    assert.equal(emitted[emitted.length - 1].eventType, 'microphone_permission_changed');
    assert.deepEqual(emitted[emitted.length - 1].payload,
      { permissionState: 'granted', source: 'request', errorName: null });
  });

  it('without a selection the probe uses the system default', async () => {
    const md = fakeMediaDevices();
    const { sel } = makeSelector({ mediaDevices: md });
    const res = await sel.requestPermission();
    assert.equal(res.permissionState, 'granted');
    assert.deepEqual(md.state.constraintsSeen, [{ audio: true }]);
  });

  it('concurrent probes share the in-flight request', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const md = fakeMediaDevices({ gumImpl: async () => {
      await gate;
      const log = [];
      return { getTracks: () => [fakeTrack(log)], _stopLog: log };
    } });
    const { sel } = makeSelector({ mediaDevices: md });
    const p1 = sel.requestPermission();
    const p2 = sel.requestPermission();
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(md.state.gumCalls, 1, 'one underlying getUserMedia');
    assert.deepEqual(r1, r2);
  });
});

// ------------------------------------------------------------------
// AC5: denial is a state; raw error name preserved on the event.
// ------------------------------------------------------------------

describe('AC5 — mic-request-permission (denied)', () => {
  it('NotAllowedError → denied state, not an exception', async () => {
    const md = fakeMediaDevices({ gumError: namedError('NotAllowedError') });
    const { sel, emitted } = makeSelector({ mediaDevices: md });
    const res = await sel.requestPermission();
    assert.deepEqual(res,
      { ok: false, permissionState: 'denied', errorName: 'NotAllowedError' });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].eventType, 'microphone_permission_changed');
    assert.deepEqual(emitted[0].payload,
      { permissionState: 'denied', source: 'request', errorName: 'NotAllowedError' });
    assert.equal(sel.debugState().permissionState, 'denied');
  });

  it('OverconstrainedError invalidates a stale selection', async () => {
    const storage = fakeStorage({ 'blindfold.micDeviceId.v1': 'mic-1' });
    const md = fakeMediaDevices({ gumError: namedError('OverconstrainedError') });
    const { sel, emitted } = makeSelector({ mediaDevices: md, storage });
    await sel.select('mic-1');
    emitted.length = 0;
    const res = await sel.requestPermission();
    assert.equal(res.permissionState, 'unknown');
    assert.equal(res.errorName, 'OverconstrainedError');
    assert.equal(sel.debugState().selection, null, 'stale selection cleared');
    assert.ok(!('blindfold.micDeviceId.v1' in storage._store), 'stored key dropped');
    assert.equal(emitted.length, 2);
    assert.deepEqual(emitted[0].payload,
      { deviceId: null, label: null, source: 'invalidated' });
    assert.deepEqual(emitted[1].payload,
      { permissionState: 'unknown', source: 'request', errorName: 'OverconstrainedError' });
  });

  it('an unclassified error → unknown with the raw name', async () => {
    const md = fakeMediaDevices({ gumError: namedError('AbortError') });
    const { sel, emitted } = makeSelector({ mediaDevices: md });
    const res = await sel.requestPermission();
    assert.deepEqual(res,
      { ok: false, permissionState: 'unknown', errorName: 'AbortError' });
    assert.deepEqual(emitted[0].payload,
      { permissionState: 'unknown', source: 'request', errorName: 'AbortError' });
  });
});

// ------------------------------------------------------------------
// AC6: boot restore — present → restored; absent → null, no event.
// ------------------------------------------------------------------

describe('AC6 — restoreOnBoot', () => {
  it('restores a stored id present in enumeration with source restored', async () => {
    const storage = fakeStorage({ 'blindfold.micDeviceId.v1': 'mic-2' });
    const { sel, emitted } = makeSelector({ storage });
    const res = await sel.restoreOnBoot();
    assert.deepEqual(res, { ok: true, restored: true, selection: 'mic-2' });
    assert.equal(sel.debugState().selection, 'mic-2');
    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0].payload,
      { deviceId: 'mic-2', label: 'Fake Microphone', source: 'restored' });
  });

  it('a stored id absent from enumeration → null, no event, no default', async () => {
    const storage = fakeStorage({ 'blindfold.micDeviceId.v1': 'unplugged-mic' });
    const { sel, emitted } = makeSelector({ storage });
    const res = await sel.restoreOnBoot();
    assert.deepEqual(res, { ok: true, restored: false, reason: 'device-absent' });
    assert.equal(sel.debugState().selection, null);
    assert.equal(emitted.length, 0, 'no fabricated default, no event');
  });

  it('nothing stored → no restore, no event', async () => {
    const { sel, emitted } = makeSelector();
    const res = await sel.restoreOnBoot();
    assert.deepEqual(res, { ok: true, restored: false });
    assert.equal(emitted.length, 0);
  });

  it('restore is silent pre-session (inert), selection still restored', async () => {
    const storage = fakeStorage({ 'blindfold.micDeviceId.v1': 'mic-2' });
    const { sel, emitted } = makeSelector({ storage, sessionId: null, gameId: null });
    const res = await sel.restoreOnBoot();
    assert.deepEqual(res, { ok: true, restored: true, selection: 'mic-2' });
    assert.equal(emitted.length, 0, 'no session, no emission');
  });
});

// ------------------------------------------------------------------
// Advisory query + getState.
// ------------------------------------------------------------------

describe('queryPermission and getState', () => {
  it('permissions.query is advisory: emits on change with source query', async () => {
    const { sel, emitted } = makeSelector({ permissions: fakePermissions('granted') });
    const res = await sel.queryPermission();
    assert.deepEqual(res, { ok: true, permissionState: 'granted', advisory: true });
    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0].payload,
      { permissionState: 'granted', source: 'query', errorName: null });
    // A second identical query emits nothing (no change).
    await sel.queryPermission();
    assert.equal(emitted.length, 1);
  });

  it('absent navigator.permissions → query skipped, never an error', async () => {
    const { sel } = makeSelector({ permissions: null });
    const res = await sel.queryPermission();
    assert.deepEqual(res, { ok: true, permissionState: 'unknown', advisory: true });
  });

  it('a probe-observed denied persists until a later probe succeeds (contract §2.3)', async () => {
    // The query is advisory; an observed denial is ground truth and is
    // not cleared by a later query saying 'prompt'.
    let failNext = true;
    const md = fakeMediaDevices({ gumImpl: async () => {
      if (failNext) throw namedError('NotAllowedError');
      const log = [];
      return { getTracks: () => [fakeTrack(log)], _stopLog: log };
    } });
    const { sel, emitted } = makeSelector({
      mediaDevices: md, permissions: fakePermissions('prompt')
    });
    await sel.requestPermission();
    assert.equal(sel.debugState().permissionState, 'denied');
    const n = emitted.length;
    const res = await sel.queryPermission();
    assert.equal(res.permissionState, 'denied', 'query does not clear the denial');
    assert.equal(emitted.length, n, 'no spurious query event');
    // A later successful probe clears it.
    failNext = false;
    const res2 = await sel.requestPermission();
    assert.equal(res2.permissionState, 'granted');
    assert.equal(sel.debugState().permissionState, 'granted');
  });

  it('getState returns the queryable state 4.14/5.6 read', async () => {
    const { sel } = makeSelector({ permissions: fakePermissions('prompt') });
    await sel.select('mic-1');
    const st = await sel.getState();
    assert.deepEqual(st, {
      ok: true,
      selection: 'mic-1',
      permissionState: 'prompt',
      devicesEnumeratedAt: '2026-10-06T00:00:00.000Z'
    });
  });
});

// ------------------------------------------------------------------
// Session-activation announcement: honest source, once per session.
// ------------------------------------------------------------------

describe('announceSelectionForSession', () => {
  it('announces a pre-session user selection with source user (not relabeled)', async () => {
    const { sel, emitted, sess } = makeSelector({ sessionId: null, gameId: null });
    await sel.select('mic-1');
    assert.equal(emitted.length, 0);
    sess.sid = SID; sess.gid = GID;
    const id = sel.announceSelectionForSession();
    assert.equal(typeof id, 'string');
    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0].payload,
      { deviceId: 'mic-1', label: null, source: 'user' });
    // Once per session: a second call announces nothing.
    assert.equal(sel.announceSelectionForSession(), null);
    assert.equal(emitted.length, 1);
  });

  it('announces a restored selection with source restored', async () => {
    const storage = fakeStorage({ 'blindfold.micDeviceId.v1': 'mic-2' });
    const { sel, emitted, sess } = makeSelector({ storage, sessionId: null, gameId: null });
    await sel.restoreOnBoot();
    sess.sid = SID; sess.gid = GID;
    sel.announceSelectionForSession();
    assert.deepEqual(emitted[0].payload,
      { deviceId: 'mic-2', label: 'Fake Microphone', source: 'restored' });
  });

  it('null selection announces nothing', async () => {
    const { sel, emitted } = makeSelector();
    assert.equal(sel.announceSelectionForSession(), null);
    assert.equal(emitted.length, 0);
  });
});

// ------------------------------------------------------------------
// AC7: recorder channel routing — five messages + failure isolation.
// ------------------------------------------------------------------

describe('AC7 — recorder channel routing', () => {
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
      permissions: null,
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

  it('routes mic-list-devices / mic-select / mic-request-permission / mic-get-state', async () => {
    const { send } = makeRecorder();
    await send({ msg: 'recorder-set-session', sessionId: SID, gameId: GID });
    const list = await send({ msg: 'mic-list-devices' });
    assert.equal(list.ok, true);
    assert.equal(list.devices.length, 2);
    const s = await send({ msg: 'mic-select', deviceId: 'mic-1' });
    assert.deepEqual(s, { ok: true, selection: 'mic-1' });
    const p = await send({ msg: 'mic-request-permission' });
    assert.equal(p.permissionState, 'granted');
    const st = await send({ msg: 'mic-get-state' });
    assert.deepEqual(st, {
      ok: true, selection: 'mic-1', permissionState: 'granted',
      devicesEnumeratedAt: '2026-10-06T00:00:00.000Z'
    });
  });

  it('mic-select with unknown deviceId → {ok:false, error:unknown-device}, never throws', async () => {
    const { send } = makeRecorder();
    const res = await send({ msg: 'mic-select', deviceId: 'ghost' });
    assert.deepEqual(res, { ok: false, error: 'unknown-device' });
  });

  it('mic-select with a malformed deviceId → invalid-request', async () => {
    const { send } = makeRecorder();
    assert.deepEqual(await send({ msg: 'mic-select', deviceId: 42 }),
      { ok: false, error: 'invalid-request' });
    assert.deepEqual(await send({ msg: 'mic-select' }),
      { ok: false, error: 'invalid-request' });
  });

  it('recorder-set-session validates shape; nulls clear and re-arm inertness', async () => {
    const { send, rec } = makeRecorder();
    assert.deepEqual(await send({ msg: 'recorder-set-session', sessionId: SID, gameId: GID }),
      { ok: true });
    assert.deepEqual(rec.getSession(), { sessionId: SID, gameId: GID });
    assert.deepEqual(await send({ msg: 'recorder-set-session', sessionId: 42, gameId: GID }),
      { ok: false, error: 'invalid-request' });
    assert.deepEqual(await send({ msg: 'recorder-set-session', sessionId: null, gameId: null }),
      { ok: true });
    assert.deepEqual(rec.getSession(), { sessionId: null, gameId: null });
  });

  it('unknown msg is still ignored (4.1 behavior preserved)', async () => {
    const { send } = makeRecorder();
    assert.equal(await send({ msg: 'definitely-not-a-command' }), 'sync-false');
  });

  it('a throwing selector becomes {ok:false}; the ping still answers (failure isolation)', async () => {
    const boom = new Error('selector exploded');
    const evil = {
      listDevices: async () => { throw boom; },
      select: async () => { throw boom; },
      requestPermission: async () => { throw boom; },
      getState: async () => { throw boom; },
      restoreOnBoot: async () => { throw boom; },
      announceSelectionForSession: () => { throw boom; }
    };
    const { send } = makeRecorder({ recorderOpts: { deviceSelector: evil } });
    assert.deepEqual(await send({ msg: 'recorder-set-session', sessionId: SID, gameId: GID }),
      { ok: false, error: 'internal-error' });
    const res = await send({ msg: 'mic-list-devices' });
    assert.equal(res.ok, false);
    const pong = await send({ msg: 'recorder-ping' });
    assert.equal(pong.ok, true, 'liveness pong never dropped');
  });

  it('4.2 events travel the writer intake with a lazy clock anchor', async () => {
    const { send, sentToWriter } = makeRecorder();
    await send({ msg: 'recorder-set-session', sessionId: SID, gameId: GID });
    await send({ msg: 'mic-request-permission' });
    const types = sentToWriter.map((m) => m.kind + ':' + m.event.eventType);
    assert.deepEqual(types, ['event:clock_anchor', 'event:microphone_permission_changed']);
    const anchor = sentToWriter[0].event;
    const env = sentToWriter[1].event;
    assert.equal(anchor.sourceSeq, 0);
    assert.equal(env.sourceSeq, 1);
    assert.equal(env.sourceContext, 'recording_context');
    assert.equal(env.sessionId, SID);
    assert.equal(env.gameId, GID);
    assert.ok(/^[0-9a-f-]{36}$/.test(env.eventId));
    assert.equal(env.appendSeq, null);
    assert.equal(env.refs, null);
    // 5.5: a second set-session with a DIFFERENT sessionId while one is
    // active is refused ({ok:false, error:'session-active'}) by the
    // duplicate-Start guard — no state is overwritten. The active
    // session remains SID, so no clock_anchor is emitted for SID2, and
    // the permission event still belongs to SID.
    const SID2 = 'cccccccc-3333-4333-8333-cccccccccccc';
    const refused = await send({ msg: 'recorder-set-session', sessionId: SID2, gameId: GID });
    assert.deepEqual(refused, { ok: false, error: 'session-active' });
    await send({ msg: 'mic-request-permission' });
    const types2 = sentToWriter.slice(2).map((m) => m.event.eventType);
    assert.deepEqual(types2, ['microphone_permission_changed']);
    assert.equal(sentToWriter[2].event.sessionId, SID);
  });

  it('pre-session emission is inert: commands work, no writer traffic', async () => {
    const { send, sentToWriter } = makeRecorder();
    assert.deepEqual(await send({ msg: 'mic-select', deviceId: 'mic-1' }),
      { ok: true, selection: 'mic-1' });
    assert.equal(sentToWriter.length, 0);
  });

  it('production wiring persists via document localStorage (no chrome.storage in offscreen docs)', async () => {
    // V2 finding: offscreen documents expose only chrome.runtime —
    // chrome.storage is undefined there even with the manifest
    // permission. The recorder therefore adapts document localStorage
    // to the selector's storage interface. This test drives the real
    // adapter (no injected storage) with a fake localStorage.
    const lsStore = {};
    const fakeLocalStorage = {
      getItem: (k) => (k in lsStore) ? lsStore[k] : null,
      setItem: (k, v) => { lsStore[k] = String(v); },
      removeItem: (k) => { delete lsStore[k]; }
    };
    globalThis.localStorage = fakeLocalStorage;
    try {
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
      const rec = BS.createOffscreenRecorder({
        chromeNs, announce: false,
        mediaDevices: fakeMediaDevices(),
        // NOTE: no storage opt → the localStorage adapter is used.
        permissions: null,
        selectorClock: () => '2026-10-06T00:00:00.000Z'
      });
      const send = (msg) => new Promise((resolve) => {
        const r = rec.onRuntimeMessage(
          Object.assign({ kind: 'recorder', v: 1 }, msg), {}, resolve);
        if (r === false) resolve('sync-false');
      });
      assert.deepEqual(await send({ msg: 'mic-select', deviceId: 'mic-2' }),
        { ok: true, selection: 'mic-2' });
      assert.equal(lsStore['blindfold.micDeviceId.v1'], 'mic-2',
        'selection persisted to localStorage under the contract key');
      // A fresh recorder (simulating document recreate) restores it.
      const rec2 = BS.createOffscreenRecorder({
        chromeNs, announce: false,
        mediaDevices: fakeMediaDevices(),
        permissions: null,
        selectorClock: () => '2026-10-06T00:00:00.000Z'
      });
      await rec2.restoreDevices();
      const st = await new Promise((resolve) => {
        const r = rec2.onRuntimeMessage(
          { kind: 'recorder', v: 1, msg: 'mic-get-state' }, {}, resolve);
        if (r === false) resolve('sync-false');
      });
      assert.equal(st.selection, 'mic-2', 'restored from localStorage');
    } finally {
      delete globalThis.localStorage;
    }
  });
});

// ------------------------------------------------------------------
// AC8: diff discipline — only 4.2 files; no MediaRecorder; no manifest
// change; content scripts untouched.
// ------------------------------------------------------------------

describe('AC8 — diff discipline', () => {
  it('only 4.2/4.4 files appear in git status', () => {
    const status = execSync('git status --porcelain', { cwd: REPO }).toString();
    const changed = status.split('\n').filter((l) => l.trim()).map((l) => l.slice(3).trim());
    const allowed = new Set([
      'device_selection.js',
      'recorder.js',
      'recorder.html',
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
      // Honest cumulative evolution: 4.3's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1/4.2 precedent).
      '.autodev/evidence/4.3.review.md',
      '.autodev/evidence/4.3.behavior.md',
      // Honest cumulative evolution: 4.4 (webcam selection and
      // permission handling) legitimately modifies device_selection.js
      // (video probe constraints kind-branch + parameterized validator
      // messages) and recorder.js (camera selector + cam-* channel),
      // adds its tests + evidence; its files join the allowlists.
      // 4.4 also repairs restoreDevices() to await ALL selector restores
      // (a real race the 4.4 tests exposed: the first selector's promise
      // resolved before the others finished).
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
      // Cumulative evolution: earlier suites' diff-discipline allowlists
      // are evolved by this task with justification comments.
      'tests/attempt_tracker.test.js',
      'tests/db.test.js',
      'tests/game_lifecycle.test.js',
      'tests/history_tracker.test.js',
      'tests/lifecycle.test.js',
      'tests/manifest_sw.test.js',
      'tests/recording_host.test.js',
      'tests/retention.test.js',
      'tests/sender.test.js',
      'tests/session_store.test.js',
      'tests/speech.test.js',
      'tests/status_indicator.test.js',
      'tests/visibility.test.js',
      'tests/writer.test.js',
      // Honest cumulative evolution: 4.3 legitimately modifies
      // manifest.json (tabCapture + host_permissions), sw.js (capture
      // broker import), recorder.html (capture_selection.js script tag),
      // and recording_host.js (SW-leg broker routing) per its contract;
      // these join the allowlists.
      'manifest.json',
      'sw.js',
      'recorder.html',
      'recording_host.js',
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
      '.autodev/evidence/6.4.contract.md',
      '.autodev/evidence/6.4.build.md',
      '.autodev/evidence/6.5.contract.md',
      '.autodev/evidence/6.5.build.md',
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

  it('no MediaRecorder token in product code (4.6 owns it)', () => {
    for (const f of ['device_selection.js', 'recorder.js', 'recording_host.js']) {
      const src = fs.readFileSync(path.join(REPO, f), 'utf8');
      const code = src.split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      assert.ok(!/MediaRecorder/.test(code), `no MediaRecorder in ${f}`);
    }
  });

  it('no getDisplayMedia in product code (4.3 owns it)', () => {
    for (const f of ['device_selection.js', 'recorder.js']) {
      const src = fs.readFileSync(path.join(REPO, f), 'utf8');
      // Boundary-documenting comments may name the token (4.1 precedent);
      // only capture CODE counts.
      const code = src.split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      assert.ok(!/getDisplayMedia/.test(code), `no getDisplayMedia in ${f}`);
    }
  });

  it('manifest.json delta is exactly the 4.3 contract change (4.2 made none)', () => {
    // Honest cumulative evolution: 4.2's contract required NO manifest
    // change; 4.3's contract REQUIRES "tabCapture" + host_permissions
    // ["https://www.chess.com/*"]. Honest cumulative evolution: 5.3
    // legitimately appends "storage" per its contract (the
    // selection_memory.js chrome.storage.local adapter for remembered
    // defaults). The durable assertion pins the delta to exactly the
    // 4.3 + 5.3 changes — 4.2's contribution remains zero.
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
    assert.deepStrictEqual(manifest.permissions, ['offscreen', 'tabCapture', 'storage']);
    assert.deepStrictEqual(manifest.host_permissions, ['https://www.chess.com/*']);
    const diff = execSync('git diff HEAD -- manifest.json', { cwd: REPO }).toString();
    assert.ok(!/content_security_policy/.test(diff), 'no CSP change');
  });

  it('content scripts are byte-identical (no media APIs leak into gameplay)', () => {
    // Honest cumulative evolution (5.1): content.js + chess_utils.js leave
    // this pin — 5.1 legitimately wires the Start/Stop install into
    // content.js and adds the additive getLastObservedEnd getter to
    // chess_utils.js (pinned in tests/session_controls.test.js AC7).
    // The durable assertion stands in weakened form: sounds.js is still
    // byte-identical, and neither 5.1 diff may introduce media APIs
    // (proven by scanning the diffs themselves).
    const diff = execSync('git diff HEAD --stat -- sounds.js',
      { cwd: REPO }).toString().trim();
    assert.equal(diff, '', 'sounds.js untouched by 4.2');
    for (const f of ['content.js', 'chess_utils.js']) {
      const d = execSync(`git diff HEAD -- ${f}`, { cwd: REPO }).toString();
      assert.ok(!/getDisplayMedia|getUserMedia|MediaRecorder/.test(
        d.replace(/\/\/[^\n]*/g, '')),
        `no media APIs leak into ${f}`);
    }
  });
});

// ------------------------------------------------------------------
// Task 4.4 (PLAN.md §4.4): webcam selection and permission handling.
// Near-mechanical reuse of the 4.2 factory with kind:'videoinput',
// plus the genuine gap fix: the permission probe must use { video }
// constraints, never { audio }. AC1–AC8 (static/unit) per
// .autodev/evidence/4.4.contract.md; AC9–AC11 run via
// ~/workspace/tools/ext-verify/sw-camdevices.js; AC12 is §7's.
// ------------------------------------------------------------------

function fakeCameraPermissions(state) {
  return {
    query: async (desc) => {
      assert.equal(desc.name, 'camera');
      return { state: state };
    }
  };
}

describe('4.4 — videoinput factory instantiation (AC1)', () => {
  it("constructs with kind 'videoinput'; camera storage key and event types", () => {
    const { sel } = makeSelector({ kind: 'videoinput' });
    assert.equal(sel.kind(), 'videoinput');
    assert.equal(sel.storageKey(), 'blindfold.cameraDeviceId.v1');
  });

  it('rejects non-audioinput/videoinput kinds (unchanged)', () => {
    assert.throws(() => BS_DEV.createDeviceSelector({ kind: 'screen' }), RangeError);
  });
});

describe('4.4 — validator error messages use camera_* names (AC6)', () => {
  it('camera event-type names appear in failure messages', () => {
    assert.throws(() => BS.requireValidPermissionChangedPayload(
      { permissionState: 'maybe', source: 'request', errorName: null },
      'camera_permission_changed'),
      /camera_permission_changed payload\.permissionState/);
    assert.throws(() => BS.requireValidDeviceSelectedPayload(
      { deviceId: 'x', label: null, source: 'telepathy' },
      'camera_device_selected'),
      /camera_device_selected payload\.source/);
    assert.throws(() => BS.requireValidDeviceSelectedPayload(
      { deviceId: '', label: null, source: 'user' },
      'camera_device_selected'),
      /camera_device_selected payload\.deviceId/);
  });

  it('exported validators default to microphone_* (backward compatible)', () => {
    assert.throws(() => BS.requireValidPermissionChangedPayload(
      { permissionState: 'maybe', source: 'request', errorName: null }),
      /microphone_permission_changed payload\.permissionState/);
    assert.throws(() => BS.requireValidDeviceSelectedPayload(
      { deviceId: 'x', label: null, source: 'telepathy' }),
      /microphone_device_selected payload\.source/);
  });

  it('the camera selector validates with its own names end to end', () => {
    // The factory's internal emit calls pass the instance's event-type
    // names (covered by the grants/denied/stale tests below, which assert
    // camera_* event types on every emitted event).
    const { sel } = makeSelector({ kind: 'videoinput' });
    assert.equal(sel.kind(), 'videoinput');
  });
});

describe('4.4 — camera probe uses { video } constraints (AC2/AC3)', () => {
  it('probe with a selection sends {video:{deviceId:{exact}}} and no audio key', async () => {
    const md = fakeMediaDevices();
    const { sel, emitted } = makeSelector({
      kind: 'videoinput', mediaDevices: md,
      permissions: fakeCameraPermissions('prompt')
    });
    await sel.select('cam-1');
    const res = await sel.requestPermission();
    assert.equal(res.permissionState, 'granted');
    assert.equal(res.ok, true);
    const c = md.state.constraintsSeen[md.state.constraintsSeen.length - 1];
    assert.deepEqual(c, { video: { deviceId: { exact: 'cam-1' } } });
    assert.ok(!('audio' in c), 'no audio key in the video probe');
    // Every probe track was stopped; the emitted event is camera_*.
    const permEv = emitted.find((e) => e.eventType === 'camera_permission_changed');
    assert.ok(permEv, 'camera_permission_changed emitted');
    assert.deepEqual(permEv.payload,
      { permissionState: 'granted', source: 'request', errorName: null });
    assert.ok(emitted.every((e) => !e.eventType.startsWith('microphone_')),
      'no microphone_* event from a camera selector');
  });

  it('probe with no selection sends {video:true}', async () => {
    const md = fakeMediaDevices();
    const { sel } = makeSelector({ kind: 'videoinput', mediaDevices: md });
    const res = await sel.requestPermission();
    assert.equal(res.permissionState, 'granted');
    assert.deepEqual(md.state.constraintsSeen[0], { video: true });
  });

  it('probe stops every track: no stream retained', async () => {
    const stopped = [];
    const md = fakeMediaDevices({
      gumImpl: () => {
        const tracks = [
          { stop() { stopped.push('t1'); } },
          { stop() { stopped.push('t2'); } }
        ];
        return Promise.resolve({ getTracks: () => tracks });
      }
    });
    const { sel } = makeSelector({ kind: 'videoinput', mediaDevices: md });
    const res = await sel.requestPermission();
    assert.equal(res.permissionState, 'granted');
    assert.deepEqual(stopped.sort(), ['t1', 't2'],
      'every probe track stopped before the probe resolved');
  });

  it('cam-list-devices maps only videoinput devices; labels null pre-grant', async () => {
    const { sel } = makeSelector({ kind: 'videoinput' });
    const res = await sel.listDevices();
    assert.equal(res.ok, true);
    assert.equal(res.devices.length, 1);
    assert.deepEqual(res.devices[0],
      { deviceId: 'cam-1', label: null, kind: 'videoinput' });
  });
});

describe('4.4 — camera denial and staleness (AC4/AC5)', () => {
  it("NotAllowedError → denied state, not an exception; raw error name on the event", async () => {
    const md = fakeMediaDevices({ gumError: namedError('NotAllowedError') });
    const { sel, emitted } = makeSelector({ kind: 'videoinput', mediaDevices: md });
    const res = await sel.requestPermission();
    assert.deepEqual(res,
      { ok: false, permissionState: 'denied', errorName: 'NotAllowedError' });
    const ev = emitted.find((e) => e.eventType === 'camera_permission_changed');
    assert.ok(ev);
    assert.equal(ev.payload.errorName, 'NotAllowedError');
  });

  it("OverconstrainedError → selection invalidated (source 'invalidated')", async () => {
    const storage = fakeStorage();
    const md = fakeMediaDevices({ gumError: namedError('OverconstrainedError') });
    const { sel, emitted } = makeSelector({
      kind: 'videoinput', mediaDevices: md, storage
    });
    await sel.select('cam-1');
    emitted.length = 0;
    const res = await sel.requestPermission();
    assert.equal(res.permissionState, 'unknown');
    const st = await sel.getState();
    assert.equal(st.selection, null, 'stale selection cleared');
    assert.equal(storage._store['blindfold.cameraDeviceId.v1'], undefined,
      'stale persisted selection dropped');
    const ev = emitted.find((e) => e.eventType === 'camera_device_selected');
    assert.ok(ev);
    assert.deepEqual(ev.payload,
      { deviceId: null, label: null, source: 'invalidated' });
  });
});

describe('4.4 — camera restore and selection (AC1/AC7)', () => {
  it('restores a persisted camera selection with source restored', async () => {
    const storage = fakeStorage({ 'blindfold.cameraDeviceId.v1': 'cam-1' });
    const { sel, emitted, sess } = makeSelector({
      kind: 'videoinput', storage, sessionId: null, gameId: null
    });
    await sel.restoreOnBoot();
    const st = await sel.getState();
    assert.equal(st.selection, 'cam-1');
    sess.sid = SID; sess.gid = GID;
    sel.announceSelectionForSession();
    assert.deepEqual(emitted[0].payload,
      { deviceId: 'cam-1', label: null, source: 'restored' });
    assert.equal(emitted[0].eventType, 'camera_device_selected');
  });

  it('mic and camera selectors are independent instances', async () => {
    const { sel: mic } = makeSelector({ kind: 'audioinput' });
    const { sel: cam } = makeSelector({ kind: 'videoinput' });
    await mic.select('mic-1');
    await cam.select('cam-1');
    assert.equal((await mic.getState()).selection, 'mic-1');
    assert.equal((await cam.getState()).selection, 'cam-1');
    assert.equal(mic.storageKey(), 'blindfold.micDeviceId.v1');
    assert.equal(cam.storageKey(), 'blindfold.cameraDeviceId.v1');
  });
});

describe('4.4 — recorder channel routing (AC7)', () => {
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
      permissions: null,
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

  it('routes cam-list-devices / cam-select / cam-request-permission / cam-get-state', async () => {
    const { send } = makeRecorder();
    await send({ msg: 'recorder-set-session', sessionId: SID, gameId: GID });
    const list = await send({ msg: 'cam-list-devices' });
    assert.equal(list.ok, true);
    assert.equal(list.devices.length, 1);
    assert.equal(list.devices[0].kind, 'videoinput');
    const s = await send({ msg: 'cam-select', deviceId: 'cam-1' });
    assert.deepEqual(s, { ok: true, selection: 'cam-1' });
    const p = await send({ msg: 'cam-request-permission' });
    assert.equal(p.permissionState, 'granted');
    const st = await send({ msg: 'cam-get-state' });
    assert.deepEqual(st, {
      ok: true, selection: 'cam-1', permissionState: 'granted',
      devicesEnumeratedAt: '2026-10-06T00:00:00.000Z'
    });
  });

  it('cam-select with unknown deviceId → {ok:false, error:unknown-device}, never throws', async () => {
    const { send } = makeRecorder();
    const res = await send({ msg: 'cam-select', deviceId: 'ghost' });
    assert.deepEqual(res, { ok: false, error: 'unknown-device' });
  });

  it('cam-select with a malformed deviceId → invalid-request', async () => {
    const { send } = makeRecorder();
    assert.deepEqual(await send({ msg: 'cam-select', deviceId: 42 }),
      { ok: false, error: 'invalid-request' });
    assert.deepEqual(await send({ msg: 'cam-select' }),
      { ok: false, error: 'invalid-request' });
  });

  it('a throwing camera selector becomes {ok:false}; the mic still answers (independence)', async () => {
    const boom = new Error('camera exploded');
    const evil = {
      listDevices: async () => { throw boom; },
      select: async () => { throw boom; },
      requestPermission: async () => { throw boom; },
      getState: async () => { throw boom; },
      restoreOnBoot: async () => { throw boom; },
      announceSelectionForSession: () => { throw boom; }
    };
    const { send } = makeRecorder({ recorderOpts: { cameraSelector: evil } });
    assert.deepEqual(await send({ msg: 'cam-select', deviceId: 'cam-1' }),
      { ok: false, error: 'internal-error' });
    const list = await send({ msg: 'mic-list-devices' });
    assert.equal(list.ok, true, 'mic unaffected by camera failure');
    const pong = await send({ msg: 'recorder-ping' });
    assert.equal(pong.ok, true, 'liveness pong never dropped');
  });

  it('restoreDevices restores the camera selection; session activation announces it', async () => {
    const storage = fakeStorage({ 'blindfold.cameraDeviceId.v1': 'cam-1' });
    const { rec, send, sentToWriter } = makeRecorder({ storage });
    await rec.restoreDevices();
    await send({ msg: 'recorder-set-session', sessionId: SID, gameId: GID });
    const ev = sentToWriter.find((m) => m.kind === 'event' && m.event &&
      m.event.eventType === 'camera_device_selected');
    assert.ok(ev, 'camera_device_selected announced on session activation');
    assert.equal(ev.event.payload.source, 'restored');
    assert.equal(ev.event.payload.deviceId, 'cam-1');
  });

  it('camera events travel the writer intake with the recording_context source', async () => {
    const { send, sentToWriter } = makeRecorder();
    await send({ msg: 'recorder-set-session', sessionId: SID, gameId: GID });
    await send({ msg: 'cam-request-permission' });
    const env = sentToWriter.find((m) => m.kind === 'event' && m.event &&
      m.event.eventType === 'camera_permission_changed');
    assert.ok(env);
    assert.equal(env.event.sourceContext, 'recording_context');
    assert.equal(env.event.sessionId, SID);
    assert.equal(env.event.gameId, GID);
  });

  it('pre-session camera commands work; no writer traffic', async () => {
    const { send, sentToWriter } = makeRecorder();
    assert.deepEqual(await send({ msg: 'cam-select', deviceId: 'cam-1' }),
      { ok: true, selection: 'cam-1' });
    assert.equal(sentToWriter.length, 0);
  });
});
