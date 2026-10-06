// event_envelope.js
//
// Task 1.3 (PLAN.md §1.3.1–§1.3.5): event identity and time model.
//
// Dependency-free plain script. Loads as a content-script global, via
// importScripts() in a future MV3 service worker, or under Node via the
// module.exports shim at the end. Platform-independent by design: no
// chrome.* APIs, no DOM, no storage — factories, validators, constants, and
// the wall-clock derivation formula only.
//
// Envelope semantics:
// - Every event belongs to a recording session (sessionId required).
// - Event identity is a UUID v4 (eventId); the §2.4 writer deduplicates by it.
// - Event types are flat snake_case strings (e.g. 'conditions_changed',
//   'clock_anchor'), enforced in code by EVENT_TYPE_RE. Each task defines its
//   own *_EVENT_TYPE constant(s) in its own module; event_envelope.js owns
//   only the types 1.3 itself defines (CLOCK_ANCHOR).
// - Time is stamped at the source on a per-context-segment monotonic clock
//   (performance.now(), stored verbatim as monotonicMs). No per-event wall
//   clock is persisted: wall time is derived from the segment's clock anchor
//   via deriveWallUtcMs (anchor.utcEpochMs + (t - anchor.monotonicMs)).
// - A context segment is one continuous lifetime of one event-producing
//   execution context (one content-script instance per page load, one service
//   worker instance, one recording-context instance). Each segment captures
//   one clock anchor at startup, emitted as a clock_anchor event row.
// - appendSeq is null at creation; assignment is the §2.4 writer's job.
//   Source times (clockSegmentId, monotonicMs) are never rewritten on
//   delivery — delivery/storage order may differ from occurrence order.
// - refs is null or a flat frozen {roleId: uuid-v4} map. Reference roles are
//   defined by the tasks that emit them, never enumerated here.
//
// Error conventions:
// - TypeError  = wrong type/shape, including missing required fields.
// - RangeError = value outside the allowed domain (bad event-type syntax,
//   bad sourceContext, negative/non-integer sequences, etc.).
// - plain Error = unavailable platform capability (crypto.randomUUID or
//   performance.now missing) — honest failure, never a silent fallback.
//
// Load-order independence: the UUID check below is a private internal
// function (same pattern as session_identity.js's UUID_V4_RE). This module
// reads no other module's exports at load time and does not re-export
// isUuidV4 (that name is already taken on BlindfoldSession).

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  var EVENT_TYPES = Object.freeze({ CLOCK_ANCHOR: 'clock_anchor' });
  var SOURCE_CONTEXTS = Object.freeze([
    'content_script',
    'service_worker',
    'recording_context'
  ]);
  var EVENT_TYPE_RE = Object.freeze(/^[a-z][a-z0-9_]{0,63}$/);
  // Reference role keys: camelCase, 'Id' suffix (documents that values are IDs).
  var REF_ROLE_RE = /^[a-z][a-zA-Z0-9]*Id$/;
  // Private UUID v4 check — deliberately not shared with session_identity.js
  // so neither module depends on the other's load order.
  var UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  var EVENT_KEYS = [
    'eventId', 'eventType', 'sessionId', 'gameId', 'sourceContext',
    'sourceSeq', 'clockSegmentId', 'monotonicMs', 'appendSeq', 'refs', 'payload'
  ];
  var ANCHOR_KEYS = ['segmentId', 'utcEpochMs', 'monotonicMs'];

  function isUuidV4(s) {
    return typeof s === 'string' && UUID_V4_RE.test(s);
  }

  function webCrypto() {
    if (typeof globalThis !== 'undefined' && globalThis.crypto) {
      return globalThis.crypto;
    }
    return null;
  }

  // Single private UUID source. newEventId and newClockSegmentId are
  // independent exported functions (not aliases) so the two streams stay
  // separable in review. No fallback: if the Web Crypto API is unavailable
  // the factory throws instead of fabricating weak IDs.
  function newUuid() {
    var cryptoObj = webCrypto();
    if (!cryptoObj || typeof cryptoObj.randomUUID !== 'function') {
      throw new Error(
        'BlindfoldSession: crypto.randomUUID() is unavailable in this environment'
      );
    }
    return cryptoObj.randomUUID();
  }

  function newEventId() { return newUuid(); }

  function newClockSegmentId() { return newUuid(); }

  function isEventType(s) {
    return typeof s === 'string' && EVENT_TYPE_RE.test(s);
  }

  function isSourceContext(s) {
    return typeof s === 'string' && SOURCE_CONTEXTS.indexOf(s) !== -1;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
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

  // Missing or malformed ID: TypeError (mirrors 1.1's "gameId must be a
  // uuid-v4 string"). A missing/malformed ID is a caller error, not a
  // value-out-of-domain case.
  function requireUuidV4(value, name) {
    if (!isUuidV4(value)) {
      throw new TypeError(name + ' must be a uuid-v4 string');
    }
  }

  function requireNonNegativeInteger(value, name) {
    if (typeof value !== 'number') {
      throw new TypeError(name + ' must be a number');
    }
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(name + ' must be an integer >= 0');
    }
  }

  // Monotonic clock readings: finite number >= 0, stored verbatim
  // (never rounded at the contract layer).
  function requireMonotonicMs(value, name) {
    if (typeof value !== 'number') {
      throw new TypeError(name + ' must be a number');
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(name + ' must be a finite number >= 0');
    }
  }

  function requireEventType(value) {
    if (typeof value !== 'string') {
      throw new TypeError('eventType must be a string');
    }
    if (!EVENT_TYPE_RE.test(value)) {
      throw new RangeError(
        'eventType must be flat snake_case of up to 64 chars ' +
        '(lowercase letters, digits, underscores)'
      );
    }
  }

  function requireSourceContext(value) {
    if (!isSourceContext(value)) {
      throw new RangeError(
        'sourceContext must be one of: ' + SOURCE_CONTEXTS.join(', ')
      );
    }
  }

  function requireSessionId(value) {
    requireUuidV4(value, 'sessionId');
  }

  function requireGameId(value) {
    if (value === undefined) {
      throw new TypeError('gameId is required (use null for session-scoped events)');
    }
    if (value === null) return;
    requireUuidV4(value, 'gameId');
  }

  function requireClockSegmentId(value) {
    requireUuidV4(value, 'clockSegmentId');
  }

  function requireRefs(value) {
    if (value === null || value === undefined) return null;
    if (!isPlainObject(value)) {
      throw new TypeError('refs must be null or a flat object');
    }
    var frozen = {};
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      var role = keys[i];
      if (typeof role !== 'string' || !REF_ROLE_RE.test(role)) {
        throw new RangeError(
          'refs key must be camelCase with an Id suffix (e.g. attemptId)'
        );
      }
      requireUuidV4(value[role], 'refs[' + role + ']');
      frozen[role] = value[role];
    }
    return Object.freeze(frozen);
  }

  function requirePayload(value) {
    if (!isPlainObject(value)) {
      throw new TypeError('payload must be a plain object');
    }
    // Shallow freeze; already-frozen payloads are unaffected.
    return Object.freeze(value);
  }

  // Validates the (segmentId, utcEpochMs, monotonicMs) triple. Throws
  // TypeError/RangeError on any shape/domain violation; void on success.
  function requireValidClockAnchor(anchor) {
    requireObject(anchor, 'anchor');
    requireExactKeys(anchor, ANCHOR_KEYS, 'anchor');
    requireUuidV4(anchor.segmentId, 'anchor.segmentId');
    requireNonNegativeInteger(anchor.utcEpochMs, 'anchor.utcEpochMs');
    requireMonotonicMs(anchor.monotonicMs, 'anchor.monotonicMs');
  }

  // Creates a clock anchor record: exactly {segmentId, utcEpochMs,
  // monotonicMs}, frozen. segmentId is generated when omitted (undefined or
  // null); utcEpochMs is integer epoch ms; monotonicMs is the unrounded
  // performance.now() reading.
  function createClockAnchor(options) {
    requireObject(options, 'options');
    var segmentId = (options.segmentId === undefined || options.segmentId === null)
      ? newUuid()
      : options.segmentId;
    requireUuidV4(segmentId, 'segmentId');
    requireNonNegativeInteger(options.utcEpochMs, 'utcEpochMs');
    requireMonotonicMs(options.monotonicMs, 'monotonicMs');
    return Object.freeze({
      segmentId: segmentId,
      utcEpochMs: options.utcEpochMs,
      monotonicMs: options.monotonicMs
    });
  }

  function perfHooks() {
    if (typeof globalThis !== 'undefined' && globalThis.performance) {
      return globalThis.performance;
    }
    return null;
  }

  // Captures a clock anchor for a context segment: reads performance.now()
  // first, then Date.now() adjacently. Throws a plain Error (not a silent
  // Date.now() substitution) when performance.now is unavailable.
  function captureClockAnchor(segmentId) {
    var id = (segmentId === undefined || segmentId === null)
      ? newUuid()
      : segmentId;
    requireUuidV4(id, 'segmentId');
    var perf = perfHooks();
    if (!perf || typeof perf.now !== 'function') {
      throw new Error(
        'BlindfoldSession: performance.now() is unavailable in this environment'
      );
    }
    var monotonicMs = perf.now();
    var utcEpochMs = Date.now();
    return createClockAnchor({
      segmentId: id,
      utcEpochMs: utcEpochMs,
      monotonicMs: monotonicMs
    });
  }

  // Derives wall-clock epoch ms for an event stamped at monotonicMs on the
  // segment described by anchor. Pure: anchor.utcEpochMs +
  // (monotonicMs - anchor.monotonicMs). For the anchor's own monotonicMs it
  // returns exactly anchor.utcEpochMs.
  function deriveWallUtcMs(anchor, monotonicMs) {
    requireValidClockAnchor(anchor);
    requireMonotonicMs(monotonicMs, 'monotonicMs');
    return anchor.utcEpochMs + (monotonicMs - anchor.monotonicMs);
  }

  // Creates an event envelope: exactly the 11 keys, frozen, with appendSeq
  // null (assignment is the §2.4 writer's job) and refs defaulting to null.
  // sourceSeq is the caller-owned per-segment counter (passed through, not
  // generated); monotonicMs is the caller-supplied clock reading, stored
  // verbatim and never rewritten.
  function createEvent(options) {
    requireObject(options, 'options');
    requireEventType(options.eventType);
    requireSessionId(options.sessionId);
    requireGameId(options.gameId);
    requireSourceContext(options.sourceContext);
    requireNonNegativeInteger(options.sourceSeq, 'sourceSeq');
    requireClockSegmentId(options.clockSegmentId);
    requireMonotonicMs(options.monotonicMs, 'monotonicMs');
    var refs = requireRefs(options.refs === undefined ? null : options.refs);
    var payload = requirePayload(options.payload);
    return Object.freeze({
      eventId: newEventId(),
      eventType: options.eventType,
      sessionId: options.sessionId,
      gameId: options.gameId,
      sourceContext: options.sourceContext,
      sourceSeq: options.sourceSeq,
      clockSegmentId: options.clockSegmentId,
      monotonicMs: options.monotonicMs,
      appendSeq: null,
      refs: refs,
      payload: payload
    });
  }

  // Creates the clock_anchor event row for a segment: clockSegmentId and
  // monotonicMs are copied from the anchor itself, gameId is null
  // (session-scoped by definition), payload is the frozen anchor.
  function createAnchorEvent(options) {
    requireObject(options, 'options');
    requireSessionId(options.sessionId);
    requireSourceContext(options.sourceContext);
    requireNonNegativeInteger(options.sourceSeq, 'sourceSeq');
    requireValidClockAnchor(options.anchor);
    var anchor = options.anchor;
    return createEvent({
      eventType: EVENT_TYPES.CLOCK_ANCHOR,
      sessionId: options.sessionId,
      gameId: null,
      sourceContext: options.sourceContext,
      sourceSeq: options.sourceSeq,
      clockSegmentId: anchor.segmentId,
      monotonicMs: anchor.monotonicMs,
      payload: anchor,
      refs: null
    });
  }

  // Full envelope validation: all 11 keys present, correct types and
  // domains, appendSeq null-or-integer, refs shape, payload plain object.
  // Throws TypeError/RangeError; void on success.
  function requireValidEvent(event) {
    requireObject(event, 'event');
    requireExactKeys(event, EVENT_KEYS, 'event');
    requireUuidV4(event.eventId, 'eventId');
    requireEventType(event.eventType);
    requireSessionId(event.sessionId);
    requireGameId(event.gameId);
    requireSourceContext(event.sourceContext);
    requireNonNegativeInteger(event.sourceSeq, 'sourceSeq');
    requireClockSegmentId(event.clockSegmentId);
    requireMonotonicMs(event.monotonicMs, 'monotonicMs');
    if (event.appendSeq !== null) {
      requireNonNegativeInteger(event.appendSeq, 'appendSeq');
    }
    if (event.refs !== null) {
      if (!isPlainObject(event.refs)) {
        throw new TypeError('refs must be null or a flat object');
      }
      var keys = Object.keys(event.refs);
      for (var i = 0; i < keys.length; i++) {
        if (!REF_ROLE_RE.test(keys[i])) {
          throw new RangeError(
            'refs key must be camelCase with an Id suffix (e.g. attemptId)'
          );
        }
        requireUuidV4(event.refs[keys[i]], 'refs[' + keys[i] + ']');
      }
    }
    if (!isPlainObject(event.payload)) {
      throw new TypeError('payload must be a plain object');
    }
  }

  // Intake validation for §2.4: true when requireValidEvent passes.
  function isValidEvent(event) {
    try {
      requireValidEvent(event);
      return true;
    } catch (e) {
      return false;
    }
  }

  BlindfoldSession.EVENT_TYPES = EVENT_TYPES;
  BlindfoldSession.SOURCE_CONTEXTS = SOURCE_CONTEXTS;
  BlindfoldSession.EVENT_TYPE_RE = EVENT_TYPE_RE;
  BlindfoldSession.newEventId = newEventId;
  BlindfoldSession.newClockSegmentId = newClockSegmentId;
  BlindfoldSession.isEventType = isEventType;
  BlindfoldSession.isSourceContext = isSourceContext;
  BlindfoldSession.createClockAnchor = createClockAnchor;
  BlindfoldSession.captureClockAnchor = captureClockAnchor;
  BlindfoldSession.requireValidClockAnchor = requireValidClockAnchor;
  BlindfoldSession.createAnchorEvent = createAnchorEvent;
  BlindfoldSession.createEvent = createEvent;
  BlindfoldSession.requireValidEvent = requireValidEvent;
  BlindfoldSession.isValidEvent = isValidEvent;
  BlindfoldSession.deriveWallUtcMs = deriveWallUtcMs;
})();

// Node test shim. Content-script and importScripts() consumers use the
// BlindfoldSession global directly; only environments that provide CommonJS
// get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
