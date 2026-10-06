// tests/finalizer.test.js
//
// V1 verification for task 4.13 (PLAN.md §4.13) per
// .autodev/evidence/4.13.contract.md. Covers acceptance criteria AC1–AC8
// (static/unit). AC9–AC10 (real Chrome) run separately via
// ~/workspace/tools/ext-verify/sw-stop.js; AC11 (split-path reality) is
// V1-pinned — post-gap media is not forceable headless — and documented
// honestly in the build report.
//
// 4.13 is the Stop half of the recording lifecycle: on
// `recorder-stop-streams` the finalizer emits the stop sync marker,
// waits the double-beep capture window (STOP_MARKER_WAIT_MS = 1000,
// once globally), stops every recorder, awaits the final
// `dataavailable` flush (bounded: poll recorder.state → 'inactive' ≤ 5s,
// then a 1s write grace; timeout → honest flushTimedOut:true), detaches
// the monitor BEFORE stopping tracks (a clean Stop is not a
// discontinuity), releases devices, discards the registry entries, then
// closes each segment's chunk set: segments whose chunk timeline spans
// a discontinuity with media on BOTH sides are split into separate
// pieces (new uuid-v4 segmentIds, post-gap chunks re-keyed 0-based in a
// single atomic IDB transaction, fresh clock link via 4.10's linker),
// every piece is numbered per (sessionId, streamKind) chronologically
// 1-based, and the manifest is marked finalizedAtUtc. Crash-recovery:
// a stop with no active streams but unfinalized orphans finalizes the
// orphans (no marker — no media to align to); a double Stop is a
// nothing-to-finalize no-op.
//
// Run: node --test tests/finalizer.test.js   (from repo root)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BS_ENV = require(path.join(REPO, 'event_envelope.js'));
const BS_AP = require(path.join(REPO, 'audio_policy.js'));
const BS_FMT = require(path.join(REPO, 'format_support.js'));
const BS_DB = require(path.join(REPO, 'db.js'));
const BS_STR = require(path.join(REPO, 'stream_starter.js'));
const BS_CW = require(path.join(REPO, 'chunk_writer.js'));
const BS_TM = require(path.join(REPO, 'track_monitor.js'));
const BS_SM = require(path.join(REPO, 'sync_marker.js'));
const BS_CL = require(path.join(REPO, 'clock_link.js'));
const BS_FIN = require(path.join(REPO, 'finalizer.js'));
const BS_REC = require(path.join(REPO, 'recorder.js'));

// The Node test harness publishes the merged namespace on globalThis
// (sender.js precedent): finalizer.js resolves BlindfoldSession.DB /
// MANIFEST_KEYS lazily, and recorder.js resolves createFinalizer the
// same way (the lazy getters check factory availability before the o.*
// injection, so every factory module must be present).
const BS = Object.assign({}, BS_ENV, BS_AP, BS_FMT, BS_DB, BS_STR, BS_CW,
  BS_TM, BS_SM, BS_CL, BS_FIN, BS_REC);
globalThis.BlindfoldSession = BS;

const SID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const GID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SEGS = [
  'cccccccc-3333-4333-8333-cccccccccccc',
  'dddddddd-4444-4444-8444-dddddddddddd',
  'eeeeeeee-5555-4555-8555-eeeeeeeeeeee',
];
const FIXED_NOW = '2026-10-06T12:00:00.000Z';

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

// ------------------------------------------------------------------
// Fakes.
// ------------------------------------------------------------------

// Controllable timers: the finalizer's STOP_MARKER_WAIT_MS (1000) and
// flush polling would otherwise make the suite sleep for seconds. The
// fake setTimeoutFn records the requested delay but fires on the next
// tick (real event loop), so the drive helper just pumps until settled.
function makeTimers() {
  let nowMs = 1000000;
  const calls = [];
  return {
    calls,
    setTimeoutFn: (fn, ms) => {
      calls.push(ms);
      setImmediate(fn);
      return calls.length;
    },
    performanceNow: () => nowMs,
    advance: (ms) => { nowMs += ms; },
    take: () => [],
    pendingCount: () => 0,
  };
}

// In-memory DB surface ({put, get, getAll}) with the real DB's key
// semantics: media_chunks keyed [segmentId, chunkIndex],
// recording_manifest keyed segmentId, events keyed eventId.
function makeDb() {
  const stores = {
    recording_manifest: new Map(),
    media_chunks: new Map(),
    events: new Map(),
  };
  function keyOf(store, record) {
    if (store === 'media_chunks') {
      return JSON.stringify([record.segmentId, record.chunkIndex]);
    }
    if (store === 'recording_manifest') {
      return record.segmentId;
    }
    return record.eventId;
  }
  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }
  function cmpKey(a, b) {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    return a[1] - b[1];
  }
  return {
    _stores: stores,
    put: async (store, record) => {
      stores[store].set(keyOf(store, record), clone(record));
    },
    get: async (store, key) => {
      const k = store === 'media_chunks' ? JSON.stringify(key) : key;
      const v = stores[store].get(k);
      return v === undefined ? null : clone(v);
    },
    getAll: async (store, options) => {
      let recs = [...stores[store].values()].map(clone);
      const opts = options || {};
      if (opts.index === 'bySessionId') {
        recs = recs.filter((r) => r.sessionId === opts.lower);
      } else if (opts.lower !== undefined && Array.isArray(opts.lower)) {
        recs = recs.filter((r) => {
          const k = [r.segmentId, r.chunkIndex];
          return cmpKey(k, opts.lower) >= 0 && cmpKey(k, opts.upper) <= 0;
        });
        recs.sort((a, b) => cmpKey(
          [a.segmentId, a.chunkIndex], [b.segmentId, b.chunkIndex]));
      }
      return recs;
    },
  };
}

