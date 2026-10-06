// tests/exporter.test.js
//
// V1 verification for task 6.1 (PLAN.md §6.1) per
// .autodev/evidence/6.1.contract.md. Covers acceptance criteria AC1–AC6
// (static/unit). AC7–AC8 (real Chrome) run separately via
// ~/workspace/tools/ext-verify/sw-exporter.js; AC9 (real-device export)
// is deferred to owner verification (§7).
//
// 6.1 owns the *content* of metadata.json: a pure builder function
// (buildMetadataJson) over the session's stored records plus 5.10's
// stop verdict. No I/O, no IndexedDB reads, no ID minting. Raw-data
// discipline: values are copied or counted, never inferred.
//
// Run: node --test tests/exporter.test.js   (from repo root)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BS = require(path.join(REPO, 'exporter.js'));
globalThis.BlindfoldSession = BS;

// ------------------------------------------------------------------
// Fixtures.
// ------------------------------------------------------------------

const SID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const GID1 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const GID2 = 'cccccccc-3333-4333-8333-cccccccccccc';
const FEN1 = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function fixtureMetadata() {
  return {
    sessionId: SID,
    gameIds: [GID1, GID2],
    schemaVersion: '1.0.0',
    extensionVersion: '0.9.0-test',
    protocolVersion: null,
    sessionCategory: 'training'
  };
}

function fixtureConditions() {
  // Seven CONDITION_FIELDS, each {value, source} — mixed
  // observed/manual per 5.4's manual-vs-observed distinction.
  return {
    trainingApproach: { value: 'narrate candidate moves', source: 'manual' },
    verbalScaffolding: { value: null, source: 'manual' },
    botName: { value: 'Nelson', source: 'manual' },
    botDisplayedRating: { value: 1200, source: 'manual' },
    playerColor: { value: 'white', source: 'observed' },
    timeControl: { value: null, source: 'manual' },
    assistanceSettings: { value: null, source: 'manual' }
  };
}

function fixtureManifest() {
  // Three-kind manifest: mic has 2 segments (1 finalized), screen 1
  // (finalized), webcam 0 (explicit missing stream).
  return [
    { segmentId: 'seg-m1', sessionId: SID, gameId: GID1, streamKind: 'microphone',
      actualMimeType: 'audio/webm', segmentNumber: 1, finalizedAtUtc: '2026-10-06T20:00:00.000Z' },
    { segmentId: 'seg-m2', sessionId: SID, gameId: GID1, streamKind: 'microphone',
      actualMimeType: 'audio/webm', segmentNumber: null, finalizedAtUtc: null },
    { segmentId: 'seg-s1', sessionId: SID, gameId: GID1, streamKind: 'screen',
      actualMimeType: 'video/webm', segmentNumber: 1, finalizedAtUtc: '2026-10-06T20:00:00.000Z' }
  ];
}

function fixtureStopVerdict() {
  return {
    stopResp: {
      finalizedAtUtc: '2026-10-06T20:05:00.000Z',
      streams: {
        microphone: { ok: true, flushTimedOut: false },
        screen: { ok: true, flushTimedOut: true },
        webcam: { ok: false, error: 'start-failed' }
      }
    },
    flushResult: { delivered: 140, pending: 2 },
    verdict: 'complete-with-warnings',
    warnings: ['screen-flush-timed-out', '2-events-undelivered']
  };
}

function build(args) {
  return BS.buildMetadataJson(Object.assign({
    metadata: fixtureMetadata(),
    conditions: fixtureConditions(),
    manifestRecords: fixtureManifest(),
    stopVerdict: fixtureStopVerdict(),
    eventCount: 142,
    gameStartingFens: { [GID1]: FEN1, [GID2]: null },
    nowUtcIso: () => '2026-10-06T21:00:00.000Z'
  }, args));
}

// ------------------------------------------------------------------
// AC1 — golden shape.
// ------------------------------------------------------------------

describe('AC1 — golden metadata.json shape', () => {
  it('produces the exact §3 schema with stable key order', () => {
    const out = build({});
    const doc = JSON.parse(out);
    assert.deepEqual(Object.keys(doc), [
      'sessionId', 'gameIds', 'sessionCategory', 'versions', 'training',
      'initialConditions', 'gameStartingFen', 'completion',
      'mediaInventory', 'coverage', 'exportedAtUtc'
    ]);
    assert.equal(doc.sessionId, SID);
    assert.deepEqual(doc.gameIds, [GID1, GID2]);
    assert.equal(doc.sessionCategory, 'training');
    assert.deepEqual(doc.versions, {
      schemaVersion: '1.0.0',
      extensionVersion: '0.9.0-test',
      protocolVersion: null
    });
    assert.deepEqual(doc.training, {
      trainingApproach: 'narrate candidate moves',
      verbalScaffolding: null
    });
    // initialConditions verbatim (seven fields, sources preserved).
    assert.equal(Object.keys(doc.initialConditions).length, 7);
    assert.deepEqual(doc.initialConditions.playerColor,
      { value: 'white', source: 'observed' });
    assert.deepEqual(doc.initialConditions.trainingApproach,
      { value: 'narrate candidate moves', source: 'manual' });
    // gameStartingFen per gameId, null where unknown.
    assert.deepEqual(doc.gameStartingFen, { [GID1]: FEN1, [GID2]: null });
    // completion mapped from the 5.10 verdict, warnings verbatim.
    assert.equal(doc.completion.verdict, 'complete-with-warnings');
    assert.deepEqual(doc.completion.warnings,
      ['screen-flush-timed-out', '2-events-undelivered']);
    assert.equal(doc.completion.finalizedAtUtc, '2026-10-06T20:05:00.000Z');
    assert.equal(doc.completion.undeliveredEvents, 2);
    // media inventory: facts only, zero-segment kind explicit.
    assert.deepEqual(doc.mediaInventory.microphone,
      { segments: 2, finalized: 1, formats: ['audio/webm'] });
    assert.deepEqual(doc.mediaInventory.screen,
      { segments: 1, finalized: 1, formats: ['video/webm'] });
    assert.deepEqual(doc.mediaInventory.webcam,
      { segments: 0, finalized: 0, formats: [] });
    // coverage: counts, not metrics.
    assert.deepEqual(doc.coverage, { eventsStored: 142, gamesObserved: 2 });
    assert.equal(doc.exportedAtUtc, '2026-10-06T21:00:00.000Z');
  });

  it('is byte-stable: same inputs → identical bytes (2-space indent)', () => {
    const a = build({});
    const b = build({});
    assert.equal(a, b);
    assert.ok(a.indexOf('\n  "sessionId"') !== -1, 'pretty-printed with 2-space indent');
  });
});

// ------------------------------------------------------------------
// AC2 — null honesty.
// ------------------------------------------------------------------

describe('AC2 — null honesty on absent inputs', () => {
  it('absent conditions → initialConditions null and training nulls', () => {
    const doc = JSON.parse(build({ conditions: null }));
    assert.equal(doc.initialConditions, null);
    assert.deepEqual(doc.training,
      { trainingApproach: null, verbalScaffolding: null });
  });

  it('absent stopVerdict → completion unknown, never complete', () => {
    const doc = JSON.parse(build({ stopVerdict: null }));
    assert.equal(doc.completion.verdict, 'unknown');
    assert.deepEqual(doc.completion.warnings, []);
    assert.equal(doc.completion.note, 'stop-verdict-unavailable');
    assert.equal(doc.completion.finalizedAtUtc, null);
    assert.equal(doc.completion.undeliveredEvents, null);
  });

  it('clean stop verdict → complete with empty warnings', () => {
    const doc = JSON.parse(build({
      stopVerdict: {
        stopResp: { finalizedAtUtc: '2026-10-06T20:05:00.000Z', streams: {} },
        flushResult: { delivered: 142, pending: 0 },
        verdict: 'complete',
        warnings: []
      }
    }));
    assert.equal(doc.completion.verdict, 'complete');
    assert.deepEqual(doc.completion.warnings, []);
    assert.equal(doc.completion.undeliveredEvents, 0);
  });
});

// ------------------------------------------------------------------
// AC3 — no fabrication.
// ------------------------------------------------------------------

describe('AC3 — no fabrication', () => {
  it('zero manifest records → explicit zero-segment inventory', () => {
    const doc = JSON.parse(build({ manifestRecords: [] }));
    assert.deepEqual(doc.mediaInventory.microphone,
      { segments: 0, finalized: 0, formats: [] });
    assert.deepEqual(doc.mediaInventory.screen,
      { segments: 0, finalized: 0, formats: [] });
    assert.deepEqual(doc.mediaInventory.webcam,
      { segments: 0, finalized: 0, formats: [] });
  });

  it('unresolvable gameStartingFen → null per gameId, never synthesized', () => {
    const doc = JSON.parse(build({ gameStartingFens: undefined }));
    assert.deepEqual(doc.gameStartingFen, { [GID1]: null, [GID2]: null });
  });

  it('failed stop verdict → export refuses honestly (throws)', () => {
    assert.throws(() => build({
      stopVerdict: {
        stopResp: null, flushResult: null,
        verdict: 'failed', warnings: ['stop-failed:no-response']
      }
    }), /session-not-complete/);
  });
});

// ------------------------------------------------------------------
// AC4 — purity and strict input validation.
// ------------------------------------------------------------------

describe('AC4 — purity and strict validation', () => {
  it('throws TypeError on malformed input, never silently defaults', () => {
    assert.throws(() => BS.buildMetadataJson(null), TypeError);
    assert.throws(() => BS.buildMetadataJson({}), TypeError); // no metadata
    assert.throws(() => build({ metadata: null }), TypeError);
    assert.throws(() => build({
      metadata: Object.assign(fixtureMetadata(), { sessionId: 'not-a-uuid' })
    }), TypeError);
    assert.throws(() => build({ manifestRecords: undefined }), TypeError);
    assert.throws(() => build({ eventCount: -1 }), TypeError);
    assert.throws(() => build({ eventCount: 1.5 }), TypeError);
    assert.throws(() => build({
      stopVerdict: { verdict: 'bogus', warnings: [] }
    }), TypeError);
    assert.throws(() => build({
      conditions: { playerColor: { value: 'white', source: 'observed' } }
    }), TypeError); // partial conditions record
  });

  it('reads no clock except the labeled exportedAtUtc', () => {
    // Deterministic output given the injected clock: two builds with
    // different injected times differ ONLY in exportedAtUtc.
    const a = JSON.parse(build({ nowUtcIso: () => '2026-10-06T21:00:00.000Z' }));
    const b = JSON.parse(build({ nowUtcIso: () => '2026-10-06T22:00:00.000Z' }));
    delete a.exportedAtUtc;
    delete b.exportedAtUtc;
    assert.deepEqual(a, b);
  });

  it('does not mutate its inputs', () => {
    const metadata = fixtureMetadata();
    const manifest = fixtureManifest();
    const gameIdsBefore = metadata.gameIds.slice();
    build({ metadata, manifestRecords: manifest });
    assert.deepEqual(metadata.gameIds, gameIdsBefore);
    assert.equal(manifest.length, 3);
  });
});

