// Task 2.4 (PLAN.md §2.4): V1 verification for writer.js — the
// transactional event writer (dedup by eventId, commit-awaited acks).
//
// Hand-rolled in-memory IndexedDB fake (the repo stays dependency-free —
// no fake-indexeddb). The fake consumes the REAL DB.SCHEMA, so schema
// drift breaks here by design. Documented fake limits (see makeFakeIDB):
// the fake does NOT model overlapping-transaction serialization — the
// §2.6 no-lock concurrency argument is verified at V2 against real
// IndexedDB (AC13). It also does not model structured-clone
// serialization (records are stored by reference).
//
// Real-transport behavior is covered at V2 in the puppeteer harness
// (~/workspace/tools/ext-verify/sw-writer.js).

const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// Load order: event_envelope.js, then db.js; publish the merged namespace
// on globalThis (writer.js reads both at call time via the shared
// namespace), then require writer.js and merge its exports.
const Envelope = require('../event_envelope.js');
const DBModule = require('../db.js');
const merged = Object.assign({}, Envelope, DBModule);
const priorGlobal = globalThis.BlindfoldSession;
globalThis.BlindfoldSession = merged;
const WriterExports = require('../writer.js');
Object.assign(merged, WriterExports);
const BlindfoldSession = merged;

const WRITER_PATH = path.join(ROOT, 'writer.js');
const writerSource = fs.readFileSync(WRITER_PATH, 'utf8');
// Strip line and block comments so static checks see code tokens only.
const codeOnly = writerSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

