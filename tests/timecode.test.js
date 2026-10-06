// tests/timecode.test.js
//
// V1 verification for task 4.12 (PLAN.md §4.12) per
// .autodev/evidence/4.12.contract.md. Covers acceptance criteria AC1–AC8
// (static/unit). AC9–AC10 (real Chrome) run separately via
// ~/workspace/tools/ext-verify/sw-timecode.js; AC11 (real-device
// alignment reality) is deferred to owner verification (§7).
//
// 4.12 is the first task allowed to do timestamp arithmetic: timecode.js
// is the single canonical home for the media-time → document-clock →
// wall-clock conversions, the played-vs-failed marker disambiguation
// rule, and the discontinuity-continuity rule. It is a pure library —
// zero platform surface, no persistence (every offset is a pure
// function of already-stored values; persisting them would violate the
// standing no-derivable-values rule).
//
// Run: node --test tests/timecode.test.js   (from repo root)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BS_TC = require(path.join(REPO, 'timecode.js'));
const BS_ENV = require(path.join(REPO, 'event_envelope.js'));
const BS_FMT = require(path.join(REPO, 'format_support.js'));
const BS_DB = require(path.join(REPO, 'db.js'));

// Strip // and /* */ comments so the scan pins test executable code,
// not prose (4.6/4.7/4.10 precedent).
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

// A valid uuid-v4 fixture (4- nibble, [89ab] variant).
const UUID1 = '123e4567-e89b-42d3-a456-426614174000';
const UUID2 = '223e4567-e89b-42d3-a456-426614174001';

// A well-formed clock anchor triple (also valid for
// event_envelope.requireValidClockAnchor: exact keys, non-negative
// integer utcEpochMs, monotonicMs >= 0).
const ANCHOR = {
  segmentId: UUID1,
  utcEpochMs: 1700000000000,
  monotonicMs: 1000
};

// ------------------------------------------------------------------
// AC1 — media→clock conversion.
// ------------------------------------------------------------------

describe('AC1 — media→clock conversion', () => {
  it('mediaToMonotonicMs adds timecode to the stream start', () => {
    assert.equal(BS_TC.mediaToMonotonicMs(1000, 250), 1250);
    // Timecode 0 ≈ the start() call time (§3.1 of the contract).
    assert.equal(BS_TC.mediaToMonotonicMs(1000, 0), 1000);
  });

  it('the §3.1 assumption is documented on the function', () => {
    const src = fs.readFileSync(path.join(REPO, 'timecode.js'), 'utf8');
    assert.ok(/timecode 0/i.test(src),
      'the timecode-0 ≈ start() assumption must be documented');
  });

  it('null/undefined in → null out (unknown is null)', () => {
    assert.equal(BS_TC.mediaToMonotonicMs(null, 250), null);
    assert.equal(BS_TC.mediaToMonotonicMs(1000, null), null);
    assert.equal(BS_TC.mediaToMonotonicMs(undefined, undefined), null);
  });

  it('non-finite → null (platform garbage is unknown, not a guess)', () => {
    assert.equal(BS_TC.mediaToMonotonicMs(NaN, 250), null);
    assert.equal(BS_TC.mediaToMonotonicMs(1000, Infinity), null);
    assert.equal(BS_TC.mediaToMonotonicMs(1000, -Infinity), null);
  });

  it('negative timecodeMs → null (unusable platform data)', () => {
    assert.equal(BS_TC.mediaToMonotonicMs(1000, -1), null);
  });

  it('wrong-type non-null input → TypeError', () => {
    assert.throws(() => BS_TC.mediaToMonotonicMs('1000', 250), TypeError);
    assert.throws(() => BS_TC.mediaToMonotonicMs(1000, '250'), TypeError);
    assert.throws(() => BS_TC.mediaToMonotonicMs({}, 250), TypeError);
    assert.throws(() => BS_TC.mediaToMonotonicMs(1000, true), TypeError);
  });
});

// ------------------------------------------------------------------
// AC2 — canonical wall derivation.
// ------------------------------------------------------------------

