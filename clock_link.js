// clock_link.js
//
// Task 4.10 (PLAN.md §4.10): link recording segments to clock segments.
//
// A "clock segment" in this codebase is exactly one clock_anchor event
// row: {segmentId (uuid-v4), utcEpochMs, monotonicMs} (event_envelope.js,
// createClockAnchor / captureClockAnchor). Every event envelope carries
// clockSegmentId + monotonicMs; wall time for any event is
// anchor.utcEpochMs + (monotonicMs - anchor.monotonicMs)
// (deriveWallUtcMs). The offscreen document holds ONE anchor per
// document generation, captured lazily at first emission (recorder.js:
// anchor = null → captureClockAnchor() on first emitEvent). All
// recording_context events from one document generation therefore share
// one clockSegmentId.
//
// 4.10 is the link between the two identity systems: at stream start it
// writes the active recording-context clock segment's ID into the
// recording's manifest record (the clockSegmentId field), so 4.12 can
// later convert any recording-relative timestamp
// (streamStartedAtMonotonicMs, chunk timecodeMs) to wall clock via the
// named anchor. 4.10 mints nothing (4.6 mints segmentIds at stream
// start; 4.13 mints post-discontinuity segmentIds — the 4.5 §2 amendment
// and 4.6 contract record why), computes no offsets, emits no events —
// it writes one nullable field and documents the model.
//
// The lazy-anchor subtlety: the document's anchor may not exist when
// the first stream starts (nothing may have been emitted yet). The
// linker FORCES anchor capture through the injected getAnchor thunk
// (recorder.js's ensureAnchor) before reading the id — honest, because
// the anchor describes the document's already-running clock; capturing
// it earlier changes nothing about the clock.
//
// Document restart = new clock segment (new performance.now() origin →
// new anchor → new clockSegmentId). The 4.9 'restart' discontinuity
// mints new segmentIds; 4.10 writes new links for them against the new
// anchor. Old manifest records keep their old links (the manifest
// survives document death in extension-owned IDB) — exactly why the
// link belongs in the manifest, not in document memory. A mid-recording
// discontinuity (4.9) does NOT change the clock segment: the clock
// continues; only the media timeline has a gap. Links survive media
// gaps; 4.12 interprets them with 4.9's discontinuity events.
//
// The linker is identity-only: it reads the anchor's segmentId and
// nothing else. No deriveWallUtcMs calls, no offset computation, no
// timecodeMs interpretation (4.12 owns all of that). It NEVER throws:
// any failure (missing/throwing getAnchor, malformed anchor,
// non-uuid segmentId) → {clockSegmentId: null}. Unknown is null;
// linking can never fail a stream (the 4.6/4.7/4.8/4.9 precedent).
//
// Dependency-free classic script → guarded BlindfoldSession global →
// IIFE 'use strict' → Node module.exports shim (repo house convention).
//
// Error conventions (AGENTS.md): this module never throws on the link
// path. (No platform capability is involved — the anchor comes from the
// injected thunk.)

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  var UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  // linkClockSegment({segmentId, getAnchor}) → {clockSegmentId}.
  //
  // segmentId is the caller's recording segmentId (carried for the
  // 4.13 seam — the linker does not mint, only links; it is not
  // otherwise used). getAnchor is the forced-capture thunk
  // (recorder.js's ensureAnchor in production; injected in tests).
  //
  // Returns the anchor's segmentId, or null when the anchor cannot be
  // captured or is malformed. Never throws.
  function linkClockSegment(input) {
    try {
      if (!input || typeof input !== 'object') {
        return { clockSegmentId: null };
      }
      var getAnchor = input.getAnchor;
      if (typeof getAnchor !== 'function') {
        return { clockSegmentId: null };
      }
      // Forced capture: if the document has not emitted yet, this
      // captures the anchor now (honest — the clock already runs).
      // A throw becomes a null link, never a stream failure.
      var anchor = getAnchor();
      if (!anchor || typeof anchor !== 'object') {
        return { clockSegmentId: null };
      }
      // Identity-only: read the segmentId, nothing else. No
      // wall-clock derivation, no offset arithmetic (4.12's).
      var id = anchor.segmentId;
      if (typeof id !== 'string' || !UUID_V4_RE.test(id)) {
        return { clockSegmentId: null };
      }
      return { clockSegmentId: id };
    } catch (e) {
      return { clockSegmentId: null };
    }
  }

  // Factory for the shared-namespace lazy-resolution pattern
  // (createAudioPolicy / createFormatSupport precedent). The factory
  // takes no options today; the link inputs arrive per call so 4.13
  // can link caller-minted post-discontinuity segmentIds through the
  // same function.
  function createClockLink() {
    return { linkClockSegment: linkClockSegment };
  }

  BlindfoldSession.createClockLink = createClockLink;
  BlindfoldSession.linkClockSegment = linkClockSegment;
})();

// Node test shim. The offscreen document loads this via <script>; only
// environments that provide CommonJS get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
