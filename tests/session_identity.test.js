// tests/session_identity.test.js
//
// V1 verification for task 1.1 (PLAN.md §1.1.1–§1.1.3) per
// .autodev/evidence/1.1.contract.md. Covers acceptance criteria AC1–AC3,
// AC5–AC7 (pure-function parts) and AC9–AC17. Deferred: AC4 (§5.1), AC8
// (§3.1/§3.5), AC7 boundary-flag behavior (§5.9), AC11 live manifest wiring
// (§5.1), AC17 service-worker importScripts loading (§2.1).
//
// Run: node --test tests/session_identity.test.js   (from repo root)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BlindfoldSession = require('../session_identity.js');
const SOURCE_PATH = path.join(__dirname, '..', 'session_identity.js');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

function makeMetadata(overrides) {
  return BlindfoldSession.createSessionMetadata(Object.assign({
    extensionVersion: '1.0.0',
    sessionCategory: 'baseline',
    protocolVersion: null
  }, overrides));
}

describe('static module constraints (AC17, AC11, contract §3.1)', () => {
  it('declares no import/export statements (plain script)', () => {
    assert.ok(!/^\s*(import|export)\b/m.test(source), 'found an import/export statement');
  });

  it('contains no chrome.* references (module never touches extension APIs)', () => {
    assert.ok(!/chrome\./.test(source), 'found a chrome.* reference');
  });

  it('uses no Math.random fallback', () => {
    assert.ok(!/Math\.random/.test(source), 'found Math.random usage');
  });

  it('declares exactly one guarded global namespace', () => {
    const guards = source.match(/var\s+BlindfoldSession\s*=\s*BlindfoldSession\s*\|\|\s*\{\}/g) || [];
    assert.strictEqual(guards.length, 1, `expected 1 guarded global, found ${guards.length}`);
  });

  it('exposes exactly the contracted export names', () => {
    const expected = [
      'SCHEMA_VERSION', 'SESSION_CATEGORIES', 'UUID_V4_RE',
      'newSessionId', 'newGameId', 'isUuidV4', 'isSessionCategory',
      'normalizeProtocolVersion', 'createSessionMetadata', 'addGameToSession'
    ];
    assert.deepStrictEqual(Object.keys(BlindfoldSession).sort(), expected.sort());
  });
});

describe('UUID factories (AC1–AC3)', () => {
  it('newSessionId returns UUID v4 shape over 1,000 samples (AC1)', () => {
    for (let i = 0; i < 1000; i++) {
      const id = BlindfoldSession.newSessionId();
      assert.ok(BlindfoldSession.isUuidV4(id), `bad shape: ${id}`);
      assert.strictEqual(id.length, 36);
      assert.strictEqual(id[14], '4', `version nibble wrong: ${id}`);
      assert.ok('89ab'.includes(id[19]), `variant nibble wrong: ${id}`);
      assert.strictEqual(id, id.toLowerCase(), `not lowercase: ${id}`);
    }
  });

  it('100,000 generated session IDs are all distinct (AC2)', () => {
    const seen = new Set();
    for (let i = 0; i < 100000; i++) {
      const id = BlindfoldSession.newSessionId();
      assert.ok(!seen.has(id), 'duplicate session ID detected');
      seen.add(id);
    }
    assert.strictEqual(seen.size, 100000);
  });

  it('factories throw when crypto.randomUUID is unavailable (AC3)', () => {
    // Node exposes crypto as a getter-only global, so assignment is a silent
    // no-op; stub via defineProperty and restore the original descriptor.
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    assert.ok(desc, 'expected a crypto global to exist');
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      writable: true,
      configurable: true,
      enumerable: true
    });
    try {
      assert.throws(() => BlindfoldSession.newSessionId(), Error);
      assert.throws(() => BlindfoldSession.newGameId(), Error);
    } finally {
      Object.defineProperty(globalThis, 'crypto', desc);
    }
    // sanity: restored and working again
    assert.ok(BlindfoldSession.isUuidV4(BlindfoldSession.newSessionId()));
  });
});

describe('newGameId (AC5)', () => {
  it('produces UUID v4 with the same guarantees as newSessionId', () => {
    for (let i = 0; i < 100; i++) {
      const id = BlindfoldSession.newGameId();
      assert.ok(BlindfoldSession.isUuidV4(id), `bad shape: ${id}`);
      assert.strictEqual(id[14], '4');
      assert.ok('89ab'.includes(id[19]));
    }
  });

  it('is an independent function, not an alias of newSessionId', () => {
    assert.notStrictEqual(BlindfoldSession.newGameId, BlindfoldSession.newSessionId);
  });

  it('generates distinct IDs from the session stream', () => {
    const a = BlindfoldSession.newSessionId();
    const b = BlindfoldSession.newGameId();
    assert.notStrictEqual(a, b);
  });
});