// ------------------------------------------------------------------
// AC5 — multi-game flag.
// ------------------------------------------------------------------

describe('AC5 — multi-game sessions', () => {
  it('gameIds.length > 1 is preserved verbatim (shared-session flag is the array)', () => {
    const doc = JSON.parse(build({}));
    assert.equal(doc.gameIds.length, 2);
    assert.equal(doc.coverage.gamesObserved, 2);
    assert.ok(!('sharedSession' in doc), 'no invented flag field');
  });

  it('single-game session exports cleanly', () => {
    const doc = JSON.parse(build({
      metadata: Object.assign(fixtureMetadata(), { gameIds: [GID1] }),
      gameStartingFens: { [GID1]: FEN1 }
    }));
    assert.deepEqual(doc.gameIds, [GID1]);
    assert.deepEqual(doc.gameStartingFen, { [GID1]: FEN1 });
    assert.equal(doc.coverage.gamesObserved, 1);
  });
});

// ------------------------------------------------------------------
// AC6 — diff discipline.
// ------------------------------------------------------------------

describe('AC6 — diff discipline', () => {
  it('only 6.1 files appear in git status', () => {
    const status = execSync('git status --porcelain', { cwd: REPO }).toString();
    const changed = status.split('\n')
      .map((l) => l.slice(3).trim())
      .filter((f) => f !== '' && !/^\.autodev\/evidence\/5\.\d/.test(f));
    assert.deepEqual(changed.sort(), [
      // 6.1–6.6 were committed (7a23b3a, f3bb3dd, 27ef7a5, 4b2c6a1);
      // this pin now covers 6.7/6.8's working tree. 6.7 (repeatable
      // export) is verification-only (tests + docs, no product-code
      // changes); 6.8 (export documentation) adds EXPORT.md.
      '.autodev/DECISIONS.md',
      '.autodev/evidence/6.7.contract.md',
      '.autodev/evidence/6.7.build.md',
      '.autodev/evidence/6.8.contract.md',
      '.autodev/evidence/6.8.build.md',
      'EXPORT.md',
      'tests/exporter.test.js',
      ...[
        'tests/attempt_tracker.test.js',
        'tests/audio_policy.test.js',
        'tests/capture_selection.test.js',
        'tests/chunk_writer.test.js',
        'tests/clock_link.test.js',
        'tests/detected_conditions.test.js',
        'tests/device_selection.test.js',
        'tests/duplicate_start.test.js',
        'tests/finalizer.test.js',
        'tests/format_support.test.js',
        'tests/game_lifecycle.test.js',
        'tests/history_tracker.test.js',
        'tests/lifecycle.test.js',
        // 6.6's manifest_sw.test.js and db.test.js pin evolutions are
        // committed (4b2c6a1); they drop from the working-tree allowlist.
        // 6.6: sw.js pins in session_store/writer evolved for the
        // export-request listener IIFE (6.6's legitimate sw.js delta).
        'tests/session_store.test.js',
        'tests/writer.test.js',
        'tests/recording_host.test.js',
        'tests/retention.test.js',
        'tests/selection_memory.test.js',
        'tests/sender.test.js',
        'tests/session_controls.test.js',
        'tests/session_fields.test.js',
        'tests/speech.test.js',
        'tests/status_indicator.test.js',
        'tests/stream_starter.test.js',
        'tests/stream_status.test.js',
        'tests/sync_marker.test.js',
        'tests/timecode.test.js',
        'tests/track_monitor.test.js',
        'tests/visibility.test.js'
      ]
    ].sort());
  });

  it('exporter.js defines no new channel messages, event types, stores, or permissions', () => {
    const src = require('fs').readFileSync(
      path.join(REPO, 'exporter.js'), 'utf8');
    assert.ok(src.indexOf('sendMessage') === -1, 'no messaging');
    assert.ok(src.indexOf('indexedDB') === -1, 'no IndexedDB access');
    assert.ok(src.indexOf('EVENT_TYPE') === -1 ||
      src.indexOf('MOMENT_MARKER_EVENT_TYPE') !== -1,
      'no new event types');
    assert.ok(src.indexOf('chrome.') === -1, 'no chrome.* APIs');
  });

  it('PLAN.md is unmodified', () => {
    const diff = execSync('git diff HEAD -- PLAN.md', { cwd: REPO }).toString();
    assert.equal(diff.trim(), '');
  });
});

// ------------------------------------------------------------------
// 6.2 — events.jsonl (PLAN.md §6.2).
// ------------------------------------------------------------------
//
// Pure buildEventsJsonl({events}): one JSON.stringify per line in
// appendSeq ascending order. Verbatim passthrough — no added/removed/
// reordered keys, no computed metrics, no position filtering.

function fixtureEvent(appendSeq, overrides) {
  var base = {
    eventId: 'eeeeeeee-' + String(1000 + appendSeq).slice(1) +
      '-4' + String(appendSeq).padStart(3, '0') + '-8111-aaaaaaaaaaaa',
    eventType: 'move_confirmed',
    sessionId: SID,
    gameId: GID1,
    sourceContext: 'content',
    sourceSeq: appendSeq * 7,   // deliberately not correlated with appendSeq
    clockSegmentId: null,
    monotonicMs: 1000 + appendSeq * 13.7,  // deliberately not correlated
    appendSeq: appendSeq,
    refs: null,
    payload: { moveUci: 'e2e4' }
  };
  var k;
  for (k in overrides) {
    if (Object.prototype.hasOwnProperty.call(overrides, k)) {
      base[k] = overrides[k];
    }
  }
  return base;
}

describe('6.2 AC1 — appendSeq ordering', () => {
  it('exports in strict appendSeq ascending order regardless of input order', () => {
    var events = [
      fixtureEvent(5),
      fixtureEvent(1),
      fixtureEvent(3),
      fixtureEvent(0),
      fixtureEvent(2),
      fixtureEvent(4)
    ];
    var out = BS.buildEventsJsonl({ events: events });
    var lines = out.split('\n').filter(function (l) { return l !== ''; });
    assert.equal(lines.length, 6);
    var seqs = lines.map(function (l) { return JSON.parse(l).appendSeq; });
    assert.deepEqual(seqs, [0, 1, 2, 3, 4, 5]);
  });

  it('orders by appendSeq, not by sourceSeq or monotonicMs', () => {
    // sourceSeq and monotonicMs are deliberately anti-correlated with
    // appendSeq in the fixture; a naive sort would misorder them.
    var events = [
      fixtureEvent(2, { sourceSeq: 100, monotonicMs: 99999 }),
      fixtureEvent(0, { sourceSeq: 300, monotonicMs: 1 }),
      fixtureEvent(1, { sourceSeq: 200, monotonicMs: 50000 })
    ];
    var out = BS.buildEventsJsonl({ events: events });
    var seqs = out.split('\n').filter(function (l) { return l !== ''; })
      .map(function (l) { return JSON.parse(l).appendSeq; });
    assert.deepEqual(seqs, [0, 1, 2]);
  });
});

describe('6.2 AC2 — verbatim passthrough', () => {
  it('every output line deep-equals the input event with identical key order', () => {
    var events = [
      fixtureEvent(0, { eventType: 'game_started', payload: { startingFen: FEN1 } }),
      fixtureEvent(1, { payload: { moveUci: 'g1f3', note: 'unicode ✓ test' } }),
      fixtureEvent(2, { refs: { replyTo: SID }, payload: null })
    ];
    var out = BS.buildEventsJsonl({ events: events });
    var lines = out.split('\n').filter(function (l) { return l !== ''; });
    assert.equal(lines.length, 3);
    var i;
    for (i = 0; i < events.length; i++) {
      assert.deepEqual(JSON.parse(lines[i]), events[i]);
      // Key order preserved (byte-stable serialization).
      assert.equal(
        lines[i].indexOf('"eventId"'),
        JSON.stringify(events[i]).indexOf('"eventId"'));
    }
  });

  it('trailing newline present; empty input yields empty string', () => {
    var out = BS.buildEventsJsonl({ events: [fixtureEvent(0)] });
    assert.ok(out.endsWith('\n'));
    assert.equal(BS.buildEventsJsonl({ events: [] }), '');
  });
});

describe('6.2 AC3 — no metrics, no position filtering', () => {
  it('move_confirmed events gain no fen/san/pgn/moveNumber/durationMs keys', () => {
    var events = [fixtureEvent(0), fixtureEvent(1)];
    var out = BS.buildEventsJsonl({ events: events });
    var lines = out.split('\n').filter(function (l) { return l !== ''; });
    lines.forEach(function (l) {
      var parsed = JSON.parse(l);
      ['fen', 'san', 'pgn', 'moveNumber', 'durationMs'].forEach(function (k) {
        assert.ok(!(k in parsed), 'no added ' + k);
        assert.ok(!(parsed.payload !== null && k in parsed.payload),
          'no added payload.' + k);
      });
    });
  });

  it('legitimate stored positions (game_started FEN, recovery checkpoint) survive verbatim', () => {
    var checkpoint = {
      eventType: 'history_revision',
      fen: FEN1,
      checkpointSeq: 42
    };
    var events = [
      fixtureEvent(0, { eventType: 'game_started', payload: { startingFen: FEN1 } }),
      fixtureEvent(1, { eventType: 'history_checkpoint', payload: checkpoint })
    ];
    var out = BS.buildEventsJsonl({ events: events });
    var lines = out.split('\n').filter(function (l) { return l !== ''; });
    assert.equal(JSON.parse(lines[0]).payload.startingFen, FEN1);
    assert.deepEqual(JSON.parse(lines[1]).payload, checkpoint);
  });
});

