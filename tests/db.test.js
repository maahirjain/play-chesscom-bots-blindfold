// tests/db.test.js
//
// Task 2.2 (PLAN.md §2.2): V1 static verification for db.js.
//
// No IndexedDB exists in Node — by design. The schema is asserted as data
// (SCHEMA deep-equality), the error contract is exercised with
// globalThis.indexedDB deleted (argument validation must run before any
// platform access), and static guards prove the storage layer touches
// neither the page's storage nor extension APIs. Real IndexedDB behavior is
// covered at V2 in the puppeteer harness (~/workspace/tools/ext-verify/sw-db.js).

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BlindfoldSession = require('../db.js');

describe('SCHEMA — matches contract §2.3 exactly (AC1)', () => {
  const expected = {
    dbName: 'blindfold-experiment',
    version: 1,
    stores: [
      {
        name: 'events',
        keyPath: 'eventId',
        indexes: [
          { name: 'bySessionId', keyPath: 'sessionId', unique: false },
          { name: 'byAppendSeq', keyPath: 'appendSeq', unique: false }
        ]
      },
      { name: 'session_metadata', keyPath: 'sessionId', indexes: [] },
      { name: 'conditions', keyPath: 'sessionId', indexes: [] },
      { name: 'sequence_state', keyPath: 'sessionId', indexes: [] },
      {
        name: 'media_chunks',
        keyPath: ['segmentId', 'chunkIndex'],
        indexes: []
      }
    ]
  };

  it('AC1: SCHEMA deep-equals the specified schema', () => {
    assert.deepEqual(BlindfoldSession.DB.SCHEMA, expected);
  });

  it('AC1: DB_NAME and DB_VERSION match the schema', () => {
    assert.equal(BlindfoldSession.DB.DB_NAME, 'blindfold-experiment');
    assert.equal(BlindfoldSession.DB.DB_VERSION, 1);
    assert.equal(BlindfoldSession.DB.SCHEMA.dbName, BlindfoldSession.DB.DB_NAME);
    assert.equal(BlindfoldSession.DB.SCHEMA.version, BlindfoldSession.DB.DB_VERSION);
  });

  it('AC1: schema constants are frozen (deeply)', () => {
    const s = BlindfoldSession.DB.SCHEMA;
    assert.ok(Object.isFrozen(s));
    assert.ok(Object.isFrozen(s.stores));
    for (const store of s.stores) {
      assert.ok(Object.isFrozen(store), 'store not frozen: ' + store.name);
      assert.ok(Object.isFrozen(store.keyPath), 'keyPath not frozen: ' + store.name);
      assert.ok(Object.isFrozen(store.indexes), 'indexes not frozen: ' + store.name);
      for (const idx of store.indexes) {
        assert.ok(Object.isFrozen(idx), 'index not frozen: ' + idx.name);
      }
    }
  });

  it('AC1: exactly five stores, no speculative extras', () => {
    const names = BlindfoldSession.DB.SCHEMA.stores.map((s) => s.name).sort();
    assert.deepEqual(names, [
      'conditions',
      'events',
      'media_chunks',
      'sequence_state',
      'session_metadata'
    ]);
  });
});

describe('API surface (AC2)', () => {
  it('AC2: BlindfoldSession.DB exposes the specified functions', () => {
    const DB = BlindfoldSession.DB;
    for (const fn of ['openDatabase', 'closeDatabase', 'put', 'get', 'getAll']) {
      assert.equal(typeof DB[fn], 'function', fn + ' is not a function');
    }
  });

  it('AC2: module loads in Node with indexedDB undefined (no throw at load)', () => {
    assert.equal(typeof globalThis.indexedDB, 'undefined');
    assert.ok(BlindfoldSession.DB, 'DB namespace missing after load');
  });

  it('AC2: no speculative helpers (deleteDatabase, count, transaction runner)', () => {
    const DB = BlindfoldSession.DB;
    assert.equal(typeof DB.deleteDatabase, 'undefined');
    assert.equal(typeof DB.count, 'undefined');
    assert.equal(typeof DB.transaction, 'undefined');
    assert.equal(typeof DB.validate, 'undefined');
  });
});

