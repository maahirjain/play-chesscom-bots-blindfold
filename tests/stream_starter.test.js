// tests/stream_starter.test.js
//
// V1 verification for task 4.6 (PLAN.md §4.6) per
// .autodev/evidence/4.6.contract.md. Covers acceptance criteria AC1–AC8
// (static/unit). AC9–AC11 (real Chrome) run separately via
// ~/workspace/tools/ext-verify/sw-streams.js; AC12 (actual device
// capture + true transient-activation behavior) is deferred to owner
// verification (§7).
//
// 4.6's scope is the stream-start PLUMBING: acquire three MediaStreams,
// construct three MediaRecorders, start them (no timeslice), and write
// one recording-manifest record per stream with the REAL negotiated
// recorder.mimeType and actual per-stream start times. 4.7 owns the
// audio-content policy (what may be heard/stored), not 4.6.
//
// Run: node --test tests/stream_starter.test.js   (from repo root)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BS_STR = require(path.join(REPO, 'stream_starter.js'));
const BS_POL = require(path.join(REPO, 'audio_policy.js'));
const BS_CLK = require(path.join(REPO, 'clock_link.js'));
const BS_FMT = require(path.join(REPO, 'format_support.js'));
const BS_DB = require(path.join(REPO, 'db.js'));
const BS_ENV = require(path.join(REPO, 'event_envelope.js'));
const BS_DEV = require(path.join(REPO, 'device_selection.js'));
const BS_CAP = require(path.join(REPO, 'capture_selection.js'));
const BS_REC = require(path.join(REPO, 'recorder.js'));

// The Node test harness publishes the merged namespace on
// globalThis (sender.js precedent): recorder.js resolves
// createStreamStarter the same way.
const BS = Object.assign({},
  BS_ENV, BS_STR, BS_FMT, BS_DEV, BS_CAP, BS_DB, BS_REC, BS_POL, BS_CLK);
globalThis.BlindfoldSession = BS;

const SID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const GID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SEGS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444'
];

const REQUESTED = {
  microphone: 'audio/webm;codecs=opus',
  screen: 'video/webm;codecs=vp9,opus',
  webcam: 'video/webm;codecs=vp8,opus'
};
// Negotiated types DELIBERATELY diverge from the requested strings —
// the "actual ≠ assumed" proof the contract demands (AC2).
const NEGOTIATED = {
  microphone: 'audio/webm',
  screen: 'video/webm',
  webcam: 'video/webm'
};

// ------------------------------------------------------------------
// Fakes.
// ------------------------------------------------------------------

function makeTrack(kind, deviceId) {
  return {
    kind,
    stopped: false,
    getSettings: () => ({ deviceId: deviceId || null }),
    stop() { this.stopped = true; }
  };
}

function makeStream(tracks) {
  const s = {
    tracks: tracks.slice(),
    getTracks() { return this.tracks; }
  };
  return s;
}

function makeMediaRecorderClass(opts = {}) {
  const instances = [];
  class FakeMR {
    constructor(stream, mrOpts) {
      this.stream = stream;
      this.requestedMimeType = mrOpts ? mrOpts.mimeType : undefined;
      const kind = opts.kindOf ? opts.kindOf(stream) : 'microphone';
      this.mimeType = (opts.negotiated && opts.negotiated[kind]) ||
        this.requestedMimeType;
      this.state = 'inactive';
      this.startArgs = null;
      this.stoppedByUs = false;
      instances.push(this);
      if (opts.constructThrow) { throw opts.constructThrow; }
    }
    start(timeslice) {
      this.startArgs = [timeslice];
      if (opts.startThrow) { throw opts.startThrow; }
      this.state = 'recording';
    }
    stop() { this.state = 'inactive'; this.stoppedByUs = true; }
  }
  return { FakeMR, instances };
}

function makeMediaDevices(route) {
  const calls = [];
  return {
    calls,
    getUserMedia(constraints) {
      calls.push(constraints);
      return Promise.resolve().then(() => route(constraints));
    }
  };
}

function isTabConstraints(c) {
  return !!(c && c.video && c.video.mandatory &&
    c.video.mandatory.chromeMediaSource === 'tab');
}

function makeSelector(state, overrides = {}) {
  const sel = {
    stateCalls: 0,
    recordDefaultCalls: [],
    getState() {
      this.stateCalls++;
      return Promise.resolve(state);
    },
    recordDefault(deviceId) {
      this.recordDefaultCalls.push(deviceId);
      return Promise.resolve({ ok: true, selection: deviceId });
    },
    // recorder.js's set-session path announces selections; the fake is a
    // no-op (the announce path is 4.2/4.3/4.4's own tested behavior).
    announceSelectionForSession() {
      return Promise.resolve({ ok: true, announced: false });
    }
  };
  return Object.assign(sel, overrides);
}

function makeCaptureSelector(mode, tabId = 42) {
  const sel = makeSelector({
    ok: true,
    captureMode: mode,
    tabId: mode === 'tab' ? tabId : null,
    tabTitle: 't',
    permissionState: 'granted'
  });
  return sel;
}

function makeBroker(resolveResult = { ok: true, tabId: 42 },
                    streamResult = { ok: true, streamId: 'stream-tab-42' }) {
  return {
    resolveCalls: 0,
    streamIdCalls: [],
    resolveTargetTab() {
      this.resolveCalls++;
      return Promise.resolve(resolveResult);
    },
    getStreamId(tabId) {
      this.streamIdCalls.push(tabId);
      return Promise.resolve(streamResult);
    }
  };
}

function makeFormatSupport(formats, writeImpl) {
  const records = [];
  return {
    records,
    verifyFormats: () => JSON.parse(JSON.stringify(formats)),
    recordSegmentFormat(input) {
      records.push(input);
      return Promise.resolve(
        typeof writeImpl === 'function' ?
          writeImpl(input) : { ok: true, fileExtension: '.webm' });
    }
  };
}

