// chunk_writer.js
//
// Task 4.8 (PLAN.md §4.8): save recorder chunks incrementally in
// extension-owned storage.
//
// 4.6 starts each stream's MediaRecorder with NO timeslice and
// ondataavailable UNSET — until 4.8, the only data path is the implicit
// final flush on stop(), so a crash or document death mid-game loses
// everything. 4.8 wires chunk extraction: a per-stream requestData()
// poll loop (CHUNK_POLL_MS, not a timeslice) feeds ondataavailable, and
// each non-empty Blob is appended to the extension-owned IndexedDB
// `media_chunks` store (compound key [segmentId, chunkIndex], created
// for exactly this purpose in task 2.2) keyed to 4.6's segmentIds.
//
// Chunking starts automatically for every successfully started stream
// (recorder.js kicks it off after recorder-start-streams — Start implies
// record; no new channel message). 4.8 appends and indexes; it does NOT
// concatenate, finalize, or interpret chunk timing (4.13 / 4.12 own
// those). Polling never fails the stream: chunk-writing is best-effort
// durability around a recording that continues regardless; a broken
// chunker is reported (getChunkState), never thrown into the pipeline.
//
// Restart honesty: already-written chunks persist (extension-owned IDB);
// in-flight data the encoder holds but 4.8 has not yet requested dies
// with the offscreen document — there is no API to recover it, and 4.8
// does not fabricate recovery or resurrect recorders. Poll timers die
// with the document. 4.9 logs the discontinuity (via the optional
// onTerminalState seam — exact-once per stream — and recorder.js's
// manifest pre-check); 4.13 re-segments on restart; §5 decides whether
// to restart streams at all.
//
// 4.13 seam: stopForStream()/stopAll() stop the poll loops. The final
// dataavailable from recorder.stop() is stored as a chunk like any
// other, so the ondataavailable handler stays attached after the loop
// stops — 4.13 must await that final flush before declaring a segment
// finalized.
//
// Recording platform APIs live only in the offscreen document (4.1's
// rule): this module references no MediaRecorder constructor — the
// recorder instances arrive via startForStream() — and the DB is read
// lazily from the shared namespace (format_support.js precedent), so the
// module is DOM-free and unit-testable in Node.
//
// Dependency-free classic script → guarded BlindfoldSession global → IIFE
// 'use strict' → Node module.exports shim (repo house convention).
//
// Error conventions (AGENTS.md): TypeError = wrong type/shape;
// RangeError = bad domain value; plain Error = unavailable platform
// capability (never a weak fallback).

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Constants.
  // ------------------------------------------------------------------

  // Poll cadence: 5 s balances incremental durability against IDB write
  // volume. A named, V1-pinned constant — tuning it is §7 territory.
  var CHUNK_POLL_MS = 5000;
  // ±10% jitter per loop, so the three streams' polls do not lockstep
  // into the same IDB contention window.
  var CHUNK_JITTER_RATIO = 0.10;
  // How long a tick waits for its dataavailable before counting a miss.
  var CHUNK_REQUEST_TIMEOUT_MS = 2000;
  // Consecutive misses before the chunker is declared stalled (fail-loud).
  var CHUNK_MAX_MISSES = 3;

  var STREAM_KINDS = ['microphone', 'screen', 'webcam'];

  // Chunker statuses. 'active' = polling; the three 'chunk-*' states are
  // terminal failure states (fail-closed: the loop is stopped, the
  // recorder is untouched); 'stopped' = the loop was stopped deliberately
  // (4.13's Stop); the durable trace is the chunks themselves.
  var STATUS_ACTIVE = 'active';
  var STATUS_STALLED = 'chunk-stalled';
  var STATUS_QUOTA_EXCEEDED = 'chunk-quota-exceeded';
  var STATUS_WRITE_ERROR = 'chunk-write-error';
  var STATUS_STOPPED = 'stopped';

  function freezeConstants() {
    Object.freeze(STREAM_KINDS);
  }
  freezeConstants();

  // ------------------------------------------------------------------
  // Private helpers.
  // ------------------------------------------------------------------

  function shared() {
    return (typeof BlindfoldSession !== 'undefined') ? BlindfoldSession : null;
  }

  function errName(err) {
    return (err && typeof err.name === 'string' && err.name !== '') ?
      err.name : 'Error';
  }

  function errMessage(err) {
    return (err && typeof err.message === 'string') ? err.message : String(err);
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function requireStreamKind(streamKind) {
    if (typeof streamKind !== 'string') {
      throw new TypeError('chunk_writer: streamKind must be a string');
    }
    if (STREAM_KINDS.indexOf(streamKind) === -1) {
      throw new RangeError(
        'chunk_writer: unknown streamKind: ' + streamKind);
    }
    return streamKind;
  }

  function requireRecorder(recorder) {
    if (recorder === null || typeof recorder !== 'object' || Array.isArray(recorder)) {
      throw new TypeError('chunk_writer: recorder must be an object');
    }
    if (typeof recorder.requestData !== 'function') {
      throw new TypeError('chunk_writer: recorder.requestData must be a function');
    }
    return recorder;
  }

  // ------------------------------------------------------------------
  // Factory.
  // ------------------------------------------------------------------

  function createChunkWriter(opts) {
    var o = opts || {};

    // Fully injected platform surface (V1 drives fakes; the offscreen
    // document relies on the real globals).
    var injectedDb = ('db' in o) ? o.db : null;
    var nowUtcIso = (typeof o.nowUtcIso === 'function') ?
      o.nowUtcIso : function () { return new Date().toISOString(); };
    var performanceNow = (typeof o.performanceNow === 'function') ?
      o.performanceNow : defaultPerformanceNow;
    var setIntervalFn = (typeof o.setInterval === 'function') ?
      o.setInterval : defaultSetInterval;
    var clearIntervalFn = (typeof o.clearInterval === 'function') ?
      o.clearInterval : defaultClearInterval;
    var setTimeoutFn = (typeof o.setTimeout === 'function') ?
      o.setTimeout : defaultSetTimeout;
    var clearTimeoutFn = (typeof o.clearTimeout === 'function') ?
      o.clearTimeout : defaultClearTimeout;
    var randomFn = (typeof o.random === 'function') ?
      o.random : Math.random;
    // 4.9 seam: optional onTerminalState({streamKind, terminalState}),
    // invoked exactly once per stream when a poll loop reaches a terminal
    // state (chunk-stalled, chunk-quota-exceeded, chunk-write-error).
    // Absent → 4.8's behavior is unchanged. Never throws into the
    // chunker: monitoring must not break chunking, just as chunking must
    // not break recording.
    var onTerminalState = (('onTerminalState' in o) &&
      o.onTerminalState !== undefined && o.onTerminalState !== null) ?
      o.onTerminalState : null;
    if (onTerminalState !== null && typeof onTerminalState !== 'function') {
      throw new TypeError('chunk_writer: onTerminalState must be a function');
    }

    function defaultPerformanceNow() {
      var g = (typeof globalThis !== 'undefined') ? globalThis : null;
      var perf = g && g.performance;
      if (!perf || typeof perf.now !== 'function') {
        throw new Error('chunk_writer: performance.now() is unavailable');
      }
      return perf.now();
    }
    function defaultSetInterval(fn, ms) { return setInterval(fn, ms); }
    function defaultClearInterval(id) { clearInterval(id); }
    function defaultSetTimeout(fn, ms) { return setTimeout(fn, ms); }
    function defaultClearTimeout(id) { clearTimeout(id); }

    function readDb() {
      if (injectedDb) {
        return injectedDb;
      }
      var BS = shared();
      if (!BS || !BS.DB || typeof BS.DB.put !== 'function') {
        throw new Error('chunk_writer: DB is unavailable');
      }
      return BS.DB;
    }

    // Per-stream poll state: streamKind → state object. States persist
    // after the loop stops (terminal failure states are the durable
    // record for 4.9/4.14); the chunks themselves are the durable trace.
    var polls = {};

    function freshState(kind, segmentId, recorder) {
      return {
        streamKind: kind,
        segmentId: segmentId,
        recorder: recorder,
        timerId: null,
        awaiting: null, // { timeoutId } while a tick's dataavailable is pending
        nextChunkIndex: 0, // reserved synchronously at chunk acceptance
                           // (see storeChunk); 0-byte drops never reach it
        status: STATUS_ACTIVE,
        lastChunkIndex: -1,
        lastWriteAtUtc: null,
        consecutiveMisses: 0,
        emptyPolls: 0,
        lastErrorName: null,
        lastErrorMessage: null,
        // 4.9: whether the onTerminalState seam has fired for this poll
        // generation (exact-once per stream; a re-started kind gets a
        // fresh state and may notify again).
        terminalNotified: false
      };
    }

    // 4.9: report a terminal chunker state through the optional seam,
    // exactly once per poll generation. Never throws into the chunker.
    function notifyTerminalState(kind) {
      var p = polls[kind];
      if (!p || p.terminalNotified) {
        return;
      }
      p.terminalNotified = true;
      if (onTerminalState !== null) {
        try {
          onTerminalState({ streamKind: kind, terminalState: p.status });
        } catch (e) { /* monitoring must never break the chunker */ }
      }
    }

    function stopLoop(kind) {
      var p = polls[kind];
      if (!p) {
        return;
      }
      if (p.timerId !== null) {
        try { clearIntervalFn(p.timerId); } catch (e) { /* ignore */ }
        p.timerId = null;
      }
      if (p.awaiting !== null) {
        try { clearTimeoutFn(p.awaiting.timeoutId); } catch (e) { /* ignore */ }
        p.awaiting = null;
      }
    }

    function noteMiss(kind) {
      var p = polls[kind];
      if (!p) {
        return;
      }
      p.consecutiveMisses += 1;
      if (p.consecutiveMisses >= CHUNK_MAX_MISSES) {
        // Fail-loud: a stalled chunker is a recording anomaly. 4.9
        // decides the durable log shape; the recorder keeps running.
        p.status = STATUS_STALLED;
        stopLoop(kind);
        notifyTerminalState(kind);
      }
    }

    function failWrite(kind, err) {
      var p = polls[kind];
      if (!p) {
        return;
      }
      var name = errName(err);
      if (name === 'QuotaExceededError') {
        // Fail-closed: retrying would spin against a full quota. The
        // recording itself keeps running — the failure is visible, not
        // silent (4.14 reports it per stream).
        p.status = STATUS_QUOTA_EXCEEDED;
      } else {
        p.status = STATUS_WRITE_ERROR;
      }
      p.lastErrorName = name;
      p.lastErrorMessage = errMessage(err);
      stopLoop(kind);
      notifyTerminalState(kind);
    }

    function storeChunk(kind, blob, timecodeMs) {
      var p = polls[kind];
      if (!p) {
        return;
      }
      // Reserve the index SYNCHRONOUSLY at acceptance: two chunks accepted
      // while a write is still in flight must never share a key (an IDB
      // put with a duplicate compound key would silently overwrite —
      // data loss). A failed write therefore leaves a gap in the
      // sequence, never a duplicate key. 4.13 reads chunks in key order,
      // so gaps are honest; 0-byte drops still never consume an index
      // (they are rejected before this point).
      var chunkIndex = p.nextChunkIndex;
      p.nextChunkIndex = chunkIndex + 1;
      var record = {
        segmentId: p.segmentId,
        chunkIndex: chunkIndex,
        receivedAtUtc: nowUtcIso(),
        receivedAtMonotonicMs: performanceNow(),
        // Stored RAW for 4.12 to interpret — never analyzed here.
        timecodeMs: (typeof timecodeMs === 'number') ? timecodeMs : null,
        data: blob
      };
      var db;
      try {
        db = readDb();
      } catch (e) {
        failWrite(kind, e);
        return;
      }
      var writeResult;
      try {
        writeResult = db.put('media_chunks', record);
      } catch (e) {
        failWrite(kind, e);
        return;
      }
      Promise.resolve(writeResult).then(function () {
        p.lastChunkIndex = chunkIndex;
        p.lastWriteAtUtc = record.receivedAtUtc;
        p.consecutiveMisses = 0;
      }, function (err) {
        // The chunk was not stored: its reserved index stays a gap.
        failWrite(kind, err);
      });
    }

    function onDataAvailable(kind, event) {
      var p = polls[kind];
      if (!p) {
        return;
      }
      if (p.awaiting !== null) {
        try { clearTimeoutFn(p.awaiting.timeoutId); } catch (e) { /* ignore */ }
        p.awaiting = null;
      }
      var blob = event && event.data;
      var timecodeMs = event && event.timecode;
      if (!blob || typeof blob.size !== 'number' || blob.size === 0) {
        // 0-byte Blobs are dropped: not stored, index not consumed,
        // counted in state. Not a miss — the recorder answered.
        p.emptyPolls += 1;
        return;
      }
      storeChunk(kind, blob, timecodeMs);
    }

    function attachHandler(kind, recorder) {
      var handler = function (event) { onDataAvailable(kind, event); };
      // addEventListener keeps any existing listeners (4.13's seam:
      // the handler stays attached after the loop stops so the final
      // stop() flush is stored as a chunk like any other).
      if (typeof recorder.addEventListener === 'function') {
        recorder.addEventListener('dataavailable', handler);
      } else {
        recorder.ondataavailable = handler;
      }
    }

    function tick(kind) {
      var p = polls[kind];
      if (!p || p.timerId === null) {
        return;
      }
      var recorder = p.recorder;
      if (!recorder || recorder.state !== 'recording') {
        // Not an error: 4.13's Stop owns the final flush, and a recorder
        // that died on its own is 4.9's discontinuity to log. The loop
        // stops (observed, not requested); the handler stays attached so
        // the final flush is still stored as a chunk. The vocabulary
        // stays closed: 'stopped' covers both paths.
        stopLoop(kind);
        if (p.status === STATUS_ACTIVE) {
          p.status = STATUS_STOPPED;
        }
        return;
      }
      if (p.awaiting !== null) {
        // The previous tick's dataavailable is still inside its 2 s
        // window — skip this tick rather than double-requesting.
        return;
      }
      try {
        recorder.requestData();
      } catch (e) {
        // The recorder died between the state check and the call:
        // a missed tick, never a stream failure.
        noteMiss(kind);
        return;
      }
      p.awaiting = {
        timeoutId: setTimeoutFn(function () {
          var q = polls[kind];
          if (q && q.awaiting !== null) {
            q.awaiting = null;
            noteMiss(kind);
          }
        }, CHUNK_REQUEST_TIMEOUT_MS)
      };
    }

    // Start chunking for a successfully started stream. Idempotent per
    // streamKind: an existing loop for the kind is stopped first (the
    // 4.6 already-started guard makes this defensive, not expected).
    // Never throws for a live stream — validation errors are the only
    // throws (caller bugs), and the recorder.js kickoff wraps this in
    // try/catch so chunking can never fail the channel response.
    function startForStream(args) {
      var a = args || {};
      var kind = requireStreamKind(a.streamKind);
      if (typeof a.segmentId !== 'string' || a.segmentId === '') {
        throw new TypeError('chunk_writer: segmentId must be a non-empty string');
      }
      var recorder = requireRecorder(a.recorder);
      stopLoop(kind);
      var p = freshState(kind, a.segmentId, recorder);
      polls[kind] = p;
      attachHandler(kind, recorder);
      var jitter = 1 + (randomFn() * 2 - 1) * CHUNK_JITTER_RATIO;
      p.timerId = setIntervalFn(function () { tick(kind); }, CHUNK_POLL_MS * jitter);
      return { ok: true, streamKind: kind, segmentId: a.segmentId };
    }

    // Stop one stream's poll loop. The ondataavailable handler stays
    // attached so the final stop() flush is still stored as a chunk.
    // Idempotent. Terminal failure states are preserved (they are the
    // honest record for 4.9/4.14); 'active' becomes 'stopped'.
    function stopForStream(streamKind) {
      var kind = requireStreamKind(streamKind);
      var p = polls[kind];
      if (!p) {
        return { ok: true, streamKind: kind, wasActive: false };
      }
      var wasActive = p.timerId !== null;
      stopLoop(kind);
      if (p.status === STATUS_ACTIVE) {
        p.status = STATUS_STOPPED;
      }
      return { ok: true, streamKind: kind, wasActive: wasActive };
    }

    // Stop every stream's poll loop. Idempotent.
    function stopAll() {
      var kinds = Object.keys(polls);
      for (var i = 0; i < kinds.length; i++) {
        stopForStream(kinds[i]);
      }
      return { ok: true, stopped: kinds };
    }

    // The 4.9/4.13/4.14 seam: per-stream chunker state (in-memory; the
    // durable trace is the chunks themselves). null when this streamKind
    // was never chunked — unknown is null, never a fabricated state.
    function getChunkState(streamKind) {
      var kind = requireStreamKind(streamKind);
      var p = polls[kind];
      if (!p) {
        return null;
      }
      return {
        status: p.status,
        lastChunkIndex: p.lastChunkIndex,
        lastWriteAtUtc: p.lastWriteAtUtc,
        consecutiveMisses: p.consecutiveMisses,
        emptyPolls: p.emptyPolls,
        lastErrorName: p.lastErrorName,
        lastErrorMessage: p.lastErrorMessage
      };
    }

    function hasActivePoll(streamKind) {
      var kind = requireStreamKind(streamKind);
      var p = polls[kind];
      return !!(p && p.timerId !== null);
    }

    return {
      startForStream: startForStream,
      stopForStream: stopForStream,
      stopAll: stopAll,
      getChunkState: getChunkState,
      hasActivePoll: hasActivePoll
    };
  }

  BlindfoldSession.createChunkWriter = createChunkWriter;
  BlindfoldSession.CHUNK_WRITER_POLL_MS = CHUNK_POLL_MS;
  BlindfoldSession.CHUNK_WRITER_REQUEST_TIMEOUT_MS = CHUNK_REQUEST_TIMEOUT_MS;
  BlindfoldSession.CHUNK_WRITER_MAX_MISSES = CHUNK_MAX_MISSES;
  BlindfoldSession.CHUNK_WRITER_STREAM_KINDS = STREAM_KINDS;
})();

// Node test shim. The offscreen document consumes the BlindfoldSession
// global directly; only environments that provide CommonJS get
// module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
