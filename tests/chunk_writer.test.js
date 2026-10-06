// tests/chunk_writer.test.js
//
// V1 verification for task 4.8 (PLAN.md §4.8) per
// .autodev/evidence/4.8.contract.md. Covers acceptance criteria AC1–AC8
// (static/unit). AC9–AC11 (real Chrome) run separately via
// ~/workspace/tools/ext-verify/sw-chunks.js; AC12 (real-device chunk
// reality) is deferred to owner verification (§7).
//
// 4.8's scope is chunk EXTRACTION + durable append: per-stream
// requestData() poll loops feed ondataavailable, and each non-empty Blob
// is appended to the extension-owned IDB `media_chunks` store (compound
// key [segmentId, chunkIndex]). 4.8 does not concatenate, finalize, or
// interpret chunk timing.
//
// Run: node --test tests/chunk_writer.test.js   (from repo root)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BS_CW = require(path.join(REPO, 'chunk_writer.js'));
const BS_STR = require(path.join(REPO, 'stream_starter.js'));
const BS_POL = require(path.join(REPO, 'audio_policy.js'));
const BS_FMT = require(path.join(REPO, 'format_support.js'));
const BS_REC = require(path.join(REPO, 'recorder.js'));

// The Node test harness publishes the merged namespace on
// globalThis (sender.js precedent): recorder.js resolves
// createChunkWriter / createStreamStarter the same way.
const BS = Object.assign({}, BS_CW, BS_STR, BS_POL, BS_FMT, BS_REC);
globalThis.BlindfoldSession = BS;

// ------------------------------------------------------------------
// Fakes.
// ------------------------------------------------------------------

function makeTimers() {
  let nextId = 1;
  const intervals = new Map();
  const timeouts = new Map();
  return {
    intervals,
    timeouts,
    setInterval: (fn, ms) => {
      const id = nextId++;
      intervals.set(id, { fn, ms, cleared: false });
      return id;
    },
    clearInterval: (id) => {
      const e = intervals.get(id);
      if (e) e.cleared = true;
    },
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timeouts.set(id, { fn, ms, cleared: false });
      return id;
    },
    clearTimeout: (id) => {
      const e = timeouts.get(id);
      if (e) e.cleared = true;
    },
    fireInterval: (id) => {
      const e = intervals.get(id);
      assert.ok(e && !e.cleared, 'interval must be live to fire');
      e.fn();
    },
    fireTimeout: (id) => {
      const e = timeouts.get(id);
      assert.ok(e && !e.cleared, 'timeout must be live to fire');
      e.fn();
    },
    liveIntervalIds: () =>
      [...intervals.entries()].filter(([, e]) => !e.cleared).map(([id]) => id),
    liveTimeoutIds: () =>
      [...timeouts.entries()].filter(([, e]) => !e.cleared).map(([id]) => id)
  };
}

function makeRecorder() {
  const listeners = {};
  return {
    state: 'recording',
    requestDataCalls: 0,
    throwOnRequestData: null,
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    dataAvailableHandlers: () => listeners['dataavailable'] || [],
    fireDataAvailable: function (data, timecode) {
      const ev = { data };
      if (timecode !== undefined) ev.timecode = timecode;
      for (const fn of (listeners['dataavailable'] || [])) fn(ev);
    },
    requestData: function () {
      this.requestDataCalls++;
      if (this.throwOnRequestData) throw this.throwOnRequestData;
    }
  };
}

function makeDb({ failWith = null } = {}) {
  const puts = [];
  return {
    puts,
    put: (store, record) => {
      puts.push({ store, record });
      return failWith ? Promise.reject(failWith) : Promise.resolve(undefined);
    }
  };
}

function makeClock() {
  let n = 0;
  let m = 1000;
  return {
    nowUtcIso: () => new Date(1000 * (n++)).toISOString(),
    performanceNow: () => (m += 7)
  };
}

const SEG = '11111111-1111-4111-8111-111111111111';

