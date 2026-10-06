// tests/audio_policy.test.js
//
// V1 verification for task 4.7 (PLAN.md §4.7) per
// .autodev/evidence/4.7.contract.md. Covers acceptance criteria AC1–AC8
// (static/unit). AC9–AC10 (real Chrome) run separately via
// ~/workspace/tools/ext-verify/sw-audio.js; AC11 (audible content on a
// real device) is deferred to owner verification (§7).
//
// 4.7 is the audio-CONTENT POLICY layer, not acquisition: it classifies
// what each stream's audio track can contain by construction and writes
// the classification into the manifest record. It acquires nothing new,
// builds no mixer, and performs no content analysis (forbidden by the
// raw-collection rule).
//
// Run: node --test tests/audio_policy.test.js   (from repo root)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BS_POL = require(path.join(REPO, 'audio_policy.js'));
const BS_FMT = require(path.join(REPO, 'format_support.js'));
const BS_STR = require(path.join(REPO, 'stream_starter.js'));
const BS_DB = require(path.join(REPO, 'db.js'));
const BS_ENV = require(path.join(REPO, 'event_envelope.js'));

// The Node test harness publishes the merged namespace on
// globalThis (sender.js precedent): format_support.js resolves the
// 4.7 audio-content validators at call time from the shared namespace,
// and stream_starter.js resolves createAudioPolicy the same way when
// it is not injected.
const BS = Object.assign({}, BS_ENV, BS_POL, BS_FMT, BS_STR, BS_DB);
globalThis.BlindfoldSession = BS;

const SID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const GID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SEGS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444'
];

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
// AC1 — classifyScreenAudio truth table.
// ------------------------------------------------------------------

describe('AC1 — screen classification correct', () => {
  it('loads in Node via the shim and exposes the factory + vocabularies', () => {
    assert.equal(typeof BS.createAudioPolicy, 'function');
    assert.deepEqual(BS.SCREEN_AUDIO_CONTENTS,
      ['tab-audio', 'system-audio', 'none']);
    assert.deepEqual(BS.MIC_AUDIO_CONTENTS, ['device-only']);
    assert.ok(Object.isFrozen(BS.SCREEN_AUDIO_CONTENTS));
    assert.ok(Object.isFrozen(BS.MIC_AUDIO_CONTENTS));
  });

  it('classifies the mode × track-presence matrix (contract §1.1)', () => {
    const ap = BS.createAudioPolicy();
    assert.equal(ap.classifyScreenAudio(
      { captureMode: 'tab', audioTrackPresent: true }), 'tab-audio');
    assert.equal(ap.classifyScreenAudio(
      { captureMode: 'screen', audioTrackPresent: true }), 'system-audio');
    assert.equal(ap.classifyScreenAudio(
      { captureMode: 'tab', audioTrackPresent: false }), 'none');
    assert.equal(ap.classifyScreenAudio(
      { captureMode: 'screen', audioTrackPresent: false }), 'none');
  });

  it('never guesses: unknown/unrecorded mode with a track → null', () => {
    const ap = BS.createAudioPolicy();
    assert.equal(ap.classifyScreenAudio(
      { captureMode: 'weird-future-mode', audioTrackPresent: true }), null);
    assert.equal(ap.classifyScreenAudio(
      { captureMode: null, audioTrackPresent: true }), null);
    assert.equal(ap.classifyScreenAudio(
      { captureMode: undefined, audioTrackPresent: true }), null);
    // No track → 'none' regardless of mode (nothing to classify).
    assert.equal(ap.classifyScreenAudio(
      { captureMode: null, audioTrackPresent: false }), 'none');
  });

  it('rejects wrong types (TypeError), never a weak classification', () => {
    const ap = BS.createAudioPolicy();
    assert.throws(() => ap.classifyScreenAudio(null), TypeError);
    assert.throws(() => ap.classifyScreenAudio('tab'), TypeError);
    assert.throws(() => ap.classifyScreenAudio(
      { captureMode: 'tab' }), TypeError);
    assert.throws(() => ap.classifyScreenAudio(
      { captureMode: 'tab', audioTrackPresent: 'yes' }), TypeError);
    assert.throws(() => ap.classifyScreenAudio(
      { captureMode: 42, audioTrackPresent: true }), TypeError);
  });
});