function makeClocks() {
  let mono = 1000;
  let n = 0;
  return {
    monoCalls: [],
    nowUtcIso: () => {
      const mm = String(10 + n).padStart(2, '0');
      n++;
      return `2026-10-06T12:${mm}:00.000Z`;
    },
    perfNowMs: () => {
      mono += 7;
      return mono;
    }
  };
}

function makeUuids() {
  let i = 0;
  return () => SEGS[i++ % SEGS.length];
}

// A fully scripted world: mic + cam selected by the user (source
// 'user'), tab-mode screen capture, three tracks per expected shape.
function makeWorld(overrides = {}) {
  const micTracks = [makeTrack('audio', 'mic-1')];
  const camTracks = [makeTrack('video', 'cam-1')];
  const tabTracks = [makeTrack('video', null), makeTrack('audio', null)];
  const micStream = makeStream(micTracks);
  const camStream = makeStream(camTracks);
  const tabStream = makeStream(tabTracks);

  const kindOf = overrides.kindOf || ((s) =>
    (s === micStream ? 'microphone' : (s === camStream ? 'webcam' : 'screen')));
  const { FakeMR, instances } = makeMediaRecorderClass({
    negotiated: overrides.negotiated || NEGOTIATED,
    kindOf,
    constructThrow: overrides.constructThrow,
    startThrow: overrides.startThrow
  });

  const route = overrides.route || ((c) => {
    if (c.audio && !c.video) { return micStream; }
    if (c.video && !c.audio) { return camStream; }
    if (isTabConstraints(c)) { return tabStream; }
    throw new Error('unexpected constraints in test route');
  });
  const mediaDevices = makeMediaDevices(route);

  const micSelector = makeSelector({ ok: true, selection: 'mic-1' },
    overrides.micSelector || {});
  const cameraSelector = makeSelector({ ok: true, selection: 'cam-1' },
    overrides.cameraSelector || {});
  const captureSelector = overrides.captureSelector ||
    makeCaptureSelector('tab');
  const broker = overrides.broker || makeBroker();
  const formats = overrides.formats || {
    microphone: [REQUESTED.microphone, 'audio/webm'],
    screen: [REQUESTED.screen, 'video/webm'],
    webcam: [REQUESTED.webcam, 'video/webm']
  };
  const formatSupport = makeFormatSupport(formats, overrides.writeImpl);
  const clocks = overrides.clocks || makeClocks();
  const newUuidV4 = overrides.newUuidV4 || makeUuids();

  const getDisplayMedia = ('getDisplayMedia' in overrides) ?
    overrides.getDisplayMedia :
    (() => Promise.reject(new Error('should not be called in tab mode')));

  const sessionId = overrides.sessionId === undefined ? SID : overrides.sessionId;
  const gameId = overrides.gameId === undefined ? GID : overrides.gameId;

  const starter = BS.createStreamStarter({
    mediaDevices,
    getDisplayMedia,
    MediaRecorder: FakeMR,
    micSelector,
    cameraSelector,
    captureSelector,
    broker,
    formatSupport,
    getSessionId: () => sessionId,
    getGameId: () => gameId,
    nowUtcIso: clocks.nowUtcIso,
    perfNowMs: clocks.perfNowMs,
    newUuidV4
  });

  return {
    starter, mediaDevices, FakeMR, instances, micSelector, cameraSelector,
    captureSelector, broker, formatSupport, clocks,
    micStream, camStream, tabStream, micTracks, camTracks, tabTracks
  };
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ------------------------------------------------------------------
// AC1: full happy path — three streams start, real values recorded.
// ------------------------------------------------------------------

describe('AC1 — happy path: three streams start independently', () => {
  it('loads in Node via the shim and exposes the factory + constants', () => {
    assert.equal(typeof BS.createStreamStarter, 'function');
    assert.deepEqual(BS.STREAM_STARTER_KINDS, ['microphone', 'screen', 'webcam']);
    assert.deepEqual(BS.STREAM_STARTER_STAGES, [
      'verify-formats', 'acquire-stream', 'construct-recorder',
      'start-recorder', 'write-manifest'
    ]);
  });

  it('starts all three streams with per-stream outcomes', async () => {
    const w = makeWorld();
    const res = await w.starter.startStreams();
    assert.equal(res.ok, true);
    assert.equal(res.streams.microphone.ok, true);
    assert.equal(res.streams.screen.ok, true);
    assert.equal(res.streams.webcam.ok, true);
  });

  it('constructs three distinct MediaRecorders on three distinct streams', async () => {
    const w = makeWorld();
    await w.starter.startStreams();
    assert.equal(w.instances.length, 3);
    const streams = w.instances.map((r) => r.stream);
    assert.ok(streams.includes(w.micStream), 'mic stream present');
    assert.ok(streams.includes(w.camStream), 'cam stream present');
    assert.ok(streams.includes(w.tabStream), 'tab stream present');
    assert.equal(new Set(streams).size, 3, 'three DISTINCT streams');
    assert.equal(new Set(w.instances).size, 3, 'three DISTINCT recorders');
    // No timeslice, ondataavailable unset (4.8 owns chunks).
    for (const r of w.instances) {
      assert.equal(r.startArgs.length, 1, 'start called with 0 args');
      assert.equal(r.startArgs[0], undefined, 'no timeslice');
      assert.equal(typeof r.ondataavailable, 'undefined',
        'ondataavailable unset');
      assert.equal(r.state, 'recording');
    }
  });

  it('no AudioContext or track merging in stream_starter.js (V1 pin)', () => {
    const src = fs.readFileSync(path.join(REPO, 'stream_starter.js'), 'utf8');
    const code = src.split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    assert.ok(!/AudioContext/.test(code), 'no AudioContext');
    assert.ok(!/new\s+MediaStream\(/.test(code),
      'no new MediaStream (no track merging)');
    assert.ok(!/addTrack/.test(code), 'no addTrack (no track merging)');
  });

  it('writes one manifest record per stream with real start times', async () => {
    const w = makeWorld();
    const res = await w.starter.startStreams();
    assert.equal(w.formatSupport.records.length, 3);
    const recs = w.formatSupport.records;
    const byKind = {};
    for (const r of recs) { byKind[r.streamKind] = r; }
    for (const kind of ['microphone', 'screen', 'webcam']) {
      const r = byKind[kind];
      assert.ok(r, `manifest record for ${kind}`);
      assert.ok(UUID_V4_RE.test(r.segmentId), 'uuid-v4 segmentId');
      assert.equal(r.sessionId, SID);
      assert.equal(r.gameId, GID);
      assert.equal(r.requestedMimeType, REQUESTED[kind]);
      assert.equal(r.actualMimeType, NEGOTIATED[kind]);
      assert.equal(typeof r.streamStartedAtUtc, 'string');
      assert.equal(typeof r.streamStartedAtMonotonicMs, 'number');
      assert.equal(r.streamStartedAtUtc,
        res.streams[kind].streamStartedAtUtc, 'start time in response too');
    }
    // Segment IDs distinct; monotonic start times differ (not simultaneous).
    const ids = recs.map((r) => r.segmentId);
    assert.equal(new Set(ids).size, 3, 'distinct segmentIds');
    const monos = recs.map((r) => r.streamStartedAtMonotonicMs);
    assert.equal(new Set(monos).size, 3, 'start times differ');
  });

  it('records track presence per stream (4.7/4.14 seam)', async () => {
    const w = makeWorld();
    await w.starter.startStreams();
    const byKind = {};
    for (const r of w.formatSupport.records) { byKind[r.streamKind] = r; }
    assert.equal(byKind.microphone.audioTrackPresent, true);
    assert.equal(byKind.microphone.videoTrackPresent, false);
    assert.equal(byKind.webcam.videoTrackPresent, true);
    assert.equal(byKind.webcam.audioTrackPresent, false);
    assert.equal(byKind.screen.videoTrackPresent, true);
    assert.equal(byKind.screen.audioTrackPresent, true);
  });

  it('populates the live-stream registry for 4.8/4.9/4.13', async () => {
    const w = makeWorld();
    await w.starter.startStreams();
    const active = w.starter.getActiveStreams();
    assert.deepEqual(Object.keys(active).sort(),
      ['microphone', 'screen', 'webcam']);
    for (const kind of ['microphone', 'screen', 'webcam']) {
      const rec = w.starter.getStreamRecord(kind);
      assert.ok(rec.stream && rec.recorder && rec.segmentId,
        `registry record for ${kind}`);
      assert.equal(rec.segmentId,
        w.formatSupport.records.find((r) => r.streamKind === kind).segmentId);
    }
    assert.equal(w.starter.getStreamRecord('bogus'), null);
  });

  it('response carries per-stream actual MIME types + fileExtension', async () => {
    const w = makeWorld();
    const res = await w.starter.startStreams();
    for (const kind of ['microphone', 'screen', 'webcam']) {
      assert.equal(res.streams[kind].actualMimeType, NEGOTIATED[kind]);
      assert.equal(res.streams[kind].fileExtension, '.webm');
    }
  });
});

// ------------------------------------------------------------------
// AC2: actual ≠ assumed — the real recorder.mimeType is what lands in
// the manifest (the proof 4.5's V2 deferred to 4.6).
// ------------------------------------------------------------------

describe('AC2 — real negotiated recorder.mimeType, never the request', () => {
  it('manifest actualMimeType is the recorder instance value', async () => {
    const w = makeWorld();
    const res = await w.starter.startStreams();
    for (const kind of ['microphone', 'screen', 'webcam']) {
      const rec = w.formatSupport.records.find((r) => r.streamKind === kind);
      const inst = w.instances.find((r) => r.stream === rec && false) || null;
      assert.equal(rec.actualMimeType, NEGOTIATED[kind]);
      assert.notEqual(rec.actualMimeType, rec.requestedMimeType,
        'actual differs from requested — this is the point');
      assert.equal(res.streams[kind].actualMimeType, rec.actualMimeType);
    }
  });

  it('constructor receives the first verified candidate', async () => {
    const w = makeWorld();
    await w.starter.startStreams();
    for (const inst of w.instances) {
      const kind = w.micStream === inst.stream ? 'microphone' :
        (w.camStream === inst.stream ? 'webcam' : 'screen');
      assert.equal(inst.requestedMimeType, REQUESTED[kind]);
    }
  });
});

// ------------------------------------------------------------------
// AC3: failure of one stream never blocks the others; partial tracks
// stopped; no manifest record for failed streams.
// ------------------------------------------------------------------

describe('AC3 — per-stream failure independence', () => {
  it('webcam failure leaves mic + screen started', async () => {
    const w = makeWorld({
      route: (c) => {
        if (c.audio && !c.video) { return makeStream([makeTrack('audio', 'mic-1')]); }
        if (c.video && !c.audio) { throw new Error('camera unplugged'); }
        if (isTabConstraints(c)) {
          return makeStream([makeTrack('video', null), makeTrack('audio', null)]);
        }
        throw new Error('unexpected constraints');
      }
    });
    const res = await w.starter.startStreams();
    assert.equal(res.ok, false, 'overall not ok');
    assert.equal(res.streams.microphone.ok, true);
    assert.equal(res.streams.screen.ok, true);
    assert.equal(res.streams.webcam.ok, false);
    assert.equal(res.streams.webcam.stage, 'acquire-stream');
    assert.equal(typeof res.streams.webcam.error, 'string');
    assert.equal(res.streams.webcam.errorName, 'Error');
    // No manifest record for the failed stream; registry has 2.
    assert.equal(w.formatSupport.records.length, 2);
    assert.ok(!w.starter.getStreamRecord('webcam'));
    assert.ok(w.starter.getStreamRecord('microphone'));
    assert.ok(w.starter.getStreamRecord('screen'));
  });

  it('a stream that fails mid-way stops its partial tracks', async () => {
    const victimTracks = [makeTrack('audio', 'mic-1')];
    const w = makeWorld({
      route: (c) => {
        if (c.audio && !c.video) { return makeStream(victimTracks); }
        if (c.video && !c.audio) {
          return makeStream([makeTrack('video', 'cam-1')]);
        }
        return makeStream([makeTrack('video', null)]);
      },
      // verifyFormats finds nothing for microphone → early failure.
      formats: {
        microphone: [],
        screen: [REQUESTED.screen, 'video/webm'],
        webcam: [REQUESTED.webcam, 'video/webm']
      }
    });
    const res = await w.starter.startStreams();
    assert.equal(res.streams.microphone.ok, false);
    assert.equal(res.streams.microphone.stage, 'verify-formats');
    assert.equal(res.streams.microphone.error, 'no-supported-format');
    assert.equal(res.streams.screen.ok, true);
    assert.equal(res.streams.webcam.ok, true);
  });

  it('recorder construction failure stops the acquired stream tracks', async () => {
    const victimTracks = [makeTrack('video', 'cam-1')];
    const w = makeWorld({
      constructThrow: new Error('codec unavailable'),
      route: (c) => {
        if (c.audio && !c.video) {
          return makeStream([makeTrack('audio', 'mic-1')]);
        }
        if (c.video && !c.audio) { return makeStream(victimTracks); }
        return makeStream([makeTrack('video', null)]);
      }
    });
    const res = await w.starter.startStreams();
    for (const kind of ['microphone', 'screen', 'webcam']) {
      assert.equal(res.streams[kind].ok, false);
      assert.equal(res.streams[kind].stage, 'construct-recorder');
    }
    for (const t of victimTracks) {
      assert.equal(t.stopped, true, 'partial webcam tracks stopped');
    }
    assert.equal(w.formatSupport.records.length, 0,
      'no manifest records on total failure');
  });

  it('recorder.start() failure stops tracks and reports stage', async () => {
    const w = makeWorld({ startThrow: new Error('start failed') });
    const res = await w.starter.startStreams();
    for (const kind of ['microphone', 'screen', 'webcam']) {
      assert.equal(res.streams[kind].ok, false);
      assert.equal(res.streams[kind].stage, 'start-recorder');
    }
    for (const t of [...w.micTracks, ...w.camTracks, ...w.tabTracks]) {
      assert.equal(t.stopped, true, 'tracks stopped after start failure');
    }
    assert.equal(w.formatSupport.records.length, 0);
    assert.deepEqual(w.starter.getActiveStreams(), {});
  });

  it('manifest write failure stops the live recorder + tracks (no orphaned recording)', async () => {
    const w = makeWorld({
      writeImpl: (input) =>
        (input.streamKind === 'webcam' ?
          { ok: false, error: 'idb-unavailable' } :
          { ok: true, fileExtension: '.webm' })
    });
    const res = await w.starter.startStreams();
    assert.equal(res.streams.microphone.ok, true);
    assert.equal(res.streams.screen.ok, true);
    assert.equal(res.streams.webcam.ok, false);
    assert.equal(res.streams.webcam.stage, 'write-manifest');
    assert.equal(res.streams.webcam.error, 'idb-unavailable');
    const webcamRecorder = w.instances.find(
      (r) => r.stream === w.camStream);
    assert.equal(webcamRecorder.stoppedByUs, true,
      'live recorder stopped on manifest-write failure');
    for (const t of w.camTracks) {
      assert.equal(t.stopped, true, 'webcam tracks stopped');
    }
    assert.ok(!w.starter.getStreamRecord('webcam'),
      'failed stream not in registry');
  });
});

// ------------------------------------------------------------------
// AC4: guards — no-session, already-started, start-in-progress.
// ------------------------------------------------------------------

describe('AC4 — session and re-entrancy guards', () => {
  it('no session → {ok:false, error:no-session} without touching devices', async () => {
    const w = makeWorld({ sessionId: null });
    const res = await w.starter.startStreams();
    assert.deepEqual(res, { ok: false, error: 'no-session' });
    assert.equal(w.mediaDevices.calls.length, 0, 'no device touched');
    assert.equal(w.formatSupport.records.length, 0);
  });

  it('second start → already-started', async () => {
    const w = makeWorld();
    const first = await w.starter.startStreams();
    assert.equal(first.ok, true);
    const second = await w.starter.startStreams();
    assert.deepEqual(second, { ok: false, error: 'already-started' });
    assert.equal(w.instances.length, 3, 'no new recorders');
  });

  it('concurrent starts → start-in-progress', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const w = makeWorld({
      route: (c) => {
        if (c.audio && !c.video) {
          return gate.then(() => makeStream([makeTrack('audio', 'mic-1')]));
        }
        return makeStream([makeTrack('video', 'cam-1')]);
      }
    });
    const firstP = w.starter.startStreams();
    const second = await w.starter.startStreams();
    assert.deepEqual(second, { ok: false, error: 'start-in-progress' });
    release();
    const first = await firstP;
    assert.equal(first.streams.microphone.ok, true);
  });
});

// ------------------------------------------------------------------
// AC5: default-device honesty — an actually-used-but-unselected device
// is recorded as source:'default' (never 'user'); a recordDefault
// failure fails the stream, not silently.
// ------------------------------------------------------------------

describe('AC5 — unselected device recorded as source:default', () => {
  it('recordDefault persists the actually-used device as default', async () => {
    const micSelector = makeSelector({ ok: true, selection: '' });
    const w = makeWorld({ micSelector });
    const res = await w.starter.startStreams();
    assert.equal(res.streams.microphone.ok, true);
    assert.deepEqual(micSelector.recordDefaultCalls, ['mic-1'],
      'recordDefault called with the track-reported device');
    const rec = w.formatSupport.records.find(
      (r) => r.streamKind === 'microphone');
    assert.equal(rec.effectiveDeviceId, 'mic-1');
  });

  it('recordDefault failure fails the stream honestly and stops tracks', async () => {
    const victimTracks = [makeTrack('audio', 'sys-mic')];
    const micSelector = makeSelector(
      { ok: true, selection: '' },
      { recordDefault: () => Promise.reject(new Error('idb down')) });
    const w = makeWorld({
      micSelector,
      route: (c) => {
        if (c.audio && !c.video) { return makeStream(victimTracks); }
        if (c.video && !c.audio) {
          return makeStream([makeTrack('video', 'cam-1')]);
        }
        return makeStream([makeTrack('video', null)]);
      }
    });
    const res = await w.starter.startStreams();
    assert.equal(res.streams.microphone.ok, false);
    assert.equal(res.streams.microphone.stage, 'acquire-stream');
    assert.equal(res.streams.microphone.error, 'selection-record-failed');
    for (const t of victimTracks) {
      assert.equal(t.stopped, true, 'partial mic tracks stopped');
    }
    // Others unaffected; no mic manifest record.
    assert.equal(res.streams.screen.ok, true);
    assert.equal(res.streams.webcam.ok, true);
    assert.ok(!w.formatSupport.records.some(
      (r) => r.streamKind === 'microphone'));
  });

  it('real recordDefault persists as source:default (never user)', async () => {
    const store = {};
    const storage = {
      get: async (k) => (k in store ? store[k] : null),
      set: async (kv) => { Object.assign(store, kv); }
    };
    const emitted = [];
    const sel = BS.createDeviceSelector({
      kind: 'audioinput',
      mediaDevices: {
        enumerateDevices: async () => [
          { deviceId: 'sys-mic', kind: 'audioinput', label: 'System Mic' }
        ],
        getUserMedia: async () => { throw new Error('not needed here'); }
      },
      storage,
      permissions: null,
      emitEvent: (eventType, payload) => {
        emitted.push({ eventType, payload });
        return { eventId: 'e1' };
      },
      getSessionId: () => SID,
      getGameId: () => GID,
      nowUtcIso: () => '2026-10-06T00:00:00.000Z'
    });
    const wr = await sel.recordDefault('sys-mic');
    assert.equal(wr.ok, true);
    assert.equal(store['blindfold.micDeviceId.v1'], 'sys-mic',
      'persisted under the mic key');
    const st = await sel.getState();
    assert.equal(st.selection, 'sys-mic');
    // getState() intentionally carries no source field; the source is
    // the event payload's contract (4.2's mic-device-selected vocabulary).
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].payload.source, 'default',
      'event source is default, never user');
    assert.equal(emitted[0].payload.deviceId, 'sys-mic');
  });

  it('recordDefault rejects a malformed deviceId (TypeError)', async () => {
    const sel = BS.createDeviceSelector({
      kind: 'audioinput',
      mediaDevices: {
        enumerateDevices: async () => [],
        getUserMedia: async () => { throw new Error('not needed here'); }
      },
      storage: { get: async () => null, set: async () => {} },
      permissions: null,
      emitEvent: () => ({ eventId: 'e' }),
      getSessionId: () => SID,
      getGameId: () => GID,
      nowUtcIso: () => '2026-10-06T00:00:00.000Z'
    });
    // recordDefault validates synchronously (requireDeviceId before any
    // async work) — malformed ids throw TypeError, never a promise.
    assert.throws(() => sel.recordDefault(''), TypeError);
    assert.throws(() => sel.recordDefault(null), TypeError);
    assert.throws(() => sel.recordDefault(42), TypeError);
  });
});

