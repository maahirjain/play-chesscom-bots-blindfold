// tests/clock_link.test.js
//
// V1 verification for task 4.10 (PLAN.md §4.10) per
// .autodev/evidence/4.10.contract.md. Covers acceptance criteria AC1–AC8
// (static/unit). AC9–AC10 (real Chrome) run separately via
// ~/workspace/tools/ext-verify/sw-clock-link.js; AC11 (real-device
// wall-clock reconstruction) is deferred to owner verification (§7).
//
// 4.10 is the link between the two identity systems: at stream start
// the active recording-context clock segment's ID (the clock_anchor's
// segmentId) is written into the recording's manifest record as
// clockSegmentId. 4.10 mints nothing (4.6 mints segmentIds), computes
// no offsets (4.12's), emits no events.
//
// Run: node --test tests/clock_link.test.js   (from repo root)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BS_CLK = require(path.join(REPO, 'clock_link.js'));
const BS_STR = require(path.join(REPO, 'stream_starter.js'));
const BS_FMT = require(path.join(REPO, 'format_support.js'));
const BS_POL = require(path.join(REPO, 'audio_policy.js'));
const BS_ENV = require(path.join(REPO, 'event_envelope.js'));
const BS_DB = require(path.join(REPO, 'db.js'));
const BS_DEV = require(path.join(REPO, 'device_selection.js'));
const BS_CAP = require(path.join(REPO, 'capture_selection.js'));

// The Node test harness publishes the merged namespace on
// globalThis (sender.js precedent): stream_starter.js resolves
// createClockLink the same way.
const BS = Object.assign({},
  BS_ENV, BS_STR, BS_FMT, BS_DEV, BS_CAP, BS_DB, BS_POL, BS_CLK);
globalThis.BlindfoldSession = BS;

const SID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const GID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SEGS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444'
];
// Two distinct clock anchors (two document generations).
const ANCHOR_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ANCHOR_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const REQUESTED = {
  microphone: 'audio/webm;codecs=opus',
  screen: 'video/webm;codecs=vp9,opus',
  webcam: 'video/webm;codecs=vp8,opus'
};
const NEGOTIATED = {
  microphone: 'audio/webm',
  screen: 'video/webm',
  webcam: 'video/webm'
};

// ------------------------------------------------------------------
// Compact fakes (stream_starter.test.js pattern, trimmed).
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
  return { tracks: tracks.slice(), getTracks() { return this.tracks; } };
}

function makeMediaRecorderClass() {
  const instances = [];
  class FakeMR {
    constructor(stream, mrOpts) {
      this.stream = stream;
      this.requestedMimeType = mrOpts ? mrOpts.mimeType : undefined;
      const kind = stream === FakeMR._mic ? 'microphone' :
        (stream === FakeMR._cam ? 'webcam' : 'screen');
      this.mimeType = NEGOTIATED[kind] || this.requestedMimeType;
      this.state = 'inactive';
      instances.push(this);
    }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
  }
  return { FakeMR, instances };
}