// ------------------------------------------------------------------
// AC2 — assertMicAudio + the intentional-mix prohibition (code scan).
// ------------------------------------------------------------------

describe('AC2 — mic assertion correct; no intentional mix', () => {
  it('returns device-only iff an audio track is present', () => {
    const ap = BS.createAudioPolicy();
    assert.equal(ap.assertMicAudio(
      { audioTrackPresent: true, audioTrackCount: 1 }), 'device-only');
    assert.equal(ap.assertMicAudio(
      { audioTrackPresent: true, audioTrackCount: 3 }), 'device-only');
    assert.equal(ap.assertMicAudio(
      { audioTrackPresent: true }), 'device-only');
    assert.equal(ap.assertMicAudio(
      { audioTrackPresent: false, audioTrackCount: 0 }), null);
    assert.equal(ap.assertMicAudio(
      { audioTrackPresent: false }), null);
  });

  it('validates audioTrackCount (TypeError/RangeError)', () => {
    const ap = BS.createAudioPolicy();
    assert.throws(() => ap.assertMicAudio(null), TypeError);
    assert.throws(() => ap.assertMicAudio(
      { audioTrackPresent: 'yes' }), TypeError);
    assert.throws(() => ap.assertMicAudio(
      { audioTrackPresent: true, audioTrackCount: 1.5 }), TypeError);
    assert.throws(() => ap.assertMicAudio(
      { audioTrackPresent: true, audioTrackCount: -1 }), RangeError);
  });

  it('no Web Audio graph in the offscreen scripts (intentional-mix prohibition)', () => {
    // The "intentional mix" prohibition made testable: no
    // AudioContext, no destination nodes, no analyser in executable
    // code. 4.6 already pinned separateness for stream_starter.js;
    // 4.7 re-pins it across every offscreen script the audio path
    // touches.
    const files = ['audio_policy.js', 'stream_starter.js', 'recorder.js',
      'device_selection.js', 'capture_selection.js', 'format_support.js',
      'recording_host.js'];
    for (const f of files) {
      const code = codeOnly(f);
      assert.ok(!/AudioContext/.test(code), `${f}: no AudioContext`);
      assert.ok(!/AudioDestinationNode/.test(code),
        `${f}: no AudioDestinationNode`);
      assert.ok(!/createMediaStreamDestination/.test(code),
        `${f}: no createMediaStreamDestination`);
      assert.ok(!/AnalyserNode/.test(code), `${f}: no AnalyserNode`);
    }
  });

  it('no track merging in stream_starter.js (4.6 separateness re-pinned)', () => {
    const code = codeOnly('stream_starter.js');
    assert.ok(!/new\s+MediaStream\(/.test(code), 'no new MediaStream');
    assert.ok(!/addTrack/.test(code), 'no addTrack');
  });
});

// ------------------------------------------------------------------
// AC3 — deliberate manifest widening 13 → 15, then 15 → 16 (4.10).
// ------------------------------------------------------------------

describe('AC3 — manifest widening is deliberate (13 → 15 → 16)', () => {
  function makeFs() {
    const puts = [];
    const db = { put: async (store, record) => { puts.push({ store, record }); } };
    const mr = { isTypeSupported: () => false };
    return { fs: BS.createFormatSupport({ mediaRecorder: mr, db }), puts };
  }

  function validRecord(overrides) {
    return Object.assign({
      segmentId: SEGS[0],
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

  it('MANIFEST_KEYS is exactly the 18-key shape (4.13 adds segmentNumber + finalizedAtUtc)', () => {
    assert.deepEqual(BS.MANIFEST_KEYS, [
      'segmentId', 'sessionId', 'gameId', 'streamKind',
      'requestedMimeType', 'actualMimeType', 'fileExtension', 'createdAtUtc',
      // 4.6-owned:
      'streamStartedAtUtc', 'streamStartedAtMonotonicMs',
      'effectiveDeviceId', 'audioTrackPresent', 'videoTrackPresent',
      // 4.7-owned:
      'screenAudioContent', 'micAudioContent',
      // 4.10-owned:
      'clockSegmentId',
      // Honest cumulative evolution (4.13): the 4.13-owned finalization
      // fields (nullable until finalized).
      'segmentNumber',
      'finalizedAtUtc'
    ]);
  });

  it('requireValidManifestRecord accepts the widened shape; rejects extra keys', () => {
    const { fs } = makeFs();
    assert.deepEqual(fs.requireValidManifestRecord(validRecord()), validRecord());
    assert.throws(() => fs.requireValidManifestRecord(
      validRecord({ screenAudioContent: 'tab-audio', extra: 1 })), TypeError);
  });

  it('new fields validate their vocabularies (RangeError on bad values)', () => {
    const { fs } = makeFs();
    assert.deepEqual(
      fs.requireValidManifestRecord(validRecord({ screenAudioContent: 'tab-audio' })),
      validRecord({ screenAudioContent: 'tab-audio' }));
    assert.deepEqual(
      fs.requireValidManifestRecord(validRecord({ micAudioContent: 'device-only' })),
      validRecord({ micAudioContent: 'device-only' }));
    assert.throws(() => fs.requireValidManifestRecord(
      validRecord({ screenAudioContent: 'mp3' })), RangeError);
    assert.throws(() => fs.requireValidManifestRecord(
      validRecord({ micAudioContent: 'mixed' })), RangeError);
    assert.throws(() => fs.requireValidManifestRecord(
      validRecord({ screenAudioContent: 42 })), RangeError);
  });

  it('recordSegmentFormat derives the 4.7 fields; 4.5 call shape still defaults to null', async () => {
    const { fs, puts } = makeFs();
    const wr = await fs.recordSegmentFormat({
      segmentId: SEGS[1], sessionId: SID, gameId: GID, streamKind: 'screen',
      requestedMimeType: 'video/webm', actualMimeType: 'video/webm',
      screenAudioContent: 'system-audio', micAudioContent: null
    });
    assert.equal(wr.ok, true);
    assert.equal(puts.length, 1);
    assert.equal(puts[0].record.screenAudioContent, 'system-audio');
    assert.equal(puts[0].record.micAudioContent, null);
    // 4.5's call shape (no 4.6/4.7 fields) still works — nulls.
    const wr2 = await fs.recordSegmentFormat({
      segmentId: SEGS[2], sessionId: SID, gameId: GID, streamKind: 'microphone',
      requestedMimeType: 'audio/webm', actualMimeType: 'audio/webm'
    });
    assert.equal(wr2.ok, true);
    assert.equal(puts[1].record.screenAudioContent, null);
    assert.equal(puts[1].record.micAudioContent, null);
  });

  it('cross-stream nulls: screenAudioContent only on screen, micAudioContent only on mic', () => {
    // The convention is enforced by the stream starter wiring (AC4);
    // the validator permits nulls everywhere so the record shape stays
    // uniform (4.6 precedent).
    const { fs } = makeFs();
    assert.doesNotThrow(() => fs.requireValidManifestRecord(
      validRecord({ streamKind: 'microphone', micAudioContent: 'device-only' })));
    assert.doesNotThrow(() => fs.requireValidManifestRecord(
      validRecord({ streamKind: 'webcam' })));
  });
});

// ------------------------------------------------------------------
// AC4 — wired into the 4.6 start pipeline.
// ------------------------------------------------------------------

// A compact scripted world driving the REAL createStreamStarter with
// the REAL audio policy and the REAL format support (fake IDB), so the
// AC4 wiring claim is proven, not mocked.
function makeTrack(kind) {
  return { kind, stopped: false, getSettings: () => ({}), stop() { this.stopped = true; } };
}
function makeStream(tracks) {
  return { tracks: tracks.slice(), getTracks() { return this.tracks; } };
}
function makeWorld(overrides = {}) {
  const micStream = makeStream([makeTrack('audio')]);
  const camStream = makeStream([makeTrack('video')]);
  const scrTracks = overrides.screenTracks ||
    [makeTrack('video'), makeTrack('audio')];
  const scrStream = makeStream(scrTracks);
  const instances = [];
  class FakeMR {
    constructor(stream, mrOpts) {
      this.stream = stream;
      this.mimeType = mrOpts ? mrOpts.mimeType : '';
      this.state = 'inactive';
      instances.push(this);
    }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
  }
  const mode = overrides.captureMode || 'tab';
  const route = (c) => {
    if (c.audio && !c.video) { return micStream; }
    if (c.video && !c.audio) { return camStream; }
    if (c.video && c.video.mandatory && c.video.mandatory.chromeMediaSource === 'tab') {
      return scrStream;
    }
    throw new Error('unexpected constraints in test route');
  };
  const mediaDevices = { getUserMedia: (c) => Promise.resolve(route(c)) };
  const sel = (state) => ({
    getState: () => Promise.resolve(state),
    recordDefault: () => Promise.resolve({ ok: true })
  });
  const puts = [];
  const db = { put: async (store, record) => { puts.push({ store, record }); } };
  const formatSupport = BS.createFormatSupport({
    mediaRecorder: { isTypeSupported: () => true },
    db,
    nowUtcIso: () => '2026-10-06T00:00:00.000Z'
  });
  let n = 0;
  const starter = BS.createStreamStarter({
    mediaDevices,
    getDisplayMedia: overrides.getDisplayMedia ||
      (() => Promise.resolve(scrStream)),
    MediaRecorder: FakeMR,
    micSelector: sel({ ok: true, selection: null }),
    cameraSelector: sel({ ok: true, selection: null }),
    captureSelector: sel({ ok: true, captureMode: mode }),
    broker: {
      resolveTargetTab: () => Promise.resolve({ ok: true, tabId: 42 }),
      getStreamId: () => Promise.resolve({ ok: true, streamId: 's-42' })
    },
    formatSupport,
    audioPolicy: overrides.audioPolicy === undefined ?
      BS.createAudioPolicy() : overrides.audioPolicy,
    getSessionId: () => SID,
    getGameId: () => GID,
    nowUtcIso: () => '2026-10-06T00:00:00.000Z',
    perfNowMs: () => 1000 + (n++),
    newUuidV4: () => SEGS[n % SEGS.length]
  });
  return { starter, puts, instances };
}

describe('AC4 — wired into the start pipeline', () => {
  it('tab mode: screen record gets tab-audio, mic gets device-only, webcam gets nulls', async () => {
    const w = makeWorld({ captureMode: 'tab' });
    const res = await w.starter.startStreams();
    assert.equal(res.ok, true);
    assert.equal(w.puts.length, 3);
    const byKind = {};
    for (const p of w.puts) { byKind[p.record.streamKind] = p.record; }
    assert.equal(byKind.screen.screenAudioContent, 'tab-audio');
    assert.equal(byKind.screen.micAudioContent, null);
    assert.equal(byKind.microphone.micAudioContent, 'device-only');
    assert.equal(byKind.microphone.screenAudioContent, null);
    assert.equal(byKind.webcam.screenAudioContent, null);
    assert.equal(byKind.webcam.micAudioContent, null);
    // The classifications ride the channel response (no new event).
    assert.equal(res.streams.screen.screenAudioContent, 'tab-audio');
    assert.equal(res.streams.microphone.micAudioContent, 'device-only');
    assert.equal(res.streams.webcam.screenAudioContent, null);
    assert.equal(res.streams.webcam.micAudioContent, null);
  });

  it('screen mode with an audio track: system-audio; video-only: none', async () => {
    const w = makeWorld({ captureMode: 'screen' });
    const res = await w.starter.startStreams();
    assert.equal(res.streams.screen.screenAudioContent, 'system-audio');
    const w2 = makeWorld({
      captureMode: 'screen',
      screenTracks: [makeTrack('video')]
    });
    const res2 = await w2.starter.startStreams();
    assert.equal(res2.streams.screen.screenAudioContent, 'none');
    assert.equal(res2.streams.screen.ok, true);
  });

  it('classification can never fail a stream: a throwing policy yields nulls, stream still starts', async () => {
    const throwing = {
      classifyScreenAudio() { throw new Error('policy bug'); },
      assertMicAudio() { throw new Error('policy bug'); }
    };
    const w = makeWorld({ captureMode: 'tab', audioPolicy: throwing });
    const res = await w.starter.startStreams();
    assert.equal(res.ok, true);
    assert.equal(res.streams.screen.ok, true);
    assert.equal(res.streams.screen.screenAudioContent, null);
    assert.equal(res.streams.microphone.micAudioContent, null);
    assert.equal(w.puts.length, 3);
  });

  it('failure isolation across the five 4.6 stages is unchanged', async () => {
    // A mic acquisition failure must not block screen/webcam, and the
    // failed stream writes no manifest record (4.6 behavior, re-pinned
    // with the 4.7 wiring in place).
    const w = makeWorld({ captureMode: 'tab' });
    const badMic = {
      getState: () => Promise.reject(new Error('mic denied')),
      recordDefault: () => Promise.resolve({ ok: true })
    };
    const puts = [];
    const db = { put: async (store, record) => { puts.push({ store, record }); } };
    const formatSupport = BS.createFormatSupport({
      mediaRecorder: { isTypeSupported: () => true },
      db,
      nowUtcIso: () => '2026-10-06T00:00:00.000Z'
    });
    let n = 0;
    const micStream = makeStream([makeTrack('audio')]);
    const camStream = makeStream([makeTrack('video')]);
    const scrStream = makeStream([makeTrack('video'), makeTrack('audio')]);
    const instances = [];
    class FakeMR {
      constructor(stream, mrOpts) {
        this.stream = stream; this.mimeType = mrOpts.mimeType;
        this.state = 'inactive'; instances.push(this);
      }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; }
    }
    const starter = BS.createStreamStarter({
      mediaDevices: {
        getUserMedia: (c) => {
          if (c.audio && !c.video) { return Promise.reject(new Error('mic denied')); }
          if (c.video && !c.audio) { return Promise.resolve(camStream); }
          return Promise.resolve(scrStream);
        }
      },
      getDisplayMedia: () => Promise.reject(new Error('unused')),
      MediaRecorder: FakeMR,
      micSelector: badMic,
      cameraSelector: { getState: () => Promise.resolve({ ok: true, selection: null }), recordDefault: () => Promise.resolve({ ok: true }) },
      captureSelector: { getState: () => Promise.resolve({ ok: true, captureMode: 'tab' }) },
      broker: {
        resolveTargetTab: () => Promise.resolve({ ok: true, tabId: 42 }),
        getStreamId: () => Promise.resolve({ ok: true, streamId: 's-42' })
      },
      formatSupport,
      audioPolicy: BS.createAudioPolicy(),
      getSessionId: () => SID,
      getGameId: () => GID,
      nowUtcIso: () => '2026-10-06T00:00:00.000Z',
      perfNowMs: () => 1000 + (n++),
      newUuidV4: () => SEGS[n % SEGS.length]
    });
    const res = await starter.startStreams();
    assert.equal(res.streams.microphone.ok, false);
    assert.equal(res.streams.screen.ok, true);
    assert.equal(res.streams.webcam.ok, true);
    assert.equal(puts.length, 2, 'no manifest record for the failed mic stream');
    assert.equal(res.streams.screen.screenAudioContent, 'tab-audio');
  });
});

// ------------------------------------------------------------------
// AC5 — no new event types; no new channel message.
// ------------------------------------------------------------------

describe('AC5 — no new event types; no new channel message', () => {
  it('recorder.js MSG_* vocabulary gains exactly the deliberate 4.13 stop-streams + 4.14 get-status messages', () => {
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

  it('event-name vocabulary is unchanged (no new event types)', () => {
    const names = new Set();
    for (const f of fs.readdirSync(REPO).filter((f) => f.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(REPO, f), 'utf8');
      const re = /'([a-z_]+_(permission_)?changed|[a-z_]+_(device_)?selected)'/g;
      let m;
      while ((m = re.exec(src)) !== null) { names.add(m[1]); }
    }
    assert.deepEqual(Array.from(names).sort(), [
      'camera_device_selected',
      'camera_permission_changed',
      'conditions_changed',
      'document_visibility_changed',
      'microphone_device_selected',
      'microphone_permission_changed',
      'piece_visibility_changed',
      // Honest cumulative evolution: 4.9 deliberately adds
      // 'recorder_track_state_changed' (its other two event types,
      // 'recorder_error' and 'stream_discontinuity', do not match this
      // scan's regex — they are pinned in tests/track_monitor.test.js
      // AC5 instead).
      'recorder_track_state_changed',
      'screen_capture_permission_changed',
      'screen_capture_selected'
    ]);
  });
});

// ------------------------------------------------------------------
// AC6 — documentation is durable (DECISIONS.md).
// ------------------------------------------------------------------

describe('AC6 — documentation is durable', () => {
  it('DECISIONS.md carries a ## 4.7 section with the required content', () => {
    const md = fs.readFileSync(path.join(REPO, '.autodev/DECISIONS.md'), 'utf8');
    assert.ok(md.includes('## 4.7'), 'missing ## 4.7 section');
    const section = md.slice(md.indexOf('## 4.7'));
    // The mode×content matrix (§1.1).
    assert.ok(/tab-audio/.test(section) && /system-audio/.test(section),
      'mode×content matrix missing');
    // The speechSynthesis routing fact (§1.3).
    assert.ok(/speechSynthesis/.test(section),
      'speechSynthesis routing fact missing');
    // The acoustic-bleed reality (§1.4).
    assert.ok(/bleed/i.test(section), 'acoustic bleed missing');
    // The loopback-device caveat (§1.4).
    assert.ok(/loopback/i.test(section), 'loopback-device caveat missing');
  });
});

// ------------------------------------------------------------------
// AC7 — changed-files discipline.
// ------------------------------------------------------------------

describe('AC7 — changed-files discipline', () => {
  it('git status shows only 4.7-allowed changes', () => {
    const status = execSync('git status --porcelain', { cwd: REPO }).toString();
    const changed = status.split('\n').filter((l) => l.trim())
      .map((l) => l.slice(3).trim());
    const allowed = new Set([
      // Honest cumulative evolution: 4.7 (audio-content policy)
      // legitimately adds audio_policy.js, wires the classifications
      // into stream_starter.js's manifest-write stage, widens
      // format_support.js's manifest validator 13 → 15, loads the new
      // module in recorder.html, resolves it in recorder.js, and adds
      // its test + evidence; its files join the allowlists.
      'audio_policy.js',
      'stream_starter.js',
      'format_support.js',
      'recorder.js',
      'recorder.html',
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
      'tests/capture_selection.test.js',
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
      assert.ok(!changed.includes(f), `${f} must be untouched by 4.7`);
    }
  });

  it('PLAN.md unmodified', () => {
    const diff = execSync('git diff HEAD -- PLAN.md', { cwd: REPO }).toString();
    assert.strictEqual(diff, '', 'PLAN.md must not change');
  });
});

// ------------------------------------------------------------------
// AC8 — no content inference.
// ------------------------------------------------------------------

describe('AC8 — no content inference', () => {
  it('no audio analysis or content claims in code', () => {
    for (const f of ['audio_policy.js', 'stream_starter.js',
      'format_support.js', 'recorder.js']) {
      const code = codeOnly(f);
      assert.ok(!/AnalyserNode/.test(code), `${f}: no AnalyserNode`);
      assert.ok(!/getByteFrequencyData/.test(code),
        `${f}: no frequency analysis`);
      assert.ok(!/getByteTimeDomainData/.test(code),
        `${f}: no time-domain analysis`);
    }
  });

  it('no "utterance was recorded" claims in evidence or code', () => {
    for (const f of ['audio_policy.js',
      '.autodev/evidence/4.7.contract.md',
      '.autodev/evidence/4.7.build.md']) {
      let text = fs.readFileSync(path.join(REPO, f), 'utf8');
      // The contract and code document the PROHIBITION with the generic
      // placeholder phrase "utterance X was recorded" — exempt exactly
      // that placeholder; any other utterance-captured claim fails.
      text = text.replace(/["']utterance X was recorded["']/gi, '');
      assert.ok(!/utterance[^.?!]{0,80}was (recorded|captured)/i.test(text),
        `${f}: no utterance-captured claim`);
    }
  });

  it('the strongest content claim is the by-construction classification', () => {
    // The only content-shaped strings 4.7 may produce are the
    // classification vocabulary values — pinned here so a future
    // "detected"/"heard"/"contains" claim would fail loudly.
    const code = codeOnly('audio_policy.js');
    for (const w of ['detected', 'heard', 'contains game']) {
      assert.ok(!new RegExp(w, 'i').test(code),
        `audio_policy.js must not claim: ${w}`);
    }
  });
});