describe('addGameToSession (AC6, AC7 pure-function parts)', () => {
  it('normal workflow yields exactly one entry in gameIds (AC7)', () => {
    const meta = makeMetadata();
    assert.deepStrictEqual(meta.gameIds, []);
    const updated = BlindfoldSession.addGameToSession(meta);
    assert.strictEqual(updated.gameIds.length, 1);
    assert.ok(BlindfoldSession.isUuidV4(updated.gameIds[0]));
  });

  it('a second detected game appends a distinct ID without replacing (AC7)', () => {
    const meta = makeMetadata();
    const once = BlindfoldSession.addGameToSession(meta);
    const twice = BlindfoldSession.addGameToSession(once);
    assert.strictEqual(twice.gameIds.length, 2);
    assert.strictEqual(twice.gameIds[0], once.gameIds[0], 'first entry altered');
    assert.ok(BlindfoldSession.isUuidV4(twice.gameIds[1]));
    assert.notStrictEqual(twice.gameIds[0], twice.gameIds[1]);
  });

  it('never mutates the input record (deep-frozen input) (AC6)', () => {
    const meta = makeMetadata();
    const withGame = BlindfoldSession.addGameToSession(meta);
    Object.freeze(withGame);
    Object.freeze(withGame.gameIds);
    const snapshot = structuredClone(withGame);
    const updated = BlindfoldSession.addGameToSession(withGame);
    assert.deepStrictEqual(withGame, snapshot, 'input record was mutated');
    assert.notStrictEqual(updated, withGame);
    assert.notStrictEqual(updated.gameIds, withGame.gameIds);
    assert.strictEqual(updated.gameIds.length, 2);
  });

  it('accepts an explicit uuid game ID and appends in order (AC6)', () => {
    const meta = makeMetadata();
    const explicit = BlindfoldSession.newGameId();
    const updated = BlindfoldSession.addGameToSession(meta, explicit);
    assert.deepStrictEqual(updated.gameIds, [explicit]);
  });

  it('rejects non-uuid game IDs with TypeError (AC6)', () => {
    const meta = makeMetadata();
    for (const bad of ['not-a-uuid', '', 42, true, {}, '43F267DD-C44D-42EE-B99D-5537C5A4F95E']) {
      assert.throws(() => BlindfoldSession.addGameToSession(meta, bad), TypeError, `accepted: ${bad}`);
    }
  });

  it('throws on a duplicate explicit gameId instead of appending it (SF1)', () => {
    const meta = makeMetadata();
    const explicit = BlindfoldSession.newGameId();
    const once = BlindfoldSession.addGameToSession(meta, explicit);
    assert.throws(
      () => BlindfoldSession.addGameToSession(once, explicit),
      Error,
      'duplicate gameId was silently appended'
    );
    assert.deepStrictEqual(once.gameIds, [explicit], 'input record altered by failed call');
  });

  it('returns frozen records and frozen gameIds arrays (SF2)', () => {
    const meta = makeMetadata();
    assert.ok(Object.isFrozen(meta), 'createSessionMetadata record not frozen');
    assert.ok(Object.isFrozen(meta.gameIds), 'createSessionMetadata gameIds not frozen');
    const updated = BlindfoldSession.addGameToSession(meta);
    assert.ok(Object.isFrozen(updated), 'addGameToSession record not frozen');
    assert.ok(Object.isFrozen(updated.gameIds), 'addGameToSession gameIds not frozen');
  });

  it('rejects malformed metadata with TypeError (AC6)', () => {
    const good = makeMetadata();
    const badSessionId = Object.assign({}, good, { sessionId: 'bogus' });
    const badGameIds = Object.assign({}, good, { gameIds: ['bogus'] });
    assert.throws(() => BlindfoldSession.addGameToSession(badSessionId), TypeError);
    assert.throws(() => BlindfoldSession.addGameToSession(badGameIds), TypeError);
    assert.throws(() => BlindfoldSession.addGameToSession(null), TypeError);
    assert.throws(() => BlindfoldSession.addGameToSession('nope'), TypeError);
  });
});