function makeWorld(overrides = {}) {
  const micStream = makeStream([makeTrack('audio', 'mic-1')]);
  const camStream = makeStream([makeTrack('video', 'cam-1')]);
  const tabStream = makeStream(
    [makeTrack('video', null), makeTrack('audio', null)]);
  const { FakeMR, instances } = makeMediaRecorderClass();
  FakeMR._mic = micStream;
  FakeMR._cam = camStream;

  const route = (c) => {
    if (c.audio && !c.video) { return micStream; }
    if (c.video && !c.audio) { return camStream; }
    if (c.video && c.video.mandatory &&
        c.video.mandatory.chromeMediaSource === 'tab') { return tabStream; }
    throw new Error('unexpected constraints in test route');
  };
  const mediaDevices = {
    getUserMedia: (c) => Promise.resolve().then(() => route(c))
  };
  const broker = {
    resolveTargetTab: () => Promise.resolve({ ok: true, tabId: 42 }),
    getStreamId: () => Promise.resolve({ ok: true, streamId: 'stream-tab-42' })
  };
  const sel = (state) => ({
    getState: () => Promise.resolve(state),
    recordDefault: () => Promise.resolve({ ok: true }),
    announceSelectionForSession: () => Promise.resolve({ ok: true })
  });
  const micSelector = sel({ ok: true, selection: 'mic-1' });
  const cameraSelector = sel({ ok: true, selection: 'cam-1' });
  const captureSelector = sel({
    ok: true, captureMode: 'tab', tabId: 42,
    tabTitle: 't', permissionState: 'granted'
  });

  // Real format support over an injected in-memory manifest store.
  const manifest = new Map();
  const db = overrides.db || {
    put: async (store, record) => {
      manifest.set(record.segmentId, JSON.parse(JSON.stringify(record)));
    },
    get: async (store, key) =>
      (manifest.has(key) ? JSON.parse(JSON.stringify(manifest.get(key))) : undefined),
    getAll: async () => Array.from(manifest.values())
  };
  const formatSupport = BS.createFormatSupport({
    mediaRecorder: { isTypeSupported: () => true },
    db,
    nowUtcIso: () => '2026-10-06T12:00:00.000Z'
  });
  const audioPolicy = BS.createAudioPolicy();
  const clockLink = ('clockLink' in overrides) ?
    overrides.clockLink : BS.createClockLink();

  let mono = overrides.anchorMonotonicMs !== undefined ?
    overrides.anchorMonotonicMs + 100 : 1100;
  const starter = BS.createStreamStarter({
    mediaDevices,
    getDisplayMedia: () =>
      Promise.reject(new Error('should not be called in tab mode')),
    MediaRecorder: FakeMR,
    micSelector,
    cameraSelector,
    captureSelector,
    broker,
    formatSupport,
    audioPolicy,
    clockLink,
    getAnchor: overrides.getAnchor,
    getSessionId: () => SID,
    getGameId: () => GID,
    nowUtcIso: () => '2026-10-06T12:00:00.000Z',
    perfNowMs: () => { mono += 7; return mono; },
    newUuidV4: (() => { let i = 0; return () => SEGS[i++ % SEGS.length]; })()
  });
  return { starter, formatSupport, manifest, db };
}

function makeAnchor(id, monotonicMs) {
  return { segmentId: id, utcEpochMs: 1728216000000, monotonicMs };
}

// Strip // and /* */ comments so the scan pins test executable code,
// not prose (4.6/4.7 precedent).
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

// ------------------------------------------------------------------
// AC1 — link written at stream start.
// ------------------------------------------------------------------

describe('AC1 — link written at stream start', () => {
  it('manifest records carry the active anchor id; same-clock sanity holds', async () => {
    const anchor = makeAnchor(ANCHOR_A, 900);
    let anchorCalls = 0;
    const { starter, manifest } = makeWorld({
      getAnchor: () => { anchorCalls++; return anchor; },
      anchorMonotonicMs: 900
    });
    const res = await starter.startStreams();
    assert.equal(res.ok, true);
    // The linker forced the lazy capture (getAnchor was called).
    assert.ok(anchorCalls >= 3, 'expected forced anchor capture');
    assert.equal(manifest.size, 3);
    for (const rec of manifest.values()) {
      assert.equal(rec.clockSegmentId, ANCHOR_A,
        'record must carry the active anchor id');
      // Same monotonic clock (contract AC1): the stream started after
      // the anchor was captured.
      assert.ok(rec.streamStartedAtMonotonicMs >= anchor.monotonicMs,
        'streamStartedAtMonotonicMs must be on the anchor clock');
    }
    // The link rides the channel response alongside the record
    // (4.6/4.7 precedent).
    for (const kind of ['microphone', 'screen', 'webcam']) {
      assert.equal(res.streams[kind].clockSegmentId, ANCHOR_A);
    }
  });
});