describe('Error contract with indexedDB unavailable (AC3)', () => {
  it('AC3: openDatabase() rejects a plain Error when indexedDB is unavailable', async () => {
    delete globalThis.indexedDB;
    await assert.rejects(
      () => BlindfoldSession.DB.openDatabase(),
      (e) => {
        assert.ok(e instanceof Error, 'not an Error');
        assert.ok(!(e instanceof TypeError), 'must be plain Error, not TypeError');
        assert.ok(!(e instanceof RangeError), 'must be plain Error, not RangeError');
        return true;
      }
    );
  });

  it('AC3: put with unknown store rejects RangeError before platform access', async () => {
    delete globalThis.indexedDB;
    await assert.rejects(() => BlindfoldSession.DB.put('nope', {}), RangeError);
  });

  it('AC3: put with non-object record rejects TypeError before platform access', async () => {
    delete globalThis.indexedDB;
    await assert.rejects(() => BlindfoldSession.DB.put('events', 42), TypeError);
    await assert.rejects(() => BlindfoldSession.DB.put('events', null), TypeError);
    await assert.rejects(() => BlindfoldSession.DB.put('events', 'x'), TypeError);
  });

  it('AC3: put with non-string store name rejects TypeError', async () => {
    delete globalThis.indexedDB;
    await assert.rejects(() => BlindfoldSession.DB.put(42, {}), TypeError);
  });

  it('AC3: get with unknown store rejects RangeError', async () => {
    delete globalThis.indexedDB;
    await assert.rejects(() => BlindfoldSession.DB.get('nope', 'k'), RangeError);
  });

  it('AC3: getAll with unknown index rejects RangeError before platform access', async () => {
    delete globalThis.indexedDB;
    await assert.rejects(
      () => BlindfoldSession.DB.getAll('events', { index: 'nope' }),
      RangeError
    );
  });

  it('AC3: getAll with non-object options rejects TypeError', async () => {
    delete globalThis.indexedDB;
    await assert.rejects(() => BlindfoldSession.DB.getAll('events', 'nope'), TypeError);
  });

  it('AC3: put on a valid store with unavailable indexedDB rejects plain Error (no silent fallback)', async () => {
    delete globalThis.indexedDB;
    await assert.rejects(
      () => BlindfoldSession.DB.put('events', { eventId: 'x' }),
      (e) => {
        assert.ok(e instanceof Error);
        assert.ok(!(e instanceof TypeError));
        assert.ok(!(e instanceof RangeError));
        return true;
      }
    );
  });
});

describe('Static guards (AC2/AC4)', () => {
  const dbSource = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  const swSource = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

  it('AC2: db.js references neither the page storage API nor extension APIs', () => {
    assert.ok(!dbSource.includes('localStorage'), 'db.js mentions localStorage');
    assert.ok(!dbSource.includes('chrome.'), 'db.js mentions chrome.*');
  });

  it('AC2: db.js imports no Section-1 contract modules', () => {
    const codeOnly = dbSource
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    assert.ok(!codeOnly.includes('importScripts'), 'db.js must not call importScripts');
  });

  it('AC4: sw.js functional code is exactly the importScripts line', () => {
    const codeLines = swSource
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, '').trim())
      .filter((l) => l.length > 0);
    assert.deepEqual(codeLines, ["'use strict';", "importScripts('db.js');"]);
  });

  it('AC4: sw.js header no longer lists 2.2 as absent; still lists 2.3-2.9', () => {
    assert.ok(!swSource.includes('2.2:'), 'sw.js still lists 2.2 as absent');
    for (const n of ['2.3', '2.4', '2.5', '2.6', '2.7', '2.8', '2.9']) {
      assert.ok(swSource.includes(n + ':'), 'sw.js missing absent entry ' + n);
    }
  });

  it('AC4: manifest.json is byte-identical to HEAD (IndexedDB is permissionless)', () => {
    const atHead = execSync('git show HEAD:manifest.json', { cwd: ROOT });
    const onDisk = fs.readFileSync(path.join(ROOT, 'manifest.json'));
    assert.ok(atHead.equals(onDisk), 'manifest.json changed in task 2.2');
  });
});
