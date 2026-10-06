// tests/session_conditions.test.js
//
// V1 verification for task 1.2 (PLAN.md §1.2.1–§1.2.4) per
// .autodev/evidence/1.2.contract.md. Covers acceptance criteria AC1–AC2,
// AC4–AC17, AC19–AC21. Deferred: AC3's §5.1 Start wiring (→ §5.1),
// AC18 envelope (→ 1.3), AC20 service-worker importScripts loading (→ §2.1),
// DOM observation (§3.3/§5.4), manual-entry UI (§5.2/§5.4), persistence
// (§2.2), export merge (§6.1).
//
// Run: node --test tests/session_conditions.test.js   (from repo root)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BlindfoldSession = require('../session_conditions.js');
const SOURCE_PATH = path.join(__dirname, '..', 'session_conditions.js');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

const FIELDS = [
  'trainingApproach',
  'verbalScaffolding',
  'botName',
  'botDisplayedRating',
  'playerColor',
  'timeControl',
  'assistanceSettings'
];

function makeInput(overrides) {
  return Object.assign({
    trainingApproach: { value: 'relational think-aloud mapping with occasional peeks', source: 'manual' },
    verbalScaffolding: { value: 'full think-aloud', source: 'manual' },
    botName: { value: 'Nelson', source: 'observed' },
    botDisplayedRating: { value: 1000, source: 'observed' },
    playerColor: { value: 'white', source: 'observed' },
    timeControl: { value: '10 min', source: 'manual' },
    assistanceSettings: { value: { hints: false }, source: 'observed' }
  }, overrides);
}

function nullInput(sourceName) {
  const input = {};
  for (const f of FIELDS) input[f] = { value: null, source: sourceName || 'manual' };
  return input;
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  }
  return obj;
}

describe('static module constraints (AC20, AC19)', () => {
  it('declares no import/export statements (plain script)', () => {
    assert.ok(!/^\s*(import|export)\b/m.test(source), 'found an import/export statement');
  });

  it('contains no chrome.* references (module never touches extension APIs)', () => {
    assert.ok(!/chrome\./.test(source), 'found a chrome.* reference');
  });

  it('uses no Math.random', () => {
    assert.ok(!/Math\.random/.test(source), 'found Math.random usage');
  });

  it('has exactly one guarded global declaration shared with 1.1', () => {
    const matches = source.match(/^var BlindfoldSession = BlindfoldSession \|\| \{\};$/gm);
    assert.ok(matches && matches.length === 1, 'expected exactly one guarded global');
  });

  it('exports the contract-specified API surface only', () => {
    const expected = [
      'CONDITION_FIELDS', 'CONDITION_SOURCES', 'PLAYER_COLORS',
      'CONDITION_CHANGE_EVENT_TYPE',
      'isConditionField', 'isConditionSource', 'isPlayerColor',
      'normalizeConditionString', 'normalizeBotRating',
      'normalizeAssistanceSettings',
      'createInitialConditions', 'createConditionChange',
      'applyConditionChange'
    ];
    for (const name of expected) {
      assert.ok(BlindfoldSession[name] !== undefined, 'missing export: ' + name);
    }
  });
});

describe('constants (AC4, AC17)', () => {
  it('CONDITION_FIELDS is exactly the seven keys, frozen', () => {
    assert.deepEqual(BlindfoldSession.CONDITION_FIELDS, FIELDS);
    assert.ok(Object.isFrozen(BlindfoldSession.CONDITION_FIELDS));
  });

  it('CONDITION_SOURCES is [observed, manual], frozen', () => {
    assert.deepEqual(BlindfoldSession.CONDITION_SOURCES, ['observed', 'manual']);
    assert.ok(Object.isFrozen(BlindfoldSession.CONDITION_SOURCES));
  });

  it('PLAYER_COLORS is [white, black], frozen', () => {
    assert.deepEqual(BlindfoldSession.PLAYER_COLORS, ['white', 'black']);
    assert.ok(Object.isFrozen(BlindfoldSession.PLAYER_COLORS));
  });

  it("CONDITION_CHANGE_EVENT_TYPE === 'conditions_changed'", () => {
    assert.equal(BlindfoldSession.CONDITION_CHANGE_EVENT_TYPE, 'conditions_changed');
  });

  it('predicates classify membership (AC17/AC4 support)', () => {
    assert.ok(BlindfoldSession.isConditionField('botName'));
    assert.ok(!BlindfoldSession.isConditionField('sessionId'));
    assert.ok(!BlindfoldSession.isConditionField(null));
    assert.ok(BlindfoldSession.isConditionSource('observed'));
    assert.ok(BlindfoldSession.isConditionSource('manual'));
    assert.ok(!BlindfoldSession.isConditionSource('guessed'));
    assert.ok(BlindfoldSession.isPlayerColor('white'));
    assert.ok(BlindfoldSession.isPlayerColor('black'));
    assert.ok(!BlindfoldSession.isPlayerColor('White'));
  });
});