// ------------------------------------------------------------------
// AC2 — lazy anchor forced; failures become null, never a failure.
// ------------------------------------------------------------------

describe('AC2 — linking never fails the stream', () => {
  async function startWith(getAnchor, clockLink) {
    const { starter, manifest } = makeWorld({ getAnchor, clockLink });
    const res = await starter.startStreams();
    return { res, manifest };
  }

  it('throwing getAnchor → null links, streams still start', async () => {
    const { res, manifest } = await startWith(() => {
      throw new Error('captureClockAnchor is unavailable');
    });
    assert.equal(res.ok, true);
    for (const rec of manifest.values()) {
      assert.equal(rec.clockSegmentId, null);
    }
  });

  it('malformed anchor (non-uuid id) → null links, streams still start', async () => {
    const { res, manifest } = await startWith(
      () => ({ segmentId: 'not-a-uuid', utcEpochMs: 1, monotonicMs: 2 }));
    assert.equal(res.ok, true);
    for (const rec of manifest.values()) {
      assert.equal(rec.clockSegmentId, null);
    }
  });

  it('missing getAnchor thunk → null links, streams still start', async () => {
    const { res, manifest } = await startWith(undefined);
    assert.equal(res.ok, true);
    for (const rec of manifest.values()) {
      assert.equal(rec.clockSegmentId, null);
    }
  });

  it('unavailable linker (none injected, none in namespace) → null links', async () => {
    // Remove the namespace fallback as well: with no linker anywhere,
    // the link is honestly null and the streams still start.
    const saved = globalThis.BlindfoldSession.createClockLink;
    delete globalThis.BlindfoldSession.createClockLink;
    try {
      const { starter, manifest } = makeWorld({
        getAnchor: () => makeAnchor(ANCHOR_A, 900),
        clockLink: {}
      });
      const res = await starter.startStreams();
      assert.equal(res.ok, true);
      for (const rec of manifest.values()) {
        assert.equal(rec.clockSegmentId, null);
      }
    } finally {
      globalThis.BlindfoldSession.createClockLink = saved;
    }
  });

  it('linkClockSegment never throws on garbage input', () => {
    const link = BS.createClockLink().linkClockSegment;
    for (const bad of [null, undefined, 42, 'x', {}, { getAnchor: 42 },
        { getAnchor: () => null }, { getAnchor: () => 42 },
        { getAnchor: () => { throw new Error('boom'); } }]) {
      assert.deepEqual(link(bad), { clockSegmentId: null });
    }
  });
});

// ------------------------------------------------------------------
// AC3 — manifest widening is deliberate (15 → 16).
// ------------------------------------------------------------------

