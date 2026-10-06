// tests/format_support.test.js
//
// V1 verification for task 4.5 (PLAN.md §4.5) per
// .autodev/evidence/4.5.contract.md. Covers acceptance criteria AC1–AC8
// (static/unit). AC9–AC11 (real Chrome) run separately via
// ~/workspace/tools/ext-verify/sw-formats.js; AC12 (real device codec
// support + actual MIME types from real recordings) is deferred to
// owner verification (§7).
//
// Run: node --test tests/format_support.test.js   (from repo root)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BS_FMT = require(path.join(REPO, 'format_support.js'));
const BS_POL = require(path.join(REPO, 'audio_policy.js'));
const BS_DB = require(path.join(REPO, 'db.js'));
const BS_ENV = require(path.join(REPO, 'event_envelope.js'));
const BS_DEV = require(path.join(REPO, 'device_selection.js'));
const BS_CAP = require(path.join(REPO, 'capture_selection.js'));
const BS_REC = require(path.join(REPO, 'recorder.js'));

// The Node test harness publishes the merged namespace on
// globalThis (sender.js precedent): format_support resolves DB through
// shared(), the recorder resolves createFormatSupport the same way, and
// (4.7) format_support resolves the audio-content validators at call
// time from the shared namespace.
const BS = Object.assign({}, BS_ENV, BS_FMT, BS_DEV, BS_CAP, BS_DB, BS_REC, BS_POL);
globalThis.BlindfoldSession = BS;

const SID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const GID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SEG = 'cccccccc-3333-4333-8333-cccccccccccc';

const FROZEN_LISTS = {
  microphone: [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4'
  ],
  screen: [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/webm'
  ],
  webcam: [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm;codecs=h264',
    'video/webm'
  ]
};

// A scripted MediaRecorder: supportedSet = MIME types reporting true.
function fakeMediaRecorder(supportedSet) {
  const seen = [];
  return {
    seen,
    isTypeSupported: (mime) => {
      seen.push(mime);
      return supportedSet.has(mime);
    }
  };
}

function fakeDb() {
  const puts = [];
  return {
    puts,
    put: async (store, record) => {
      puts.push({ store, record });
    }
  };
}

// ------------------------------------------------------------------
// AC1: module loads; verifyFormats returns the supported subset.
// ------------------------------------------------------------------

describe('AC1 — module and verifyFormats', () => {
  it('loads in Node via the shim and exposes the factory + constants', () => {
    assert.equal(typeof BS.createFormatSupport, 'function');
    assert.equal(typeof BS.extensionForMimeType, 'function');
    assert.equal(BS.MANIFEST_STORE_NAME, 'recording_manifest');
    assert.deepEqual(BS.FORMAT_STREAM_KINDS,
      ['microphone', 'screen', 'webcam']);
  });

  it('candidate lists are frozen and match the contract §3', () => {
    assert.deepEqual(BS.FORMAT_CANDIDATES, FROZEN_LISTS);
    assert.ok(Object.isFrozen(BS.FORMAT_CANDIDATES));
    for (const k of BS.FORMAT_STREAM_KINDS) {
      assert.ok(Object.isFrozen(BS.FORMAT_CANDIDATES[k]),
        'candidate list not frozen: ' + k);
    }
  });

  it('verifyFormats returns the supported subset per kind', () => {
    const supported = new Set([
      'audio/webm;codecs=opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/webm;codecs=vp8'
    ]);
    const mr = fakeMediaRecorder(supported);
    const fs = BS.createFormatSupport({ mediaRecorder: mr });
    const formats = fs.verifyFormats();
    assert.deepEqual(formats, {
      microphone: ['audio/webm;codecs=opus'],
      screen: ['video/webm;codecs=vp8,opus', 'video/webm'],
      webcam: ['video/webm;codecs=vp8', 'video/webm']
    });
  });

  it('every candidate is probed exactly once per call (no cache)', () => {
    const mr = fakeMediaRecorder(new Set());
    const fs = BS.createFormatSupport({ mediaRecorder: mr });
    fs.verifyFormats();
    const total = FROZEN_LISTS.microphone.length +
      FROZEN_LISTS.screen.length + FROZEN_LISTS.webcam.length;
    assert.equal(mr.seen.length, total, 'all candidates probed');
    fs.verifyFormats();
    assert.equal(mr.seen.length, total * 2, 're-probed, not cached');
  });
});

// ------------------------------------------------------------------
// AC2: priority order preserved — first supported candidate wins.
// ------------------------------------------------------------------

