// tests/event_envelope.test.js
//
// V1 verification for task 1.3 (PLAN.md §1.3.1–§1.3.5) per
// .autodev/evidence/1.3.contract.md. Covers acceptance criteria AC1–AC17,
// AC19, AC21–AC23.
// Deferred: AC18 append assignment (→ §2.4), AC20 reference roles
// (→ §3.2/§3.4/§4.10), in-context anchor capture (→ §2.3/§2.7/§4.1, V2/V3),
// per-segment sourceSeq counters (→ §2.3), SW-restart re-anchor (→ §2.6/§2.7).
//
// Run: node --test tests/event_envelope.test.js   (from repo root)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const Envelope = require('../event_envelope.js');
const Conditions = require('../session_conditions.js');
const REPO_ROOT = path.join(__dirname, '..');
const SOURCE_PATH = path.join(REPO_ROOT, 'event_envelope.js');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Known-good UUID v4 fixtures (3rd group starts with 4, 4th with 8/9/a/b).
const SID = '43f267dd-c44d-42ee-b99d-5537c5a4f95e';
const GID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const SEG = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ATTEMPT = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';

const EVENT_KEY_ORDER = [
  'eventId', 'eventType', 'sessionId', 'gameId', 'sourceContext',
  'sourceSeq', 'clockSegmentId', 'monotonicMs', 'appendSeq', 'refs', 'payload'
];

function makeEventInput(overrides) {
  return Object.assign({
    eventType: 'conditions_changed',
    sessionId: SID,
    gameId: GID,
    sourceContext: 'content_script',
    sourceSeq: 42,
    clockSegmentId: SEG,
    monotonicMs: 123456.789,
    payload: { changes: {} }
  }, overrides);
}

function makeAnchor(overrides) {
  return Object.assign({
    segmentId: SEG,
    utcEpochMs: 1728096000123,
    monotonicMs: 1234.567
  }, overrides);
}

// Temporarily replace a configurable globalThis property; returns restore().
function swapGlobal(name, value) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: value
  });
  return () => Object.defineProperty(globalThis, name, desc);
}

function assertPlainError(fn) {
  // "plain Error": Error, but neither TypeError nor RangeError.
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof Error, 'must throw an Error');
    assert.ok(!(e instanceof TypeError), 'must not be a TypeError');
    assert.ok(!(e instanceof RangeError), 'must not be a RangeError');
    return;
  }
  assert.fail('expected a plain Error to be thrown');
}

describe('exports', () => {
  it('exposes exactly the contract exports and no 1.1/1.2 names', () => {
    const expected = [
      'EVENT_TYPES', 'SOURCE_CONTEXTS', 'EVENT_TYPE_RE',
      'newEventId', 'newClockSegmentId', 'isEventType', 'isSourceContext',
      'createClockAnchor', 'captureClockAnchor', 'requireValidClockAnchor',
      'createAnchorEvent', 'createEvent', 'requireValidEvent', 'isValidEvent',
      'deriveWallUtcMs'
    ].sort();
    assert.deepStrictEqual(Object.keys(Envelope).sort(), expected);
  });

  it('does not re-export isUuidV4 (name taken by 1.1) or 1.2 constants', () => {
    assert.strictEqual(Envelope.isUuidV4, undefined);
    assert.strictEqual(Envelope.CONDITION_CHANGE_EVENT_TYPE, undefined);
  });

  it('EVENT_TYPES is frozen with only CLOCK_ANCHOR (no segment lifecycle types)', () => {
    assert.deepStrictEqual(Envelope.EVENT_TYPES, { CLOCK_ANCHOR: 'clock_anchor' });
    assert.ok(Object.isFrozen(Envelope.EVENT_TYPES));
  });

  it('SOURCE_CONTEXTS is the frozen 3-value vocabulary', () => {
    assert.deepStrictEqual(
      [...Envelope.SOURCE_CONTEXTS],
      ['content_script', 'service_worker', 'recording_context']
    );
    assert.ok(Object.isFrozen(Envelope.SOURCE_CONTEXTS));
  });

  it('EVENT_TYPE_RE enforces flat snake_case syntax', () => {
    assert.ok(Envelope.isEventType('clock_anchor'));
    assert.ok(Envelope.isEventType('conditions_changed'));
    assert.ok(!Envelope.isEventType('MoveMade'));
    assert.ok(!Envelope.isEventType('move.made'));
    assert.ok(!Envelope.isEventType('move made'));
    assert.ok(!Envelope.isEventType(''));
    assert.ok(!Envelope.isEventType('a'.repeat(65)));
    assert.ok(Envelope.isEventType('a'.repeat(64)));
    assert.ok(!Envelope.isEventType(42));
    assert.ok(!Envelope.isEventType(null));
  });

  it('isSourceContext is a membership check over SOURCE_CONTEXTS', () => {
    assert.ok(Envelope.isSourceContext('content_script'));
    assert.ok(Envelope.isSourceContext('service_worker'));
    assert.ok(Envelope.isSourceContext('recording_context'));
    assert.ok(!Envelope.isSourceContext('popup'));
    assert.ok(!Envelope.isSourceContext('content-script'));
    assert.ok(!Envelope.isSourceContext(''));
    assert.ok(!Envelope.isSourceContext(null));
  });
});

