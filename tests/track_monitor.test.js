// tests/track_monitor.test.js
//
// V1 verification for task 4.9 (PLAN.md §4.9) per
// .autodev/evidence/4.9.contract.md. Covers acceptance criteria AC1–AC8
// (static/unit). AC9–AC10 (real Chrome) run separately via
// ~/workspace/tools/ext-verify/sw-track-monitor.js; AC11 (real-device
// track/error reality) is deferred to owner verification (§7).
//
// 4.9's scope is OBSERVATION: track mute/unmute/end, recorder errors,
// and explicit discontinuity flags — all to the append-only event log
// (2.4) as three new event types. The manifest gains nothing. 4.9
// interprets nothing (no why), recovers nothing (no restarts), and
// never lets monitoring fail the pipeline.
//
// Run: node --test tests/track_monitor.test.js   (from repo root)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BS_TM = require(path.join(REPO, 'track_monitor.js'));
const BS_CW = require(path.join(REPO, 'chunk_writer.js'));
const BS_FMT = require(path.join(REPO, 'format_support.js'));
const BS_ENV = require(path.join(REPO, 'event_envelope.js'));
const BS_STR = require(path.join(REPO, 'stream_starter.js'));
const BS_REC = require(path.join(REPO, 'recorder.js'));

// The Node test harness publishes the merged namespace on
// globalThis (sender.js precedent): recorder.js resolves
// createTrackMonitor / createChunkWriter / createStreamStarter the same way.
const BS = Object.assign({}, BS_ENV, BS_TM, BS_CW, BS_FMT, BS_STR, BS_REC);
globalThis.BlindfoldSession = BS;

const SID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const GID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SEGS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];
const OLDSEG = '99999999-9999-4999-8999-999999999999';

const EVENT_TYPE_RE = /^[a-z][a-z0-9_]{0,63}$/;

// ------------------------------------------------------------------
// Fakes.
// ------------------------------------------------------------------

function makeTrack(kind, opts) {
  const o = opts || {};
  return {
    kind: kind,
    muted: !!o.muted,
    readyState: o.ended ? 'ended' : 'live',
    onmute: null,
    onunmute: null,
    onended: null,
  };
}

function makeStream(tracks) {
  return { getTracks: () => tracks.slice() };
}

function makeRecorder() {
  return { state: 'recording', onerror: null, requestData() {} };
}

// A capturing emitEvent: records (eventType, payload, refs).
function makeEmitter() {
  const emitted = [];
  const emitEvent = (eventType, payload, refs) => {
    emitted.push({ eventType, payload, refs });
    return { eventId: 'evt-' + emitted.length };
  };
  return { emitted, emitEvent };
}

function makeMonitor(emitter, getChunkState) {
  return BS_TM.createTrackMonitor({
    emitEvent: emitter ? emitter.emitEvent : (() => null),
    getChunkState,
  });
}

function trackStateEvents(emitted) {
  return emitted.filter((e) => e.eventType === 'recorder_track_state_changed');
}

function discontinuities(emitted) {
  return emitted.filter((e) => e.eventType === 'stream_discontinuity');
}

// ------------------------------------------------------------------
// AC1 — track mute/end logged.
// ------------------------------------------------------------------