describe('6.2 AC4 — malformed input fails closed', () => {
  it('non-array events throws TypeError', () => {
    assert.throws(function () { BS.buildEventsJsonl({ events: null }); }, TypeError);
    assert.throws(function () { BS.buildEventsJsonl({}); }, TypeError);
    assert.throws(function () { BS.buildEventsJsonl('x'); }, TypeError);
  });

  it('corrupt appendSeq throws TypeError naming the event', () => {
    var bad = [fixtureEvent(0), fixtureEvent(1, { appendSeq: null })];
    assert.throws(function () { BS.buildEventsJsonl({ events: bad }); }, function (e) {
      return e instanceof TypeError && /appendSeq/.test(e.message);
    });
    assert.throws(function () {
      BS.buildEventsJsonl({ events: [fixtureEvent(0, { appendSeq: -1 })] });
    }, TypeError);
    assert.throws(function () {
      BS.buildEventsJsonl({ events: [fixtureEvent(0, { appendSeq: 1.5 })] });
    }, TypeError);
    assert.throws(function () {
      BS.buildEventsJsonl({ events: [fixtureEvent(0, { appendSeq: 'x' })] });
    }, TypeError);
  });

  it('duplicate appendSeq throws TypeError (never silently reordered)', () => {
    var dup = [fixtureEvent(0), fixtureEvent(0, { payload: { moveUci: 'd2d4' } })];
    assert.throws(function () { BS.buildEventsJsonl({ events: dup }); }, function (e) {
      return e instanceof TypeError && /duplicate/.test(e.message);
    });
  });

  it('non-object event throws TypeError', () => {
    assert.throws(function () {
      BS.buildEventsJsonl({ events: [fixtureEvent(0), 42] });
    }, TypeError);
  });
});

describe('6.2 AC5 — byte-stability', () => {
  it('same fixture serialized twice is byte-identical', () => {
    var events = [
      fixtureEvent(2, { payload: { moveUci: 'e7e5' } }),
      fixtureEvent(0, { eventType: 'game_started', payload: { startingFen: FEN1 } }),
      fixtureEvent(1, { payload: { moveUci: 'g1f3' } })
    ];
    assert.equal(
      BS.buildEventsJsonl({ events: events }),
      BS.buildEventsJsonl({ events: events }));
  });
});

// ------------------------------------------------------------------
// 6.3 — media-sync.json (PLAN.md §6.3).
// ------------------------------------------------------------------
//
// Pure buildMediaSyncJson: manifest facts verbatim, ONE computed value
// (mediaStartWallUtcMs via the timecode.js canonical formula), known
// gaps in two layers, deterministic segment ordering.

var SEG1 = 'dddddddd-1111-4111-8111-dddddddddddd';
var SEG2 = 'eeeeeeee-2222-4222-8222-eeeeeeeeeeee';
var SEG3 = 'ffffffff-3333-4333-8333-ffffffffffff';

function fixtureManifestRecord(overrides) {
  var base = {
    segmentId: SEG1,
    sessionId: SID,
    gameId: GID1,
    streamKind: 'microphone',
    requestedMimeType: 'audio/webm',
    actualMimeType: 'audio/webm;codecs=opus',
    fileExtension: '.webm',
    createdAtUtc: '2026-10-06T20:00:00.000Z',
    streamStartedAtUtc: '2026-10-06T20:00:01.000Z',
    streamStartedAtMonotonicMs: 1000.5,
    effectiveDeviceId: null,
    audioTrackPresent: true,
    videoTrackPresent: false,
    screenAudioContent: null,
    micAudioContent: 'mic',
    clockSegmentId: 'anchor-seg-1',
    segmentNumber: 0,
    finalizedAtUtc: '2026-10-06T21:00:00.000Z'
  };
  var k;
  for (k in overrides) {
    if (Object.prototype.hasOwnProperty.call(overrides, k)) {
      base[k] = overrides[k];
    }
  }
  return base;
}

function fixtureAnchor() {
  return { segmentId: 'anchor-seg-1', utcEpochMs: 1000000, monotonicMs: 500 };
}

function fixtureSyncStopVerdict(overrides) {
  var base = {
    stopResp: {
      ok: true,
      markerId: null,
      finalizedAtUtc: '2026-10-06T21:00:00.000Z',
      streams: {
        microphone: { ok: true, segments: [], flushTimedOut: false },
        screen: { ok: true, segments: [], flushTimedOut: false },
        webcam: { ok: true, segments: [], flushTimedOut: false }
      }
    },
    flushResult: { delivered: 42, pending: 0 },
    verdict: 'complete',
    warnings: []
  };
  if (overrides) {
    var k;
    for (k in overrides) {
      if (Object.prototype.hasOwnProperty.call(overrides, k)) {
        base[k] = overrides[k];
      }
    }
  }
  return base;
}

describe('6.3 AC1 — golden media-sync.json shape', () => {
  it('fixture with two kinds x two segments produces the exact schema', () => {
    var records = [
      fixtureManifestRecord({
        segmentId: SEG1, streamKind: 'microphone', segmentNumber: 0
      }),
      fixtureManifestRecord({
        segmentId: SEG2, streamKind: 'webcam', segmentNumber: null,
        finalizedAtUtc: null, clockSegmentId: 'anchor-seg-1'
      }),
      fixtureManifestRecord({
        segmentId: SEG3, streamKind: 'microphone', segmentNumber: 1,
        createdAtUtc: '2026-10-06T20:30:00.000Z'
      })
    ];
    var anchors = [fixtureAnchor()];
    var verdict = fixtureSyncStopVerdict({
      verdict: 'complete-with-warnings',
      warnings: ['webcam-flush-timed-out'],
      stopResp: {
        ok: true,
        markerId: null,
        finalizedAtUtc: '2026-10-06T21:00:00.000Z',
        streams: {
          microphone: { ok: true, segments: [], flushTimedOut: false },
          screen: { ok: true, segments: [], flushTimedOut: false },
          webcam: { ok: true, segments: [], flushTimedOut: true }
        }
      }
    });
    var segmentFiles = {};
    segmentFiles[SEG1] = 'microphone-001.webm';
    segmentFiles[SEG2] = 'webcam-001.webm';
    segmentFiles[SEG3] = 'microphone-002.webm';
    var chunkStats = {};
    chunkStats[SEG1] = { chunkCount: 10, chunksAfterFinalize: 0 };

    var out = BS.buildMediaSyncJson({
      manifestRecords: records,
      clockAnchors: anchors,
      stopVerdict: verdict,
      segmentFiles: segmentFiles,
      chunkStats: chunkStats,
      nowUtcIso: function () { return '2026-10-06T22:00:00.000Z'; }
    });
    var doc = JSON.parse(out);

    // Deterministic ordering: kind (microphone, screen, webcam) →
    // segmentNumber (nulls last) → createdAtUtc → segmentId.
    assert.deepEqual(doc.segments.map(function (s) { return s.segmentId; }),
      [SEG1, SEG3, SEG2]);

    var mic0 = doc.segments[0];
    assert.equal(mic0.segmentId, SEG1);
    assert.equal(mic0.streamKind, 'microphone');
    assert.equal(mic0.segmentNumber, 0);
    assert.equal(mic0.filename, 'microphone-001.webm');
    assert.equal(mic0.format, 'audio/webm;codecs=opus');
    assert.equal(mic0.fileExtension, '.webm');
    assert.equal(mic0.finalized, true);
    assert.equal(mic0.finalizedAtUtc, '2026-10-06T21:00:00.000Z');
    assert.deepEqual(mic0.clockAnchor, fixtureAnchor());
    // Canonical formula: 1000000 + (1000.5 - 500) = 1000500.5 (no rounding).
    assert.equal(mic0.mediaStartWallUtcMs, 1000500.5);
    assert.equal(mic0.chunkCount, 10);
    assert.equal(mic0.chunksAfterFinalize, 0);
    assert.deepEqual(mic0.gaps, []);

    var web = doc.segments[2];
    assert.equal(web.segmentId, SEG2);
    assert.equal(web.finalized, false);
    assert.equal(web.segmentNumber, null);
    assert.equal(web.filename, 'webcam-001.webm');
    assert.deepEqual(web.gaps, ['unfinalized', 'flush-timed-out']);

    assert.deepEqual(doc.knownGaps, ['webcam-flush-timed-out']);
    assert.equal(doc.stopVerdict, 'complete-with-warnings');
    assert.equal(doc.exportedAtUtc, '2026-10-06T22:00:00.000Z');
  });

  it('empty manifest records yields an empty segments array', () => {
    var out = BS.buildMediaSyncJson({
      manifestRecords: [],
      clockAnchors: [],
      stopVerdict: fixtureSyncStopVerdict(),
      nowUtcIso: function () { return '2026-10-06T22:00:00.000Z'; }
    });
    var doc = JSON.parse(out);
    assert.deepEqual(doc.segments, []);
    assert.deepEqual(doc.knownGaps, []);
    assert.equal(doc.stopVerdict, 'complete');
  });
});

describe('6.3 AC2 — known gaps', () => {
  it('flushTimedOut, undelivered events, and stream failure all surface verbatim', () => {
    var records = [
      fixtureManifestRecord({ segmentId: SEG1, streamKind: 'microphone', segmentNumber: 0 }),
      fixtureManifestRecord({
        segmentId: SEG2, streamKind: 'screen', segmentNumber: 0,
        clockSegmentId: 'anchor-seg-1'
      })
    ];
    var verdict = fixtureSyncStopVerdict({
      verdict: 'complete-with-warnings',
      warnings: ['webcam-flush-timed-out', '3-events-undelivered', 'screen-failed:boom'],
      stopResp: {
        ok: true, markerId: null, finalizedAtUtc: null,
        streams: {
          microphone: { ok: true, segments: [], flushTimedOut: false },
          screen: { ok: false, segments: [], error: 'boom' },
          webcam: { ok: true, segments: [], flushTimedOut: true }
        }
      },
      flushResult: { delivered: 39, pending: 3 }
    });
    var chunkStats = {};
    chunkStats[SEG1] = { chunkCount: 5, chunksAfterFinalize: 2 };

    var doc = JSON.parse(BS.buildMediaSyncJson({
      manifestRecords: records,
      clockAnchors: [fixtureAnchor()],
      stopVerdict: verdict,
      segmentFiles: null,
      chunkStats: chunkStats,
      nowUtcIso: function () { return '2026-10-06T22:00:00.000Z'; }
    }));

    assert.deepEqual(doc.knownGaps,
      ['webcam-flush-timed-out', '3-events-undelivered', 'screen-failed:boom']);
    var mic = doc.segments[0];
    assert.deepEqual(mic.gaps, ['chunks-after-finalize:2']);
    assert.equal(mic.filename, null);  // absent mapping → null, honest
    var screen = doc.segments[1];
    assert.deepEqual(screen.gaps, ['stream-failed']);
  });
});

describe('6.3 AC3 — absent stop verdict degrades honestly', () => {
  it('stop-verdict-unavailable, stopVerdict unknown, per-segment facts still export', () => {
    var records = [fixtureManifestRecord({ segmentId: SEG1 })];
    var doc = JSON.parse(BS.buildMediaSyncJson({
      manifestRecords: records,
      clockAnchors: [fixtureAnchor()],
      stopVerdict: null,
      nowUtcIso: function () { return '2026-10-06T22:00:00.000Z'; }
    }));
    assert.deepEqual(doc.knownGaps, ['stop-verdict-unavailable']);
    assert.equal(doc.stopVerdict, 'unknown');
    assert.equal(doc.segments[0].segmentId, SEG1);
    assert.equal(doc.segments[0].mediaStartWallUtcMs, 1000500.5);
  });
});