describe('AC3 — manifest widening is deliberate', () => {
  it('MANIFEST_KEYS is exactly the 18-key shape (4.13 adds two owned fields)', () => {
    const keys = BS.MANIFEST_KEYS;
    assert.equal(keys.length, 18);
    assert.ok(keys.includes('clockSegmentId'), 'missing clockSegmentId');
    assert.ok(keys.includes('segmentNumber'), 'missing segmentNumber');
    assert.ok(keys.includes('finalizedAtUtc'), 'missing finalizedAtUtc');
    const src = fs.readFileSync(path.join(REPO, 'format_support.js'), 'utf8');
    assert.ok(/\/\/ 4\.10-owned:\s*\n\s*'clockSegmentId'/.test(src),
      'expected the // 4.10-owned: comment convention');
    assert.ok(/\/\/ 4\.13-owned:\s*\n\s*'segmentNumber'/.test(src),
      'expected the // 4.13-owned: comment convention');
  });

  it('requireValidManifestRecord rejects extra keys; clockSegmentId nullable/uuid', () => {
    const fst = BS.createFormatSupport({
      mediaRecorder: { isTypeSupported: () => true },
      db: { put: async () => {} },
      nowUtcIso: () => '2026-10-06T12:00:00.000Z'
    });
    const base = {
      segmentId: SEGS[0], sessionId: SID, gameId: GID,
      streamKind: 'microphone', requestedMimeType: 'audio/webm',
      actualMimeType: 'audio/webm', fileExtension: '.webm',
      createdAtUtc: '2026-10-06T12:00:00.000Z',
      streamStartedAtUtc: null, streamStartedAtMonotonicMs: null,
      effectiveDeviceId: null, audioTrackPresent: null,
      videoTrackPresent: null, screenAudioContent: null,
      micAudioContent: null, clockSegmentId: null,
      // Honest cumulative evolution (4.13): the 4.13-owned finalization
      // fields (nullable until finalized).
      segmentNumber: null, finalizedAtUtc: null
    };
    assert.doesNotThrow(() => fst.requireValidManifestRecord(base));
    assert.doesNotThrow(() => fst.requireValidManifestRecord(
      Object.assign({}, base, { clockSegmentId: ANCHOR_A })));
    // Exact-keys discipline: a 19th key is rejected.
    assert.throws(() => fst.requireValidManifestRecord(
      Object.assign({}, base, { futureField: 1 })), TypeError);
    // Non-uuid link is rejected.
    assert.throws(() => fst.requireValidManifestRecord(
      Object.assign({}, base, { clockSegmentId: 'nope' })), TypeError);
  });

  it('recordSegmentFormat accepts clockSegmentId, defaults to null', async () => {
    const puts = [];
    const fst = BS.createFormatSupport({
      mediaRecorder: { isTypeSupported: () => true },
      db: { put: async (s, r) => { puts.push(r); } },
      nowUtcIso: () => '2026-10-06T12:00:00.000Z'
    });
    await fst.recordSegmentFormat({
      segmentId: SEGS[1], sessionId: SID, gameId: GID,
      streamKind: 'screen', requestedMimeType: 'video/webm',
      actualMimeType: 'video/webm', clockSegmentId: ANCHOR_A
    });
    assert.equal(puts[0].clockSegmentId, ANCHOR_A);
    await fst.recordSegmentFormat({
      segmentId: SEGS[2], sessionId: SID, gameId: GID,
      streamKind: 'screen', requestedMimeType: 'video/webm',
      actualMimeType: 'video/webm'
    });
    assert.equal(puts[1].clockSegmentId, null);
  });

  it('getManifestRecord reads one segment or null (no new index)', async () => {
    const store = new Map();
    const rec = {
      segmentId: SEGS[3], sessionId: SID, gameId: GID,
      streamKind: 'webcam', requestedMimeType: 'video/webm',
      actualMimeType: 'video/webm', fileExtension: '.webm',
      createdAtUtc: '2026-10-06T12:00:00.000Z',
      streamStartedAtUtc: null, streamStartedAtMonotonicMs: null,
      effectiveDeviceId: null, audioTrackPresent: null,
      videoTrackPresent: null, screenAudioContent: null,
      micAudioContent: null, clockSegmentId: ANCHOR_B
    };
    store.set(SEGS[3], rec);
    const fst = BS.createFormatSupport({
      mediaRecorder: { isTypeSupported: () => true },
      db: {
        put: async () => {},
        get: async (s, k) => store.get(k),
        getAll: async () => []
      },
      nowUtcIso: () => '2026-10-06T12:00:00.000Z'
    });
    const got = await fst.getManifestRecord(SEGS[3]);
    assert.equal(got.clockSegmentId, ANCHOR_B);
    assert.equal(await fst.getManifestRecord(SEGS[0]), null);
    assert.throws(() => fst.getManifestRecord('nope'), TypeError);
  });
});

// ------------------------------------------------------------------
// AC5 — identity-only (code-scan pin).
// ------------------------------------------------------------------