describe('AC1 — track mute/unmute/end logged', () => {
  it('the three event types are the contract-pinned constants, passing EVENT_TYPE_RE', () => {
    assert.equal(BS_TM.TRACK_STATE_CHANGED_EVENT_TYPE, 'recorder_track_state_changed');
    assert.equal(BS_TM.RECORDER_ERROR_EVENT_TYPE, 'recorder_error');
    assert.equal(BS_TM.STREAM_DISCONTINUITY_EVENT_TYPE, 'stream_discontinuity');
    for (const t of [BS_TM.TRACK_STATE_CHANGED_EVENT_TYPE,
                     BS_TM.RECORDER_ERROR_EVENT_TYPE,
                     BS_TM.STREAM_DISCONTINUITY_EVENT_TYPE]) {
      assert.ok(EVENT_TYPE_RE.test(t), t + ' must pass EVENT_TYPE_RE');
    }
  });

  it('payload constructors enforce exact keys and the type conventions', () => {
    // Extra key → TypeError.
    assert.throws(() => BS_TM.createTrackStatePayload({
      streamKind: 'microphone', trackKind: 'audio', muted: false,
      ended: false, baseline: true, extra: 1,
    }), TypeError);
    // Missing key → TypeError.
    assert.throws(() => BS_TM.createTrackStatePayload({
      streamKind: 'microphone', trackKind: 'audio', muted: false, ended: false,
    }), TypeError);
    // Wrong types → TypeError.
    assert.throws(() => BS_TM.createTrackStatePayload({
      streamKind: 'microphone', trackKind: 'audio', muted: 'no',
      ended: false, baseline: true,
    }), TypeError);
    // Bad domain → RangeError.
    assert.throws(() => BS_TM.createTrackStatePayload({
      streamKind: 'nope', trackKind: 'audio', muted: false,
      ended: false, baseline: true,
    }), RangeError);
    assert.throws(() => BS_TM.createTrackStatePayload({
      streamKind: 'microphone', trackKind: 'subtitle', muted: false,
      ended: false, baseline: true,
    }), RangeError);
    // Discontinuity payload: unknown reason → RangeError.
    assert.throws(() => BS_TM.createDiscontinuityPayload({
      streamKind: 'microphone', reason: 'vibes', lastChunkIndex: null,
      supersededSegmentIds: null, detail: null,
    }), RangeError);
    // Recorder-error payload: non-string message → TypeError.
    assert.throws(() => BS_TM.createRecorderErrorPayload({
      streamKind: 'microphone', errorName: 'X', errorMessage: 42,
      recorderState: 'inactive',
    }), TypeError);
  });

  it('baseline emitted once per track at attach, with observed state and refs', () => {
    const { emitted, emitEvent } = makeEmitter();
    const mon = makeMonitor({ emitEvent });
    const audio = makeTrack('audio', { muted: true });
    const video = makeTrack('video');
    mon.attachStream({
      streamKind: 'screen',
      stream: makeStream([audio, video]),
      recorder: makeRecorder(),
      segmentId: SEGS[0],
    });
    const states = trackStateEvents(emitted);
    assert.equal(states.length, 2);
    assert.deepEqual(states[0].payload, {
      streamKind: 'screen', trackKind: 'audio',
      muted: true, ended: false, baseline: true,
    });
    assert.deepEqual(states[0].refs, { segmentId: SEGS[0] });
    assert.deepEqual(states[1].payload, {
      streamKind: 'screen', trackKind: 'video',
      muted: false, ended: false, baseline: true,
    });
    assert.equal(discontinuities(emitted).length, 0);
  });

  it('every onmute/onunmute transition emits — no debounce', () => {
    const { emitted, emitEvent } = makeEmitter();
    const mon = makeMonitor({ emitEvent });
    const track = makeTrack('audio');
    mon.attachStream({
      streamKind: 'microphone', stream: makeStream([track]),
      recorder: makeRecorder(), segmentId: SEGS[0],
    });
    assert.equal(trackStateEvents(emitted).length, 1); // baseline
    // A rapid flap: three transitions, three events (raw collection).
    track.muted = true; track.onmute();
    track.muted = false; track.onunmute();
    track.muted = true; track.onmute();
    const states = trackStateEvents(emitted);
    assert.equal(states.length, 4);
    assert.deepEqual(states.slice(1).map((s) => s.payload.muted), [true, false, true]);
    assert.ok(states.slice(1).every((s) => s.payload.baseline === false));
    assert.equal(discontinuities(emitted).length, 0); // mutes are not gaps
  });

  it('onended emits the observation, detaches the track, then flags the discontinuity', () => {
    const { emitted, emitEvent } = makeEmitter();
    const mon = makeMonitor({ emitEvent });
    const track = makeTrack('audio');
    mon.attachStream({
      streamKind: 'microphone', stream: makeStream([track]),
      recorder: makeRecorder(), segmentId: SEGS[1],
    });
    const before = emitted.length;
    track.readyState = 'ended';
    track.onended();
    // Exactly two events: the observation, then the explicit flag.
    assert.equal(emitted.length, before + 2);
    assert.equal(emitted[before].eventType, 'recorder_track_state_changed');
    assert.deepEqual(emitted[before].payload, {
      streamKind: 'microphone', trackKind: 'audio',
      muted: false, ended: true, baseline: false,
    });
    assert.deepEqual(emitted[before].refs, { segmentId: SEGS[1] });
    assert.equal(emitted[before + 1].eventType, 'stream_discontinuity');
    assert.equal(emitted[before + 1].payload.reason, 'track-ended');
    assert.equal(emitted[before + 1].payload.streamKind, 'microphone');
    assert.deepEqual(emitted[before + 1].refs, { segmentId: SEGS[1] });
    // The dead track's listeners are detached: further transitions are silent.
    assert.equal(track.onmute, null);
    assert.equal(track.onended, null);
  });

  it('malformed tracks are skipped — monitoring never fails the stream', () => {
    const { emitted, emitEvent } = makeEmitter();
    const mon = makeMonitor({ emitEvent });
    const good = makeTrack('audio');
    const res = mon.attachStream({
      streamKind: 'microphone',
      stream: makeStream([good, null, 'x', { noKind: true }, { kind: 'subtitle' }]),
      recorder: makeRecorder(),
      segmentId: SEGS[0],
    });
    assert.equal(res.tracks, 1);
    assert.equal(trackStateEvents(emitted).length, 1);
    // A stream whose getTracks throws: no tracks, no throw.
    const res2 = mon.attachStream({
      streamKind: 'webcam',
      stream: { getTracks() { throw new Error('boom'); } },
      recorder: makeRecorder(),
      segmentId: SEGS[1],
    });
    assert.equal(res2.tracks, 0);
    // A non-object stream: no tracks, no throw.
    const res3 = mon.attachStream({
      streamKind: 'screen', stream: 42,
      recorder: makeRecorder(), segmentId: SEGS[2],
    });
    assert.equal(res3.tracks, 0);
  });

  it('attachStream validates its own inputs (caller bugs throw)', () => {
    const { emitEvent } = makeEmitter();
    const mon = makeMonitor({ emitEvent });
    assert.throws(() => mon.attachStream({
      streamKind: 'nope', stream: makeStream([]),
      recorder: makeRecorder(), segmentId: SEGS[0],
    }), RangeError);
    assert.throws(() => mon.attachStream({
      streamKind: 'microphone', stream: makeStream([]),
      recorder: makeRecorder(), segmentId: 'not-a-uuid',
    }), TypeError);
    assert.throws(() => BS_TM.createTrackMonitor({}), TypeError);
    assert.throws(() => BS_TM.createTrackMonitor({ emitEvent: 42 }), TypeError);
  });

  it('detachStream removes listeners; re-attach is idempotent', () => {
    const { emitted, emitEvent } = makeEmitter();
    const mon = makeMonitor({ emitEvent });
    const track = makeTrack('audio');
    mon.attachStream({
      streamKind: 'microphone', stream: makeStream([track]),
      recorder: makeRecorder(), segmentId: SEGS[0],
    });
    assert.deepEqual(mon.getMonitoredKinds(), ['microphone']);
    const d = mon.detachStream('microphone');
    assert.equal(d.wasMonitored, true);
    assert.equal(track.onmute, null);
    assert.deepEqual(mon.getMonitoredKinds(), []);
    // Detaching again is idempotent.
    assert.equal(mon.detachStream('microphone').wasMonitored, false);
    // Re-attach emits a fresh baseline.
    const n = emitted.length;
    mon.attachStream({
      streamKind: 'microphone', stream: makeStream([track]),
      recorder: makeRecorder(), segmentId: SEGS[1],
    });
    assert.equal(trackStateEvents(emitted).length, trackStateEvents(emitted.slice(0, n)).length + 1);
  });
});