// ------------------------------------------------------------------
// AC6: screen-mode picker honesty — getDisplayMedia InvalidStateError
// (no transient activation in the hidden offscreen document) degrades
// to picker-unavailable; tab mode is the supported path.
// ------------------------------------------------------------------

describe('AC6 — screen-mode picker honesty', () => {
  it('InvalidStateError → picker-unavailable, others still start', async () => {
    const w = makeWorld({
      captureSelector: makeCaptureSelector('screen'),
      getDisplayMedia: () => {
        const e = new Error('transient activation required');
        e.name = 'InvalidStateError';
        return Promise.reject(e);
      }
    });
    const res = await w.starter.startStreams();
    assert.equal(res.streams.microphone.ok, true);
    assert.equal(res.streams.webcam.ok, true);
    assert.equal(res.streams.screen.ok, false);
    assert.equal(res.streams.screen.error, 'picker-unavailable');
    assert.equal(res.streams.screen.errorName, 'InvalidStateError');
    assert.equal(res.streams.screen.stage, 'acquire-stream');
    assert.ok(!w.formatSupport.records.some((r) => r.streamKind === 'screen'),
      'no manifest record for the degraded screen stream');
  });

  it('missing getDisplayMedia entirely → picker-unavailable (not a workaround)', async () => {
    const w = makeWorld({
      captureSelector: makeCaptureSelector('screen'),
      getDisplayMedia: null
    });
    const res = await w.starter.startStreams();
    assert.equal(res.streams.screen.ok, false);
    assert.equal(res.streams.screen.error, 'picker-unavailable');
  });

  it('screen-mode success path (if the platform allows it) writes a manifest record', async () => {
    const dispTracks = [makeTrack('video', null), makeTrack('audio', null)];
    const w = makeWorld({
      captureSelector: makeCaptureSelector('screen'),
      getDisplayMedia: () => Promise.resolve(makeStream(dispTracks))
    });
    const res = await w.starter.startStreams();
    assert.equal(res.streams.screen.ok, true);
    const rec = w.formatSupport.records.find((r) => r.streamKind === 'screen');
    assert.ok(rec, 'manifest record written');
    assert.equal(rec.effectiveDeviceId, null);
  });

  it('document-global getDisplayMedia is called bound (no Illegal invocation)', async () => {
    // Regression: the document-global fallback must bind the method —
    // an unbound reference throws TypeError "Illegal invocation" in a
    // real browser (4.6 V2 found this; injected fakes never caught it).
    const g = globalThis;
    const savedDesc = Object.getOwnPropertyDescriptor(g, 'navigator');
    const dispTracks = [makeTrack('video', null)];
    const fakeMd = {
      getDisplayMedia: function (constraints) {
        if (this !== fakeMd) {
          throw new TypeError('Illegal invocation');
        }
        assert.deepEqual(constraints, { video: true, audio: true });
        return Promise.resolve(makeStream(dispTracks));
      }
    };
    try {
      Object.defineProperty(g, 'navigator', {
        value: { mediaDevices: fakeMd },
        configurable: true, writable: true, enumerable: true
      });
      // No injected mediaDevices/getDisplayMedia for the screen path:
      // mic+cam use the default world route; the screen stream must
      // resolve getDisplayMedia from the (stubbed) document global,
      // bound.
      const w = makeWorld({
        captureSelector: makeCaptureSelector('screen'),
        getDisplayMedia: undefined
      });
      const res = await w.starter.startStreams();
      assert.equal(res.streams.screen.ok, true);
      assert.equal(res.streams.microphone.ok, true);
      assert.equal(res.streams.webcam.ok, true);
    } finally {
      if (savedDesc) {
        Object.defineProperty(g, 'navigator', savedDesc);
      } else {
        delete g.navigator;
      }
    }
  });

  it('tab mode with no target tab → no-target-tab', async () => {
    const w = makeWorld({
      broker: makeBroker({ ok: false, tabId: null, reason: 'no-target-tab' })
    });
    const res = await w.starter.startStreams();
    assert.equal(res.streams.screen.ok, false);
    assert.equal(res.streams.screen.error, 'no-target-tab');
    assert.equal(res.streams.screen.stage, 'acquire-stream');
    assert.equal(res.streams.microphone.ok, true);
    assert.equal(res.streams.webcam.ok, true);
  });

  it('tab mode with no capture mode selected → no-capture-mode', async () => {
    const w = makeWorld({
      captureSelector: makeCaptureSelector(null)
    });
    const res = await w.starter.startStreams();
    assert.equal(res.streams.screen.ok, false);
    assert.equal(res.streams.screen.error, 'no-capture-mode');
  });
});