describe('6.3 AC4 — missing clock anchor', () => {
  it('null anchor, null offset, missing-clock-anchor gap — never fabricated', () => {
    var records = [fixtureManifestRecord({
      segmentId: SEG1,
      clockSegmentId: 'anchor-that-does-not-exist'
    })];
    var doc = JSON.parse(BS.buildMediaSyncJson({
      manifestRecords: records,
      clockAnchors: [fixtureAnchor()],
      stopVerdict: fixtureSyncStopVerdict(),
      nowUtcIso: function () { return '2026-10-06T22:00:00.000Z'; }
    }));
    var seg = doc.segments[0];
    assert.equal(seg.clockAnchor, null);
    assert.equal(seg.mediaStartWallUtcMs, null);
    assert.ok(seg.gaps.indexOf('missing-clock-anchor') !== -1);
  });

  it('null clockSegmentId is not a gap (anchor simply not linked)', () => {
    var records = [fixtureManifestRecord({
      segmentId: SEG1, clockSegmentId: null
    })];
    var doc = JSON.parse(BS.buildMediaSyncJson({
      manifestRecords: records,
      clockAnchors: [],
      stopVerdict: fixtureSyncStopVerdict(),
      nowUtcIso: function () { return '2026-10-06T22:00:00.000Z'; }
    }));
    var seg = doc.segments[0];
    assert.equal(seg.clockAnchor, null);
    assert.equal(seg.mediaStartWallUtcMs, null);
    assert.ok(seg.gaps.indexOf('missing-clock-anchor') === -1);
  });
});

describe('6.3 AC5 — unfinalized segments are listed, not omitted', () => {
  it('segmentNumber null → finalized false, unfinalized gap, filename still mapped', () => {
    var records = [fixtureManifestRecord({
      segmentId: SEG1, segmentNumber: null, finalizedAtUtc: null
    })];
    var segmentFiles = {};
    segmentFiles[SEG1] = 'microphone-001.webm';
    var doc = JSON.parse(BS.buildMediaSyncJson({
      manifestRecords: records,
      clockAnchors: [fixtureAnchor()],
      stopVerdict: fixtureSyncStopVerdict(),
      segmentFiles: segmentFiles,
      nowUtcIso: function () { return '2026-10-06T22:00:00.000Z'; }
    }));
    var seg = doc.segments[0];
    assert.equal(seg.finalized, false);
    assert.equal(seg.segmentNumber, null);
    assert.deepEqual(seg.gaps, ['unfinalized']);
    assert.equal(seg.filename, 'microphone-001.webm');
  });
});

describe('6.3 AC6 — purity and strict validation', () => {
  it('inputs are not mutated', () => {
    var records = [fixtureManifestRecord({ segmentId: SEG1 })];
    var anchors = [fixtureAnchor()];
    var verdict = fixtureSyncStopVerdict();
    var snapshot = JSON.stringify({ records: records, anchors: anchors, verdict: verdict });
    BS.buildMediaSyncJson({
      manifestRecords: records,
      clockAnchors: anchors,
      stopVerdict: verdict,
      nowUtcIso: function () { return '2026-10-06T22:00:00.000Z'; }
    });
    assert.equal(JSON.stringify({ records: records, anchors: anchors, verdict: verdict }), snapshot);
  });

  it('TypeError on malformed inputs', () => {
    assert.throws(function () {
      BS.buildMediaSyncJson({ manifestRecords: 'x' });
    }, TypeError);
    assert.throws(function () {
      BS.buildMediaSyncJson({ manifestRecords: [{ segmentId: SEG1 }] });
    }, TypeError);  // missing streamKind
    assert.throws(function () {
      BS.buildMediaSyncJson({
        manifestRecords: [fixtureManifestRecord({})],
        clockAnchors: [{ segmentId: 'a' }]
      });
    }, TypeError);  // malformed anchor
    assert.throws(function () {
      BS.buildMediaSyncJson({
        manifestRecords: [fixtureManifestRecord({})],
        stopVerdict: { verdict: 'bogus' }
      });
    }, TypeError);
  });

  it('failed verdict throws plain Error (fail-closed)', () => {
    assert.throws(function () {
      BS.buildMediaSyncJson({
        manifestRecords: [fixtureManifestRecord({})],
        stopVerdict: { verdict: 'failed' },
        nowUtcIso: function () { return '2026-10-06T22:00:00.000Z'; }
      });
    }, function (e) {
      return e instanceof Error && !(e instanceof TypeError) &&
        /session-not-complete/.test(e.message);
    });
  });

  it('same fixture serialized twice is byte-identical', () => {
    var args = {
      manifestRecords: [fixtureManifestRecord({ segmentId: SEG1 })],
      clockAnchors: [fixtureAnchor()],
      stopVerdict: fixtureSyncStopVerdict(),
      nowUtcIso: function () { return '2026-10-06T22:00:00.000Z'; }
    };
    assert.equal(BS.buildMediaSyncJson(args), BS.buildMediaSyncJson(args));
  });
});

// ------------------------------------------------------------------
// 6.4 — assembleSegmentChunks (PLAN.md §6.4).
// ------------------------------------------------------------------

function fixtureChunk(segmentId, chunkIndex, byteArray, overrides) {
  var rec = {
    segmentId: segmentId,
    chunkIndex: chunkIndex,
    receivedAtUtc: '2026-10-06T20:00:00.000Z',
    receivedAtMonotonicMs: 1000 + chunkIndex,
    timecodeMs: chunkIndex * 1000,
    data: new Blob([new Uint8Array(byteArray)])
  };
  var k;
  for (k in (overrides || {})) {
    if (Object.prototype.hasOwnProperty.call(overrides || {}, k)) {
      rec[k] = overrides[k];
    }
  }
  return rec;
}

function concatParts(parts) {
  return Promise.all(parts.map(function (p) { return p.arrayBuffer(); }))
    .then(function (abs) {
      var total = abs.reduce(function (n, ab) { return n + ab.byteLength; }, 0);
      var out = new Uint8Array(total);
      var off = 0;
      abs.forEach(function (ab) {
        out.set(new Uint8Array(ab), off);
        off += ab.byteLength;
      });
      return out;
    });
}