describe('AC2 — priority order', () => {
  it('order matches the frozen lists: VP9 > VP8 > H.264 > bare', () => {
    const mr = fakeMediaRecorder(new Set([
      'video/webm;codecs=vp9', 'video/webm;codecs=vp8',
      'video/webm;codecs=h264', 'video/webm'
    ]));
    const fs = BS.createFormatSupport({ mediaRecorder: mr });
    assert.deepEqual(fs.verifyFormats().webcam, FROZEN_LISTS.webcam);
  });

  it('empty support for a kind is an honest empty list, not a fallback', () => {
    const mr = fakeMediaRecorder(new Set(['audio/webm;codecs=opus']));
    const fs = BS.createFormatSupport({ mediaRecorder: mr });
    const formats = fs.verifyFormats();
    assert.deepEqual(formats.screen, [], 'no silent fallback to unverified type');
    assert.deepEqual(formats.webcam, []);
    assert.deepEqual(formats.microphone, ['audio/webm;codecs=opus']);
  });
});

// ------------------------------------------------------------------
// AC3: unavailable platform → plain Error (no weak fallback).
// ------------------------------------------------------------------

describe('AC3 — unavailable MediaRecorder', () => {
  function assertPlainError(err) {
    assert.ok(err instanceof Error, 'is an Error');
    assert.ok(!(err instanceof TypeError), 'not a TypeError');
    assert.ok(!(err instanceof RangeError), 'not a RangeError');
    return true;
  }

  it('null MediaRecorder → plain Error on verifyFormats', () => {
    const fs = BS.createFormatSupport({ mediaRecorder: null });
    assert.throws(() => fs.verifyFormats(), assertPlainError);
  });

  it('isTypeSupported missing → plain Error on verifyFormats', () => {
    const fs = BS.createFormatSupport({ mediaRecorder: {} });
    assert.throws(() => fs.verifyFormats(), assertPlainError);
  });

  it('a throwing isTypeSupported marks that candidate unsupported', () => {
    const mr = {
      isTypeSupported: (mime) => {
        if (mime === 'video/webm;codecs=vp9') {
          throw new Error('scripted probe failure');
        }
        return mime === 'video/webm;codecs=vp8';
      }
    };
    const fs = BS.createFormatSupport({ mediaRecorder: mr });
    assert.deepEqual(fs.verifyFormats().webcam, ['video/webm;codecs=vp8']);
  });
});

// ------------------------------------------------------------------
// AC4: extensionForMimeType mapping table.
// ------------------------------------------------------------------

describe('AC4 — extensionForMimeType', () => {
  const cases = [
    ['video/webm', '.webm'],
    ['video/webm;codecs=vp9', '.webm'],
    ['video/webm;codecs=vp9,opus', '.webm'],
    ['audio/webm', '.webm'],
    ['audio/webm;codecs=opus', '.webm'],
    ['video/mp4', '.mp4'],
    ['video/mp4;codecs=avc1', '.mp4'],
    ['audio/mp4', '.m4a'],
    ['audio/mp4;codecs=mp4a', '.m4a'],
    ['video/x-matroska', null],
    ['application/octet-stream', null],
    ['', null],
    [null, null],
    [undefined, null],
    [42, null]
  ];
  for (const [mime, expected] of cases) {
    it(`maps ${JSON.stringify(mime)} → ${JSON.stringify(expected)}`, () => {
      assert.equal(BS.extensionForMimeType(mime), expected);
    });
  }

  it('strips parameters and is case-insensitive on the container', () => {
    assert.equal(BS.extensionForMimeType('Video/WebM;codecs=vp9'), '.webm');
  });
});

// ------------------------------------------------------------------
// AC5: manifest record validator — exact keys, TypeError/RangeError.
// ------------------------------------------------------------------