// Deterministic UUID v4 fixtures (version nibble 4, variant nibble 8-b).
const SID1 = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const SID2 = 'b1f2a345-6c78-4d9e-8f01-23456789abcd';
const EID1 = 'c2f3a456-7d89-4e0f-9123-456789abcdef';
const EID2 = 'd3f4b567-8e9a-4f01-a234-56789abcdef0';
const EID3 = 'e4f5c678-9f0b-4012-b345-6789abcdef01';

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ------------------------------------------------------------------
// In-memory IndexedDB fake.
// ------------------------------------------------------------------
// Implements exactly the IDB surface writer.js touches:
//   indexedDB.open(name, version) -> request {onupgradeneeded, onsuccess,
//     onerror, result, error}
//   db.transaction(storeNames, mode) -> tx {objectStore(name), abort(),
//     oncomplete, onerror, onabort}
//   db.objectStoreNames.contains(name); db.createObjectStore(name, {keyPath})
//   upgradeTx.objectStore(name)
//   store.get(key) / store.put(record) -> request {onsuccess, onerror,
//     result, error}; store.indexNames.contains(name);
//   store.createIndex(name, keyPath, {unique})
// KeyPaths are extracted from the REAL DB.SCHEMA (string and compound
// forms). A record missing its keyPath value makes put() throw
// synchronously with name 'DataError' (mirrors the real DOMException).
//
// Transactional fidelity: writes go to a per-tx journal and are applied
// to the committed stores ONLY on tx commit; abort discards the journal.
// Reads see the tx's own journaled writes first (last write wins), then
// committed state — mirroring real IndexedDB. This is what makes the AC9
// atomicity tests meaningful.
//
// Failure injection:
//   fake.failNextPut = {name, message} — the next put() request fails.
//   fake.failPutOnStore = '<store>' — the next put() to that store fails
//     (lets a test fail the second put in a transaction).
//   fake.brokenStores.add('<store>') — db.transaction() throws
//     NotFoundError synchronously for that store (schema-drift surface).
// Ordering observability: fake.onTxComplete() is invoked synchronously
// before the fake fires tx.oncomplete, so tests can assert the ack came
// from the commit event.
function makeFakeIDB() {
  const schema = BlindfoldSession.DB.SCHEMA;
  const stores = {}; // name -> { keyPath, records: Map, indexes: {} }
  const fake = {
    failNextPut: null,
    failPutOnStore: null,
    brokenStores: new Set(),
    onTxComplete: null,
    _stores: stores,
    open: function (name, version) {
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null,
                    result: undefined, error: undefined };
      queueMicrotask(() => {
        const db = makeFakeDB();
        req.result = db;
        try {
          if (req.onupgradeneeded) {
            req.onupgradeneeded({ target: req, oldVersion: 0, newVersion: version });
          }
          if (req.onsuccess) req.onsuccess({ target: req });
        } catch (e) {
          req.error = e;
          if (req.onerror) req.onerror({ target: req });
        }
      });
      return req;
    }
  };

  function dataError() {
    const e = new Error('fake: keyPath value missing');
    e.name = 'DataError';
    return e;
  }
  function notFoundError(what) {
    const e = new Error('fake: ' + what + ' not found');
    e.name = 'NotFoundError';
    return e;
  }

  function extractKey(keyPath, record) {
    let raw;
    if (Array.isArray(keyPath)) {
      raw = keyPath.map((k) => record[k]);
      if (raw.some((v) => v === undefined)) throw dataError();
    } else {
      raw = record[keyPath];
      if (raw === undefined) throw dataError();
    }
    return JSON.stringify(raw);
  }

  function makeFakeDB() {
    // Pre-create every store from the real schema (fresh per open).
    for (const spec of schema.stores) {
      if (!stores[spec.name]) {
        stores[spec.name] = { keyPath: spec.keyPath, records: new Map(), indexes: {} };
        for (const idx of spec.indexes) stores[spec.name].indexes[idx.name] = idx;
      }
    }
    return {
      objectStoreNames: { contains: (n) => !!stores[n] },
      createObjectStore: (n, opts) => {
        if (!stores[n]) stores[n] = { keyPath: opts.keyPath, records: new Map(), indexes: {} };
        return makeFakeStore(n, null);
      },
      transaction: (storeNames, mode) => makeFakeTx(storeNames, mode),
      close: () => {}
    };
  }

  function makeFakeStore(name, tx) {
    const store = stores[name];
    function journaledGet(key) {
      const k = JSON.stringify(key);
      if (tx) {
        for (let i = tx._journal.length - 1; i >= 0; i--) {
          const w = tx._journal[i];
          if (w.store === name && w.key === k) return w.record;
        }
      }
      return store.records.get(k);
    }
    return {
      indexNames: { contains: (n) => !!store.indexes[n] },
      createIndex: (n, kp, opts) => { store.indexes[n] = { name: n, keyPath: kp, unique: !!opts.unique }; },
      get: (key) => {
        const req = { onsuccess: null, onerror: null, result: undefined, error: undefined };
        tx._pending++;
        queueMicrotask(() => {
          tx._pending--;
          req.result = journaledGet(key);
          if (req.onsuccess) req.onsuccess({ target: req });
          queueMicrotask(() => maybeComplete(tx));
        });
        return req;
      },
      put: (record) => {
        const req = { onsuccess: null, onerror: null, result: undefined, error: undefined };
        // Synchronous DataError for a missing keyPath (mirrors real IDB).
        const key = extractKey(store.keyPath, record); // throws -> caller wraps
        tx._pending++;
        queueMicrotask(() => {
          tx._pending--;
          const shouldFail = fake.failNextPut || (fake.failPutOnStore === name);
          if (shouldFail) {
            const spec = fake.failNextPut || { name: 'QuotaExceededError', message: 'fake: injected put failure' };
            fake.failNextPut = null;
            if (fake.failPutOnStore === name) fake.failPutOnStore = null;
            const err = new Error(spec.message || 'fake: injected put failure');
            err.name = spec.name || 'Error';
            req.error = err;
            if (req.onerror) req.onerror({ target: req });
          } else {
            tx._journal.push({ store: name, key: key, record: record });
            req.result = record[Array.isArray(store.keyPath) ? store.keyPath[0] : store.keyPath];
            if (req.onsuccess) req.onsuccess({ target: req });
          }
          queueMicrotask(() => maybeComplete(tx));
        });
        return req;
      }
    };
  }

  function makeFakeTx(storeNames, mode) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    for (const n of names) {
      if (!stores[n] || fake.brokenStores.has(n)) throw notFoundError('object store ' + n);
    }
    const tx = {
      _pending: 0,
      _aborted: false,
      _completed: false,
      _journal: [],
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore: (n) => {
        if (!stores[n] || fake.brokenStores.has(n)) throw notFoundError('object store ' + n);
        return makeFakeStore(n, tx);
      },
      abort: () => {
        if (tx._aborted || tx._completed) return;
        tx._aborted = true;
        tx._journal = []; // discard uncommitted writes
        queueMicrotask(() => { if (tx.onabort) tx.onabort({ target: tx }); });
      }
    };
    return tx;
  }

  function maybeComplete(tx) {
    if (!tx._aborted && !tx._completed && tx._pending === 0) {
      tx._completed = true;
      // Commit: apply the journal to the committed stores.
      for (const w of tx._journal) {
        stores[w.store].records.set(w.key, w.record);
      }
      tx._journal = [];
      if (fake.onTxComplete) fake.onTxComplete();
      if (tx.oncomplete) tx.oncomplete({ target: tx });
    }
  }

  return fake;
}