describe('normalizeConditionString (AC1, AC2, AC13)', () => {
  const n = BlindfoldSession.normalizeConditionString;
  it('passes trimmed non-empty strings through verbatim', () => {
    assert.equal(n('  reduced — square names only  '), 'reduced — square names only');
    assert.equal(n('level 3; full think-aloud (v2)'), 'level 3; full think-aloud (v2)');
  });
  it('maps null/undefined/empty/whitespace-only to null, never ""', () => {
    assert.equal(n(null), null);
    assert.equal(n(undefined), null);
    assert.equal(n(''), null);
    assert.equal(n('   \t\n  '), null);
  });
  it('throws TypeError on wrong-typed non-null input', () => {
    for (const v of [42, true, {}, [], 0]) {
      assert.throws(() => n(v), TypeError, 'value: ' + JSON.stringify(v));
    }
  });
});

describe('normalizeBotRating (AC7, AC13)', () => {
  const n = BlindfoldSession.normalizeBotRating;
  it('accepts finite integers >= 0 and null/undefined', () => {
    assert.equal(n(0), 0);
    assert.equal(n(1000), 1000);
    assert.equal(n(null), null);
    assert.equal(n(undefined), null);
  });
  it('throws TypeError on floats, negatives, NaN, Infinity, numeric strings', () => {
    for (const v of [1.5, -1, NaN, Infinity, '1000', true, {}, []]) {
      assert.throws(() => n(v), TypeError, 'value: ' + String(v));
    }
  });
});

describe('normalizeAssistanceSettings (AC9, AC13)', () => {
  const n = BlindfoldSession.normalizeAssistanceSettings;
  it('maps null/undefined to null', () => {
    assert.equal(n(null), null);
    assert.equal(n(undefined), null);
  });
  it('rejects non-plain-object input with TypeError', () => {
    for (const v of [[], 'hints', 42, true]) {
      assert.throws(() => n(v), TypeError, 'value: ' + JSON.stringify(v));
    }
  });
  it('preserves {} as distinct from null (observed-none vs unknown)', () => {
    const out = n({});
    assert.deepEqual(out, {});
    assert.notEqual(out, null);
  });
  it('accepts flat primitive maps, trims string values, "" -> null', () => {
    assert.deepEqual(
      n({ hints: false, coach: ' on ', level: 3, unreadable: null, empty: '  ' }),
      { hints: false, coach: 'on', level: 3, unreadable: null, empty: null }
    );
  });
  it('keeps { hints: null } as a known setting with unknown value', () => {
    assert.deepEqual(n({ hints: null }), { hints: null });
  });
  it('throws TypeError on nested objects/arrays, empty keys, bad scalars', () => {
    assert.throws(() => n({ a: { b: 1 } }), TypeError);
    assert.throws(() => n({ a: [1] }), TypeError);
    assert.throws(() => n({ '': true }), TypeError);
    assert.throws(() => n({ a: NaN }), TypeError);
    assert.throws(() => n({ a: Infinity }), TypeError);
  });
  it("rejects the '__proto__' key loudly instead of silently dropping it", () => {
    // NOTE: an object literal {'__proto__': true} sets the prototype and is
    // not an own key — the realistic vector is JSON.parse, which creates an
    // own data property. Without the guard, out['__proto__'] = val would hit
    // the inherited setter and silently drop the observation.
    const evil = JSON.parse('{"__proto__":true,"legit":1}');
    assert.ok(Object.keys(evil).includes('__proto__'), 'test setup wrong');
    assert.throws(() => n(evil), TypeError);
    // a normal map with a near-miss key still round-trips
    assert.deepEqual(n({ proto: 1 }), { proto: 1 });
  });
  it('returns a frozen map', () => {
    assert.ok(Object.isFrozen(n({ a: 1 })));
  });
});