describe('AC2 — event IDs', () => {
  it('newEventId/newClockSegmentId produce unique shape-valid UUID v4s (10k)', () => {
    const ids = new Set();
    for (let i = 0; i < 10000; i++) {
      const id = Envelope.newEventId();
      assert.ok(UUID_V4_RE.test(id), 'uuid-v4 shape: ' + id);
      ids.add(id);
    }
    assert.strictEqual(ids.size, 10000);
  });

  it('newClockSegmentId is an independent function producing uuid-v4 ids', () => {
    assert.notStrictEqual(Envelope.newClockSegmentId, Envelope.newEventId);
    const id = Envelope.newClockSegmentId();
    assert.ok(UUID_V4_RE.test(id));
  });

  it('throws (plain Error, no fallback) when crypto.randomUUID is unavailable', () => {
    const restore = swapGlobal('crypto', undefined);
    try {
      assertPlainError(() => Envelope.newEventId());
      assertPlainError(() => Envelope.newClockSegmentId());
      assertPlainError(() => Envelope.createClockAnchor({
        utcEpochMs: 1, monotonicMs: 1
      }));
    } finally {
      restore();
    }
    // Back to normal afterwards.
    assert.ok(UUID_V4_RE.test(Envelope.newEventId()));
  });

  it('throws (plain Error) when crypto exists but randomUUID is missing (partial capability)', () => {
    const restore = swapGlobal('crypto', {});
    try {
      assertPlainError(() => Envelope.newEventId());
      assertPlainError(() => Envelope.newClockSegmentId());
    } finally {
      restore();
    }
    assert.ok(UUID_V4_RE.test(Envelope.newEventId()));
  });
});