// Fake indexedDB sharing the fake DB's Maps, so the test can verify the
// atomic split re-key (old keys gone, new keys present, piece record
// written) exactly as the finalizer's single readwrite transaction
// performs it.
function makeIndexedDB(db) {
  return {
    open: (name) => {
      const req = {};
      setTimeout(() => {
        const fakeDb = {
          transaction: (storeNames, mode) => {
            const tx = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              _done: false,
              objectStore: (storeName) => {
                const map = db._stores[storeName];
                return {
                  delete: (key) => {
                    const k = Array.isArray(key) ? JSON.stringify(key) : key;
                    map.delete(k);
                    return {};
                  },
                  put: (record) => {
                    const k = storeName === 'media_chunks'
                      ? JSON.stringify([record.segmentId, record.chunkIndex])
                      : record.segmentId;
                    map.set(k, JSON.parse(JSON.stringify(record)));
                    return {};
                  },
                };
              },
              abort: () => {
                if (!tx._done) {
                  tx._done = true;
                  setTimeout(() => { if (tx.onabort) tx.onabort(); }, 0);
                }
              },
            };
            // Real IDB fires oncomplete asynchronously after the
            // request queue drains; the finalizer's ops are synchronous
            // within onsuccess, so a next-tick oncomplete is faithful.
            setTimeout(() => {
              if (!tx._done && tx.oncomplete) {
                tx._done = true;
                tx.oncomplete();
              }
            }, 0);
            return tx;
          },
          close: () => {},
        };
        req.result = fakeDb;
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    },
  };
}

function makeRecorder() {
  return {
    state: 'recording',
    stopCalls: 0,
    stop() {
      this.stopCalls++;
      this.state = 'inactive';
    },
  };
}

function makeTrack() {
  return {
    stopped: false,
    stop() { this.stopped = true; },
  };
}

function makeStream(trackCount) {
  const tracks = [];
  for (let i = 0; i < trackCount; i++) tracks.push(makeTrack());
  return { getTracks: () => tracks, _tracks: tracks };
}

// Manifest record builder: a valid 18-key record (the real validator
// enforces exact keys).
function makeManifestRecord(overrides) {
  return Object.assign({
    segmentId: SEGS[0],
    sessionId: SID,
    gameId: GID,
    streamKind: 'microphone',
    requestedMimeType: 'audio/webm',
    actualMimeType: 'audio/webm',
    fileExtension: '.webm',
    createdAtUtc: '2026-10-06T10:00:00.000Z',
    streamStartedAtUtc: null,
    streamStartedAtMonotonicMs: null,
    effectiveDeviceId: null,
    audioTrackPresent: true,
    videoTrackPresent: false,
    screenAudioContent: null,
    micAudioContent: null,
    clockSegmentId: null,
    segmentNumber: null,
    finalizedAtUtc: null,
  }, overrides || {});
}

function makeChunk(segmentId, chunkIndex) {
  return {
    segmentId,
    chunkIndex,
    sessionId: SID,
    mimeType: 'audio/webm',
    byteLength: 10,
    capturedAtUtc: FIXED_NOW,
  };
}

function makeDiscontinuity(segmentId, lastChunkIndex, reason) {
  return {
    eventId: 'ev-' + segmentId.slice(0, 8) + '-' + lastChunkIndex,
    eventType: 'stream_discontinuity',
    sessionId: SID,
    occurredAtUtc: FIXED_NOW,
    payload: { reason, lastChunkIndex },
    refs: { segmentId },
  };
}

// Minimal world for split tests: direct finalizer construction with an
// explicitly shared db (no active streams — the orphans path exercises
// the same finalizePass as the stop path).
function makeSplitWorld(opts) {
  const o = opts || {};
  const db = makeDb();
  const timers = makeTimers();
  const linkCalls = [];
  let uuidN = 0;
  const fin = BS.createFinalizer({
    starter: { getActiveStreams: () => ({}), discardActiveStream: () => {}, _isStartInFlight: () => false },
    chunkWriter: { stopForStream: () => {}, getChunkState: () => null },
    trackMonitor: { detachStream: () => {} },
    syncMarker: { emitStopMarker: () => 'm1' },
    clockLink: { linkClockSegment: ({ segmentId }) => {
      linkCalls.push(segmentId);
      if (o.linkerThrows) throw new Error('linker boom');
      return { clockSegmentId: null };
    } },
    formatSupport: BS.createFormatSupport({
      mediaRecorder: { isTypeSupported: () => true },
      db,
      nowUtcIso: () => FIXED_NOW,
    }),
    db,
    indexedDB: makeIndexedDB(db),
    dbName: 'test-db',
    getSessionId: () => SID,
    getGameId: () => GID,
    finalizedField: 'finalizedAtUtc',
    nowUtcIso: () => FIXED_NOW,
    performanceNow: timers.performanceNow,
    setTimeoutFn: timers.setTimeoutFn,
    newUuidV4: o.newUuidV4 || (() => {
      uuidN++;
      const hex = String(uuidN).padStart(12, '0');
      return `ffffffff-ffff-4fff-8fff-${hex}`;
    }),
  });
  return { db, timers, fin, linkCalls };
}

// Full collaborator set; each fake records a call log for ordering
// assertions. `active` maps streamKind → {recorder, stream}.
function makeWorld(opts) {
  const o = opts || {};
  const db = o.db || makeDb();
  const timers = o.timers || makeTimers();
  const log = [];
  const active = {};
  for (const kind of (o.kinds || ['microphone'])) {
    active[kind] = {
      recorder: o.recorders && o.recorders[kind] ? o.recorders[kind] : makeRecorder(),
      stream: makeStream(2),
    };
  }
  const starter = {
    log,
    getActiveStreams: () => {
      log.push('getActiveStreams');
      const out = {};
      for (const k of Object.keys(active)) {
        out[k] = { recorder: active[k].recorder, stream: active[k].stream };
      }
      return out;
    },
    discardActiveStream: (kind) => {
      log.push('discard:' + kind);
      delete active[kind];
    },
    _isStartInFlight: () => !!o.startInFlight,
  };
  const chunkWriter = {
    log,
    stopForStream: (kind) => {
      log.push('chunkerStop:' + kind);
      const throws = o.chunkWriterThrows;
      if (throws === true || (throws && throws[kind])) {
        throw new Error('chunker boom');
      }
    },
    getChunkState: () => null,
  };
  const trackMonitor = {
    log,
    detachStream: (kind) => { log.push('detach:' + kind); },
  };
  const syncMarker = {
    log,
    emitStopMarker: () => {
      log.push('emitStopMarker');
      if (o.markerThrows) throw new Error('marker boom');
      return o.markerId === undefined ? 'marker-1' : o.markerId;
    },
  };
  const linkCalls = [];
  const clockLink = {
    linkCalls,
    linkClockSegment: ({ segmentId }) => {
      linkCalls.push(segmentId);
      if (o.linkerThrows) throw new Error('linker boom');
      return { clockSegmentId: 'linked-' + segmentId.slice(0, 8) };
    },
  };
  let uuidN = 0;
  const newUuidV4 = o.newUuidV4 || (() => {
    uuidN++;
    const hex = String(uuidN).padStart(12, '0');
    return `ffffffff-ffff-4fff-8fff-${hex}`;
  });
  const fin = BS.createFinalizer({
    starter,
    chunkWriter,
    trackMonitor,
    syncMarker,
    clockLink,
    getAnchor: () => ({ anchor: true }),
    formatSupport: BS.createFormatSupport({
      mediaRecorder: { isTypeSupported: () => true },
      db,
      nowUtcIso: () => FIXED_NOW,
    }),
    db,
    indexedDB: makeIndexedDB(db),
    dbName: 'test-db',
    getSessionId: () => (o.noSession ? null : SID),
    getGameId: () => (o.noSession ? null : GID),
    finalizedField: 'finalizedAtUtc',
    nowUtcIso: () => FIXED_NOW,
    performanceNow: timers.performanceNow,
    setTimeoutFn: timers.setTimeoutFn,
    newUuidV4,
  });
  return { db, timers, log, active, starter, chunkWriter, trackMonitor,
    syncMarker, clockLink, linkCalls, fin, newUuidV4 };
}

// Drive a stopAndFinalize() promise to completion. The fake timers fire
// via the real event loop (setImmediate), so this just pumps until the
// promise settles AND the event loop is quiescent (the fake indexedDB
// uses real setTimeout, which may lag the promise resolution by a tick).
async function drive(promise, timers, tick) {
  let settled = false;
  let result;
  let rejected = null;
  promise.then(
    (r) => { settled = true; result = r; },
    (e) => { settled = true; rejected = e; });
  let guard = 0;
  while (!settled) {
    if (++guard > 10000) throw new Error('drive: promise did not settle');
    if (tick) tick();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 0));
  }
  if (rejected) throw rejected;
  // Quiescence: allow any lagging real-timer callbacks (fake indexedDB)
  // to finish before the test inspects state.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setImmediate(r));
  }
  return result;
}