describe('createSessionMetadata (AC9–AC16)', () => {
  it('returns exactly the six contracted keys with correct types (AC9)', () => {
    const meta = makeMetadata({ protocolVersion: 'v2' });
    const expectedKeys = [
      'sessionId', 'gameIds', 'schemaVersion',
      'extensionVersion', 'protocolVersion', 'sessionCategory'
    ];
    assert.deepStrictEqual(Object.keys(meta).sort(), expectedKeys.sort());
    assert.ok(BlindfoldSession.isUuidV4(meta.sessionId));
    assert.ok(Array.isArray(meta.gameIds));
    assert.strictEqual(typeof meta.schemaVersion, 'string');
    assert.strictEqual(typeof meta.extensionVersion, 'string');
    assert.strictEqual(typeof meta.protocolVersion, 'string');
    assert.strictEqual(typeof meta.sessionCategory, 'string');
  });

  it('schemaVersion equals frozen SCHEMA_VERSION and cannot be overridden (AC10)', () => {
    assert.strictEqual(BlindfoldSession.SCHEMA_VERSION, '1.0.0');
    const meta = BlindfoldSession.createSessionMetadata({
      extensionVersion: '1.0.0',
      sessionCategory: 'training',
      protocolVersion: null,
      schemaVersion: '9.9.9'
    });
    assert.strictEqual(meta.schemaVersion, '1.0.0');
  });

  it('extensionVersion is the caller-supplied value (AC11)', () => {
    const meta = makeMetadata({ extensionVersion: '2.3.4' });
    assert.strictEqual(meta.extensionVersion, '2.3.4');
  });

  it('extensionVersion missing/empty/non-string throws TypeError (AC11)', () => {
    for (const bad of [undefined, '', '   ', 42, null, {}, true]) {
      assert.throws(() => makeMetadata({ extensionVersion: bad }), TypeError, `accepted: ${JSON.stringify(bad)}`);
    }
    assert.throws(() => BlindfoldSession.createSessionMetadata(null), TypeError);
    assert.throws(() => BlindfoldSession.createSessionMetadata('x'), TypeError);
  });

  it('normalizeProtocolVersion semantics (AC12)', () => {
    const n = BlindfoldSession.normalizeProtocolVersion;
    assert.strictEqual(n(null), null);
    assert.strictEqual(n(undefined), null);
    assert.strictEqual(n(''), null);
    assert.strictEqual(n('   '), null);
    assert.strictEqual(n('  protocol-v2  '), 'protocol-v2');
    assert.strictEqual(n('v1'), 'v1');
    assert.throws(() => n(42), TypeError);
    assert.throws(() => n(true), TypeError);
    assert.throws(() => n({}), TypeError);
  });

  it('protocolVersion defaults to null and is never an empty string (AC12/AC15)', () => {
    assert.strictEqual(makeMetadata().protocolVersion, null);
    assert.strictEqual(makeMetadata({ protocolVersion: '   ' }).protocolVersion, null);
    const meta = makeMetadata({ protocolVersion: '  notes-2026-10 ' });
    assert.strictEqual(meta.protocolVersion, 'notes-2026-10');
  });

  it('sessionCategory must be an exact allowed value (AC13)', () => {
    for (const cat of ['baseline', 'training', 'evaluation']) {
      assert.strictEqual(makeMetadata({ sessionCategory: cat }).sessionCategory, cat);
    }
    for (const bad of ['Baseline', 'BASELINE', 'free', '', null, 42, ' baseline']) {
      assert.throws(() => makeMetadata({ sessionCategory: bad }), RangeError, `accepted: ${JSON.stringify(bad)}`);
    }
    assert.deepStrictEqual(BlindfoldSession.SESSION_CATEGORIES, ['baseline', 'training', 'evaluation']);
    assert.ok(Object.isFrozen(BlindfoldSession.SESSION_CATEGORIES));
  });

  it('record carries no derived extras (AC14)', () => {
    const meta = makeMetadata({ protocolVersion: 'p1' });
    const extraKeys = [
      'createdAt', 'timestamp', 'sequence', 'sequenceNumber', 'date',
      'san', 'pgn', 'fen', 'moveNumber', 'duration', 'count', 'folder'
    ];
    for (const key of extraKeys) {
      assert.ok(!(key in meta), `record contains derived extra: ${key}`);
    }
    assert.deepStrictEqual(Object.keys(meta).sort(), [
      'extensionVersion', 'gameIds', 'protocolVersion',
      'schemaVersion', 'sessionCategory', 'sessionId'
    ].sort());
  });

  it('record is plain-JSON/structured-clone safe (AC16)', () => {
    const meta = makeMetadata({ protocolVersion: 'v3' });
    const withGames = BlindfoldSession.addGameToSession(meta);
    const cloned = structuredClone(withGames);
    assert.deepStrictEqual(cloned, withGames);
    const jsonRoundTrip = JSON.parse(JSON.stringify(withGames));
    assert.deepStrictEqual(jsonRoundTrip, withGames);
  });
});

describe('predicate helpers', () => {
  it('isUuidV4 rejects non-string and malformed input', () => {
    assert.strictEqual(BlindfoldSession.isUuidV4(null), false);
    assert.strictEqual(BlindfoldSession.isUuidV4(42), false);
    assert.strictEqual(BlindfoldSession.isUuidV4(''), false);
    assert.strictEqual(BlindfoldSession.isUuidV4('43f267dd-c44d-12ee-b99d-5537c5a4f95e'), false); // version nibble 1
    assert.strictEqual(BlindfoldSession.isUuidV4('43f267dd-c44d-42ee-c99d-5537c5a4f95e'), false); // variant nibble c
    assert.strictEqual(BlindfoldSession.isUuidV4('43F267DD-C44D-42EE-B99D-5537C5A4F95E'), false); // uppercase
    assert.strictEqual(BlindfoldSession.isUuidV4(BlindfoldSession.newSessionId()), true);
  });

  it('isSessionCategory rejects non-string input', () => {
    assert.strictEqual(BlindfoldSession.isSessionCategory(null), false);
    assert.strictEqual(BlindfoldSession.isSessionCategory(42), false);
    assert.strictEqual(BlindfoldSession.isSessionCategory('baseline'), true);
  });
});
