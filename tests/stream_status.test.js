// tests/stream_status.test.js
//
// V1 verification for task 4.14 (PLAN.md §4.14) per
// .autodev/evidence/4.14.contract.md. Covers acceptance criteria AC1–AC8
// (static/unit). AC9–AC10 (real Chrome) run separately via
// ~/workspace/tools/ext-verify/sw-status.js; AC11 (real-device status
// reality) is deferred to owner verification (§7).
//
// 4.14 is the read-only per-stream status query surface over the
// 4.6–4.13 pipeline seams: it reports, per streamKind, whether the
// stream's recording is actually happening and what its condition is,
// so a dead microphone, failed screen capture, or stalled chunk loop
// cannot masquerade as a complete recording. It writes nothing,
// starts/stops nothing, emits no events, builds no UI, and defines no
// "required streams" policy (that is §5's).
//
// Run: node --test tests/stream_status.test.js   (from repo root)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BS_SS = require(path.join(REPO, 'stream_status.js'));
const BS_TM = require(path.join(REPO, 'track_monitor.js'));
const BS_REC = require(path.join(REPO, 'recorder.js'));
const BS_FMT = require(path.join(REPO, 'format_support.js'));
const BS_DB = require(path.join(REPO, 'db.js'));
const BS_ENV = require(path.join(REPO, 'event_envelope.js'));

// The Node test harness publishes the merged namespace on
// globalThis (sender.js precedent): recorder.js resolves
// createStreamStatus the same way (the lazy getter checks factory
// availability before the o.* injection, so every factory module must
// be present — the track_monitor.test.js precedent).
const BS = Object.assign({}, BS_ENV, BS_SS, BS_TM, BS_FMT, BS_DB, BS_REC);
globalThis.BlindfoldSession = BS;

const SID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const GID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SEG1 = 'cccccccc-3333-4333-8333-cccccccccccc';
const SEG2 = 'dddddddd-4444-4444-8444-dddddddddddd';