describe('AC1/AC5/AC6/AC7/AC8/AC13/AC15 — createEvent validation', () => {
  it('AC1: returns exactly the 11 envelope keys in contract order', () => {
    const ev = Envelope.createEvent(makeEventInput());
    assert.deepStrictEqual(Object.keys(ev), EVENT_KEY_ORDER);
  });

  it('AC5: sessionId required uuid-v4 (missing/non-uuid → TypeError)', () => {
    assert.throws(() => Envelope.createEvent(makeEventInput({ sessionId: undefined })), TypeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ sessionId: null })), TypeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ sessionId: 'not-a-uuid' })), TypeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ sessionId: 42 })), TypeError);
  });

  it('AC5: gameId uuid-v4 or explicit null (undefined → TypeError)', () => {
    assert.throws(() => Envelope.createEvent(makeEventInput({ gameId: undefined })), TypeError);
    const ev = Envelope.createEvent(makeEventInput({ gameId: null }));
    assert.strictEqual(ev.gameId, null);
    assert.throws(() => Envelope.createEvent(makeEventInput({ gameId: 'xyz' })), TypeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ gameId: 42 })), TypeError);
  });

  it('AC6: sourceContext must be one of SOURCE_CONTEXTS (else RangeError)', () => {
    for (const bad of ['popup', 'content-script', '', 'CONTENT_SCRIPT', null, 7]) {
      assert.throws(
        () => Envelope.createEvent(makeEventInput({ sourceContext: bad })), RangeError,
        'sourceContext=' + String(bad)
      );
    }
    for (const good of ['content_script', 'service_worker', 'recording_context']) {
      assert.strictEqual(Envelope.createEvent(makeEventInput({ sourceContext: good })).sourceContext, good);
    }
  });

  it('AC7: sourceSeq integer ≥ 0; 0 valid; non-integer/negative → RangeError; non-number → TypeError', () => {
    assert.strictEqual(Envelope.createEvent(makeEventInput({ sourceSeq: 0 })).sourceSeq, 0);
    assert.throws(() => Envelope.createEvent(makeEventInput({ sourceSeq: -1 })), RangeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ sourceSeq: 1.5 })), RangeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ sourceSeq: NaN })), RangeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ sourceSeq: Infinity })), RangeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ sourceSeq: '0' })), TypeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ sourceSeq: null })), TypeError);
  });

  it('AC13: monotonicMs stored verbatim; negative/NaN/Infinity → RangeError; non-number → TypeError', () => {
    const ev = Envelope.createEvent(makeEventInput({ monotonicMs: 123456.789123 }));
    assert.strictEqual(ev.monotonicMs, 123456.789123);
    assert.throws(() => Envelope.createEvent(makeEventInput({ monotonicMs: -1 })), RangeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ monotonicMs: NaN })), RangeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ monotonicMs: Infinity })), RangeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ monotonicMs: '1' })), TypeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ monotonicMs: null })), TypeError);
  });

  it('AC15: clockSegmentId required uuid-v4 (missing/non-uuid → TypeError)', () => {
    assert.throws(() => Envelope.createEvent(makeEventInput({ clockSegmentId: undefined })), TypeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ clockSegmentId: 'nope' })), TypeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ clockSegmentId: 7 })), TypeError);
  });

  it('AC8: payload required plain object ({} allowed); null/array/non-object → TypeError; records frozen', () => {
    const ev = Envelope.createEvent(makeEventInput({ payload: {} }));
    assert.deepStrictEqual(ev.payload, {});
    assert.throws(() => Envelope.createEvent(makeEventInput({ payload: null })), TypeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ payload: [1] })), TypeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ payload: 'x' })), TypeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ payload: undefined })), TypeError);
    assert.ok(Object.isFrozen(ev));
    assert.ok(Object.isFrozen(ev.payload));
  });

  it('AC3: eventType non-string → TypeError; bad syntax → RangeError', () => {
    assert.throws(() => Envelope.createEvent(makeEventInput({ eventType: 42 })), TypeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ eventType: null })), TypeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ eventType: undefined })), TypeError);
    for (const bad of ['Move_made', 'move.made', 'move made', '', 'a'.repeat(65), '_move', 'move-made']) {
      assert.throws(
        () => Envelope.createEvent(makeEventInput({ eventType: bad })), RangeError,
        'eventType=' + JSON.stringify(bad)
      );
    }
    assert.strictEqual(
      Envelope.createEvent(makeEventInput({ eventType: 'a'.repeat(64) })).eventType,
      'a'.repeat(64)
    );
  });
});

describe('AC4 — conditions_changed round-trip, 1.2 module untouched', () => {
  it('CONDITION_CHANGE_EVENT_TYPE passes isEventType and survives a createEvent/requireValidEvent round-trip', () => {
    assert.strictEqual(Conditions.CONDITION_CHANGE_EVENT_TYPE, 'conditions_changed');
    assert.ok(Envelope.isEventType(Conditions.CONDITION_CHANGE_EVENT_TYPE));
    const ev = Envelope.createEvent(makeEventInput({
      eventType: Conditions.CONDITION_CHANGE_EVENT_TYPE,
      payload: { changes: { verbalScaffolding: { value: 'reduced', source: 'manual' } } }
    }));
    assert.doesNotThrow(() => Envelope.requireValidEvent(ev));
    assert.ok(Envelope.isValidEvent(ev));
  });

  it('session_identity.js and session_conditions.js diffs are only the 2.6 validator export lines', () => {
    // Task 2.6 (PLAN §2.6) authorizes exactly one additive export line per
    // module (requireValidMetadata / requireValidConditions) so
    // session_store.js can validate on save/restore. This pins the diff
    // to exactly those lines — no behavior change permitted.
    const diff = execFileSync('git', [
      'diff', '--', 'session_identity.js', 'session_conditions.js'
    ], { cwd: REPO_ROOT, stdio: 'pipe' }).toString();
    const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    assert.deepEqual(added, [
      '+  // Exported for task 2.6 (session_store.js save/restore validation).',
      '+  // Additive only: no behavior change to this module.',
      '+  BlindfoldSession.requireValidConditions = requireValidConditions;',
      '+  // Exported for task 2.6 (session_store.js save/restore validation).',
      '+  // Additive only: no behavior change to this module.',
      '+  BlindfoldSession.requireValidMetadata = requireValidMetadata;'
    ]);
  });
});