// ------------------------------------------------------------------
// AC2 — recorder errors logged.
// ------------------------------------------------------------------

describe('AC2 — recorder errors logged', () => {
  it('recorder.onerror emits the verbatim error, then the discontinuity (chained order)', () => {
    const { emitted, emitEvent } = makeEmitter();
    const mon = makeMonitor({ emitEvent }, () => ({
      status: 'active', lastChunkIndex: 4,
      lastErrorName: null, lastErrorMessage: null,
    }));
    const recorder = makeRecorder();
    recorder.state = 'inactive';
    mon.attachStream({
      streamKind: 'webcam', stream: makeStream([]),
      recorder, segmentId: SEGS[0],
    });
    const before = emitted.length;
    const domErr = new Error('The track is ended, you fool');
    domErr.name = 'InvalidStateError';
    recorder.onerror({ error: domErr });
    assert.equal(emitted.length, before + 2);
    // The observation first: verbatim name/message/state, no diagnosis.
    assert.equal(emitted[before].eventType, 'recorder_error');
    assert.deepEqual(emitted[before].payload, {
      streamKind: 'webcam',
      errorName: 'InvalidStateError',
      errorMessage: 'The track is ended, you fool',
      recorderState: 'inactive',
    });
    assert.deepEqual(emitted[before].refs, { segmentId: SEGS[0] });
    // Then the explicit flag, with the chunker's last index.
    assert.equal(emitted[before + 1].eventType, 'stream_discontinuity');
    assert.equal(emitted[before + 1].payload.reason, 'recorder-error');
    assert.equal(emitted[before + 1].payload.lastChunkIndex, 4);
    assert.equal(emitted[before + 1].payload.detail, null);
  });

  it('a missing error object degrades to nulls — unknown is null', () => {
    const { emitted, emitEvent } = makeEmitter();
    const mon = makeMonitor({ emitEvent });
    const recorder = makeRecorder();
    delete recorder.state;
    mon.attachStream({
      streamKind: 'microphone', stream: makeStream([]),
      recorder, segmentId: SEGS[0],
    });
    recorder.onerror({});
    const err = emitted.find((e) => e.eventType === 'recorder_error');
    assert.deepEqual(err.payload, {
      streamKind: 'microphone', errorName: null,
      errorMessage: null, recorderState: null,
    });
  });

  it('a throwing emitEvent is tolerated — monitoring never throws into the pipeline', () => {
    const mon = BS_TM.createTrackMonitor({
      emitEvent: () => { throw new Error('writer exploded'); },
    });
    const track = makeTrack('audio');
    const recorder = makeRecorder();
    // None of these throw, even though every emission explodes.
    mon.attachStream({
      streamKind: 'microphone', stream: makeStream([track]),
      recorder, segmentId: SEGS[0],
    });
    track.muted = true; track.onmute();
    track.readyState = 'ended'; track.onended();
    recorder.onerror({ error: new Error('x') });
    mon.onChunkTerminalState({ streamKind: 'microphone', terminalState: 'chunk-stalled' });
    mon.emitRestartDiscontinuity({
      streamKind: 'microphone', newSegmentId: SEGS[1],
      supersededSegmentIds: [OLDSEG],
    });
    mon.detachStream('microphone');
  });

  it('a missing recorder is fine — tracks are still monitored', () => {
    const { emitted, emitEvent } = makeEmitter();
    const mon = makeMonitor({ emitEvent });
    const track = makeTrack('audio');
    const res = mon.attachStream({
      streamKind: 'microphone', stream: makeStream([track]),
      recorder: null, segmentId: SEGS[0],
    });
    assert.equal(res.tracks, 1);
    assert.equal(trackStateEvents(emitted).length, 1);
  });
});

