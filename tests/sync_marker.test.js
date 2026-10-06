// tests/sync_marker.test.js
//
// V1 verification for task 4.11 (PLAN.md §4.11) per
// .autodev/evidence/4.11.contract.md. Covers acceptance criteria AC1–AC8
// (static/unit). AC9–AC10 (real Chrome) run separately via
// ~/workspace/tools/ext-verify/sw-sync-marker.js; AC11 (real-device
// marker reality) is deferred to owner verification (§7).
//
// 4.11 inserts one synchronization marker per recording generation at
// start AND at stop: an audible beep (offscreen document,
// HTMLAudioElement only — never a mixer) and a visible flash
// (sync_flash.js content script). Each modality emission is a
// `sync_marker` event sharing one markerId; the envelope's
// monotonicMs + clockSegmentId ARE the source timestamps. 4.11 builds
// the mechanism, wires the START marker, and defines the
// emitStopMarker() seam 4.13 must call before recorder.stop().
//
// Run: node --test tests/sync_marker.test.js   (from repo root)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BS_SM = require(path.join(REPO, 'sync_marker.js'));
const BS_SF = require(path.join(REPO, 'sync_flash.js'));
const BS_ENV = require(path.join(REPO, 'event_envelope.js'));
const BS_FMT = require(path.join(REPO, 'format_support.js'));
const BS_DB = require(path.join(REPO, 'db.js'));
const BS_TM = require(path.join(REPO, 'track_monitor.js'));
const BS_CW = require(path.join(REPO, 'chunk_writer.js'));
const BS_STR = require(path.join(REPO, 'stream_starter.js'));
const BS_REC = require(path.join(REPO, 'recorder.js'));
const BS_RH = require(path.join(REPO, 'recording_host.js'));
const BS_CB = require(path.join(REPO, 'capture_broker.js'));

// The Node test harness publishes the merged namespace on
// globalThis (sender.js precedent): recorder.js resolves
// createSyncMarker / createTrackMonitor / createChunkWriter /
// createStreamStarter the same way (the lazy getters check factory
// availability before the o.* injection, so every factory module must
// be present — the track_monitor.test.js precedent).
const BS = Object.assign({}, BS_ENV, BS_SM, BS_SF, BS_FMT, BS_DB, BS_TM,
  BS_CW, BS_STR, BS_REC, BS_RH, BS_CB);
globalThis.BlindfoldSession = BS;

const SID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const GID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const MID = 'cccccccc-3333-4333-8333-cccccccccccc';

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

// Minimal WAV parser (RIFF/PCM16) for the beep-asset spec pin.
function readWavSpec(file) {
  const buf = fs.readFileSync(path.join(REPO, file));
  assert.equal(buf.slice(0, 4).toString('ascii'), 'RIFF');
  assert.equal(buf.slice(8, 12).toString('ascii'), 'WAVE');
  assert.equal(buf.slice(12, 16).toString('ascii'), 'fmt ');
  const audioFormat = buf.readUInt16LE(20);
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  // data chunk: scan subchunks from 36
  let off = 36;
  let dataOff = -1, dataLen = -1;
  while (off + 8 <= buf.length) {
    const id = buf.slice(off, off + 4).toString('ascii');
    const len = buf.readUInt32LE(off + 4);
    if (id === 'data') { dataOff = off + 8; dataLen = len; break; }
    off += 8 + len;
  }
  const n = dataLen / 2;
  const samples = new Array(n);
  for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(dataOff + i * 2);
  return { audioFormat, channels, sampleRate, bits, n, samples };
}

// Fake audio element factory for the marker module.
function makeAudioFactory(hooks) {
  hooks = hooks || {};
  const plays = [];
  return {
    plays,
    factory: (url) => {
      const el = {
        url,
        playCalls: 0,
        play: () => {
          el.playCalls++;
          plays.push(url);
          if (hooks.rejectPlay) {
            return Promise.reject(new Error(hooks.rejectPlay));
          }
          if (hooks.throwPlay) {
            throw new Error(hooks.throwPlay);
          }
          return Promise.resolve();
        }
      };
      return el;
    }
  };
}

