// timecode.js
//
// Task 4.12 (PLAN.md §4.12): calculate (never store) the recording
// timecode/offset information needed to align each media segment with
// event time.
//
// 4.6 saved per-stream start times (streamStartedAtUtc +
// streamStartedAtMonotonicMs, which differ per stream); 4.8 saved raw
// per-chunk timecodeMs (media time, never analyzed); 4.10 saved the
// clockSegmentId link from each recording segment to its clock anchor;
// 4.11 saved sync_marker events whose envelope monotonicMs /
// clockSegmentId are the markers' source timestamps. 4.12 is the FIRST
// task allowed to do timestamp arithmetic: this module is the single
// canonical home for the media-time → document-clock → wall-clock
// conversions, the played-vs-failed marker disambiguation rule, and the
// discontinuity-continuity rule. Every function is pure (no IDB, no
// chrome.*, no DOM, no clock reads — every timestamp is a parameter),
// and 4.12 PERSISTS NOTHING: every offset below is a pure function of
// already-stored values, so persisting any of them would violate the
// standing no-derivable-values rule (see the §0.1 PLAN reading note in
// .autodev/evidence/4.12.contract.md). MANIFEST_KEYS stays 16,
// DB_VERSION stays 2.
//
// Clock model (4.10): one document generation ⇒ one performance.now()
// clock; document restart ⇒ new clock, new anchor, new generation.
// Wall time for any monotonic reading is
//   anchor.utcEpochMs + (monotonicMs - anchor.monotonicMs)
// (event_envelope.deriveWallUtcMs). All monotonic inputs below are
// readings on ONE document's clock; the anchor is always an explicit
// parameter resolved by the event's own clockSegmentId — the
// recording-context anchor is never assumed (4.11: audible markers
// carry the offscreen clock, visible markers carry the content-script
// clock; cross-context confusion is a correctness bug).
//
// Media-time semantics (§3 of the contract): BlobEvent.timecode on
// dataavailable is media ms since recorder.start(). Timecode 0 is
// treated as the start() call time (4.6's streamStartedAtMonotonicMs);
// encoder start latency is unobservable to us and folded into
// alignment tolerance, never corrected. Chunk-arrival time
// (receivedAtMonotonicMs) is NEVER frame time — ordering evidence
// only; no 4.12 conversion takes it as input.
//
// Error conventions (repo AGENTS.md): null/undefined input → null
// output (unknown is null, never a guess); non-finite numbers
// (NaN, ±Infinity) → null (platform garbage is unknown, not a
// guess); negative timecodeMs → null (unusable platform data, not a
// domain error thrown into bulk export loops — deliberate); wrong-type
// non-null input → TypeError; malformed anchor → TypeError (an anchor
// is never "unknown null" here — the caller resolves it or does not
// call); fromMono > toMono → RangeError (mediaRangeIsContinuous).
// isUsableSyncMarker is a defensive predicate: malformed payload →
// false, never throws.
//
// Dependency-free classic script → guarded BlindfoldSession global →
// IIFE 'use strict' → Node module.exports shim (repo house convention).

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  var UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  // Finite number, null, or undefined → itself-or-null; any other
  // non-null type → TypeError. Non-finite numbers (NaN, ±Infinity) →
  // null: platform garbage is unknown, never a guess.
  function requireFiniteNumberOrNull(v, name) {
    if (v === null || v === undefined) {
      return null;
    }
    if (typeof v !== 'number') {
      throw new TypeError(name + ' must be a number, null, or undefined');
    }
    if (!isFinite(v)) {
      return null;
    }
    return v;
  }

  // Media timecode: as above, plus negative → null (unusable platform
  // data — treated as unknown, not a domain error thrown into bulk
  // export loops).
  function requireTimecodeMs(v, name) {
    var n = requireFiniteNumberOrNull(v, name);
    if (n !== null && n < 0) {
      return null;
    }
    return n;
  }

  // The anchor triple the caller resolved via the event's own
  // clockSegmentId. Any shape violation → TypeError (an anchor is
  // never "unknown null" here).
  function requireValidAnchor(anchor) {
    if (!anchor || typeof anchor !== 'object') {
      throw new TypeError('anchor must be an object');
    }
    if (typeof anchor.segmentId !== 'string' ||
        !UUID_V4_RE.test(anchor.segmentId)) {
      throw new TypeError('anchor.segmentId must be a uuid-v4 string');
    }
    if (!isFiniteNumber(anchor.utcEpochMs)) {
      throw new TypeError('anchor.utcEpochMs must be a finite number');
    }
    if (!isFiniteNumber(anchor.monotonicMs)) {
      throw new TypeError('anchor.monotonicMs must be a finite number');
    }
    return anchor;
  }

  // mediaToMonotonicMs(streamStartedAtMonotonicMs, timecodeMs) →
  // number|null. Media-timeline position → document clock:
  // streamStartedAtMonotonicMs + timecodeMs. Encodes the §3.1
  // assumption (timecode 0 ≈ the start() call time).
  function mediaToMonotonicMs(streamStartedAtMonotonicMs, timecodeMs) {
    var start = requireFiniteNumberOrNull(
      streamStartedAtMonotonicMs, 'streamStartedAtMonotonicMs');
    var tc = requireTimecodeMs(timecodeMs, 'timecodeMs');
    if (start === null || tc === null) {
      return null;
    }
    return start + tc;
  }

  // wallUtcMs(anchor, monotonicMs) → number|null. The canonical
  // wall-clock derivation for alignment use:
  // anchor.utcEpochMs + (monotonicMs - anchor.monotonicMs).
  // V1-pinned equal to event_envelope.deriveWallUtcMs on fixtures.
  function wallUtcMs(anchor, monotonicMs) {
    requireValidAnchor(anchor);
    var m = requireFiniteNumberOrNull(monotonicMs, 'monotonicMs');
    if (m === null) {
      return null;
    }
    return anchor.utcEpochMs + (m - anchor.monotonicMs);
  }

  // chunkWallUtcMs(anchor, streamStartedAtMonotonicMs, timecodeMs) →
  // number|null. The wall-clock time of a chunk's media position.
  // null when timecodeMs is null/unusable — unknown, NEVER
  // arrival-time-backed (§3.2).
  function chunkWallUtcMs(anchor, streamStartedAtMonotonicMs, timecodeMs) {
    requireValidAnchor(anchor);
    var mono = mediaToMonotonicMs(streamStartedAtMonotonicMs, timecodeMs);
    if (mono === null) {
      return null;
    }
    return wallUtcMs(anchor, mono);
  }

  // streamStartWallUtcMs(anchor, streamStartedAtMonotonicMs) →
  // number|null. Wall-clock time the stream's recording began.
  function streamStartWallUtcMs(anchor, streamStartedAtMonotonicMs) {
    requireValidAnchor(anchor);
    var start = requireFiniteNumberOrNull(
      streamStartedAtMonotonicMs, 'streamStartedAtMonotonicMs');
    if (start === null) {
      return null;
    }
    return anchor.utcEpochMs + (start - anchor.monotonicMs);
  }

  // markerMediaOffsetMs(markerMonotonicMs, streamStartedAtMonotonicMs)
  // → number|null. The marker's predicted position in the stream's
  // media timeline, in ms. May be NEGATIVE (the marker is
  // per-generation; streams start at different times — a negative
  // offset honestly means the marker precedes this stream's media).
  // Callers pass only usable markers (isUsableSyncMarker).
  function markerMediaOffsetMs(markerMonotonicMs, streamStartedAtMonotonicMs) {
    var marker = requireFiniteNumberOrNull(
      markerMonotonicMs, 'markerMonotonicMs');
    var start = requireFiniteNumberOrNull(
      streamStartedAtMonotonicMs, 'streamStartedAtMonotonicMs');
    if (marker === null || start === null) {
      return null;
    }
    return marker - start;
  }

  // markerWallUtcMs(anchor, markerMonotonicMs) → number|null.
  // Wall-clock time of the marker event. anchor = the anchor named by
  // the marker event's OWN clockSegmentId (audible ⇒
  // recording-context anchor; visible ⇒ content-script anchor).
  function markerWallUtcMs(anchor, markerMonotonicMs) {
    return wallUtcMs(anchor, markerMonotonicMs);
  }

  // streamStartOffsetMs(refStartMono, otherStartMono) → number|null.
  // otherStartMono − refStartMono: the canonical per-stream start
  // offset against a caller-chosen reference (e.g. the earliest
  // stream start). Trivial arithmetic, named so multi-stream sync
  // never re-derives it ad hoc.
  function streamStartOffsetMs(refStartMono, otherStartMono) {
    var ref = requireFiniteNumberOrNull(refStartMono, 'refStartMono');
    var other = requireFiniteNumberOrNull(otherStartMono, 'otherStartMono');
    if (ref === null || other === null) {
      return null;
    }
    return other - ref;
  }

  // isUsableSyncMarker(payload) → boolean. Only sync_marker events
  // that actually anchored a modality participate in alignment:
  // 'played' (audible) or 'shown' (visible). 'failed' = the modality
  // produced no acoustic/optical anchor (the event stays in the log
  // as the honest attempt record, but its timestamp is not a media
  // landmark); 'skipped' = not attempted. Malformed payload →
  // false. Defensive predicate: never throws.
  function isUsableSyncMarker(payload) {
    if (!payload || typeof payload !== 'object') {
      return false;
    }
    var status = payload.status;
    return status === 'played' || status === 'shown';
  }

  // mediaRangeIsContinuous(discontinuityMonos, fromMono, toMono) →
  // boolean|null. discontinuityMonos is the array of envelope
  // monotonicMs values of the segment's stream_discontinuity events
  // (any order — interval membership needs no sorting). Returns true
  // iff NO discontinuity lies within the CLOSED interval
  // [fromMono, toMono] (observation times have inherent fuzz —
  // boundaries are treated conservatively). The clock continues
  // across 4.9's gaps; media must not be interpolated across them.
  // The 'restart' discontinuity is not handled here: a restart mints
  // new segmentIds with new manifest records, new start times, and
  // new clock links — each generation aligns independently via its
  // own anchor.
  function mediaRangeIsContinuous(discontinuityMonos, fromMono, toMono) {
    if (discontinuityMonos === null || discontinuityMonos === undefined) {
      return null;
    }
    if (!Array.isArray(discontinuityMonos)) {
      throw new TypeError('discontinuityMonos must be an array, null, or undefined');
    }
    var from = requireFiniteNumberOrNull(fromMono, 'fromMono');
    var to = requireFiniteNumberOrNull(toMono, 'toMono');
    if (from === null || to === null) {
      return null;
    }
    if (from > to) {
      throw new RangeError('fromMono must be <= toMono');
    }
    // Validate every element before evaluating: malformed input always
    // throws, regardless of whether an earlier element already settles
    // the interval question.
    for (var i = 0; i < discontinuityMonos.length; i++) {
      if (!isFiniteNumber(discontinuityMonos[i])) {
        throw new TypeError(
          'discontinuityMonos[' + i + '] must be a finite number');
      }
    }
    for (var j = 0; j < discontinuityMonos.length; j++) {
      var d = discontinuityMonos[j];
      if (d >= from && d <= to) {
        return false;
      }
    }
    return true;
  }

  // Factory for the shared-namespace pattern (createAudioPolicy /
  // createClockLink precedent). 4.13, 4.14, and §6.3 call these
  // instead of scattering ad-hoc timestamp math.
  function createTimecode() {
    return {
      mediaToMonotonicMs: mediaToMonotonicMs,
      wallUtcMs: wallUtcMs,
      chunkWallUtcMs: chunkWallUtcMs,
      streamStartWallUtcMs: streamStartWallUtcMs,
      markerMediaOffsetMs: markerMediaOffsetMs,
      markerWallUtcMs: markerWallUtcMs,
      streamStartOffsetMs: streamStartOffsetMs,
      isUsableSyncMarker: isUsableSyncMarker,
      mediaRangeIsContinuous: mediaRangeIsContinuous
    };
  }

  BlindfoldSession.mediaToMonotonicMs = mediaToMonotonicMs;
  BlindfoldSession.wallUtcMs = wallUtcMs;
  BlindfoldSession.chunkWallUtcMs = chunkWallUtcMs;
  BlindfoldSession.streamStartWallUtcMs = streamStartWallUtcMs;
  BlindfoldSession.markerMediaOffsetMs = markerMediaOffsetMs;
  BlindfoldSession.markerWallUtcMs = markerWallUtcMs;
  BlindfoldSession.streamStartOffsetMs = streamStartOffsetMs;
  BlindfoldSession.isUsableSyncMarker = isUsableSyncMarker;
  BlindfoldSession.mediaRangeIsContinuous = mediaRangeIsContinuous;
  BlindfoldSession.createTimecode = createTimecode;
})();

// Node test shim. Loadable in any context (offscreen document for
// 4.13's use, SW for §6.3's export); only environments that provide
// CommonJS get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