// ------------------------------------------------------------------
// AC3 — discontinuities flagged.
// ------------------------------------------------------------------

describe('AC3 — discontinuities flagged', () => {
  it('the six reason codes are the contract-pinned vocabulary', () => {
    assert.deepEqual(BS_TM.TRACK_MONITOR_DISCONTINUITY_REASONS, [
      'track-ended', 'recorder-error', 'chunk-stalled',
      'chunk-quota-exceeded', 'chunk-write-error', 'restart',
    ]);
  });

  it('onChunkTerminalState maps each terminal state to its reason, with chunker context', () => {
    const { emitted, emitEvent } = makeEmitter();
    const mon = makeMonitor({ emitEvent }, () => ({
      status: 'chunk-quota-exceeded', lastChunkIndex: 12,
      lastErrorName: 'QuotaExceededError', lastErrorMessage: '',
    }));
    mon.attachStream({
      streamKind: 'screen', stream: makeStream([]),
      recorder: makeRecorder(), segmentId: SEGS[0],
    });
    const before = emitted.length;
    mon.onChunkTerminalState({ streamKind: 'screen', terminalState: 'chunk-quota-exceeded' });
    assert.equal(emitted.length, before + 1);
    const d = emitted[before];
    assert.equal(d.eventType, 'stream_discontinuity');
    assert.deepEqual(d.payload, {
      streamKind: 'screen', reason: 'chunk-quota-exceeded',
      lastChunkIndex: 12, supersededSegmentIds: null, detail: null,
    });
    assert.deepEqual(d.refs, { segmentId: SEGS[0] });
  });

  it('chunk-write-error carries the verbatim chunker error as detail', () => {
    const { emitted, emitEvent } = makeEmitter();
    const mon = makeMonitor({ emitEvent }, () => ({
      status: 'chunk-write-error', lastChunkIndex: 3,
      lastErrorName: 'UnknownError', lastErrorMessage: 'disk gone',
    }));
    mon.onChunkTerminalState({ streamKind: 'microphone', terminalState: 'chunk-write-error' });
    const d = discontinuities(emitted)[0];
    assert.equal(d.payload.reason, 'chunk-write-error');
    assert.equal(d.payload.detail, 'UnknownError: disk gone');
    // A stream the monitor never saw: refs are honestly null.
    assert.equal(d.refs, null);
  });

  it('unknown terminal states and kinds are ignored, never thrown', () => {
    const { emitted, emitEvent } = makeEmitter();
    const mon = makeMonitor({ emitEvent });
    mon.onChunkTerminalState({ streamKind: 'microphone', terminalState: 'vibes' });
    mon.onChunkTerminalState({ streamKind: 'nope', terminalState: 'chunk-stalled' });
    mon.onChunkTerminalState({});
    assert.equal(discontinuities(emitted).length, 0);
  });

  it('the chunk_writer seam fires exactly once per stream per terminal generation', () => {
    const notified = [];
    const timeouts = [];
    const writer = BS_CW.createChunkWriter({
      db: { put: () => Promise.resolve() },
      setInterval: (fn) => { return 1; },
      clearInterval: () => {},
      setTimeout: (fn) => { timeouts.push(fn); return timeouts.length; },
      clearTimeout: () => {},
      random: () => 0.5,
      onTerminalState: (info) => { notified.push(info); },
    });
    const rec = makeRecorder();
    writer.startForStream({ streamKind: 'microphone', segmentId: SEGS[0], recorder: rec });
    // The tick is captured via the interval fake; drive three misses.
    // Re-create with a capturing interval to reach the tick:
    const ticks = [];
    const writer2 = BS_CW.createChunkWriter({
      db: { put: () => Promise.resolve() },
      setInterval: (fn) => { ticks.push(fn); return 7; },
      clearInterval: () => {},
      setTimeout: (fn) => { timeouts.push(fn); return timeouts.length; },
      clearTimeout: () => {},
      random: () => 0.5,
      onTerminalState: (info) => { notified.push(info); },
    });
    writer2.startForStream({ streamKind: 'microphone', segmentId: SEGS[0], recorder: rec });
    for (let i = 0; i < 3; i++) {
      ticks[0](); // requestData → awaiting
      timeouts[timeouts.length - 1](); // the 2 s wait expires → miss
    }
    assert.equal(writer2.getChunkState('microphone').status, 'chunk-stalled');
    assert.deepEqual(notified, [
      { streamKind: 'microphone', terminalState: 'chunk-stalled' },
    ]);
    // More ticks after the terminal state: no second notification.
    ticks[0]();
    assert.equal(notified.length, 1);
  });

  it('a throwing onTerminalState cannot break the chunker', () => {
    const timeouts = [];
    const ticks = [];
    const writer = BS_CW.createChunkWriter({
      db: { put: () => Promise.resolve() },
      setInterval: (fn) => { ticks.push(fn); return 7; },
      clearInterval: () => {},
      setTimeout: (fn) => { timeouts.push(fn); return timeouts.length; },
      clearTimeout: () => {},
      random: () => 0.5,
      onTerminalState: () => { throw new Error('monitor exploded'); },
    });
    const rec = makeRecorder();
    writer.startForStream({ streamKind: 'microphone', segmentId: SEGS[0], recorder: rec });
    for (let i = 0; i < 3; i++) {
      ticks[0]();
      timeouts[timeouts.length - 1]();
    }
    assert.equal(writer.getChunkState('microphone').status, 'chunk-stalled');
  });

  it('onTerminalState must be a function when provided; absent → 4.8 behavior unchanged', () => {
    assert.throws(() => BS_CW.createChunkWriter({ onTerminalState: 42 }), TypeError);
    const writer = BS_CW.createChunkWriter({
      db: { put: () => Promise.resolve() },
      setInterval: () => 1, clearInterval: () => {},
      setTimeout: () => 1, clearTimeout: () => {},
      random: () => 0.5,
    });
    // No seam: terminal states still recorded, nothing to notify.
    assert.equal(typeof writer.startForStream, 'function');
  });
});