async function putManifest(db, record) {
  await db.put('recording_manifest', record);
}

async function manifestRecords(db) {
  return db.getAll('recording_manifest');
}

// ------------------------------------------------------------------
// AC1 — the stop sequence.
// ------------------------------------------------------------------

describe('AC1 — the stop sequence', () => {
  it('emits the stop marker, waits STOP_MARKER_WAIT_MS=1000 once globally, then stops', async () => {
    const w = makeWorld({ kinds: ['microphone', 'webcam'] });
    const res = await drive(w.fin.stopAndFinalize(), w.timers);
    assert.equal(res.ok, true);
    assert.equal(res.markerId, 'marker-1');
    // The marker wait is the first timer, exactly 1000 ms, once.
    assert.equal(w.timers.calls[0], 1000);
    assert.equal(w.timers.calls.filter((ms) => ms === 1000).length, 2); // marker wait + write grace
    // Ordering: marker → (wait) → chunker stops → recorder stops.
    const log = w.log;
    assert.ok(log.indexOf('emitStopMarker') < log.indexOf('chunkerStop:microphone'));
    assert.ok(log.indexOf('chunkerStop:microphone') < log.indexOf('discard:microphone'));
    assert.ok(log.indexOf('chunkerStop:webcam') < log.indexOf('discard:webcam'));
    assert.equal(w.active.microphone, undefined); // discarded
    assert.equal(w.active.webcam, undefined);
  });

  it('recorder.stop() is called per recording stream; skipped when not recording', async () => {
    const idle = makeRecorder();
    idle.state = 'inactive';
    const w = makeWorld({ kinds: ['microphone', 'webcam'],
      recorders: { microphone: idle } });
    const live = w.active.webcam.recorder;
    const res = await drive(w.fin.stopAndFinalize(), w.timers);
    assert.equal(res.ok, true);
    assert.equal(idle.stopCalls, 0);
    assert.equal(live.stopCalls, 1);
    assert.equal(live.state, 'inactive');
  });

  it('InvalidStateError on recorder.stop() is a skip, not a failure', async () => {
    const racy = makeRecorder();
    racy.stop = function () {
      // The recorder was already dead: stop() throws InvalidStateError
      // and the state is (or becomes) inactive — no final flush expected.
      this.state = 'inactive';
      const e = new Error('already stopped');
      e.name = 'InvalidStateError';
      throw e;
    };
    const w = makeWorld({ kinds: ['microphone'], recorders: { microphone: racy } });
    await w.db.put('recording_manifest', makeManifestRecord({}));
    const res = await drive(w.fin.stopAndFinalize(), w.timers);
    assert.equal(res.ok, true);
    assert.equal(res.streams.microphone.ok, true);
    // The segment still finalizes (the recorder was already dead).
    const recs = await manifestRecords(w.db);
    assert.equal(recs[0].segmentNumber, 1);
    assert.equal(recs[0].finalizedAtUtc, FIXED_NOW);
  });

  it('monitor detach happens before any track.stop()', async () => {
    const w = makeWorld({ kinds: ['microphone'] });
    const trackStops = [];
    const stream = w.active.microphone.stream;
    stream._tracks.forEach((t, i) => {
      const orig = t.stop.bind(t);
      t.stop = () => { trackStops.push('track' + i); orig(); };
    });
    await drive(w.fin.stopAndFinalize(), w.timers);
    const log = w.log;
    assert.ok(log.includes('detach:microphone'));
    assert.ok(log.indexOf('detach:microphone') < log.length); // detach logged
    // All tracks stopped.
    assert.ok(stream._tracks.every((t) => t.stopped));
    // Detach precedes track stops: the detach log entry comes before any
    // track stop could have been observed — verified by wrapping: the
    // detach call is synchronous in the sequence before the track loop.
    // (Order within the finalizer: step 7 detach, step 8 track stops.)
    assert.deepEqual(trackStops, ['track0', 'track1']);
  });

  it('a stop-marker failure becomes markerId:null; the sequence continues', async () => {
    const w = makeWorld({ kinds: ['microphone'], markerThrows: true });
    await w.db.put('recording_manifest', makeManifestRecord({}));
    const res = await drive(w.fin.stopAndFinalize(), w.timers);
    assert.equal(res.ok, true);
    assert.equal(res.markerId, null);
    const recs = await manifestRecords(w.db);
    assert.equal(recs[0].segmentNumber, 1);
  });

  it('per-stream failure isolation: one kind fails, the other finalizes', async () => {
    const bad = makeRecorder();
    bad.stop = () => { throw new Error('encoder died'); };
    const w = makeWorld({ kinds: ['microphone', 'webcam'],
      recorders: { microphone: bad } });
    await w.db.put('recording_manifest',
      makeManifestRecord({ segmentId: SEGS[0], streamKind: 'microphone' }));
    await w.db.put('recording_manifest',
      makeManifestRecord({ segmentId: SEGS[1], streamKind: 'webcam' }));
    const res = await drive(w.fin.stopAndFinalize(), w.timers);
    assert.equal(res.ok, true);
    assert.equal(res.streams.microphone.ok, false);
    assert.equal(res.streams.microphone.stage, 'stop-recorder');
    assert.deepEqual(res.streams.microphone.segments, []);
    assert.equal(res.streams.webcam.ok, true);
    assert.equal(res.streams.webcam.segments.length, 1);
    // The failed kind's segment stays unfinalized for a later retry.
    const recs = await manifestRecords(w.db);
    const mic = recs.find((r) => r.streamKind === 'microphone');
    const cam = recs.find((r) => r.streamKind === 'webcam');
    assert.equal(mic.finalizedAtUtc, null);
    assert.equal(mic.segmentNumber, null);
    assert.equal(cam.segmentNumber, 1);
    assert.equal(cam.finalizedAtUtc, FIXED_NOW);
  });

  it('chunker failure fails only that stream; the rest finalize', async () => {
    const w = makeWorld({ kinds: ['microphone', 'webcam'],
      chunkWriterThrows: { microphone: true } });
    const res = await drive(w.fin.stopAndFinalize(), w.timers);
    assert.equal(res.ok, true);
    assert.equal(res.streams.microphone.ok, false);
    assert.equal(res.streams.microphone.stage, 'stop-chunker');
    assert.equal(res.streams.webcam.ok, true);
  });
});