// Strip full-line comments and trailing // comments so the code-scan
// pins test executable code only (4.6 precedent).
function codeOnly(file) {
  return fs.readFileSync(path.join(REPO, file), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .map((l) => {
      const idx = l.indexOf('//');
      return idx === -1 ? l : l.slice(0, idx);
    })
    .join('\n');
}

const EXPECTED_KEYS = [
  'streamKind',
  'lifecycle',
  'recorderState',
  'segmentId',
  'segmentNumber',
  'startedAtUtc',
  'startedAtMonotonicMs',
  'clockSegmentId',
  'actualMimeType',
  'fileExtension',
  'audioContent',
  'chunk',
  'tracks',
  'lastRecorderError',
  'lastDiscontinuity',
  'finalizedAtUtc',
  'unfinalizedSegments'
];

// A world with fully injected, controllable seams.
function makeWorld(overrides) {
  const ov = overrides || {};
  const state = {
    records: {},   // kind → registry record (or null)
    chunks: {},    // kind → chunk state (or null)
    tracks: {},    // kind → [{trackKind, track}]
    health: {},    // kind → {lastRecorderError, lastDiscontinuity} (or null)
    manifest: [],  // manifest records for the session
    sessionId: ov.sessionId === undefined ? SID : ov.sessionId,
  };
  const reader = BS_SS.createStreamStatus({
    getStreamRecord: (kind) => {
      if (ov.throwOn && ov.throwOn.getStreamRecord) {
        throw new Error('boom');
      }
      return state.records[kind] || null;
    },
    getChunkState: (kind) => {
      if (ov.throwOn && ov.throwOn.getChunkState) {
        throw new Error('boom');
      }
      return state.chunks[kind] || null;
    },
    getMonitoredTracks: (kind) => {
      if (ov.throwOn && ov.throwOn.getMonitoredTracks) {
        throw new Error('boom');
      }
      return state.tracks[kind] || [];
    },
    getStreamHealth: (kind) => {
      if (ov.throwOn && ov.throwOn.getStreamHealth) {
        throw new Error('boom');
      }
      return Object.prototype.hasOwnProperty.call(state.health, kind) ?
        state.health[kind] : null;
    },
    getManifestRecordsBySession: (sid) => {
      if (ov.throwOn && ov.throwOn.getManifestRecordsBySession) {
        return Promise.reject(new Error('db down'));
      }
      assert.equal(sid, state.sessionId);
      return Promise.resolve(state.manifest.slice());
    },
    getSessionId: () => state.sessionId,
  });
  return { state, reader };
}

function manifestRecord(overrides) {
  return Object.assign({
    segmentId: SEG1,
    sessionId: SID,
    gameId: GID,
    streamKind: 'microphone',
    requestedMimeType: 'audio/webm;codecs=opus',
    actualMimeType: 'audio/webm;codecs=opus',
    fileExtension: '.webm',
    createdAtUtc: '2026-10-06T17:00:00.000Z',
    streamStartedAtUtc: '2026-10-06T17:00:01.000Z',
    streamStartedAtMonotonicMs: 1000,
    effectiveDeviceId: 'dev-1',
    audioTrackPresent: true,
    videoTrackPresent: false,
    screenAudioContent: null,
    micAudioContent: 'device-only',
    clockSegmentId: 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee',
    segmentNumber: null,
    finalizedAtUtc: null,
  }, overrides || {});
}

// ------------------------------------------------------------------
// AC1 — exact status shape.
// ------------------------------------------------------------------

describe('AC1 — exact status shape', () => {
  it('getStreamStatus returns exactly the 17-key shape for each kind', async () => {
    const { reader } = makeWorld();
    for (const kind of ['microphone', 'screen', 'webcam']) {
      const s = await reader.getStreamStatus(kind);
      assert.deepEqual(Object.keys(s).sort(), EXPECTED_KEYS.slice().sort(),
        'shape for ' + kind);
      assert.equal(s.streamKind, kind);
    }
  });

  it('unknown is null on the empty world', async () => {
    const { reader } = makeWorld();
    const s = await reader.getStreamStatus('microphone');
    assert.equal(s.lifecycle, 'idle');
    for (const k of EXPECTED_KEYS) {
      if (k === 'streamKind' || k === 'lifecycle' || k === 'tracks' ||
          k === 'unfinalizedSegments') {
        continue;
      }
      assert.equal(s[k], null, k + ' should be null');
    }
    assert.deepEqual(s.tracks, []);
    assert.equal(s.unfinalizedSegments, 0);
  });

  it('malformed streamKind → TypeError; unknown kind → RangeError', () => {
    const { reader } = makeWorld();
    // Kind validation is synchronous (caller bug — before any async work).
    assert.throws(() => reader.getStreamStatus(42), TypeError);
    assert.throws(() => reader.getStreamStatus(null), TypeError);
    assert.throws(() => reader.getStreamStatus('speakers'), RangeError);
    assert.throws(() => reader.getStreamStatus('nope'), RangeError);
  });

  it('getAllStreamStatuses returns all three kinds', async () => {
    const { reader } = makeWorld();
    const all = await reader.getAllStreamStatuses();
    assert.deepEqual(Object.keys(all).sort(),
      ['microphone', 'screen', 'webcam']);
    for (const k of Object.keys(all)) {
      assert.deepEqual(Object.keys(all[k]).sort(), EXPECTED_KEYS.slice().sort());
    }
  });

  it('factory requires every injected seam (TypeError)', () => {
    assert.throws(() => BS_SS.createStreamStatus({}), TypeError);
    assert.throws(() => BS_SS.createStreamStatus({
      getStreamRecord: () => null,
      getChunkState: () => null,
      getMonitoredTracks: () => [],
      // getStreamHealth missing
      getManifestRecordsBySession: () => Promise.resolve([]),
      getSessionId: () => null,
    }), TypeError);
  });
});

// ------------------------------------------------------------------
// AC2 — lifecycle truth table.
// ------------------------------------------------------------------

describe('AC2 — lifecycle truth table', () => {
  function liveRec(overrides) {
    return Object.assign({
      stream: {},
      recorder: { state: 'recording' },
      segmentId: SEG1,
      startedAtUtc: '2026-10-06T17:00:01.000Z',
      startedAtMonotonicMs: 1000,
    }, overrides || {});
  }

  it("live registry entry → 'recording' (even with recorderState 'inactive')", async () => {
    const { state, reader } = makeWorld();
    state.records.microphone = liveRec({ recorder: { state: 'inactive' } });
    const s = await reader.getStreamStatus('microphone');
    assert.equal(s.lifecycle, 'recording');
    assert.equal(s.recorderState, 'inactive');
    assert.equal(s.segmentId, SEG1);
    assert.equal(s.startedAtUtc, '2026-10-06T17:00:01.000Z');
    assert.equal(s.startedAtMonotonicMs, 1000);
  });

  it("no live entry + unfinalized manifest segments → 'stopped'", async () => {
    const { state, reader } = makeWorld();
    state.manifest.push(manifestRecord({ streamKind: 'screen' }));
    const s = await reader.getStreamStatus('screen');
    assert.equal(s.lifecycle, 'stopped');
    assert.equal(s.unfinalizedSegments, 1);
    assert.equal(s.segmentId, SEG1);
    assert.equal(s.finalizedAtUtc, null);
  });

  it("no live entry + all segments finalized → 'finalized'", async () => {
    const { state, reader } = makeWorld();
    state.manifest.push(manifestRecord({
      streamKind: 'webcam',
      segmentNumber: 1,
      finalizedAtUtc: '2026-10-06T17:05:00.000Z',
    }));
    const s = await reader.getStreamStatus('webcam');
    assert.equal(s.lifecycle, 'finalized');
    assert.equal(s.finalizedAtUtc, '2026-10-06T17:05:00.000Z');
    assert.equal(s.segmentNumber, 1);
    assert.equal(s.unfinalizedSegments, 0);
  });

  it("no live entry + no records → 'idle'", async () => {
    const { reader } = makeWorld();
    const s = await reader.getStreamStatus('microphone');
    assert.equal(s.lifecycle, 'idle');
  });

  it('mixed finalized/unfinalized → stopped (the abnormal case is visible)', async () => {
    const { state, reader } = makeWorld();
    state.manifest.push(manifestRecord({
      streamKind: 'microphone', segmentId: SEG1,
      segmentNumber: 1, finalizedAtUtc: '2026-10-06T17:05:00.000Z',
    }));
    state.manifest.push(manifestRecord({
      streamKind: 'microphone', segmentId: SEG2,
      segmentNumber: null, finalizedAtUtc: null,
      createdAtUtc: '2026-10-06T17:06:00.000Z',
    }));
    const s = await reader.getStreamStatus('microphone');
    assert.equal(s.lifecycle, 'stopped');
    assert.equal(s.unfinalizedSegments, 1);
    // The latest record (SEG2) supplies the manifest fields.
    assert.equal(s.segmentId, SEG2);
  });

  it("there is no 'error' lifecycle — failures are facts, not smoothed state", async () => {
    const { state, reader } = makeWorld();
    state.records.microphone = liveRec();
    state.chunks.microphone = {
      status: 'chunk-stalled',
      lastChunkIndex: 41,
      lastWriteAtUtc: '2026-10-06T17:01:00.000Z',
      consecutiveMisses: 3,
      emptyPolls: 0,
      lastErrorName: null,
      lastErrorMessage: null,
    };
    state.health.microphone = {
      lastRecorderError: null,
      lastDiscontinuity: { reason: 'chunk-stalled', atUtc: '2026-10-06T17:01:00.000Z' },
    };
    const s = await reader.getStreamStatus('microphone');
    // The critical masquerade case: recorder still "recording" while
    // the chunk loop is terminally stalled. lifecycle stays
    // 'recording'; the stall is a fact in chunk.* + lastDiscontinuity.
    assert.equal(s.lifecycle, 'recording');
    assert.equal(s.recorderState, 'recording');
    assert.equal(s.chunk.status, 'chunk-stalled');
    assert.equal(s.chunk.lastChunkIndex, 41);
    assert.equal(s.chunk.consecutiveMisses, 3);
    assert.equal(s.lastDiscontinuity.reason, 'chunk-stalled');
  });

  it('live record wins over the manifest for segment identity', async () => {
    const { state, reader } = makeWorld();
    state.records.microphone = liveRec({ segmentId: SEG2 });
    state.manifest.push(manifestRecord({ streamKind: 'microphone', segmentId: SEG1 }));
    const s = await reader.getStreamStatus('microphone');
    assert.equal(s.segmentId, SEG2);
    // …but manifest-only fields still come from the manifest.
    assert.equal(s.actualMimeType, 'audio/webm;codecs=opus');
  });
});

// ------------------------------------------------------------------
// AC5 — health completeness (masquerade table).
// ------------------------------------------------------------------

describe('AC5 — health completeness', () => {
  it('live track state is read at query time (muted/readyState)', async () => {
    const { state, reader } = makeWorld();
    state.records.microphone = {
      stream: {}, recorder: { state: 'recording' }, segmentId: SEG1,
      startedAtUtc: '2026-10-06T17:00:01.000Z', startedAtMonotonicMs: 1000,
    };
    const track = { kind: 'audio', muted: false, readyState: 'live' };
    state.tracks.microphone = [{ trackKind: 'audio', track }];
    let s = await reader.getStreamStatus('microphone');
    assert.deepEqual(s.tracks, [
      { trackKind: 'audio', muted: false, readyState: 'live' },
    ]);
    // The read is live: mutating the track changes the next query.
    track.readyState = 'ended';
    track.muted = true;
    s = await reader.getStreamStatus('microphone');
    assert.deepEqual(s.tracks, [
      { trackKind: 'audio', muted: true, readyState: 'ended' },
    ]);
  });

  it('a throwing track read degrades to false/null, not a failed query', async () => {
    const { state, reader } = makeWorld();
    const evil = {};
    Object.defineProperty(evil, 'muted', { get() { throw new Error('x'); } });
    Object.defineProperty(evil, 'readyState', { get() { throw new Error('y'); } });
    state.tracks.screen = [{ trackKind: 'video', track: evil }];
    const s = await reader.getStreamStatus('screen');
    assert.deepEqual(s.tracks, [
      { trackKind: 'video', muted: false, readyState: null },
    ]);
  });

  it('lastRecorderError / lastDiscontinuity come from getStreamHealth', async () => {
    const { state, reader } = makeWorld();
    state.health.screen = {
      lastRecorderError: {
        errorName: 'InvalidStateError',
        errorMessage: 'boom',
        atUtc: '2026-10-06T17:02:00.000Z',
      },
      lastDiscontinuity: { reason: 'recorder-error', atUtc: '2026-10-06T17:02:00.000Z' },
    };
    const s = await reader.getStreamStatus('screen');
    assert.deepEqual(s.lastRecorderError, {
      errorName: 'InvalidStateError',
      errorMessage: 'boom',
      atUtc: '2026-10-06T17:02:00.000Z',
    });
    assert.deepEqual(s.lastDiscontinuity, {
      reason: 'recorder-error',
      atUtc: '2026-10-06T17:02:00.000Z',
    });
  });

  it('audioContent maps per kind (screen/mic/webcam)', async () => {
    const { state, reader } = makeWorld();
    state.manifest.push(manifestRecord({
      streamKind: 'screen', screenAudioContent: 'tab-audio', micAudioContent: null,
    }));
    state.manifest.push(manifestRecord({
      streamKind: 'microphone', screenAudioContent: null, micAudioContent: 'device-only',
    }));
    state.manifest.push(manifestRecord({
      streamKind: 'webcam', screenAudioContent: 'system-audio', micAudioContent: 'device-only',
    }));
    assert.equal((await reader.getStreamStatus('screen')).audioContent, 'tab-audio');
    assert.equal((await reader.getStreamStatus('microphone')).audioContent, 'device-only');
    assert.equal((await reader.getStreamStatus('webcam')).audioContent, null);
  });

  it('a throwing injected read degrades (never fails the query)', async () => {
    for (const seam of ['getStreamRecord', 'getChunkState', 'getMonitoredTracks', 'getStreamHealth']) {
      const { reader } = makeWorld({ throwOn: { [seam]: true } });
      const s = await reader.getStreamStatus('microphone');
      assert.equal(s.lifecycle, 'idle', seam);
    }
  });

  it('a failed manifest read rejects (wiring maps it to {ok:false})', async () => {
    const { reader } = makeWorld({ throwOn: { getManifestRecordsBySession: true } });
    await assert.rejects(reader.getStreamStatus('microphone'), /db down/);
  });

  it('two consecutive queries agree (deterministic)', async () => {
    const { state, reader } = makeWorld();
    state.records.microphone = {
      stream: {}, recorder: { state: 'recording' }, segmentId: SEG1,
      startedAtUtc: '2026-10-06T17:00:01.000Z', startedAtMonotonicMs: 1000,
    };
    state.manifest.push(manifestRecord({ streamKind: 'microphone' }));
    const a = await reader.getAllStreamStatuses();
    const b = await reader.getAllStreamStatuses();
    assert.deepEqual(a, b);
  });
});

// ------------------------------------------------------------------
// track_monitor.js additive getStreamHealth.
// ------------------------------------------------------------------

describe('track_monitor getStreamHealth (additive)', () => {
  function makeMonitor() {
    const emitted = [];
    const m = BS_TM.createTrackMonitor({
      emitEvent: (t, p, r) => { emitted.push({ t, p, r }); },
      nowUtcIso: () => '2026-10-06T17:00:00.000Z',
    });
    return { m, emitted };
  }

  function fakeStream() {
    const track = {
      kind: 'audio', muted: false, readyState: 'live',
      onmute: null, onunmute: null, onended: null,
    };
    return { getTracks: () => [track], _track: track };
  }

  it('null when the kind was never monitored', () => {
    const { m } = makeMonitor();
    assert.equal(m.getStreamHealth('microphone'), null);
  });

  it('retains the last recorder error', () => {
    const { m } = makeMonitor();
    const stream = fakeStream();
    m.attachStream({
      streamKind: 'microphone', stream,
      recorder: { state: 'recording', onerror: null }, segmentId: SEG1,
    });
    const rec = { state: 'recording', onerror: null };
    m.detachStream('microphone');
    m.attachStream({
      streamKind: 'microphone', stream,
      recorder: rec, segmentId: SEG1,
    });
    const err = new Error('kaput');
    err.name = 'InvalidStateError';
    rec.onerror({ error: err });
    const h = m.getStreamHealth('microphone');
    assert.deepEqual(h.lastRecorderError, {
      errorName: 'InvalidStateError',
      errorMessage: 'kaput',
      atUtc: '2026-10-06T17:00:00.000Z',
    });
    assert.equal(h.lastDiscontinuity.reason, 'recorder-error');
  });

  it('retains the last discontinuity (track-ended)', () => {
    const { m } = makeMonitor();
    const stream = fakeStream();
    m.attachStream({
      streamKind: 'webcam', stream,
      recorder: { state: 'recording', onerror: null }, segmentId: SEG1,
    });
    stream._track.onended();
    const h = m.getStreamHealth('webcam');
    assert.equal(h.lastRecorderError, null);
    assert.deepEqual(h.lastDiscontinuity, {
      reason: 'track-ended',
      atUtc: '2026-10-06T17:00:00.000Z',
    });
  });

  it('retains chunk-terminal discontinuities', () => {
    const { m } = makeMonitor();
    m.onChunkTerminalState({
      streamKind: 'screen', terminalState: 'chunk-quota-exceeded',
    });
    const h = m.getStreamHealth('screen');
    assert.deepEqual(h.lastDiscontinuity, {
      reason: 'chunk-quota-exceeded',
      atUtc: '2026-10-06T17:00:00.000Z',
    });
  });

  it('retains restart discontinuities', () => {
    const { m } = makeMonitor();
    m.emitRestartDiscontinuity({
      streamKind: 'microphone',
      newSegmentId: SEG1,
      supersededSegmentIds: [SEG2],
    });
    const h = m.getStreamHealth('microphone');
    assert.deepEqual(h.lastDiscontinuity, {
      reason: 'restart',
      atUtc: '2026-10-06T17:00:00.000Z',
    });
  });

  it('generation-scoped: detach clears, re-attach starts fresh', () => {
    const { m } = makeMonitor();
    const stream = fakeStream();
    const rec = { state: 'recording', onerror: null };
    m.attachStream({
      streamKind: 'microphone', stream, recorder: rec, segmentId: SEG1,
    });
    const err = new Error('kaput');
    err.name = 'InvalidStateError';
    rec.onerror({ error: err });
    assert.notEqual(m.getStreamHealth('microphone'), null);
    m.detachStream('microphone');
    assert.equal(m.getStreamHealth('microphone'), null);
    // Re-attach: fresh generation, no retained health.
    m.attachStream({
      streamKind: 'microphone', stream,
      recorder: { state: 'recording', onerror: null }, segmentId: SEG2,
    });
    assert.deepEqual(m.getStreamHealth('microphone'), {
      lastRecorderError: null,
      lastDiscontinuity: null,
    });
  });

  it('malformed kind → TypeError / RangeError (repo convention)', () => {
    const { m } = makeMonitor();
    assert.throws(() => m.getStreamHealth(7), TypeError);
    assert.throws(() => m.getStreamHealth('nope'), RangeError);
  });
});

// ------------------------------------------------------------------
// AC3 — read-only.
// ------------------------------------------------------------------

describe('AC3 — read-only', () => {
  it('stream_status.js has no write/emit/control vocabulary in executable code', () => {
    const code = codeOnly('stream_status.js');
    const forbidden = [
      'put(', 'add(', 'delete(', 'sendMessage', 'emitEvent',
      'new MediaRecorder', '.start(', '.stop(', 'requestData(',
    ];
    for (const token of forbidden) {
      assert.ok(!code.includes(token), 'forbidden token in executable code: ' + token);
    }
  });

  it('stream_status.js references no chrome.* / document / IDB surface', () => {
    const code = codeOnly('stream_status.js');
    assert.ok(!/chrome\./.test(code), 'no chrome.*');
    assert.ok(!/\bdocument\b/.test(code), 'no document');
    assert.ok(!/\bindexedDB\b/.test(code), 'no indexedDB');
  });
});

// ------------------------------------------------------------------
// AC4 — channel message.
// ------------------------------------------------------------------

describe('AC4 — channel message', () => {
  function drive(rec, msg) {
    return new Promise((resolve) => {
      const r = rec.onRuntimeMessage(
        { kind: 'recorder', v: 1, msg }, {}, resolve);
      if (r === false) {
        resolve(undefined);
      }
    });
  }

  function driveSession(rec) {
    return new Promise((resolve) => {
      const r = rec.onRuntimeMessage({
        kind: 'recorder', v: 1, msg: 'recorder-set-session',
        sessionId: SID, gameId: GID,
      }, {}, resolve);
      if (r === false) {
        resolve(undefined);
      }
    });
  }

  it("MSG_GET_STATUS = 'recorder-get-status' (exported)", () => {
    assert.equal(BS_REC.RECORDER_MSG_GET_STATUS, 'recorder-get-status');
  });

  it('MSG_* vocabulary is the 24-message shape (one deliberate 4.14 addition)', () => {
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

  it('recorder.js exposes getStreamStatusReader (lazy; injectable; wiring-defect → Error)', () => {
    const rec = BS_REC.createOffscreenRecorder({});
    assert.equal(typeof rec.getStreamStatusReader, 'function');
    const fake = { getAllStreamStatuses: () => Promise.resolve({}) };
    const rec2 = BS_REC.createOffscreenRecorder({ streamStatus: fake });
    assert.equal(rec2.getStreamStatusReader(), fake);
    const BS2 = Object.assign({}, BS);
    delete BS2.createStreamStatus;
    const saved = globalThis.BlindfoldSession;
    globalThis.BlindfoldSession = BS2; // no createStreamStatus
    try {
      const rec3 = BS_REC.createOffscreenRecorder({});
      assert.throws(() => rec3.getStreamStatusReader(), Error);
    } finally {
      globalThis.BlindfoldSession = saved;
    }
  });

  it("no-session → {ok:false, error:'no-session'} (never throws)", async () => {
    const rec = BS_REC.createOffscreenRecorder({});
    const resp = await drive(rec, 'recorder-get-status');
    assert.deepEqual(resp, { ok: false, error: 'no-session' });
  });

  it('with session → {ok, sessionId, queriedAtUtc, statuses}', async () => {
    const statuses = {
      microphone: { streamKind: 'microphone', lifecycle: 'idle' },
      screen: { streamKind: 'screen', lifecycle: 'idle' },
      webcam: { streamKind: 'webcam', lifecycle: 'idle' },
    };
    const rec = BS_REC.createOffscreenRecorder({
      streamStatus: { getAllStreamStatuses: () => Promise.resolve(statuses) },
    });
    await driveSession(rec);
    const resp = await drive(rec, 'recorder-get-status');
    assert.equal(resp.ok, true);
    assert.equal(resp.sessionId, SID);
    assert.equal(typeof resp.queriedAtUtc, 'string');
    assert.deepEqual(resp.statuses, statuses);
  });

  it('a rejecting reader becomes {ok:false} (never throws across the channel)', async () => {
    const rec = BS_REC.createOffscreenRecorder({
      streamStatus: {
        getAllStreamStatuses: () => Promise.reject(new Error('db down')),
      },
    });
    await driveSession(rec);
    const resp = await drive(rec, 'recorder-get-status');
    assert.equal(resp.ok, false);
  });

  it('a throwing factory becomes {ok:false, error:unavailable}', async () => {
    const BS2 = Object.assign({}, BS);
    delete BS2.createStreamStatus;
    const saved = globalThis.BlindfoldSession;
    globalThis.BlindfoldSession = BS2; // no createStreamStatus
    try {
      const rec2 = BS_REC.createOffscreenRecorder({});
      await driveSession(rec2);
      const resp = await drive(rec2, 'recorder-get-status');
      assert.deepEqual(resp, { ok: false, error: 'unavailable' });
    } finally {
      globalThis.BlindfoldSession = saved;
    }
  });
});

// ------------------------------------------------------------------
// AC6 — manifest discipline.
// ------------------------------------------------------------------

describe('AC6 — manifest discipline', () => {
  it('MANIFEST_KEYS stays exactly 18 (no 4.14 widening)', () => {
    assert.equal(BS_FMT.MANIFEST_KEYS.length, 18);
  });

  it('DB_VERSION stays 2 (no schema change)', () => {
    const src = fs.readFileSync(path.join(REPO, 'db.js'), 'utf8');
    assert.ok(/var DB_VERSION = 2;/.test(src));
  });

  it('status reads go through getManifestRecordsBySession (existing index)', async () => {
    const { reader } = makeWorld();
    let calls = 0;
    const reader2 = BS_SS.createStreamStatus({
      getStreamRecord: () => null,
      getChunkState: () => null,
      getMonitoredTracks: () => [],
      getStreamHealth: () => null,
      getManifestRecordsBySession: (sid) => {
        calls++;
        assert.equal(sid, SID);
        return Promise.resolve([]);
      },
      getSessionId: () => SID,
    });
    await reader2.getStreamStatus('microphone');
    assert.equal(calls, 1);
    assert(reader);
  });
});

// ------------------------------------------------------------------
// AC7 — no UI, no policy, no pipeline changes.
// ------------------------------------------------------------------

describe('AC7 — no UI, no policy, no pipeline changes', () => {
  it('no DOM writes in stream_status.js', () => {
    const code = codeOnly('stream_status.js');
    assert.ok(!/\.innerHTML|\.appendChild|\.createElement|insertAdjacentHTML/.test(code),
      'no DOM writes');
  });

  it('no "required streams" / readiness vocabulary in stream_status.js', () => {
    const code = codeOnly('stream_status.js');
    assert.ok(!/required/i.test(code), 'no required-streams policy');
    assert.ok(!/readiness/i.test(code), 'no readiness computation');
  });

  it('4.14 emits no new event types', () => {
    const code = codeOnly('stream_status.js');
    assert.ok(!/EVENT_TYPE/.test(code), 'no event types');
    const mon = codeOnly('track_monitor.js');
    // The monitor still defines exactly its three 4.9 event types.
    const types = mon.match(/var EVENT_[A-Z_]+ = '[^']+';/g) || [];
    assert.equal(types.length, 3);
  });

  it('pipeline modules are untouched except the additive getStreamHealth', () => {
    // git status --porcelain (not git diff HEAD) so new untracked
    // files are included. After the 4.14 commit the tree is clean, so
    // the pin is conditional on a non-empty status (2.8/4.4 precedent):
    // pre-commit it proves exactly the four product files changed;
    // post-commit it is vacuous.
    const status = execSync('git status --porcelain', { cwd: REPO }).toString();
    if (!status.trim()) return;
    const changed = status.split('\n').filter((l) => l.trim())
      .map((l) => l.slice(3).trim());
    const productChanged = changed.filter((f) =>
      (f.endsWith('.js') || f.endsWith('.html')) && !f.startsWith('tests/') &&
      !f.includes('.autodev/'));
    assert.deepEqual(productChanged.sort(), [
      'recorder.html',
      'recorder.js',
      'stream_status.js',
      'track_monitor.js',
    ].sort());
  });
});

// ------------------------------------------------------------------
// AC8 — diff discipline.
// ------------------------------------------------------------------

describe('AC8 — diff discipline', () => {
  it('git status shows only 4.14-allowed changes', () => {
    const status = execSync('git status --porcelain', { cwd: REPO }).toString();
    const changed = status.split('\n').filter((l) => l.trim())
      .map((l) => l.slice(3).trim());
    const allowed = new Set([
      // Honest cumulative evolution: 4.14 (report per-stream
      // recording status) legitimately adds stream_status.js (the
      // read-only query surface), wires the recorder-get-status
      // channel message + lazy getter into recorder.js, loads the
      // module in recorder.html, adds the additive getStreamHealth
      // seam (+ nowUtcIso opt + health retention) to
      // track_monitor.js, records the ## 4.14 decisions, and adds
      // its test + evidence; its files join the allowlists.
      'stream_status.js',
      'tests/stream_status.test.js',
      'recorder.js',
      'recorder.html',
      'track_monitor.js',
      '.autodev/evidence/4.14.contract.md',
      '.autodev/evidence/4.14.build.md',
      // Honest cumulative evolution: 4.14's review/behavior evidence
      // lands after the pins were evolved (2.x/3.x/4.1-4.13 precedent).
      '.autodev/evidence/4.14.review.md',
      '.autodev/evidence/4.14.behavior.md',
      '.autodev/DECISIONS.md',
      // Cumulative evolution: 4.14 evolves the earlier suites'
      // diff-discipline allowlists (and 5 MSG_* vocabulary pins)
      // with justification comments.
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
      'tests/sync_marker.test.js',
      'tests/timecode.test.js',
      'tests/track_monitor.test.js',
      'tests/visibility.test.js',
      'tests/writer.test.js',
    ]);
    const stray = changed.filter((f) => !allowed.has(f));
    assert.deepEqual(stray, [],
      'working tree has non-4.14 changes:\n' + stray.join('\n'));
  });

  it('PLAN.md is unmodified', () => {
    const diff = execSync('git diff HEAD -- PLAN.md', { cwd: REPO }).toString();
    assert.equal(diff, '');
  });

  it('content scripts are byte-identical', () => {
    for (const f of ['content.js', 'sync_flash.js']) {
      const diff = execSync(`git diff HEAD -- ${f}`, { cwd: REPO }).toString();
      assert.equal(diff, '', f + ' changed');
    }
  });
});