// Independent CRC-32 (not via exporter internals) for cross-checking.
function independentCrc32(byteArrays) {
  var table = new Array(256);
  var n, k, c;
  for (n = 0; n < 256; n++) {
    c = n;
    for (k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  var state = 0xFFFFFFFF;
  var i, j, bytes;
  for (i = 0; i < byteArrays.length; i++) {
    bytes = byteArrays[i];
    for (j = 0; j < bytes.length; j++) {
      state = table[(state ^ bytes[j]) & 0xFF] ^ (state >>> 8);
    }
  }
  return ((state ^ 0xFFFFFFFF) >>> 0);
}

describe('6.4 AC1 — byte-concatenation in chunkIndex order', () => {
  it('assembles N chunks to concatenated bytes in input order', async () => {
    var chunks = [
      fixtureChunk('s1', 0, [0x1A, 0x45, 0xDF, 0xA3]),
      fixtureChunk('s1', 1, [0x42, 0x86]),
      fixtureChunk('s1', 2, [0x81, 0x01, 0x42, 0xF7])
    ];
    var r = await BS.assembleSegmentChunks({ chunks: chunks });
    var bytes = await concatParts(r.parts);
    assert.deepEqual(Array.from(bytes),
      [0x1A, 0x45, 0xDF, 0xA3, 0x42, 0x86, 0x81, 0x01, 0x42, 0xF7]);
    assert.equal(r.byteLength, 10);
    assert.equal(r.chunkCount, 3);
  });

  it('processes input order as given (trusts 6.6 key-order guarantee)', async () => {
    // Deliberately out-of-order input: assembled in INPUT order,
    // per contract §3 (6.6 owns ordering via the key-range read).
    var chunks = [
      fixtureChunk('s1', 2, [0x03]),
      fixtureChunk('s1', 0, [0x01]),
      fixtureChunk('s1', 1, [0x02])
    ];
    var r = await BS.assembleSegmentChunks({ chunks: chunks });
    var bytes = await concatParts(r.parts);
    assert.deepEqual(Array.from(bytes), [0x03, 0x01, 0x02]);
  });
});

describe('6.4 AC2 — zero transcoding', () => {
  it('output bytes are byte-identical to input chunk bytes', async () => {
    // Synthetic WebM-like pattern: init segment + clusters.
    var init = [0x1A, 0x45, 0xDF, 0xA3, 0x42, 0x86, 0x81, 0x01];
    var cluster1 = [0x1F, 0x43, 0xB6, 0x75, 0x01, 0x02, 0x03];
    var cluster2 = [0x1F, 0x43, 0xB6, 0x75, 0x04, 0x05, 0x06, 0x07];
    var chunks = [
      fixtureChunk('s1', 0, init),
      fixtureChunk('s1', 1, cluster1),
      fixtureChunk('s1', 2, cluster2)
    ];
    var r = await BS.assembleSegmentChunks({ chunks: chunks });
    var bytes = await concatParts(r.parts);
    assert.deepEqual(Array.from(bytes), init.concat(cluster1, cluster2));
    // No headers added, no bytes transformed: length is exact sum.
    assert.equal(r.byteLength, init.length + cluster1.length + cluster2.length);
  });
});

describe('6.4 AC3 — CRC-32 correctness', () => {
  it('empty input yields crc32 0', async () => {
    var r = await BS.assembleSegmentChunks({ chunks: [] });
    assert.equal(r.crc32, 0);
  });

  it('"123456789" yields 0xCBF43926 (standard vector)', async () => {
    var s = '123456789';
    var bytes = [];
    var i;
    for (i = 0; i < s.length; i++) {
      bytes.push(s.charCodeAt(i));
    }
    var r = await BS.assembleSegmentChunks({
      chunks: [fixtureChunk('s1', 0, bytes)]
    });
    assert.equal(r.crc32, 0xCBF43926);
  });

  it('multi-chunk incremental CRC equals single-buffer CRC', async () => {
    var a = [1, 2, 3, 4, 5];
    var b = [6, 7, 8];
    var c = [9, 10, 11, 12];
    var multi = await BS.assembleSegmentChunks({
      chunks: [
        fixtureChunk('s1', 0, a),
        fixtureChunk('s1', 1, b),
        fixtureChunk('s1', 2, c)
      ]
    });
    var single = await BS.assembleSegmentChunks({
      chunks: [fixtureChunk('s1', 0, a.concat(b, c))]
    });
    assert.equal(multi.crc32, single.crc32);
    assert.equal(multi.crc32, independentCrc32([a, b, c]));
  });
});

describe('6.4 AC4 — streaming shape', () => {
  it('returns one Blob per chunk, not one merged Blob', async () => {
    var chunks = [
      fixtureChunk('s1', 0, [1, 2]),
      fixtureChunk('s1', 1, [3, 4, 5]),
      fixtureChunk('s1', 2, [6])
    ];
    var r = await BS.assembleSegmentChunks({ chunks: chunks });
    assert.equal(r.parts.length, 3);
    assert.equal(r.parts.length, chunks.length);
    // Each part is the original chunk Blob (same reference, same size).
    assert.equal(r.parts[0], chunks[0].data);
    assert.equal(r.parts[1].size, 3);
    assert.equal(r.parts[2].size, 1);
  });
});

describe('6.4 AC5 — malformed input fails closed', () => {
  it('non-object args rejects with TypeError', async () => {
    await assert.rejects(BS.assembleSegmentChunks(null), TypeError);
    await assert.rejects(BS.assembleSegmentChunks('x'), TypeError);
  });

  it('non-array chunks rejects with TypeError', async () => {
    await assert.rejects(BS.assembleSegmentChunks({ chunks: 'nope' }), TypeError);
  });

  it('missing data rejects with TypeError naming the chunkIndex', async () => {
    var chunks = [fixtureChunk('s1', 0, [1], { data: null })];
    await assert.rejects(
      BS.assembleSegmentChunks({ chunks: chunks }),
      function (e) {
        return e instanceof TypeError && /chunkIndex 0/.test(e.message) &&
          /data/.test(e.message);
      });
  });

  it('non-Blob data rejects with TypeError', async () => {
    var chunks = [fixtureChunk('s1', 3, [1], { data: { size: 1 } })];
    await assert.rejects(
      BS.assembleSegmentChunks({ chunks: chunks }),
      function (e) {
        return e instanceof TypeError && /chunkIndex 3/.test(e.message);
      });
  });

  it('duplicate chunkIndex rejects with TypeError', async () => {
    var chunks = [
      fixtureChunk('s1', 0, [1]),
      fixtureChunk('s1', 0, [2])
    ];
    await assert.rejects(
      BS.assembleSegmentChunks({ chunks: chunks }),
      function (e) {
        return e instanceof TypeError && /duplicate chunkIndex 0/.test(e.message);
      });
  });

  it('negative chunkIndex rejects with TypeError', async () => {
    var chunks = [fixtureChunk('s1', -1, [1])];
    await assert.rejects(BS.assembleSegmentChunks({ chunks: chunks }), TypeError);
  });
});

describe('6.4 AC6 — gaps are honest', () => {
  it('chunks [0, 2, 5] assemble without error or re-indexing', async () => {
    var chunks = [
      fixtureChunk('s1', 0, [0xAA]),
      fixtureChunk('s1', 2, [0xBB]),
      fixtureChunk('s1', 5, [0xCC])
    ];
    var r = await BS.assembleSegmentChunks({ chunks: chunks });
    assert.equal(r.chunkCount, 3);
    assert.equal(r.parts.length, 3);
    var bytes = await concatParts(r.parts);
    assert.deepEqual(Array.from(bytes), [0xAA, 0xBB, 0xCC]);
  });
});

describe('6.4 AC7 — empty input', () => {
  it('empty chunks yields zeroed result without throwing', async () => {
    var r = await BS.assembleSegmentChunks({ chunks: [] });
    assert.deepEqual(r.parts, []);
    assert.equal(r.byteLength, 0);
    assert.equal(r.crc32, 0);
    assert.equal(r.chunkCount, 0);
  });
});

// ------------------------------------------------------------------
// 6.5 — nameSegmentFiles (PLAN.md §6.5).
// ------------------------------------------------------------------

function fixtureNamingRecord(overrides) {
  var base = {
    segmentId: 'seg-1',
    streamKind: 'microphone',
    segmentNumber: 1,
    fileExtension: '.webm',
    actualMimeType: 'audio/webm;codecs=opus',
    createdAtUtc: '2026-10-06T20:00:00.000Z'
  };
  var k;
  for (k in (overrides || {})) {
    if (Object.prototype.hasOwnProperty.call(overrides || {}, k)) {
      base[k] = overrides[k];
    }
  }
  return base;
}

describe('6.5 AC1 — finalized segments use segmentNumber verbatim', () => {
  it('segmentNumber 1 -> microphone-001.webm', () => {
    var r = BS.nameSegmentFiles({
      manifestRecords: [fixtureNamingRecord({})]
    });
    assert.equal(r.bySegmentId['seg-1'], 'microphone-001.webm');
    assert.equal(r.files[0].segmentNumber, 1);
  });

  it('segmentNumber 12 -> microphone-012.webm; 1000 stays 1000', () => {
    var r = BS.nameSegmentFiles({
      manifestRecords: [
        fixtureNamingRecord({ segmentId: 'a', segmentNumber: 12 }),
        fixtureNamingRecord({ segmentId: 'b', segmentNumber: 1000 })
      ]
    });
    assert.equal(r.bySegmentId['a'], 'microphone-012.webm');
    assert.equal(r.bySegmentId['b'], 'microphone-1000.webm');
  });
});

describe('6.5 AC2 — unfinalized sessions number chronologically', () => {
  it('three null-numbered segments -> 001, 002, 003 in createdAtUtc order', () => {
    var r = BS.nameSegmentFiles({
      manifestRecords: [
        fixtureNamingRecord({
          segmentId: 'late', streamKind: 'screen', segmentNumber: null,
          fileExtension: '.webm', actualMimeType: 'video/webm',
          createdAtUtc: '2026-10-06T20:02:00.000Z'
        }),
        fixtureNamingRecord({
          segmentId: 'early', streamKind: 'screen', segmentNumber: null,
          fileExtension: '.webm', actualMimeType: 'video/webm',
          createdAtUtc: '2026-10-06T20:00:00.000Z'
        }),
        fixtureNamingRecord({
          segmentId: 'mid', streamKind: 'screen', segmentNumber: null,
          fileExtension: '.webm', actualMimeType: 'video/webm',
          createdAtUtc: '2026-10-06T20:01:00.000Z'
        })
      ]
    });
    assert.equal(r.bySegmentId['early'], 'screen-001.webm');
    assert.equal(r.bySegmentId['mid'], 'screen-002.webm');
    assert.equal(r.bySegmentId['late'], 'screen-003.webm');
    // Effective numbers are the on-the-fly labels.
    assert.deepEqual(r.files.map(function (f) { return f.segmentNumber; }), [1, 2, 3]);
  });
});

describe('6.5 AC3 — mixed finalized/unfinalized fills gaps', () => {
  it('numbers {1, 3} + one null -> null gets 002, no collision', () => {
    var r = BS.nameSegmentFiles({
      manifestRecords: [
        fixtureNamingRecord({ segmentId: 's1', segmentNumber: 1 }),
        fixtureNamingRecord({ segmentId: 's3', segmentNumber: 3 }),
        fixtureNamingRecord({
          segmentId: 'sx', segmentNumber: null,
          createdAtUtc: '2026-10-06T20:05:00.000Z'
        })
      ]
    });
    assert.equal(r.bySegmentId['s1'], 'microphone-001.webm');
    assert.equal(r.bySegmentId['sx'], 'microphone-002.webm');
    assert.equal(r.bySegmentId['s3'], 'microphone-003.webm');
  });
});

describe('6.5 AC4 — per-kind independence', () => {
  it('microphone and screen each number from 001', () => {
    var r = BS.nameSegmentFiles({
      manifestRecords: [
        fixtureNamingRecord({ segmentId: 'm1', streamKind: 'microphone', segmentNumber: 1 }),
        fixtureNamingRecord({
          segmentId: 'v1', streamKind: 'screen', segmentNumber: 1,
          fileExtension: '.webm', actualMimeType: 'video/webm'
        }),
        fixtureNamingRecord({ segmentId: 'm2', streamKind: 'microphone', segmentNumber: 2 })
      ]
    });
    assert.equal(r.bySegmentId['m1'], 'microphone-001.webm');
    assert.equal(r.bySegmentId['m2'], 'microphone-002.webm');
    assert.equal(r.bySegmentId['v1'], 'screen-001.webm');
  });
});

describe('6.5 AC5 — extension resolution', () => {
  it('manifest fileExtension used verbatim', () => {
    var r = BS.nameSegmentFiles({
      manifestRecords: [fixtureNamingRecord({ fileExtension: '.mp4' })]
    });
    assert.equal(r.bySegmentId['seg-1'], 'microphone-001.mp4');
  });

  it('null fileExtension + audio/webm -> .webm', () => {
    var r = BS.nameSegmentFiles({
      manifestRecords: [fixtureNamingRecord({
        fileExtension: null, actualMimeType: 'audio/webm'
      })]
    });
    assert.equal(r.bySegmentId['seg-1'], 'microphone-001.webm');
  });

  it('null fileExtension + video/mp4 -> .mp4', () => {
    var r = BS.nameSegmentFiles({
      manifestRecords: [fixtureNamingRecord({
        streamKind: 'screen', fileExtension: null,
        actualMimeType: 'video/mp4;codecs=avc1'
      })]
    });
    assert.equal(r.bySegmentId['seg-1'], 'screen-001.mp4');
  });

  it('null fileExtension + audio/mp4 -> .m4a', () => {
    var r = BS.nameSegmentFiles({
      manifestRecords: [fixtureNamingRecord({
        fileExtension: null, actualMimeType: 'audio/mp4'
      })]
    });
    assert.equal(r.bySegmentId['seg-1'], 'microphone-001.m4a');
  });

  it('both null -> TypeError naming the segmentId', () => {
    assert.throws(function () {
      BS.nameSegmentFiles({
        manifestRecords: [fixtureNamingRecord({
          segmentId: 'badseg', fileExtension: null, actualMimeType: null
        })]
      });
    }, function (e) {
      return e instanceof TypeError && /badseg/.test(e.message);
    });
  });

  it('unrecognized mimeType -> TypeError', () => {
    assert.throws(function () {
      BS.nameSegmentFiles({
        manifestRecords: [fixtureNamingRecord({
          segmentId: 'weird', fileExtension: null,
          actualMimeType: 'application/octet-stream'
        })]
      });
    }, TypeError);
  });
});

describe('6.5 AC6 — malformed input fails closed', () => {
  it('non-array manifestRecords throws TypeError', () => {
    assert.throws(function () {
      BS.nameSegmentFiles({ manifestRecords: 'nope' });
    }, TypeError);
  });

  it('missing segmentId throws TypeError', () => {
    assert.throws(function () {
      BS.nameSegmentFiles({
        manifestRecords: [fixtureNamingRecord({ segmentId: '' })]
      });
    }, TypeError);
  });

  it('duplicate segmentId throws TypeError', () => {
    assert.throws(function () {
      BS.nameSegmentFiles({
        manifestRecords: [
          fixtureNamingRecord({ segmentId: 'dup' }),
          fixtureNamingRecord({ segmentId: 'dup' })
        ]
      });
    }, function (e) {
      return e instanceof TypeError && /duplicate segmentId/.test(e.message);
    });
  });

  it('non-positive segmentNumber throws TypeError', () => {
    assert.throws(function () {
      BS.nameSegmentFiles({
        manifestRecords: [fixtureNamingRecord({ segmentNumber: 0 })]
      });
    }, TypeError);
    assert.throws(function () {
      BS.nameSegmentFiles({
        manifestRecords: [fixtureNamingRecord({ segmentNumber: -2 })]
      });
    }, TypeError);
  });

  it('duplicate finalized segmentNumber within a kind throws TypeError', () => {
    assert.throws(function () {
      BS.nameSegmentFiles({
        manifestRecords: [
          fixtureNamingRecord({ segmentId: 'd1', segmentNumber: 1 }),
          fixtureNamingRecord({ segmentId: 'd2', segmentNumber: 1 })
        ]
      });
    }, function (e) {
      return e instanceof TypeError && /duplicate segmentNumber/.test(e.message);
    });
  });
});

describe('6.5 AC7 — empty input', () => {
  it('empty manifestRecords yields empty mapping', () => {
    var r = BS.nameSegmentFiles({ manifestRecords: [] });
    assert.deepEqual(r.files, []);
    assert.deepEqual(r.bySegmentId, {});
  });
});

describe('6.5 AC8 — determinism', () => {
  it('shuffled input yields identical output', () => {
    var recs = [
      fixtureNamingRecord({ segmentId: 'a', segmentNumber: 2 }),
      fixtureNamingRecord({ segmentId: 'b', segmentNumber: null }),
      fixtureNamingRecord({ segmentId: 'c', segmentNumber: 1 })
    ];
    var r1 = BS.nameSegmentFiles({ manifestRecords: recs });
    var r2 = BS.nameSegmentFiles({
      manifestRecords: [recs[2], recs[0], recs[1]]
    });
    assert.deepEqual(r1, r2);
  });
});

// ------------------------------------------------------------------
// 6.6 — ZIP packaging (PLAN.md §6.6) per .autodev/evidence/6.6.contract.md.
// ------------------------------------------------------------------

// AC1: buildZipParts byte-exactness — a real unzip reads back correct
// filenames, CRCs, sizes, and data.
describe('6.6 AC1 — ZIP byte-exactness', () => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');

  async function writeZipToTemp(zipParts) {
    const blob = new Blob(zipParts, { type: 'application/zip' });
    const ab = await blob.arrayBuffer();
    const p = require('node:path').join(fs.mkdtempSync(require('node:path').join(os.tmpdir(), 'ziptest-')), 'out.zip');
    fs.writeFileSync(p, Buffer.from(ab));
    return p;
  }

  it('single-file ZIP round-trips through the system unzip', async () => {
    const text = '{"hello":"world"}';
    const data = new TextEncoder().encode(text);
    // CRC via the module's own assembler (ground truth).
    const asm = await BS.assembleSegmentChunks({
      chunks: [{ chunkIndex: 0, data: new Blob([data]) }]
    });
    const zip = BS.buildZipParts({
      files: [{
        path: 'training/2026-10-06_x/metadata.json',
        dataParts: asm.parts,
        byteLength: asm.byteLength,
        crc32: asm.crc32
      }],
      dosDateTime: BS.dosDateTimeFromIso('2026-10-06T12:00:00.000Z')
    });
    const zp = await writeZipToTemp(zip.parts);
    // unzip -t validates structure + CRCs.
    execFileSync('unzip', ['-t', zp]);
    const out = execFileSync('unzip', ['-p', zp,
      'training/2026-10-06_x/metadata.json']).toString();
    assert.equal(out, text);
  });

  it('multi-file ZIP with binary data round-trips', async () => {
    const bin = new Uint8Array([0x00, 0xFF, 0x80, 0x7F, 1, 2, 3]);
    const asm = await BS.assembleSegmentChunks({
      chunks: [
        { chunkIndex: 0, data: new Blob([bin.slice(0, 3)]) },
        { chunkIndex: 1, data: new Blob([bin.slice(3)]) }
      ]
    });
    const txt = new TextEncoder().encode('abc');
    const tstate = (() => {
      // CRC-32 via the module's exported table (independent path).
      const T = BS.EXPORTER_CRC32_TABLE;
      let c = 0xFFFFFFFF;
      for (let i = 0; i < txt.length; i++) {
        c = T[(c ^ txt[i]) & 0xFF] ^ (c >>> 8);
      }
      return ((c ^ 0xFFFFFFFF) >>> 0);
    })();
    const zip = BS.buildZipParts({
      files: [
        {
          path: 'd/f1.bin',
          dataParts: asm.parts,
          byteLength: asm.byteLength,
          crc32: asm.crc32
        },
        {
          path: 'd/f2.txt',
          dataParts: [new Blob([txt])],
          byteLength: txt.length,
          crc32: tstate
        }
      ],
      dosDateTime: BS.dosDateTimeFromIso('2026-01-02T03:04:05.000Z')
    });
    assert.equal(zip.fileCount, 2);
    const zp = await writeZipToTemp(zip.parts);
    execFileSync('unzip', ['-t', zp]);
    const listing = execFileSync('unzip', ['-l', zp]).toString();
    assert.ok(listing.includes('d/f1.bin'));
    assert.ok(listing.includes('d/f2.txt'));
    const back = execFileSync('unzip', ['-p', zp, 'd/f1.bin']);
    assert.deepEqual(new Uint8Array(back), bin);
  });

  it('empty files array throws TypeError', () => {
    assert.throws(() => BS.buildZipParts({
      files: [],
      dosDateTime: BS.dosDateTimeFromIso('2026-10-06T00:00:00.000Z')
    }), TypeError);
  });

  it('invalid ZIP path throws TypeError', () => {
    const mk = (path) => () => BS.buildZipParts({
      files: [{
        path: path,
        dataParts: [new Blob(['x'])],
        byteLength: 1,
        crc32: 0
      }],
      dosDateTime: BS.dosDateTimeFromIso('2026-10-06T00:00:00.000Z')
    });
    assert.throws(mk('/absolute'), TypeError);
    assert.throws(mk('../escape'), TypeError);
    assert.throws(mk('a/../../escape'), TypeError);
    assert.throws(mk('a\\backslash'), TypeError);
    assert.throws(mk(''), TypeError);
  });
});

// AC2: STORE-only — every header has method 0; no compression code path.
describe('6.6 AC2 — STORE-only', () => {
  it('all local and central headers declare method 0', async () => {
    const data = new TextEncoder().encode('x'.repeat(1000));
    const asm = await BS.assembleSegmentChunks({
      chunks: [{ chunkIndex: 0, data: new Blob([data]) }]
    });
    const zip = BS.buildZipParts({
      files: [{
        path: 'd/f.bin',
        dataParts: asm.parts,
        byteLength: asm.byteLength,
        crc32: asm.crc32
      }],
      dosDateTime: BS.dosDateTimeFromIso('2026-10-06T00:00:00.000Z')
    });
    const blob = new Blob(zip.parts, { type: 'application/zip' });
    const ab = await blob.arrayBuffer();
    const v = new DataView(ab);
    // Local header method at offset 8.
    assert.equal(v.getUint16(8, true), 0);
    // Central directory: find 0x02014b50 signature, method at +10.
    let centralOff = -1;
    for (let i = 0; i < ab.byteLength - 4; i++) {
      if (v.getUint32(i, true) === 0x02014b50) { centralOff = i; break; }
    }
    assert.ok(centralOff >= 0, 'central header found');
    assert.equal(v.getUint16(centralOff + 10, true), 0);
  });

  it('exporter.js contains no deflate/compress code path', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(REPO, 'exporter.js'), 'utf8');
    assert.ok(!/deflate|inflate|compress\(/i.test(src),
      'no compression code in exporter.js');
  });
});

