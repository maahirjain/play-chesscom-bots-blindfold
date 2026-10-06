// lifecycle.js
//
// Task 2.7 (PLAN.md §2.7): page/context start and clean-end events; unclean
// discontinuity marking when recovery detects a missing end.
//
// Dependency-free plain script. Loads as a content-script global (after
// sender.js) and via importScripts() in the MV3 service worker (last), or
// under Node via the module.exports shim at the end. Platform-independent
// by design: no chrome.* APIs — content-side code touches only window
// (pagehide) and an injected sender; SW-side code is a client of
// BlindfoldSession.writeEvent / BlindfoldSession.DB (reads only).
//
// A page context = one content-script instance lifetime = one 1.3 context
// segment. Three event types (each task owns its own *_EVENT_TYPE constants,
// per the 1.3 precedent — event_envelope.js is untouched):
//   page_start         — content script, eager at session start (§5 calls
//                        emitPageStart)
//   page_end_clean     — content script, on pagehide (best-effort; never a
//                        flush — see the 2.5 note below)
//   page_discontinuity — service worker, when a committed page_start finds
//                        a prior start with no clean end on record
//
// The marker's honest meaning: "when page context N started, page context M
// (older) had no page_end_clean and no prior discontinuity marker on
// record." It does NOT claim "M crashed": M may be alive in a concurrent
// tab; M's end may have lost the pagehide delivery race; a late-arriving
// end does not retract the marker (history is append-only).
//
// 2.5 tension (no unload/pagehide flush): page_end_clean is a SINGLE
// best-effort emit() through the normal sender pipeline. No flush() at
// pagehide — ever. Its loss is the designed-for trigger case: the
// detector's input IS "no end on record". Conservative by design: a lost
// end may flag a clean reload, but a real gap is never hidden.
//
// Error conventions (AGENTS.md): TypeError = wrong type/shape; RangeError =
// bad domain value; plain Error = unavailable platform capability.

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Constants.
  // ------------------------------------------------------------------

  var PAGE_START = 'page_start';
  var PAGE_END_CLEAN = 'page_end_clean';
  var PAGE_DISCONTINUITY = 'page_discontinuity';

  var UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  // ------------------------------------------------------------------
  // Private helpers.
  // ------------------------------------------------------------------

  // Resolve the shared BlindfoldSession namespace at call time (sender.js /
  // session_store.js precedent). Never cached at load: keeps this module
  // independent of importScripts order and loadable in Node.
  function shared() {
    if (typeof globalThis !== 'undefined' && globalThis.BlindfoldSession) {
      return globalThis.BlindfoldSession;
    }
    return BlindfoldSession;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function isUuidV4(s) {
    return typeof s === 'string' && UUID_V4_RE.test(s);
  }

  function requireObject(v, name) {
    if (!isPlainObject(v)) {
      throw new TypeError(name + ' must be an object');
    }
  }

  function requireExactKeys(obj, keys, name) {
    var actual = Object.keys(obj);
    if (actual.length !== keys.length) {
      throw new TypeError(name + ' must have exactly ' + keys.length + ' keys');
    }
    for (var i = 0; i < keys.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(obj, keys[i])) {
        throw new TypeError(name + ' is missing required key: ' + keys[i]);
      }
    }
  }

  function requireUuidV4(value, name) {
    if (!isUuidV4(value)) {
      throw new TypeError(name + ' must be a uuid-v4 string');
    }
  }

  function requireSessionId(value) {
    requireUuidV4(value, 'sessionId');
  }

  function requireSender(sender) {
    if (sender === null || typeof sender !== 'object' ||
        typeof sender.emit !== 'function') {
      throw new TypeError('sender must be a sender object with an emit function');
    }
  }

  function perfNowMs() {
    var g = (typeof globalThis !== 'undefined') ? globalThis : null;
    var perf = g && g.performance;
    if (!perf || typeof perf.now !== 'function') {
      throw new Error(
        'BlindfoldSession: performance.now() is unavailable in this environment'
      );
    }
    return perf.now();
  }

  // ------------------------------------------------------------------
  // Payload / refs validators (strict: extra keys rejected, 1.x convention).
  // ------------------------------------------------------------------

  function requireValidPageStartPayload(payload) {
    requireObject(payload, 'payload');
    requireExactKeys(payload, [], 'page_start payload');
    return payload;
  }

  function requireValidPageEndPayload(payload) {
    requireObject(payload, 'payload');
    requireExactKeys(payload, ['reason'], 'page_end_clean payload');
    if (payload.reason !== 'pagehide') {
      throw new RangeError('page_end_clean payload.reason must be \'pagehide\'');
    }
    return payload;
  }

  function requireValidDiscontinuityPayload(payload) {
    requireObject(payload, 'payload');
    requireExactKeys(
      payload, ['orphanedSegmentId', 'newSegmentId'], 'page_discontinuity payload'
    );
    requireUuidV4(payload.orphanedSegmentId, 'payload.orphanedSegmentId');
    requireUuidV4(payload.newSegmentId, 'payload.newSegmentId');
    return payload;
  }

  function requireValidDiscontinuityRefs(refs) {
    requireObject(refs, 'refs');
    requireExactKeys(refs, ['orphanedStartEventId'], 'page_discontinuity refs');
    requireUuidV4(refs.orphanedStartEventId, 'refs.orphanedStartEventId');
    return refs;
  }

  // ------------------------------------------------------------------
  // Content-side emission (thin wrappers over an injected sender).
  // ------------------------------------------------------------------

  // Eager: callable before any observation. The sender's own lazy logic
  // emits the clock_anchor first (sourceSeq 0); the page_start lands at
  // sourceSeq 1. Returns the envelope.
  function emitPageStart(sender, sessionId) {
    requireSender(sender);
    requireSessionId(sessionId);
    return sender.emit({
      eventType: PAGE_START,
      sessionId: sessionId,
      gameId: null,
      payload: {}
    });
  }

  function emitPageEndClean(sender, sessionId) {
    requireSender(sender);
    requireSessionId(sessionId);
    return sender.emit({
      eventType: PAGE_END_CLEAN,
      sessionId: sessionId,
      gameId: null,
      payload: { reason: 'pagehide' }
    });
  }

  // Registers one pagehide listener. No-op when window is undefined
  // (SW/Node-safe). Skips bfcache restores (e.persisted). Emits only when
  // activeSessionId is a non-empty string (§5 sets it at Start). Never
  // throws; never calls flush() (2.5 stands).
  function installPageEndHook(sender) {
    if (typeof window === 'undefined') {
      return;
    }
    requireSender(sender);
    window.addEventListener('pagehide', function (e) {
      try {
        if (e && e.persisted) {
          return; // bfcache: the context is not ending
        }
        var sid = shared().activeSessionId;
        if (typeof sid !== 'string' || sid === '') {
          return; // no active session (§5 seam): inert
        }
        emitPageEndClean(sender, sid);
      } catch (err) {
        // Best-effort by design: the hook must never break the page.
      }
    });
  }

  // ------------------------------------------------------------------
  // SW-side detection.
  // ------------------------------------------------------------------

  // Per-SW-instance module state (segment-scoped identity, NOT restored
  // durable state — a new SW instance legitimately starts new segments):
  //   swAnchors: sessionId -> captured clock anchor
  //   swSeqs:    sessionId -> next sourceSeq for discontinuity events (1, 2, …)
  //   sessionChains: sessionId -> promise chain serializing detection per
  //                  session (prevents double-marking under concurrent
  //                  page_starts; also dedups SW-anchor creation)
  var swAnchors = {};
  var swSeqs = {};
  var sessionChains = {};

  // Consumer side of the writer's generic post-commit hook (2.4 §3.2 seam).
  // Returns undefined unless the stored event is a page_start with
  // ack.ok === true; otherwise returns the notePageStartStored(event)
  // promise. Never throws synchronously.
  function afterEventStored(event, ack) {
    if (!ack || ack.ok !== true) {
      return undefined;
    }
    if (!event || event.eventType !== PAGE_START) {
      return undefined;
    }
    return notePageStartStored(event);
  }

  // Defensive entry: malformed input resolves (never sync-throws); the real
  // work runs serialized per session.
  function notePageStartStored(pageStartEvent) {
    var sessionId = (pageStartEvent && typeof pageStartEvent.sessionId === 'string')
      ? pageStartEvent.sessionId
      : null;
    if (sessionId === null || sessionId === '') {
      return Promise.resolve();
    }
    var chain = sessionChains[sessionId] || Promise.resolve();
    var next = chain.then(function () {
      return detectOrphans(pageStartEvent, sessionId);
    });
    // Keep the chain alive for the next start even if this detection
    // rejects (orphans persist — the next start retries; AC13).
    sessionChains[sessionId] = next.catch(function () {});
    return next;
  }

  // The detection itself. Reads the session's event stream via the
  // bySessionId index; partitions into anchors / ends / markers / starts;
  // flags orphans (older starts with no end and no marker, passing the
  // temporal guard); writes one page_discontinuity per orphan via
  // BlindfoldSession.writeEvent. Zero raw IDB writes to events /
  // sequence_state — the writer stays the sole writer.
  function detectOrphans(pageStartEvent, sessionId) {
    var BS = shared();
    // Defensive validation: malformed start → no-op (resolved).
    if (!pageStartEvent || pageStartEvent.eventType !== PAGE_START ||
        typeof pageStartEvent.eventId !== 'string' ||
        typeof pageStartEvent.clockSegmentId !== 'string') {
      return Promise.resolve();
    }
    var newSegmentId = pageStartEvent.clockSegmentId;
    return BS.DB.getAll('events', {
      index: 'bySessionId', lower: sessionId, upper: sessionId
    }).then(function (rows) {
      var anchorTimes = {}; // clockSegmentId -> anchor utcEpochMs
      var ended = {};       // clockSegmentId -> true
      var marked = {};      // orphaned page_start eventId -> true
      var starts = [];
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (!row || typeof row.eventType !== 'string') {
          continue;
        }
        if (row.eventType === 'clock_anchor' &&
            row.payload && typeof row.payload.utcEpochMs === 'number') {
          anchorTimes[row.clockSegmentId] = row.payload.utcEpochMs;
        } else if (row.eventType === PAGE_END_CLEAN) {
          ended[row.clockSegmentId] = true;
        } else if (row.eventType === PAGE_DISCONTINUITY &&
            row.refs && typeof row.refs.orphanedStartEventId === 'string') {
          marked[row.refs.orphanedStartEventId] = true;
        } else if (row.eventType === PAGE_START &&
            typeof row.eventId === 'string' &&
            typeof row.clockSegmentId === 'string') {
          starts.push(row);
        }
      }
      var newTime = anchorTimes[newSegmentId];
      var orphans = [];
      for (var j = 0; j < starts.length; j++) {
        var s = starts[j];
        if (s.clockSegmentId === newSegmentId) {
          continue; // the new start itself
        }
        if (ended[s.clockSegmentId]) {
          continue; // clean end on record
        }
        if (marked[s.eventId]) {
          continue; // already flagged
        }
        var orphanTime = anchorTimes[s.clockSegmentId];
        // Temporal guard: an out-of-order delayed older start must not
        // flag a newer live segment. Missing orphan anchors fall back to
        // flagging (conservative — a missing anchor is itself evidence of
        // an unhealthy pipeline; anchors always precede page_start via the
        // sender's stop-and-wait discipline).
        if (orphanTime === undefined || orphanTime < newTime) {
          orphans.push(s);
        }
      }
      if (orphans.length === 0) {
        return; // lazy: no SW anchor is created when nothing is marked
      }
      return ensureSwAnchor(sessionId).then(function (anchor) {
        var seq = (swSeqs[sessionId] === undefined) ? 1 : swSeqs[sessionId];
        var chain = Promise.resolve();
        orphans.forEach(function (orphan) {
          chain = chain.then(function () {
            var discEvent = BS.createEvent({
              eventType: PAGE_DISCONTINUITY,
              sessionId: sessionId,
              gameId: null,
              sourceContext: 'service_worker',
              sourceSeq: seq++,
              clockSegmentId: anchor.segmentId,
              monotonicMs: perfNowMs(),
              payload: {
                orphanedSegmentId: orphan.clockSegmentId,
                newSegmentId: newSegmentId
              },
              refs: { orphanedStartEventId: orphan.eventId }
            });
            // Validate at construction (fail-fast on contract drift).
            requireValidDiscontinuityPayload(discEvent.payload);
            requireValidDiscontinuityRefs(discEvent.refs);
            return BS.writeEvent(discEvent).then(function (ack) {
              if (!ack || ack.ok !== true) {
                throw new Error(
                  'lifecycle: discontinuity write failed for session ' + sessionId
                );
              }
            });
          });
        });
        return chain.then(function () {
          swSeqs[sessionId] = seq;
        });
      });
    });
  }

  // Lazy per-(SW-instance, session) clock anchor. Captures and stores the
  // anchor via BlindfoldSession.writeEvent (sourceSeq 0); write failure
  // rejects (no dishonest timestamp — the next page_start retries).
  function ensureSwAnchor(sessionId) {
    var BS = shared();
    if (swAnchors[sessionId]) {
      return Promise.resolve(swAnchors[sessionId]);
    }
    var anchor;
    try {
      anchor = BS.captureClockAnchor();
    } catch (e) {
      return Promise.reject(e);
    }
    var anchorEvent = BS.createAnchorEvent({
      sessionId: sessionId,
      sourceContext: 'service_worker',
      sourceSeq: 0,
      anchor: anchor
    });
    return BS.writeEvent(anchorEvent).then(function (ack) {
      if (!ack || ack.ok !== true) {
        throw new Error(
          'lifecycle: SW anchor write failed for session ' + sessionId
        );
      }
      swAnchors[sessionId] = anchor;
      return anchor;
    });
  }

  // ------------------------------------------------------------------
  // §5 seam.
  // ------------------------------------------------------------------

  // Set by §5 at session Start; cleared at Stop. Until §5 exists the
  // pagehide hook is inert.
  BlindfoldSession.activeSessionId = null;

  BlindfoldSession.PAGE_START = PAGE_START;
  BlindfoldSession.PAGE_END_CLEAN = PAGE_END_CLEAN;
  BlindfoldSession.PAGE_DISCONTINUITY = PAGE_DISCONTINUITY;
  BlindfoldSession.requireValidPageStartPayload = requireValidPageStartPayload;
  BlindfoldSession.requireValidPageEndPayload = requireValidPageEndPayload;
  BlindfoldSession.requireValidDiscontinuityPayload = requireValidDiscontinuityPayload;
  BlindfoldSession.requireValidDiscontinuityRefs = requireValidDiscontinuityRefs;
  BlindfoldSession.emitPageStart = emitPageStart;
  BlindfoldSession.emitPageEndClean = emitPageEndClean;
  BlindfoldSession.installPageEndHook = installPageEndHook;
  BlindfoldSession.afterEventStored = afterEventStored;
  BlindfoldSession.notePageStartStored = notePageStartStored;
})();

// Node test shim. Content-script and importScripts() consumers use the
// BlindfoldSession global directly; only environments that provide CommonJS
// get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