describe('AC5 — requireValidManifestRecord', () => {
  // Honest cumulative evolution (4.6): the 4.5 §2 contract amendment
  // widens the manifest record with six 4.6-owned fields (the record is
  // written at stream start; 4.6 mints segmentId and records the actual
  // start times). The 4.6 fields default to null here — the widened
  // validator requires the keys present, and recordSegmentFormat still
  // accepts the 4.5 call shape by nulling absent fields.
  function validRecord(overrides) {
    return Object.assign({
      segmentId: SEG,
      sessionId: SID,
      gameId: GID,
      streamKind: 'screen',
      requestedMimeType: 'video/webm;codecs=vp9,opus',
      actualMimeType: 'video/webm;codecs=vp9,opus',
      fileExtension: '.webm',
      createdAtUtc: '2026-10-06T00:00:00.000Z',
      // 4.6-owned (nullable):
      streamStartedAtUtc: null,
      streamStartedAtMonotonicMs: null,
      effectiveDeviceId: null,
      audioTrackPresent: null,
      videoTrackPresent: null,
      // 4.7-owned (nullable):
      screenAudioContent: null,
      micAudioContent: null,
      // Honest cumulative evolution (4.10): the 4.10-owned clock link
      // joins the exact-keys shape (nullable).
      clockSegmentId: null,
      // Honest cumulative evolution (4.13): the 4.13-owned finalization
      // fields join the exact-keys shape (nullable until finalized).
      segmentNumber: null,
      finalizedAtUtc: null
    }, overrides || {});
  }

  function makeFs() {
    return BS.createFormatSupport({
      mediaRecorder: fakeMediaRecorder(new Set()),
      db: fakeDb()
    });
  }

  it('accepts a valid record (4.5 shape + 4.6/4.7-widened fields)', () => {
    const fs = makeFs();
    assert.deepEqual(fs.requireValidManifestRecord(validRecord()), validRecord());
  });

  it('bad streamKind → RangeError', () => {
    const fs = makeFs();
    assert.throws(() => fs.requireValidManifestRecord(
      validRecord({ streamKind: 'radio' })), RangeError);
  });

  it('malformed segmentId → TypeError', () => {
    const fs = makeFs();
    assert.throws(() => fs.requireValidManifestRecord(
      validRecord({ segmentId: 'not-a-uuid' })), TypeError);
  });

  it('malformed sessionId/gameId → TypeError', () => {
    const fs = makeFs();
    assert.throws(() => fs.requireValidManifestRecord(
      validRecord({ sessionId: 'x' })), TypeError);
    assert.throws(() => fs.requireValidManifestRecord(
      validRecord({ gameId: 'x' })), TypeError);
  });

  it('extra keys rejected (4.10/4.12/4.13 must widen deliberately)', () => {
    const fs = makeFs();
    assert.throws(() => fs.requireValidManifestRecord(
      validRecord({ clockAnchor: {} })), TypeError);
  });

  it('missing keys rejected', () => {
    const fs = makeFs();
    const r = validRecord();
    delete r.fileExtension;
    assert.throws(() => fs.requireValidManifestRecord(r), TypeError);
  });

  it('null actual/requested MIME allowed; bad extension → RangeError', () => {
    const fs = makeFs();
    fs.requireValidManifestRecord(validRecord({
      requestedMimeType: null, actualMimeType: null, fileExtension: null
    }));
    assert.throws(() => fs.requireValidManifestRecord(
      validRecord({ fileExtension: '.avi' })), RangeError);
  });
});

// ------------------------------------------------------------------
// AC6: recordSegmentFormat — derivation, null handling, pre-session.
// ------------------------------------------------------------------