describe('AC9/AC10 — clock anchors', () => {
  it('AC9: anchor is exactly 3 keys, correct types; fractional monotonicMs round-trips exactly', () => {
    const a = Envelope.createClockAnchor(makeAnchor());
    assert.deepStrictEqual(Object.keys(a), ['segmentId', 'utcEpochMs', 'monotonicMs']);
    assert.ok(UUID_V4_RE.test(a.segmentId));
    assert.strictEqual(a.utcEpochMs, 1728096000123);
    assert.strictEqual(a.monotonicMs, 1234.567);
    assert.ok(Object.isFrozen(a));
    Envelope.requireValidClockAnchor(a);
  });

  it('AC9: rejects bad triples (TypeError/RangeError)', () => {
    assert.throws(() => Envelope.createClockAnchor(null), TypeError);
    assert.throws(() => Envelope.createClockAnchor([]), TypeError);
    assert.throws(() => Envelope.createClockAnchor('x'), TypeError);
  });

  it('AC9: segmentId generated when omitted, honored when valid', () => {
    const a = Envelope.createClockAnchor({ utcEpochMs: 1, monotonicMs: 2 });
    assert.ok(UUID_V4_RE.test(a.segmentId));
    const b = Envelope.createClockAnchor({ segmentId: SEG, utcEpochMs: 1, monotonicMs: 2 });
    assert.strictEqual(b.segmentId, SEG);
    assert.throws(() => Envelope.createClockAnchor({ segmentId: 'bad', utcEpochMs: 1, monotonicMs: 2 }), TypeError);
  });

  it('AC10: captureClockAnchor rejects an invalid supplied segmentId (TypeError)', () => {
    assert.throws(() => Envelope.captureClockAnchor('bad'), TypeError);
    assert.throws(() => Envelope.captureClockAnchor(42), TypeError);
    const ok = Envelope.captureClockAnchor(SEG);
    assert.strictEqual(ok.segmentId, SEG);
  });

  it('AC9: utcEpochMs integer ≥ 0; monotonicMs finite ≥ 0', () => {
    assert.throws(() => Envelope.createClockAnchor({ utcEpochMs: 1.5, monotonicMs: 1 }), RangeError);
    assert.throws(() => Envelope.createClockAnchor({ utcEpochMs: -1, monotonicMs: 1 }), RangeError);
    assert.throws(() => Envelope.createClockAnchor({ utcEpochMs: '1', monotonicMs: 1 }), TypeError);
    assert.throws(() => Envelope.createClockAnchor({ utcEpochMs: 1, monotonicMs: -0.5 }), RangeError);
    assert.throws(() => Envelope.createClockAnchor({ utcEpochMs: 1, monotonicMs: NaN }), RangeError);
    assert.throws(() => Envelope.createClockAnchor({ utcEpochMs: 1, monotonicMs: Infinity }), RangeError);
    assert.throws(() => Envelope.createClockAnchor({ utcEpochMs: 1, monotonicMs: '1' }), TypeError);
  });

  it('AC10: captureClockAnchor reads performance.now() then Date.now()', () => {
    const order = [];
    const restorePerf = swapGlobal('performance', {
      now: () => { order.push('performance.now'); return 500.25; }
    });
    const realNow = Date.now;
    Date.now = () => { order.push('Date.now'); return 1728096000999; };
    try {
      const a = Envelope.captureClockAnchor(SEG);
      assert.deepStrictEqual(order, ['performance.now', 'Date.now']);
      assert.strictEqual(a.segmentId, SEG);
      assert.strictEqual(a.monotonicMs, 500.25);
      assert.strictEqual(a.utcEpochMs, 1728096000999);
    } finally {
      restorePerf();
      Date.now = realNow;
    }
  });

  it('AC10: captureClockAnchor generates a fresh segmentId when omitted', () => {
    const a = Envelope.captureClockAnchor();
    assert.ok(UUID_V4_RE.test(a.segmentId));
  });

  it('AC10: throws plain Error (no Date.now substitution) when performance.now unavailable', () => {
    const restore = swapGlobal('performance', {});
    try {
      assertPlainError(() => Envelope.captureClockAnchor());
    } finally {
      restore();
    }
  });
});

