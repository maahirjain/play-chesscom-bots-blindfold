// Task 2.6 (PLAN.md §2.6): V1 verification for session_store.js — the
// session-state storage primitives (save/restore session metadata and
// conditions, read-only sequence-counter peek, corruption honesty).
//
// Hand-rolled in-memory IndexedDB fake (the repo stays dependency-free —
// no fake-indexeddb). The fake consumes the REAL DB.SCHEMA, so schema
// drift breaks here by design. Documented fake limits: session_store.js
// only ever issues single-request transactions via BlindfoldSession.DB
// (put/get), so the fake does NOT model multi-request transaction
// journals or overlapping-transaction serialization — the writer's
// transactional semantics are covered by tests/writer.test.js and the
// real-IDB V2 harnesses. It also does not model structured-clone
// serialization (records are stored by reference).
//
// Real-restart behavior is covered at V2 in the puppeteer harness
// (~/workspace/tools/ext-verify/sw-restart.js).

const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// Load order: session_identity.js, session_conditions.js, db.js; publish
// the merged namespace on globalThis (session_store.js reads DB and the
// validators at call time via the shared namespace), then require
// session_store.js and merge its exports.
const Identity = require('../session_identity.js');
const Conditions = require('../session_conditions.js');
const DBModule = require('../db.js');
const merged = Object.assign({}, Identity, Conditions, DBModule);
const priorGlobal = globalThis.BlindfoldSession;
globalThis.BlindfoldSession = merged;
const StoreExports = require('../session_store.js');
Object.assign(merged, StoreExports);
const BlindfoldSession = merged;

const STORE_PATH = path.join(ROOT, 'session_store.js');
const storeSource = fs.readFileSync(STORE_PATH, 'utf8');
// Strip line and block comments so static checks see code tokens only.
const codeOnly = storeSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

// Deterministic UUID v4 fixtures (version nibble 4, variant nibble 8-b).
const SID1 = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const SID2 = 'b1f2a345-6c78-4d9e-8f01-23456789abcd';

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ------------------------------------------------------------------
// In-memory IndexedDB fake.
// ------------------------------------------------------------------
// Implements exactly the IDB surface BlindfoldSession.DB touches:
//   indexedDB.open(name, version) -> request {onupgradeneeded, onsuccess,
//     onerror, result, error}
//   db.transaction(storeNames, mode) -> tx {objectStore(name), oncomplete,
//     onerror, onabort}
//   db.objectStoreNames.contains(name); db.createObjectStore(name,
//     {keyPath}); db.close()
//   upgradeTx.objectStore(name)
//   store.get(key) / store.put(record) -> request {onsuccess, onerror,
//     result, error}; store.indexNames.contains(name)
//   store.createIndex(name, keyPath, {unique})
// KeyPaths are extracted from the REAL DB.SCHEMA (string and compound
// forms). A record missing its keyPath value makes put() throw
// synchronously with name 'DataError' (mirrors the real DOMException).
// Stores are per-fake-instance (beforeEach isolation).

function keyOf(keyPath, record) {
  if (Array.isArray(keyPath)) {
    const parts = keyPath.map((k) => record[k]);
    if (parts.some((p) => p === undefined)) return undefined;
    return JSON.stringify(parts);
  }
  return record[keyPath];
}

