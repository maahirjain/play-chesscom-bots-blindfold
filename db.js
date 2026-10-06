// db.js
//
// Task 2.2 (PLAN.md §2.2): extension-owned IndexedDB database for metadata,
// events, and media chunks. The database lives in the extension service
// worker's origin, which is origin-scoped, so experiment records never touch
// the page's own storage.
//
// Stores (each traces to a quoted requirement; none is speculative):
//   - events            (keyPath eventId)          — 11-key envelopes; PLAN §2.4 dedups by eventId
//   - session_metadata  (keyPath sessionId)        — 1.1 record verbatim; §2.6 restore, §6.1
//   - conditions        (keyPath sessionId)        — 1.2 record verbatim; §6.1
//   - sequence_state    (keyPath sessionId)        — {sessionId, nextAppendSeq} durable slot (§2.4 assigns, §2.6 restores)
//   - media_chunks      (compound keyPath [segmentId, chunkIndex]) — §4.8 incremental chunks; §6.4 ordered assembly
//
// Intentionally absent (owned by later PLAN.md tasks):
//   - 2.3: content-script event sender / message intake
//   - 2.4: transactional event writer, dedup by event ID, write acks, appendSeq assignment
//   - 2.5: retry of unacknowledged events
//   - 2.6: restore session metadata and sequence state after worker restart (2.2 only provides the stores it will read)
//   - 2.7: page/context start and clean-end events, unclean-discontinuity marking
//   - 2.8: write-failure / storage-capacity surfacing in the status indicator
//   - 2.9 / §6: retention and export semantics
// db.js stores plain records and performs NO envelope/record validation —
// validation at write time is the §2.4 writer's job (1.3 §2.8). This keeps
// 2.2 load-order independent: no imports of the Section-1 contract modules.
//
// Rules honoured by this module:
//   - globalThis.indexedDB is read lazily, per call, never cached at load:
//     the module must load in Node (where indexedDB is undefined) without
//     throwing, and V1 tests simulate unavailability by deleting the global.
//   - Never delete user data in a schema upgrade (§2.9); onupgradeneeded is
//     idempotent (guarded creation of every store/index).
//   - No silent in-memory fallback: if indexedDB is unavailable, calls fail
//     loudly with a plain Error.
//
// Error conventions (AGENTS.md): unavailable indexedDB -> plain Error;
// unknown store/index name -> RangeError; wrong argument types -> TypeError;
// IndexedDB request/transaction failures (incl. quota) -> plain Error
// carrying the underlying DOMException name/message.

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  var DB_NAME = 'blindfold-experiment';
  var DB_VERSION = 1;

  function deepFreeze(value) {
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
      var keys = Object.keys(value);
      for (var i = 0; i < keys.length; i++) {
        deepFreeze(value[keys[i]]);
      }
      Object.freeze(value);
    }
    return value;
  }

  // Schema-as-data: the single source of truth. V1 tests assert this
  // statically (no IndexedDB); openDatabase() consumes it (no drift).
  var SCHEMA = deepFreeze({
    dbName: DB_NAME,
    version: DB_VERSION,
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
  });

  // ------------------------------------------------------------------
  // Private helpers.
  // ------------------------------------------------------------------

  var cachedDb = null;

  // Lazy platform read: never cached, so unavailability is observed per
  // call and the module loads anywhere.
  function platformIndexedDB() {
    if (typeof globalThis !== 'undefined' && globalThis.indexedDB &&
        typeof globalThis.indexedDB.open === 'function') {
      return globalThis.indexedDB;
    }
    return null;
  }

  function requireAvailableIDB() {
    var idb = platformIndexedDB();
    if (!idb) {
      throw new Error('db: indexedDB is unavailable in this context');
    }
    return idb;
  }

  function findStore(name) {
    for (var i = 0; i < SCHEMA.stores.length; i++) {
      if (SCHEMA.stores[i].name === name) {
        return SCHEMA.stores[i];
      }
    }
    return null;
  }

  function requireStoreName(storeName) {
    if (typeof storeName !== 'string') {
      throw new TypeError('db: storeName must be a string');
    }
    if (!findStore(storeName)) {
      throw new RangeError('db: unknown store: ' + storeName);
    }
  }

  function requireRecord(record) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new TypeError('db: record must be a plain object');
    }
  }

  function requireIndex(storeName, indexName) {
    var store = findStore(storeName);
    if (typeof indexName !== 'string') {
      throw new TypeError('db: index name must be a string');
    }
    for (var i = 0; i < store.indexes.length; i++) {
      if (store.indexes[i].name === indexName) {
        return;
      }
    }
    throw new RangeError('db: unknown index "' + indexName + '" on store "' + storeName + '"');
  }

  function wrapIDBError(op, err) {
    var name = err && err.name ? err.name : 'UnknownError';
    var message = err && err.message ? err.message : String(err);
    var wrapped = new Error('db: ' + op + ' failed (' + name + '): ' + message);
    wrapped.cause = err;
    return wrapped;
  }

  function requestToPromise(request, op) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(wrapIDBError(op, request.error));
      };
    });
  }

  function applySchema(db, upgradeTx) {
    for (var i = 0; i < SCHEMA.stores.length; i++) {
      var spec = SCHEMA.stores[i];
      var store;
      if (db.objectStoreNames.contains(spec.name)) {
        store = upgradeTx.objectStore(spec.name);
      } else {
        store = db.createObjectStore(spec.name, { keyPath: spec.keyPath });
      }
      for (var j = 0; j < spec.indexes.length; j++) {
        var idx = spec.indexes[j];
        if (!store.indexNames.contains(idx.name)) {
          store.createIndex(idx.name, idx.keyPath, { unique: idx.unique });
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Public API: BlindfoldSession.DB.
  // ------------------------------------------------------------------

  function openDatabase() {
    return new Promise(function (resolve, reject) {
      var idb;
      try {
        idb = requireAvailableIDB();
      } catch (e) {
        reject(e);
        return;
      }
      if (cachedDb) {
        resolve(cachedDb);
        return;
      }
      var request;
      try {
        request = idb.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(wrapIDBError('openDatabase', e));
        return;
      }
      request.onupgradeneeded = function () {
        try {
          applySchema(request.result, request.transaction);
        } catch (e) {
          // An upgrade failure aborts the open; surface it as the
          // request error below.
          try {
            request.transaction.abort();
          } catch (abortErr) {
            // Ignore: the open is already failing.
          }
        }
      };
      request.onsuccess = function () {
        cachedDb = request.result;
        resolve(cachedDb);
      };
      request.onerror = function () {
        reject(wrapIDBError('openDatabase', request.error));
      };
      request.onblocked = function () {
        reject(new Error('db: openDatabase blocked by an open connection'));
      };
    });
  }

  function closeDatabase() {
    if (cachedDb) {
      try {
        cachedDb.close();
      } finally {
        cachedDb = null;
      }
    }
  }

  function withStore(storeName, mode, fn) {
    // Argument validation runs BEFORE any platform access, so V1 tests can
    // exercise the error contract with indexedDB deleted.
    requireStoreName(storeName);
    var idb = requireAvailableIDB();
    return openDatabase().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx;
        try {
          tx = db.transaction(storeName, mode);
        } catch (e) {
          reject(wrapIDBError('transaction(' + storeName + ')', e));
          return;
        }
        var settled = false;
        tx.onabort = function () {
          if (!settled) {
            settled = true;
            reject(wrapIDBError('transaction(' + storeName + ')', tx.error));
          }
        };
        tx.onerror = function () {
          if (!settled) {
            settled = true;
            reject(wrapIDBError('transaction(' + storeName + ')', tx.error));
          }
        };
        var store;
        try {
          store = tx.objectStore(storeName);
        } catch (e) {
          reject(wrapIDBError('objectStore(' + storeName + ')', e));
          return;
        }
        var result;
        try {
          result = fn(store);
        } catch (e) {
          reject(e);
          return;
        }
        Promise.resolve(result).then(function (value) {
          settled = true;
          resolve(value);
        }, function (e) {
          settled = true;
          reject(e instanceof Error ? e : wrapIDBError('request(' + storeName + ')', e));
        });
      });
    });
  }

  async function put(storeName, record) {
    requireStoreName(storeName);
    requireRecord(record);
    requireAvailableIDB();
    await withStore(storeName, 'readwrite', function (store) {
      return requestToPromise(store.put(record), 'put(' + storeName + ')').then(function () {
        return undefined;
      });
    });
  }

  async function get(storeName, key) {
    requireStoreName(storeName);
    requireAvailableIDB();
    return withStore(storeName, 'readonly', function (store) {
      return requestToPromise(store.get(key), 'get(' + storeName + ')');
    });
  }

  function keyRangeFor(lower, upper) {
    var idbKeyRange = globalThis.IDBKeyRange;
    if (typeof lower !== 'undefined' && typeof upper !== 'undefined') {
      return idbKeyRange.bound(lower, upper);
    }
    if (typeof lower !== 'undefined') {
      return idbKeyRange.lowerBound(lower);
    }
    if (typeof upper !== 'undefined') {
      return idbKeyRange.upperBound(upper);
    }
    return null;
  }

  async function getAll(storeName, options) {
    requireStoreName(storeName);
    var opts = options === undefined || options === null ? {} : options;
    if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
      throw new TypeError('db: options must be an object');
    }
    var useIndex = typeof opts.index !== 'undefined';
    if (useIndex) {
      requireIndex(storeName, opts.index);
    }
    requireAvailableIDB();
    return withStore(storeName, 'readonly', function (store) {
      var source = useIndex ? store.index(opts.index) : store;
      var range = keyRangeFor(opts.lower, opts.upper);
      var results = [];
      return new Promise(function (resolve, reject) {
        var request = range ? source.openCursor(range) : source.openCursor();
        request.onsuccess = function () {
          var cursor = request.result;
          if (cursor) {
            results.push(cursor.value);
            cursor.continue();
          } else {
            resolve(results);
          }
        };
        request.onerror = function () {
          reject(wrapIDBError('getAll(' + storeName + ')', request.error));
        };
      });
    });
  }

  var DB = {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    SCHEMA: SCHEMA,
    openDatabase: openDatabase,
    closeDatabase: closeDatabase,
    put: put,
    get: get,
    getAll: getAll
  };

  BlindfoldSession.DB = DB;
})();

// Node test shim. importScripts() consumers use the BlindfoldSession global
// directly; only environments that provide CommonJS get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