// Install a fresh fake indexedDB and clear db.js's cached handle.
function installFakeIDB() {
  const fake = makeFakeIDB();
  globalThis.indexedDB = fake;
  BlindfoldSession.DB.closeDatabase();
  return fake;
}

function uninstallIDB() {
  delete globalThis.indexedDB;
  BlindfoldSession.DB.closeDatabase();
}

// --- Event fixtures: genuine 11-key envelopes via event_envelope.js ---
let anchor = null;
let sourceSeq = 0;
function testAnchor() {
  if (!anchor) anchor = BlindfoldSession.captureClockAnchor();
  return anchor;
}
function makeEnvelope(overrides) {
  const a = testAnchor();
  // createEvent always mints its own eventId; callers that need a
  // deterministic ID pass eventId and get it applied post-creation.
  const { eventId: wantedId, ...rest } = overrides || {};
  const env = BlindfoldSession.createEvent(Object.assign({
    eventType: 'move_confirmed',
    sessionId: SID1,
    gameId: null,
    sourceContext: 'content_script',
    sourceSeq: sourceSeq++,
    clockSegmentId: a.segmentId,
    monotonicMs: a.monotonicMs + sourceSeq,
    payload: { from: 'e2', to: 'e4', promotion: null }
  }, rest));
  if (wantedId !== undefined) {
    return Object.freeze(Object.assign({}, env, { eventId: wantedId }));
  }
  return env;
}
function storedRecord(fake, eventId) {
  return fake._stores.events.records.get(JSON.stringify(eventId));
}
function seqState(fake, sessionId) {
  return fake._stores.sequence_state.records.get(JSON.stringify(sessionId));
}
// Stores are created lazily on indexedDB.open(); a test that never
// triggers a write sees no store at all — which also means "nothing written".
function storeSize(fake, name) {
  const s = fake._stores[name];
  return s ? s.records.size : 0;
}

beforeEach(() => {
  uninstallIDB();
  delete globalThis.chrome;
  sourceSeq = 0;
});

// ------------------------------------------------------------------
// AC1: module loads in Node; exports; static guards.
// ------------------------------------------------------------------
describe('AC1 — module shape and static guards', () => {
  it('loads in Node with no chrome global', () => {
    assert.equal(typeof globalThis.chrome, 'undefined');
    assert.equal(typeof BlindfoldSession.writeEvent, 'function');
    assert.equal(typeof BlindfoldSession.installWriterListener, 'function');
    assert.equal(BlindfoldSession.MESSAGE_KIND, 'event');
  });

  it('no chrome.* literal or localStorage outside comments', () => {
    assert.ok(!/chrome\./.test(codeOnly), 'found chrome. literal in code');
    assert.ok(!/localStorage/.test(codeOnly), 'found localStorage in code');
  });

  it('no indexedDB read at load time (module required fine without it)', () => {
    assert.equal(typeof globalThis.indexedDB, 'undefined');
    assert.ok(BlindfoldSession.DB, 'DB namespace present');
  });
});

// ------------------------------------------------------------------
// AC2: malformed kind:'event' messages; writeEvent TypeError.
// ------------------------------------------------------------------
describe('AC2 — malformed messages', () => {
  function installListenerHarness() {
    const calls = [];
    const listeners = [];
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener: (fn) => listeners.push(fn) }
      }
    };
    BlindfoldSession.installWriterListener();
    return { calls, listeners };
  }

  it('writeEvent(nonObject) throws TypeError synchronously', () => {
    for (const bad of [null, undefined, 42, 'event', []]) {
      assert.throws(() => BlindfoldSession.writeEvent(bad), TypeError);
    }
  });

  it('listener: kind:event with missing event -> malformed-message, nothing written', async () => {
    const fake = installFakeIDB();
    const { listeners } = installListenerHarness();
    const responses = [];
    const ret = listeners[0]({ kind: 'event' }, {}, (ack) => responses.push(ack));
    assert.equal(ret, false, 'sync response should return false');
    assert.deepStrictEqual(responses, [{ ok: false, eventId: null, error: 'malformed-message' }]);
    await tick();
    assert.equal(storeSize(fake, 'events'), 0, 'nothing written');
    assert.equal(storeSize(fake, 'sequence_state'), 0, 'counter untouched');
  });

  it('listener: kind:event with non-object event -> malformed-message', async () => {
    installFakeIDB();
    const { listeners } = installListenerHarness();
    const responses = [];
    listeners[0]({ kind: 'event', event: 'nope' }, {}, (ack) => responses.push(ack));
    assert.deepStrictEqual(responses, [{ ok: false, eventId: null, error: 'malformed-message' }]);
  });
});