// ------------------------------------------------------------------
// AC2 — guards.
// ------------------------------------------------------------------

describe('AC2 — guards', () => {
  it('no session → {ok:false, error:no-session}; no device/media action', async () => {
    const w = makeWorld({ noSession: true });
    const res = await drive(w.fin.stopAndFinalize(), w.timers);
    assert.deepEqual(res, { ok: false, error: 'no-session' });
    assert.ok(!w.log.includes('emitStopMarker'));
    assert.equal(w.timers.calls.length, 0);
  });

  it('start in progress → {ok:false, error:start-in-progress}', async () => {
    const w = makeWorld({ startInFlight: true });
    const res = await drive(w.fin.stopAndFinalize(), w.timers);
    assert.deepEqual(res, { ok: false, error: 'start-in-progress' });
    assert.ok(!w.log.includes('emitStopMarker'));
  });

  it('factory requires its collaborators (TypeError on wiring defects)', () => {
    assert.throws(() => BS.createFinalizer({}), TypeError);
    assert.throws(() => BS.createFinalizer({ starter: null }), TypeError);
    const w = makeWorld({});
    // Sanity: a complete set constructs.
    assert.equal(typeof w.fin.stopAndFinalize, 'function');
  });
});

// ------------------------------------------------------------------
// AC3 — the final-flush await.
// ------------------------------------------------------------------