// AC3: path helpers.
describe('6.6 AC3 — path helpers', () => {
  const dirArgs = (over = {}) => Object.assign({
    sessionCategory: 'training',
    dateIso: '2026-10-06T12:34:56.000Z',
    gameIds: [GID1],
    sessionId: SID
  }, over);

  it('single-game directory: <category>/<date>_<gameId>/', () => {
    assert.equal(BS.buildBundleDir(dirArgs()),
      'training/2026-10-06_' + GID1 + '/');
  });

  it('multi-game directory: <category>/<date>_session-<sessionId>/', () => {
    assert.equal(BS.buildBundleDir(dirArgs({ gameIds: [GID1, GID2] })),
      'training/2026-10-06_session-' + SID + '/');
  });

  it('download filename: <category>-<date>-<shortId>.zip', () => {
    assert.equal(BS.buildDownloadFilename(dirArgs()),
      'training-2026-10-06-' + GID1.slice(0, 8) + '.zip');
    assert.equal(
      BS.buildDownloadFilename(dirArgs({ gameIds: [GID1, GID2] })),
      'training-2026-10-06-' + SID.slice(0, 8) + '.zip');
  });

  it('corrupt category throws TypeError', () => {
    assert.throws(() => BS.buildBundleDir(dirArgs({ sessionCategory: '../evil' })), TypeError);
    assert.throws(() => BS.buildBundleDir(dirArgs({ sessionCategory: 'a/b' })), TypeError);
    assert.throws(() => BS.buildBundleDir(dirArgs({ sessionCategory: '' })), TypeError);
    assert.throws(() => BS.buildDownloadFilename(dirArgs({ sessionCategory: 'x;y' })), TypeError);
  });

  it('bad dateIso throws TypeError', () => {
    assert.throws(() => BS.buildBundleDir(dirArgs({ dateIso: 'not-a-date' })), TypeError);
    assert.throws(() => BS.buildDownloadFilename(dirArgs({ dateIso: null })), TypeError);
  });

  it('dosDateTimeFromIso: valid date encodes; garbage → MSDOS epoch', () => {
    const d = BS.dosDateTimeFromIso('2026-10-06T12:00:00.000Z');
    // 2026-10-06 → ((2026-1980)<<9)|(10<<5)|6 ; 12:00 → (12<<11)
    assert.equal(d.dosDate, ((46) << 9) | (10 << 5) | 6);
    assert.equal(d.dosTime, (12 << 11));
    const e = BS.dosDateTimeFromIso('garbage');
    assert.equal(e.dosDate, (0 << 9) | (1 << 5) | 1); // 1980-01-01
    assert.equal(e.dosTime, 0);
  });
});