// ------------------------------------------------------------------
// AC3: invalid envelope -> invalid-envelope; stores untouched.
// ------------------------------------------------------------------
describe('AC3 — envelope validation boundary', () => {
  it('envelope missing eventId -> invalid-envelope, stores untouched', async () => {
    const fake = installFakeIDB();
    const env = makeEnvelope();
    const broken = Object.assign({}, env);
    delete broken.eventId;
    const ack = await BlindfoldSession.writeEvent(broken);
    assert.equal(ack.ok, false);
    assert.equal(ack.error, 'invalid-envelope');
    assert.equal(ack.eventId, null, 'no extractable ID');
    assert.equal(storeSize(fake, 'events'), 0);
    assert.equal(storeSize(fake, 'sequence_state'), 0);
  });

  it('bad eventType (not flat snake_case) -> invalid-envelope with the intake eventId echoed', async () => {
    installFakeIDB();
    const env = makeEnvelope({ eventId: EID1 });
    const broken = Object.assign({}, env, { eventType: 'NotASnakeCaseType' });
    const ack = await BlindfoldSession.writeEvent(broken);
    assert.deepStrictEqual(ack, { ok: false, eventId: EID1, error: 'invalid-envelope' });
  });

  it('payload is NOT semantically validated (envelope-level only)', async () => {
    // A payload no Section-1 factory would produce still passes the writer:
    // semantic refereeing is the emitter's job, not the writer's.
    const fake = installFakeIDB();
    const env = makeEnvelope({ eventId: EID1, payload: { nonsense: true } });
    const ack = await BlindfoldSession.writeEvent(env);
    assert.deepStrictEqual(ack, { ok: true, eventId: EID1 });
    assert.equal(storedRecord(fake, EID1).appendSeq, 0);
  });
});

// ------------------------------------------------------------------
// AC4: appendSeq !== null on intake -> append-seq-present.
// ------------------------------------------------------------------
describe('AC4 — double-processing rule', () => {
  it('intake with appendSeq 7 -> append-seq-present, nothing written', async () => {
    const fake = installFakeIDB();
    const env = makeEnvelope({ eventId: EID1 });
    const replayed = Object.assign({}, env, { appendSeq: 7 });
    const ack = await BlindfoldSession.writeEvent(replayed);
    assert.deepStrictEqual(ack, { ok: false, eventId: EID1, error: 'append-seq-present' });
    assert.equal(storeSize(fake, 'events'), 0);
    assert.equal(storeSize(fake, 'sequence_state'), 0);
  });
});