// ------------------------------------------------------------------
// AC7: channel message recorder-start-streams (driven by §5 later) —
// failure-isolated, session-gated, shaped by the starter.
// ------------------------------------------------------------------

describe('AC7 — recorder-start-streams channel message', () => {
  // The channel handler owns routing + failure isolation; the starter
  // owns the start logic. recorder.js accepts an injected o.streamStarter
  // (its own lazy constructor is exercised in the real document and by
  // the V2 harness).
  function sendThrough(rec, message) {
    return new Promise((resolve) => {
      const r = rec.onRuntimeMessage(
        Object.assign({ kind: 'recorder', v: 1 }, message), {}, resolve);
      if (r === false) { resolve(undefined); }
    });
  }

  it('routes recorder-start-streams and passes the starter result through', async () => {
    const scripted = {
      ok: true,
      streams: {
        microphone: { ok: true, segmentId: SEGS[0] },
        screen: { ok: true, segmentId: SEGS[1] },
        webcam: { ok: true, segmentId: SEGS[2] }
      }
    };
    const rec = BS.createOffscreenRecorder({
      streamStarter: { startStreams: () => Promise.resolve(scripted) }
    });
    const resp = await sendThrough(rec, {
      kind: 'recorder', v: 1, msg: 'recorder-start-streams'
    });
    assert.deepEqual(resp, scripted);
  });

  it('starter rejection is failure-isolated (3.2 SF-1 precedent)', async () => {
    const rec = BS.createOffscreenRecorder({
      streamStarter: {
        startStreams: () => Promise.reject(new Error('starter blew up'))
      }
    });
    const resp = await sendThrough(rec, {
      kind: 'recorder', v: 1, msg: 'recorder-start-streams'
    });
    assert.equal(resp.ok, false);
    assert.equal(typeof resp.error, 'string');
  });

  it('no-session from the starter passes through honestly', async () => {
    const rec = BS.createOffscreenRecorder({
      streamStarter: {
        startStreams: () => Promise.resolve({ ok: false, error: 'no-session' })
      }
    });
    const resp = await sendThrough(rec, {
      kind: 'recorder', v: 1, msg: 'recorder-start-streams'
    });
    assert.deepEqual(resp, { ok: false, error: 'no-session' });
  });

  it('message constant is published', () => {
    assert.equal(BS.RECORDER_MSG_START_STREAMS, 'recorder-start-streams');
  });

  it('recorder.js exposes getStreamStarter (4.8/4.9/4.13 seam)', () => {
    const rec = BS.createOffscreenRecorder({
      streamStarter: { startStreams: () => Promise.resolve({}) }
    });
    assert.equal(typeof rec.getStreamStarter, 'function');
  });

  it('lazy getStreamStarter wires a working starter from document globals', async () => {
    // The real-document path: recorder.js references NO media-capture
    // APIs itself (4.1 boundary, V1-pinned); the starter reads them from
    // the offscreen document's globals. Stub those globals in Node and
    // drive recorder-start-streams end to end through the channel.
    const micTracks = [makeTrack('audio', 'mic-1')];
    const camTracks = [makeTrack('video', 'cam-1')];
    const tabTracks = [makeTrack('video', null), makeTrack('audio', null)];
    const micStream = makeStream(micTracks);
    const camStream = makeStream(camTracks);
    const tabStream = makeStream(tabTracks);
    const { FakeMR, instances } = makeMediaRecorderClass({
      negotiated: NEGOTIATED,
      kindOf: (s) => (s === micStream ? 'microphone' :
        (s === camStream ? 'webcam' : 'screen'))
    });
    const g = globalThis;
    // Node 24 defines globalThis.navigator as a getter-only accessor —
    // plain assignment silently fails. Redefine it for the test and
    // restore the original descriptor afterwards.
    const savedNavigatorDesc =
      Object.getOwnPropertyDescriptor(g, 'navigator');
    const savedMR = g.MediaRecorder;
    const savedPerf = g.performance;
    let mono = 5000;
    try {
      Object.defineProperty(g, 'navigator', {
        value: {
          mediaDevices: {
            getUserMedia: (c) => {
              if (c.audio && !c.video) { return Promise.resolve(micStream); }
              if (c.video && !c.audio) { return Promise.resolve(camStream); }
              return Promise.resolve(tabStream);
            }
          }
        },
        configurable: true,
        writable: true,
        enumerable: true
      });
      g.MediaRecorder = FakeMR;
      g.performance = { now: () => { mono += 11; return mono; } };

      const dbPuts = [];
      const formatSupport = BS.createFormatSupport({
        mediaRecorder: { isTypeSupported: () => true },
        db: { put: async (store, record) => { dbPuts.push({ store, record }); } },
        nowUtcIso: () => '2026-10-06T12:00:00.000Z'
      });
      const rec = BS.createOffscreenRecorder({
        deviceSelector: makeSelector({ ok: true, selection: 'mic-1' }),
        cameraSelector: makeSelector({ ok: true, selection: 'cam-1' }),
        captureSelector: makeCaptureSelector('tab'),
        broker: makeBroker(),
        formatSupport,
        selectorClock: () => '2026-10-06T12:00:00.000Z',
        announce: false
      });
      const setResp = await sendThrough(rec, {
        msg: 'recorder-set-session', sessionId: SID, gameId: GID
      });
      assert.equal(setResp.ok, true);
      const resp = await sendThrough(rec, { msg: 'recorder-start-streams' });
      assert.equal(resp.ok, true);
      assert.equal(resp.streams.microphone.ok, true);
      assert.equal(resp.streams.screen.ok, true);
      assert.equal(resp.streams.webcam.ok, true);
      // The starter read MediaRecorder + getUserMedia from the (stubbed)
      // document globals — recorder.js passed none of them.
      assert.equal(instances.length, 3);
      assert.equal(dbPuts.length, 3);
      assert.equal(dbPuts[0].store, 'recording_manifest');
      for (const { record } of dbPuts) {
        assert.equal(record.actualMimeType, NEGOTIATED[record.streamKind]);
        assert.equal(typeof record.streamStartedAtMonotonicMs, 'number');
        assert.ok(UUID_V4_RE.test(record.segmentId));
      }
      const active = rec.getStreamStarter().getActiveStreams();
      assert.deepEqual(Object.keys(active).sort(),
        ['microphone', 'screen', 'webcam']);
    } finally {
      if (savedNavigatorDesc) {
        Object.defineProperty(g, 'navigator', savedNavigatorDesc);
      } else {
        delete g.navigator;
      }
      g.MediaRecorder = savedMR;
      g.performance = savedPerf;
    }
  });

  it('unknown messages are ignored; no throw', () => {
    const rec = BS.createOffscreenRecorder({});
    const r = rec.onRuntimeMessage({ kind: 'recorder', v: 1, msg: 'nope' },
      () => { throw new Error('must not respond'); });
    assert.equal(r, false);
  });
});

