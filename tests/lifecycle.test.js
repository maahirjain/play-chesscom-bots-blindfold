// tests/lifecycle.test.js
//
// V1 verification for task 2.7 (PLAN.md §2.7): page/context start and
// clean-end events; unclean-discontinuity marking.
//
// Covers AC1–AC15 (static/unit). AC16–AC17 run at V2 (sw-lifecycle.js
// harness + full suite); AC18 is deferred to §7/owner device.
//
// The SW-side detection tests use the REAL db.js + REAL writer.js against
// the in-memory IndexedDB fake (2.4 precedent, extended here with index /
// openCursor support for the bySessionId queries lifecycle.js performs).
// lifecycle.js performs zero raw IDB writes — detection reads via
// BlindfoldSession.DB.getAll and writes only via BlindfoldSession.writeEvent.
//
// Module-state isolation: lifecycle.js holds per-SW-instance state
// (swAnchors, swSeqs, sessionChains); tests use unique sessionIds per
// test rather than a test-only reset API (contract §6).

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// Load order: event_envelope.js, db.js, sender.js, writer.js, then
// lifecycle.js; publish the merged namespace on globalThis (lifecycle.js
// reads sibling exports at call time via the shared namespace).
const Envelope = require('../event_envelope.js');
const DBModule = require('../db.js');
const SenderModule = require('../sender.js');
const merged = Object.assign({}, Envelope, DBModule, SenderModule);
const priorGlobal = globalThis.BlindfoldSession;
globalThis.BlindfoldSession = merged;
const WriterExports = require('../writer.js');
Object.assign(merged, WriterExports);
const LifecycleExports = require('../lifecycle.js');
Object.assign(merged, LifecycleExports);
const BlindfoldSession = merged;

// Fake IDBKeyRange for db.js's keyRangeFor (Node has no IDBKeyRange).
// The fake cursor below interprets __fakeRange bounds.
globalThis.IDBKeyRange = {
  bound: (lower, upper) => ({ __fakeRange: true, lower, upper }),
  lowerBound: (lower) => ({ __fakeRange: true, lower }),
  upperBound: (upper) => ({ __fakeRange: true, upper })
};