describe('AC2 — canonical wall derivation', () => {
  it('wallUtcMs equals event_envelope.deriveWallUtcMs on a fixture battery', () => {
    for (const m of [1000, 0, 1500, 999.5, 1000000, 1000.0001]) {
      assert.equal(
        BS_TC.wallUtcMs(ANCHOR, m),
        BS_ENV.deriveWallUtcMs(ANCHOR, m),
        `wallUtcMs must equal deriveWallUtcMs at monotonicMs=${m}`);
    }
    // Spot-check the formula itself: utcEpochMs + (m - anchor.monotonicMs).
    assert.equal(BS_TC.wallUtcMs(ANCHOR, 1200), 1700000000000 + 200);
  });

  it('null monotonicMs → null; malformed anchor → TypeError', () => {
    assert.equal(BS_TC.wallUtcMs(ANCHOR, null), null);
    assert.equal(BS_TC.wallUtcMs(ANCHOR, undefined), null);
    assert.equal(BS_TC.wallUtcMs(ANCHOR, NaN), null);
    // An anchor is never "unknown null" — the caller resolves it or
    // does not call (contract §2).
    assert.throws(() => BS_TC.wallUtcMs(null, 1200), TypeError);
    assert.throws(() => BS_TC.wallUtcMs(undefined, 1200), TypeError);
    assert.throws(() => BS_TC.wallUtcMs('anchor', 1200), TypeError);
    assert.throws(() => BS_TC.wallUtcMs({}, 1200), TypeError);
    assert.throws(() => BS_TC.wallUtcMs(
      { segmentId: 'not-a-uuid', utcEpochMs: 1, monotonicMs: 1 }, 1200),
      TypeError);
    assert.throws(() => BS_TC.wallUtcMs(
      { segmentId: UUID1, utcEpochMs: NaN, monotonicMs: 1 }, 1200),
      TypeError);
    assert.throws(() => BS_TC.wallUtcMs(
      { segmentId: UUID1, utcEpochMs: 1, monotonicMs: 'x' }, 1200),
      TypeError);
    assert.throws(() => BS_TC.wallUtcMs(ANCHOR, '1200'), TypeError);
  });
});

// ------------------------------------------------------------------
// AC3 — compositions.
// ------------------------------------------------------------------

describe('AC3 — compositions', () => {
  it('chunkWallUtcMs composes media→clock→wall', () => {
    assert.equal(BS_TC.chunkWallUtcMs(ANCHOR, 1000, 250),
      1700000000000 + 250);
    // null timecode → null: unknown, NEVER arrival-time-backed (§3.2).
    assert.equal(BS_TC.chunkWallUtcMs(ANCHOR, 1000, null), null);
    assert.equal(BS_TC.chunkWallUtcMs(ANCHOR, null, 250), null);
    assert.throws(() => BS_TC.chunkWallUtcMs(null, 1000, 250), TypeError);
    assert.throws(() => BS_TC.chunkWallUtcMs(ANCHOR, '1000', 250), TypeError);
  });

  it('streamStartWallUtcMs gives the wall time recording began', () => {
    assert.equal(BS_TC.streamStartWallUtcMs(ANCHOR, 1500),
      1700000000000 + 500);
    assert.equal(BS_TC.streamStartWallUtcMs(ANCHOR, null), null);
    assert.throws(() => BS_TC.streamStartWallUtcMs(null, 1500), TypeError);
  });

  it('markerWallUtcMs converts the marker event time to wall', () => {
    assert.equal(BS_TC.markerWallUtcMs(ANCHOR, 1200),
      1700000000000 + 200);
    assert.equal(BS_TC.markerWallUtcMs(ANCHOR, null), null);
  });

  it('markerMediaOffsetMs may be negative (honest, not clamped)', () => {
    // Marker at 1200, stream started at 1500: the marker precedes
    // this stream's media — negative offset, honestly reported.
    assert.equal(BS_TC.markerMediaOffsetMs(1200, 1500), -300);
    assert.equal(BS_TC.markerMediaOffsetMs(1600, 1500), 100);
    assert.equal(BS_TC.markerMediaOffsetMs(1500, 1500), 0);
    assert.equal(BS_TC.markerMediaOffsetMs(null, 1500), null);
    assert.equal(BS_TC.markerMediaOffsetMs(1200, null), null);
    assert.throws(() => BS_TC.markerMediaOffsetMs('1200', 1500), TypeError);
  });

  it('streamStartOffsetMs: two-stream offset table', () => {
    const starts = [1000, 1250, 1100]; // per-stream 4.6 start times
    const ref = Math.min(...starts);
    const offsets = starts.map((s) => BS_TC.streamStartOffsetMs(ref, s));
    assert.deepEqual(offsets, [0, 250, 100]);
    assert.equal(BS_TC.streamStartOffsetMs(1000, 1000), 0);
    assert.equal(BS_TC.streamStartOffsetMs(null, 1250), null);
    assert.throws(() => BS_TC.streamStartOffsetMs(1000, '1250'), TypeError);
  });
});

// ------------------------------------------------------------------
// AC4 — marker disambiguation.
// ------------------------------------------------------------------