// ------------------------------------------------------------------
// AC8: no new event types; manifest records + response are the trace.
// The 4.5 widening is deliberate and nullable.
// ------------------------------------------------------------------

describe('AC8 — manifest widening is deliberate; no new event types', () => {
  it('MANIFEST_KEYS grew by exactly the 4.6-owned + 4.7-owned + 4.10-owned + two 4.13-owned fields', () => {
    // Honest cumulative evolution (4.7): the manifest validator widens
    // deliberately 13 → 15 with the two 4.7-owned audio-content
    // classifications (screenAudioContent, micAudioContent) — see
    // .autodev/evidence/4.7.contract.md §2. The 4.5/4.6 fields below
    // are unchanged.
    // Honest cumulative evolution (4.10): the validator widens
    // deliberately 15 → 16 with the 4.10-owned clock link
    // (clockSegmentId) — see .autodev/evidence/4.10.contract.md §2.
    // Honest cumulative evolution (4.13): the validator widens
    // deliberately 16 → 18 with the 4.13-owned finalization fields
    // (segmentNumber, finalizedAtUtc) — see
    // .autodev/evidence/4.13.contract.md §2.
    const keys = BS.MANIFEST_KEYS;
    const extra = keys.filter((k) => ![
      'segmentId', 'sessionId', 'gameId', 'streamKind',
      'requestedMimeType', 'actualMimeType', 'fileExtension', 'createdAtUtc'
    ].includes(k));
    assert.deepEqual(extra.sort(), [
      'audioTrackPresent', 'effectiveDeviceId', 'streamStartedAtMonotonicMs',
      'streamStartedAtUtc', 'videoTrackPresent',
      'screenAudioContent', 'micAudioContent',
      'clockSegmentId',
      'segmentNumber', 'finalizedAtUtc'
    ].sort());
    assert.equal(keys.length, 18);
  });

  it('recordSegmentFormat accepts the widened shape (real values)', async () => {
    const db = { puts: [], put: async (store, record) => { db.puts.push({ store, record }); } };
    const fst = BS.createFormatSupport({
      mediaRecorder: { isTypeSupported: () => true },
      db,
      nowUtcIso: () => '2026-10-06T12:00:00.000Z'
    });
    const wr = await fst.recordSegmentFormat({
      segmentId: SEGS[0],
      sessionId: SID,
      gameId: GID,
      streamKind: 'microphone',
      requestedMimeType: 'audio/webm;codecs=opus',
      actualMimeType: 'audio/webm',
      streamStartedAtUtc: '2026-10-06T12:01:00.000Z',
      streamStartedAtMonotonicMs: 1234.5,
      effectiveDeviceId: 'mic-1',
      audioTrackPresent: true,
      videoTrackPresent: false
    });
    assert.equal(wr.ok, true);
    assert.equal(wr.fileExtension, '.webm');
    const rec = db.puts[0].record;
    assert.equal(rec.streamStartedAtUtc, '2026-10-06T12:01:00.000Z');
    assert.equal(rec.streamStartedAtMonotonicMs, 1234.5);
    assert.equal(rec.effectiveDeviceId, 'mic-1');
    assert.equal(rec.audioTrackPresent, true);
    assert.equal(rec.videoTrackPresent, false);
  });

  it('recordSegmentFormat keeps the 4.5 shape working (null defaults)', async () => {
    const db = { puts: [], put: async (store, record) => { db.puts.push({ store, record }); } };
    const fst = BS.createFormatSupport({
      mediaRecorder: { isTypeSupported: () => true },
      db,
      nowUtcIso: () => '2026-10-06T12:00:00.000Z'
    });
    const wr = await fst.recordSegmentFormat({
      segmentId: SEGS[1],
      sessionId: SID,
      gameId: GID,
      streamKind: 'screen',
      requestedMimeType: 'video/webm;codecs=vp9,opus',
      actualMimeType: 'video/webm'
    });
    assert.equal(wr.ok, true);
    const rec = db.puts[0].record;
    assert.equal(rec.streamStartedAtUtc, null);
    assert.equal(rec.streamStartedAtMonotonicMs, null);
    assert.equal(rec.effectiveDeviceId, null);
    assert.equal(rec.audioTrackPresent, null);
    assert.equal(rec.videoTrackPresent, null);
  });

  it('requireValidManifestRecord rejects malformed 4.6 fields', () => {
    const db = { puts: [], put: async () => {} };
    const fst = BS.createFormatSupport({
      mediaRecorder: { isTypeSupported: () => true },
      db,
      nowUtcIso: () => '2026-10-06T12:00:00.000Z'
    });
    assert.ok(fst.requireValidManifestRecord, 'validator exposed');
    const base = {
      segmentId: SEGS[2], sessionId: SID, gameId: GID,
      streamKind: 'webcam', requestedMimeType: 'video/webm',
      actualMimeType: 'video/webm', fileExtension: '.webm',
      createdAtUtc: '2026-10-06T12:00:00.000Z',
      streamStartedAtUtc: null, streamStartedAtMonotonicMs: null,
      effectiveDeviceId: null, audioTrackPresent: null, videoTrackPresent: null,
      // Honest cumulative evolution (4.7): the two 4.7-owned
      // audio-content classifications join the exact-keys shape.
      screenAudioContent: null, micAudioContent: null,
      // Honest cumulative evolution (4.10): the 4.10-owned clock link
      // joins the exact-keys shape (nullable).
      clockSegmentId: null,
      // Honest cumulative evolution (4.13): the 4.13-owned finalization
      // fields join the exact-keys shape (nullable until finalized).
      segmentNumber: null, finalizedAtUtc: null
    };
    assert.doesNotThrow(() => fst.requireValidManifestRecord(base));
    assert.throws(() => fst.requireValidManifestRecord(
      Object.assign({}, base, { streamStartedAtMonotonicMs: 'noon' })), TypeError);
    assert.throws(() => fst.requireValidManifestRecord(
      Object.assign({}, base, { audioTrackPresent: 'yes' })), TypeError);
    assert.throws(() => fst.requireValidManifestRecord(
      Object.assign({}, base, { streamStartedAtUtc: 42 })), TypeError);
    assert.throws(() => fst.requireValidManifestRecord(
      Object.assign({}, base, { effectiveDeviceId: '' })), TypeError);
  });

  it('4.6 adds no new event types', () => {
    for (const f of ['stream_starter.js', 'recorder.js', 'format_support.js',
                     'device_selection.js']) {
      const src = fs.readFileSync(path.join(REPO, f), 'utf8');
      const code = src.split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      assert.ok(!/buildEvent\b/.test(code) || f === 'recorder.js',
        `no event building in ${f}`);
    }
  });
});