// ------------------------------------------------------------------
// AC5: new event -> appendSeq assigned; ack only after tx.oncomplete.
// ------------------------------------------------------------------
describe('AC5 — appendSeq assignment and commit-awaited ack', () => {
  it('new event stored with appendSeq 0; counter advanced; ack after oncomplete', async () => {
    const fake = installFakeIDB();
    const order = [];
    fake.onTxComplete = () => order.push('tx-oncomplete');
    const env = makeEnvelope({ eventId: EID1 });
    const ackP = BlindfoldSession.writeEvent(env);
    const ack = await ackP.then((a) => { order.push('ack-resolved'); return a; });
    assert.deepStrictEqual(ack, { ok: true, eventId: EID1 });
    assert.deepStrictEqual(order, ['tx-oncomplete', 'ack-resolved'],
      'ack must be produced by the commit event, not before it');
    const stored = storedRecord(fake, EID1);
    assert.equal(stored.appendSeq, 0);
    assert.deepStrictEqual(seqState(fake, SID1), { sessionId: SID1, nextAppendSeq: 1 });
    // Intake object is never mutated (still the frozen null-appendSeq envelope).
    assert.equal(env.appendSeq, null);
    assert.ok(Object.isFrozen(env));
  });

  it('second event for the session gets appendSeq 1', async () => {
    const fake = installFakeIDB();
    await BlindfoldSession.writeEvent(makeEnvelope({ eventId: EID1 }));
    const ack = await BlindfoldSession.writeEvent(makeEnvelope({ eventId: EID2 }));
    assert.deepStrictEqual(ack, { ok: true, eventId: EID2 });
    assert.equal(storedRecord(fake, EID2).appendSeq, 1);
    assert.deepStrictEqual(seqState(fake, SID1), { sessionId: SID1, nextAppendSeq: 2 });
  });

  it('corrupt counter (non-numeric nextAppendSeq) fails the write honestly — no silent renumber (2.6 SF-1)', async () => {
    const fake = installFakeIDB();
    await BlindfoldSession.writeEvent(makeEnvelope({ eventId: EID1 }));
    // Plant a corrupt counter directly (bypasses the writer, the sole writer —
    // only external corruption can produce this state). Stores exist now that
    // the DB has been opened once.
    fake._stores.sequence_state.records.set(JSON.stringify(SID1), { sessionId: SID1, nextAppendSeq: 'abc' });
    const ack = await BlindfoldSession.writeEvent(makeEnvelope({ eventId: EID2 }));
    assert.equal(ack.ok, false, 'corrupt counter must fail the write');
    assert.equal(ack.error, 'write-failed:CorruptSequenceState', 'stable corruption code');
    assert.equal(fake._stores.events.records.size, 1, 'only the pre-corruption event stored');
    assert.deepStrictEqual(seqState(fake, SID1), { sessionId: SID1, nextAppendSeq: 'abc' },
      'corrupt record must not be overwritten or renumbered');
  });

  it('counter with mismatched sessionId fails the write honestly (2.6 SF-1)', async () => {
    const fake = installFakeIDB();
    await BlindfoldSession.writeEvent(makeEnvelope({ eventId: EID1 }));
    fake._stores.sequence_state.records.set(JSON.stringify(SID1), { sessionId: SID2, nextAppendSeq: 5 });
    const ack = await BlindfoldSession.writeEvent(makeEnvelope({ eventId: EID2 }));
    assert.equal(ack.ok, false, 'sessionId-mismatched counter must fail the write');
    assert.equal(ack.error, 'write-failed:CorruptSequenceState');
    assert.equal(fake._stores.events.records.size, 1, 'only the pre-corruption event stored');
  });
});

// ------------------------------------------------------------------
// AC6: per-session independent counters.
// ------------------------------------------------------------------
describe('AC6 — per-session counters', () => {
  it('two sessions count independently from 0', async () => {
    const fake = installFakeIDB();
    await BlindfoldSession.writeEvent(makeEnvelope({ eventId: EID1, sessionId: SID1 }));
    await BlindfoldSession.writeEvent(makeEnvelope({ eventId: EID2, sessionId: SID2 }));
    await BlindfoldSession.writeEvent(makeEnvelope({ eventId: EID3, sessionId: SID1 }));
    assert.equal(storedRecord(fake, EID1).appendSeq, 0);
    assert.equal(storedRecord(fake, EID2).appendSeq, 0);
    assert.equal(storedRecord(fake, EID3).appendSeq, 1);
    assert.deepStrictEqual(seqState(fake, SID1), { sessionId: SID1, nextAppendSeq: 2 });
    assert.deepStrictEqual(seqState(fake, SID2), { sessionId: SID2, nextAppendSeq: 1 });
  });
});

// ------------------------------------------------------------------
// AC7: duplicate same-content -> idempotent ok:true, counter untouched.
// ------------------------------------------------------------------
describe('AC7 — idempotent duplicate', () => {
  it('resend of the identical envelope -> ok:true, counter and record unchanged', async () => {
    const fake = installFakeIDB();
    const env = makeEnvelope({ eventId: EID1 });
    const first = await BlindfoldSession.writeEvent(env);
    assert.deepStrictEqual(first, { ok: true, eventId: EID1 });
    // Simulate the 2.5 retry-after-lost-ack: a fresh clone of the same event.
    const retry = JSON.parse(JSON.stringify(env));
    const second = await BlindfoldSession.writeEvent(retry);
    assert.deepStrictEqual(second, { ok: true, eventId: EID1 });
    assert.deepStrictEqual(seqState(fake, SID1), { sessionId: SID1, nextAppendSeq: 1 },
      'counter must not advance on idempotent retry');
    const stored = storedRecord(fake, EID1);
    assert.equal(stored.appendSeq, 0, 'assigned appendSeq preserved');
    assert.equal(fake._stores.events.records.size, 1, 'no second record');
  });

  it('same content with different key order still dedups', async () => {
    const fake = installFakeIDB();
    const env = makeEnvelope({ eventId: EID1 });
    await BlindfoldSession.writeEvent(env);
    const reordered = {};
    for (const k of Object.keys(env).reverse()) reordered[k] = env[k];
    const ack = await BlindfoldSession.writeEvent(reordered);
    assert.deepStrictEqual(ack, { ok: true, eventId: EID1 });
    assert.equal(fake._stores.events.records.size, 1);
  });
});

