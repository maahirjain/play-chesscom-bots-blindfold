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
    // 2.7 legitimately appends lifecycle.js to the importScripts line per
    // its contract (SW-side discontinuity detection); 4.1 legitimately
    // appends recording_host.js plus the two recordingHost startup lines
    // per its contract (recording-context supervision); 4.3 legitimately
    // appends capture_broker.js per its contract (SW-side capture broker).
    assert.deepEqual(lines, [
      "'use strict';",
      "importScripts('db.js', 'event_envelope.js', 'writer.js', 'session_identity.js', 'session_conditions.js', 'session_store.js', 'lifecycle.js', 'capture_broker.js', 'recording_host.js');",
      'BlindfoldSession.writerListener = BlindfoldSession.installWriterListener();',
      'BlindfoldSession.recordingHost = BlindfoldSession.createRecordingHost(globalThis.chrome || {});',
      'BlindfoldSession.recordingHost.start();'
    ]);
  });

  it('sender.js byte-identical to HEAD (db.js legitimately changed by 4.5)', () => {
    // Honest cumulative evolution (4.5): db.js leaves this list — 4.5
    // legitimately bumps DB_VERSION 1 → 2 and adds the
    // recording_manifest store (see its pin in
    // tests/format_support.test.js). sender.js must be untouched.
    for (const f of ['sender.js']) {
      const head = execSync(`git show HEAD:${f}`, { cwd: ROOT, stdio: 'pipe' }).toString();
      const current = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.strictEqual(current, head, `${f} changed but 2.7/4.5 must not touch it`);
    }
  });

  it('manifest.json js list carries lifecycle.js and status_indicator.js in contracted order', () => {
    // Honest cumulative evolution: 2.7 inserted lifecycle.js after sender.js;
    // 2.8 inserts status_indicator.js after lifecycle.js (deviation from the
    // 2.8 contract AC10 documented in 2.8.build.md — the module cannot load
    // in the content script without the manifest entry); 4.1 legitimately
    // adds "permissions": ["offscreen"] per its contract (pinned in
    // tests/recording_host.test.js AC2); 4.3 legitimately extends it with
    // "tabCapture" and adds host_permissions per its contract; 4.11
    // appends sync_flash.js (the visible sync-marker content script)
    // per its contract — content.js itself stays byte-identical.
    const headManifest = JSON.parse(
      execSync('git show HEAD:manifest.json', { cwd: ROOT, stdio: 'pipe' }).toString());
    const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    headManifest.content_scripts[0].js = current.content_scripts[0].js;
    headManifest.permissions = current.permissions;
    headManifest.host_permissions = current.host_permissions;
    assert.deepEqual(current, headManifest, 'manifest changed beyond the js list + permissions');
    assert.deepEqual(current.content_scripts[0].js, [
      'event_envelope.js', 'sender.js', 'lifecycle.js', 'status_indicator.js',
      'sounds.js', 'chess.min.js', 'game_records.js', 'chess_utils.js', 'content.js',
      'sync_flash.js'
    ]);
  });

  it('content.js carries the 2.7 install line (2.7 committed)', () => {
    // Post-commit durable form of the 2.7 diff pin. (2.8's install wiring
    // is pinned in tests/status_indicator.test.js.)
    const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
    const occurrences = src.split('BlindfoldSession.installPageEndHook(BlindfoldSession.sender);').length - 1;
    assert.strictEqual(occurrences, 1, 'content.js: exactly one 2.7 install line');
  });

  it('writer.js carries the 2.7 §3.2 hook (2.7 committed)', () => {
    // Post-commit durable form of the 2.7 diff pin.
    const src = fs.readFileSync(path.join(ROOT, 'writer.js'), 'utf8');
    assert.ok(src.includes('function fireAfterEventStored'), 'hook helper present');
    assert.ok(src.includes('fireAfterEventStored(message, ack)'), 'success-path call site');
    assert.ok(src.includes('fireAfterEventStored(message, failAck)'), 'failure-path call site');
    assert.ok(src.includes('afterEventStored'), 'hook consumer reference');
    assert.ok(!src.slice(src.indexOf('function fireAfterEventStored'),
      src.indexOf('function fireAfterEventStored') + 800).includes('eventType'),
      'hook must stay type-agnostic');
  });

  it('session_identity.js / session_conditions.js byte-identical to HEAD', () => {
    // Honest cumulative evolution: the 2.6 "only the export lines" pin
    // was transient (it could only pass pre-commit); 2.6 is committed,
    // so the 2.7 invariant is that 2.7 does not touch the 1.1/1.2 modules.
    for (const f of ['session_identity.js', 'session_conditions.js']) {
      const head = execSync(`git show HEAD:${f}`, { cwd: ROOT, stdio: 'pipe' }).toString();
      const current = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.strictEqual(current, head, `${f} changed but 2.7 must not touch it`);
    }
  });

  it('no other repo files modified (git status allowlist)', () => {
    const status = execSync('git status --porcelain', { cwd: ROOT }).toString();
    const changed = status.split('\n').filter((l) => l.trim()).map((l) => l.slice(3).trim());
    const allowed = new Set([
      // Honest cumulative evolution: 4.1 (dedicated recording context)
      // legitimately adds recorder.html/recorder.js/recording_host.js,
      // the "offscreen" manifest permission, and the sw.js supervisor
      // wiring; its files join the allowlists.
      'recorder.html',
      'recorder.js',
      'recording_host.js',
      'manifest.json',
      'sw.js',
      'tests/recording_host.test.js',
      'tests/manifest_sw.test.js',
      '.autodev/evidence/4.1.contract.md',
      '.autodev/evidence/4.1.build.md',
      // Honest cumulative evolution: 4.1's review/behavior
      // evidence lands after the pins were evolved (2.x/3.x precedent).
      '.autodev/evidence/4.1.review.md',
      '.autodev/evidence/4.1.behavior.md',
      // Honest cumulative evolution: 4.2 (microphone selection and
      // permission handling) legitimately adds device_selection.js, routes
      // the five mic commands through recorder.js/recorder.html, and adds
      // its test + evidence; its files join the allowlists.
      'device_selection.js',
      'tests/device_selection.test.js',
      '.autodev/evidence/4.2.contract.md',
      '.autodev/evidence/4.2.build.md',
      // Honest cumulative evolution: 4.2's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1 precedent).
      '.autodev/evidence/4.2.review.md',
      '.autodev/evidence/4.2.behavior.md',
      // Honest cumulative evolution: 4.3 (screen/tab capture selection
      // and permission handling) legitimately adds capture_selection.js
      // (offscreen side) + capture_broker.js (SW side), routes the four
      // capture commands plus the three SW-leg broker messages, adds the
      // tabCapture permission + host_permissions, and adds its tests +
      // evidence; its files join the allowlists.
      'capture_selection.js',
      'capture_broker.js',
      'tests/capture_selection.test.js',
      'tests/capture_broker.test.js',
      'tests/manifest_sw.test.js',
      '.autodev/evidence/4.3.contract.md',
      '.autodev/evidence/4.3.build.md',
      // Honest cumulative evolution: 4.4 (webcam selection and
      // permission handling) modifies device_selection.js (video
      // probe kind-branch + validator messages) and recorder.js
      // (camera selector + cam-* channel), and repairs
      // restoreDevices() to await all selector restores.
      '.autodev/evidence/4.4.contract.md',
      '.autodev/evidence/4.4.build.md',
      // Honest cumulative evolution: 4.4's review/behavior
      // evidence lands after the pins were evolved (2.x/3.x/4.1-4.3 precedent).
      '.autodev/evidence/4.4.review.md',
      '.autodev/evidence/4.4.behavior.md',
      // Honest cumulative evolution: 4.5 (recording format
      // verification + recording manifest) legitimately adds
      // format_support.js, routes recorder-get-formats through
      // recorder.js/recorder.html (which now also load db.js),
      // bumps db.js to version 2 with the recording_manifest
      // store, and adds its test + evidence; its files join
      // the allowlists.
      'format_support.js',
      'db.js',
      'tests/format_support.test.js',
      '.autodev/evidence/4.5.contract.md',
      '.autodev/evidence/4.5.build.md',
      // Honest cumulative evolution: 4.5's review/behavior
      // evidence lands after the pins were evolved (2.x/3.x/4.1-4.4 precedent).
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
      // Honest cumulative evolution: 4.3's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1/4.2 precedent).
      '.autodev/evidence/4.3.review.md',
      '.autodev/evidence/4.3.behavior.md',
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
      // Honest cumulative evolution: task 2.7 legitimately adds
      // lifecycle.js, the writer's type-agnostic hook, the content.js
      // install line, the manifest js-list entry, and extends the suites
      // that pin those files.
      'lifecycle.js',
      'content.js',
      'manifest.json',
      'tests/lifecycle.test.js',
      '.autodev/evidence/2.7.contract.md',
      '.autodev/evidence/2.7.build.md',
      // Honest cumulative evolution (2.2–2.7 precedent): 2.8 legitimately
      // adds status_indicator.js (new), wires it in content.js + the
      // manifest js list + overlay.css, and evolves these pins.
      'status_indicator.js',
      'tests/status_indicator.test.js',
      'content.js',
      'manifest.json',
      'overlay.css',
      '.autodev/evidence/2.8.contract.md',
      '.autodev/evidence/2.8.build.md',
      // Honest cumulative evolution: the adversarial review and
      // behavioral verification evidence land after the builder
      // evolved these pins (2.6 precedent).
      '.autodev/evidence/2.7.review.md',
      '.autodev/evidence/2.7.behavior.md',
      // Honest cumulative evolution: the 2.8 adversarial review and
      // behavioral verification evidence land after the builder
      // evolved these pins (2.6/2.7 precedent).
      '.autodev/evidence/2.8.review.md',
      '.autodev/evidence/2.8.behavior.md',
      // Honest cumulative evolution (2.2–2.8 precedent): 2.9 adds the
      // retention scan suite (no product code) and evolves these pins.
      'tests/retention.test.js',
      '.autodev/evidence/2.9.contract.md',
      '.autodev/evidence/2.9.build.md',
      // Honest cumulative evolution: the adversarial review and
      // behavioral verification evidence land after the builder
      // evolved these pins (2.6/2.7/2.8 precedent).
      '.autodev/evidence/2.9.review.md',
      '.autodev/evidence/2.9.behavior.md',
      // Honest cumulative evolution: 3.1 legitimately touches
      // chess_utils.js (tracker), content.js (wiring), manifest.json
      // (game_records.js for 1.4 factories), and adds the suite.
      'chess_utils.js',
      'content.js',
      'manifest.json',
      'tests/history_tracker.test.js',
      '.autodev/evidence/3.1.contract.md',
      '.autodev/evidence/3.1.build.md',
      // Honest cumulative evolution: the adversarial review and
      // behavioral verification evidence land after the builder
      // evolved these pins (2.x precedent).
      '.autodev/evidence/3.1.review.md',
      '.autodev/evidence/3.1.behavior.md',
      // Honest cumulative evolution: 3.2's planner contract lands
      // before this task's pins evolve (3.1 precedent).
      '.autodev/evidence/3.2.contract.md',
      '.autodev/evidence/3.2.build.md',
      // Honest cumulative evolution: 3.2's review/behavior evidence
      // lands after the pins were evolved (2.x/3.1 precedent).
      '.autodev/evidence/3.2.review.md',
      '.autodev/evidence/3.2.behavior.md',
      // Honest cumulative evolution: 3.3 legitimately touches
      // chess_utils.js + content.js; its files join the allowlists.
      'tests/visibility.test.js',
      'tests/speech.test.js',
      '.autodev/evidence/3.3.contract.md',
      '.autodev/evidence/3.3.build.md',
      // Honest cumulative evolution: 3.3's review/behavior evidence
      // lands after the pins were evolved (2.x/3.1/3.2 precedent).
      '.autodev/evidence/3.3.review.md',
      '.autodev/evidence/3.3.behavior.md',
      '.autodev/evidence/3.3.domaudit.md',
            'sounds.js',
      'tests/speech.test.js',
// Honest cumulative evolution: 3.4 legitimately touches
      // sounds.js + content.js and adds its evidence.
      '.autodev/evidence/3.4.contract.md',
      '.autodev/evidence/3.4.build.md',
      // Honest cumulative evolution: 3.4's review/behavior evidence
      // lands after the pins were evolved (2.x/3.1/3.2/3.3 precedent).
      '.autodev/evidence/3.4.review.md',
      '.autodev/evidence/3.4.behavior.md',
      // Honest cumulative evolution: 3.5 legitimately touches
      // chess_utils.js (game lifecycle recorder + additive onGameReset
      // { confirmedMoveCount } argument) + content.js (visibility/focus
      // listeners, onGameReset recording, chess_rules game-end wiring);
      // adds tests/game_lifecycle.test.js and its evidence; records the
      // 3.5.3 dialog / reconnect audit in DECISIONS.md.
      'chess_utils.js',
      'tests/game_lifecycle.test.js',
      '.autodev/evidence/3.5.contract.md',
      '.autodev/evidence/3.5.build.md',
      // Honest cumulative evolution: 3.5's rereview/behavior
      // evidence lands after the pins were evolved (2.x/3.x precedent).
      '.autodev/evidence/3.5.rereview.md',
      '.autodev/evidence/3.5.behavior.md',
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
      // Honest cumulative evolution: 3.5's review/behavior evidence
      // lands after the pins were evolved (2.x/3.1/3.2/3.3/3.4 precedent).
      '.autodev/evidence/3.5.review.md',
      '.autodev/evidence/3.5.behavior.md',
      'tests/attempt_tracker.test.js',
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
    // NOTE (2.9): the 2.8 "status_indicator.js must be new" assertion was
    // transient — it could only pass before the 2.8 feature commit, same as
    // the 2.7 novelty assertions noted above. The durable invariant is the
    // allowlist (no unexpected files); 2.9 adds no product files.
  });
});