describe('AC6 — recordSegmentFormat', () => {
  function makeFs(db) {
    return BS.createFormatSupport({
      mediaRecorder: fakeMediaRecorder(new Set()),
      db: db || fakeDb(),
      nowUtcIso: () => '2026-10-06T00:00:00.000Z'
    });
  }

  function input(overrides) {
    return Object.assign({
      segmentId: SEG,
      sessionId: SID,
      gameId: GID,
      streamKind: 'screen',
      requestedMimeType: 'video/webm;codecs=vp9,opus',
      actualMimeType: 'video/webm;codecs=vp9,opus'
    }, overrides || {});
  }

  it('writes the record with fileExtension derived from actualMimeType', async () => {
    const db = fakeDb();
    const fs = makeFs(db);
    const res = await fs.recordSegmentFormat(input());
    assert.deepEqual(res, { ok: true, segmentId: SEG, fileExtension: '.webm' });
    assert.equal(db.puts.length, 1);
    assert.equal(db.puts[0].store, 'recording_manifest');
    assert.deepEqual(db.puts[0].record, {
      segmentId: SEG,
      sessionId: SID,
      gameId: GID,
      streamKind: 'screen',
      requestedMimeType: 'video/webm;codecs=vp9,opus',
      actualMimeType: 'video/webm;codecs=vp9,opus',
      fileExtension: '.webm',
      createdAtUtc: '2026-10-06T00:00:00.000Z',
      // 4.6-owned fields default to null when the 4.5 call shape is used.
      streamStartedAtUtc: null,
      streamStartedAtMonotonicMs: null,
      effectiveDeviceId: null,
      audioTrackPresent: null,
      videoTrackPresent: null,
      // 4.7-owned fields default to null when the 4.5/4.6 call shape is
      // used (deliberate 13 → 15 widening).
      screenAudioContent: null,
      micAudioContent: null,
      // Honest cumulative evolution (4.10): the 4.10-owned clock link
      // joins the exact-keys shape (nullable).
      clockSegmentId: null,
      // Honest cumulative evolution (4.13): the 4.13-owned finalization
      // fields default to null (nullable until finalized).
      segmentNumber: null,
      finalizedAtUtc: null
    });
  });

  it('derives from the ACTUAL type when requested ≠ actual (diverged pair)', async () => {
    const db = fakeDb();
    const fs = makeFs(db);
    // Chrome normalized the requested string: actual is what counts.
    const res = await fs.recordSegmentFormat(input({
      requestedMimeType: 'video/webm;codecs=vp9,opus',
      actualMimeType: 'video/webm'
    }));
    assert.equal(res.fileExtension, '.webm');
    assert.equal(db.puts[0].record.fileExtension, '.webm');
    assert.equal(db.puts[0].record.requestedMimeType,
      'video/webm;codecs=vp9,opus', 'requested preserved for forensics');
  });

  it('unknown actual type → null extension, never fabricated', async () => {
    const db = fakeDb();
    const fs = makeFs(db);
    const res = await fs.recordSegmentFormat(input({
      requestedMimeType: 'video/x-matroska',
      actualMimeType: 'video/x-matroska'
    }));
    assert.deepEqual(res, { ok: true, segmentId: SEG, fileExtension: null });
    assert.equal(db.puts[0].record.fileExtension, null);
  });

  it('null actualMimeType → null extension', async () => {
    const db = fakeDb();
    const fs = makeFs(db);
    const res = await fs.recordSegmentFormat(input({
      requestedMimeType: null, actualMimeType: null
    }));
    assert.equal(res.fileExtension, null);
    assert.equal(db.puts[0].record.actualMimeType, null);
  });

  it('pre-session (null ids) → {ok:false}, no throw, no write', async () => {
    const db = fakeDb();
    const fs = makeFs(db);
    const res = await fs.recordSegmentFormat(
      input({ sessionId: null, gameId: null }));
    assert.deepEqual(res, { ok: false, error: 'no-session' });
    assert.equal(db.puts.length, 0, 'nothing written pre-session');
  });

  it('malformed input rejects with TypeError/RangeError (channel maps it)', async () => {
    const fs = makeFs();
    await assert.rejects(() => fs.recordSegmentFormat(
      input({ streamKind: 'radio' })), RangeError);
    await assert.rejects(() => fs.recordSegmentFormat(
      input({ segmentId: 'bad' })), TypeError);
  });

  it('non-object input → {ok:false, error:invalid-request}', async () => {
    const db = fakeDb();
    const fs = makeFs(db);
    assert.deepEqual(await fs.recordSegmentFormat(null),
      { ok: false, error: 'invalid-request' });
    assert.equal(db.puts.length, 0);
  });
});

// ------------------------------------------------------------------
// AC7: db.js SCHEMA includes recording_manifest; DB_VERSION is 2.
// ------------------------------------------------------------------

describe('AC7 — db.js schema', () => {
  it('SCHEMA includes recording_manifest (keyPath segmentId, bySessionId)', () => {
    const stores = BS.DB.SCHEMA.stores;
    const m = stores.find((s) => s.name === 'recording_manifest');
    assert.ok(m, 'recording_manifest present');
    assert.equal(m.keyPath, 'segmentId');
    assert.deepEqual(m.indexes, [
      { name: 'bySessionId', keyPath: 'sessionId', unique: false }
    ]);
  });

  it('DB_VERSION is 2 and SCHEMA.version matches', () => {
    assert.equal(BS.DB.DB_VERSION, 2);
    assert.equal(BS.DB.SCHEMA.version, 2);
  });
});

// ------------------------------------------------------------------
// Recorder channel: 'recorder-get-formats'.
// ------------------------------------------------------------------

