// writer.js — service-worker event writer (task 2.4: PLAN.md §2.4).
//
// SW side of the 2.3 handoff. Receives {kind:'event',event} messages from
// content-script senders, validates the envelope, deduplicates by eventId,
// assigns appendSeq transactionally with the write, and acknowledges ONLY
// after the transaction commits — so at-least-once delivery collapses to
// exactly-once durable state.
//
// Design (see .autodev/evidence/2.4.contract.md):
//   - Intake: chrome.runtime.onMessage adapter. kind:'event' -> writeEvent()
//     -> exactly one sendResponse, listener returns true (async channel).
//     Other kinds are ignored (return false, no response). A kind:'event'
//     message whose event is missing/not an object gets a synchronous
//     {ok:false,eventId:null,error:'malformed-message'}.
//   - Validation boundary: envelope-level only (isValidEvent +
//     writer-owned appendSeq===null rule). NO per-event-type payload
//     validation: emitters validate at construction; new types must not
//     require writer changes; the writer's job is durability, not
//     refereeing ("preserve original observations").
//   - Dedup: read-before-write inside the write transaction. Same content
//     (deep-equal excluding appendSeq) -> idempotent {ok:true}, counter
//     untouched (the 2.5 retry-after-lost-ack case). Different content ->
//     {ok:false,error:'event-id-content-mismatch'}, stored record never
//     overwritten.
//   - appendSeq: ONE readwrite transaction over ['events','sequence_state']
//     via RAW IndexedDB (db.js's withStore resolves on request success, not
//     on commit — insufficient for the ack path). Per-session counter
//     {sessionId,nextAppendSeq}, 0-based. Counter increment and event put
//     commit or abort together; ack {ok:true} is produced ONLY from
//     tx.oncomplete.
//   - Transaction-body discipline: between the first request and oncomplete
//     the code awaits NO non-IDB promise (no timers, fetches, message
//     passing) — awaiting a macrotask while the tx is open lets the browser
//     auto-commit it early. Only IDB request callbacks run inside the body.
//   - Concurrency: safe without a JS lock — single-threaded JS plus
//     IndexedDB's serialization of overlapping readwrite transactions —
//     IFF the sole-writer invariants hold: (i) the writer is the sole
//     writer of sequence_state (2.6 restores by reading it); (ii) the
//     writer is the sole writer of events; (iii) the body discipline
//     above is honored.
//   - Ack is the error channel: wire-data failures (bad envelope,
//     double-processing, content-mismatch, write failures) -> {ok:false}
//     acks, never throws. Error strings are short stable codes (2.8 will
//     match on them); never stack traces, never sensitive data.
//
// Intentionally absent (owned by later PLAN.md tasks):
//   - 2.5: retry timers/backoff/policy (only the ack protocol both sides
//     already speak)
//   - 2.6: restore after worker restart (the writer only WRITES
//     sequence_state; 2.6 reads it back)
//   - 2.7: lifecycle event types/emission
//   - 2.8: status-indicator UI (only error strings in acks)
//   - 2.9 / §6: retention and export
//   - writes to session_metadata, conditions, or media_chunks (owned by
//     2.6/§5 session wiring and §4/§6 respectively)
//
// Platform discipline: no chrome.* and no BlindfoldSession.DB /
// event_envelope.js exports are read at load time. The onMessage adapter
// resolves chrome.runtime.onMessage at install time (bracket notation
// keeps the literal "chrome." out of the source so static guards can
// assert no extension-API use outside installWriterListener).
// BlindfoldSession.DB and isValidEvent are read at CALL time through the
// shared namespace (never cached at load), so this module stays
// load-order independent: in the SW (importScripts) the module binding IS
// the shared global; in Node tests the harness publishes the merged
// namespace on globalThis.
//
// Error conventions (AGENTS.md): writeEvent(nonObject) -> TypeError
// (programmer-facing, synchronous); wire-data domain failures ->
// {ok:false,...} acks, never throws; installWriterListener() with no
// chrome.runtime.onMessage -> plain Error (unavailable platform).

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // Discriminator fixed by the 2.3 handoff contract. sender.js is
  // content-script-only and is never loaded in the SW, so the writer
  // defines its own constant citing that contract (the V2 end-to-end
  // test proves the two sides agree).
  var MESSAGE_KIND = 'event';

  // Resolve the shared BlindfoldSession namespace at call time. Prefers
  // the globalThis-published namespace (Node test harness merges the
  // separately required modules there); falls back to the module-local
  // binding, which IS the shared global in classic-script contexts.
  function shared() {
    if (typeof globalThis !== 'undefined' &&
        globalThis.BlindfoldSession &&
        typeof globalThis.BlindfoldSession.isValidEvent === 'function' &&
        globalThis.BlindfoldSession.DB) {
      return globalThis.BlindfoldSession;
    }
    return BlindfoldSession;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function isEventMessage(m) {
    return isPlainObject(m) && m.kind === MESSAGE_KIND;
  }

  // Extract an echoable eventId from intake: a string, else null (the
  // sender matches acks by eventId; null means "no ID could be extracted").
  function extractEventId(event) {
    if (isPlainObject(event) && typeof event.eventId === 'string') {
      return event.eventId;
    }
    return null;
  }

  function errorName(err) {
    if (err && typeof err.name === 'string' && err.name) {
      return err.name;
    }
    return 'Error';
  }

  // Map a write-path failure to the stable 'write-failed:<name>' code.
  // Unavailable indexedDB has its own code (the sender keeps the event
  // queued either way; 2.8 will match on the string).
  function toWriteFailed(err) {
    var message = (err && typeof err.message === 'string') ? err.message : '';
    if (message.indexOf('indexedDB is unavailable') !== -1) {
      return 'write-failed:unavailable';
    }
    var inner = (err && err.cause) ? err.cause : err;
    return 'write-failed:' + errorName(inner);
  }

  // Deep-equal on all keys except the top-level `skipKey` (used with
  // 'appendSeq': the stored record carries the assigned integer, the
  // intake carries null). Key order is irrelevant. Values are JSON-safe
  // (structured-cloned envelopes), so no NaN/Date/undefined edge cases.
  function deepEqualExcept(a, b, skipKey) {
    if (a === b) {
      return true;
    }
    if (typeof a !== 'object' || typeof b !== 'object' ||
        a === null || b === null) {
      return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
      return false;
    }
    var ka = Object.keys(a).filter(function (k) { return k !== skipKey; });
    var kb = Object.keys(b).filter(function (k) { return k !== skipKey; });
    if (ka.length !== kb.length) {
      return false;
    }
    for (var i = 0; i < ka.length; i++) {
      var k = ka[i];
      if (!Object.prototype.hasOwnProperty.call(b, k)) {
        return false;
      }
      // skipKey applies at the top level only; nested objects compare fully.
      if (!deepEqualExcept(a[k], b[k], null)) {
        return false;
      }
    }
    return true;
  }

  function sameContentExcludingAppendSeq(stored, incoming) {
    return deepEqualExcept(stored, incoming, 'appendSeq');
  }

  // The transactional write. ONE readwrite transaction over
  // ['events','sequence_state']: dedup read -> counter read -> puts ->
  // ack from tx.oncomplete. The body uses IDB request callbacks only;
  // no non-IDB promise is awaited while the transaction is open.
  function runWriteTransaction(db, event, eventId) {
    return new Promise(function (resolve) {
      var tx;
      try {
        tx = db.transaction(['events', 'sequence_state'], 'readwrite');
      } catch (e) {
        resolve({ ok: false, eventId: eventId, error: toWriteFailed(e) });
        return;
      }
      var events;
      var seqState;
      try {
        events = tx.objectStore('events');
        seqState = tx.objectStore('sequence_state');
      } catch (e) {
        // Unknown store (schema drift) -> abort the empty transaction.
        ack = { ok: false, eventId: eventId, error: toWriteFailed(e) };
        try { tx.abort(); } catch (abortErr) { /* already failing */ }
        // Resolve now; if tx.onabort fires later, finish() is a no-op.
        finish(ack);
        return;
      }

      var sessionId = event.sessionId;
      var ack = null;      // set for every non-commit path; null => commit ok
      var settled = false; // exactly one resolve, from exactly one tx event

      function finish(result) {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      }

      tx.oncomplete = function () {
        // Commit is the ONLY path that produces {ok:true}: the ack means
        // durable, not merely request-succeeded.
        finish(ack || { ok: true, eventId: eventId });
      };
      tx.onerror = function () {
        finish(ack || {
          ok: false,
          eventId: eventId,
          error: toWriteFailed(tx.error)
        });
      };
      tx.onabort = function () {
        finish(ack || {
          ok: false,
          eventId: eventId,
          error: toWriteFailed(tx.error)
        });
      };

      function fail(err) {
        if (ack === null) {
          ack = { ok: false, eventId: eventId, error: toWriteFailed(err) };
        }
        try {
          tx.abort();
        } catch (abortErr) {
          // The transaction is already dead; onabort (or nothing) follows.
          // Resolve now so the sender never hangs; a later tx event is a
          // no-op via finish().
          finish(ack);
        }
      }

      // Step 1: dedup read.
      var getReq;
      try {
        getReq = events.get(eventId);
      } catch (e) {
        // Synchronous DataError (e.g. bad key) -> abort, ack the failure.
        fail(e);
        return;
      }
      getReq.onerror = function () { fail(getReq.error); };
      getReq.onsuccess = function () {
        var existing = getReq.result;
        if (existing !== undefined) {
          if (sameContentExcludingAppendSeq(existing, event)) {
            // Idempotent retry-after-lost-ack: data already durable, the
            // counter is untouched, the empty readwrite tx commits.
            ack = { ok: true, eventId: eventId };
          } else {
            // Corruption signal: never overwrite the stored record.
            ack = {
              ok: false,
              eventId: eventId,
              error: 'event-id-content-mismatch'
            };
            try {
              tx.abort();
            } catch (abortErr) {
              finish(ack);
            }
          }
          return;
        }
        // Step 2: new event — read the per-session counter.
        var seqReq;
        try {
          seqReq = seqState.get(sessionId);
        } catch (e) {
          fail(e);
          return;
        }
        seqReq.onerror = function () { fail(seqReq.error); };
        seqReq.onsuccess = function () {
          var rec = seqReq.result;
          var next;
          if (rec === undefined || rec === null) {
            next = 0; // new session: legitimate
          } else if (typeof rec.nextAppendSeq === 'number' &&
              Number.isInteger(rec.nextAppendSeq) &&
              rec.nextAppendSeq >= 0 &&
              rec.sessionId === sessionId) {
            next = rec.nextAppendSeq;
          } else {
            // Corrupt counter: fail the write honestly (→ {ok:false} →
            // 2.5 retry → 2.8 status) instead of silently forking the
            // sequence. Coherent with session_store.js restore-side
            // corruption errors (2.6 review SF-1). The distinctive name
            // survives toWriteFailed as 'write-failed:CorruptSequenceState'
            // so 2.8 can match on it.
            var corruptErr = new Error('writer: corrupt sequence_state for session ' + sessionId);
            corruptErr.name = 'CorruptSequenceState';
            fail(corruptErr);
            return;
          }
          // New record — never mutate the intake object (1.3 §2.8 pure
          // pattern; the intake arrives structured-cloned but is treated
          // as read-only regardless).
          var stored = Object.assign({}, event, { appendSeq: next });
          var putEventReq;
          try {
            putEventReq = events.put(stored);
          } catch (e) {
            fail(e); // sync DataError -> abort (DECISIONS.md #9b)
            return;
          }
          putEventReq.onerror = function () { fail(putEventReq.error); };
          putEventReq.onsuccess = function () {
            var putSeqReq;
            try {
              putSeqReq = seqState.put({
                sessionId: sessionId,
                nextAppendSeq: next + 1
              });
            } catch (e) {
              fail(e);
              return;
            }
            putSeqReq.onerror = function () { fail(putSeqReq.error); };
            // putSeqReq.onsuccess: nothing more to do; the transaction
            // commits when the last request completes -> tx.oncomplete
            // produces {ok:true}.
          };
        };
      };
    });
  }

  function writeEventAsync(event, eventId) {
    var ns = shared();
    // Validation before any platform access: envelope-level only.
    if (!ns.isValidEvent(event)) {
      return Promise.resolve({
        ok: false,
        eventId: eventId,
        error: 'invalid-envelope'
      });
    }
    // Writer-owned rule (1.3 §2.8): non-null appendSeq on intake indicates
    // double-processing; assignment is the writer's exclusive job.
    if (event.appendSeq !== null) {
      return Promise.resolve({
        ok: false,
        eventId: eventId,
        error: 'append-seq-present'
      });
    }
    var DB = ns.DB;
    return DB.openDatabase().then(function (db) {
      return runWriteTransaction(db, event, eventId);
    }, function (err) {
      // Open failure (incl. unavailable indexedDB) -> the sender keeps the
      // event queued; 2.5 will retry.
      return { ok: false, eventId: eventId, error: toWriteFailed(err) };
    });
  }

  // writeEvent(event) -> Promise<ack>. Never rejects for wire data: every
  // domain failure becomes an {ok:false,...} ack. Throws TypeError
  // synchronously only for a non-object argument (programmer-facing).
  function writeEvent(event) {
    if (!isPlainObject(event)) {
      throw new TypeError('writeEvent requires an event object');
    }
    var eventId = extractEventId(event);
    var result;
    try {
      result = writeEventAsync(event, eventId);
    } catch (e) {
      // Defensive: writeEventAsync validates before touching the platform,
      // so a synchronous throw here is unexpected. Map it to an ack so the
      // sender never hangs.
      return Promise.resolve({
        ok: false,
        eventId: eventId,
        error: toWriteFailed(e)
      });
    }
    return result.then(null, function (err) {
      // Defensive: the transaction paths above resolve, never reject. If a
      // rejection ever escapes, ack it rather than leaving the sender
      // hanging on an unsettled sendMessage promise.
      return { ok: false, eventId: eventId, error: toWriteFailed(err) };
    });
  }

  // Installs the chrome.runtime.onMessage adapter. Returns the listener
  // function so tests can remove it to simulate a genuine no-ack state.
  // (Not for production use: a service-worker restart recreates the whole
  // JS context and re-installs the listener from scratch, so there is no
  // restart-time removal — production code must NEVER remove the writer's
  // listener.) Throws a plain Error when the extension message
  // API is unavailable (unavailable platform capability — honest failure,
  // per AGENTS.md).
  function installWriterListener() {
    var g = (typeof globalThis !== 'undefined') ? globalThis : null;
    var chromeNs = g ? g['chrome'] : null;
    var runtime = chromeNs ? chromeNs['runtime'] : null;
    var onMessage = runtime ? runtime['onMessage'] : null;
    if (!onMessage || typeof onMessage['addListener'] !== 'function') {
      throw new Error('writer: extension runtime.onMessage is unavailable');
    }
    var listener = function (message, sender, sendResponse) {
      if (!isEventMessage(message)) {
        return false; // not ours: ignore, no response
      }
      if (!isPlainObject(message.event)) {
        sendResponse({ ok: false, eventId: null, error: 'malformed-message' });
        return false;
      }
      var eventId = extractEventId(message.event);
      var result;
      try {
        result = writeEvent(message.event);
      } catch (e) {
        // writeEvent throws synchronously only for non-object input,
        // excluded above — defensive.
        sendResponse({ ok: false, eventId: eventId, error: 'malformed-message' });
        return false;
      }
      result.then(function (ack) {
        try {
          sendResponse(ack);
        } catch (respondErr) {
          // The message channel closed; the write already committed.
        }
      }, function (err) {
        try {
          sendResponse({
            ok: false,
            eventId: eventId,
            error: toWriteFailed(err)
          });
        } catch (respondErr) {
          // The message channel closed; nothing more to do.
        }
      });
      return true; // async response follows
    };
    onMessage['addListener'](listener);
    return listener;
  }

  BlindfoldSession.MESSAGE_KIND = MESSAGE_KIND;
  BlindfoldSession.writeEvent = writeEvent;
  BlindfoldSession.installWriterListener = installWriterListener;
})();

// Node test shim. importScripts() consumers use the BlindfoldSession global
// directly; only environments that provide CommonJS get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