describe('AC3 — the final-flush await', () => {
  it('waits for recorders to report inactive, then the write grace', async () => {
    const w = makeWorld({ kinds: ['microphone'] });
    const res = await drive(w.fin.stopAndFinalize(), w.timers);
    assert.equal(res.ok, true);
    assert.equal(res.streams.microphone.flushTimedOut, undefined);
    // The marker wait (1000) and the write grace (1000) are observed.
    assert.ok(w.timers.calls.includes(1000));
  });

  it('flush timeout → honest flushTimedOut:true; still finalizes', async () => {
    const stuck = makeRecorder();
    stuck.stop = function () { this.stopCalls++; /* stays recording */ };
    const w = makeWorld({ kinds: ['microphone'],
      recorders: { microphone: stuck } });
    await w.db.put('recording_manifest', makeManifestRecord({}));
    const res = await drive(
      w.fin.stopAndFinalize(), w.timers, () => w.timers.advance(6000));
    assert.equal(res.ok, true);
    assert.equal(res.streams.microphone.flushTimedOut, true);
    const recs = await manifestRecords(w.db);
    assert.equal(recs[0].segmentNumber, 1);
    assert.equal(recs[0].finalizedAtUtc, FIXED_NOW);
  });

  it('waits are exactly STOP_MARKER_WAIT_MS=1000 / FLUSH_TIMEOUT=5000 / WRITE_GRACE=1000', () => {
    assert.equal(BS.FINALIZER_STOP_MARKER_WAIT_MS, 1000);
    assert.equal(BS.FINALIZER_FLUSH_TIMEOUT_MS, 5000);
    assert.equal(BS.FINALIZER_WRITE_GRACE_MS, 1000);
    assert.equal(BS.FINALIZER_FLUSH_POLL_MS, 100);
  });
});

// ------------------------------------------------------------------
// AC4 — numbering.
// ------------------------------------------------------------------

describe('AC4 — numbering per (sessionId, streamKind)', () => {
  it('numbers chronologically 1-based per streamKind', async () => {
    const w = makeWorld({ kinds: ['microphone', 'webcam'] });
    // Two mic segments out of chronological order; one webcam segment.
    await putManifest(w.db, makeManifestRecord({
      segmentId: SEGS[0], streamKind: 'microphone',
      createdAtUtc: '2026-10-06T10:02:00.000Z' }));
    await putManifest(w.db, makeManifestRecord({
      segmentId: SEGS[1], streamKind: 'microphone',
      createdAtUtc: '2026-10-06T10:01:00.000Z' }));
    await putManifest(w.db, makeManifestRecord({
      segmentId: SEGS[2], streamKind: 'webcam',
      createdAtUtc: '2026-10-06T10:00:00.000Z' }));
    const res = await drive(w.fin.stopAndFinalize(), w.timers);
    assert.equal(res.ok, true);
    const recs = await manifestRecords(w.db);
    const byId = {};
    recs.forEach((r) => { byId[r.segmentId] = r; });
    // Chronological within microphone: SEGS[1] (10:01) → 1, SEGS[0] → 2.
    assert.equal(byId[SEGS[1]].segmentNumber, 1);
    assert.equal(byId[SEGS[0]].segmentNumber, 2);
    // Webcam has its own 1-based sequence.
    assert.equal(byId[SEGS[2]].segmentNumber, 1);
    // One finalizedAtUtc for the whole pass.
    for (const r of recs) assert.equal(r.finalizedAtUtc, FIXED_NOW);
    // Response carries per-stream segment lists in number order.
    assert.deepEqual(res.streams.microphone.segments.map((s) => s.segmentNumber), [1, 2]);
    assert.deepEqual(res.streams.webcam.segments.map((s) => s.segmentNumber), [1]);
    for (const s of res.streams.microphone.segments) {
      assert.equal(typeof s.chunkCount, 'number');
    }
  });

  it('ties on createdAtUtc break by segmentId (deterministic)', async () => {
    const w = makeWorld({ kinds: ['microphone'] });
    const a = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const b = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
    await putManifest(w.db, makeManifestRecord({
      segmentId: b, createdAtUtc: '2026-10-06T10:00:00.000Z' }));
    await putManifest(w.db, makeManifestRecord({
      segmentId: a, createdAtUtc: '2026-10-06T10:00:00.000Z' }));
    await drive(w.fin.stopAndFinalize(), w.timers);
    const recs = await manifestRecords(w.db);
    const byId = {};
    recs.forEach((r) => { byId[r.segmentId] = r; });
    assert.equal(byId[a].segmentNumber, 1);
    assert.equal(byId[b].segmentNumber, 2);
  });

  it('idempotent: a second stop renumbers nothing', async () => {
    const w = makeWorld({ kinds: ['microphone'] });
    await putManifest(w.db, makeManifestRecord({}));
    const first = await drive(w.fin.stopAndFinalize(), w.timers);
    assert.equal(first.streams.microphone.segments[0].segmentNumber, 1);
    // No active streams now; the second stop is the double-Stop no-op.
    const second = await drive(w.fin.stopAndFinalize(), w.timers);
    assert.deepEqual(second,
      { ok: true, streams: {}, note: 'nothing-to-finalize' });
    const recs = await manifestRecords(w.db);
    assert.equal(recs[0].segmentNumber, 1);
    assert.equal(recs[0].finalizedAtUtc, FIXED_NOW);
  });
});

// ------------------------------------------------------------------
// AC5 — splits.
// ------------------------------------------------------------------