describe('createInitialConditions (AC1, AC2, AC4, AC5, AC6, AC8, AC9, AC11)', () => {
  it('AC1: stores arbitrary free-form strings verbatim after trimming (no enum)', () => {
    const rec = BlindfoldSession.createInitialConditions(makeInput({
      trainingApproach: { value: '  square stories; relational mapping v2 (test)  ', source: 'manual' },
      verbalScaffolding: { value: 'reduced — square names only', source: 'manual' }
    }));
    assert.equal(rec.trainingApproach.value, 'square stories; relational mapping v2 (test)');
    assert.equal(rec.verbalScaffolding.value, 'reduced — square names only');
  });

  it('AC2: empty/whitespace/null values normalize to null, never ""', () => {
    const rec = BlindfoldSession.createInitialConditions(makeInput({
      trainingApproach: { value: '   ', source: 'manual' },
      verbalScaffolding: { value: null, source: 'manual' },
      botName: { value: '', source: 'observed' },
      timeControl: { value: undefined, source: 'observed' }
    }));
    for (const f of ['trainingApproach', 'verbalScaffolding', 'botName', 'timeControl']) {
      assert.equal(rec[f].value, null, f);
      assert.notEqual(rec[f].value, '');
    }
  });

  it('AC4: record has exactly the seven fields; each is a frozen { value, source }', () => {
    const rec = BlindfoldSession.createInitialConditions(makeInput());
    assert.deepEqual(Object.keys(rec).sort(), FIELDS.slice().sort());
    assert.ok(Object.isFrozen(rec));
    for (const f of FIELDS) {
      assert.ok(Object.isFrozen(rec[f]), f + ' wrapper not frozen');
      assert.deepEqual(Object.keys(rec[f]).sort(), ['source', 'value']);
    }
  });

  it('AC5: missing/invalid source -> RangeError; missing field -> TypeError; no defaulted sources', () => {
    assert.throws(() => BlindfoldSession.createInitialConditions(makeInput({
      botName: { value: 'Nelson' }
    })), RangeError);
    assert.throws(() => BlindfoldSession.createInitialConditions(makeInput({
      botName: { value: 'Nelson', source: 'guessed' }
    })), RangeError);
    assert.throws(() => BlindfoldSession.createInitialConditions(makeInput({
      botName: { value: 'Nelson', source: null }
    })), RangeError);
    const missing = makeInput();
    delete missing.botName;
    assert.throws(() => BlindfoldSession.createInitialConditions(missing), TypeError);
    assert.throws(() => BlindfoldSession.createInitialConditions(makeInput({
      botName: 'Nelson'
    })), TypeError);
  });

  it('AC5: source matrix — every field accepts both sources when honest', () => {
    for (const f of FIELDS) {
      for (const s of ['observed', 'manual']) {
        const input = makeInput({ [f]: { value: null, source: s } });
        const rec = BlindfoldSession.createInitialConditions(input);
        assert.equal(rec[f].source, s, f + '/' + s);
      }
    }
  });

  it('AC6: playerColor accepts only white/black/null', () => {
    for (const v of ['white', 'black', null]) {
      const rec = BlindfoldSession.createInitialConditions(
        makeInput({ playerColor: { value: v, source: 'observed' } }));
      assert.equal(rec.playerColor.value, v);
    }
    for (const v of ['White', 'w', 'WHITE']) {
      assert.throws(() => BlindfoldSession.createInitialConditions(
        makeInput({ playerColor: { value: v, source: 'observed' } })), RangeError,
        'value: ' + JSON.stringify(v));
    }
    // wrong-typed value is a domain error (RangeError), mirroring 1.1's
    // sessionCategory: 1 → RangeError (contract §3.1 error conventions)
    for (const v of [1, true, {}, []]) {
      assert.throws(() => BlindfoldSession.createInitialConditions(
        makeInput({ playerColor: { value: v, source: 'observed' } })), RangeError,
        'value: ' + JSON.stringify(v));
    }
    // surrounding whitespace trims to a valid color
    const spaced = BlindfoldSession.createInitialConditions(
      makeInput({ playerColor: { value: ' white ', source: 'observed' } }));
    assert.equal(spaced.playerColor.value, 'white');
  });

  it('AC8: timeControl preserves the original label verbatim; no seconds parsed', () => {
    const rec = BlindfoldSession.createInitialConditions(makeInput({
      timeControl: { value: '  10 min  ', source: 'observed' }
    }));
    assert.equal(rec.timeControl.value, '10 min');
    assert.ok(!('baseSeconds' in rec.timeControl) && typeof rec.timeControl.value === 'string');
  });

  it('AC9: assistanceSettings value shapes round-trip', () => {
    const rec = BlindfoldSession.createInitialConditions(makeInput({
      assistanceSettings: { value: { hints: null }, source: 'observed' }
    }));
    assert.deepEqual(rec.assistanceSettings.value, { hints: null });
    const empty = BlindfoldSession.createInitialConditions(makeInput({
      assistanceSettings: { value: {}, source: 'observed' }
    }));
    assert.deepEqual(empty.assistanceSettings.value, {});
    assert.notEqual(empty.assistanceSettings.value, null);
  });

  it('AC11: all-unknown record is legal; no sentinel strings anywhere', () => {
    const rec = BlindfoldSession.createInitialConditions(nullInput('observed'));
    for (const f of FIELDS) {
      assert.equal(rec[f].value, null, f);
      assert.equal(rec[f].source, 'observed', f);
    }
    const allNull = JSON.stringify(rec);
    assert.ok(!/"unknown"/.test(allNull) && !/"n\/a"/i.test(allNull));
  });

  it('AC12: no derived values are persisted — record keys are exactly the seven fields', () => {
    const rec = BlindfoldSession.createInitialConditions(makeInput());
    assert.deepEqual(Object.keys(rec).sort(), FIELDS.slice().sort());
    const json = JSON.stringify(rec);
    assert.ok(!/seconds|duration|count|category/i.test(json.replace(/trainingApproach/g, '')));
  });

  it('AC3 (V1 part): fresh frozen record per call; no in-place update API exists', () => {
    const a = BlindfoldSession.createInitialConditions(makeInput());
    const b = BlindfoldSession.createInitialConditions(makeInput());
    assert.notEqual(a, b);
    assert.ok(Object.isFrozen(a) && Object.isFrozen(b));
    assert.ok(typeof BlindfoldSession.updateConditions === 'undefined');
    assert.ok(typeof BlindfoldSession.setCondition === 'undefined');
  });

  it('rejects unexpected extra fields (exact key set, no more)', () => {
    const input = makeInput({ extra: { value: 'x', source: 'manual' } });
    assert.throws(() => BlindfoldSession.createInitialConditions(input), TypeError);
  });

  it('rejects non-object input', () => {
    for (const v of [null, 'x', [], 42]) {
      assert.throws(() => BlindfoldSession.createInitialConditions(v), TypeError);
    }
  });

  it('does not mutate the caller input object', () => {
    const input = makeInput({ botName: { value: '  Nelson  ', source: 'observed' } });
    BlindfoldSession.createInitialConditions(input);
    assert.equal(input.botName.value, '  Nelson  ');
  });
});