// AC4–AC6: exportSession orchestration with fake deps.
describe('6.6 AC4 — exportSession with fake deps', () => {
  function fakeDb(seed) {
    // seed: {metadata, conditions, events, manifest, chunksBySegment}
    return {
      get: (store, key) => {
        if (store === 'session_metadata') {
          return Promise.resolve(seed.metadata || undefined);
        }
        if (store === 'conditions') {
          return Promise.resolve(seed.conditions || undefined);
        }
        return Promise.resolve(undefined);
      },
      getAll: (store, opts) => {
        if (store === 'events') {
          const sid = opts && opts.lower;
          return Promise.resolve(
            (seed.events || []).filter((e) => e.sessionId === sid));
        }
        if (store === 'recording_manifest') {
          const sid = opts && opts.lower;
          return Promise.resolve(
            (seed.manifest || []).filter((m) => m.sessionId === sid));
        }
        if (store === 'media_chunks') {
          const seg = opts && opts.lower && opts.lower[0];
          return Promise.resolve((seed.chunksBySegment || {})[seg] || []);
        }
        return Promise.resolve([]);
      }
    };
  }

  function seedSession() {
    const segId = 'seg-1';
    const meta = {
      sessionId: SID,
      gameIds: [GID1],
      schemaVersion: '1.0.0',
      extensionVersion: '1.0.0',
      protocolVersion: null,
      sessionCategory: 'training'
    };
    const manifestRec = {
      segmentId: segId,
      sessionId: SID,
      streamKind: 'microphone',
      segmentNumber: 1,
      actualMimeType: 'audio/webm',
      fileExtension: '.webm',
      finalized: true,
      finalizedAtUtc: '2026-10-06T12:01:00.000Z',
      createdAtUtc: '2026-10-06T12:00:00.000Z',
      streamStartedAtUtc: '2026-10-06T12:00:00.000Z',
      streamStartedAtMonotonicMs: 1000,
      clockSegmentId: 'clk-1'
    };
    const anchorEvent = {
      eventId: 'e-anchor-1',
      eventType: 'clock_anchor',
      sessionId: SID,
      gameId: null,
      sourceContext: 'sw',
      sourceSeq: 0,
      clockSegmentId: 'clk-1',
      monotonicMs: 1000,
      appendSeq: 0,
      refs: null,
      payload: { segmentId: 'clk-1', utcEpochMs: 1728216000000, monotonicMs: 1000 }
    };
    const startedEvent = {
      eventId: 'e-gs-1',
      eventType: 'game_started',
      sessionId: SID,
      gameId: GID1,
      sourceContext: 'content',
      sourceSeq: 1,
      clockSegmentId: 'clk-1',
      monotonicMs: 1100,
      appendSeq: 1,
      refs: null,
      payload: { fen: FEN1 }
    };
    const chunkBytes = new Uint8Array([1, 2, 3, 4, 5]);
    return {
      meta, manifestRec,
      seed: {
        metadata: meta,
        conditions: null,
        events: [anchorEvent, startedEvent],
        manifest: [manifestRec],
        chunksBySegment: {
          [segId]: [{
            segmentId: segId,
            chunkIndex: 0,
            createdAtUtc: '2026-10-06T12:00:30.000Z',
            data: new Blob([chunkBytes])
          }]
        }
      }
    };
  }

  function fakeDeps(db, over = {}) {
    const calls = { downloads: [] };
    return {
      calls,
      deps: Object.assign({
        db,
        downloads: {
          download: (opts) => {
            calls.downloads.push(opts);
            return Promise.resolve(42);
          }
        },
        createObjectURL: (blob) => 'blob:fake-url',
        revokeObjectURL: (url) => {},
        nowUtcIso: () => '2026-10-06T13:00:00.000Z'
      }, over)
    };
  }

  it('exports a session end-to-end with fake deps', async () => {
    const { seed } = seedSession();
    const { deps, calls } = fakeDeps(fakeDb(seed));
    const res = await BS.exportSession({
      sessionId: SID,
      stopVerdict: {
        verdict: 'complete',
        warnings: [],
        stopResp: { ok: true, finalizedAtUtc: '2026-10-06T12:01:00.000Z', streams: {} },
        flushResult: { delivered: 2, pending: 0 }
      },
      deps
    });
    assert.equal(res.ok, true);
    assert.ok(res.filename.endsWith('.zip'));
    assert.ok(res.bytes > 0);
    // 3 JSON + 1 media = 4 files.
    assert.equal(res.fileCount, 4);
    assert.equal(calls.downloads.length, 1);
    assert.equal(calls.downloads[0].filename, res.filename);
    assert.equal(calls.downloads[0].saveAs, false);
    assert.equal(calls.downloads[0].url, 'blob:fake-url');
  });

  it('session-not-found when metadata absent', async () => {
    const { deps } = fakeDeps(fakeDb({}));
    const res = await BS.exportSession({ sessionId: SID, stopVerdict: null, deps });
    assert.deepEqual(res, { ok: false, error: 'session-not-found' });
  });

  it('session-not-complete on failed verdict', async () => {
    const { seed } = seedSession();
    const { deps } = fakeDeps(fakeDb(seed));
    const res = await BS.exportSession({
      sessionId: SID,
      stopVerdict: { verdict: 'failed', warnings: [] },
      deps
    });
    assert.deepEqual(res, { ok: false, error: 'session-not-complete' });
  });

  it('malformed sessionId rejects with TypeError', async () => {
    const { deps } = fakeDeps(fakeDb({}));
    await assert.rejects(
      BS.exportSession({ sessionId: 'not-a-uuid', stopVerdict: null, deps }),
      TypeError);
  });

  it('downloads-unavailable when deps lack downloads', async () => {
    const { seed } = seedSession();
    const { deps } = fakeDeps(fakeDb(seed), {
      downloads: undefined, createObjectURL: undefined
    });
    const res = await BS.exportSession({ sessionId: SID, stopVerdict: null, deps });
    assert.deepEqual(res, { ok: false, error: 'downloads-unavailable' });
  });

  it('download-failed when downloads.download rejects', async () => {
    const { seed } = seedSession();
    const { deps, calls } = fakeDeps(fakeDb(seed), {
      downloads: { download: () => Promise.reject(new Error('disk full')) }
    });
    const res = await BS.exportSession({ sessionId: SID, stopVerdict: null, deps });
    assert.equal(res.ok, false);
    assert.ok(res.error.startsWith('download-failed:'));
  });
});

// AC5: readonly proof — mid-export mutation → store-changed-during-export,
// no download.
describe('6.6 AC5 — readonly proof', () => {
  it('mutating events mid-export aborts with no download', async () => {
    const segId = 'seg-1';
    const meta = {
      sessionId: SID, gameIds: [GID1], schemaVersion: '1.0.0',
      extensionVersion: '1.0.0', protocolVersion: null,
      sessionCategory: 'training'
    };
    let events = [{
      eventId: 'e1', eventType: 'clock_anchor', sessionId: SID, gameId: null,
      sourceContext: 'sw', sourceSeq: 0, clockSegmentId: 'c', monotonicMs: 1,
      appendSeq: 0, refs: null,
      payload: { segmentId: 'c', utcEpochMs: 1, monotonicMs: 1 }
    }];
    const db = {
      get: (s, k) => Promise.resolve(s === 'session_metadata' ? meta : undefined),
      getAll: (s, o) => {
        if (s === 'events') { return Promise.resolve(events.slice()); }
        if (s === 'recording_manifest') { return Promise.resolve([]); }
        return Promise.resolve([]);
      }
    };
    const calls = [];
    const deps = {
      db,
      downloads: { download: (x) => { calls.push(x); return Promise.resolve(1); } },
      createObjectURL: () => 'blob:x',
      revokeObjectURL: () => {},
      nowUtcIso: () => '2026-10-06T13:00:00.000Z'
    };
    // Mutate between the before-snapshot and the after-proof: the
    // after-proof recounts, so push a new event after the first read.
    const origGetAll = db.getAll;
    let reads = 0;
    db.getAll = (s, o) => {
      reads++;
      if (s === 'events' && reads === 3) {
        // Third events read = the after-proof recount → inject a row.
        events = events.concat([Object.assign({}, events[0], {
          eventId: 'e2', appendSeq: 1
        })]);
      }
      return origGetAll(s, o);
    };
    const res = await BS.exportSession({ sessionId: SID, stopVerdict: null, deps });
    assert.deepEqual(res, { ok: false, error: 'store-changed-during-export' });
    assert.equal(calls.length, 0, 'no download on store change');
  });
});

// AC6: failure mapping — corrupt records.
describe('6.6 AC6 — corrupt record mapping', () => {
  it('corrupt manifest record → corrupt-recording_manifest-record', async () => {
    const meta = {
      sessionId: SID, gameIds: [GID1], schemaVersion: '1.0.0',
      extensionVersion: '1.0.0', protocolVersion: null,
      sessionCategory: 'training'
    };
    const db = {
      get: (s) => Promise.resolve(s === 'session_metadata' ? meta : undefined),
      getAll: (s) => {
        if (s === 'events') { return Promise.resolve([]); }
        if (s === 'recording_manifest') {
          // Missing streamKind → nameSegmentFiles TypeError.
          return Promise.resolve([{ segmentId: 'x', sessionId: SID }]);
        }
        return Promise.resolve([]);
      }
    };
    const deps = {
      db,
      downloads: { download: () => Promise.resolve(1) },
      createObjectURL: () => 'blob:x',
      revokeObjectURL: () => {},
      nowUtcIso: () => '2026-10-06T13:00:00.000Z'
    };
    const res = await BS.exportSession({ sessionId: SID, stopVerdict: null, deps });
    assert.equal(res.ok, false);
    assert.ok(res.error.startsWith('corrupt-recording_manifest-record:'),
      'got: ' + res.error);
  });
});