// ------------------------------------------------------------------
// Diff-discipline: cumulative pin evolution (justified).
// ------------------------------------------------------------------

describe('diff-discipline pins (4.6 evolution)', () => {
  it('git status shows only 4.6-allowed changes', () => {
    const status = execSync('git status --porcelain', { cwd: REPO }).toString();
    const changed = status.split('\n').filter((l) => l.trim())
      .map((l) => l.slice(3).trim());
    const allowed = new Set([
      // Honest cumulative evolution: 4.6 (stream start plumbing)
      // legitimately adds stream_starter.js, routes
      // recorder-start-streams through recorder.js/recorder.html,
      // adds device_selection.recordDefault, widens format_support.js's
      // manifest fields, and adds its test + evidence; its files join
      // the allowlists.
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
      'tests/capture_broker.test.js',
      'tests/capture_selection.test.js',
      'tests/db.test.js',
      'tests/device_selection.test.js',
      'tests/format_support.test.js',
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

  it('content scripts byte-identical (no gameplay change)', () => {
    const status = execSync('git status --porcelain', { cwd: REPO }).toString();
    const changed = status.split('\n').filter((l) => l.trim())
      .map((l) => l.slice(3).trim());
    // Honest cumulative evolution (5.1): content.js + chess_utils.js leave
    // this list — 5.1 legitimately wires the Start/Stop install into
    // content.js and adds the additive getLastObservedEnd getter to
    // chess_utils.js (pinned in tests/session_controls.test.js AC7).
    for (const f of ['sounds.js']) {
      assert.ok(!changed.includes(f), `${f} must be untouched by 4.6`);
    }
  });

  it('4.5 manifest contract preserved: original 8 fields still exact', () => {
    const original8 = ['segmentId', 'sessionId', 'gameId', 'streamKind',
      'requestedMimeType', 'actualMimeType', 'fileExtension', 'createdAtUtc'];
    for (const k of original8) {
      assert.ok(BS.MANIFEST_KEYS.includes(k), `key retained: ${k}`);
    }
  });
});