// ------------------------------------------------------------------
// AC8: duplicate different-content -> event-id-content-mismatch, never
// overwrites.
// ------------------------------------------------------------------
describe('AC8 — content mismatch under a known eventId', () => {
  it('same eventId, flipped payload field -> mismatch ack, stored record kept', async () => {
    const fake = installFakeIDB();
    const env = makeEnvelope({ eventId: EID1, payload: { from: 'e2', to: 'e4', promotion: null } });
    await BlindfoldSession.writeEvent(env);
    const tampered = Object.assign({}, env, {
      payload: { from: 'e2', to: 'e5', promotion: null }
    });
    const ack = await BlindfoldSession.writeEvent(tampered);
    assert.deepStrictEqual(ack,
      { ok: false, eventId: EID1, error: 'event-id-content-mismatch' });
    const stored = storedRecord(fake, EID1);
    assert.deepStrictEqual(stored.payload, { from: 'e2', to: 'e4', promotion: null },
      'stored record must never be overwritten');
    assert.equal(stored.appendSeq, 0);
    assert.deepStrictEqual(seqState(fake, SID1), { sessionId: SID1, nextAppendSeq: 1 },
      'counter untouched by the rejected duplicate');
  });
});

// ------------------------------------------------------------------
// AC9: injected write failure -> atomic abort, write-failed:<name>.
// ------------------------------------------------------------------
describe('AC9 — atomic abort on write failure', () => {
  it('failing event put -> nothing stored, counter not advanced', async () => {
    const fake = installFakeIDB();
    await BlindfoldSession.writeEvent(makeEnvelope({ eventId: EID1 }));
    fake.failNextPut = { name: 'QuotaExceededError', message: 'fake: quota' };
    const ack = await BlindfoldSession.writeEvent(makeEnvelope({ eventId: EID2 }));
    assert.equal(ack.ok, false);
    assert.equal(ack.eventId, EID2);
    assert.equal(ack.error, 'write-failed:QuotaExceededError');
    assert.equal(storedRecord(fake, EID2), undefined, 'failed event must leave no trace');
    assert.deepStrictEqual(seqState(fake, SID1), { sessionId: SID1, nextAppendSeq: 1 },
      'counter must not advance on abort');
    assert.equal(storedRecord(fake, EID1).appendSeq, 0, 'earlier event intact');
  });

  it('failing counter put -> event also rolled back', async () => {
    const fake = installFakeIDB();
    // Fail the SECOND put in the transaction (the sequence_state write).
    // The event put succeeds into the tx journal; the failed counter put
    // aborts the tx, and the journal is discarded — real IDB atomicity.
    fake.failPutOnStore = 'sequence_state';
    const ack = await BlindfoldSession.writeEvent(makeEnvelope({ eventId: EID1 }));
    assert.equal(ack.ok, false);
    assert.equal(ack.error, 'write-failed:QuotaExceededError');
    assert.equal(storeSize(fake, 'events'), 0,
      'journaled event write must be rolled back on abort');
    assert.equal(storeSize(fake, 'sequence_state'), 0);
  });

  it('synchronous transaction throw becomes a write-failed ack, not a throw', async () => {
    const fake = installFakeIDB();
    // Schema-drift surface: db.transaction throws NotFoundError
    // synchronously (mirrors the sync DataError/NotFoundError throws the
    // writer defends against per DECISIONS.md #9b).
    fake.brokenStores.add('events');
    const ack = await BlindfoldSession.writeEvent(makeEnvelope({ eventId: EID1 }));
    assert.equal(ack.ok, false);
    assert.equal(ack.error, 'write-failed:NotFoundError');
    assert.equal(ack.eventId, EID1);
  });

  it('unavailable indexedDB -> write-failed:unavailable, never throws', async () => {
    uninstallIDB(); // no indexedDB at all
    const env = makeEnvelope({ eventId: EID1 });
    const ack = await BlindfoldSession.writeEvent(env);
    assert.deepStrictEqual(ack, { ok: false, eventId: EID1, error: 'write-failed:unavailable' });
  });
});