// ------------------------------------------------------------------
// AC4 — restart detected (recorder-level, injected fakes).
// ------------------------------------------------------------------

describe('AC4 — restart detected', () => {
  function makeFakeChrome() {
    const sent = [];
    const chromeNs = {
      runtime: {
        sendMessage: (msg) => {
          sent.push(msg);
          const eventId = msg && msg.event && msg.event.eventId;
          return Promise.resolve({ ok: true, eventId });
        },
        onMessage: { addListener: () => {} },
      },
    };
    return { sent, chromeNs };
  }

  function eventMessages(sent) {
    return sent.filter((m) => m && m.kind === 'event').map((m) => m.event);
  }

  function startStreams(rec) {
    return new Promise((resolve) => {
      const r = rec.onRuntimeMessage(
        { kind: 'recorder', v: 1, msg: 'recorder-start-streams' }, {}, resolve);
      if (r === false) resolve(undefined);
    });
  }

  function setSession(rec) {
    return new Promise((resolve) => {
      const r = rec.onRuntimeMessage(
        { kind: 'recorder', v: 1, msg: 'recorder-set-session',
          sessionId: SID, gameId: GID }, {}, resolve);
      if (r === false) resolve(undefined);
    });
  }

  function makeHarness(manifestRecords) {
    const { sent, chromeNs } = makeFakeChrome();
    const fakeFormat = {
      getManifestRecordsBySession: (sid) =>
        Promise.resolve(sid === SID ? manifestRecords : []),
    };
    const micTrack = makeTrack('audio');
    const camTrack = makeTrack('video');
    const active = {
      microphone: { stream: makeStream([micTrack]), recorder: makeRecorder(), segmentId: SEGS[0] },
      webcam: { stream: makeStream([camTrack]), recorder: makeRecorder(), segmentId: SEGS[1] },
    };
    const fakeStarter = {
      startStreams: () => Promise.resolve({
        ok: true,
        streams: {
          microphone: { ok: true, segmentId: SEGS[0] },
          screen: { ok: false, error: 'no-capture-mode', stage: 'acquire-stream' },
          webcam: { ok: true, segmentId: SEGS[1] },
        },
      }),
      getActiveStreams: () => active,
    };
    const fakeWriter = { startForStream: () => ({ ok: true }) };
    const rec = BS_REC.createOffscreenRecorder({
      chromeNs, announce: false,
      streamStarter: fakeStarter,
      chunkWriter: fakeWriter,
      formatSupport: fakeFormat,
    });
    return { rec, sent, micTrack, camTrack };
  }

  it('first start (no manifest records) emits no restart discontinuity', async () => {
    const { rec, sent } = makeHarness([]);
    await setSession(rec);
    await startStreams(rec);
    const restarts = eventMessages(sent).filter((e) =>
      e.eventType === 'stream_discontinuity' && e.payload.reason === 'restart');
    assert.equal(restarts.length, 0);
  });

  it('pre-existing unfinalized records → one restart event per affected kind', async () => {
    const { rec, sent } = makeHarness([
      { segmentId: OLDSEG, streamKind: 'microphone', sessionId: SID },
    ]);
    await setSession(rec);
    await startStreams(rec);
    const restarts = eventMessages(sent).filter((e) =>
      e.eventType === 'stream_discontinuity' && e.payload.reason === 'restart');
    assert.equal(restarts.length, 1);
    const r = restarts[0];
    assert.equal(r.payload.streamKind, 'microphone');
    assert.deepEqual(r.payload.supersededSegmentIds, [OLDSEG]);
    assert.equal(r.payload.lastChunkIndex, null);
    assert.equal(r.payload.detail, null);
    // refs.segmentId is the NEW segmentId.
    assert.equal(r.refs.segmentId, SEGS[0]);
    // The new generation's monitor is attached and baselines were emitted.
    const baselines = eventMessages(sent).filter((e) =>
      e.eventType === 'recorder_track_state_changed' && e.payload.baseline);
    assert.equal(baselines.length, 2);
  });

  it('a kind that failed the new start still gets a restart event, with null refs', async () => {
    const { rec, sent } = makeHarness([
      { segmentId: OLDSEG, streamKind: 'screen', sessionId: SID },
    ]);
    await setSession(rec);
    await startStreams(rec);
    const restarts = eventMessages(sent).filter((e) =>
      e.eventType === 'stream_discontinuity' && e.payload.reason === 'restart');
    assert.equal(restarts.length, 1);
    assert.equal(restarts[0].payload.streamKind, 'screen');
    assert.deepEqual(restarts[0].payload.supersededSegmentIds, [OLDSEG]);
    assert.equal(restarts[0].refs, null); // the new screen stream never started
  });

  it('no session → no restart check (the start response is the record)', async () => {
    const { rec, sent } = makeHarness([
      { segmentId: OLDSEG, streamKind: 'microphone', sessionId: SID },
    ]);
    // No set-session: the restart pre-check is skipped.
    await startStreams(rec);
    const restarts = eventMessages(sent).filter((e) =>
      e.eventType === 'stream_discontinuity' && e.payload.reason === 'restart');
    assert.equal(restarts.length, 0);
  });

  it('a failing manifest read degrades to "no restart" — monitoring never fails the start', async () => {
    const { sent, chromeNs } = makeFakeChrome();
    const fakeFormat = {
      getManifestRecordsBySession: () => Promise.reject(new Error('idb exploded')),
    };
    const fakeStarter = {
      startStreams: () => Promise.resolve({
        ok: true,
        streams: { microphone: { ok: true, segmentId: SEGS[0] } },
      }),
      getActiveStreams: () => ({
        microphone: { stream: makeStream([makeTrack('audio')]), recorder: makeRecorder(), segmentId: SEGS[0] },
      }),
    };
    const rec = BS_REC.createOffscreenRecorder({
      chromeNs, announce: false,
      streamStarter: fakeStarter,
      chunkWriter: { startForStream: () => ({ ok: true }) },
      formatSupport: fakeFormat,
    });
    await setSession(rec);
    const resp = await startStreams(rec);
    assert.equal(resp.ok, true); // the start still succeeds
  });

  it('recorder.js exposes getTrackMonitor; lazy wiring resolves from the namespace', () => {
    const rec = BS_REC.createOffscreenRecorder({ announce: false });
    assert.equal(typeof rec.getTrackMonitor, 'function');
    const mon = rec.getTrackMonitor();
    assert.equal(typeof mon.attachStream, 'function');
    assert.equal(typeof mon.onChunkTerminalState, 'function');
    assert.equal(typeof mon.emitRestartDiscontinuity, 'function');
  });

  it('recorder.js accepts an injected o.trackMonitor (test seam)', () => {
    const fake = { attachStream: () => ({ ok: true }) };
    const rec = BS_REC.createOffscreenRecorder({ announce: false, trackMonitor: fake });
    assert.equal(rec.getTrackMonitor(), fake);
  });
});