describe('AC4 — marker disambiguation', () => {
  it('isUsableSyncMarker truth table', () => {
    assert.equal(BS_TC.isUsableSyncMarker({ status: 'played' }), true);
    assert.equal(BS_TC.isUsableSyncMarker({ status: 'shown' }), true);
    assert.equal(BS_TC.isUsableSyncMarker({ status: 'failed' }), false);
    assert.equal(BS_TC.isUsableSyncMarker({ status: 'skipped' }), false);
    // A failed audible marker means no beep exists in any recording
    // to align against — its timestamp is not a media landmark.
    assert.equal(BS_TC.isUsableSyncMarker(
      { markerId: UUID1, phase: 'start', modality: 'audible',
        status: 'failed', error: 'NotAllowedError', detail: null }),
      false);
  });

  it('malformed payload → false, never throws', () => {
    assert.equal(BS_TC.isUsableSyncMarker(null), false);
    assert.equal(BS_TC.isUsableSyncMarker(undefined), false);
    assert.equal(BS_TC.isUsableSyncMarker('played'), false);
    assert.equal(BS_TC.isUsableSyncMarker({}), false);
    assert.equal(BS_TC.isUsableSyncMarker({ status: 42 }), false);
    assert.equal(BS_TC.isUsableSyncMarker([]), false);
  });

  it('stop double-beep rule: earliest played audible per markerId by appendSeq', () => {
    // Selector example (§4 of the contract): the two stop beeps share
    // one markerId; each beep has its own 'played' event; alignment
    // uses the EARLIEST 'played' audible event per markerId, ordered
    // by the event log's appendSeq. The join logic belongs to §6.3 —
    // this pins the rule 4.12 requires.
    function earliestPlayedAudiblePerMarkerId(events) {
      const best = new Map();
      for (const e of events) {
        if (!e || e.eventType !== 'sync_marker') {
          continue;
        }
        const p = e.payload || {};
        if (p.modality !== 'audible' || !BS_TC.isUsableSyncMarker(p)) {
          continue;
        }
        const cur = best.get(p.markerId);
        if (cur === undefined || e.appendSeq < cur.appendSeq) {
          best.set(p.markerId, e);
        }
      }
      return best;
    }

    const mk = (seq, status, markerId) => ({
      eventType: 'sync_marker',
      appendSeq: seq,
      payload: { markerId, phase: 'stop', modality: 'audible',
        status, error: null, detail: null }
    });
    const events = [
      mk(7, 'played', UUID1),   // second beep (later)
      mk(3, 'played', UUID1),   // first beep (earliest) — the landmark
      mk(5, 'failed', UUID2),   // excluded: no acoustic anchor
      mk(9, 'played', UUID2),
      { eventType: 'game_started', appendSeq: 1, payload: {} }
    ];
    const best = earliestPlayedAudiblePerMarkerId(events);
    assert.equal(best.get(UUID1).appendSeq, 3);
    assert.equal(best.get(UUID2).appendSeq, 9);
    assert.equal(best.size, 2);
  });
});

// ------------------------------------------------------------------
// AC5 — continuity predicate.
// ------------------------------------------------------------------

describe('AC5 — continuity predicate', () => {
  it('no discontinuities → true', () => {
    assert.equal(BS_TC.mediaRangeIsContinuous([], 1000, 2000), true);
  });

  it('discontinuity inside the interval → false', () => {
    assert.equal(BS_TC.mediaRangeIsContinuous([1500], 1000, 2000), false);
  });

  it('closed interval: on the boundary → false', () => {
    assert.equal(BS_TC.mediaRangeIsContinuous([1000], 1000, 2000), false);
    assert.equal(BS_TC.mediaRangeIsContinuous([2000], 1000, 2000), false);
  });

  it('outside the interval (any order) → true', () => {
    assert.equal(BS_TC.mediaRangeIsContinuous([999, 2001], 1000, 2000), true);
    assert.equal(BS_TC.mediaRangeIsContinuous([2500, 500], 1000, 2000), true);
  });

  it('null discontinuity list or bounds → null (unknown)', () => {
    assert.equal(BS_TC.mediaRangeIsContinuous(null, 1000, 2000), null);
    assert.equal(BS_TC.mediaRangeIsContinuous(undefined, 1000, 2000), null);
    assert.equal(BS_TC.mediaRangeIsContinuous([], null, 2000), null);
    assert.equal(BS_TC.mediaRangeIsContinuous([], 1000, null), null);
  });

  it('fromMono > toMono → RangeError', () => {
    assert.throws(() => BS_TC.mediaRangeIsContinuous([], 2000, 1000),
      RangeError);
    assert.throws(() => BS_TC.mediaRangeIsContinuous([1500], 2000, 1000),
      RangeError);
  });

  it('wrong-type input → TypeError', () => {
    assert.throws(() => BS_TC.mediaRangeIsContinuous('x', 1000, 2000),
      TypeError);
    assert.throws(() => BS_TC.mediaRangeIsContinuous([1500], '1000', 2000),
      TypeError);
    // Malformed elements are malformed input, not unknown.
    assert.throws(() => BS_TC.mediaRangeIsContinuous([1500, null], 1000, 2000),
      TypeError);
    assert.throws(() => BS_TC.mediaRangeIsContinuous([NaN], 1000, 2000),
      TypeError);
  });
});

