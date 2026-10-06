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
      '.autodev/DECISIONS.md',
      '.autodev/evidence/6.1.build.md',
      '.autodev/evidence/6.1.contract.md',
      // 6.1's review/behavior evidence lands after the pins are
      // evolved (2.x/3.x/4.x/5.x precedent).
      '.autodev/evidence/6.1.review.md',
      '.autodev/evidence/6.1.behavior.md',
      '.autodev/evidence/section-5.audit.md',
      '.autodev/evidence/section-6.architecture.md',
      'exporter.js',
      'tests/exporter.test.js',
      // Honest cumulative evolution: 6.1 (generate metadata.json from
      // stored context and observed completion status) legitimately
      // adds the new SW-side exporter.js module (pure buildMetadataJson
      // builder; 6.6 owns the orchestration/permission/message), its
      // test file, and its evidence; its files join the allowlists.
      // No new channel messages, event types, stores, or permissions
      // in 6.1.
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
        'tests/timecode.test.js',
        'tests/track_monitor.test.js',
        'tests/visibility.test.js',
        'tests/writer.test.js'
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