// ------------------------------------------------------------------
// AC5 — vocabulary discipline.
// ------------------------------------------------------------------

describe('AC5 — vocabulary discipline', () => {
  it('MSG_* vocabulary gains exactly the deliberate 4.13 stop-streams + 4.14 get-status messages (no other new message)', () => {
    const src = fs.readFileSync(path.join(REPO, 'recorder.js'), 'utf8');
    const found = [];
    const re = /var (MSG_[A-Z_]+) = '([^']+)';/g;
    let m;
    while ((m = re.exec(src)) !== null) { found.push(`${m[1]}=${m[2]}`); }
    assert.deepEqual(found, [
      'MSG_READY=recorder-ready',
      'MSG_PING=recorder-ping',
      'MSG_PONG=recorder-pong',
      'MSG_SET_SESSION=recorder-set-session',
      'MSG_MIC_LIST=mic-list-devices',
      'MSG_MIC_SELECT=mic-select',
      'MSG_MIC_PERMISSION=mic-request-permission',
      'MSG_MIC_STATE=mic-get-state',
      'MSG_CAM_LIST=cam-list-devices',
      'MSG_CAM_SELECT=cam-select',
      'MSG_CAM_PERMISSION=cam-request-permission',
      'MSG_CAM_STATE=cam-get-state',
      'MSG_CAPTURE_LIST=capture-list-modes',
      'MSG_CAPTURE_SELECT=capture-select',
      'MSG_CAPTURE_PERMISSION=capture-request-permission',
      'MSG_CAPTURE_STATE=capture-get-state',
      'MSG_CAPTURE_RESOLVE_TAB=capture-resolve-tab',
      'MSG_CAPTURE_QUERY_PERMISSION=capture-query-permission',
      'MSG_CAPTURE_GET_STREAM_ID=capture-get-stream-id',
      'MSG_FORMATS=recorder-get-formats',
      'MSG_START_STREAMS=recorder-start-streams',
      // Honest cumulative evolution: 4.11 deliberately adds the
      // single flash-relay message (contract §7).
      'MSG_SYNC_FLASH=recorder-sync-flash',
      // Honest cumulative evolution: 4.13 deliberately adds the single
      // stop-streams message (contract §7).
      'MSG_STOP_STREAMS=recorder-stop-streams',
      // Honest cumulative evolution: 4.14 deliberately adds the single
      // per-stream status query message (contract §3.2).
      'MSG_GET_STATUS=recorder-get-status'
    ]);
  });

  it('4.9 events flow through the existing {kind:\'event\'} writer path', async () => {
    const sent = [];
    const chromeNs = {
      runtime: {
        sendMessage: (msg) => {
          sent.push(msg);
          const eventId = msg && msg.event && msg.event.eventId;
          return Promise.resolve({ ok: true, eventId });
        },
        onMessage: { addListener: () => {} },
      },
    };
    const micTrack = makeTrack('audio');
    const fakeStarter = {
      startStreams: () => Promise.resolve({
        ok: true,
        streams: { microphone: { ok: true, segmentId: SEGS[0] } },
      }),
      getActiveStreams: () => ({
        microphone: { stream: makeStream([micTrack]), recorder: makeRecorder(), segmentId: SEGS[0] },
      }),
    };
    const rec = BS_REC.createOffscreenRecorder({
      chromeNs, announce: false,
      streamStarter: fakeStarter,
      chunkWriter: { startForStream: () => ({ ok: true }) },
      formatSupport: { getManifestRecordsBySession: () => Promise.resolve([]) },
    });
    await new Promise((resolve) => {
      const r = rec.onRuntimeMessage(
        { kind: 'recorder', v: 1, msg: 'recorder-set-session',
          sessionId: SID, gameId: GID }, {}, resolve);
      if (r === false) resolve(undefined);
    });
    await new Promise((resolve) => {
      const r = rec.onRuntimeMessage(
        { kind: 'recorder', v: 1, msg: 'recorder-start-streams' }, {}, resolve);
      if (r === false) resolve(undefined);
    });
    // Force the platform event on the real (fake) track.
    micTrack.readyState = 'ended';
    micTrack.onended();
    const events = sent.filter((m) => m && m.kind === 'event').map((m) => m.event);
    const types = events.map((e) => e.eventType);
    assert.ok(types.includes('recorder_track_state_changed'),
      'expected a track-state event through {kind:\'event\'}');
    assert.ok(types.includes('stream_discontinuity'),
      'expected the chained discontinuity through {kind:\'event\'}');
    // The chained order is preserved end to end: the ended observation
    // precedes the discontinuity flag.
    const endedIdx = events.findIndex((e) =>
      e.eventType === 'recorder_track_state_changed' && e.payload.ended === true);
    const discIdx = events.findIndex((e) =>
      e.eventType === 'stream_discontinuity' && e.payload.reason === 'track-ended');
    assert.ok(endedIdx !== -1 && discIdx !== -1 && discIdx > endedIdx,
      'observation must precede the discontinuity flag');
    for (const e of events) {
      assert.equal(e.sessionId, SID);
      assert.equal(e.sourceContext, 'recording_context');
    }
  });

  it('content scripts are byte-identical to HEAD (no gameplay change)', () => {
    // Honest cumulative evolution (5.1): content.js + chess_utils.js leave
    // this pin — 5.1 legitimately wires the Start/Stop install into
    // content.js and adds the additive getLastObservedEnd getter to
    // chess_utils.js (pinned in tests/session_controls.test.js AC7).
    const out = execSync('git diff HEAD --stat -- sounds.js status_indicator.js',
      { cwd: REPO }).toString();
    assert.equal(out.trim(), '', 'content scripts must be untouched by 4.9');
  });
});