describe('createConditionChange (AC14, AC16)', () => {
  it('AC14: payload contains only the changed fields', () => {
    const change = BlindfoldSession.createConditionChange({
      verbalScaffolding: { value: 'reduced — square names only', source: 'manual' }
    });
    assert.deepEqual(Object.keys(change), ['changes']);
    assert.deepEqual(Object.keys(change.changes), ['verbalScaffolding']);
    assert.deepEqual(change.changes.verbalScaffolding,
      { value: 'reduced — square names only', source: 'manual' });
    assert.ok(Object.isFrozen(change) && Object.isFrozen(change.changes));
  });

  it('AC16: multi-field changes are one payload; unknown field -> RangeError', () => {
    const change = BlindfoldSession.createConditionChange({
      verbalScaffolding: { value: 'none', source: 'manual' },
      assistanceSettings: { value: { hints: true }, source: 'observed' }
    });
    assert.deepEqual(Object.keys(change.changes).sort(),
      ['assistanceSettings', 'verbalScaffolding']);
    assert.throws(() => BlindfoldSession.createConditionChange({
      unknownField: { value: 'x', source: 'manual' }
    }), RangeError);
  });

  it('AC16: a change back to unknown is { value: null, source }', () => {
    const change = BlindfoldSession.createConditionChange({
      botDisplayedRating: { value: null, source: 'observed' }
    });
    assert.deepEqual(change.changes.botDisplayedRating, { value: null, source: 'observed' });
  });

  it('AC16: a field changed twice is two separate payloads (append-only, never merged)', () => {
    const c1 = BlindfoldSession.createConditionChange({
      verbalScaffolding: { value: 'reduced', source: 'manual' }
    });
    const c2 = BlindfoldSession.createConditionChange({
      verbalScaffolding: { value: 'none', source: 'manual' }
    });
    assert.notEqual(c1, c2);
    assert.equal(c1.changes.verbalScaffolding.value, 'reduced');
    assert.equal(c2.changes.verbalScaffolding.value, 'none');
  });

  it('empty change map -> plain Error (logic error)', () => {
    assert.throws(() => BlindfoldSession.createConditionChange({}), Error);
    assert.throws(() => BlindfoldSession.createConditionChange({}),
      (e) => e instanceof Error && !(e instanceof TypeError) && !(e instanceof RangeError));
  });

  it('non-object changes input -> TypeError; per-field validation applies', () => {
    for (const v of [null, 'x', [], 42]) {
      assert.throws(() => BlindfoldSession.createConditionChange(v), TypeError);
    }
    assert.throws(() => BlindfoldSession.createConditionChange({
      playerColor: { value: 'green', source: 'manual' }
    }), RangeError);
    assert.throws(() => BlindfoldSession.createConditionChange({
      botName: { value: 'x' }
    }), RangeError);
  });
});