// AC7: streaming shape — one Blob per chunk, no full-file buffering.
describe('6.6 AC7 — streaming shape', () => {
  it('ZIP parts reference chunk Blobs without concatenating', async () => {
    const c1 = new Blob([new Uint8Array([1, 2])]);
    const c2 = new Blob([new Uint8Array([3, 4, 5])]);
    const asm = await BS.assembleSegmentChunks({
      chunks: [
        { chunkIndex: 0, data: c1 },
        { chunkIndex: 1, data: c2 }
      ]
    });
    // 6.4 pushes the ORIGINAL Blob references.
    assert.equal(asm.parts[0], c1);
    assert.equal(asm.parts[1], c2);
    const zip = BS.buildZipParts({
      files: [{
        path: 'd/microphone-001.webm',
        dataParts: asm.parts,
        byteLength: asm.byteLength,
        crc32: asm.crc32
      }],
      dosDateTime: BS.dosDateTimeFromIso('2026-10-06T00:00:00.000Z')
    });
    // The media's chunk Blobs appear verbatim in the parts array
    // (header, c1, c2, central dir, end record).
    assert.ok(zip.parts.includes(c1), 'chunk Blob 1 in ZIP parts');
    assert.ok(zip.parts.includes(c2), 'chunk Blob 2 in ZIP parts');
    assert.equal(zip.byteLength,
      zip.parts.reduce((n, p) => n + p.size, 0));
  });
});

// AC8: diff discipline + readonly static pins.
describe('6.6 AC8 — diff discipline and readonly', () => {
  it('exporter.js orchestration performs no writes', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(REPO, 'exporter.js'), 'utf8');
    assert.ok(!/\.put\(|\.delete\(|deleteObjectStore/.test(src),
      'no IDB writes in exporter.js');
    assert.ok(!/sendMessage/.test(src), 'no messaging in exporter.js');
  });

  it('manifest.json gains exactly the downloads permission', () => {
    const m = JSON.parse(require('node:fs').readFileSync(
      require('node:path').join(REPO, 'manifest.json'), 'utf8'));
    assert.deepEqual(m.permissions,
      ['offscreen', 'tabCapture', 'storage', 'downloads']);
  });

  it('PLAN.md is unmodified', () => {
    const diff = execSync('git diff HEAD -- PLAN.md', { cwd: REPO }).toString();
    assert.equal(diff, '');
  });

  it('no new event types, stores, or offscreen messages', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(REPO, 'exporter.js'), 'utf8');
    // The export-request envelope is SW-side (chrome.runtime), not offscreen.
    assert.ok(!/MSG_[A-Z_]+ *=/.test(src), 'no offscreen MSG_* in exporter.js');
    const sw = require('node:fs').readFileSync(
      require('node:path').join(REPO, 'sw.js'), 'utf8');
    assert.ok(sw.includes('export-request'), 'sw.js handles export-request');
    assert.ok(sw.includes("importScripts(") && sw.includes('exporter.js'),
      'sw.js imports exporter.js');
  });
});

// ------------------------------------------------------------------
// 6.7 — repeatable export from retained local data
// ------------------------------------------------------------------
describe('6.7 AC1 — re-export is byte-identical except exportedAtUtc', () => {
  // Reuse the 6.6 AC4 fakes via closure: we redefine them here to keep
  // the 6.7 block self-contained (the 6.6 block's helpers are scoped to
  // its describe).
  const SID67 = '11111111-1111-4111-8111-111111111111';
  const GID67 = '22222222-2222-4222-8222-222222222222';

  function fakeDb67(seed) {
    return {
      get: (store, key) => {
        if (store === 'session_metadata') {
          return Promise.resolve(seed.metadata || undefined);
        }
        if (store === 'conditions') {
          return Promise.resolve(seed.conditions || undefined);
        }
        return Promise.resolve(undefined);
      },
      getAll: (store, opts) => {
        if (store === 'events') {
          const sid = opts && opts.lower;
          return Promise.resolve(
            (seed.events || []).filter((e) => e.sessionId === sid));
        }
        if (store === 'recording_manifest') {
          const sid = opts && opts.lower;
          return Promise.resolve(
            (seed.manifest || []).filter((m) => m.sessionId === sid));
        }
        if (store === 'media_chunks') {
          const seg = opts && opts.lower && opts.lower[0];
          return Promise.resolve((seed.chunksBySegment || {})[seg] || []);
        }
        return Promise.resolve([]);
      }
    };
  }

  function seed67() {
    const segId = 'seg-67';
    const meta = {
      sessionId: SID67,
      gameIds: [GID67],
      schemaVersion: '1.0.0',
      extensionVersion: '1.0.0',
      protocolVersion: null,
      sessionCategory: 'training'
    };
    const manifestRec = {
      segmentId: segId,
      sessionId: SID67,
      streamKind: 'microphone',
      segmentNumber: 1,
      actualMimeType: 'audio/webm',
      fileExtension: '.webm',
      finalized: true,
      finalizedAtUtc: '2026-10-06T12:01:00.000Z',
      createdAtUtc: '2026-10-06T12:00:00.000Z',
      streamStartedAtUtc: '2026-10-06T12:00:00.000Z',
      streamStartedAtMonotonicMs: 1000,
      clockSegmentId: 'clk-67'
    };
    const anchorEvent = {
      eventId: 'e-67-anchor',
      eventType: 'clock_anchor',
      sessionId: SID67,
      gameId: null,
      sourceContext: 'sw',
      sourceSeq: 0,
      clockSegmentId: 'clk-67',
      monotonicMs: 1000,
      appendSeq: 0,
      refs: null,
      payload: { segmentId: 'clk-67', utcEpochMs: 1728216000000, monotonicMs: 1000 }
    };
    const chunkBytes = new Uint8Array([10, 20, 30, 40, 50, 60]);
    return {
      metadata: meta,
      conditions: null,
      events: [anchorEvent],
      manifest: [manifestRec],
      chunksBySegment: {
        [segId]: [{
          segmentId: segId,
          chunkIndex: 0,
          createdAtUtc: '2026-10-06T12:00:30.000Z',
          data: new Blob([chunkBytes])
        }]
      }
    };
  }

  // Run exportSession and capture the ZIP Blob bytes.
  async function exportBytes(seed, nowIso) {
    let captured = null;
    const deps = {
      db: fakeDb67(seed),
      downloads: {
        download: () => Promise.resolve(1)
      },
      createObjectURL: (blob) => { captured = blob; return 'blob:fake'; },
      revokeObjectURL: () => {},
      nowUtcIso: () => nowIso
    };
    const res = await BS.exportSession({
      sessionId: SID67,
      stopVerdict: { verdict: 'complete', warnings: [] },
      deps
    });
    assert.ok(res.ok, 'export must succeed, got: ' + JSON.stringify(res));
    assert.ok(captured, 'createObjectURL must receive the ZIP blob');
    const buf = Buffer.from(await captured.arrayBuffer());
    return buf;
  }

  it('two exports with different clocks differ only in exportedAtUtc', async () => {
    const seed = seed67();
    const a = await exportBytes(seed, '2026-10-06T14:00:00.000Z');
    const b = await exportBytes(seed, '2026-10-06T15:00:00.000Z');
    // Parse both ZIPs with buildZipParts' inverse: use the central
    // directory to extract file entries, then compare per-file bytes.
    // Simpler honest check: the ZIPs must have equal length and differ
    // only where exportedAtUtc appears. We verify by unzipping via the
    // system unzip binary (6.6 AC1 precedent) and diffing contents.
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { execSync } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp67-'));
    try {
      const za = path.join(dir, 'a.zip');
      const zb = path.join(dir, 'b.zip');
      fs.writeFileSync(za, a);
      fs.writeFileSync(zb, b);
      execSync(`unzip -q -o ${za} -d ${dir}/a`);
      execSync(`unzip -q -o ${zb} -d ${dir}/b`);
      const listA = execSync(`cd ${dir}/a && find . -type f | sort`).toString().trim().split('\n');
      const listB = execSync(`cd ${dir}/b && find . -type f | sort`).toString().trim().split('\n');
      assert.deepEqual(listA, listB, 'same file list in both exports');
      for (const f of listA) {
        const pa = path.join(dir, 'a', f);
        const pb = path.join(dir, 'b', f);
        const ca = fs.readFileSync(pa, 'utf8');
        const cb = fs.readFileSync(pb, 'utf8');
        if (f.endsWith('metadata.json') || f.endsWith('media-sync.json')) {
          // Only exportedAtUtc may differ.
          const ja = JSON.parse(ca);
          const jb = JSON.parse(cb);
          assert.ok(ja.exportedAtUtc === '2026-10-06T14:00:00.000Z', 'a has its clock');
          assert.ok(jb.exportedAtUtc === '2026-10-06T15:00:00.000Z', 'b has its clock');
          delete ja.exportedAtUtc;
          delete jb.exportedAtUtc;
          assert.deepEqual(ja, jb, f + ' identical except exportedAtUtc');
        } else {
          assert.ok(Buffer.from(ca, 'binary').equals(Buffer.from(cb, 'binary')),
            f + ' byte-identical across re-exports');
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two exports with the same clock are fully byte-identical', async () => {
    const seed = seed67();
    const a = await exportBytes(seed, '2026-10-06T14:00:00.000Z');
    const b = await exportBytes(seed, '2026-10-06T14:00:00.000Z');
    assert.ok(a.equals(b), 'ZIP bytes fully identical with fixed clock');
  });
});

describe('6.7 AC3 — Download button stays enabled for re-export', () => {
  it('session_controls.js keeps the Download button enabled after successful export', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(REPO, 'session_controls.js'), 'utf8');
    // The 6.6 contract requires the button to stay enabled after success
    // for 6.7 re-export. The success path explicitly says "Keep the
    // button enabled for re-export". We assert:
    // 1. The success-path comment is present (the documented guarantee).
    // 2. The only setDownloadEnabled(false) is for the Start phase
    //    (not exportable while starting), not for post-export.
    assert.ok(src.includes('Keep the\n          // button enabled for re-export') ||
              src.includes('Keep the button enabled for re-export'),
      'success path documents the re-export guarantee');
    const disables = src.split('\n').filter((l) =>
      /setDownloadEnabled\s*\(\s*false\s*\)/.test(l));
    for (const l of disables) {
      assert.ok(l.includes('while starting'),
        'setDownloadEnabled(false) only while starting, not after export: ' + l.trim());
    }
  });
});

describe('6.7 AC4 — diff discipline', () => {
  it('6.7 adds no product-code changes', () => {
    const diff = execSync('git diff HEAD --stat', { cwd: REPO }).toString();
    const productFiles = ['exporter.js', 'sw.js', 'manifest.json',
      'session_controls.js', 'content.js', 'recorder.js'];
    for (const f of productFiles) {
      const lines = diff.split('\n').filter((l) => l.includes(f + ' '));
      assert.ok(lines.length === 0, f + ' must be untouched by 6.7');
    }
  });

  it('PLAN.md is unmodified', () => {
    const diff = execSync('git diff HEAD -- PLAN.md', { cwd: REPO }).toString();
    assert.equal(diff, '');
  });
});