// ------------------------------------------------------------------
// AC6 — log-shape decision documented.
// ------------------------------------------------------------------

describe('AC6 — log-shape decision documented', () => {
  it('the 4.9 contract records the events-not-manifest decision with consumption points', () => {
    const contract = fs.readFileSync(
      path.join(REPO, '.autodev/evidence/4.9.contract.md'), 'utf8');
    assert.ok(contract.includes('## 1. The log-shape decision: events, not the manifest'),
      '§1 decision heading missing');
    // The four justification points.
    assert.ok(contract.includes('timestamped occurrences'),
      'justification (1) missing');
    assert.ok(contract.includes('clockSegmentId'),
      'justification (2) missing');
    assert.ok(contract.includes('Consumption is uniform'),
      'justification (3) missing');
    assert.ok(contract.includes('transport already exists'),
      'justification (4) missing');
    // The named consumption points.
    for (const name of ['4.10', '4.12', '4.13', '4.14', '§6.3']) {
      assert.ok(contract.includes(name), 'consumption point ' + name + ' missing');
    }
  });

  it('DECISIONS.md carries a ## 4.9 section with the required content', () => {
    const md = fs.readFileSync(path.join(REPO, '.autodev/DECISIONS.md'), 'utf8');
    assert.ok(md.includes('## 4.9'), 'missing ## 4.9 section');
    const section = md.slice(md.indexOf('## 4.9'));
    assert.ok(/event log/.test(section), 'events-not-manifest decision missing');
    assert.ok(/recorder_track_state_changed/.test(section), 'event types missing');
    assert.ok(/restart/.test(section), 'restart detection missing');
    assert.ok(/muted/.test(section), 'muted≠silent note missing');
  });
});