describe('applyConditionChange (AC15)', () => {
  it('is pure: input never mutated; returns new frozen record with only changed fields replaced', () => {
    const before = BlindfoldSession.createInitialConditions(makeInput());
    const snapshot = JSON.parse(JSON.stringify(before));
    const change = BlindfoldSession.createConditionChange({
      verbalScaffolding: { value: 'reduced — square names only', source: 'manual' },
      assistanceSettings: { value: { hints: true }, source: 'observed' }
    });
    const after = BlindfoldSession.applyConditionChange(before, change);
    assert.notEqual(after, before);
    assert.ok(Object.isFrozen(after));
    assert.deepEqual(JSON.parse(JSON.stringify(before)), snapshot,
      'input record was mutated');
    assert.equal(after.verbalScaffolding.value, 'reduced — square names only');
    assert.deepEqual(after.assistanceSettings.value, { hints: true });
    assert.equal(after.botName.value, before.botName.value);
    assert.equal(after.playerColor.value, before.playerColor.value);
    assert.deepEqual(Object.keys(after).sort(), FIELDS.slice().sort());
  });

  it('validates both inputs', () => {
    const good = BlindfoldSession.createInitialConditions(makeInput());
    const change = BlindfoldSession.createConditionChange({
      botName: { value: 'Komodo', source: 'observed' }
    });
    assert.throws(() => BlindfoldSession.applyConditionChange(null, change), TypeError);
    assert.throws(() => BlindfoldSession.applyConditionChange(good, null), TypeError);
    assert.throws(() => BlindfoldSession.applyConditionChange(good, { changes: {} }),
      Error);
    const bad = makeInput();
    delete bad.timeControl;
    assert.throws(() => BlindfoldSession.applyConditionChange(bad, change), TypeError);
  });
});

describe('unknown representation (AC11 static)', () => {
  it('source contains no sentinel unknown-strings', () => {
    assert.ok(!/"unknown"/.test(source), 'found "unknown" sentinel string');
    assert.ok(!/"n\/a"/i.test(source), 'found "n/a" sentinel string');
    assert.ok(!/"none available"/i.test(source));
  });
});

describe('plain-JSON safety (AC21)', () => {
  it('records and payloads survive structuredClone and JSON round-trip', () => {
    const rec = BlindfoldSession.createInitialConditions(makeInput());
    const change = BlindfoldSession.createConditionChange({
      timeControl: { value: '15 | 10', source: 'observed' }
    });
    const after = BlindfoldSession.applyConditionChange(rec, change);
    for (const obj of [rec, change, after]) {
      assert.deepEqual(JSON.parse(JSON.stringify(obj)),
        JSON.parse(JSON.stringify(structuredClone(obj))));
    }
    assert.equal(JSON.parse(JSON.stringify(after)).timeControl.value, '15 | 10');
  });
});