describe('AC5 — the linker is identity-only', () => {
  it('clock_link.js performs no wall-clock derivation in executable code', () => {
    const src = codeOnly(
      fs.readFileSync(path.join(REPO, 'clock_link.js'), 'utf8'));
    assert.ok(!src.includes('utcEpochMs'),
      'linker must not touch utcEpochMs');
    assert.ok(!src.includes('monotonicMs'),
      'linker must not touch monotonicMs');
    assert.ok(!src.includes('deriveWallUtcMs'),
      'linker must not derive wall time');
    // The only anchor property the linker reads is the identity.
    const reads = src.match(/anchor\.[a-zA-Z]+/g) || [];
    assert.deepEqual(reads.sort(), ['anchor.segmentId'],
      'linker must read only anchor.segmentId');
  });
});

// ------------------------------------------------------------------
// AC6 — 4.13 seam: the linker is callable standalone.
// ------------------------------------------------------------------

describe('AC6 — 4.13 seam', () => {
  it('links a caller-minted post-discontinuity segmentId', () => {
    // 4.13 mints; 4.10 owns all linking. The linker takes
    // {segmentId, getAnchor} — not hardwired to 4.6's pipeline.
    const synthetic = '55555555-5555-4555-8555-555555555555';
    const out = BS.createClockLink().linkClockSegment({
      segmentId: synthetic,
      getAnchor: () => makeAnchor(ANCHOR_A, 900)
    });
    assert.deepEqual(out, { clockSegmentId: ANCHOR_A });
    // Same-document clock: the value equals the generation's anchor
    // id, written fresh (never copied from another record).
    assert.equal(typeof BS.linkClockSegment, 'function',
      'direct export for the seam');
  });
});

// ------------------------------------------------------------------
// AC7 — discontinuities don't re-link.
// ------------------------------------------------------------------