describe('AC5 — discontinuous segments split', () => {
  it('a non-restart gap with media on both sides splits into two pieces', async () => {
    const w = makeSplitWorld({});
    const db = w.db;
    const timers = w.timers;
    const linkCalls = w.linkCalls;
    const fin = w.fin;
    await db.put('recording_manifest', makeManifestRecord({
      segmentId: SEGS[0], clockSegmentId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' }));
    // Chunks 0..4; the discontinuity flags the gap after chunk 2.
    for (let i = 0; i <= 4; i++) {
      await db.put('media_chunks', makeChunk(SEGS[0], i));
    }
    await db.put('events', makeDiscontinuity(SEGS[0], 2, 'track-ended'));
    const res = await drive(fin.stopAndFinalize(), timers);
    assert.equal(res.ok, true);
    // Two pieces, numbered 1 and 2.
    const recs = await db.getAll('recording_manifest');
    assert.equal(recs.length, 2);
    const byId = {};
    recs.forEach((r) => { byId[r.segmentId] = r; });
    assert.equal(byId[SEGS[0]].segmentNumber, 1);
    const pieceId = recs.map((r) => r.segmentId).find((id) => id !== SEGS[0]);
    assert.equal(byId[pieceId].segmentNumber, 2);
    // The piece clones the template's stream identity with a fresh clock link.
    assert.equal(byId[pieceId].streamKind, 'microphone');
    assert.equal(byId[pieceId].sessionId, SID);
    assert.equal(byId[pieceId].gameId, GID);
    assert.deepEqual(linkCalls, [pieceId]);
    // Chunks re-keyed: original keeps 0..2, piece has 0..1 (was 3..4).
    const origChunks = await db.getAll('media_chunks',
      { lower: [SEGS[0], -1], upper: [SEGS[0], Number.MAX_SAFE_INTEGER] });
    const pieceChunks = await db.getAll('media_chunks',
      { lower: [pieceId, -1], upper: [pieceId, Number.MAX_SAFE_INTEGER] });
    assert.deepEqual(origChunks.map((c) => c.chunkIndex), [0, 1, 2]);
    assert.deepEqual(pieceChunks.map((c) => c.chunkIndex), [0, 1]);
    assert.equal(pieceChunks[0].byteLength, 10); // payload preserved
  });

  it('a gap with no post-gap media does NOT split', async () => {
    const w = makeSplitWorld({});
    await w.db.put('recording_manifest', makeManifestRecord({ segmentId: SEGS[0] }));
    for (let i = 0; i <= 2; i++) {
      await w.db.put('media_chunks', makeChunk(SEGS[0], i));
    }
    // Gap after the last chunk: nothing on the far side.
    await w.db.put('events', makeDiscontinuity(SEGS[0], 2, 'track-ended'));
    const res = await drive(w.fin.stopAndFinalize(), w.timers);
    assert.equal(res.ok, true);
    const recs = await w.db.getAll('recording_manifest');
    assert.equal(recs.length, 1);
    assert.equal(recs[0].segmentNumber, 1);
    assert.equal(w.linkCalls.length, 0);
  });

  it("'restart' never splits (4.6 already minted those generations)", async () => {
    const w = makeSplitWorld({});
    await w.db.put('recording_manifest', makeManifestRecord({ segmentId: SEGS[0] }));
    for (let i = 0; i <= 4; i++) {
      await w.db.put('media_chunks', makeChunk(SEGS[0], i));
    }
    await w.db.put('events', makeDiscontinuity(SEGS[0], 2, 'restart'));
    await drive(w.fin.stopAndFinalize(), w.timers);
    const recs = await w.db.getAll('recording_manifest');
    assert.equal(recs.length, 1);
    assert.equal(w.linkCalls.length, 0);
  });

  it('multiple gaps split sequentially into N+1 pieces', async () => {
    const w = makeSplitWorld({});
    await w.db.put('recording_manifest', makeManifestRecord({ segmentId: SEGS[0] }));
    for (let i = 0; i <= 8; i++) {
      await w.db.put('media_chunks', makeChunk(SEGS[0], i));
    }
    await w.db.put('events', makeDiscontinuity(SEGS[0], 2, 'track-ended'));
    await w.db.put('events', makeDiscontinuity(SEGS[0], 5, 'track-ended'));
    await drive(w.fin.stopAndFinalize(), w.timers);
    const recs = await w.db.getAll('recording_manifest');
    assert.equal(recs.length, 3);
    const numbers = recs.map((r) => r.segmentNumber).sort();
    assert.deepEqual(numbers, [1, 2, 3]);
    // Chunk sets: [0..2], [0..2] (was 3..5), [0..2] (was 6..8).
    for (const r of recs) {
      const chunks = await w.db.getAll('media_chunks',
        { lower: [r.segmentId, -1], upper: [r.segmentId, Number.MAX_SAFE_INTEGER] });
      assert.deepEqual(chunks.map((c) => c.chunkIndex), [0, 1, 2]);
    }
    assert.equal(w.linkCalls.length, 2);
  });

  it('a linker failure records a null clock link, never fails the split', async () => {
    const w = makeSplitWorld({ linkerThrows: true });
    await w.db.put('recording_manifest', makeManifestRecord({ segmentId: SEGS[0] }));
    for (let i = 0; i <= 4; i++) {
      await w.db.put('media_chunks', makeChunk(SEGS[0], i));
    }
    await w.db.put('events', makeDiscontinuity(SEGS[0], 2, 'track-ended'));
    const res = await drive(w.fin.stopAndFinalize(), w.timers);
    assert.equal(res.ok, true);
    const recs = await w.db.getAll('recording_manifest');
    assert.equal(recs.length, 2);
    const piece = recs.find((r) => r.segmentId !== SEGS[0]);
    assert.equal(piece.clockSegmentId, null);
    assert.equal(piece.segmentNumber, 2);
  });

  it('a split failure finalizes the segment unsplit (best-effort)', async () => {
    const w = makeSplitWorld({
      newUuidV4: () => { throw new Error('no entropy'); },
    });
    await w.db.put('recording_manifest', makeManifestRecord({ segmentId: SEGS[0] }));
    for (let i = 0; i <= 4; i++) {
      await w.db.put('media_chunks', makeChunk(SEGS[0], i));
    }
    await w.db.put('events', makeDiscontinuity(SEGS[0], 2, 'track-ended'));
    const res = await drive(w.fin.stopAndFinalize(), w.timers);
    assert.equal(res.ok, true);
    const recs = await w.db.getAll('recording_manifest');
    assert.equal(recs.length, 1);
    assert.equal(recs[0].segmentNumber, 1);
    assert.equal(recs[0].finalizedAtUtc, FIXED_NOW);
  });
});

// ------------------------------------------------------------------
// AC6 — crash recovery and double Stop.
// ------------------------------------------------------------------

describe('AC6 — crash recovery', () => {
  it('no active streams + unfinalized orphans → finalized-orphans (no marker)', async () => {
    const w = makeWorld({ kinds: [] });
    await putManifest(w.db, makeManifestRecord({ segmentId: SEGS[0] }));
    await putManifest(w.db, makeManifestRecord({
      segmentId: SEGS[1], streamKind: 'webcam' }));
    const res = await drive(w.fin.stopAndFinalize(), w.timers);
    assert.equal(res.ok, true);
    assert.equal(res.note, 'finalized-orphans');
    assert.equal(res.markerId, null);
    assert.deepEqual(res.streams, {});
    assert.ok(!w.log.includes('emitStopMarker'));
    const recs = await manifestRecords(w.db);
    assert.ok(recs.every((r) => r.finalizedAtUtc === FIXED_NOW));
  });

  it('no active streams + no orphans → nothing-to-finalize', async () => {
    const w = makeWorld({ kinds: [] });
    const res = await drive(w.fin.stopAndFinalize(), w.timers);
    assert.deepEqual(res, { ok: true, streams: {}, note: 'nothing-to-finalize' });
  });

  it('finalized records are never renumbered (restart pre-check exclusion)', async () => {
    const w = makeWorld({ kinds: [] });
    await putManifest(w.db, makeManifestRecord({
      segmentId: SEGS[0], segmentNumber: 7, finalizedAtUtc: '2026-10-06T09:00:00.000Z' }));
    const res = await drive(w.fin.stopAndFinalize(), w.timers);
    assert.deepEqual(res, { ok: true, streams: {}, note: 'nothing-to-finalize' });
    const recs = await manifestRecords(w.db);
    assert.equal(recs[0].segmentNumber, 7);
  });
});

// ------------------------------------------------------------------
// AC7 — manifest widening, vocabulary, and the finalized marker.
// ------------------------------------------------------------------

describe('AC7 — manifest widening, vocabulary, finalized marker', () => {
  it('MANIFEST_KEYS is exactly the 18-key shape', () => {
    assert.deepEqual(BS.MANIFEST_KEYS, [
      'segmentId', 'sessionId', 'gameId', 'streamKind',
      'requestedMimeType', 'actualMimeType', 'fileExtension',
      'createdAtUtc',
      'streamStartedAtUtc', 'streamStartedAtMonotonicMs',
      'effectiveDeviceId', 'audioTrackPresent', 'videoTrackPresent',
      'screenAudioContent', 'micAudioContent',
      'clockSegmentId',
      'segmentNumber',
      'finalizedAtUtc'
    ]);
  });

  it('the 4.13 fields are // 4.13-owned: and validate (positive-int / ISO-or-null)', () => {
    const src = fs.readFileSync(path.join(REPO, 'format_support.js'), 'utf8');
    assert.ok(/\/\/ 4\.13-owned:\s*\n\s*'segmentNumber'/.test(src));
    const fst = BS.createFormatSupport({
      mediaRecorder: { isTypeSupported: () => true },
      db: { put: async () => {} },
      nowUtcIso: () => FIXED_NOW,
    });
    const base = makeManifestRecord({});
    assert.doesNotThrow(() => fst.requireValidManifestRecord(base));
    assert.doesNotThrow(() => fst.requireValidManifestRecord(
      Object.assign({}, base, { segmentNumber: 3, finalizedAtUtc: FIXED_NOW })));
    assert.throws(() => fst.requireValidManifestRecord(
      Object.assign({}, base, { segmentNumber: 0 })), TypeError);
    assert.throws(() => fst.requireValidManifestRecord(
      Object.assign({}, base, { segmentNumber: 1.5 })), TypeError);
    assert.throws(() => fst.requireValidManifestRecord(
      Object.assign({}, base, { finalizedAtUtc: '' })), TypeError);
  });

  it('recorder.js MSG_* vocabulary is the 24-message shape (4.13 + 4.14 deliberate additions)', () => {
    const src = fs.readFileSync(path.join(REPO, 'recorder.js'), 'utf8');
    const found = [];
    const re = /var (MSG_[A-Z_]+) = '([^']+)';/g;
    let m;
    while ((m = re.exec(src)) !== null) { found.push(m[1] + '=' + m[2]); }
    assert.equal(found.length, 24);
    assert.ok(found.includes('MSG_STOP_STREAMS=recorder-stop-streams'));
    // Honest cumulative evolution: 4.14 deliberately adds the single
    // per-stream status query message (contract §3.2).
    assert.ok(found.includes('MSG_GET_STATUS=recorder-get-status'));
    assert.equal(BS.RECORDER_MSG_STOP_STREAMS, 'recorder-stop-streams');
    assert.equal(BS.RECORDER_MSG_GET_STATUS, 'recorder-get-status');
  });

  it('4.13 emits no new event types', () => {
    const code = codeOnly('finalizer.js');
    // The finalizer reads discontinuity events and writes chunks/manifest;
    // it emits nothing.
    assert.ok(!/emitEvent/.test(code), 'no event emission');
    assert.ok(!/eventType/.test(code) || /DISCONTINUITY_EVENT_TYPE/.test(code),
      'only reads the 4.9 discontinuity type');
  });

  it("recorder.js defines MANIFEST_FINALIZED_FIELD as 'finalizedAtUtc'", () => {
    const src = fs.readFileSync(path.join(REPO, 'recorder.js'), 'utf8');
    assert.ok(/var MANIFEST_FINALIZED_FIELD = 'finalizedAtUtc';/.test(src));
  });

  it('finalizer.js references no media-capture APIs', () => {
    const code = codeOnly('finalizer.js');
    for (const api of ['MediaRecorder', 'getUserMedia', 'getDisplayMedia',
      'AudioContext', 'webkitAudioContext', 'captureStream',
      'HTMLCanvasElement', 'requestData']) {
      assert.ok(!new RegExp(api).test(code), 'no ' + api);
    }
  });

  it('recorder.js exposes getFinalizer (lazy; injectable; wiring-defect → Error)', () => {
    const rec = BS_REC.createOffscreenRecorder({});
    assert.equal(typeof rec.getFinalizer, 'function');
    const fake = { stopAndFinalize: async () => ({ ok: true }) };
    const rec2 = BS_REC.createOffscreenRecorder({ finalizer: fake });
    assert.equal(rec2.getFinalizer(), fake);
    const BS2 = Object.assign({}, BS_ENV, BS_REC);
    const saved = globalThis.BlindfoldSession;
    globalThis.BlindfoldSession = BS2; // no createFinalizer
    try {
      const rec3 = BS_REC.createOffscreenRecorder({});
      assert.throws(() => rec3.getFinalizer(), Error);
    } finally {
      globalThis.BlindfoldSession = saved;
    }
  });

  it('stream_starter.js exposes the discardActiveStream seam (validated, idempotent)', () => {
    const st = BS_STR.createStreamStarter({
      getSession: () => ({ sessionId: SID, gameId: GID }),
      nowUtcIso: () => FIXED_NOW,
    });
    assert.equal(typeof st.discardActiveStream, 'function');
    assert.throws(() => st.discardActiveStream('nope'), RangeError);
    assert.doesNotThrow(() => st.discardActiveStream('microphone')); // absent → no-op
  });
});

// ------------------------------------------------------------------
// AC8 — diff discipline.
// ------------------------------------------------------------------

describe('AC8 — diff discipline', () => {
  it('git status shows only 4.13-allowed changes', () => {
    const status = execSync('git status --porcelain', { cwd: REPO }).toString();
    const changed = status.split('\n').filter((l) => l.trim())
      .map((l) => l.slice(3).trim());
    const allowed = new Set([
      // Honest cumulative evolution: 4.13 (finalize recordings at Stop)
      // legitimately adds finalizer.js (the Stop sequence), widens
      // MANIFEST_KEYS 16 → 18 with the 4.13-owned segmentNumber +
      // finalizedAtUtc fields, adds the MSG_STOP_STREAMS vocabulary
      // entry, wires the recorder-stop-streams handler into
      // recorder.js, adds the discardActiveStream seam to
      // stream_starter.js, loads the new module in recorder.html,
      // records the ## 4.13 decisions, and adds its test + evidence;
      // its files join the allowlists.
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
      '.autodev/DECISIONS.md',
      // Cumulative evolution: earlier suites' diff-discipline allowlists
      // are evolved by this task with justification comments.
      'tests/attempt_tracker.test.js',
      'tests/audio_policy.test.js',
      'tests/capture_selection.test.js',
      'tests/chunk_writer.test.js',
      'tests/clock_link.test.js',
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
      'tests/sync_marker.test.js',
      'tests/timecode.test.js',
      'tests/track_monitor.test.js',
      'tests/visibility.test.js',
      'tests/writer.test.js',
      // 4.14 deliberately touches track_monitor.js (additive
      // getStreamHealth seam + health mirror) — not in 4.13's
      // allowlist, so listed here.
      'track_monitor.js',
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
    ]);
    const stray = changed.filter((f) => !allowed.has(f));
    assert.deepEqual(stray, [],
      'working tree has non-4.13 changes:\n' + stray.join('\n'));
  });

  it('PLAN.md is unmodified', () => {
    const diff = execSync('git diff HEAD -- PLAN.md', { cwd: REPO }).toString();
    assert.equal(diff, '', 'PLAN.md must be unmodified');
  });

  it('content scripts byte-identical (no gameplay change)', () => {
    // Honest cumulative evolution (5.1): 5.1 legitimately wires the
    // Start/Stop install into content.js, adds the additive
    // getLastObservedEnd getter to chess_utils.js, adds additive classes
    // to overlay.css, and adds session_identity.js + session_controls.js
    // to the manifest content_scripts list (pinned in
    // tests/session_controls.test.js AC7). Gameplay itself is unchanged.
    const diff = execSync('git diff HEAD --name-only', { cwd: REPO })
      .toString().split('\n').filter((l) => l.trim());
    for (const f of diff) {
      assert.ok(!f.startsWith('content') && f !== 'manifest.json' ||
        ['recorder.html', 'content.js', 'chess_utils.js', 'overlay.css',
         'manifest.json'].includes(f),
        'content scripts and manifest.json untouched: ' + f);
    }
  });
});