function makeFakeIDB() {
  const databases = new Map(); // name -> { version, stores: Map(name -> {keyPath, records: Map, indexes}) }

  function applySchema(dbRec, upgradeTx) {
    const schema = BlindfoldSession.DB.SCHEMA;
    for (const spec of schema.stores) {
      let storeRec;
      if (dbRec.stores.has(spec.name)) {
        storeRec = dbRec.stores.get(spec.name);
      } else {
        storeRec = { keyPath: spec.keyPath, records: new Map(), indexes: new Map() };
        dbRec.stores.set(spec.name, storeRec);
      }
      for (const idx of (spec.indexes || [])) {
        storeRec.indexes.set(idx.name, idx.keyPath);
      }
    }
    void upgradeTx;
  }

  function makeStore(storeRec) {
    return {
      indexNames: { contains: (n) => storeRec.indexes.has(n) },
      createIndex: (name, keyPath) => { storeRec.indexes.set(name, keyPath); },
      get: (key) => {
        const req = {};
        setImmediate(() => {
          req.result = storeRec.records.get(key);
          if (req.onsuccess) req.onsuccess();
        });
        return req;
      },
      put: (record) => {
        const k = keyOf(storeRec.keyPath, record);
        if (k === undefined) {
          const err = new Error('DataError: keyPath value missing');
          err.name = 'DataError';
          throw err;
        }
        const req = {};
        setImmediate(() => {
          storeRec.records.set(k, record);
          req.result = k;
          if (req.onsuccess) req.onsuccess();
        });
        return req;
      }
    };
  }

  const indexedDB = {
    open: (name, version) => {
      const req = {};
      setImmediate(() => {
        let dbRec = databases.get(name);
        if (!dbRec) {
          dbRec = { version, stores: new Map() };
          databases.set(name, dbRec);
          const fakeDb = {
            objectStoreNames: { contains: (n) => dbRec.stores.has(n) },
            createObjectStore: (sname, opts) => {
              const rec = { keyPath: opts.keyPath, records: new Map(), indexes: new Map() };
              dbRec.stores.set(sname, rec);
              return makeStore(rec);
            },
            transaction: (storeNames, mode) => {
              const names = Array.isArray(storeNames) ? storeNames : [storeNames];
              void mode;
              const tx = {
                objectStore: (n) => {
                  const rec = dbRec.stores.get(n);
                  if (!rec) {
                    const err = new Error('NotFoundError: no such store');
                    err.name = 'NotFoundError';
                    throw err;
                  }
                  return makeStore(rec);
                },
                oncomplete: null, onerror: null, onabort: null
              };
              return tx;
            },
            close: () => {}
          };
          applySchema(dbRec, { objectStore: (n) => makeStore(dbRec.stores.get(n)) });
          req.result = fakeDb;
          if (req.onupgradeneeded) req.onupgradeneeded();
          if (req.onsuccess) req.onsuccess();
        } else {
          const fakeDb = {
            objectStoreNames: { contains: (n) => dbRec.stores.has(n) },
            createObjectStore: (sname, opts) => {
              const rec = { keyPath: opts.keyPath, records: new Map(), indexes: new Map() };
              dbRec.stores.set(sname, rec);
              return makeStore(rec);
            },
            transaction: (storeNames) => {
              const names = Array.isArray(storeNames) ? storeNames : [storeNames];
              void names;
              return {
                objectStore: (n) => {
                  const rec = dbRec.stores.get(n);
                  if (!rec) {
                    const err = new Error('NotFoundError: no such store');
                    err.name = 'NotFoundError';
                    throw err;
                  }
                  return makeStore(rec);
                },
                oncomplete: null, onerror: null, onabort: null
              };
            },
            close: () => {}
          };
          req.result = fakeDb;
          if (req.onsuccess) req.onsuccess();
        }
      });
      return req;
    }
  };

  return { indexedDB, databases };
}

let fake = null;
beforeEach(() => {
  fake = makeFakeIDB();
  globalThis.indexedDB = fake.indexedDB;
  // db.js caches the open handle per module load; the fake is fresh per
  // test but the DB name is constant, so reset the module-level cache by
  // closing through the public API.
  BlindfoldSession.DB.closeDatabase();
});

// ------------------------------------------------------------------
// Fixtures (built with the real 1.1/1.2 factories).
// ------------------------------------------------------------------

function makeMetadata(sessionId) {
  const rec = BlindfoldSession.createSessionMetadata({
    extensionVersion: '1.0.0',
    sessionCategory: 'training',
    protocolVersion: null
  });
  // createSessionMetadata mints its own ID; rebuild with the fixture ID
  // via the pure addGameToSession path is unnecessary — construct the
  // record through the factory then re-key deterministically:
  return Object.freeze({
    sessionId,
    gameIds: rec.gameIds,
    schemaVersion: rec.schemaVersion,
    extensionVersion: rec.extensionVersion,
    protocolVersion: rec.protocolVersion,
    sessionCategory: rec.sessionCategory
  });
}

