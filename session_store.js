// session_store.js
//
// Task 2.6 (PLAN.md §2.6): session-state storage primitives — save and
// restore session metadata, session conditions, and the stored sequence
// counter after a background-worker restart.
//
// SW-side only: the database lives in the extension service worker's
// origin (2.2), invisible to content scripts. Loaded via importScripts()
// in sw.js, after writer.js.
//
// Honest design (see .autodev/evidence/2.6.contract.md §2):
// - Sequence state needs NO in-memory restore. writer.js keeps no
//   in-memory counter: every writeEvent transaction reads sequence_state
//   from IndexedDB and writes back next+1 in the same transaction, so the
//   first post-restart write continues gaplessly by construction.
//   Introducing an in-memory counter plus a restore step would be strictly
//   worse (a new divergence hazard) and would break the 2.4 contract's
//   no-lock concurrency argument, which depends on the counter living
//   only in the database.
// - What 2.6 adds: (a) the storage-layer save/restore pair for the
//   session_metadata and conditions stores (nothing wrote them yet —
//   2.4 explicitly deferred them); (b) a read-only sequence-counter
//   peek for 2.7/§6/2.8 consumers; (c) corruption honesty on the read
//   path (see below).
//
// Binding invariants (from the 2.4 contract, re-verified here):
// - The writer is the SOLE writer of sequence_state and of events.
//   session_store.js NEVER writes sequence_state, events, or
//   media_chunks — getSequenceState is a pure read (a peek must not
//   create the record it peeks at).
//
// Corruption honesty: a present-but-malformed sequence_state record is
// CORRUPTION, surfaced as an error, never silently renumbered. (Contrast
// the writer's write-path fallback, which treats a missing/non-numeric
// counter as 0 — a documented wart in 2.4 review NOTE-2, not a restore
// semantic. Restore must not repeat it: renumbering on read would
// silently fork the append sequence.)
//
// Platform discipline: no chrome.* at load; BlindfoldSession.DB and the
// 1.1/1.2 validators are read at call time, never cached at load, so this
// module loads in Node and is independent of importScripts order.

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Private helpers.
  // ------------------------------------------------------------------

  // Resolve the shared BlindfoldSession namespace at call time. Prefers
  // the globalThis-published namespace (in classic-script contexts —
  // content scripts, importScripts in the SW — this IS the module-local
  // binding; in Node the test harness merges the separately required
  // modules there); falls back to the module-local binding otherwise.
  // Follows the sender.js precedent. Never cached at load: keeps this
  // module independent of importScripts order and loadable in Node.
  function shared() {
    if (typeof globalThis !== 'undefined' && globalThis.BlindfoldSession) {
      return globalThis.BlindfoldSession;
    }
    return BlindfoldSession;
  }

  function requireSessionId(sessionId) {
    // Keys are opaque on the read path: non-empty string only. The 1.1
    // validator enforces uuid-v4 shape at save time via the record
    // itself; the read path must not invent stricter key rules.
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new TypeError('sessionId must be a non-empty string');
    }
  }

  // Corruption errors are plain Errors with stable code prefixes so 2.8
  // can match on them; the underlying validator message is appended for
  // debuggability. Session IDs are uuid-v4 (non-sensitive).
  function corrupt(kind, sessionId, detail) {
    var msg = 'session-store: ' + kind + ' for session ' + sessionId;
    if (detail) {
      msg += ' (' + detail + ')';
    }
    return new Error(msg);
  }

  function isValidSequenceState(record, sessionId) {
    return record !== null &&
      typeof record === 'object' &&
      !Array.isArray(record) &&
      record.sessionId === sessionId &&
      typeof record.nextAppendSeq === 'number' &&
      Number.isInteger(record.nextAppendSeq) &&
      record.nextAppendSeq >= 0;
  }

  // ------------------------------------------------------------------
  // Public API. All functions return Promises; rejections follow the
  // 2.2 error contract (validation TypeError/RangeError propagate;
  // platform/IDB failures reject as plain Errors via BlindfoldSession.DB).
  // ------------------------------------------------------------------

  // Validates with the 1.1 validator BEFORE any IDB access, then stores
  // with replace semantics (same sessionId overwrites — a session's
  // metadata is re-saved when games are appended via addGameToSession).
  async function saveSessionMetadata(record) {
    shared().requireValidMetadata(record);
    await shared().DB.put('session_metadata', record);
  }

  // Validates with the 1.2 validator BEFORE any IDB access, then stores
  // with replace semantics. Merges are the caller's job (1.2
  // applyConditionChange + save); the store does not merge.
  //
  // Signature note (deviation from 2.6.contract.md §3.1, documented in
  // 2.6.build.md): the contract specified saveConditions(record), but
  // the conditions store's keyPath is sessionId and the 1.2 factory
  // record has no sessionId field — a 7-field record cannot be stored.
  // Taking sessionId as an explicit parameter (mirroring
  // restoreSessionState/getSequenceState) keeps the 1.2 domain record
  // pure instead of inventing an 8th field. The stored record is
  // {sessionId, ...sevenFields}; requireValidConditions tolerates the
  // key (it validates the seven fields and ignores extras), so both
  // save-time and restore-time validation hold.
  async function saveConditions(sessionId, record) {
    requireSessionId(sessionId);
    // requireValidConditions returns the normalized 7-field record;
    // the keyPath-mandated sessionId is attached here, never invented
    // inside the 1.2 domain model.
    var normalized = shared().requireValidConditions(record);
    var stored = Object.assign({ sessionId: sessionId }, normalized);
    await shared().DB.put('conditions', stored);
  }

  // Reads the durable triple for a session. Each present record is
  // re-validated: data written corrupt (or by a foreign writer) is an
  // honest corruption error, never silently accepted. Absent stores
  // yield null for that field (unknown = unknown, no throw).
  async function restoreSessionState(sessionId) {
    requireSessionId(sessionId);
    var DB = shared().DB;
    var metadata = await DB.get('session_metadata', sessionId);
    var conditions = await DB.get('conditions', sessionId);
    var sequenceState = await DB.get('sequence_state', sessionId);
    if (metadata !== null && metadata !== undefined) {
      try {
        shared().requireValidMetadata(metadata);
      } catch (e) {
        throw corrupt('invalid stored session_metadata', sessionId, e.message);
      }
    } else {
      metadata = null;
    }
    if (conditions !== null && conditions !== undefined) {
      try {
        shared().requireValidConditions(conditions);
      } catch (e) {
        throw corrupt('invalid stored conditions', sessionId, e.message);
      }
    } else {
      conditions = null;
    }
    if (sequenceState !== null && sequenceState !== undefined) {
      if (!isValidSequenceState(sequenceState, sessionId)) {
        throw corrupt('corrupt sequence_state', sessionId);
      }
    } else {
      sequenceState = null;
    }
    return {
      metadata: metadata,
      conditions: conditions,
      sequenceState: sequenceState
    };
  }

  // Read-only counter peek for 2.7/§6/2.8 consumers. Absent → null.
  // Malformed → corruption error (never silent renumbering). NEVER
  // writes: the writer stays the sole writer of sequence_state.
  async function getSequenceState(sessionId) {
    requireSessionId(sessionId);
    var record = await shared().DB.get('sequence_state', sessionId);
    if (record === null || record === undefined) {
      return null;
    }
    if (!isValidSequenceState(record, sessionId)) {
      throw corrupt('corrupt sequence_state', sessionId);
    }
    return record;
  }

  BlindfoldSession.saveSessionMetadata = saveSessionMetadata;
  BlindfoldSession.saveConditions = saveConditions;
  BlindfoldSession.restoreSessionState = restoreSessionState;
  BlindfoldSession.getSequenceState = getSequenceState;
})();

// Node test shim. importScripts() consumers use the BlindfoldSession
// global directly; only environments that provide CommonJS get
// module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