describe('AC11/AC12 — anchor event and no-wall-clock rules', () => {
  it('AC11: createAnchorEvent produces a valid 11-key clock_anchor envelope', () => {
    const anchor = Envelope.createClockAnchor(makeAnchor());
    const ev = Envelope.createAnchorEvent({
      sessionId: SID,
      sourceContext: 'service_worker',
      sourceSeq: 0,
      anchor: anchor
    });
    assert.deepStrictEqual(Object.keys(ev), EVENT_KEY_ORDER);
    assert.strictEqual(ev.eventType, 'clock_anchor');
    assert.strictEqual(ev.gameId, null);
    assert.strictEqual(ev.clockSegmentId, anchor.segmentId);
    assert.strictEqual(ev.monotonicMs, anchor.monotonicMs);
    assert.deepStrictEqual(ev.payload, anchor);
    assert.strictEqual(ev.refs, null);
    assert.strictEqual(ev.appendSeq, null);
    assert.doesNotThrow(() => Envelope.requireValidEvent(ev));
  });

  it('AC11: createAnchorEvent validates its inputs', () => {
    const anchor = Envelope.createClockAnchor(makeAnchor());
    assert.throws(() => Envelope.createAnchorEvent(null), TypeError);
    assert.throws(() => Envelope.createAnchorEvent({
      sessionId: 'bad', sourceContext: 'service_worker', sourceSeq: 0, anchor: anchor
    }), TypeError);
    assert.throws(() => Envelope.createAnchorEvent({
      sessionId: SID, sourceContext: 'popup', sourceSeq: 0, anchor: anchor
    }), RangeError);
    assert.throws(() => Envelope.createAnchorEvent({
      sessionId: SID, sourceContext: 'service_worker', sourceSeq: -1, anchor: anchor
    }), RangeError);
    assert.throws(() => Envelope.createAnchorEvent({
      sessionId: SID, sourceContext: 'service_worker', sourceSeq: 0, anchor: { bad: 1 }
    }), TypeError);
  });

  it('AC12: no timeOrigin, no ISO-8601 string, no second wall-clock field', () => {
    const anchor = Envelope.createClockAnchor(makeAnchor());
    const ev = Envelope.createAnchorEvent({
      sessionId: SID, sourceContext: 'content_script', sourceSeq: 0, anchor: anchor
    });
    const json = JSON.stringify({ anchor: anchor, event: ev });
    assert.ok(!json.includes('timeOrigin'), 'no timeOrigin');
    assert.ok(!json.includes('utcIso'), 'no ISO string field');
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(json), 'no ISO-8601 timestamp');
    assert.ok(typeof anchor.utcEpochMs === 'number', 'epoch ms, not a string');
    const wallFields = Object.keys(ev).filter(k => /wall|utc|iso|date/i.test(k));
    assert.deepStrictEqual(wallFields, [], 'no wall-clock field on the envelope');
  });
});

describe('AC14 — wall-clock derivation', () => {
  it('deriveWallUtcMs implements anchor.utcEpochMs + (t - anchor.monotonicMs)', () => {
    const anchor = Envelope.createClockAnchor({
      segmentId: SEG, utcEpochMs: 1728096000123, monotonicMs: 1234.5
    });
    assert.strictEqual(Envelope.deriveWallUtcMs(anchor, 2234.75), 1728096001123.25);
  });

  it('for the anchor own monotonicMs it returns exactly anchor.utcEpochMs', () => {
    const anchor = Envelope.createClockAnchor(makeAnchor());
    assert.strictEqual(Envelope.deriveWallUtcMs(anchor, anchor.monotonicMs), anchor.utcEpochMs);
  });

  it('fractional arithmetic is the pure formula (epsilon check)', () => {
    const anchor = Envelope.createClockAnchor(makeAnchor());
    const got = Envelope.deriveWallUtcMs(anchor, 2234.567);
    assert.ok(Math.abs(got - 1728096001123) < 1e-6);
  });

  it('validates inputs (TypeError/RangeError)', () => {
    const anchor = Envelope.createClockAnchor(makeAnchor());
    assert.throws(() => Envelope.deriveWallUtcMs(null, 1), TypeError);
    assert.throws(() => Envelope.deriveWallUtcMs({ bad: 1 }, 1), TypeError);
    assert.throws(() => Envelope.deriveWallUtcMs(anchor, 'x'), TypeError);
    assert.throws(() => Envelope.deriveWallUtcMs(anchor, -1), RangeError);
    assert.throws(() => Envelope.deriveWallUtcMs(anchor, NaN), RangeError);
  });
});

