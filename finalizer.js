// finalizer.js
//
// Task 4.13 (PLAN.md §4.13): finalize recordings at Stop — close each
// segment's chunk set, keep discontinuous recordings as separate numbered
// segments, and mark the manifest finalized.
//
// 4.6 starts the streams, 4.8 extracts chunks incrementally into
// `media_chunks`, 4.9 flags discontinuities, 4.10 links clock segments,
// 4.11 defines the stop-marker seam, and 4.12 provides the (pure,
// stored-nowhere) timecode arithmetic. 4.13 is the Stop half of the
// recording lifecycle: on `recorder-stop-streams` it emits the stop sync
// marker, waits for the double-beep capture window, stops every
// recorder, awaits the final `dataavailable` flush (boundedly and
// honestly), releases devices, then closes each segment's chunk set:
// segments whose chunk timeline spans a discontinuity with media on both
// sides are split into separate pieces (minting new segmentIds — the
// 4.6/4.10 anticipation), every piece is numbered per
// (sessionId, streamKind) in chronological order, and the manifest is
// marked `finalizedAtUtc`.
//
// "Finalize" means closing the segment's chunk set and declaring it
// complete — 4.13 NEVER assembles media files (§6.4), never ZIPs (§6.6),
// never writes to downloads/OPFS. 4.13 stops, splits, numbers, marks;
// §6 consumes `segmentNumber` + chunks at export time.
//
// Recording platform APIs live only in the offscreen document (4.1's
// rule): this module references no MediaRecorder constructor, no
// getUserMedia/getDisplayMedia, no AudioContext — recorder/stream
// handles arrive injected, and the DB/indexedDB access is storage, not
// media capture. Everything is injected, so the module is DOM-free and
// unit-testable in Node.
//
// Dependency-free classic script → guarded BlindfoldSession global → IIFE
// 'use strict' → Node module.exports shim (repo house convention).
//
// Error conventions (AGENTS.md): TypeError = wrong type/shape;
// RangeError = bad domain value; plain Error = unavailable platform
// capability (never a weak fallback). The finalizer never throws into
// the channel handler: per-stream try/catch plus a top-level guard turn
// every failure into data.

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Constants.
  // ------------------------------------------------------------------

  // Stop-marker capture window: the double-beep is 150 ms onset-to-onset
  // with 250 ms beeps; 1000 ms covers the full 400 ms plus output/encoder
  // latency with margin (contract §6; 4.11 review). Named and V1-pinned;
  // tuning is §7 territory. Once, globally — not per stream.
  var STOP_MARKER_WAIT_MS = 1000;
  // Final-flush await: poll recorder.state until 'inactive' (the encoder
  // has handed off its last Blob by then, per spec) or this elapses.
  var FINALIZE_FLUSH_TIMEOUT_MS = 5000;
  // After the recorders report 'inactive', wait this long for 4.8's
  // async IDB puts to land before closing the segment.
  var FINALIZE_WRITE_GRACE_MS = 1000;
  // Flush-poll cadence.
  var FLUSH_POLL_MS = 100;

  var STREAM_KINDS = ['microphone', 'screen', 'webcam'];
  var MANIFEST_STORE = 'recording_manifest';
  var CHUNKS_STORE = 'media_chunks';
  var EVENTS_STORE = 'events';
  var EVENTS_BY_SESSION_INDEX = 'bySessionId';
  var DISCONTINUITY_EVENT_TYPE = 'stream_discontinuity';
  // This IS 4.9's reserved MANIFEST_FINALIZED_FIELD (contract §2):
  // recorder.js sets its reservation to this literal, and 4.9's
  // isManifestRecordFinalized() exclusion then works as designed.
  var FINALIZED_FIELD_DEFAULT = 'finalizedAtUtc';

  function freezeConstants() {
    Object.freeze(STREAM_KINDS);
  }
  freezeConstants();

  // ------------------------------------------------------------------
  // Private helpers.
  // ------------------------------------------------------------------

  function shared() {
    if (typeof globalThis !== 'undefined' && globalThis.BlindfoldSession) {
      return globalThis.BlindfoldSession;
    }
    return BlindfoldSession;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function errName(err) {
    return (err && typeof err.name === 'string' && err.name !== '') ?
      err.name : 'Error';
  }

  function errCode(err) {
    return (err && typeof err.streamErrorCode === 'string') ?
      err.streamErrorCode : 'internal-error';
  }

  function closeQuiet(db) {
    try {
      if (db && typeof db.close === 'function') {
        db.close();
      }
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------
  // Factory.
  //
  // opts (collaborators — all required unless noted):
  //   starter       — {getActiveStreams, discardActiveStream,
  //                    _isStartInFlight} (4.6; the last is the
  //                    start-in-progress guard)
  //   chunkWriter   — {stopForStream, getChunkState} (4.8)
  //   trackMonitor  — {detachStream} (4.9)
  //   syncMarker    — {emitStopMarker} (4.11)
  //   clockLink     — {linkClockSegment} (4.10; for split pieces)
  //   getAnchor     — forced-capture thunk (recorder.js ensureAnchor);
  //                   optional (null → null links, never a failure)
  //   formatSupport — {recordSegmentFormat?, getManifestRecord,
  //                    getManifestRecordsBySession,
  //                    requireValidManifestRecord} (4.5/4.10)
  //   db            — {put, get, getAll}; optional (default: lazy
  //                   shared-namespace BlindfoldSession.DB, the
  //                   format_support precedent)
  //   indexedDB     — optional (default: lazy globalThis.indexedDB,
  //                   the db.js pattern); used ONLY for the atomic
  //                   split re-key transaction
  //   dbName        — optional (default: shared DB.DB_NAME)
  //   getSessionId / getGameId — thunks (default: () => null →
  //                   the no-session guard fires)
  //   finalizedField — optional (default 'finalizedAtUtc'); recorder.js
  //                   passes its MANIFEST_FINALIZED_FIELD so the two
  //                   stay a single source of truth at wiring time
  //   nowUtcIso, performanceNow, setTimeoutFn, newUuidV4 — injected
  //   clocks/timers/uuid (defaults: real globals; newUuidV4 throws
  //   without crypto.randomUUID — never a weak fallback)
  // ------------------------------------------------------------------

  function createFinalizer(opts) {
    var o = opts || {};

    function requireCollaborator(name, value) {
      if (!isPlainObject(value)) {
        throw new TypeError('finalizer: ' + name + ' must be an object');
      }
      return value;
    }

    var starter = requireCollaborator('starter', o.starter);
    var chunkWriter = requireCollaborator('chunkWriter', o.chunkWriter);
    var trackMonitor = requireCollaborator('trackMonitor', o.trackMonitor);
    var syncMarker = requireCollaborator('syncMarker', o.syncMarker);
    var clockLink = requireCollaborator('clockLink', o.clockLink);
    var formatSupport = requireCollaborator('formatSupport', o.formatSupport);

    var getAnchor = (typeof o.getAnchor === 'function') ? o.getAnchor : null;
    var injectedDb = ('db' in o) ? o.db : null;
    var injectedIndexedDB = ('indexedDB' in o) ? o.indexedDB : null;
    var dbNameOpt = ('dbName' in o) ? o.dbName : null;
    var getSessionId = (typeof o.getSessionId === 'function') ?
      o.getSessionId : function () { return null; };
    var getGameId = (typeof o.getGameId === 'function') ?
      o.getGameId : function () { return null; };
    var finalizedField = (typeof o.finalizedField === 'string' &&
      o.finalizedField !== '') ? o.finalizedField : FINALIZED_FIELD_DEFAULT;

    var nowUtcIso = (typeof o.nowUtcIso === 'function') ?
      o.nowUtcIso : function () { return new Date().toISOString(); };
    var performanceNow = (typeof o.performanceNow === 'function') ?
      o.performanceNow : function () {
        var g = (typeof globalThis !== 'undefined') ? globalThis : null;
        var p = g ? g.performance : null;
        if (!p || typeof p.now !== 'function') {
          throw new Error('finalizer: performance.now is unavailable');
        }
        return p.now();
      };
    var setTimeoutFn = (typeof o.setTimeoutFn === 'function') ?
      o.setTimeoutFn : function (fn, ms) { return setTimeout(fn, ms); };
    var newUuidV4 = (typeof o.newUuidV4 === 'function') ?
      o.newUuidV4 : function () {
        var g = (typeof globalThis !== 'undefined') ? globalThis : null;
        var c = g ? g.crypto : null;
        if (!c || typeof c.randomUUID !== 'function') {
          throw new Error('finalizer: crypto.randomUUID is unavailable');
        }
        return c.randomUUID();
      };

    function readDb() {
      if (injectedDb) {
        return injectedDb;
      }
      var BS = shared();
      if (!BS || !BS.DB || typeof BS.DB.put !== 'function' ||
          typeof BS.DB.getAll !== 'function') {
        throw new Error('finalizer: DB is unavailable');
      }
      return BS.DB;
    }

    function readIndexedDB() {
      if (injectedIndexedDB) {
        return injectedIndexedDB;
      }
      var g = (typeof globalThis !== 'undefined') ? globalThis : null;
      var idb = g ? g.indexedDB : null;
      if (!idb || typeof idb.open !== 'function') {
        throw new Error('finalizer: indexedDB is unavailable');
      }
      return idb;
    }

    function readDbName() {
      if (typeof dbNameOpt === 'string' && dbNameOpt !== '') {
        return dbNameOpt;
      }
      var BS = shared();
      if (BS && BS.DB && typeof BS.DB.DB_NAME === 'string' &&
          BS.DB.DB_NAME !== '') {
        return BS.DB.DB_NAME;
      }
      throw new Error('finalizer: DB name is unavailable');
    }

    function sleep(ms) {
      return new Promise(function (resolve) {
        setTimeoutFn(resolve, ms);
      });
    }

    function isFinalized(record) {
      return !!(record && record[finalizedField]);
    }

    // Backfill any missing manifest keys to null before validation.
    // Records written by older extension versions predate the 4.13
    // widening; null is the honest "not applicable / not observed"
    // (the 4.6/4.7 nullable-field precedent). Real corruption (e.g. a
    // null segmentId) still fails requireValidManifestRecord below.
    function backfillRecord(rec) {
      var BS = shared();
      var keys = (BS && Array.isArray(BS.MANIFEST_KEYS)) ?
        BS.MANIFEST_KEYS : null;
      if (keys) {
        for (var i = 0; i < keys.length; i++) {
          if (!(keys[i] in rec)) {
            rec[keys[i]] = null;
          }
        }
      } else {
        if (!('segmentNumber' in rec)) {
          rec.segmentNumber = null;
        }
        if (!('finalizedAtUtc' in rec)) {
          rec.finalizedAtUtc = null;
        }
      }
      return rec;
    }

    // ----------------------------------------------------------------
    // Reads.
    // ----------------------------------------------------------------

    function getUnfinalizedRecords(sessionId) {
      return Promise.resolve()
        .then(function () {
          return formatSupport.getManifestRecordsBySession(sessionId);
        })
        .then(function (records) {
          var out = [];
          for (var i = 0; i < records.length; i++) {
            if (records[i] && !isFinalized(records[i])) {
              out.push(records[i]);
            }
          }
          return out;
        });
    }

    function readDiscontinuityEvents(sessionId) {
      var db = readDb();
      return Promise.resolve()
        .then(function () {
          return db.getAll(EVENTS_STORE, {
            index: EVENTS_BY_SESSION_INDEX,
            lower: sessionId,
            upper: sessionId
          });
        })
        .then(function (events) {
          var out = [];
          for (var i = 0; i < events.length; i++) {
            if (events[i] && events[i].eventType === DISCONTINUITY_EVENT_TYPE) {
              out.push(events[i]);
            }
          }
          return out;
        });
    }

    function readSegmentChunks(segmentId) {
      var db = readDb();
      return Promise.resolve()
        .then(function () {
          return db.getAll(CHUNKS_STORE, {
            lower: [segmentId, -1],
            upper: [segmentId, Number.MAX_SAFE_INTEGER]
          });
        })
        .then(function (records) {
          return Array.isArray(records) ? records : [];
        });
    }

    function readChunkIndexes(segmentId) {
      return readSegmentChunks(segmentId).then(function (records) {
        var out = [];
        for (var i = 0; i < records.length; i++) {
          var idx = records[i] && records[i].chunkIndex;
          if (typeof idx === 'number' && isFinite(idx)) {
            out.push(idx);
          }
        }
        return out;
      });
    }

    // ----------------------------------------------------------------
    // The atomic split transaction.
    //
    // One readwrite transaction over ['media_chunks',
    // 'recording_manifest']: delete each (oldSegmentId, idx) with
    // idx > cutoffExclusive, put the re-keyed record
    // (newSegmentId, idx - (cutoffExclusive + 1)), and put the new
    // piece's manifest record. A mid-split document death leaves
    // either the old keys or the new keys — never a mixture — and
    // the piece record only exists when its chunks moved.
    // ----------------------------------------------------------------

    function atomicSplit(oldSegmentId, newSegmentId, cutoffExclusive,
                         pieceRecord) {
      var idb = readIndexedDB();
      var name = readDbName();
      return readSegmentChunks(oldSegmentId).then(function (chunks) {
        var moves = [];
        for (var i = 0; i < chunks.length; i++) {
          var rec = chunks[i];
          var idx = rec.chunkIndex;
          if (typeof idx === 'number' && idx > cutoffExclusive) {
            var newRec = {};
            for (var k in rec) {
              if (Object.prototype.hasOwnProperty.call(rec, k)) {
                newRec[k] = rec[k];
              }
            }
            newRec.segmentId = newSegmentId;
            newRec.chunkIndex = idx - (cutoffExclusive + 1);
            moves.push({ oldKey: [oldSegmentId, idx], record: newRec });
          }
        }
        return runSplitTransaction(idb, name, moves, pieceRecord);
      });
    }

    function runSplitTransaction(idb, name, moves, pieceRecord) {
      return new Promise(function (resolve, reject) {
        var openReq;
        try {
          openReq = idb.open(name);
        } catch (e) {
          reject(e);
          return;
        }
        openReq.onerror = function () {
          reject(new Error('finalizer: could not open IDB for split (' +
            errName(openReq.error) + ')'));
        };
        openReq.onsuccess = function () {
          var db = openReq.result;
          var tx;
          try {
            tx = db.transaction([CHUNKS_STORE, MANIFEST_STORE], 'readwrite');
          } catch (e) {
            closeQuiet(db);
            reject(e);
            return;
          }
          var settled = false;
          function done(err) {
            if (settled) {
              return;
            }
            settled = true;
            closeQuiet(db);
            if (err) {
              reject(err);
            } else {
              resolve(true);
            }
          }
          tx.oncomplete = function () { done(null); };
          tx.onerror = function () {
            done(new Error('finalizer: split transaction failed (' +
              errName(tx.error) + ')'));
          };
          tx.onabort = function () {
            done(new Error('finalizer: split transaction aborted (' +
              errName(tx.error) + ')'));
          };
          var chunkStore;
          var manifestStore;
          try {
            chunkStore = tx.objectStore(CHUNKS_STORE);
            manifestStore = tx.objectStore(MANIFEST_STORE);
          } catch (e) {
            done(e);
            return;
          }
          try {
            for (var i = 0; i < moves.length; i++) {
              chunkStore.delete(moves[i].oldKey);
              chunkStore.put(moves[i].record);
            }
            // A request error aborts the transaction by default
            // (no preventDefault anywhere here); onabort reports it.
            manifestStore.put(pieceRecord);
          } catch (e) {
            try {
              tx.abort();
            } catch (w) { /* onabort reports */ }
          }
        };
      });
    }

    // ----------------------------------------------------------------
    // Splits (§4).
    // ----------------------------------------------------------------

    // Fresh clock link for a minted piece (4.10 §3.2 — never copied).
    // Linking can never fail the finalize: any failure → null.
    function linkPiece(newSegmentId) {
      try {
        var linked = clockLink.linkClockSegment({
          segmentId: newSegmentId,
          getAnchor: getAnchor
        });
        if (linked && typeof linked.clockSegmentId === 'string') {
          return linked.clockSegmentId;
        }
      } catch (e) { /* null link, recorded honestly */ }
      return null;
    }

    function buildPieceRecord(template, newSegmentId) {
      return {
        segmentId: newSegmentId,
        sessionId: template.sessionId,
        gameId: template.gameId,
        streamKind: template.streamKind,
        requestedMimeType: template.requestedMimeType,
        actualMimeType: template.actualMimeType,
        // actualMimeType is cloned, so the derived extension is
        // identical — copied, not re-derived.
        fileExtension: template.fileExtension,
        createdAtUtc: nowUtcIso(),
        // The piece is the same stream: the stream's identity fields
        // are unchanged (contract §4).
        streamStartedAtUtc: template.streamStartedAtUtc,
        streamStartedAtMonotonicMs: template.streamStartedAtMonotonicMs,
        effectiveDeviceId: template.effectiveDeviceId,
        audioTrackPresent: template.audioTrackPresent,
        videoTrackPresent: template.videoTrackPresent,
        screenAudioContent: template.screenAudioContent,
        micAudioContent: template.micAudioContent,
        clockSegmentId: linkPiece(newSegmentId),
        // Numbering and finalization happen in the later passes (§3).
        segmentNumber: null,
        finalizedAtUtc: null
      };
    }

    // Split the current piece at one gap (original coordinates).
    // Returns Promise<{newSegId} | null> (null = no split: no post-gap
    // media). A split failure rejects — the caller treats it as
    // best-effort and finalizes the segment unsplit (the discontinuity
    // stays in the event log; §6 still exports the chunks).
    function splitAtGap(template, currentSegId, base, gap) {
      var localGap = gap - base;
      if (localGap < 0) {
        return Promise.resolve(null);
      }
      return readChunkIndexes(currentSegId).then(function (indexes) {
        if (indexes.length === 0) {
          return null;
        }
        var localMax = indexes[0];
        for (var i = 1; i < indexes.length; i++) {
          if (indexes[i] > localMax) {
            localMax = indexes[i];
          }
        }
        // Contract §4: split iff media exists on BOTH sides of the gap.
        if (localMax <= localGap) {
          return null;
        }
        var newSegId = newUuidV4();
        var piece = buildPieceRecord(template, newSegId);
        formatSupport.requireValidManifestRecord(backfillRecord(piece));
        return atomicSplit(currentSegId, newSegId, localGap, piece)
          .then(function () { return { newSegId: newSegId }; });
      });
    }

    function maybeSplitSegment(record, events) {
      var segId = record.segmentId;
      var gaps = [];
      for (var i = 0; i < events.length; i++) {
        var e = events[i];
        var p = e.payload;
        // 'restart' never splits (4.6 already minted those generations).
        if (!p || p.reason === 'restart') {
          continue;
        }
        if (!(e.refs && e.refs.segmentId === segId)) {
          continue;
        }
        var lci = p.lastChunkIndex;
        if (typeof lci !== 'number' || !isFinite(lci)) {
          continue;
        }
        if (gaps.indexOf(lci) === -1) {
          gaps.push(lci);
        }
      }
      if (gaps.length === 0) {
        return Promise.resolve();
      }
      gaps.sort(function (a, b) { return a - b; });
      // Sequential splits, tracking the original-coordinate base of the
      // current tail piece (its chunk 0 == original chunk `base`).
      var currentSegId = segId;
      var base = 0;
      var chain = Promise.resolve();
      gaps.forEach(function (gap) {
        chain = chain.then(function () {
          return splitAtGap(record, currentSegId, base, gap).then(
            function (res) {
              if (res && res.newSegId) {
                currentSegId = res.newSegId;
                base = gap + 1;
              }
            },
            function () {
              // Best-effort: a failed split finalizes the segment
              // unsplit; the gap stays flagged in the event log.
            });
        });
      });
      return chain;
    }

    function runSplits(sessionId, records) {
      return readDiscontinuityEvents(sessionId).then(function (events) {
        var chain = Promise.resolve();
        records.forEach(function (rec) {
          chain = chain.then(function () {
            return maybeSplitSegment(rec, events);
          });
        });
        return chain;
      });
    }

    // ----------------------------------------------------------------
    // Numbering + final mark (§§2–3).
    // ----------------------------------------------------------------

    function assignNumbersAndMark(records, finalizedAt) {
      var db = readDb();
      var byKind = {};
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        var k = r.streamKind;
        if (typeof k !== 'string' || k === '') {
          continue;
        }
        (byKind[k] = byKind[k] || []).push(r);
      }
      var chain = Promise.resolve();
      Object.keys(byKind).forEach(function (kind) {
        var list = byKind[kind].sort(function (a, b) {
          if (a.createdAtUtc < b.createdAtUtc) {
            return -1;
          }
          if (a.createdAtUtc > b.createdAtUtc) {
            return 1;
          }
          if (a.segmentId < b.segmentId) {
            return -1;
          }
          if (a.segmentId > b.segmentId) {
            return 1;
          }
          return 0;
        });
        list.forEach(function (rec, idx) {
          chain = chain.then(function () {
            backfillRecord(rec);
            rec.segmentNumber = idx + 1;
            rec.finalizedAtUtc = finalizedAt;
            formatSupport.requireValidManifestRecord(rec);
            return db.put(MANIFEST_STORE, rec);
          });
        });
      });
      return chain.then(function () { return records; });
    }

    function buildSegmentLists(records) {
      var byKind = {};
      var chain = Promise.resolve();
      records.forEach(function (rec) {
        chain = chain.then(function () {
          return readChunkIndexes(rec.segmentId).then(function (indexes) {
            var k = rec.streamKind;
            (byKind[k] = byKind[k] || []).push({
              segmentId: rec.segmentId,
              segmentNumber: rec.segmentNumber,
              chunkCount: indexes.length
            });
          });
        });
      });
      return chain.then(function () {
        Object.keys(byKind).forEach(function (k) {
          byKind[k].sort(function (a, b) {
            return a.segmentNumber - b.segmentNumber;
          });
        });
        return byKind;
      });
    }

    // The finalize pass (§1 step 10): splits → numbering → finalizedAtUtc.
    // failedKinds: streamKinds whose stop sequence failed — their
    // segments stay unfinalized for a later retry.
    function finalizePass(sessionId, failedKinds) {
      var finalizedAt = nowUtcIso();
      var failedSet = {};
      (failedKinds || []).forEach(function (k) { failedSet[k] = true; });
      function eligible(records) {
        return records.filter(function (r) {
          return !failedSet[r.streamKind];
        });
      }
      return getUnfinalizedRecords(sessionId)
        .then(function (records) {
          return runSplits(sessionId, eligible(records));
        })
        .then(function () {
          return getUnfinalizedRecords(sessionId);
        })
        .then(function (fresh) {
          return assignNumbersAndMark(eligible(fresh), finalizedAt);
        })
        .then(function (numbered) {
          return buildSegmentLists(numbered).then(function (byKind) {
            return {
              finalizedAtUtc: finalizedAt,
              byKind: byKind,
              totalFinalized: numbered.length
            };
          });
        });
    }

    // ----------------------------------------------------------------
    // The stop sequence (§1).
    // ----------------------------------------------------------------

    function awaitFinalFlush(liveRecorders) {
      return new Promise(function (resolve) {
        var start = null;
        try {
          start = performanceNow();
        } catch (e) {
          start = 0;
        }
        function notInactive() {
          var out = [];
          for (var i = 0; i < liveRecorders.length; i++) {
            var st = null;
            try {
              st = liveRecorders[i].recorder.state;
            } catch (e) {
              st = null;
            }
            // An unreadable recorder counts as not-inactive: unknown is
            // unknown, and the timeout path reports it honestly.
            if (st !== 'inactive') {
              out.push(liveRecorders[i].kind);
            }
          }
          return out;
        }
        function poll() {
          var pending = notInactive();
          if (pending.length === 0) {
            resolve({ timedOutKinds: [] });
            return;
          }
          var elapsed = 0;
          try {
            elapsed = performanceNow() - start;
          } catch (e) {
            elapsed = 0;
          }
          if (elapsed >= FINALIZE_FLUSH_TIMEOUT_MS) {
            resolve({ timedOutKinds: pending });
            return;
          }
          setTimeoutFn(poll, FLUSH_POLL_MS);
        }
        poll();
      }).then(function (r) {
        // Write grace: give 4.8's async IDB puts time to land before
        // the segment is closed.
        return sleep(FINALIZE_WRITE_GRACE_MS).then(function () { return r; });
      });
    }

    function stopActiveStreams(sessionId, active, kinds) {
      var perStream = {};
      var failed = {};
      kinds.forEach(function (k) {
        perStream[k] = { ok: true, segments: [] };
      });
      function failKind(kind, stage, err) {
        failed[kind] = true;
        perStream[kind] = {
          ok: false,
          error: errCode(err),
          errorName: errName(err),
          stage: stage,
          segments: []
        };
      }

      // Step 2: the stop marker — iff streams are active. Auxiliary:
      // a marker failure becomes markerId:null, never a Stop failure.
      var markerId = null;
      try {
        var mid = syncMarker.emitStopMarker();
        markerId = (typeof mid === 'string' && mid !== '') ? mid : null;
      } catch (e) {
        markerId = null;
      }

      // Step 3: the capture window (once, globally).
      return sleep(STOP_MARKER_WAIT_MS).then(function () {
        // Step 4: stop the chunk poll loops (the ondataavailable
        // handler stays attached — the 4.8 seam — so the final
        // stop() flush is stored as a chunk).
        kinds.forEach(function (kind) {
          if (failed[kind]) {
            return;
          }
          try {
            chunkWriter.stopForStream(kind);
          } catch (e) {
            failKind(kind, 'stop-chunker', e);
          }
        });
        // Step 5: recorder.stop() per stream (skipped when not
        // 'recording'; an InvalidStateError race is a skip, not a
        // failure — no final flush is expected from a dead recorder).
        var liveRecorders = [];
        kinds.forEach(function (kind) {
          if (failed[kind]) {
            return;
          }
          var rec = active[kind] && active[kind].recorder;
          if (!rec || typeof rec !== 'object') {
            failKind(kind, 'stop-recorder', new Error('missing recorder'));
            return;
          }
          var state = null;
          try {
            state = rec.state;
          } catch (e) {
            state = null;
          }
          if (state === 'recording') {
            try {
              rec.stop();
            } catch (e) {
              if (!e || e.name !== 'InvalidStateError') {
                failKind(kind, 'stop-recorder', e);
                return;
              }
            }
          }
          liveRecorders.push({ kind: kind, recorder: rec });
        });
        // Step 6: final-flush await (bounded; honest on timeout).
        return awaitFinalFlush(liveRecorders).then(function (flush) {
          flush.timedOutKinds.forEach(function (kind) {
            if (perStream[kind]) {
              perStream[kind].flushTimedOut = true;
            }
          });
          // Step 7: monitor detach BEFORE stopping tracks — a clean
          // Stop is not a discontinuity (4.9 logs mid-session ends).
          // Best-effort: monitoring cleanup never fails the Stop.
          kinds.forEach(function (kind) {
            if (failed[kind]) {
              return;
            }
            try {
              trackMonitor.detachStream(kind);
            } catch (e) { /* monitoring cleanup is best-effort */ }
          });
          // Step 8: release devices, per-track try/catch.
          kinds.forEach(function (kind) {
            if (failed[kind]) {
              return;
            }
            var stream = active[kind] && active[kind].stream;
            var tracks = [];
            try {
              tracks = (stream && typeof stream.getTracks === 'function') ?
                stream.getTracks() : [];
            } catch (e) {
              tracks = [];
            }
            if (!Array.isArray(tracks)) {
              tracks = [];
            }
            for (var i = 0; i < tracks.length; i++) {
              try {
                tracks[i].stop();
              } catch (e) { /* one bad track must not block the rest */ }
            }
          });
          // Step 9: discard the registry entries so a later
          // recorder-start-streams passes the already-started guard.
          kinds.forEach(function (kind) {
            if (failed[kind]) {
              return;
            }
            try {
              starter.discardActiveStream(kind);
            } catch (e) {
              failKind(kind, 'discard-registry', e);
            }
          });
          // Step 10: the finalize pass.
          var failedKinds = Object.keys(failed);
          return finalizePass(sessionId, failedKinds).then(function (fin) {
            // Step 11: response.
            kinds.forEach(function (kind) {
              if (failed[kind]) {
                return; // segments: [] already
              }
              perStream[kind].segments = fin.byKind[kind] || [];
            });
            return {
              ok: true,
              markerId: markerId,
              finalizedAtUtc: fin.finalizedAtUtc,
              streams: perStream
            };
          });
        });
      });
    }

    // Crash-recovery (§1): no active streams, but unfinalized manifest
    // records exist (a previous generation died without Stop). Steps
    // 2–9 are skipped — there are no recorders to stop and no media
    // for a marker to align to — and step 10 finalizes the orphans.
    function finalizeOrphans(sessionId) {
      return finalizePass(sessionId, []).then(function (fin) {
        if (fin.totalFinalized === 0) {
          return { ok: true, streams: {}, note: 'nothing-to-finalize' };
        }
        return {
          ok: true,
          markerId: null,
          finalizedAtUtc: fin.finalizedAtUtc,
          streams: {},
          note: 'finalized-orphans'
        };
      });
    }

    function runStop() {
      var sid = null;
      var gid = null;
      try {
        sid = getSessionId();
        gid = getGameId();
      } catch (e) {
        sid = null;
        gid = null;
      }
      // Guards (before any device/media action — the 4.6 precedent).
      if (typeof sid !== 'string' || sid === '' ||
          typeof gid !== 'string' || gid === '') {
        return Promise.resolve({ ok: false, error: 'no-session' });
      }
      var inFlight = false;
      try {
        inFlight = !!(starter._isStartInFlight &&
          starter._isStartInFlight());
      } catch (e) {
        inFlight = false;
      }
      if (inFlight) {
        return Promise.resolve({ ok: false, error: 'start-in-progress' });
      }
      var active = {};
      try {
        active = starter.getActiveStreams() || {};
      } catch (e) {
        active = {};
      }
      var kinds = STREAM_KINDS.filter(function (k) {
        return !!active[k];
      });
      if (kinds.length === 0) {
        return finalizeOrphans(sid);
      }
      return stopActiveStreams(sid, active, kinds);
    }

    // Never throws into the channel handler: per-stream try/catch above
    // plus this top-level guard turn every failure into data.
    function stopAndFinalize() {
      try {
        return Promise.resolve()
          .then(runStop)
          .then(function (res) {
            return res;
          }, function (err) {
            return {
              ok: false,
              error: errCode(err),
              errorName: errName(err)
            };
          });
      } catch (e) {
        return Promise.resolve({
          ok: false,
          error: errCode(e),
          errorName: errName(e)
        });
      }
    }

    return {
      stopAndFinalize: stopAndFinalize,
      // Exposed for tests / V1 pins.
      stopMarkerWaitMs: function () { return STOP_MARKER_WAIT_MS; },
      flushTimeoutMs: function () { return FINALIZE_FLUSH_TIMEOUT_MS; },
      writeGraceMs: function () { return FINALIZE_WRITE_GRACE_MS; }
    };
  }

  // ------------------------------------------------------------------
  // Exports.
  // ------------------------------------------------------------------

  BlindfoldSession.FINALIZER_STOP_MARKER_WAIT_MS = STOP_MARKER_WAIT_MS;
  BlindfoldSession.FINALIZER_FLUSH_TIMEOUT_MS = FINALIZE_FLUSH_TIMEOUT_MS;
  BlindfoldSession.FINALIZER_WRITE_GRACE_MS = FINALIZE_WRITE_GRACE_MS;
  BlindfoldSession.FINALIZER_FLUSH_POLL_MS = FLUSH_POLL_MS;
  BlindfoldSession.FINALIZER_STREAM_KINDS = STREAM_KINDS;
  BlindfoldSession.FINALIZER_FINALIZED_FIELD = FINALIZED_FIELD_DEFAULT;
  BlindfoldSession.createFinalizer = createFinalizer;
})();

// Node test shim. The offscreen document loads this via <script>; only
// environments that provide CommonJS get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