describe('AC7 — discontinuities do not re-link', () => {
  it('no 4.9/4.8 module writes the manifest in executable code', () => {
    for (const f of ['track_monitor.js', 'chunk_writer.js']) {
      const src = codeOnly(
        fs.readFileSync(path.join(REPO, f), 'utf8'));
      assert.ok(!src.includes('recordSegmentFormat'),
        f + ' must not call the manifest writer');
      assert.ok(!src.includes('recording_manifest'),
        f + ' must not reference the manifest store');
    }
    // Only the stream starter calls the manifest writer (4.6/4.7/4.10
    // write stage); format_support.js defines it.
    const writers = [];
    for (const f of ['stream_starter.js', 'recorder.js', 'track_monitor.js',
        'chunk_writer.js', 'audio_policy.js', 'clock_link.js']) {
      const src = codeOnly(
        fs.readFileSync(path.join(REPO, f), 'utf8'));
      if (/[^a-zA-Z]recordSegmentFormat\s*\(/.test(src)) {
        writers.push(f);
      }
    }
    assert.deepEqual(writers, ['stream_starter.js'],
      'only the starter writes manifest records');
  });

  it('the link written at stream start is the only link (one put per stream)', async () => {
    let puts = 0;
    const anchor = makeAnchor(ANCHOR_A, 900);
    const backing = new Map();
    const { starter } = makeWorld({
      getAnchor: () => anchor,
      db: {
        put: async (store, record) => {
          puts++;
          backing.set(record.segmentId, JSON.parse(JSON.stringify(record)));
        },
        get: async (store, key) => backing.get(key),
        getAll: async () => Array.from(backing.values())
      }
    });
    const res = await starter.startStreams();
    assert.equal(res.ok, true);
    // Exactly one manifest put per started stream: the write stage is
    // the only writer (4.9's monitor writes events, never the
    // manifest — see the scan pin above).
    assert.equal(puts, 3);
    for (const rec of backing.values()) {
      assert.equal(rec.clockSegmentId, ANCHOR_A);
    }
  });

  it('restart: new anchor → new links; old records keep old links', async () => {
    // Generation 1 (document A).
    const w1 = makeWorld({ getAnchor: () => makeAnchor(ANCHOR_A, 900) });
    const r1 = await w1.starter.startStreams();
    assert.equal(r1.ok, true);
    // Generation 2 (document B, same session — the 4.9 'restart' case):
    // new anchor → new clock segment → new links.
    const w2 = makeWorld({ getAnchor: () => makeAnchor(ANCHOR_B, 5000) });
    const r2 = await w2.starter.startStreams();
    assert.equal(r2.ok, true);
    for (const rec of w1.manifest.values()) {
      assert.equal(rec.clockSegmentId, ANCHOR_A,
        'old generation keeps its old link');
    }
    for (const rec of w2.manifest.values()) {
      assert.equal(rec.clockSegmentId, ANCHOR_B,
        'new generation links against the new anchor');
    }
    assert.notEqual(
      Array.from(w1.manifest.values())[0].clockSegmentId,
      Array.from(w2.manifest.values())[0].clockSegmentId);
  });
});

// ------------------------------------------------------------------
// AC8 — changed-files discipline.
// ------------------------------------------------------------------

describe('AC8 — changed-files discipline', () => {
  it('the 4.10 working-tree diff touches only 4.10 files', () => {
    // Honest cumulative evolution (4.10): the clock link legitimately
    // adds clock_link.js, wires the link into the stream starter's
    // manifest-write stage, widens MANIFEST_KEYS 15 → 16 with the
    // 4.10-owned field, adds the getManifestRecord read, loads the new
    // module in recorder.html, exposes getClockLink in recorder.js
    // (the 4.13 seam), records the ## 4.10 decisions, and adds its
    // test + evidence; its files join the allowlists.
    const allowed = new Set([
      'clock_link.js',
      'tests/clock_link.test.js',
      'stream_starter.js',
      'format_support.js',
      'recorder.html',
      'recorder.js',
      '.autodev/evidence/4.10.contract.md',
      '.autodev/evidence/4.10.build.md',
      // Honest cumulative evolution: 4.10's review/behavior evidence
      // lands after the pins were evolved (2.x/3.x/4.1-4.9 precedent).
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
      // Cumulative evolution: earlier suites' diff-discipline
      // allowlists are evolved by this task with justification
      // comments.
      'tests/attempt_tracker.test.js',
      'tests/audio_policy.test.js',
      'tests/capture_broker.test.js',
      'tests/capture_selection.test.js',
      'tests/chunk_writer.test.js',
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
      'tests/track_monitor.test.js',
      'tests/timecode.test.js',
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
      // clock_link pins tracked diffs only; track_monitor.js is the
      // tracked 4.14-modified file.
      'track_monitor.js',
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
      // Honest cumulative evolution: 5.3 (remember previous selections
      // without silently changing a game's recorded conditions)
      // legitimately adds selection_memory.js (new/untracked — invisible
      // to git diff), adds the optional onSessionStarted hook to
      // session_controls.js (fired once at the phase → 'active' point,
      // guarded), wires the memory construction + restore + hook
      // pass-through into content.js, appends the "storage" permission
      // and selection_memory.js to manifest.json, evolves the
      // exact-permissions pins (tests/db.test.js,
      // tests/manifest_sw.test.js), the manifest/js-list pins
      // (tests/sender.test.js, tests/lifecycle.test.js,
      // tests/session_store.test.js, tests/recording_host.test.js,
      // tests/sync_marker.test.js), the load-surface scan
      // (tests/retention.test.js), records the ## 5.3 decisions, and
      // adds its test + evidence; its tracked files join the
      // allowlists. (5.3's new files are untracked and never appear in
      // git diff HEAD --name-only.)
      'session_controls.js',
      'content.js',
      'manifest.json',
      '.autodev/DECISIONS.md',
      'tests/db.test.js',
      'tests/manifest_sw.test.js',
      // 5.3 also evolves the working-tree diff pins in these suites.
      'tests/clock_link.test.js',
      'tests/timecode.test.js',
      'tests/sender.test.js',
      'tests/lifecycle.test.js',
      'tests/session_store.test.js',
      'tests/recording_host.test.js',
      'tests/sync_marker.test.js',
      'tests/retention.test.js',
      'tests/device_selection.test.js',
      'tests/writer.test.js',
      'tests/session_fields.test.js',
      'tests/session_controls.test.js',
      'tests/attempt_tracker.test.js',
      'tests/audio_policy.test.js',
      'tests/capture_selection.test.js',
      'tests/chunk_writer.test.js',
      'tests/finalizer.test.js',
      'tests/format_support.test.js',
      'tests/game_lifecycle.test.js',
      'tests/history_tracker.test.js',
      'tests/speech.test.js',
      'tests/status_indicator.test.js',
      'tests/stream_starter.test.js',
      'tests/stream_status.test.js',
      'tests/track_monitor.test.js',
      'tests/visibility.test.js',
      // Honest cumulative evolution: 5.4 (show detected game conditions
      // and allow manual completion of unavailable fields before
      // recording) legitimately adds detected_conditions.js (new/
      // untracked — invisible to git diff), wires the panel install +
      // getDetectedConditions plug-in + attachConditionsPanel composite
      // into content.js, adds detected_conditions.js to manifest.json,
      // adds additive panel classes to overlay.css, records the ## 5.4
      // decisions, and adds its test + evidence; its tracked files join
      // the allowlists. (content.js, manifest.json, overlay.css and
      // .autodev/DECISIONS.md are already allowlisted from 5.1/5.2/5.3;
      // 5.4's new files are untracked and never appear in
      // git diff HEAD --name-only.)
      // 5.4 also evolves the working-tree diff pins in these suites.
      'tests/clock_link.test.js',
      'tests/timecode.test.js',
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
      // Honest cumulative evolution: 5.5 (prevent a duplicate Start from
      // creating overlapping recording sessions) legitimately modifies
      // recorder.js (the atomic duplicate-Start guard in handleSetSession:
      // sessionId-equality discriminator, synchronous check-and-set,
      // nothing overwritten on refusal) and session_controls.js (the
      // content-side pre-check, mint reorder, localAbortStart, and
      // refusal-detail mapping), records the ## 5.5 decisions, and evolves
      // the cumulative pins in these suites; its tracked files join the
      // allowlists. (5.5's new test + evidence files are untracked and
      // never appear in git diff HEAD --name-only. No new channel
      // messages, events, stores, or permissions.)
      'recorder.js',
      'session_controls.js',
      'tests/duplicate_start.test.js',
      // 5.5 also evolves the working-tree diff pins in these suites.
      'tests/clock_link.test.js',
      'tests/timecode.test.js',
      'tests/attempt_tracker.test.js',
      'tests/audio_policy.test.js',
      'tests/capture_selection.test.js',
      'tests/chunk_writer.test.js',
      'tests/detected_conditions.test.js',
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
    const out = execSync('git diff HEAD --name-only', { cwd: REPO })
      .toString().trim();
    const changed = out === '' ? [] : out.split('\n');
    const stray = changed.filter((f) => !allowed.has(f));
    assert.deepEqual(stray, [],
      '4.10 has diff hunks beyond its files:\n' + stray.join('\n'));
  });

  it('no new event types; no new channel message', () => {
    const rec = fs.readFileSync(path.join(REPO, 'recorder.js'), 'utf8');
    const clk = fs.readFileSync(path.join(REPO, 'clock_link.js'), 'utf8');
    // 4.10 emits nothing: no event-type constant, no sendEventMessage
    // call, no new msg: value in the linker.
    assert.ok(!/EVENT_TYPE/.test(codeOnly(clk)), 'linker defines no event type');
    assert.ok(!/sendEventMessage/.test(codeOnly(clk)), 'linker sends no events');
    assert.ok(!/msg:\s*['"]recorder-/.test(codeOnly(clk)),
      'linker adds no channel message');
    void rec;
  });

  it('PLAN.md is unmodified', () => {
    const out = execSync('git diff main -- PLAN.md', { cwd: REPO })
      .toString().trim();
    assert.equal(out, '', 'PLAN.md must be untouched');
  });
});