function makeMarkerDeps(overrides) {
  overrides = overrides || {};
  const emitted = [];
  const relays = [];
  const audio = makeAudioFactory(overrides.audioHooks);
  const timeouts = [];
  return {
    emitted,
    relays,
    audio,
    timeouts,
    deps: {
      emitEvent: (eventType, payload, refs) => {
        emitted.push({ eventType, payload, refs });
        return { eventId: 'e' + emitted.length };
      },
      getSessionId: () => SID,
      sendRelayMessage: (fields) => {
        relays.push(fields);
        if (overrides.relay) return Promise.resolve(overrides.relay);
        return Promise.resolve({ ok: true, relayed: true });
      },
      audioFactory: overrides.audioFactory || audio.factory,
      assetUrl: 'chrome-extension://fake/sync_beep.wav',
      setTimeoutFn: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
      newUuidV4: (() => {
        let n = 0;
        return () => {
          n++;
          const hex = n.toString(16).padStart(12, '0');
          return `dddddddd-4444-4444-8444-${hex}`;
        };
      })()
    }
  };
}

const flushMicrotasks = () => new Promise((r) => setImmediate(r));

// ------------------------------------------------------------------
// AC1 — audible marker correct.
// ------------------------------------------------------------------

describe('AC1 — audible marker correct', () => {
  it('sync_beep.wav exists with the §2 spec (880 Hz, 250 ms, 44.1 kHz, 16-bit mono, faded)', () => {
    const spec = readWavSpec('sync_beep.wav');
    assert.equal(spec.audioFormat, 1, 'PCM');
    assert.equal(spec.channels, 1, 'mono');
    assert.equal(spec.sampleRate, 44100, '44.1 kHz');
    assert.equal(spec.bits, 16, '16-bit');
    assert.equal(spec.n, 11025, '250 ms at 44.1 kHz');
    // 880 Hz → 220 cycles → 440 zero crossings.
    let crossings = 0;
    for (let i = 1; i < spec.n; i++) {
      if ((spec.samples[i - 1] < 0) !== (spec.samples[i] < 0)) crossings++;
    }
    assert.equal(crossings, 440, '880 Hz sine');
    // 10 ms raised-cosine fade: edges at ~0, peak at 0.8 full-scale.
    assert.equal(spec.samples[0], 0, 'fade-in starts at 0');
    assert.equal(spec.samples[spec.n - 1], 0, 'fade-out ends at 0');
    const peak = Math.max(...spec.samples.map(Math.abs));
    assert.ok(Math.abs(peak - 26213) <= 2, `peak ~0.8*32767, got ${peak}`);
  });

  it('no Web Audio graph in the offscreen scripts (4.7 pin passes UNMODIFIED)', () => {
    const files = ['sync_marker.js', 'audio_policy.js', 'stream_starter.js',
      'recorder.js', 'device_selection.js', 'capture_selection.js',
      'format_support.js', 'recording_host.js'];
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

  it('tone playback uses HTMLAudioElement only, in the offscreen document', () => {
    // sync_marker.js never constructs audio itself — the factory is
    // injected (testability + the no-direct-platform-API rule).
    const code = codeOnly('sync_marker.js');
    assert.ok(!/new\s+Audio\s*\(/.test(code),
      'sync_marker.js must not construct Audio directly');
    // recorder.js (the offscreen document) builds the element from the
    // global Audio constructor and the packaged asset URL.
    const rec = codeOnly('recorder.js');
    assert.ok(rec.includes("getURL('sync_beep.wav')"),
      'recorder.js resolves the packaged sync_beep.wav');
    assert.ok(/g\.Audio|globalThis[\s\S]{0,40}Audio/.test(rec) ||
             rec.includes('ACtor'),
      'recorder.js builds the element from the Audio constructor');
  });

  it('start = 1 beep; stop = 2 beeps 150 ms apart', () => {
    const t = makeMarkerDeps();
    const m = BS.createSyncMarker(t.deps);
    m.emitStartMarker();
    assert.equal(t.audio.plays.length, 1, 'start plays exactly one beep');
    assert.equal(t.timeouts.length, 0, 'start schedules no second beep');

    const t2 = makeMarkerDeps();
    const m2 = BS.createSyncMarker(t2.deps);
    m2.emitStopMarker();
    assert.equal(t2.audio.plays.length, 1, 'stop plays the first beep now');
    assert.equal(t2.timeouts.length, 1, 'stop schedules the second beep');
    assert.equal(t2.timeouts[0].ms, 150, 'onset-to-onset gap is 150 ms');
    t2.timeouts[0].fn();
    assert.equal(t2.audio.plays.length, 2, 'second beep plays after the gap');
  });

  it('stop-beep gap and asset name are pinned constants', () => {
    assert.equal(BS.SYNC_STOP_BEEP_GAP_MS, 150);
    assert.equal(BS.SYNC_BEEP_ASSET, 'sync_beep.wav');
  });
});

// ------------------------------------------------------------------
// AC2 — visible marker correct.
// ------------------------------------------------------------------

describe('AC2 — visible marker correct', () => {
  it('manifest content_scripts gains sync_flash.js; content.js byte-identical', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
    const js = manifest.content_scripts[0].js;
    assert.ok(js.includes('sync_flash.js'), 'sync_flash.js is registered');
    assert.ok(js.includes('content.js'), 'content.js still registered');
    // Deliberate delta: exactly one file added to the list — while the
    // change is uncommitted. Post-commit the 4.11 delta is IN HEAD, so
    // the delta check is conditional (4.5 SF-1 precedent); the
    // registration + byte-identical assertions above pin the state
    // durably either way.
    // Honest cumulative evolution (5.2): 5.2 legitimately adds
    // session_fields.js to the js list and restructures the install
    // block (the fields handle is installed after the controls) —
    // the delta check admits the 5.2 addition too. (5.1's and 5.2's
    // additions are committed, so the uncommitted delta is the 5.3
    // addition.)
    const head = execSync('git show HEAD:manifest.json', { cwd: REPO }).toString();
    const headJs = JSON.parse(head).content_scripts[0].js;
    const added = js.filter((f) => headJs.indexOf(f) === -1);
    // Honest cumulative evolution: 5.3's selection_memory.js is committed,
    // so the uncommitted delta is now 5.4's. 5.4 adds detected_conditions.js
    // (the 5.4 detected-conditions panel) to the content_scripts list per
    // its contract.
    // Honest cumulative evolution (5.5): 5.4's addition is committed (in
    // HEAD), and 5.5 adds no manifest entries (no new content scripts —
    // the guard lives in recorder.js, the pre-check in session_controls.js,
    // both already registered), so the uncommitted js-list delta is empty.
    assert.deepEqual(added, [],
      'uncommitted js-list delta must be empty (5.5 adds no manifest entries)');
    const diff = execSync('git diff HEAD -- content.js', { cwd: REPO }).toString();
    if (diff.trim() !== '') {
      // 5.1/5.2/5.3 are committed, so the uncommitted content.js delta
      // is 5.4's panel wiring only: the installConditionsPanel install,
      // the getDetectedConditions plug-in pass-through, and the
      // attachConditionsPanel composite wrap. The detailed line-level
      // pin lives in tests/session_controls.test.js AC7; here we only
      // require the 5.2/5.4 wiring to still reference the fields
      // install and no gameplay identifiers to appear in added lines.
      //
      // Honest cumulative evolution (5.9): 5.9's delta is in the
      // tracker section (createGameHistoryTracker factory,
      // handleGameResetEvent, let bindings) — it does not touch the
      // install wiring, so the installSessionFields/installConditionsPanel
      // assertions are vacuous for a pure-5.9 delta. We assert the
      // 5.9 keywords instead when the delta carries them.
      const is59Delta = diff.includes('createGameHistoryTracker') ||
        diff.includes('handleGameResetEvent');
      if (!is59Delta) {
        assert.ok(diff.includes('installSessionFields'),
          'content.js delta must keep the 5.2 fields install wiring');
        assert.ok(diff.includes('installConditionsPanel'),
          'content.js delta must include the 5.4 panel install');
      } else {
        assert.ok(diff.includes('handleGameReset'),
          'content.js 5.9 delta must wire the handleGameReset call');
      }
      const added = diff.split('\n').filter((l) => l.startsWith('+'));
      assert.ok(!/move_input|piece_set|chess\.move/i.test(added.join('\n')),
        'content.js delta must not touch gameplay');
    }
  });

  it('flash matches the §3 spec (white, ~200 ms, non-interactive, removed)', () => {
    const code = codeOnly('sync_flash.js');
    assert.ok(/background.*#fff/.test(code), 'white flash');
    assert.ok(/pointerEvents.*none/.test(code), 'pointer-events: none');
    assert.ok(/aria-hidden/.test(code), 'aria-hidden="true"');
    assert.ok(/2147483647/.test(code), 'z-index 2147483647');
    assert.ok(/removeChild/.test(code), 'removed from the DOM after');
    // ~200 ms: 60 ms in + 80 ms hold + 60 ms out.
    assert.ok(/FLASH_IN_MS = 60/.test(code), 'fade-in 60 ms');
    assert.ok(/FLASH_HOLD_MS = 80/.test(code), 'hold 80 ms');
    assert.ok(/FLASH_OUT_MS = 60/.test(code), 'fade-out 60 ms');
  });

  it('the flash cannot steal focus or intercept input', () => {
    const code = codeOnly('sync_flash.js');
    assert.ok(!/\.focus\s*\(/.test(code), 'no focus() calls');
    // The only addEventListener in the file is the chrome.runtime
    // listener installed once at load; the overlay element itself
    // gets no listeners.
    const overlayBlock = code.slice(code.indexOf('function showFlash'));
    assert.ok(!/el\.addEventListener/.test(overlayBlock),
      'no listeners on the overlay element');
    assert.ok(!/tabindex/i.test(code), 'no tabindex');
  });

  it('sync_flash.js listens for blindfold-sync-flash and emits synchronously with the flash', () => {
    const code = codeOnly('sync_flash.js');
    assert.ok(code.includes("message.kind !== 'blindfold-sync-flash'") ||
             code.includes('message.kind !== FLASH_MESSAGE_KIND'),
      'ignores other message kinds');
    // Malformed relay payloads are ignored (lenient-on-input).
    const order = code.indexOf('showFlash()');
    const emitAt = code.indexOf('emitVisibleEvent(message, shown)');
    assert.ok(order !== -1 && emitAt !== -1 && order < emitAt,
      'flash displays before the visible event is emitted');
    assert.ok(/phase !== 'start' && message\.phase !== 'stop'/.test(code) ||
             /phase !== 'start'/.test(code),
      'malformed phase ignored');
  });
});

// ------------------------------------------------------------------
// AC3 — event shape exact.
// ------------------------------------------------------------------

describe('AC3 — event shape exact', () => {
  it('SYNC_MARKER_EVENT_TYPE is defined once in sync_marker.js (1.3 convention)', () => {
    assert.equal(BS.SYNC_MARKER_EVENT_TYPE, 'sync_marker');
    const code = codeOnly('sync_marker.js');
    const defs = code.match(/var SYNC_MARKER_EVENT_TYPE =/g) || [];
    assert.equal(defs.length, 1, 'defined exactly once');
    assert.ok(/^[a-z][a-z0-9_]{0,63}$/.test(BS.SYNC_MARKER_EVENT_TYPE),
      'flat snake_case per EVENT_TYPE_RE');
  });

  it("sync_flash.js's literal agrees with the canonical constant", () => {
    const code = codeOnly('sync_flash.js');
    assert.ok(code.includes("'sync_marker'"), 'pinned literal present');
    assert.equal(BS.SYNC_MARKER_EVENT_TYPE, 'sync_marker');
  });

  it('payload is exactly {markerId, phase, modality, status, error, detail}', () => {
    assert.deepEqual(Array.from(BS.SYNC_MARKER_PAYLOAD_KEYS).sort(),
      ['detail', 'error', 'markerId', 'modality', 'phase', 'status']);
    const good = {
      markerId: MID, phase: 'stop', modality: 'visible',
      status: 'shown', error: null, detail: null
    };
    assert.deepEqual(BS.createSyncMarkerPayload(good), good);
    assert.throws(() => BS.createSyncMarkerPayload({ ...good, extra: 1 }), TypeError);
    assert.throws(() => BS.createSyncMarkerPayload({ ...good, phase: 'middle' }), RangeError);
    assert.throws(() => BS.createSyncMarkerPayload({ ...good, status: 'maybe' }), RangeError);
    assert.throws(() => BS.createSyncMarkerPayload({ ...good, markerId: 'x' }), TypeError);
    assert.throws(() => BS.createSyncMarkerPayload({ ...good, modality: 'olfactory' }), RangeError);
  });

  it('one markerId is shared across the two modalities of one phase', async () => {
    const t = makeMarkerDeps();
    const m = BS.createSyncMarker(t.deps);
    const markerId = m.emitStartMarker();
    await flushMicrotasks();
    const audible = t.emitted.filter((e) => e.payload.modality === 'audible');
    assert.equal(audible.length, 1, 'one audible event at start');
    assert.equal(audible[0].payload.markerId, markerId);
    assert.equal(audible[0].payload.phase, 'start');
    assert.equal(audible[0].payload.status, 'played');
    assert.deepEqual(audible[0].refs, { sessionId: SID });

    // The visible half: drive the content-script listener with the
    // relayed markerId and assert the shared markerId lands on the
    // visible event.
    const seen = [];
    const savedSender = BS.sender;
    BS.sender = {
      emit: (input) => { seen.push(input); return { eventId: 'v1' }; }
    };
    const savedDoc = globalThis.document;
    const appended = [];
    globalThis.document = {
      body: {
        appendChild: (el) => { appended.push(el); el.parentNode = { removeChild: () => {} }; }
      },
      createElement: () => ({
        attrs: {},
        style: {},
        parentNode: null,
        setAttribute(k, v) { this.attrs[k] = v; },
        offsetWidth: 10
      })
    };
    try {
      BS.syncFlashListener({
        kind: 'blindfold-sync-flash',
        markerId,
        phase: 'start',
        sessionId: SID
      });
    } finally {
      BS.sender = savedSender;
      if (savedDoc === undefined) delete globalThis.document;
      else globalThis.document = savedDoc;
    }
    assert.equal(appended.length, 1, 'flash overlay inserted');
    assert.equal(appended[0].style.zIndex, '2147483647');
    assert.equal(seen.length, 1, 'one visible event emitted');
    assert.equal(seen[0].eventType, 'sync_marker');
    assert.equal(seen[0].payload.markerId, markerId, 'markerId shared');
    assert.equal(seen[0].payload.modality, 'visible');
    assert.equal(seen[0].payload.status, 'shown');
    assert.deepEqual(seen[0].refs, { sessionId: SID });
    assert.equal(seen[0].gameId, null, 'session-scoped (gameId null)');
  });

  it('audible emission is synchronous with the play() call (no await between)', () => {
    const code = codeOnly('sync_marker.js');
    const playedAt = code.indexOf("status: 'played'");
    const thenAt = code.indexOf('pr.then');
    assert.ok(playedAt !== -1 && thenAt !== -1 && playedAt < thenAt,
      'the played event is emitted before any promise handling');
    assert.ok(!/await/.test(code), 'no await in the marker module');
  });
});

// ------------------------------------------------------------------
// AC4 — sequencing.
// ------------------------------------------------------------------

describe('AC4 — sequencing', () => {
  function makeStartHarness(streams, markerImpl) {
    const fakeRecs = {};
    for (const k of Object.keys(streams)) {
      if (streams[k].ok) fakeRecs[k] = { state: 'recording', requestData() {} };
    }
    const fakeStarter = {
      startStreams: () => Promise.resolve({ ok: true, streams }),
      getActiveStreams: () => {
        const m = {};
        for (const k of Object.keys(fakeRecs)) {
          m[k] = { segmentId: 'seg-' + k, recorder: fakeRecs[k], stream: {} };
        }
        return m;
      }
    };
    const rec = BS_REC.createOffscreenRecorder({
      streamStarter: fakeStarter,
      chunkWriter: { startForStream: () => ({ ok: true }) },
      trackMonitor: {
        attachStream: () => {},
        onChunkTerminalState: () => {}
      },
      syncMarker: markerImpl || null
    });
    return rec;
  }

  async function driveStart(rec) {
    return new Promise((resolve) => {
      const r = rec.onRuntimeMessage(
        { kind: 'recorder', v: 1, msg: 'recorder-start-streams' }, {}, resolve);
      if (r === false) resolve(undefined);
    });
  }

  it('recorder.js exposes getSyncMarker (lazy; injectable; wiring-defect → Error)', () => {
    const rec = BS_REC.createOffscreenRecorder({});
    assert.equal(typeof rec.getSyncMarker, 'function');
    const fake = { emitStartMarker() {}, emitStopMarker() {} };
    const rec2 = BS_REC.createOffscreenRecorder({ syncMarker: fake });
    assert.equal(rec2.getSyncMarker(), fake);
    const BS2 = Object.assign({}, BS_ENV, BS_REC);
    const saved = globalThis.BlindfoldSession;
    globalThis.BlindfoldSession = BS2; // no createSyncMarker
    try {
      const rec3 = BS_REC.createOffscreenRecorder({});
      assert.throws(() => rec3.getSyncMarker(), Error);
    } finally {
      globalThis.BlindfoldSession = saved;
    }
  });

  it('start marker fires iff ≥1 stream started successfully', async () => {
    let calls = 0;
    const rec = makeStartHarness({
      microphone: { ok: true, segmentId: 's1' },
      screen: { ok: false, error: 'nope', stage: 'acquire-stream' },
      webcam: { ok: true, segmentId: 's3' }
    }, { emitStartMarker: () => { calls++; }, emitStopMarker: () => {} });
    const resp = await driveStart(rec);
    assert.equal(resp.streams.microphone.ok, true);
    assert.equal(calls, 1, 'marker fired once for a partial start');
  });

  it('zero started streams → no marker at all', async () => {
    let calls = 0;
    const rec = makeStartHarness({
      microphone: { ok: false, error: 'x', stage: 'acquire-stream' },
      screen: { ok: false, error: 'y', stage: 'acquire-stream' },
      webcam: { ok: false, error: 'z', stage: 'acquire-stream' }
    }, { emitStartMarker: () => { calls++; }, emitStopMarker: () => {} });
    await driveStart(rec);
    assert.equal(calls, 0, 'no marker when nothing started');
  });

  it('a throwing marker cannot fail the channel response (best-effort)', async () => {
    const rec = makeStartHarness({
      microphone: { ok: true, segmentId: 's1' },
      screen: { ok: true, segmentId: 's2' },
      webcam: { ok: true, segmentId: 's3' }
    }, { emitStartMarker: () => { throw new Error('marker broke'); }, emitStopMarker: () => {} });
    const resp = await driveStart(rec);
    assert.equal(resp.ok, true, 'response survives a throwing marker');
  });

  it('per-generation fresh markerIds', () => {
    const t = makeMarkerDeps();
    const m = BS.createSyncMarker(t.deps);
    const a = m.emitStartMarker();
    const b = m.emitStartMarker();
    assert.notEqual(a, b, 'each generation mints a fresh markerId');
  });

  it('emitStopMarker seam exists and is NOT yet wired (4.13’s obligation)', () => {
    const t = makeMarkerDeps();
    const m = BS.createSyncMarker(t.deps);
    assert.equal(typeof m.emitStopMarker, 'function');
    // The seam is defined and exposed for 4.13; nothing in 4.11 calls
    // it (auditor check, not a defect — contract §4).
    const code = codeOnly('recorder.js');
    const calls = code.match(/\.emitStopMarker\s*\(/g) || [];
    assert.equal(calls.length, 0, 'recorder.js must not call emitStopMarker yet');
    const raw = fs.readFileSync(path.join(REPO, 'recorder.js'), 'utf8');
    assert.ok(raw.includes('getSyncMarker().emitStopMarker()'),
      'the 4.13 call point is documented in recorder.js');
    const md = fs.readFileSync(path.join(REPO, '.autodev/DECISIONS.md'), 'utf8');
    assert.ok(md.includes('## 4.11'), '## 4.11 documents the stop seam');
  });
});

// ------------------------------------------------------------------
// AC5 — failure honesty.
// ------------------------------------------------------------------

describe('AC5 — failure honesty', () => {
  it("play() rejection → 'failed' event with the verbatim error (streams unaffected)", async () => {
    const t = makeMarkerDeps({ audioHooks: { rejectPlay: 'NotAllowedError: play() failed' } });
    const m = BS.createSyncMarker(t.deps);
    m.emitStartMarker();
    await flushMicrotasks();
    const failed = t.emitted.filter((e) => e.payload.status === 'failed');
    assert.equal(failed.length, 1, 'exactly one failed audible event');
    assert.equal(failed[0].payload.modality, 'audible');
    assert.equal(failed[0].payload.phase, 'start');
    assert.ok(failed[0].payload.error.includes('NotAllowedError'),
      'verbatim platform error preserved');
    assert.equal(failed[0].payload.detail, 'play-promise-rejected');
    // The marker module touches no stream/recorder — nothing to break.
    assert.ok(t.emitted.every((e) => e.eventType === 'sync_marker'));
  });

  it('synchronous audioFactory throw → single failed event', () => {
    const t = makeMarkerDeps({
      audioFactory: () => { throw new Error('no Audio here'); }
    });
    const m = BS.createSyncMarker(t.deps);
    m.emitStartMarker();
    const failed = t.emitted.filter((e) => e.payload.status === 'failed');
    assert.equal(failed.length, 1);
    assert.ok(failed[0].payload.error.includes('no Audio here'));
  });

  it('missing Audio constructor → failed with audio-unavailable', () => {
    const t = makeMarkerDeps({ audioFactory: () => null });
    const m = BS.createSyncMarker(t.deps);
    m.emitStartMarker();
    const failed = t.emitted.filter((e) => e.payload.status === 'failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].payload.error, 'audio-unavailable');
  });

  it("relay {relayed:false} → visible 'skipped' with the honest reason", async () => {
    const t = makeMarkerDeps({ relay: { ok: true, relayed: false, reason: 'no-target-tab' } });
    const m = BS.createSyncMarker(t.deps);
    m.emitStartMarker();
    await flushMicrotasks();
    const skipped = t.emitted.filter((e) =>
      e.payload.modality === 'visible' && e.payload.status === 'skipped');
    assert.equal(skipped.length, 1, 'exactly one skipped visible event');
    assert.equal(skipped[0].payload.detail, 'no-target-tab');
    assert.equal(skipped[0].payload.error, null);
  });

  it("relay rejection → visible 'skipped' with relay-rejected", async () => {
    const t = makeMarkerDeps();
    t.deps.sendRelayMessage = () => Promise.reject(new Error('boom'));
    const m = BS.createSyncMarker(t.deps);
    m.emitStartMarker();
    await flushMicrotasks();
    await flushMicrotasks();
    const skipped = t.emitted.filter((e) =>
      e.payload.modality === 'visible' && e.payload.status === 'skipped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].payload.detail, 'relay-rejected');
  });

  it('a throwing emitEvent never breaks the marker (never-fail-the-pipeline)', () => {
    const t = makeMarkerDeps();
    t.deps.emitEvent = () => { throw new Error('writer down'); };
    const m = BS.createSyncMarker(t.deps);
    assert.doesNotThrow(() => m.emitStartMarker());
    assert.doesNotThrow(() => m.emitStopMarker());
  });
});

// ------------------------------------------------------------------
// AC6 — vocabulary discipline.
// ------------------------------------------------------------------

describe('AC6 — vocabulary discipline', () => {
  it('MSG_* gains exactly one value per task: MSG_STOP_STREAMS=recorder-stop-streams (4.13), MSG_GET_STATUS=recorder-get-status (4.14)', () => {
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
      // Honest cumulative evolution: 4.11 deliberately adds the single
      // flash-relay message (contract §7).
      'MSG_SYNC_FLASH=recorder-sync-flash',
      // Honest cumulative evolution: 4.13 deliberately adds the single
      // stop-streams message (contract §7).
      'MSG_STOP_STREAMS=recorder-stop-streams',
      // Honest cumulative evolution: 4.14 deliberately adds the single
      // per-stream status query message (contract §3.2).
      'MSG_GET_STATUS=recorder-get-status'
    ]);
    assert.equal(BS.RECORDER_MSG_SYNC_FLASH, 'recorder-sync-flash');
    assert.equal(BS.RECORDER_MSG_STOP_STREAMS, 'recorder-stop-streams');
    assert.equal(BS.RECORDER_MSG_GET_STATUS, 'recorder-get-status');
  });

  function makeSwHost(tabsImpl, queryImpl) {
    const sent = [];
    const chromeNs = {
      runtime: { onMessage: { addListener: () => {} } },
      tabs: tabsImpl || {
        query: queryImpl || (() => Promise.resolve([])),
        sendMessage: (tabId, msg) => { sent.push({ tabId, msg }); return Promise.resolve(); }
      }
    };
    const host = BS.createRecordingHost(chromeNs, {});
    return { host, sent, chromeNs };
  }

  async function driveSw(host, message) {
    return new Promise((resolve) => {
      const r = host.onRuntimeMessage(message, {}, resolve);
      if (r === false) resolve(undefined);
    });
  }

  it('SW relays the flash to the broker-resolved tab', async () => {
    const { host, sent } = makeSwHost({
      query: () => Promise.resolve([{ id: 42, lastAccessed: 1 }]),
      sendMessage: (tabId, msg) => { sent.push({ tabId, msg }); return Promise.resolve(); }
    });
    const resp = await driveSw(host, {
      kind: 'recorder', v: 1, msg: 'recorder-sync-flash',
      markerId: MID, phase: 'start', sessionId: SID
    });
    assert.deepEqual(resp, { ok: true, relayed: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].tabId, 42);
    assert.deepEqual(sent[0].msg, {
      kind: 'blindfold-sync-flash',
      markerId: MID,
      phase: 'start',
      sessionId: SID
    });
  });

  it('SW reports no-target-tab honestly when no Chess.com tab exists', async () => {
    const { host, sent } = makeSwHost({
      query: () => Promise.resolve([]),
      sendMessage: () => { throw new Error('must not be called'); }
    });
    const resp = await driveSw(host, {
      kind: 'recorder', v: 1, msg: 'recorder-sync-flash',
      markerId: MID, phase: 'stop', sessionId: SID
    });
    assert.deepEqual(resp, { ok: true, relayed: false, reason: 'no-target-tab' });
    assert.equal(sent.length, 0, 'no send attempted');
  });

  it('SW reports send-failed honestly when tabs.sendMessage throws', async () => {
    const { host } = makeSwHost({
      query: () => Promise.resolve([{ id: 7, lastAccessed: 1 }]),
      sendMessage: () => Promise.reject(new Error('tab closed'))
    });
    const resp = await driveSw(host, {
      kind: 'recorder', v: 1, msg: 'recorder-sync-flash',
      markerId: MID, phase: 'start', sessionId: SID
    });
    assert.deepEqual(resp, { ok: true, relayed: false, reason: 'send-failed' });
  });

  it('content scripts other than sync_flash.js are byte-identical to HEAD', () => {
    // Honest cumulative evolution (5.1): content.js + chess_utils.js leave
    // this list — 5.1 legitimately wires the Start/Stop install into
    // content.js and adds the additive getLastObservedEnd getter to
    // chess_utils.js (pinned in tests/session_controls.test.js AC7).
    const names = execSync('git diff HEAD --name-only', { cwd: REPO })
      .toString().split('\n').filter((l) => l.trim());
    const contentScripts = ['sounds.js',
      'status_indicator.js', 'lifecycle.js', 'sender.js', 'event_envelope.js',
      'game_records.js', 'chess.min.js'];
    for (const f of contentScripts) {
      assert.ok(!names.includes(f), `${f} must be byte-identical to HEAD`);
    }
  });
});

// ------------------------------------------------------------------
// AC7 — no overreach.
// ------------------------------------------------------------------

describe('AC7 — no overreach', () => {
  it('manifest widening is exactly the deliberate 4.13 widening (16 → 18); DB_VERSION still 2', () => {
    // Honest cumulative evolution (4.13): MANIFEST_KEYS widens 16 → 18
    // with the 4.13-owned segmentNumber + finalizedAtUtc — the only
    // deliberate widening (contract §2). DB_VERSION stays 2.
    assert.equal(BS.MANIFEST_KEYS.length, 18);
    assert.equal(BS.DB.DB_VERSION, 2);
  });

  it('no timestamp arithmetic in the marker module (4.12’s territory)', () => {
    const code = codeOnly('sync_marker.js');
    assert.ok(!/monotonicMs/.test(code), 'no monotonicMs reads');
    assert.ok(!/utcEpochMs/.test(code), 'no utcEpochMs reads');
    assert.ok(!/deriveWallUtcMs/.test(code), 'no wall-clock derivation');
    assert.ok(!/Date\.now/.test(code), 'no Date.now');
    assert.ok(!/performance\.now/.test(code), 'no performance.now');
  });

  it('no marker detection in recordings (content analysis is forbidden)', () => {
    for (const f of ['sync_marker.js', 'sync_flash.js', 'recorder.js']) {
      const code = codeOnly(f);
      assert.ok(!/AnalyserNode/.test(code), `${f}: no AnalyserNode`);
    }
  });

  it('§6.3 consumption is named in the durable decision log', () => {
    const md = fs.readFileSync(path.join(REPO, '.autodev/DECISIONS.md'), 'utf8');
    assert.ok(md.includes('## 4.11'), '## 4.11 section present');
    const section = md.slice(md.indexOf('## 4.11'));
    assert.ok(/6\.3|media-sync/.test(section), '§6.3 consumption named');
    assert.ok(/4\.12/.test(section), '4.12 offset ownership named');
  });
});

// ------------------------------------------------------------------
// AC8 — changed-files discipline.
// ------------------------------------------------------------------

describe('AC8 — changed-files discipline', () => {
  it('git status shows only 4.11-allowed changes', () => {
    const status = execSync('git status --porcelain', { cwd: REPO }).toString();
    const changed = status.split('\n').filter((l) => l.trim())
      .map((l) => l.slice(3).trim());
    const allowed = new Set([
      // Honest cumulative evolution: 4.11 (audible/visible sync
      // markers) legitimately adds sync_marker.js (offscreen audible
      // marker + SW flash-relay request), sync_flash.js (content-script
      // visible flash), sync_beep.wav (880 Hz beep asset), wires the
      // start marker into recorder.js's start-streams final .then, adds
      // the SW flash-relay leg to recording_host.js
      // (handleSyncFlashRelay), the MSG_SYNC_FLASH vocabulary entry,
      // the script tag in recorder.html, the content script in
      // manifest.json, records the ## 4.11 decisions, and adds its
      // test + evidence; its files join the allowlists.
      'sync_marker.js',
      'sync_flash.js',
      'sync_beep.wav',
      'tests/sync_marker.test.js',
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
      'tests/track_monitor.test.js',
      'tests/timecode.test.js',
      'tests/visibility.test.js',
      'tests/writer.test.js',
      // 4.14 deliberately touches track_monitor.js (additive
      // getStreamHealth seam + health mirror) — not in 4.11's
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
    const stray = changed.filter((f) => !allowed.has(f));
    assert.deepEqual(stray, [],
      'working tree has non-4.11 changes:\n' + stray.join('\n'));
  });

  it('PLAN.md is unmodified', () => {
    const diff = execSync('git diff HEAD -- PLAN.md', { cwd: REPO }).toString();
    assert.equal(diff, '', 'PLAN.md must be unmodified');
  });
});