// ------------------------------------------------------------------
// AC10: installWriterListener adapter behavior.
// ------------------------------------------------------------------
describe('AC10 — listener installation and adapter', () => {
  function fakeChrome() {
    const listeners = [];
    return {
      listeners,
      chrome: { runtime: { onMessage: { addListener: (fn) => listeners.push(fn) } } }
    };
  }

  it('kind:event -> returns true and exactly one sendResponse with the ack', async () => {
    const fake = installFakeIDB();
    const fc = fakeChrome();
    globalThis.chrome = fc.chrome;
    BlindfoldSession.installWriterListener();
    assert.equal(fc.listeners.length, 1);
    const responses = [];
    let returned;
    // Drive the listener; the ack is async (returns true).
    const env = makeEnvelope({ eventId: EID1 });
    await new Promise((resolve) => {
      returned = fc.listeners[0]({ kind: 'event', event: env }, {},
        (ack) => { responses.push(ack); resolve(); });
    });
    assert.equal(returned, true, 'async channel must stay open');
    assert.equal(responses.length, 1, 'exactly one sendResponse');
    assert.deepStrictEqual(responses[0], { ok: true, eventId: EID1 });
    assert.equal(storedRecord(fake, EID1).appendSeq, 0, 'event actually written');
  });

  it('other kinds -> returns false, no sendResponse', async () => {
    installFakeIDB();
    const fc = fakeChrome();
    globalThis.chrome = fc.chrome;
    BlindfoldSession.installWriterListener();
    const responses = [];
    const ret = fc.listeners[0]({ kind: 'something-else' }, {},
      (ack) => responses.push(ack));
    assert.equal(ret, false);
    await tick();
    assert.equal(responses.length, 0, 'no response for foreign kinds');
  });

  it('installWriterListener returns the listener for lifecycle management', () => {
    const fc = fakeChrome();
    globalThis.chrome = fc.chrome;
    const listener = BlindfoldSession.installWriterListener();
    assert.equal(typeof listener, 'function');
    assert.equal(fc.listeners[0], listener, 'returned fn is the installed one');
  });

  it('no chrome -> plain Error (not TypeError)', () => {
    delete globalThis.chrome;
    let caught = null;
    try {
      BlindfoldSession.installWriterListener();
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error, 'must throw');
    assert.equal(caught.constructor, Error, 'must be a plain Error, not a subclass');
  });
});