describe('AC16/AC17 — appendSeq and delivery round-trip', () => {
  it('AC16: appendSeq is null at creation; validator accepts null or integer ≥ 0', () => {
    const ev = Envelope.createEvent(makeEventInput());
    assert.strictEqual(ev.appendSeq, null);
    // A caller-supplied appendSeq cannot be smuggled through createEvent:
    // the field is hard-coded to null at creation (assignment is §2.4's job).
    const smuggled = Envelope.createEvent(makeEventInput({ appendSeq: 999 }));
    assert.strictEqual(smuggled.appendSeq, null, 'appendSeq smuggled through createEvent');
    const anchor = Envelope.createClockAnchor(makeAnchor());
    assert.strictEqual(
      Envelope.createAnchorEvent({ sessionId: SID, sourceContext: 'content_script', sourceSeq: 0, anchor: anchor }).appendSeq,
      null
    );
    assert.doesNotThrow(() => Envelope.requireValidEvent(ev));
    const stored = Object.assign({}, ev, { appendSeq: 7 });
    assert.doesNotThrow(() => Envelope.requireValidEvent(stored));
    const zeroed = Object.assign({}, ev, { appendSeq: 0 });
    assert.doesNotThrow(() => Envelope.requireValidEvent(zeroed));
    for (const bad of ['7', -1, 1.5, NaN, {}]) {
      const copy = Object.assign({}, ev, { appendSeq: bad });
      assert.throws(() => Envelope.requireValidEvent(copy), bad === '7' || typeof bad === 'object' ? TypeError : RangeError);
    }
  });

  it('AC17: JSON serialize→parse round-trip leaves source times bit-identical and valid', () => {
    const ev = Envelope.createEvent(makeEventInput({ monotonicMs: 987654.321098 }));
    const rt = JSON.parse(JSON.stringify(ev));
    assert.strictEqual(rt.clockSegmentId, ev.clockSegmentId);
    assert.ok(Object.is(rt.monotonicMs, ev.monotonicMs), 'monotonicMs bit-identical');
    assert.doesNotThrow(() => Envelope.requireValidEvent(rt));
    assert.ok(Envelope.isValidEvent(rt));
  });
});

describe('AC19 — references', () => {
  it('refs defaults to null', () => {
    assert.strictEqual(Envelope.createEvent(makeEventInput()).refs, null);
  });

  it('accepts a flat frozen {roleId: uuid-v4} map', () => {
    const ev = Envelope.createEvent(makeEventInput({
      refs: { attemptId: ATTEMPT, moveId: GID }
    }));
    assert.deepStrictEqual(ev.refs, { attemptId: ATTEMPT, moveId: GID });
    assert.ok(Object.isFrozen(ev.refs));
    assert.doesNotThrow(() => Envelope.requireValidEvent(ev));
  });

  it('rejects malformed refs (TypeError for shape, RangeError for role names)', () => {
    assert.throws(() => Envelope.createEvent(makeEventInput({ refs: [ATTEMPT] })), TypeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ refs: 'x' })), TypeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ refs: { attempt_id: ATTEMPT } })), RangeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ refs: { AttemptId: ATTEMPT } })), RangeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ refs: { attempt: ATTEMPT } })), RangeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ refs: { attemptId: 'bad' } })), TypeError);
    assert.throws(() => Envelope.createEvent(makeEventInput({ refs: { attemptId: 42 } })), TypeError);
  });
});