// ------------------------------------------------------------------
// AC6 — purity and no persistence.
// ------------------------------------------------------------------

describe('AC6 — purity and no persistence', () => {
  it('timecode.js has zero platform surface in executable code', () => {
    const code = codeOnly(
      fs.readFileSync(path.join(REPO, 'timecode.js'), 'utf8'));
    assert.ok(!/indexedDB/.test(code), 'no indexedDB');
    assert.ok(!/chrome\./.test(code), 'no chrome.*');
    assert.ok(!/document\./.test(code), 'no document.*');
    assert.ok(!/Date\.now\s*\(/.test(code), 'no Date.now()');
    assert.ok(!/performance\.now\s*\(/.test(code), 'no performance.now()');
    // A library, not a pipeline stage: no events, no messages, no
    // storage calls of any kind.
    assert.ok(!/EVENT_TYPE/.test(code), 'no event types');
    assert.ok(!/sendMessage/.test(code), 'no messaging');
    assert.ok(!/localStorage/.test(code), 'no localStorage');
  });

  it('MANIFEST_KEYS is exactly the 18-key shape (4.12 stored nothing; 4.13 widens deliberately)', () => {
    // Honest cumulative evolution (4.13): MANIFEST_KEYS widens 16 → 18
    // with the 4.13-owned segmentNumber + finalizedAtUtc (contract §2).
    assert.equal(BS_FMT.MANIFEST_KEYS.length, 18);
  });

  it('media_chunks shape unchanged; DB_VERSION still 2', () => {
    assert.equal(BS_DB.DB.DB_VERSION, 2);
    const src = fs.readFileSync(path.join(REPO, 'db.js'), 'utf8');
    assert.ok(
      /name: 'media_chunks',\s*\n\s*keyPath: \['segmentId', 'chunkIndex'\]/
        .test(src),
      'media_chunks keeps its compound key [segmentId, chunkIndex]');
  });

  it('no producer or consumer module was modified by 4.12 (4.13 and 4.14 changes are deliberate)', () => {
    // Honest cumulative evolution (4.13): 4.13 deliberately modifies
    // stream_starter.js (discardActiveStream seam), format_support.js
    // (MANIFEST_KEYS 16 → 18), recorder.js (recorder-stop-streams
    // handler + getFinalizer), and recorder.html (finalizer.js script
    // tag) — see .autodev/evidence/4.13.contract.md. Honest cumulative
    // evolution (4.14): 4.14 deliberately adds the additive
    // getStreamHealth seam (+ health mirror, nowUtcIso opt, retention
    // calls) to track_monitor.js — see
    // .autodev/evidence/4.14.contract.md. The modules neither task
    // touches stay untouched.
    const names = execSync('git diff HEAD --name-only', { cwd: REPO })
      .toString().split('\n').filter((l) => l.trim());
    for (const f of ['chunk_writer.js', 'clock_link.js',
      'sync_marker.js', 'sync_flash.js', 'db.js']) {
      assert.ok(!names.includes(f), `${f} must be untouched by 4.12/4.13/4.14`);
    }
  });
});

// ------------------------------------------------------------------
// AC7 — validation discipline (cross-cutting).
// ------------------------------------------------------------------

describe('AC7 — validation discipline', () => {
  it('createTimecode() exposes all nine functions', () => {
    const tc = BS_TC.createTimecode();
    for (const name of ['mediaToMonotonicMs', 'wallUtcMs', 'chunkWallUtcMs',
      'streamStartWallUtcMs', 'markerMediaOffsetMs', 'markerWallUtcMs',
      'streamStartOffsetMs', 'isUsableSyncMarker',
      'mediaRangeIsContinuous']) {
      assert.equal(typeof tc[name], 'function', `${name} exposed`);
      assert.equal(typeof BS_TC[name], 'function', `${name} on namespace`);
    }
  });

  it('the nine functions are deterministic (pure)', () => {
    const a = BS_TC.chunkWallUtcMs(ANCHOR, 1000, 250);
    const b = BS_TC.chunkWallUtcMs(ANCHOR, 1000, 250);
    assert.equal(a, b);
    assert.equal(BS_TC.isUsableSyncMarker({ status: 'played' }),
      BS_TC.isUsableSyncMarker({ status: 'played' }));
  });

  it('null/undefined/non-finite → null across the board', () => {
    assert.equal(BS_TC.wallUtcMs(ANCHOR, Infinity), null);
    assert.equal(BS_TC.streamStartWallUtcMs(ANCHOR, NaN), null);
    assert.equal(BS_TC.markerWallUtcMs(ANCHOR, undefined), null);
    assert.equal(BS_TC.streamStartOffsetMs(undefined, 5), null);
    assert.equal(BS_TC.markerMediaOffsetMs(5, -Infinity), null);
  });
});

// ------------------------------------------------------------------
// AC8 — changed-files discipline.
// ------------------------------------------------------------------

describe('AC8 — changed-files discipline', () => {
  it('the 4.12 working-tree diff touches only 4.12 files', () => {
    // Honest cumulative evolution (4.12): recording timecode/offset
    // arithmetic legitimately adds timecode.js (the pure nine-function
    // alignment library — media→clock→wall conversions, marker
    // disambiguation, continuity rule), persists nothing new
    // (MANIFEST_KEYS stays 16, DB_VERSION stays 2, no recorder.html
    // wiring — a library, not a pipeline stage), records the ## 4.12
    // decisions, and adds its test + evidence; its files join the
    // allowlists.
    const allowed = new Set([
      'timecode.js',
      'tests/timecode.test.js',
      '.autodev/evidence/4.12.contract.md',
      '.autodev/evidence/4.12.build.md',
      // Honest cumulative evolution: 4.12's review/behavior evidence
      // lands after the pins were evolved (2.x/3.x/4.1-4.11 precedent).
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
      'tests/clock_link.test.js',
      'tests/db.test.js',
      'tests/device_selection.test.js',
      'tests/event_envelope.test.js',
      'tests/format_support.test.js',
      'tests/game_lifecycle.test.js',
      'tests/game_records.test.js',
      'tests/history_tracker.test.js',
      'tests/lifecycle.test.js',
      'tests/manifest_sw.test.js',
      'tests/recording_host.test.js',
      'tests/retention.test.js',
      'tests/sender.test.js',
      'tests/session_conditions.test.js',
      'tests/session_identity.test.js',
      'tests/session_store.test.js',
      'tests/speech.test.js',
      'tests/status_indicator.test.js',
      'tests/stream_starter.test.js',
      'tests/sync_marker.test.js',
      'tests/track_monitor.test.js',
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
    ]);
    const out = execSync('git diff HEAD --name-only', { cwd: REPO })
      .toString().trim();
    const changed = out === '' ? [] : out.split('\n');
    const stray = changed.filter((f) => !allowed.has(f));
    assert.deepEqual(stray, [],
      '4.12 has diff hunks beyond its files:\n' + stray.join('\n'));
  });

  it('no new event types; no new channel message', () => {
    const code = codeOnly(
      fs.readFileSync(path.join(REPO, 'timecode.js'), 'utf8'));
    assert.ok(!/EVENT_TYPE/.test(code), 'library defines no event type');
    assert.ok(!/sendEventMessage/.test(code), 'library sends no events');
    assert.ok(!/msg:\s*['"]recorder-/.test(code),
      'library adds no channel message');
  });

  it('PLAN.md is unmodified', () => {
    const diff = execSync('git diff HEAD -- PLAN.md', { cwd: REPO }).toString();
    assert.equal(diff, '', 'PLAN.md must be unmodified');
  });

  it('content scripts are byte-identical to HEAD', () => {
    const names = execSync('git diff HEAD --name-only', { cwd: REPO })
      .toString().split('\n').filter((l) => l.trim());
    // Honest cumulative evolution (5.1): content.js + chess_utils.js leave
    // this list — 5.1 legitimately wires the Start/Stop install into
    // content.js and adds the additive getLastObservedEnd getter to
    // chess_utils.js (pinned in tests/session_controls.test.js AC7).
    const contentScripts = ['sounds.js',
      'status_indicator.js', 'lifecycle.js', 'sender.js', 'event_envelope.js',
      'game_records.js', 'chess.min.js'];
    for (const f of contentScripts) {
      assert.ok(!names.includes(f), `${f} must be byte-identical to HEAD`);
    }
  });
});