describe('recorder channel — recorder-get-formats', () => {
  function makeRecorder(formatSupport) {
    const chromeNs = {
      runtime: {
        sendMessage: () => Promise.resolve({ ok: true }),
        onMessage: { addListener: () => true }
      }
    };
    const rec = BS.createOffscreenRecorder(Object.assign({
      chromeNs, announce: false,
      mediaDevices: null,
      storage: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      permissions: null,
      selectorClock: () => '2026-10-06T00:00:00.000Z'
    }, formatSupport ? { formatSupport } : {}));
    function send(msg) {
      return new Promise((resolve) => {
        const r = rec.onRuntimeMessage(
          Object.assign({ kind: 'recorder', v: 1 }, msg), {}, resolve);
        if (r === false) {
          resolve('sync-false');
        }
      });
    }
    return { rec, send };
  }

  it('routes recorder-get-formats → {ok, formats, verifiedAtUtc}', async () => {
    const fakeFs = {
      verifyFormats: () => ({
        microphone: ['audio/webm;codecs=opus'],
        screen: [],
        webcam: ['video/webm;codecs=vp8']
      }),
      recordSegmentFormat: async () => ({ ok: true })
    };
    const { send } = makeRecorder(fakeFs);
    const res = await send({ msg: 'recorder-get-formats' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.formats, {
      microphone: ['audio/webm;codecs=opus'],
      screen: [],
      webcam: ['video/webm;codecs=vp8']
    });
    assert.equal(typeof res.verifiedAtUtc, 'string');
  });

  it('unavailable MediaRecorder → {ok:false, error:unavailable}, never throws', async () => {
    const fakeFs = {
      verifyFormats: () => {
        throw new Error('format_support: MediaRecorder.isTypeSupported is unavailable');
      },
      recordSegmentFormat: async () => ({ ok: true })
    };
    const { send } = makeRecorder(fakeFs);
    const res = await send({ msg: 'recorder-get-formats' });
    assert.deepEqual(res, { ok: false, error: 'unavailable' });
  });

  it('unknown msg still ignored (4.1 behavior)', async () => {
    const { send } = makeRecorder({
      verifyFormats: () => ({}),
      recordSegmentFormat: async () => ({ ok: true })
    });
    assert.equal(await send({ msg: 'recorder-get-nonsense' }), 'sync-false');
  });
});

// ------------------------------------------------------------------
// AC8: diff discipline — only 4.5 files; no MediaRecorder
// construction; content scripts untouched; no new event types.
// ------------------------------------------------------------------

describe('AC8 — diff discipline', () => {
  it('only 4.5 files appear in git status', () => {
    const status = execSync('git status --porcelain', { cwd: REPO }).toString();
    const changed = status.split('\n').filter((l) => l.trim()).map((l) => l.slice(3).trim());
    const allowed = new Set([
      // Honest cumulative evolution: 4.5 (recording format verification
      // + recording manifest) legitimately adds format_support.js,
      // routes recorder-get-formats through recorder.js/recorder.html
      // (which now also load db.js), bumps db.js to version 2 with the
      // recording_manifest store, and adds its test + evidence; its
      // files join the allowlists.
      'format_support.js',
      'db.js',
      'recorder.js',
      'recorder.html',
      'tests/format_support.test.js',
      '.autodev/evidence/4.5.contract.md',
      '.autodev/evidence/4.5.build.md',
      // Honest cumulative evolution: 4.5's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.4 precedent).
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
      'tests/capture_broker.test.js',
      'tests/capture_selection.test.js',
      'tests/db.test.js',
      'tests/device_selection.test.js',
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
    ]);
    for (const f of changed) {
      assert.ok(allowed.has(f), `unexpected modified file: ${f}`);
    }
  });

  it('no MediaRecorder CONSTRUCTION in 4.5 product code (only isTypeSupported probing)', () => {
    for (const f of ['format_support.js', 'recorder.js', 'recorder.html', 'db.js']) {
      const src = fs.readFileSync(path.join(REPO, f), 'utf8');
      const code = src.split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      assert.ok(!/new\s+MediaRecorder/.test(code),
        `no MediaRecorder construction in ${f}`);
    }
  });

  it('content scripts byte-identical (no gameplay change)', () => {
    const status = execSync('git status --porcelain', { cwd: REPO }).toString();
    const changed = status.split('\n').filter((l) => l.trim()).map((l) => l.slice(3).trim());
    // Honest cumulative evolution (5.1): content.js + chess_utils.js leave
    // this list — 5.1 legitimately wires the Start/Stop install into
    // content.js and adds the additive getLastObservedEnd getter to
    // chess_utils.js (pinned in tests/session_controls.test.js AC7).
    for (const f of ['sounds.js']) {
      assert.ok(!changed.includes(f), `${f} must be untouched by 4.5`);
    }
  });

  it('event_envelope.js untouched (no new event types)', () => {
    const status = execSync('git status --porcelain', { cwd: REPO }).toString();
    const changed = status.split('\n').filter((l) => l.trim()).map((l) => l.slice(3).trim());
    assert.ok(!changed.includes('event_envelope.js'),
      'event_envelope.js must be untouched by 4.5');
  });
});