describe('requireValidEvent / isValidEvent', () => {
  it('accepts createEvent output; rejects garbage, wrong key counts, and bad fields', () => {
    const ev = Envelope.createEvent(makeEventInput());
    assert.doesNotThrow(() => Envelope.requireValidEvent(ev));
    assert.ok(Envelope.isValidEvent(ev));
    assert.ok(!Envelope.isValidEvent(null));
    assert.ok(!Envelope.isValidEvent({}));
    assert.ok(!Envelope.isValidEvent('x'));
    const missing = Object.assign({}, ev);
    delete missing.eventId;
    assert.ok(!Envelope.isValidEvent(missing));
    const extra = Object.assign({}, ev, { wallUtcMs: 1 });
    assert.ok(!Envelope.isValidEvent(extra));
    const badId = Object.assign({}, ev, { eventId: 'nope' });
    assert.ok(!Envelope.isValidEvent(badId));
    const badType = Object.assign({}, ev, { eventType: 'no.dots' });
    assert.ok(!Envelope.isValidEvent(badType));
    const badPayload = Object.assign({}, ev, { payload: null });
    assert.ok(!Envelope.isValidEvent(badPayload));
  });
});

describe('AC21–AC23 — integrity, module pattern, JSON-safety', () => {
  it('AC22: plain script — no import/export tokens, no chrome.*, no Math.random', () => {
    // Strip comments so prose (e.g. "re-export", "importScripts()") is not
    // mistaken for ESM syntax.
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    assert.ok(!/\bimport\b/.test(codeOnly), 'no import keyword');
    assert.ok(!/\bexport\b/.test(codeOnly.replace(/module\.exports/g, '')), 'no export keyword');
    assert.ok(!codeOnly.includes('chrome.'), 'no chrome.*');
    assert.ok(!codeOnly.includes('Math.random'), 'no Math.random');
  });

  it('AC22: exactly one guarded global (shared with 1.1/1.2); Node shim present', () => {
    const guards = source.match(/[A-Za-z_$][\w$]* = [A-Za-z_$][\w$]* \|\| \{\}/g) || [];
    assert.deepStrictEqual(guards, ['BlindfoldSession = BlindfoldSession || {}']);
    assert.ok(source.includes("if (typeof module !== 'undefined' && module.exports)"));
  });

  it('AC22: load-order independent — never reads another module\'s exports at load time', () => {
    const forbidden = [
      'BlindfoldSession.isUuidV4', 'BlindfoldSession.SCHEMA_VERSION',
      'BlindfoldSession.SESSION_CATEGORIES', 'BlindfoldSession.newSessionId',
      'BlindfoldSession.newGameId', 'BlindfoldSession.CONDITION_CHANGE_EVENT_TYPE',
      'BlindfoldSession.isSessionCategory', 'BlindfoldSession.createSessionMetadata'
    ];
    for (const name of forbidden) {
      assert.ok(!source.includes(name), 'must not reference ' + name);
    }
    // Only assignments of this module's own exports are allowed.
    const reads = source.match(/BlindfoldSession\.[A-Za-z_$][\w$]*/g) || [];
    for (const r of reads) {
      assert.ok(/^BlindfoldSession\.(EVENT_TYPES|SOURCE_CONTEXTS|EVENT_TYPE_RE|newEventId|newClockSegmentId|isEventType|isSourceContext|createClockAnchor|captureClockAnchor|requireValidClockAnchor|createAnchorEvent|createEvent|requireValidEvent|isValidEvent|deriveWallUtcMs)$/.test(r),
        'unexpected BlindfoldSession reference: ' + r);
    }
  });

  it('AC22: loads standalone under Node without session_identity.js loaded first', () => {
    // This file requires event_envelope.js before anything else in this
    // module scope; reaching here proves standalone load. Re-verify exports.
    assert.strictEqual(typeof Envelope.createEvent, 'function');
  });

  it('AC23: envelope, anchor, and payload are plain-JSON / structuredClone-safe', () => {
    const ev = Envelope.createEvent(makeEventInput({
      refs: { attemptId: ATTEMPT },
      payload: { changes: { verbalScaffolding: { value: 'reduced', source: 'manual' } } }
    }));
    const cloned = structuredClone(ev);
    assert.deepStrictEqual(cloned, JSON.parse(JSON.stringify(ev)));
    assert.doesNotThrow(() => Envelope.requireValidEvent(cloned));
    const anchor = Envelope.createClockAnchor(makeAnchor());
    assert.deepStrictEqual(structuredClone(anchor), JSON.parse(JSON.stringify(anchor)));
    Envelope.requireValidClockAnchor(structuredClone(anchor));
  });
});