// Deterministic uuid-v4 fixtures (version nibble 4, variant nibble 8).
let uuidCounter = 0;
function testUuid() {
  uuidCounter++;
  const h = uuidCounter.toString(16).padStart(12, '0');
  return `11111111-2222-4333-8444-${h}`;
}
function sid() { return testUuid(); }

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ------------------------------------------------------------------
// In-memory IndexedDB fake (2.4 precedent + index/openCursor extension).
// ------------------------------------------------------------------
// Implements the IDB surface db.js + writer.js touch, plus:
//   store.index(name) -> { openCursor(range) }
//   store.openCursor(range) / index.openCursor(range)
//   globalThis.IDBKeyRange (installed above)
// Documented fake limits (inherited from 2.4): no overlapping-transaction
// serialization; no structured-clone (records stored by reference).
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

  function openFakeCursor(store, keyPath, range, tx) {
    const req = { onsuccess: null, onerror: null, result: undefined, error: undefined };
    tx._pending++;
    const values = [];
    for (const record of store.records.values()) {
      if (range && range.__fakeRange) {
        const v = keyPath ? record[keyPath] : undefined;
        if (range.lower !== undefined && (v === undefined || v < range.lower)) continue;
        if (range.upper !== undefined && (v === undefined || v > range.upper)) continue;
      }
      values.push(record);
    }
    let i = 0;
    function fire() {
      queueMicrotask(() => {
        if (i < values.length) {
          const cursor = { value: values[i], continue: () => { i++; fire(); } };
          req.result = cursor;
        } else {
          req.result = null;
          tx._pending--;
        }
        if (req.onsuccess) req.onsuccess({ target: req });
        queueMicrotask(() => maybeComplete(tx));
      });
    }
    fire();
    return req;
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
      index: (n) => {
        if (!store.indexes[n]) throw notFoundError('index ' + n);
        return { openCursor: (range) => openFakeCursor(store, store.indexes[n].keyPath, range, tx) };
      },
      openCursor: (range) => openFakeCursor(store, null, range, tx),
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
        tx._journal = [];
        queueMicrotask(() => { if (tx.onabort) tx.onabort({ target: tx }); });
      }
    };
    return tx;
  }

  function maybeComplete(tx) {
    if (!tx._aborted && !tx._completed && tx._pending === 0) {
      tx._completed = true;
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

// ------------------------------------------------------------------
// Scenario helpers.
// ------------------------------------------------------------------

// Stores a full page-context segment: clock_anchor + page_start (+ optional
// page_end_clean), all via the REAL writer. Returns the envelopes.
async function storeSegment(sessionId, utcEpochMs, opts) {
  const BS = BlindfoldSession;
  const withEnd = !!(opts && opts.withEnd);
  const seqBase = (opts && opts.seqBase) || 0;
  const segmentId = testUuid();
  const anchor = BS.createClockAnchor({
    segmentId: segmentId, utcEpochMs: utcEpochMs, monotonicMs: 10
  });
  const anchorEv = BS.createAnchorEvent({
    sessionId: sessionId, sourceContext: 'content_script',
    sourceSeq: seqBase, anchor: anchor
  });
  const startEv = BS.createEvent({
    eventType: 'page_start', sessionId: sessionId, gameId: null,
    sourceContext: 'content_script', sourceSeq: seqBase + 1,
    clockSegmentId: segmentId, monotonicMs: 20, payload: {}
  });
  await BS.writeEvent(anchorEv);
  const ack = await BS.writeEvent(startEv);
  assert.equal(ack.ok, true, 'page_start must store');
  let endEv = null;
  if (withEnd) {
    endEv = BS.createEvent({
      eventType: 'page_end_clean', sessionId: sessionId, gameId: null,
      sourceContext: 'content_script', sourceSeq: seqBase + 2,
      clockSegmentId: segmentId, monotonicMs: 30,
      payload: { reason: 'pagehide' }
    });
    const endAck = await BS.writeEvent(endEv);
    assert.equal(endAck.ok, true, 'page_end_clean must store');
  }
  return { segmentId, anchor, anchorEv, startEv, endEv };
}

async function eventsOfType(sessionId, eventType) {
  const rows = await BlindfoldSession.DB.getAll('events', {
    index: 'bySessionId', lower: sessionId, upper: sessionId
  });
  return rows.filter((r) => r.eventType === eventType);
}

async function allSessionEvents(sessionId) {
  return BlindfoldSession.DB.getAll('events', {
    index: 'bySessionId', lower: sessionId, upper: sessionId
  });
}
// ------------------------------------------------------------------
// AC1: constants; event_envelope.js untouched.
// ------------------------------------------------------------------
describe('AC1 — lifecycle event-type constants', () => {
  it('exports the three exact event-type strings', () => {
    assert.strictEqual(BlindfoldSession.PAGE_START, 'page_start');
    assert.strictEqual(BlindfoldSession.PAGE_END_CLEAN, 'page_end_clean');
    assert.strictEqual(BlindfoldSession.PAGE_DISCONTINUITY, 'page_discontinuity');
  });

  it('all three match the 1.3 EVENT_TYPE_RE', () => {
    for (const t of [BlindfoldSession.PAGE_START, BlindfoldSession.PAGE_END_CLEAN,
                     BlindfoldSession.PAGE_DISCONTINUITY]) {
      assert.ok(BlindfoldSession.EVENT_TYPE_RE.test(t), t + ' must match EVENT_TYPE_RE');
    }
  });

  it('event_envelope.js is byte-identical to HEAD (2.7 owns its own constants)', () => {
    const head = execSync('git show HEAD:event_envelope.js', { cwd: ROOT }).toString();
    const current = fs.readFileSync(path.join(ROOT, 'event_envelope.js'), 'utf8');
    assert.strictEqual(current, head, 'event_envelope.js must be untouched by 2.7');
  });
});

// ------------------------------------------------------------------
// AC2: payload/refs validators.
// ------------------------------------------------------------------
describe('AC2 — payload/refs validators', () => {
  it('page_start payload: exactly {}', () => {
    BlindfoldSession.requireValidPageStartPayload({});
    assert.throws(() => BlindfoldSession.requireValidPageStartPayload({ a: 1 }), TypeError);
    assert.throws(() => BlindfoldSession.requireValidPageStartPayload(null), TypeError);
    assert.throws(() => BlindfoldSession.requireValidPageStartPayload([]), TypeError);
  });

  it('page_end_clean payload: exactly {reason: pagehide}', () => {
    BlindfoldSession.requireValidPageEndPayload({ reason: 'pagehide' });
    assert.throws(() => BlindfoldSession.requireValidPageEndPayload({}), TypeError);
    assert.throws(() => BlindfoldSession.requireValidPageEndPayload({ reason: 'unload' }), RangeError);
    assert.throws(
      () => BlindfoldSession.requireValidPageEndPayload({ reason: 'pagehide', x: 1 }),
      TypeError
    );
  });

  it('page_discontinuity payload: exactly {orphanedSegmentId, newSegmentId}, uuid-v4', () => {
    const a = testUuid(), b = testUuid();
    BlindfoldSession.requireValidDiscontinuityPayload({ orphanedSegmentId: a, newSegmentId: b });
    assert.throws(
      () => BlindfoldSession.requireValidDiscontinuityPayload({ orphanedSegmentId: a }),
      TypeError
    );
    assert.throws(
      () => BlindfoldSession.requireValidDiscontinuityPayload({ orphanedSegmentId: 'nope', newSegmentId: b }),
      TypeError
    );
    assert.throws(
      () => BlindfoldSession.requireValidDiscontinuityPayload(
        { orphanedSegmentId: a, newSegmentId: b, extra: 1 }),
      TypeError
    );
  });

  it('page_discontinuity refs: exactly {orphanedStartEventId}, uuid-v4', () => {
    const e = testUuid();
    BlindfoldSession.requireValidDiscontinuityRefs({ orphanedStartEventId: e });
    assert.throws(() => BlindfoldSession.requireValidDiscontinuityRefs({}), TypeError);
    assert.throws(
      () => BlindfoldSession.requireValidDiscontinuityRefs({ orphanedStartEventId: 'x' }),
      TypeError
    );
    assert.throws(
      () => BlindfoldSession.requireValidDiscontinuityRefs({ orphanedStartEventId: e, z: e }),
      TypeError
    );
  });
});

// ------------------------------------------------------------------
// AC3/AC4: content-side emission.
// ------------------------------------------------------------------
describe('AC3/AC4 — emitPageStart / emitPageEndClean', () => {
  it('emitPageStart: valid envelope via sender.emit, gameId null, payload {}', () => {
    const s = BlindfoldSession.createSender();
    const sessionId = sid();
    const env = BlindfoldSession.emitPageStart(s, sessionId);
    assert.strictEqual(env.eventType, 'page_start');
    assert.strictEqual(env.sessionId, sessionId);
    assert.strictEqual(env.gameId, null);
    assert.deepStrictEqual(env.payload, {});
    assert.strictEqual(env.appendSeq, null);
    // Eager: the sender's own lazy anchor went first (sourceSeq 0);
    // the page_start lands at sourceSeq 1 on the anchor's segment.
    assert.strictEqual(env.sourceSeq, 1);
    assert.strictEqual(env.clockSegmentId, s.anchor.segmentId);
    assert.strictEqual(s.pendingCount(), 2, 'anchor + page_start queued');
  });

  it('emitPageStart: TypeError on bad sender / bad sessionId', () => {
    const s = BlindfoldSession.createSender();
    assert.throws(() => BlindfoldSession.emitPageStart(null, sid()), TypeError);
    assert.throws(() => BlindfoldSession.emitPageStart({}, sid()), TypeError);
    assert.throws(() => BlindfoldSession.emitPageStart({ emit: 42 }, sid()), TypeError);
    assert.throws(() => BlindfoldSession.emitPageStart(s, 'not-a-uuid'), TypeError);
    assert.throws(() => BlindfoldSession.emitPageStart(s, null), TypeError);
  });

  it('emitPageEndClean: payload exactly {reason: pagehide}', () => {
    const s = BlindfoldSession.createSender();
    const sessionId = sid();
    const env = BlindfoldSession.emitPageEndClean(s, sessionId);
    assert.strictEqual(env.eventType, 'page_end_clean');
    assert.strictEqual(env.gameId, null);
    assert.deepStrictEqual(env.payload, { reason: 'pagehide' });
  });

  it('emitPageEndClean: same validation as emitPageStart', () => {
    const s = BlindfoldSession.createSender();
    assert.throws(() => BlindfoldSession.emitPageEndClean(null, sid()), TypeError);
    assert.throws(() => BlindfoldSession.emitPageEndClean(s, 'bad'), TypeError);
  });

  it('returned envelope passes the 1.3 full-envelope validator', () => {
    const s = BlindfoldSession.createSender();
    const env = BlindfoldSession.emitPageStart(s, sid());
    BlindfoldSession.requireValidEvent(env);
  });
});

// ------------------------------------------------------------------
// AC5: installPageEndHook.
// ------------------------------------------------------------------
describe('AC5 — installPageEndHook', () => {
  let savedWindow;
  let savedActive;

  beforeEach(() => {
    savedWindow = globalThis.window;
    savedActive = BlindfoldSession.activeSessionId;
    delete globalThis.window;
    BlindfoldSession.activeSessionId = null;
  });

  afterEach(() => {
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
    BlindfoldSession.activeSessionId = savedActive;
  });

  function fakeWindow() {
    const listeners = {};
    return {
      listeners,
      addEventListener: (type, fn) => {
        listeners[type] = listeners[type] || [];
        listeners[type].push(fn);
      }
    };
  }

  function fakeSender() {
    return {
      emitted: [],
      flushCalls: 0,
      emit(input) { this.emitted.push(input); return { fake: true, input }; },
      flush() { this.flushCalls++; return Promise.resolve(); }
    };
  }

  it('no-op without window (SW/Node-safe); never throws', () => {
    const s = fakeSender();
    assert.doesNotThrow(() => BlindfoldSession.installPageEndHook(s));
    assert.strictEqual(s.emitted.length, 0);
  });

  it('pagehide emits page_end_clean iff activeSessionId is set', () => {
    globalThis.window = fakeWindow();
    const s = fakeSender();
    BlindfoldSession.installPageEndHook(s);
    const sessionId = sid();
    // Not set: inert.
    globalThis.window.listeners.pagehide[0]({ persisted: false });
    assert.strictEqual(s.emitted.length, 0);
    // Set: emits.
    BlindfoldSession.activeSessionId = sessionId;
    globalThis.window.listeners.pagehide[0]({ persisted: false });
    assert.strictEqual(s.emitted.length, 1);
    assert.strictEqual(s.emitted[0].eventType, 'page_end_clean');
    assert.strictEqual(s.emitted[0].sessionId, sessionId);
    assert.deepStrictEqual(s.emitted[0].payload, { reason: 'pagehide' });
  });

  it('skips bfcache pagehide (persisted === true)', () => {
    globalThis.window = fakeWindow();
    const s = fakeSender();
    BlindfoldSession.installPageEndHook(s);
    BlindfoldSession.activeSessionId = sid();
    globalThis.window.listeners.pagehide[0]({ persisted: true });
    assert.strictEqual(s.emitted.length, 0);
  });

  it('never throws (even with a throwing sender); never calls flush()', () => {
    globalThis.window = fakeWindow();
    const s = fakeSender();
    s.emit = () => { throw new Error('boom'); };
    BlindfoldSession.installPageEndHook(s);
    BlindfoldSession.activeSessionId = sid();
    assert.doesNotThrow(() =>
      globalThis.window.listeners.pagehide[0]({ persisted: false }));
    assert.strictEqual(s.flushCalls, 0, 'pagehide must never flush (2.5 stands)');
  });
});

// ------------------------------------------------------------------
// AC6: activeSessionId seam.
// ------------------------------------------------------------------
describe('AC6 — activeSessionId (§5 seam)', () => {
  it('exists and defaults to null (§5-owned)', () => {
    assert.ok('activeSessionId' in BlindfoldSession);
    // No test before this point sets it (AC5 restores it), so this
    // observes the module-load default.
    assert.strictEqual(BlindfoldSession.activeSessionId, null);
  });
});
// ------------------------------------------------------------------
// AC7: afterEventStored.
// ------------------------------------------------------------------
describe('AC7 — afterEventStored (writer hook consumer)', () => {
  it('undefined for non-page_start events', () => {
    const ev = { eventType: 'move_confirmed', sessionId: sid() };
    assert.strictEqual(
      BlindfoldSession.afterEventStored(ev, { ok: true, eventId: 'x' }),
      undefined
    );
  });

  it('undefined for non-ok acks (hook filters on ok)', () => {
    const ev = { eventType: 'page_start', sessionId: sid() };
    assert.strictEqual(
      BlindfoldSession.afterEventStored(ev, { ok: false, eventId: 'x' }),
      undefined
    );
    assert.strictEqual(BlindfoldSession.afterEventStored(ev, null), undefined);
  });

  it('returns a promise for a committed page_start; never sync-throws', async () => {
    installFakeIDB();
    try {
      const ev = {
        eventType: 'page_start', sessionId: sid(),
        eventId: testUuid(), clockSegmentId: testUuid()
      };
      let result;
      assert.doesNotThrow(() => {
        result = BlindfoldSession.afterEventStored(ev, { ok: true, eventId: ev.eventId });
      });
      assert.ok(result && typeof result.then === 'function', 'must return a promise');
      await result; // empty session: no orphans, resolves
    } finally {
      uninstallIDB();
    }
  });

  it('never sync-throws on garbage input', () => {
    assert.doesNotThrow(() => BlindfoldSession.afterEventStored(null, { ok: true }));
    assert.doesNotThrow(() => BlindfoldSession.afterEventStored('x', { ok: true }));
    assert.doesNotThrow(() => BlindfoldSession.afterEventStored(undefined, undefined));
    assert.strictEqual(BlindfoldSession.afterEventStored(null, { ok: true }), undefined);
  });
});

// ------------------------------------------------------------------
// AC8: clean scenario — no discontinuity, no SW anchor.
// ------------------------------------------------------------------
describe('AC8 — clean start→end→start: no discontinuity', () => {
  it('start(A) → end(A) → start(B) marks nothing and creates no SW anchor', async () => {
    installFakeIDB();
    try {
      const sessionId = sid();
      const A = await storeSegment(sessionId, 1000, { withEnd: true });
      const B = await storeSegment(sessionId, 2000);
      await BlindfoldSession.notePageStartStored(B.startEv);

      const discs = await eventsOfType(sessionId, 'page_discontinuity');
      assert.strictEqual(discs.length, 0, 'clean scenario must not mark');
      const anchors = await eventsOfType(sessionId, 'clock_anchor');
      // Exactly the two content-script anchors; no SW anchor (lazy).
      assert.strictEqual(anchors.length, 2);
      assert.ok(anchors.every((a) => a.sourceContext === 'content_script'));
    } finally {
      uninstallIDB();
    }
  });
});

// ------------------------------------------------------------------
// AC9: orphan scenario — one discontinuity + one SW anchor, via writeEvent.
// ------------------------------------------------------------------
describe('AC9 — orphan start(A), no end → start(B): one discontinuity', () => {
  it('exactly one page_discontinuity with correct refs/payload, one SW clock_anchor; zero raw IDB writes', async () => {
    const fake = installFakeIDB();
    // Spy: lifecycle.js must never call DB.put/DB.get directly — all
    // writes go through BlindfoldSession.writeEvent (sole-writer invariant).
    const dbPuts = [];
    const origPut = BlindfoldSession.DB.put;
    const origGet = BlindfoldSession.DB.get;
    BlindfoldSession.DB.put = function (...args) { dbPuts.push(args); return origPut.apply(this, args); };
    const dbGets = [];
    BlindfoldSession.DB.get = function (...args) { dbGets.push(args); return origGet.apply(this, args); };
    try {
      const sessionId = sid();
      const A = await storeSegment(sessionId, 1000); // no end → orphan
      const B = await storeSegment(sessionId, 2000);
      await BlindfoldSession.notePageStartStored(B.startEv);

      const discs = await eventsOfType(sessionId, 'page_discontinuity');
      assert.strictEqual(discs.length, 1, 'exactly one discontinuity');
      const d = discs[0];
      assert.strictEqual(d.sourceContext, 'service_worker');
      assert.strictEqual(d.gameId, null);
      assert.deepStrictEqual(d.refs, { orphanedStartEventId: A.startEv.eventId });
      assert.deepStrictEqual(d.payload, {
        orphanedSegmentId: A.segmentId,
        newSegmentId: B.segmentId
      });
      BlindfoldSession.requireValidDiscontinuityPayload(d.payload);
      BlindfoldSession.requireValidDiscontinuityRefs(d.refs);
      BlindfoldSession.requireValidEvent(d);

      const anchors = await eventsOfType(sessionId, 'clock_anchor');
      const swAnchors = anchors.filter((a) => a.sourceContext === 'service_worker');
      assert.strictEqual(swAnchors.length, 1, 'exactly one SW anchor (lazy)');
      assert.strictEqual(swAnchors[0].sourceSeq, 0);
      assert.strictEqual(d.sourceSeq, 1, 'discontinuity follows the anchor');
      assert.strictEqual(d.clockSegmentId, swAnchors[0].clockSegmentId);

      // Append order is gapless across all writers.
      const all = await allSessionEvents(sessionId);
      const seqs = all.map((e) => e.appendSeq).sort((a, b) => a - b);
      for (let i = 0; i < seqs.length; i++) {
        assert.strictEqual(seqs[i], i, 'appendSeq gapless 0..' + (seqs.length - 1));
      }

      assert.strictEqual(dbPuts.length, 0, 'lifecycle.js must not call DB.put');
      assert.strictEqual(dbGets.length, 0, 'lifecycle.js must not call DB.get');
    } finally {
      BlindfoldSession.DB.put = origPut;
      BlindfoldSession.DB.get = origGet;
      uninstallIDB();
    }
  });
});

// ------------------------------------------------------------------
// AC10: no double-marking.
// ------------------------------------------------------------------
describe('AC10 — no double-marking across successive starts', () => {
  it('A marked at B; start(C) marks B only — two discontinuities total', async () => {
    installFakeIDB();
    try {
      const sessionId = sid();
      const A = await storeSegment(sessionId, 1000);
      const B = await storeSegment(sessionId, 2000);
      await BlindfoldSession.notePageStartStored(B.startEv);
      let discs = await eventsOfType(sessionId, 'page_discontinuity');
      assert.strictEqual(discs.length, 1);
      assert.strictEqual(discs[0].refs.orphanedStartEventId, A.startEv.eventId);

      const C = await storeSegment(sessionId, 3000);
      await BlindfoldSession.notePageStartStored(C.startEv);
      discs = await eventsOfType(sessionId, 'page_discontinuity');
      assert.strictEqual(discs.length, 2, 'A must not be re-marked; B marked');
      const orphanIds = discs.map((d) => d.refs.orphanedStartEventId).sort();
      assert.deepStrictEqual(orphanIds, [A.startEv.eventId, B.startEv.eventId].sort());
      // Second discontinuity continues the SW segment's sourceSeq.
      const seqs = discs.map((d) => d.sourceSeq).sort((a, b) => a - b);
      assert.deepStrictEqual(seqs, [1, 2]);
    } finally {
      uninstallIDB();
    }
  });
});

// ------------------------------------------------------------------
// AC11: out-of-order arrival — delayed older start must not flag newer.
// ------------------------------------------------------------------
describe('AC11 — out-of-order delayed start does not flag the newer segment', () => {
  it('B stored first, then A (older anchor): A\'s detection flags nothing', async () => {
    installFakeIDB();
    try {
      const sessionId = sid();
      // B is the NEWER segment (anchor 2000), stored first.
      const B = await storeSegment(sessionId, 2000);
      // A's start arrives late with an OLDER anchor (1000).
      const A = await storeSegment(sessionId, 1000);
      await BlindfoldSession.notePageStartStored(A.startEv);

      const discs = await eventsOfType(sessionId, 'page_discontinuity');
      assert.strictEqual(discs.length, 0,
        'delayed older start must not flag the newer live segment');
      const anchors = await eventsOfType(sessionId, 'clock_anchor');
      assert.ok(anchors.every((a) => a.sourceContext === 'content_script'),
        'no SW anchor when nothing is marked');
    } finally {
      uninstallIDB();
    }
  });

  it('missing orphan anchor falls back to flagging (conservative)', async () => {
    installFakeIDB();
    try {
      const sessionId = sid();
      const BS = BlindfoldSession;
      // A start with NO anchor event on record (pathological).
      const segmentId = testUuid();
      const startA = BS.createEvent({
        eventType: 'page_start', sessionId: sessionId, gameId: null,
        sourceContext: 'content_script', sourceSeq: 0,
        clockSegmentId: segmentId, monotonicMs: 20, payload: {}
      });
      await BS.writeEvent(startA);
      const B = await storeSegment(sessionId, 2000);
      await BS.notePageStartStored(B.startEv);
      const discs = await eventsOfType(sessionId, 'page_discontinuity');
      assert.strictEqual(discs.length, 1,
        'anchorless orphan is flagged conservatively');
      assert.strictEqual(discs[0].payload.orphanedSegmentId, segmentId);
    } finally {
      uninstallIDB();
    }
  });
});

// ------------------------------------------------------------------
// AC12: multi-orphan.
// ------------------------------------------------------------------
describe('AC12 — multiple orphans marked at the next start', () => {
  it('A, B orphaned ⇒ C\'s start marks both (sourceSeq 1, 2)', async () => {
    installFakeIDB();
    try {
      const sessionId = sid();
      const A = await storeSegment(sessionId, 1000);
      const B = await storeSegment(sessionId, 2000);
      const C = await storeSegment(sessionId, 3000);
      await BlindfoldSession.notePageStartStored(C.startEv);

      const discs = await eventsOfType(sessionId, 'page_discontinuity');
      assert.strictEqual(discs.length, 2);
      const orphanIds = discs.map((d) => d.refs.orphanedStartEventId).sort();
      assert.deepStrictEqual(orphanIds, [A.startEv.eventId, B.startEv.eventId].sort());
      const seqs = discs.map((d) => d.sourceSeq).sort((a, b) => a - b);
      assert.deepStrictEqual(seqs, [1, 2]);
      for (const d of discs) {
        assert.strictEqual(d.payload.newSegmentId, C.segmentId);
      }
    } finally {
      uninstallIDB();
    }
  });
});

// ------------------------------------------------------------------
// AC13: failure honesty.
// ------------------------------------------------------------------
describe('AC13 — failure honesty', () => {
  it('IDB failure ⇒ notePageStartStored rejects (never sync-throws); retry heals', async () => {
    const fake = installFakeIDB();
    try {
      const sessionId = sid();
      const A = await storeSegment(sessionId, 1000);
      const B = await storeSegment(sessionId, 2000);

      fake.brokenStores.add('events');
      let p;
      assert.doesNotThrow(() => {
        p = BlindfoldSession.notePageStartStored(B.startEv);
      }, 'must never sync-throw');
      await assert.rejects(p, 'IDB failure must reject the detection promise');

      // Orphans persist: a later start (after the failure clears) marks.
      fake.brokenStores.delete('events');
      const C = await storeSegment(sessionId, 3000);
      await BlindfoldSession.notePageStartStored(C.startEv);
      const discs = await eventsOfType(sessionId, 'page_discontinuity');
      assert.strictEqual(discs.length, 2, 'both orphans marked after healing');
    } finally {
      uninstallIDB();
    }
  });

  it('writer ack path unaffected by a failing hook consumer', async () => {
    installFakeIDB();
    try {
      // afterEventStored returns the detection promise; the writer
      // fire-and-forgets it. A rejection must not propagate to the ack.
      const ev = {
        eventType: 'page_start', sessionId: 'not-a-real-session',
        eventId: testUuid(), clockSegmentId: testUuid()
      };
      const p = BlindfoldSession.afterEventStored(ev, { ok: true, eventId: ev.eventId });
      assert.ok(p && typeof p.then === 'function');
      await p; // unknown session: resolves (no orphans), ack path untouched
    } finally {
      uninstallIDB();
    }
  });
});

// ------------------------------------------------------------------
// AC14: SW anchor discipline.
// ------------------------------------------------------------------
describe('AC14 — SW anchor discipline', () => {
  it('concurrent same-session starts share one anchor and never double-mark', async () => {
    installFakeIDB();
    try {
      const sessionId = sid();
      const A = await storeSegment(sessionId, 1000);
      const B = await storeSegment(sessionId, 2000);
      const C = await storeSegment(sessionId, 3000);
      // Fire both detections concurrently: per-session serialization
      // must prevent double-marking and duplicate anchors.
      await Promise.all([
        BlindfoldSession.notePageStartStored(B.startEv),
        BlindfoldSession.notePageStartStored(C.startEv)
      ]);
      const discs = await eventsOfType(sessionId, 'page_discontinuity');
      assert.strictEqual(discs.length, 2, 'A once, B once — never double-marked');
      const anchors = (await eventsOfType(sessionId, 'clock_anchor'))
        .filter((a) => a.sourceContext === 'service_worker');
      assert.strictEqual(anchors.length, 1, 'one SW anchor per (instance, session)');
    } finally {
      uninstallIDB();
    }
  });

  it('anchor write failure rejects; next start retries (self-healing)', async () => {
    const fake = installFakeIDB();
    try {
      const sessionId = sid();
      const A = await storeSegment(sessionId, 1000);
      const B = await storeSegment(sessionId, 2000);
      // Fail the anchor write: the first writeEvent inside detection is
      // the SW clock_anchor (failPutOnStore fires once).
      fake.failPutOnStore = 'events';
      await assert.rejects(
        BlindfoldSession.notePageStartStored(B.startEv),
        'anchor write failure must reject'
      );
      let discs = await eventsOfType(sessionId, 'page_discontinuity');
      assert.strictEqual(discs.length, 0, 'nothing marked when the anchor failed');

      // Next start retries and heals.
      const C = await storeSegment(sessionId, 3000);
      await BlindfoldSession.notePageStartStored(C.startEv);
      discs = await eventsOfType(sessionId, 'page_discontinuity');
      assert.strictEqual(discs.length, 2, 'A and B marked after healing');
      const swAnchors = (await eventsOfType(sessionId, 'clock_anchor'))
        .filter((a) => a.sourceContext === 'service_worker');
      assert.strictEqual(swAnchors.length, 1);
    } finally {
      uninstallIDB();
    }
  });
});
// ------------------------------------------------------------------
// AC15: diff discipline.
// ------------------------------------------------------------------
describe('AC15 — diff discipline', () => {
  it('manifest js list is exactly the contracted order (lifecycle.js, status_indicator.js after sender.js)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    // 3.1 inserts game_records.js before chess_utils.js — the tracker
    // needs the 1.4 payload factories in the content-script world.
    assert.deepEqual(manifest.content_scripts[0].js, [
      'event_envelope.js', 'sender.js', 'lifecycle.js',
      // Honest cumulative evolution: 5.1 adds session_identity.js (UUID-v4
      // session/game minting for the Start control) and session_controls.js
      // (the in-page Start/Stop + per-stream lights) to the content_scripts
      // list per its contract; load order keeps lifecycle.js first and
      // content.js (which installs the control) last-but-one.
      'session_identity.js', 'status_indicator.js', 'session_controls.js',
      // Honest cumulative evolution: 5.4 adds detected_conditions.js
      // (detectGameConditions + CONDITION_PROBES + installConditionsPanel
      // + attachConditionsPanel; the 5.4 conditions panel installs before
      // the fields) to the content_scripts list per its contract, right
      // after session_controls.js.
      'detected_conditions.js',
      // Honest cumulative evolution: 5.2 adds session_fields.js (the
      // baseline/training/evaluation selection + training approach and
      // verbal scaffolding fields) to the content_scripts list per its
      // contract, right after session_controls.js (the Start sequence
      // consumes the fields handle).
      'session_fields.js',
      // Honest cumulative evolution: 5.3 adds selection_memory.js (the
      // chrome.storage.local-backed remembered-defaults module) to the
      // content_scripts list per its contract, right after
      // session_fields.js.
      'selection_memory.js',
      // Honest cumulative evolution: 4.11 appends sync_flash.js
      // (the visible sync-marker content script) per its contract;
      // content.js itself stays byte-identical apart from 5.1's install.
      'sounds.js', 'chess.min.js', 'game_records.js', 'chess_utils.js', 'content.js',
      'sync_flash.js'
    ]);
  });

  it('manifest is otherwise meaning-identical to HEAD (js list + 4.1/4.3 permissions only)', () => {
    // Honest cumulative evolution: 4.1 legitimately adds
    // "permissions": ["offscreen"] per its contract (pinned in
    // tests/recording_host.test.js AC2); 4.3 legitimately extends it with
    // "tabCapture" and adds host_permissions per its contract. Honest
    // cumulative evolution: 5.3 legitimately appends "storage" per its
    // contract (the selection_memory.js chrome.storage.local adapter).
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const headManifest = JSON.parse(
      execSync('git show HEAD:manifest.json', { cwd: ROOT }).toString()
    );
    headManifest.content_scripts[0].js = manifest.content_scripts[0].js;
    headManifest.permissions = manifest.permissions;
    headManifest.host_permissions = manifest.host_permissions;
    assert.deepEqual(manifest, headManifest);
  });

  it('sw.js: importScripts carries lifecycle.js + capture_broker.js + recording_host.js + install calls intact (4.3)', () => {
    // Post-commit durable form of the 2.7 diff pin; 4.1 legitimately
    // extends the importScripts line (recording-context supervisor) and
    // adds the two recordingHost startup lines per its contract; 4.3
    // legitimately adds the SW-side capture broker (capture_broker.js)
    // per its contract. 6.6 legitimately adds exporter.js (export bundle
    // builders + orchestration) per its contract. The working tree now
    // equals HEAD, so assert the contracted content instead of the diff.
    const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    const calls = (sw.match(/importScripts\s*\(/g) || []).length;
    assert.strictEqual(calls, 1, 'exactly one importScripts call');
    assert.ok(sw.includes(
      "importScripts('db.js', 'event_envelope.js', 'writer.js', " +
      "'session_identity.js', 'session_conditions.js', 'session_store.js', 'lifecycle.js', 'capture_broker.js', 'recording_host.js', 'exporter.js');"
    ));
    assert.ok(!sw.includes('2.7: page/context start'),
      '2.7 must be removed from the absent list');
    assert.ok(sw.includes(
      'BlindfoldSession.writerListener = BlindfoldSession.installWriterListener();'
    ));
    assert.ok(sw.includes(
      'BlindfoldSession.recordingHost = BlindfoldSession.createRecordingHost(globalThis.chrome || {});'
    ));
    assert.ok(sw.includes('BlindfoldSession.recordingHost.start();'));
  });

  it('writer.js: the 2.7 §3.2 hook is present and type-agnostic (2.7 committed)', () => {
    // Post-commit durable form of the 2.7 diff pin.
    const src = fs.readFileSync(path.join(ROOT, 'writer.js'), 'utf8');
    assert.ok(src.includes('function fireAfterEventStored'),
      'hook helper must be present');
    assert.ok(src.includes('fireAfterEventStored(message, ack)'),
      'success-path call site');
    assert.ok(src.includes('fireAfterEventStored(message, failAck)'),
      'failure-path call site');
    assert.ok(src.includes('afterEventStored'),
      'hook consumer reference');
    // The hook never inspects event types.
    const hookBlock = src.slice(src.indexOf('function fireAfterEventStored'));
    assert.ok(!hookBlock.slice(0, 800).includes('eventType'),
      'writer hook must stay type-agnostic');
  });

  it('content.js: the 2.7 §3.3 install line is present (2.7 committed)', () => {
    // Post-commit durable form of the 2.7 diff pin. (2.8 adds its own
    // install wiring; pinned in tests/status_indicator.test.js.)
    const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
    const occurrences = src.split('BlindfoldSession.installPageEndHook(BlindfoldSession.sender);').length - 1;
    assert.strictEqual(occurrences, 1, 'content.js: exactly one 2.7 install line');
  });

  it('db.js, sender.js, event_envelope.js, session_identity.js, session_conditions.js, session_store.js byte-identical to HEAD', () => {
    // Honest cumulative evolution (4.5): db.js leaves this list — 4.5
    // legitimately bumps DB_VERSION 1 → 2 and adds the
    // recording_manifest store (see its pin in
    // tests/format_support.test.js).
    for (const f of ['sender.js', 'event_envelope.js',
                     'session_identity.js', 'session_conditions.js',
                     'session_store.js']) {
      const head = execSync(`git show HEAD:${f}`, { cwd: ROOT, stdio: 'pipe' }).toString();
      const current = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.strictEqual(current, head, `${f} changed but 2.7 must not touch it`);
    }
  });

  it('lifecycle.js follows the module convention (header spot-check)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lifecycle.js'), 'utf8');
    assert.ok(src.includes('var BlindfoldSession = BlindfoldSession || {};'));
    assert.ok(src.includes("(function () {\n  'use strict';"));
    assert.ok(src.includes('if (typeof module !== \'undefined\' && module.exports)'));
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
      // 2.7's own files:
      'lifecycle.js',
      'tests/lifecycle.test.js',
      'sw.js',
      'writer.js',
      'content.js',
      'manifest.json',
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
      // Honest cumulative evolution (2.2–2.6 precedent): earlier tasks'
      // suites pin files 2.7 legitimately touches, so their pins evolve
      // in this task's commit.
      'tests/manifest_sw.test.js',
      'tests/sender.test.js',
      'tests/writer.test.js',
      'tests/session_store.test.js',
      'tests/game_records.test.js',
      'tests/db.test.js',
      'tests/event_envelope.test.js',
      'tests/session_identity.test.js',
      '.autodev/DECISIONS.md',
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
      // Honest cumulative evolution: 5.2 (baseline/training/evaluation
      // selection + training approach and verbal scaffolding fields)
      // legitimately adds session_fields.js (pure buildInitialConditions +
      // UNDETECTED_CONDITION_FIELDS placeholders + installSessionFields
      // with the 5.3/5.4 seams), amends session_controls.js's Start
      // sequence (metadata-first minting, session-save, category echo,
      // category-required abort), adds the SW-side session-save handler
      // to recording_host.js, accepts/stores/echoes sessionCategory in
      // recorder.js, wires the fields install into content.js (+
      // extensionVersion pass-through), adds session_fields.js to the
      // manifest content_scripts list, adds additive classes to
      // overlay.css, records the ## 5.2 decisions, and adds its test +
      // evidence; its files join the allowlists.
      'session_fields.js',
      'tests/session_fields.test.js',
      'session_controls.js',
      'recorder.js',
      'recording_host.js',
      'content.js',
      'manifest.json',
      'overlay.css',
      '.autodev/evidence/5.2.contract.md',
      '.autodev/evidence/5.2.build.md',
      // Honest cumulative evolution: 5.2's review/behavior evidence
      // lands after the pins were evolved (2.x/3.x/4.x/5.1 precedent).
      '.autodev/evidence/5.2.review.md',
      '.autodev/evidence/5.2.behavior.md',
      // Honest cumulative evolution: 5.3 (remember previous selections
      // without silently changing a game's recorded conditions)
      // legitimately adds selection_memory.js (createSelectionMemory +
      // validateRememberedSelection, chrome.storage.local-backed
      // remembered defaults, no record-write path), adds the optional
      // onSessionStarted hook to session_controls.js (fired once at the
      // phase → 'active' point, guarded in try/catch), wires the memory
      // construction + restore + onSessionStarted pass-through into
      // content.js, adds the "storage" permission and selection_memory.js
      // to manifest.json, records the ## 5.3 decisions, and adds its test
      // + evidence; its files join the allowlists. (session_controls.js,
      // content.js, manifest.json and .autodev/DECISIONS.md are already
      // allowlisted from 5.1/5.2.)
      'selection_memory.js',
      'tests/selection_memory.test.js',
      // 5.3 also evolves the exact-permissions pins in these suites
      // (they carry no git-status allowlist of their own, so they join
      // here).
      'tests/db.test.js',
      'tests/manifest_sw.test.js',
      // 5.3 also evolves the working-tree diff pins in these suites.
      'tests/clock_link.test.js',
      'tests/timecode.test.js',
      '.autodev/evidence/5.3.contract.md',
      '.autodev/evidence/5.3.build.md',
      // Honest cumulative evolution: 5.3's review/behavior evidence
      // lands after the pins are evolved (2.x/3.x/4.x/5.1/5.2 precedent).
      '.autodev/evidence/5.3.review.md',
      '.autodev/evidence/5.3.behavior.md',
      // Honest cumulative evolution: 5.4 (show detected game conditions
      // and allow manual completion of unavailable fields before
      // recording) legitimately adds detected_conditions.js
      // (detectGameConditions + CONDITION_PROBES + installConditionsPanel
      // + attachConditionsPanel; playerColor detected via the verified
      // wc-chess-board/flipped probe, the other four fields manual-only),
      // wires the panel install + getDetectedConditions plug-in +
      // attachConditionsPanel composite into content.js, adds
      // detected_conditions.js to manifest.json, adds additive panel
      // classes to overlay.css, records the ## 5.4 decisions, and adds
      // its test + evidence; its files join the allowlists.
      // (content.js, manifest.json, overlay.css and .autodev/DECISIONS.md
      // are already allowlisted from 5.1/5.2/5.3.)
      'detected_conditions.js',
      'tests/detected_conditions.test.js',
      '.autodev/evidence/5.4.contract.md',
      '.autodev/evidence/5.4.build.md',
      '.autodev/evidence/5.4.review.md',
      '.autodev/evidence/5.4.behavior.md',
      // 5.4 also evolves the cumulative pins in these suites (each
      // carries its own git-status allowlist, so they join here).
      'tests/attempt_tracker.test.js',
      'tests/audio_policy.test.js',
      'tests/capture_selection.test.js',
      'tests/chunk_writer.test.js',
      'tests/device_selection.test.js',
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
      'tests/track_monitor.test.js',
      'tests/visibility.test.js',
      'tests/writer.test.js',
      // 5.4 also evolves the working-tree diff pins in these suites.
      'tests/clock_link.test.js',
      'tests/timecode.test.js',
      // Honest cumulative evolution: 5.5 (prevent a duplicate Start
      // from creating overlapping recording sessions) legitimately adds
      // the atomic duplicate-Start guard to recorder.js's
      // handleSetSession (sessionId-equality discriminator, synchronous
      // check-and-set, nothing overwritten on refusal), adds the
      // content-side pre-check + mint reorder + localAbortStart +
      // refusal-detail mapping to session_controls.js, records the
      // ## 5.5 decisions, and adds its test + evidence; its files join
      // the allowlists. No new channel messages, events, stores, or
      // permissions.
      'recorder.js',
      'session_controls.js',
      'tests/duplicate_start.test.js',
      '.autodev/DECISIONS.md',
      '.autodev/evidence/5.5.contract.md',
      '.autodev/evidence/5.5.build.md',
      // Honest cumulative evolution: 5.5's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.4 precedent).
      '.autodev/evidence/5.5.review.md',
      '.autodev/evidence/5.5.behavior.md',
      // 5.5 also evolves the cumulative pins in these suites (each
      // carries its own git-status allowlist, so they join here).
      'tests/attempt_tracker.test.js',
      'tests/audio_policy.test.js',
      'tests/capture_selection.test.js',
      'tests/chunk_writer.test.js',
      'tests/device_selection.test.js',
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
      'tests/track_monitor.test.js',
      'tests/visibility.test.js',
      'tests/writer.test.js',
      // 5.5 also evolves the working-tree diff pins in these suites.
      'tests/clock_link.test.js',
      'tests/timecode.test.js',
      // Honest cumulative evolution: 5.6 (show readiness only after
      // required media streams have started and an initial storage
      // write has succeeded) legitimately adds the pure
      // computeReadiness() policy function + readiness badge
      // presentation + poll-loop wiring to session_controls.js, adds
      // its unit/integration tests, and records its evidence; its
      // files join the allowlists. No new channel messages, events,
      // stores, or permissions.
      '.autodev/evidence/5.6.contract.md',
      '.autodev/evidence/5.6.build.md',
      // Honest cumulative evolution: 5.6's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.5 precedent).
      '.autodev/evidence/5.6.review.md',
      '.autodev/evidence/5.6.behavior.md',
      // Honest cumulative evolution: 5.7 (keep recording through game
      // end until the user clicks Stop) is primarily a pinning task —
      // it adds no product-code changes, only the 5.7 no-auto-stop
      // tests to tests/session_controls.test.js, and records its
      // evidence; its files join the allowlists. No new channel
      // messages, events, stores, or permissions.
      '.autodev/evidence/5.7.contract.md',
      '.autodev/evidence/5.7.build.md',
      // Honest cumulative evolution: 5.7's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.6 precedent).
      '.autodev/evidence/5.7.review.md',
      '.autodev/evidence/5.7.behavior.md',
      // Honest cumulative evolution: 5.8 (optional timestamped
      // note/moment marker) legitimately adds the moment_marker event
      // type + marker UI to session_controls.js, its test + evidence;
      // its files join the allowlists. No new channel messages,
      // stores, or permissions.
      '.autodev/evidence/5.8.contract.md',
      '.autodev/evidence/5.8.build.md',
      // Honest cumulative evolution: 5.8's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.7 precedent).
      '.autodev/evidence/5.8.review.md',
      '.autodev/evidence/5.8.behavior.md',
      // Honest cumulative evolution: 5.9 (mid-session game transition)
      // legitimately implements the onGameReset placeholder in content.js
      // (mint new gameId + install fresh tracker) and adds handleGameReset
      // + activeMetadata/activeConditions to session_controls.js (the
      // specified deliverable; 5.7 named the placeholder as 5.9's input),
      // adds its unit/integration tests, and records its evidence; its
      // files join the allowlists. No new channel messages, event types,
      // stores, or permissions.
      '.autodev/evidence/5.9.contract.md',
      '.autodev/evidence/5.9.build.md',
      // Honest cumulative evolution: 5.9's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.8 precedent).
      '.autodev/evidence/5.9.review.md',
      '.autodev/evidence/5.9.behavior.md',
      // Honest cumulative evolution: 5.10 (Stop completion verdict)
      // legitimately adds the sender.flush() await + transitional
      // "Finalizing…" UI + pure computeCompletion() + enriched
      // lastStopResponse retention to session_controls.js's Stop
      // sequence, adds its unit/integration tests, and records its
      // evidence; its files join the allowlists. No new channel
      // messages, event types, stores, or permissions.
      '.autodev/evidence/5.10.contract.md',
      '.autodev/evidence/5.10.build.md',
      // Honest cumulative evolution: 5.10's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.9 precedent).
      '.autodev/evidence/5.10.review.md',
      '.autodev/evidence/5.10.behavior.md',
      // Honest cumulative evolution: 6.1 (generate metadata.json from
      // stored context and observed completion status) legitimately adds
      // the new SW-side exporter.js module (pure buildMetadataJson
      // builder; 6.6 owns the orchestration/permission/message), its
      // test file, and its evidence; its files join the allowlists.
      // No new channel messages, event types, stores, or permissions
      // in 6.1. The section audit/architecture evidence files
      // (section-5.audit.md, created by the section auditor after 5.10's
      // pins; section-6.architecture.md, the §6 planner's) are
      // allowlisted here to repair the stale pins.
      'exporter.js',
      'tests/exporter.test.js',
      '.autodev/evidence/6.1.contract.md',
      '.autodev/evidence/6.1.build.md',
      '.autodev/evidence/section-5.audit.md',
      '.autodev/evidence/section-6.architecture.md',
      // Honest cumulative evolution: 6.1's review/behavior evidence lands
      // after the pins are evolved (2.x-5.x precedent).
      '.autodev/evidence/6.1.review.md',
      '.autodev/evidence/6.1.behavior.md',
      // Honest cumulative evolution: 6.2 (export events.jsonl) and
      // 6.3 (export media-sync.json) extend the 6.1 exporter.js module
      // with pure builder functions; their evidence files join the
      // allowlists. No new channel messages, event types, stores, or
      // permissions in 6.2/6.3.
      '.autodev/evidence/6.2.contract.md',
      '.autodev/evidence/6.2.build.md',
      '.autodev/evidence/6.2+6.3.review.md',
      '.autodev/evidence/6.2+6.3.behavior.md',
      '.autodev/evidence/6.3.contract.md',
      '.autodev/evidence/6.4.contract.md',
      '.autodev/evidence/6.4.build.md',
      '.autodev/evidence/6.5.contract.md',
      '.autodev/evidence/6.5.build.md',
      // 6.6 (ZIP packaging) adds the ZIP writer + exportSession to
      // exporter.js, the export-request listener to sw.js, the
      // downloads permission to manifest.json, and the Download
      // affordance to session_controls.js.
      '.autodev/evidence/6.6.contract.md',
      '.autodev/evidence/6.6.build.md',
      // Honest cumulative evolution: 6.7 (repeatable export) is
      // verification-only (tests + docs); 6.8 (export
      // documentation) adds EXPORT.md.
      '.autodev/evidence/6.7.contract.md',
      '.autodev/evidence/6.7.build.md',
      '.autodev/evidence/6.8.contract.md',
      '.autodev/evidence/6.8.build.md',
      'EXPORT.md',
      'tests/acceptance_7_2.test.js',
      'tests/acceptance_7_4_7_7.test.js',
      'tests/acceptance_7_10.test.js',
      'tests/acceptance_7_11.test.js',
      // 7.14 inlined EXPORT.md into README.md and deleted the file.
      'README.md',
      // 7.1-7.3 (acceptance tests) evidence files.
      '.autodev/evidence/7.1.contract.md',
      '.autodev/evidence/7.1.build.md',
      '.autodev/evidence/7.1.review.md',
      '.autodev/evidence/7.1.behavior.md',
      '.autodev/evidence/7.2.contract.md',
      '.autodev/evidence/7.2.build.md',
      '.autodev/evidence/7.3.contract.md',
      '.autodev/evidence/7.3.build.md',
      '.autodev/evidence/7.3.review.md',
      '.autodev/evidence/7.3.behavior.md',
      '.autodev/evidence/7.1-7.11.review.md',
      '.autodev/evidence/7.1-7.11+7.14.behavior.md',
      '.autodev/evidence/7.10.contract.md',
      '.autodev/evidence/7.10.build.md',
      '.autodev/evidence/7.11.contract.md',
      '.autodev/evidence/7.11.build.md',
      '.autodev/evidence/7.4.contract.md',
      '.autodev/evidence/7.4.build.md',
      '.autodev/evidence/7.5.contract.md',
      '.autodev/evidence/7.5.build.md',
      '.autodev/evidence/7.6.contract.md',
      '.autodev/evidence/7.6.build.md',
      '.autodev/evidence/7.7.contract.md',
      '.autodev/evidence/7.7.build.md',
      '.autodev/evidence/7.14.contract.md',
      '.autodev/evidence/7.14.build.md',
      '.autodev/evidence/7.14.review.md',
      // 6.4+6.5 review/behavior use combined naming (reviewer/verifier
      // wrote single files for the pair, 6.2+6.3 precedent).
      '.autodev/evidence/6.4+6.5.review.md',
      '.autodev/evidence/6.4+6.5.behavior.md',
      '.autodev/evidence/6.3.build.md',
      
      
        // Termination-reason feature (owner decision).
    'chess_utils.js',
    'session_controls.js',
    'exporter.js',
    '.autodev/evidence/termination-reason.contract.md',
    '.autodev/evidence/termination-reason.build.md',
]);
    for (const f of changed) {
      assert.ok(allowed.has(f), `unexpected modified file: ${f}`);
    }
    // NOTE (2.9): the 2.8 "status_indicator.js must be new" assertion was
    // transient — it could only pass before the 2.8 feature commit, same as
    // the 2.7 "lifecycle.js must be new" assertion noted above. The durable
    // invariant is the allowlist (no unexpected files); 2.9 adds no product
    // files of its own.
  });

  it('PLAN.md untouched', () => {
    execSync('git diff --exit-code -- PLAN.md', { cwd: ROOT, stdio: 'pipe' });
  });
});