function makeWriter(overrides = {}) {
  const timers = makeTimers();
  const db = overrides.db || makeDb();
  const clock = makeClock();
  const writer = BS.createChunkWriter(Object.assign({
    db,
    nowUtcIso: clock.nowUtcIso,
    performanceNow: clock.performanceNow,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    random: () => 0.5 // deterministic: no jitter in tests unless overridden
  }, overrides.writerOpts || {}));
  return { writer, timers, db, clock };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

// ------------------------------------------------------------------
// AC1 — chunk record shape and identity.
// ------------------------------------------------------------------

describe('AC1 — chunk record shape and identity', () => {
  it('writes exactly the §2 shape to media_chunks with compound identity', async () => {
    const { writer, timers, db } = makeWriter();
    const rec = makeRecorder();
    writer.startForStream({ streamKind: 'microphone', segmentId: SEG, recorder: rec });
    const [iv] = timers.liveIntervalIds();
    timers.fireInterval(iv); // tick → requestData
    rec.fireDataAvailable({ size: 123 }, 456.7);
    await flush();
    assert.equal(db.puts.length, 1);
    const { store, record } = db.puts[0];
    assert.equal(store, 'media_chunks');
    assert.deepEqual(Object.keys(record).sort(), [
      'chunkIndex', 'data', 'receivedAtMonotonicMs', 'receivedAtUtc',
      'segmentId', 'timecodeMs'
    ]);
    assert.equal(record.segmentId, SEG);
    assert.equal(record.chunkIndex, 0);
    assert.equal(record.timecodeMs, 456.7); // raw passthrough, never analyzed
    assert.equal(record.data.size, 123);
    assert.equal(typeof record.receivedAtUtc, 'string');
    assert.equal(typeof record.receivedAtMonotonicMs, 'number');
  });

  it('chunkIndex is 0-based per segment and increments per stored chunk', async () => {
    const { writer, timers, db } = makeWriter();
    const rec = makeRecorder();
    writer.startForStream({ streamKind: 'microphone', segmentId: SEG, recorder: rec });
    const [iv] = timers.liveIntervalIds();
    for (let i = 0; i < 3; i++) {
      timers.fireInterval(iv);
      rec.fireDataAvailable({ size: 10 + i });
      await flush();
    }
    assert.deepEqual(db.puts.map((p) => p.record.chunkIndex), [0, 1, 2]);
  });

  it('per-segment isolation: two streams index independently', async () => {
    const { writer, timers, db } = makeWriter();
    const recA = makeRecorder();
    const recB = makeRecorder();
    writer.startForStream({ streamKind: 'microphone', segmentId: 'seg-a', recorder: recA });
    writer.startForStream({ streamKind: 'webcam', segmentId: 'seg-b', recorder: recB });
    const [ivA, ivB] = timers.liveIntervalIds();
    timers.fireInterval(ivA); recA.fireDataAvailable({ size: 5 });
    timers.fireInterval(ivB); recB.fireDataAvailable({ size: 6 });
    timers.fireInterval(ivA); recA.fireDataAvailable({ size: 7 });
    await flush();
    const bySeg = {};
    for (const p of db.puts) {
      (bySeg[p.record.segmentId] = bySeg[p.record.segmentId] || [])
        .push(p.record.chunkIndex);
    }
    assert.deepEqual(bySeg['seg-a'], [0, 1]);
    assert.deepEqual(bySeg['seg-b'], [0]);
  });

  it('missing event.timecode → timecodeMs null (never analyzed)', async () => {
    const { writer, timers, db } = makeWriter();
    const rec = makeRecorder();
    writer.startForStream({ streamKind: 'screen', segmentId: SEG, recorder: rec });
    const [iv] = timers.liveIntervalIds();
    timers.fireInterval(iv);
    rec.fireDataAvailable({ size: 9 });
    await flush();
    assert.equal(db.puts[0].record.timecodeMs, null);
  });

  it('no streamKind/sessionId/byteLength persisted (derivable rule)', async () => {
    const { writer, timers, db } = makeWriter();
    const rec = makeRecorder();
    writer.startForStream({ streamKind: 'microphone', segmentId: SEG, recorder: rec });
    const [iv] = timers.liveIntervalIds();
    timers.fireInterval(iv);
    rec.fireDataAvailable({ size: 9 });
    await flush();
    const record = db.puts[0].record;
    assert.ok(!('streamKind' in record));
    assert.ok(!('sessionId' in record));
    assert.ok(!('byteLength' in record));
  });

  it('0-byte Blobs are dropped: not stored, index not consumed, counted', async () => {
    const { writer, timers, db } = makeWriter();
    const rec = makeRecorder();
    writer.startForStream({ streamKind: 'microphone', segmentId: SEG, recorder: rec });
    const [iv] = timers.liveIntervalIds();
    timers.fireInterval(iv); rec.fireDataAvailable({ size: 0 });
    timers.fireInterval(iv); rec.fireDataAvailable({ size: 42 });
    await flush();
    assert.equal(db.puts.length, 1);
    assert.equal(db.puts[0].record.chunkIndex, 0);
    const state = writer.getChunkState('microphone');
    assert.equal(state.emptyPolls, 1);
    assert.equal(state.consecutiveMisses, 0); // a 0-byte drop is not a miss
  });
});

// ------------------------------------------------------------------
// AC2 — polling, not timeslice.
// ------------------------------------------------------------------

describe('AC2 — polling, not timeslice', () => {
  it('no timeslice argument is passed to any recorder.start() (code-scan pin)', () => {
    // chunk_writer.js never calls start() at all; stream_starter.js must
    // call it bare. A timeslice would look like .start(<digits>).
    for (const f of ['chunk_writer.js', 'stream_starter.js']) {
      const src = fs.readFileSync(path.join(REPO, f), 'utf8');
      const code = src.split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      assert.ok(!/\.start\(\s*\d/.test(code),
        `${f} must not pass a timeslice to recorder.start()`);
    }
  });

  it('CHUNK_POLL_MS is the named 5000 constant with ±10% jitter', () => {
    assert.equal(BS.CHUNK_WRITER_POLL_MS, 5000);
    for (const [rnd, expected] of [[0, 4500], [0.5, 5000], [1, 5500]]) {
      const { writer, timers } = makeWriter({ writerOpts: { random: () => rnd } });
      writer.startForStream({
        streamKind: 'microphone', segmentId: SEG, recorder: makeRecorder()
      });
      const [iv] = timers.liveIntervalIds();
      assert.equal(timers.intervals.get(iv).ms, expected);
    }
  });

  it('one setInterval loop per stream', () => {
    const { writer, timers } = makeWriter();
    writer.startForStream({ streamKind: 'microphone', segmentId: SEG, recorder: makeRecorder() });
    writer.startForStream({ streamKind: 'webcam', segmentId: SEG, recorder: makeRecorder() });
    assert.equal(timers.liveIntervalIds().length, 2);
    assert.ok(writer.hasActivePoll('microphone'));
    assert.ok(writer.hasActivePoll('webcam'));
    assert.ok(!writer.hasActivePoll('screen'));
  });

  it('ticks skip when recorder.state !== recording (loop stops, no error)', () => {
    const { writer, timers } = makeWriter();
    const rec = makeRecorder();
    writer.startForStream({ streamKind: 'microphone', segmentId: SEG, recorder: rec });
    const [iv] = timers.liveIntervalIds();
    rec.state = 'inactive';
    timers.fireInterval(iv);
    assert.equal(rec.requestDataCalls, 0);
    assert.ok(!writer.hasActivePoll('microphone'));
    assert.equal(writer.getChunkState('microphone').status, 'stopped');
  });

  it('requestData() throw → missed tick, never a stream failure', () => {
    const { writer, timers } = makeWriter();
    const rec = makeRecorder();
    rec.throwOnRequestData = new Error('recorder died');
    writer.startForStream({ streamKind: 'microphone', segmentId: SEG, recorder: rec });
    const [iv] = timers.liveIntervalIds();
    timers.fireInterval(iv);
    const state = writer.getChunkState('microphone');
    assert.equal(state.consecutiveMisses, 1);
    assert.equal(state.status, 'active'); // still polling — the stream is not failed
    assert.ok(writer.hasActivePoll('microphone'));
  });
});

// ------------------------------------------------------------------
// AC3 — empty-chunk and miss handling.
// ------------------------------------------------------------------

describe('AC3 — empty-chunk and miss handling', () => {
  it('missing dataavailable within 2000ms counts a miss', async () => {
    const { writer, timers } = makeWriter();
    const rec = makeRecorder();
    writer.startForStream({ streamKind: 'microphone', segmentId: SEG, recorder: rec });
    assert.equal(BS.CHUNK_WRITER_REQUEST_TIMEOUT_MS, 2000);
    const [iv] = timers.liveIntervalIds();
    timers.fireInterval(iv);
    assert.equal(timers.liveTimeoutIds().length, 1);
    const [to] = timers.liveTimeoutIds();
    assert.equal(timers.timeouts.get(to).ms, 2000);
    timers.fireTimeout(to); // the 2 s wait expires with no dataavailable
    const state = writer.getChunkState('microphone');
    assert.equal(state.consecutiveMisses, 1);
    assert.equal(state.status, 'active');
  });

  it('a successful chunk resets the miss counter', async () => {
    const { writer, timers, db } = makeWriter();
    const rec = makeRecorder();
    writer.startForStream({ streamKind: 'microphone', segmentId: SEG, recorder: rec });
    const [iv] = timers.liveIntervalIds();
    timers.fireInterval(iv);
    const [to] = timers.liveTimeoutIds();
    timers.fireTimeout(to);
    assert.equal(writer.getChunkState('microphone').consecutiveMisses, 1);
    timers.fireInterval(iv);
    rec.fireDataAvailable({ size: 5 });
    await flush();
    assert.equal(db.puts.length, 1);
    assert.equal(writer.getChunkState('microphone').consecutiveMisses, 0);
  });

  it('3 consecutive misses → chunk-stalled, loop stopped, fail-loud', () => {
    assert.equal(BS.CHUNK_WRITER_MAX_MISSES, 3);
    const { writer, timers } = makeWriter();
    const rec = makeRecorder();
    writer.startForStream({ streamKind: 'microphone', segmentId: SEG, recorder: rec });
    const [iv] = timers.liveIntervalIds();
    for (let i = 0; i < 3; i++) {
      timers.fireInterval(iv);
      const [to] = timers.liveTimeoutIds();
      timers.fireTimeout(to);
    }
    const state = writer.getChunkState('microphone');
    assert.equal(state.consecutiveMisses, 3);
    assert.equal(state.status, 'chunk-stalled');
    assert.ok(!writer.hasActivePoll('microphone'));
  });

  it('a tick inside a pending 2 s window does not double-request', () => {
    const { writer, timers } = makeWriter();
    const rec = makeRecorder();
    writer.startForStream({ streamKind: 'microphone', segmentId: SEG, recorder: rec });
    const [iv] = timers.liveIntervalIds();
    timers.fireInterval(iv);
    timers.fireInterval(iv); // still awaiting the first tick's dataavailable
    assert.equal(rec.requestDataCalls, 1);
  });
});

// ------------------------------------------------------------------
// AC4 — quota/write-failure fail-closed.
// ------------------------------------------------------------------

describe('AC4 — quota/write-failure fail-closed', () => {
  it('QuotaExceededError → chunk-quota-exceeded, loop stopped, no retry', async () => {
    const quotaErr = new Error('quota full');
    quotaErr.name = 'QuotaExceededError';
    const { writer, timers, db } = makeWriter({ db: makeDb({ failWith: quotaErr }) });
    const rec = makeRecorder();
    writer.startForStream({ streamKind: 'microphone', segmentId: SEG, recorder: rec });
    const [iv] = timers.liveIntervalIds();
    timers.fireInterval(iv);
    rec.fireDataAvailable({ size: 100 });
    await flush();
    const state = writer.getChunkState('microphone');
    assert.equal(state.status, 'chunk-quota-exceeded');
    assert.equal(state.lastErrorName, 'QuotaExceededError');
    assert.ok(!writer.hasActivePoll('microphone'));
    // The recorder itself is untouched — the recording continues.
    assert.equal(rec.state, 'recording');
    // No retry spin: exactly one write attempt was made.
    assert.equal(db.puts.length, 1);
  });

  it('other write rejections → chunk-write-error with name/message preserved', async () => {
    const idbErr = new Error('transaction aborted');
    idbErr.name = 'UnknownError';
    const { writer, timers } = makeWriter({ db: makeDb({ failWith: idbErr }) });
    const rec = makeRecorder();
    writer.startForStream({ streamKind: 'screen', segmentId: SEG, recorder: rec });
    const [iv] = timers.liveIntervalIds();
    timers.fireInterval(iv);
    rec.fireDataAvailable({ size: 100 });
    await flush();
    const state = writer.getChunkState('screen');
    assert.equal(state.status, 'chunk-write-error');
    assert.equal(state.lastErrorName, 'UnknownError');
    assert.equal(state.lastErrorMessage, 'transaction aborted');
    assert.ok(!writer.hasActivePoll('screen'));
  });

  it('failed writes reserve-then-gap: no duplicate keys, lastChunkIndex stays -1', async () => {
    const quotaErr = new Error('quota full');
    quotaErr.name = 'QuotaExceededError';
    let failNext = true;
    const db = makeDb();
    const origPut = db.put;
    db.put = (store, record) => failNext ?
      Promise.reject(quotaErr) : origPut(store, record);
    const { writer, timers } = makeWriter({ db });
    const rec = makeRecorder();
    writer.startForStream({ streamKind: 'microphone', segmentId: SEG, recorder: rec });
    const [iv] = timers.liveIntervalIds();
    timers.fireInterval(iv);
    rec.fireDataAvailable({ size: 100 });
    await flush();
    assert.equal(writer.getChunkState('microphone').lastChunkIndex, -1);
    assert.equal(writer.getChunkState('microphone').status, 'chunk-quota-exceeded');
    // The failed chunk's reserved index is a gap, never reused: a later
    // successful write for the same segment takes index 1, not 0.
    failNext = false;
    rec.fireDataAvailable({ size: 50 }); // final-flush path: handler stays attached
    await flush();
    assert.equal(db.puts.length, 1);
    assert.equal(db.puts[0].record.chunkIndex, 1);
  });
});

// ------------------------------------------------------------------
// AC5 — restart honesty; AC6 — wiring and seams.
// ------------------------------------------------------------------

describe('AC5/AC6 — honesty, validation, and seams', () => {
  it('stopForStream stops the loop but keeps the final-flush chunk path', async () => {
    const { writer, timers, db } = makeWriter();
    const rec = makeRecorder();
    writer.startForStream({ streamKind: 'microphone', segmentId: SEG, recorder: rec });
    const r = writer.stopForStream('microphone');
    assert.deepEqual(r, { ok: true, streamKind: 'microphone', wasActive: true });
    assert.ok(!writer.hasActivePoll('microphone'));
    assert.equal(writer.getChunkState('microphone').status, 'stopped');
    // 4.13's seam: the final stop() dataavailable is still stored.
    rec.fireDataAvailable({ size: 77 });
    await flush();
    assert.equal(db.puts.length, 1);
    assert.equal(db.puts[0].record.chunkIndex, 0);
  });

  it('stopAll is idempotent', () => {
    const { writer } = makeWriter();
    writer.startForStream({ streamKind: 'microphone', segmentId: SEG, recorder: makeRecorder() });
    const r1 = writer.stopAll();
    const r2 = writer.stopAll();
    assert.deepEqual(r1, { ok: true, stopped: ['microphone'] });
    assert.deepEqual(r2, { ok: true, stopped: ['microphone'] });
  });

  it('stopForStream preserves terminal failure states', () => {
    const { writer, timers } = makeWriter();
    const rec = makeRecorder();
    writer.startForStream({ streamKind: 'microphone', segmentId: SEG, recorder: rec });
    const [iv] = timers.liveIntervalIds();
    for (let i = 0; i < 3; i++) {
      timers.fireInterval(iv);
      const [to] = timers.liveTimeoutIds();
      timers.fireTimeout(to);
    }
    assert.equal(writer.getChunkState('microphone').status, 'chunk-stalled');
    writer.stopForStream('microphone');
    assert.equal(writer.getChunkState('microphone').status, 'chunk-stalled');
  });

  it('getChunkState is null for a never-chunked streamKind (unknown is null)', () => {
    const { writer } = makeWriter();
    assert.equal(writer.getChunkState('webcam'), null);
  });

  it('validation: TypeError on wrong shape, RangeError on bad domain', () => {
    const { writer } = makeWriter();
    const rec = makeRecorder();
    assert.throws(() => writer.startForStream({ streamKind: 42, segmentId: SEG, recorder: rec }), TypeError);
    assert.throws(() => writer.startForStream({ streamKind: 'nope', segmentId: SEG, recorder: rec }), RangeError);
    assert.throws(() => writer.startForStream({ streamKind: 'microphone', segmentId: '', recorder: rec }), TypeError);
    assert.throws(() => writer.startForStream({ streamKind: 'microphone', segmentId: SEG, recorder: null }), TypeError);
    assert.throws(() => writer.startForStream({ streamKind: 'microphone', segmentId: SEG, recorder: {} }), TypeError);
    assert.throws(() => writer.stopForStream('nope'), RangeError);
    assert.throws(() => writer.getChunkState('nope'), RangeError);
    assert.throws(() => writer.hasActivePoll('nope'), RangeError);
  });

  it('double startForStream for a kind stops the old loop first (no timer leak)', () => {
    const { writer, timers } = makeWriter();
    writer.startForStream({ streamKind: 'microphone', segmentId: 'seg-old', recorder: makeRecorder() });
    const [oldIv] = timers.liveIntervalIds();
    writer.startForStream({ streamKind: 'microphone', segmentId: 'seg-new', recorder: makeRecorder() });
    assert.ok(timers.intervals.get(oldIv).cleared);
    assert.equal(timers.liveIntervalIds().length, 1);
  });

  it('recorder.js exposes getChunkWriter; lazy wiring resolves from the namespace', () => {
    const rec = BS_REC.createOffscreenRecorder({});
    assert.equal(typeof rec.getChunkWriter, 'function');
    const writer = rec.getChunkWriter();
    assert.equal(typeof writer.startForStream, 'function');
    assert.equal(typeof writer.stopForStream, 'function');
    assert.equal(typeof writer.stopAll, 'function');
    assert.equal(typeof writer.getChunkState, 'function');
    assert.equal(typeof writer.hasActivePoll, 'function');
  });

  it('recorder.js accepts an injected o.chunkWriter (test seam)', () => {
    const fake = { startForStream: () => ({ ok: true }) };
    const rec = BS_REC.createOffscreenRecorder({ chunkWriter: fake });
    assert.equal(rec.getChunkWriter(), fake);
  });

  it('recorder-start-streams auto-starts chunking for successful streams only', async () => {
    const started = [];
    const fakeWriter = {
      startForStream: (args) => { started.push(args); return { ok: true }; }
    };
    const fakeRecs = { microphone: makeRecorder(), webcam: makeRecorder() };
    const fakeStarter = {
      startStreams: () => Promise.resolve({
        ok: false,
        streams: {
          microphone: { ok: true, segmentId: 'seg-mic' },
          screen: { ok: false, error: 'no-capture-mode', stage: 'acquire-stream' },
          webcam: { ok: true, segmentId: 'seg-cam' }
        }
      }),
      getActiveStreams: () => ({
        microphone: { segmentId: 'seg-mic', recorder: fakeRecs.microphone },
        webcam: { segmentId: 'seg-cam', recorder: fakeRecs.webcam }
      })
    };
    const rec = BS_REC.createOffscreenRecorder({
      streamStarter: fakeStarter,
      chunkWriter: fakeWriter
    });
    const resp = await new Promise((resolve) => {
      const r = rec.onRuntimeMessage(
        { kind: 'recorder', v: 1, msg: 'recorder-start-streams' }, {}, resolve);
      if (r === false) resolve(undefined);
    });
    assert.equal(resp.ok, false); // screen failed — response passes through
    assert.deepEqual(started.map((s) => s.streamKind).sort(), ['microphone', 'webcam']);
    assert.deepEqual(started.map((s) => s.segmentId).sort(), ['seg-cam', 'seg-mic']);
    assert.ok(started.every((s) => s.recorder && typeof s.recorder.requestData === 'function'));
  });

  it('a throwing chunk writer cannot fail the channel response (best-effort)', async () => {
    const fakeStarter = {
      startStreams: () => Promise.resolve({ ok: true, streams: {} }),
      getActiveStreams: () => ({
        microphone: { segmentId: SEG, recorder: makeRecorder() }
      })
    };
    const rec = BS_REC.createOffscreenRecorder({
      streamStarter: fakeStarter,
      chunkWriter: { startForStream: () => { throw new Error('chunker broke'); } }
    });
    const resp = await new Promise((resolve) => {
      const r = rec.onRuntimeMessage(
        { kind: 'recorder', v: 1, msg: 'recorder-start-streams' }, {}, resolve);
      if (r === false) resolve(undefined);
    });
    assert.equal(resp.ok, true);
  });

  it('recorder.js references no media-capture APIs for chunking (4.1 boundary)', () => {
    const src = fs.readFileSync(path.join(REPO, 'recorder.js'), 'utf8');
    const code = src.split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    for (const api of ['MediaRecorder', 'getUserMedia', 'getDisplayMedia', 'AudioContext']) {
      assert.ok(!code.includes(api), `recorder.js must not reference ${api}`);
    }
  });
});

// ------------------------------------------------------------------
// AC7 — changed-files discipline; AC8 — no overreach.
// ------------------------------------------------------------------

describe('AC7/AC8 — discipline and no overreach', () => {
  it('no new event types; MSG_* vocabulary unchanged (no new channel message)', () => {
    const src = fs.readFileSync(path.join(REPO, 'recorder.js'), 'utf8');
    const found = [];
    const re = /var (MSG_[A-Z_]+) = '([^']+)';/g;
    let m;
    while ((m = re.exec(src)) !== null) { found.push(m[1] + '=' + m[2]); }
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
      'MSG_START_STREAMS=recorder-start-streams'
    ]);
  });

  it('no overreach: no Blob assembly, no playback, no transcoding, no deletion', () => {
    const src = fs.readFileSync(path.join(REPO, 'chunk_writer.js'), 'utf8');
    const code = src.split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    assert.ok(!/new Blob\(/.test(code), 'no Blob assembly (4.13 owns it)');
    for (const needle of ['new Blob(', 'URL.createObjectURL', 'AnalyserNode',
                          'AudioContext', 'transcod', 'playback']) {
      assert.ok(!code.includes(needle), `chunk_writer.js must not contain ${needle}`);
    }
  });

  it('git status shows only 4.8-allowed changes', () => {
    const status = execSync('git status --porcelain', { cwd: REPO }).toString();
    const changed = status.split('\n').filter((l) => l.trim())
      .map((l) => l.slice(3).trim());
    const allowed = new Set([
      // Honest cumulative evolution: 4.8 (incremental chunk extraction)
      // legitimately adds chunk_writer.js, wires the automatic kickoff
      // into recorder.js's recorder-start-streams handler, loads the
      // new module in recorder.html, records the ## 4.8 decisions, and
      // adds its test + evidence; its files join the allowlists.
      'chunk_writer.js',
      'recorder.js',
      'recorder.html',
      // Honest cumulative evolution: 4.9 adds the additive
      // getManifestRecordsBySession read to format_support.js (restart
      // detection); its file joins this allowlist.
      'format_support.js',
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
      '.autodev/DECISIONS.md',
      // Cumulative evolution: earlier suites' diff-discipline allowlists
      // are evolved by this task with justification comments.
      'tests/attempt_tracker.test.js',
      'tests/audio_policy.test.js',
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
      'tests/stream_starter.test.js',
      'tests/visibility.test.js',
      'tests/writer.test.js'
    ]);
    for (const f of changed) {
      assert.ok(allowed.has(f), `unexpected modified file: ${f}`);
    }
  });
});