function makeConditions() {
  return BlindfoldSession.createInitialConditions({
    trainingApproach: { value: 'guided', source: 'manual' },
    verbalScaffolding: { value: null, source: 'observed' },
    botName: { value: 'Nelson', source: 'observed' },
    botDisplayedRating: { value: 1200, source: 'observed' },
    playerColor: { value: 'white', source: 'observed' },
    timeControl: { value: '10 min', source: 'observed' },
    assistanceSettings: { value: {}, source: 'observed' }
  });
}

// ------------------------------------------------------------------
// AC1 — loads in Node; platform reads are call-time only.
// ------------------------------------------------------------------

describe('AC1 — module loading discipline', () => {
  it('session_store.js has no chrome.* references in code', () => {
    assert.ok(!/chrome\./.test(codeOnly), 'found chrome. in session_store.js code');
    assert.ok(!/chrome\[/.test(codeOnly), 'found chrome[ in session_store.js code');
  });

  it('loads in Node with no chrome global and exports the four functions', () => {
    assert.equal(typeof BlindfoldSession.saveSessionMetadata, 'function');
    assert.equal(typeof BlindfoldSession.saveConditions, 'function');
    assert.equal(typeof BlindfoldSession.restoreSessionState, 'function');
    assert.equal(typeof BlindfoldSession.getSequenceState, 'function');
  });

  it('platform reads are call-time: removing DB makes calls reject, not load-time throw', async () => {
    const saved = BlindfoldSession.DB;
    delete BlindfoldSession.DB;
    try {
      await assert.rejects(
        BlindfoldSession.saveSessionMetadata(makeMetadata(SID1)),
        (e) => e instanceof Error
      );
    } finally {
      BlindfoldSession.DB = saved;
    }
  });

  it('never writes sequence_state/events/media_chunks (static)', () => {
    assert.ok(!/['"]sequence_state['"]\s*,/.test(
      codeOnly.replace(/DB\.get\('sequence_state'/g, '')),
      'session_store.js must never put to sequence_state'
    );
    assert.ok(!/put\(['"]events['"]/.test(codeOnly), 'must never write events');
    assert.ok(!/put\(['"]media_chunks['"]/.test(codeOnly), 'must never write media_chunks');
  });
});

// ------------------------------------------------------------------
// AC2 — saveSessionMetadata validates via the 1.1 validator.
// ------------------------------------------------------------------

describe('AC2 — saveSessionMetadata validation', () => {
  it('factory-built record stores verbatim', async () => {
    const rec = makeMetadata(SID1);
    await BlindfoldSession.saveSessionMetadata(rec);
    const back = await BlindfoldSession.DB.get('session_metadata', SID1);
    assert.deepEqual(back, rec);
  });

  it('malformed record (wrong key count) rejects with TypeError', async () => {
    const bad = { sessionId: SID1 };
    await assert.rejects(
      BlindfoldSession.saveSessionMetadata(bad),
      TypeError
    );
    assert.equal(await BlindfoldSession.DB.get('session_metadata', SID1), undefined);
  });

  it('bad sessionCategory rejects with RangeError', async () => {
    const rec = Object.assign({}, makeMetadata(SID1), { sessionCategory: 'nope' });
    await assert.rejects(
      BlindfoldSession.saveSessionMetadata(rec),
      RangeError
    );
    assert.equal(await BlindfoldSession.DB.get('session_metadata', SID1), undefined);
  });

  it('validation runs before any IDB access (indexedDB deleted)', async () => {
    const savedIDB = globalThis.indexedDB;
    delete globalThis.indexedDB;
    try {
      // Malformed input → validator's TypeError, not the platform Error.
      await assert.rejects(
        BlindfoldSession.saveSessionMetadata({ sessionId: SID1 }),
        TypeError
      );
      // Well-formed input → platform-unavailable plain Error.
      await assert.rejects(
        BlindfoldSession.saveSessionMetadata(makeMetadata(SID1)),
        (e) => e instanceof Error && !(e instanceof TypeError) && !(e instanceof RangeError)
      );
    } finally {
      globalThis.indexedDB = savedIDB;
    }
  });
});

// ------------------------------------------------------------------
// AC3 — saveConditions validates via the 1.2 validator.
// ------------------------------------------------------------------

describe('AC3 — saveConditions validation', () => {
  it('factory-built record stores verbatim (plus the sessionId key)', async () => {
    const rec = makeConditions();
    await BlindfoldSession.saveConditions(SID1, rec);
    const back = await BlindfoldSession.DB.get('conditions', SID1);
    assert.deepEqual(back, Object.assign({ sessionId: SID1 }, rec));
  });

  it('non-string sessionId rejects with TypeError', async () => {
    for (const bad of [123, null, undefined, '']) {
      await assert.rejects(BlindfoldSession.saveConditions(bad, makeConditions()), TypeError);
    }
  });

  it('bad playerColor rejects with RangeError and stores nothing', async () => {
    const rec = JSON.parse(JSON.stringify(makeConditions()));
    rec.playerColor = { value: 'purple', source: 'manual' };
    await assert.rejects(
      BlindfoldSession.saveConditions(SID1, rec),
      RangeError
    );
    assert.equal(await BlindfoldSession.DB.get('conditions', SID1), undefined);
  });

  it('__proto__ inside assistanceSettings rejects loudly (TypeError) and stores nothing', async () => {
    // The realistic vector (per 1.2): __proto__ nested in the assistance
    // settings map, not at the record top level.
    const rec = JSON.parse(JSON.stringify(makeConditions()));
    rec.assistanceSettings = JSON.parse('{"value":{"__proto__":{"x":1}},"source":"manual"}');
    await assert.rejects(
      BlindfoldSession.saveConditions(SID1, rec),
      TypeError
    );
    assert.equal(await BlindfoldSession.DB.get('conditions', SID1), undefined);
  });
});

// ------------------------------------------------------------------
// AC4 — save then restore returns the exact triple.
// ------------------------------------------------------------------

describe('AC4 — save/restore round-trip', () => {
  it('restoreSessionState returns the exact triple deep-equal', async () => {
    const metadata = makeMetadata(SID1);
    const conditions = makeConditions();
    // Simulate the writer's sequence_state write (session_store never
    // writes it itself): raw DB.put, the writer's exact shape.
    await BlindfoldSession.DB.put('sequence_state', { sessionId: SID1, nextAppendSeq: 7 });
    await BlindfoldSession.saveSessionMetadata(metadata);
    await BlindfoldSession.saveConditions(SID1, conditions);
    const triple = await BlindfoldSession.restoreSessionState(SID1);
    assert.deepEqual(triple.metadata, metadata);
    assert.deepEqual(triple.conditions, Object.assign({ sessionId: SID1 }, conditions));
    assert.deepEqual(triple.sequenceState, { sessionId: SID1, nextAppendSeq: 7 });
  });
});

// ------------------------------------------------------------------
// AC5 — unknown session → nulls, no throw.
// ------------------------------------------------------------------

describe('AC5 — unknown session', () => {
  it('restoreSessionState for an unknown sessionId returns nulls', async () => {
    const triple = await BlindfoldSession.restoreSessionState(SID2);
    assert.deepEqual(triple, { metadata: null, conditions: null, sequenceState: null });
  });

  it('non-string / empty sessionId rejects with TypeError', async () => {
    for (const bad of [123, null, undefined, '', {}, []]) {
      await assert.rejects(BlindfoldSession.restoreSessionState(bad), TypeError);
      await assert.rejects(BlindfoldSession.getSequenceState(bad), TypeError);
    }
  });
});

// ------------------------------------------------------------------
// AC6 — corrupt sequence_state → corruption error, never silent 0.
// ------------------------------------------------------------------

describe('AC6 — corrupt sequence_state honesty', () => {
  it('non-numeric nextAppendSeq → restore rejects (never silent 0)', async () => {
    await BlindfoldSession.DB.put('sequence_state', { sessionId: SID1, nextAppendSeq: 'seven' });
    await assert.rejects(
      BlindfoldSession.restoreSessionState(SID1),
      /session-store: corrupt sequence_state for session /
    );
  });

  it('missing nextAppendSeq → getSequenceState rejects (never silent 0)', async () => {
    // Note: a record missing sessionId itself cannot exist — sessionId is
    // the keyPath, so real IndexedDB (and this fake) reject it at write
    // time with DataError. Corruption on the read path means bad field
    // values, not a missing key.
    await BlindfoldSession.DB.put('sequence_state', { sessionId: SID1 });
    await assert.rejects(
      BlindfoldSession.getSequenceState(SID1),
      /session-store: corrupt sequence_state for session /
    );
  });

  it('negative / fractional nextAppendSeq → corruption error', async () => {
    await BlindfoldSession.DB.put('sequence_state', { sessionId: SID1, nextAppendSeq: -1 });
    await assert.rejects(BlindfoldSession.getSequenceState(SID1), /corrupt sequence_state/);
    await BlindfoldSession.DB.put('sequence_state', { sessionId: SID1, nextAppendSeq: 2.5 });
    await assert.rejects(BlindfoldSession.getSequenceState(SID1), /corrupt sequence_state/);
  });

  it('absent counter → null (not corruption, not 0)', async () => {
    assert.equal(await BlindfoldSession.getSequenceState(SID1), null);
  });
});

// ------------------------------------------------------------------
// AC7 — invalid stored metadata → restore rejects.
// ------------------------------------------------------------------

describe('AC7 — invalid stored records are rejected on restore', () => {
  it('stripped-keys metadata written around the validator → restore rejects', async () => {
    await BlindfoldSession.DB.put('session_metadata', { sessionId: SID1 });
    await assert.rejects(
      BlindfoldSession.restoreSessionState(SID1),
      /session-store: invalid stored session_metadata/
    );
  });

  it('stripped-keys conditions written around the validator → restore rejects', async () => {
    await BlindfoldSession.DB.put('session_metadata', makeMetadata(SID1));
    // sessionId present (it is the keyPath — a record without it cannot be
    // stored), but the other six fields stripped: invalid per the 1.2
    // validator.
    await BlindfoldSession.DB.put('conditions', {
      sessionId: SID1,
      trainingApproach: { value: null, source: 'observed' }
    });
    await assert.rejects(
      BlindfoldSession.restoreSessionState(SID1),
      /session-store: invalid stored conditions/
    );
  });
});

// ------------------------------------------------------------------
// AC8 — replace semantics; peek never writes.
// ------------------------------------------------------------------

describe('AC8 — replace semantics and read-only peek', () => {
  it('second save overwrites; no duplicates', async () => {
    const first = makeMetadata(SID1);
    await BlindfoldSession.saveSessionMetadata(first);
    const second = Object.assign({}, first, { sessionCategory: 'evaluation' });
    await BlindfoldSession.saveSessionMetadata(second);
    const triple = await BlindfoldSession.restoreSessionState(SID1);
    assert.equal(triple.metadata.sessionCategory, 'evaluation');
  });

  it('getSequenceState returns the stored record verbatim', async () => {
    await BlindfoldSession.DB.put('sequence_state', { sessionId: SID1, nextAppendSeq: 12 });
    assert.deepEqual(
      await BlindfoldSession.getSequenceState(SID1),
      { sessionId: SID1, nextAppendSeq: 12 }
    );
  });

  it('peek on an absent counter leaves the store untouched', async () => {
    assert.equal(await BlindfoldSession.getSequenceState(SID1), null);
    assert.equal(await BlindfoldSession.DB.get('sequence_state', SID1), undefined);
  });
});

// ------------------------------------------------------------------
// AC9 — diff discipline.
// ------------------------------------------------------------------

describe('AC9 — diff discipline', () => {
  it('sw.js functional lines are exactly the contracted set', () => {
    const swRaw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    const swCode = swRaw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const lines = swCode.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    assert.deepEqual(lines, [
      "'use strict';",
      "importScripts('db.js', 'event_envelope.js', 'writer.js', 'session_identity.js', 'session_conditions.js', 'session_store.js');",
      'BlindfoldSession.writerListener = BlindfoldSession.installWriterListener();'
    ]);
  });

  it('db.js, sender.js, manifest.json, content.js byte-identical to HEAD', () => {
    for (const f of ['db.js', 'sender.js', 'manifest.json', 'content.js']) {
      const head = execSync(`git show HEAD:${f}`, { cwd: ROOT, stdio: 'pipe' }).toString();
      const current = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.strictEqual(current, head, `${f} changed but 2.6 must not touch it`);
    }
  });

  it('writer.js diff is only the 2.6 SF-1 corruption-honesty repair', () => {
    // Honest cumulative evolution: the 2.6 adversarial review's SHOULD_FIX
    // (SF-1) required the writer to fail honestly on a corrupt counter
    // instead of silently renumbering to 0. The diff is the repair block
    // only — no other writer.js change.
    const diff = execSync('git diff HEAD -- writer.js', { cwd: ROOT }).toString();
    const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    const removed = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
    assert.equal(removed.length, 3, `writer.js: expected exactly 3 removed lines, got ${removed.length}`);
    assert.ok(removed[0].includes('var next = (rec && typeof rec.nextAppendSeq'), 'removed line must be the old fallback');
    assert.ok(added.some((l) => l.includes('CorruptSequenceState')), 'added block must name the corruption error');
    assert.ok(added.some((l) => l.includes('fail(corruptErr)')), 'added block must fail the write');
    assert.ok(added.every((l) => !l.includes('.put(')), 'repair must not add any store writes');
  });

  it('session_identity.js / session_conditions.js diffs are only the export lines', () => {
    for (const f of ['session_identity.js', 'session_conditions.js']) {
      const diff = execSync(`git diff HEAD -- ${f}`, { cwd: ROOT }).toString();
      const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
      assert.equal(added.length, 3, `${f}: expected exactly 3 added lines, got ${added.length}`);
      assert.ok(added[2].includes('requireValid'), `${f}: third added line must be the export`);
    }
  });

  it('no other repo files modified (git status allowlist)', () => {
    const status = execSync('git status --porcelain', { cwd: ROOT }).toString();
    const changed = status.split('\n').filter((l) => l.trim()).map((l) => l.slice(3).trim());
    const allowed = new Set([
      'sw.js',
      'session_store.js',
      'session_identity.js',
      'session_conditions.js',
      'tests/session_store.test.js',
      // Honest cumulative evolution (2.2/2.3/2.4/2.5 precedent): earlier
      // tasks' allowlists admit this task's files and vice versa.
      // 2.6's SF-1 repair (adversarial review should-fix) legitimately
      // touches writer.js: the corrupt-counter fallback becomes an
      // honest write failure instead of a silent renumber to 0.
      'writer.js',
      'tests/db.test.js',
      'tests/manifest_sw.test.js',
      'tests/sender.test.js',
      'tests/writer.test.js',
      'tests/event_envelope.test.js',
      'tests/game_records.test.js',
      'tests/session_identity.test.js',
      '.autodev/evidence/2.6.contract.md',
      '.autodev/evidence/2.6.build.md',
      // This task's own verification evidence lands after the builder ran:
      '.autodev/evidence/2.6.review.md',
      '.autodev/evidence/2.6.behavior.md',
      '.autodev/DECISIONS.md'
    ]);
    for (const f of changed) {
      assert.ok(allowed.has(f), `unexpected modified file: ${f}`);
    }
    assert.ok(changed.includes('session_store.js'), 'session_store.js must be new');
    assert.ok(changed.includes('sw.js'), 'sw.js must be modified');
  });
});