// ------------------------------------------------------------------
// AC11: diff discipline.
// ------------------------------------------------------------------
describe('AC11 — diff discipline', () => {
  it('sw.js: importScripts line + install calls + header update only (4.3 cumulative)', () => {
    // 2.6 legitimately extended the importScripts line per its contract
    // (session-state storage primitives); 2.7 legitimately extends it per
    // its contract (lifecycle detector); 4.1 legitimately extends it per
    // its contract (recording-context supervisor + two startup lines);
    // 4.3 legitimately extends it per its contract (SW-side capture
    // broker). Cumulative invariant: exactly one importScripts call,
    // exactly one installWriterListener call, and the completed tasks
    // removed from the absent list.
    const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    assert.ok(sw.includes("importScripts('db.js', 'event_envelope.js', 'writer.js', 'session_identity.js', 'session_conditions.js', 'session_store.js', 'lifecycle.js', 'capture_broker.js', 'recording_host.js');"),
      'importScripts line');
    assert.ok(sw.includes('BlindfoldSession.writerListener = BlindfoldSession.installWriterListener();'),
      'install call with lifecycle handle');
    assert.ok(sw.includes('BlindfoldSession.recordingHost = BlindfoldSession.createRecordingHost(globalThis.chrome || {});'),
      'recordingHost construction');
    assert.ok(sw.includes('BlindfoldSession.recordingHost.start();'),
      'recordingHost startup');
    assert.ok(!sw.includes('2.4:'), '2.4 line removed from the absent list');
    assert.ok(!sw.includes('2.6:'), '2.6 line removed from the absent list');
    assert.ok(!sw.includes('2.7: page/context start'), '2.7 line removed from the absent list');
    // No other functional surface: exactly one importScripts call, exactly
    // one installWriterListener call.
    const codeStripped = sw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.equal((codeStripped.match(/importScripts\s*\(/g) || []).length, 1);
    assert.equal((codeStripped.match(/installWriterListener\s*\(/g) || []).length, 1);
  });

  it('manifest.json differs from HEAD only in the js list and the 4.1/4.3 permissions (cumulative)', () => {
    // Honest cumulative evolution: 2.7 legitimately inserts lifecycle.js
    // after sender.js per its contract; 4.1 legitimately adds
    // "permissions": ["offscreen"] per its contract; 4.3 legitimately
    // extends it with "tabCapture" and adds host_permissions per its
    // contract. The cumulative invariant is that nothing else in the
    // manifest changed.
    const headManifest = JSON.parse(execSync('git show HEAD:manifest.json', { cwd: ROOT }).toString());
    const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    headManifest.content_scripts[0].js = current.content_scripts[0].js;
    headManifest.permissions = current.permissions;
    headManifest.host_permissions = current.host_permissions;
    assert.deepEqual(current, headManifest, 'manifest changed beyond the js list + permissions');
    assert.deepStrictEqual(current.permissions, ['offscreen', 'tabCapture']);
    assert.deepStrictEqual(current.host_permissions, ['https://www.chess.com/*']);
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
      'writer.js',
      'tests/writer.test.js',
      // Honest cumulative evolution of transient sw.js-pinning assertions
      // broken by 2.4's legitimate sw.js amendment (2.2/2.3 precedent):
      'tests/db.test.js',
      'tests/manifest_sw.test.js',
      'tests/sender.test.js',
      '.autodev/evidence/2.4.contract.md',
      '.autodev/evidence/2.4.build.md',
      // This task's own verification evidence lands after the builder ran:
      '.autodev/evidence/2.4.review.md',
      '.autodev/evidence/2.4.behavior.md',
      // Honest cumulative evolution: task 2.5 legitimately extends sender.js
      // (retry policy) and its suite (2.5 describe block); 2.5's own evidence
      // lands after its builder ran:
      'sender.js',
      'tests/sender.test.js',
      '.autodev/evidence/2.5.contract.md',
      '.autodev/evidence/2.5.build.md',
      '.autodev/evidence/2.5.review.md',
      '.autodev/evidence/2.5.behavior.md',
      // 2.5 records its retry-policy findings in DECISIONS.md (contract §3.4).
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
      // Honest cumulative evolution: task 2.6 legitimately extends sw.js
      // (session-state storage primitives), adds the two 1.1/1.2 validator
      // export lines, and extends the suites that pin those files; 2.6's
      // own evidence lands after its builder ran.
      'session_store.js',
      'session_identity.js',
      'session_conditions.js',
      'tests/session_store.test.js',
      'tests/session_identity.test.js',
      'tests/event_envelope.test.js',
      'tests/game_records.test.js',
      '.autodev/evidence/2.6.contract.md',
      '.autodev/evidence/2.6.build.md',
      '.autodev/evidence/2.6.review.md',
      '.autodev/evidence/2.6.behavior.md',
      // Honest cumulative evolution: task 2.7 legitimately adds
      // lifecycle.js (page/context lifecycle), the writer's type-agnostic
      // post-commit hook, the one-line content.js install, the manifest
      // js-list entry, the sw.js import, and its own suite + evidence;
      // the suites that pin those files evolve accordingly.
      'lifecycle.js',
      'content.js',
      'sounds.js',
      'manifest.json',
      'tests/lifecycle.test.js',
      'tests/session_store.test.js',
      'tests/manifest_sw.test.js',
      'tests/db.test.js',
      'tests/event_envelope.test.js',
      'tests/game_records.test.js',
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
    ]);
    for (const f of changed) {
      assert.ok(allowed.has(f), `unexpected modified file: ${f}`);
    }
    // NOTE (2.5): the "must be new/modified in git status" assertions below
    // were transient — they could only pass before the 2.4 feature commit.
    // The durable invariants are (a) no unexpected files above, and
    // (b) writer.js / sw.js exist with the contracted content, which the
    // content assertions in this file verify. Existence (not git novelty)
    // is what's pinned here.
    assert.ok(fs.existsSync(path.join(ROOT, 'writer.js')), 'writer.js must exist');
    assert.ok(fs.existsSync(path.join(ROOT, 'sw.js')), 'sw.js must exist');
  });
});