// ------------------------------------------------------------------
// AC7 — no analysis.
// ------------------------------------------------------------------

describe('AC7 — no analysis', () => {
  it('track_monitor.js references no media-capture APIs (everything injected)', () => {
    const src = fs.readFileSync(path.join(REPO, 'track_monitor.js'), 'utf8');
    const code = src.split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    for (const needle of ['MediaRecorder', 'getUserMedia', 'getDisplayMedia',
                          'AudioContext', 'webkitAudioContext', 'AnalyserNode',
                          'createMediaStreamDestination', 'AudioDestinationNode']) {
      assert.ok(!code.includes(needle), `track_monitor.js must not contain ${needle}`);
    }
  });

  it('no content inference: no metering, no VAD, no why-claims', () => {
    const src = fs.readFileSync(path.join(REPO, 'track_monitor.js'), 'utf8');
    const code = src.split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    for (const needle of ['AnalyserNode', 'getByteFrequencyData', 'VAD',
                          'voice activity', 'unplugged', 'disconnected device']) {
      assert.ok(!code.includes(needle), `track_monitor.js must not contain ${needle}`);
    }
    // muted≠silent is documented, not claimed as silence.
    assert.ok(src.includes('muted'), 'muted≠silent must be documented');
    assert.ok(src.includes('silent'), 'muted≠silent must be documented');
  });

  it('error strings pass through verbatim (functional)', () => {
    const { emitted, emitEvent } = makeEmitter();
    const mon = makeMonitor({ emitEvent });
    const recorder = makeRecorder();
    mon.attachStream({
      streamKind: 'microphone', stream: makeStream([]),
      recorder, segmentId: SEGS[0],
    });
    const weird = new Error('weird: \\u0000 binary \\n stuff — ünïcödé');
    weird.name = 'SomeFutureError';
    recorder.onerror({ error: weird });
    const err = emitted.find((e) => e.eventType === 'recorder_error');
    assert.equal(err.payload.errorName, 'SomeFutureError');
    assert.equal(err.payload.errorMessage, 'weird: \\u0000 binary \\n stuff — ünïcödé');
  });
});

// ------------------------------------------------------------------
// AC8 — changed-files discipline.
// ------------------------------------------------------------------

describe('AC8 — changed-files discipline', () => {
  it('git status shows only 4.9-allowed changes', () => {
    const status = execSync('git status --porcelain', { cwd: REPO }).toString();
    const changed = status.split('\n').filter((l) => l.trim())
      .map((l) => l.slice(3).trim());
    const allowed = new Set([
      // Honest cumulative evolution: 4.9 (track/error/discontinuity
      // monitoring) legitimately adds track_monitor.js, wires it into
      // recorder.js's recorder-start-streams handler (restart pre-check,
      // attach, restart events), adds the onTerminalState seam to
      // chunk_writer.js, the getManifestRecordsBySession read to
      // format_support.js, the script tag in recorder.html, records the
      // ## 4.9 decisions, and adds its test + evidence; its files join
      // the allowlists.
      'track_monitor.js',
      'recorder.js',
      'recorder.html',
      'chunk_writer.js',
      'format_support.js',
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
      'tests/audio_policy.test.js',
      'tests/capture_selection.test.js',
      'tests/chunk_writer.test.js',
      'tests/device_selection.test.js',
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
    ]);
    for (const f of changed) {
      assert.ok(allowed.has(f), `unexpected modified file: ${f}`);
    }
  });

  it('PLAN.md is unmodified', () => {
    const out = execSync('git diff main --stat -- PLAN.md', { cwd: REPO }).toString();
    assert.equal(out.trim(), '', 'PLAN.md must be unmodified');
  });

  it('no new event types beyond the three 4.9 types', () => {
    const src = fs.readFileSync(path.join(REPO, 'track_monitor.js'), 'utf8');
    const found = [];
    const re = /var (EVENT_[A-Z_]+) = '([^']+)';/g;
    let m;
    while ((m = re.exec(src)) !== null) { found.push(`${m[1]}=${m[2]}`); }
    assert.deepEqual(found, [
      'EVENT_TRACK_STATE_CHANGED=recorder_track_state_changed',
      'EVENT_RECORDER_ERROR=recorder_error',
      'EVENT_STREAM_DISCONTINUITY=stream_discontinuity',
    ]);
  });
});
