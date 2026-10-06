// stream_starter.js
//
// Task 4.6 (PLAN.md §4.6): start separate microphone, screen, and webcam
// recording streams, saving actual start times rather than assuming
// simultaneous starts.
//
// 4.6 acquires the three MediaStreams, constructs the three
// MediaRecorders, starts them (no timeslice — 4.8 owns chunk extraction),
// and writes the manifest record for each via 4.5's recordSegmentFormat
// with the REAL negotiated recorder.mimeType and per-stream actual start
// times (UTC ISO + performance.now() monotonic).
//
// Per-stream independence: a failure in one stream never blocks the
// others. Partial tracks are stopped; no manifest record is written for
// a failed stream; the channel response carries per-stream
// {ok:false, error, errorName, stage} outcomes (stage ∈
// {'verify-formats','acquire-stream','construct-recorder',
// 'start-recorder','write-manifest'}).
//
// Separateness (the 4.4 boundary, implemented here): three distinct
// MediaStreams, three MediaRecorders, no AudioContext, no track merging.
// audioTrackPresent / videoTrackPresent are recorded per stream for 4.7
// and 4.14.
//
// 4.6 mints the segmentId (uuid-v4) at each stream start — the 4.5 §2
// contract amendment: the manifest record is written at stream start and
// recording_manifest's keyPath IS segmentId. 4.10 links clock anchors to
// these IDs; 4.13 mints only post-discontinuity segments.
//
// Recording platform APIs live only in the offscreen document (4.1's
// rule): getUserMedia, getDisplayMedia, new MediaRecorder never appear
// in the SW, content scripts, or capture_broker.js. Everything is
// injected, so the module is DOM-free and unit-testable in Node.
//
// No new event types: the manifest records plus the channel response are
// the durable trace; 4.9/4.10/4.14 own the event timeline.
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

  var STREAM_KINDS = ['microphone', 'screen', 'webcam'];

  // Honest failure stages for per-stream outcomes.
  var STAGES = [
    'verify-formats',
    'acquire-stream',
    'construct-recorder',
    'start-recorder',
    'write-manifest'
  ];

  function freezeConstants() {
    Object.freeze(STREAM_KINDS);
    Object.freeze(STAGES);
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

  function codedError(code, message) {
    var e = new Error(message || code);
    e.streamErrorCode = code;
    return e;
  }

  function errorCodeOf(err) {
    return (err && typeof err.streamErrorCode === 'string') ?
      err.streamErrorCode : null;
  }

  function stopAllTracks(stream) {
    try {
      var tracks = (stream && typeof stream.getTracks === 'function') ?
        stream.getTracks() : [];
      for (var i = 0; i < tracks.length; i++) {
        try { tracks[i].stop(); } catch (e) { /* one bad track must not block the rest */ }
      }
    } catch (e) { /* a stream we cannot inspect is still dropped */ }
  }

  // ------------------------------------------------------------------
  // createStreamStarter.
  //
  // opts:
  //   mediaDevices   — injected; else read from globalThis.navigator
  //   getDisplayMedia— injected; else read from navigator.mediaDevices /
  //                    navigator (screen-mode fallback; probed honestly)
  //   MediaRecorder  — injected constructor; else globalThis.MediaRecorder
  //   micSelector    — the 4.2 audioinput selector instance
  //   cameraSelector — the 4.4 videoinput selector instance
  //   captureSelector— the 4.3 capture selector instance
  //   broker         — SW broker client {resolveTargetTab, getStreamId}
  //   formatSupport  — 4.5's {verifyFormats, recordSegmentFormat}
  //   audioPolicy    — 4.7's {classifyScreenAudio, assertMicAudio};
  //                    injected for tests, else resolved lazily from the
  //                    document's shared namespace at call time.
  //                    Classification can never fail a stream (nulls on
  //                    any failure).
  //   clockLink      — 4.10's {linkClockSegment}; injected for tests,
  //                    else resolved lazily from the document's shared
  //                    namespace at call time. Linking can never fail a
  //                    stream (null link on any failure).
  //   getAnchor      — forced-capture thunk for the recording-context
  //                    clock anchor (recorder.js's ensureAnchor);
  //                    injected in tests. A throw becomes a null link.
  //   getSessionId / getGameId — thunks (pre-session inertness)
  //   nowUtcIso      — () => UTC ISO string (injectable clock)
  //   perfNowMs      — () => performance.now() (injectable clock)
  //   newUuidV4      — () => uuid-v4 string (injectable; never a weak
  //                    fallback in production — recorder.js throws)
  // ------------------------------------------------------------------

  function createStreamStarter(opts) {
    var o = opts || {};

    function readGlobal() {
      return (typeof globalThis !== 'undefined') ? globalThis : null;
    }

    function readMediaDevices() {
      if (o.mediaDevices !== undefined && o.mediaDevices !== null) {
        return o.mediaDevices;
      }
      var g = readGlobal();
      var nav = g ? g.navigator : null;
      var md = nav ? nav.mediaDevices : null;
      if (!md || typeof md.getUserMedia !== 'function') {
        throw new Error('stream_starter: navigator.mediaDevices.getUserMedia is unavailable');
      }
      return md;
    }

    function readGetDisplayMedia() {
      if (typeof o.getDisplayMedia === 'function') {
        return o.getDisplayMedia;
      }
      var g = readGlobal();
      var nav = g ? g.navigator : null;
      var md = nav ? nav.mediaDevices : null;
      // The document-global fallback must be BOUND: an unbound method
      // reference throws "Illegal invocation" (TypeError) when called —
      // a real bug class this fallback exists to avoid (4.6 V2 found it).
      var self = null;
      var fn = null;
      if (md && typeof md.getDisplayMedia === 'function') {
        self = md;
        fn = md.getDisplayMedia;
      } else if (nav && typeof nav.getDisplayMedia === 'function') {
        self = nav;
        fn = nav.getDisplayMedia;
      }
      if (!fn) {
        throw new Error('stream_starter: getDisplayMedia is unavailable');
      }
      return function (constraints) {
        return fn.call(self, constraints);
      };
    }

    function readMediaRecorder() {
      if (o.MediaRecorder !== undefined && o.MediaRecorder !== null) {
        return o.MediaRecorder;
      }
      var g = readGlobal();
      var MR = g ? g.MediaRecorder : null;
      if (typeof MR !== 'function') {
        throw new Error('stream_starter: MediaRecorder is unavailable');
      }
      return MR;
    }

    var micSelector = o.micSelector || null;
    var cameraSelector = o.cameraSelector || null;
    var captureSelector = o.captureSelector || null;
    var broker = o.broker || null;
    var formatSupport = o.formatSupport || null;
    var audioPolicyOpt = o.audioPolicy || null;
    var clockLinkOpt = o.clockLink || null;
    var getAnchorThunk = (typeof o.getAnchor === 'function') ?
      o.getAnchor : null;

    // 4.7's audio-content policy ({classifyScreenAudio, assertMicAudio}).
    // Injected for tests; in the offscreen document resolved lazily from
    // the shared namespace at call time (recorder.js passes it like
    // formatSupport). Classification can NEVER fail a stream: an
    // unavailable policy or a policy throw yields null classifications,
    // recorded honestly.
    function readAudioPolicy() {
      if (audioPolicyOpt &&
          typeof audioPolicyOpt.classifyScreenAudio === 'function' &&
          typeof audioPolicyOpt.assertMicAudio === 'function') {
        return audioPolicyOpt;
      }
      var g = readGlobal();
      var ns = g ? g.BlindfoldSession : null;
      if (ns && typeof ns.createAudioPolicy === 'function') {
        try {
          var ap = ns.createAudioPolicy();
          if (ap && typeof ap.classifyScreenAudio === 'function' &&
              typeof ap.assertMicAudio === 'function') {
            audioPolicyOpt = ap;
            return ap;
          }
        } catch (e) { /* fall through to nulls */ }
      }
      return null;
    }

    // Classify this stream's audio content (4.7). Pure and infallible
    // from the caller's perspective: any failure → {null, null}.
    function classifyStreamAudio(kind, acq) {
      var out = { screenAudioContent: null, micAudioContent: null };
      try {
        var ap = readAudioPolicy();
        if (!ap) {
          return out;
        }
        var presence = !!acq.audioTrackPresent;
        if (kind === 'screen') {
          out.screenAudioContent = ap.classifyScreenAudio({
            captureMode: (acq.captureMode === undefined) ?
              null : acq.captureMode,
            audioTrackPresent: presence
          });
        } else if (kind === 'microphone') {
          out.micAudioContent = ap.assertMicAudio({
            audioTrackPresent: presence,
            audioTrackCount: (typeof acq.audioTrackCount === 'number') ?
              acq.audioTrackCount : null
          });
        }
        // Webcam records carry null for both (uniform record shape).
      } catch (e) { /* classification can never fail a stream */ }
      return out;
    }

    // 4.10's clock linker ({linkClockSegment}). Injected for tests; in
    // the offscreen document resolved lazily from the shared namespace
    // at call time (recorder.js passes it like formatSupport /
    // audioPolicy). Linking can NEVER fail a stream: an unavailable
    // linker yields a null link, recorded honestly.
    function readClockLink() {
      if (clockLinkOpt &&
          typeof clockLinkOpt.linkClockSegment === 'function') {
        return clockLinkOpt;
      }
      var g = readGlobal();
      var ns = g ? g.BlindfoldSession : null;
      if (ns && typeof ns.createClockLink === 'function') {
        try {
          var cl = ns.createClockLink();
          if (cl && typeof cl.linkClockSegment === 'function') {
            clockLinkOpt = cl;
            return cl;
          }
        } catch (e) { /* fall through to null link */ }
      }
      return null;
    }

    // Link this recording segment to the active recording-context
    // clock segment (4.10). Identity-only and infallible from the
    // caller's perspective: any failure → null link. The getAnchor
    // thunk forces the lazy anchor capture (honest — the document's
    // clock already runs); a throw becomes a null link.
    function linkStreamClock(segmentId) {
      try {
        var cl = readClockLink();
        if (!cl) {
          return null;
        }
        var linked = cl.linkClockSegment({
          segmentId: segmentId,
          getAnchor: getAnchorThunk
        });
        if (linked && typeof linked.clockSegmentId === 'string') {
          return linked.clockSegmentId;
        }
        return null;
      } catch (e) {
        return null;
      }
    }

    function getSessionId() {
      return (typeof o.getSessionId === 'function') ? o.getSessionId() : null;
    }
    function getGameId() {
      return (typeof o.getGameId === 'function') ? o.getGameId() : null;
    }
    var nowUtcIso = (typeof o.nowUtcIso === 'function') ?
      o.nowUtcIso : function () { return new Date().toISOString(); };
    var perfNowMs = (typeof o.perfNowMs === 'function') ?
      o.perfNowMs : function () {
        var g = readGlobal();
        var p = g ? g.performance : null;
        if (!p || typeof p.now !== 'function') {
          throw new Error('stream_starter: performance.now is unavailable');
        }
        return p.now();
      };
    var newUuidV4 = (typeof o.newUuidV4 === 'function') ?
      o.newUuidV4 : function () {
        var g = readGlobal();
        var c = g ? g.crypto : null;
        if (!c || typeof c.randomUUID !== 'function') {
          throw new Error('stream_starter: crypto.randomUUID is unavailable');
        }
        return c.randomUUID();
      };

    function requireFormatSupport() {
      if (!formatSupport ||
          typeof formatSupport.verifyFormats !== 'function' ||
          typeof formatSupport.recordSegmentFormat !== 'function') {
        throw new Error('stream_starter: formatSupport is unavailable');
      }
      return formatSupport;
    }

    // Module registry of live streams: streamKind → {stream, recorder,
    // segmentId, startedAtUtc, startedAtMonotonicMs}. In-memory only —
    // streams cannot survive document death (honest; 4.9 logs the
    // discontinuity, 4.13 re-segments). Keeps everything referenced so
    // 4.13's Stop is possible and nothing is GC'd.
    var registry = {};
    var startInFlight = false;

    function getActiveStreams() {
      var out = {};
      for (var i = 0; i < STREAM_KINDS.length; i++) {
        var k = STREAM_KINDS[i];
        if (registry[k]) {
          out[k] = {
            stream: registry[k].stream,
            recorder: registry[k].recorder,
            segmentId: registry[k].segmentId,
            startedAtUtc: registry[k].startedAtUtc,
            startedAtMonotonicMs: registry[k].startedAtMonotonicMs
          };
        }
      }
      return out;
    }

    function getStreamRecord(streamKind) {
      var rec = registry[streamKind];
      return rec ? {
        stream: rec.stream,
        recorder: rec.recorder,
        segmentId: rec.segmentId,
        startedAtUtc: rec.startedAtUtc,
        startedAtMonotonicMs: rec.startedAtMonotonicMs
      } : null;
    }

    // 4.13 seam: remove one kind's registry entry after a clean Stop so
    // a later recorder-start-streams passes the already-started guard.
    // Additive (the getActiveStreams pattern). Validates the kind;
    // idempotent (unknown/absent kinds are a no-op, not an error).
    function discardActiveStream(streamKind) {
      if (STREAM_KINDS.indexOf(streamKind) === -1) {
        throw new RangeError('unknown streamKind: ' + streamKind);
      }
      if (registry[streamKind]) {
        delete registry[streamKind];
      }
    }

    function failResult(stage, err, forcedCode) {
      return {
        ok: false,
        error: forcedCode || errorCodeOf(err) || 'internal-error',
        errorName: errName(err),
        stage: stage
      };
    }

    function deviceIdOf(stream) {
      var tracks = [];
      try {
        tracks = (stream && typeof stream.getTracks === 'function') ?
          stream.getTracks() : [];
      } catch (e) { return null; }
      for (var i = 0; i < tracks.length; i++) {
        try {
          var s = (tracks[i] && typeof tracks[i].getSettings === 'function') ?
            tracks[i].getSettings() : null;
          if (s && typeof s.deviceId === 'string' && s.deviceId !== '') {
            return s.deviceId;
          }
        } catch (e) { /* keep looking */ }
      }
      return null;
    }

    function observeTracks(stream) {
      var audio = false;
      var video = false;
      var audioTrackCount = 0;
      var tracks = [];
      try {
        tracks = (stream && typeof stream.getTracks === 'function') ?
          stream.getTracks() : [];
      } catch (e) { tracks = []; }
      for (var i = 0; i < tracks.length; i++) {
        try {
          var kind = tracks[i] ? tracks[i].kind : null;
          if (kind === 'audio') { audio = true; audioTrackCount++; }
          if (kind === 'video') { video = true; }
        } catch (e) { /* ignore */ }
      }
      return {
        audioTrackPresent: audio,
        videoTrackPresent: video,
        audioTrackCount: audioTrackCount
      };
    }

    // Acquire one device stream (mic or camera). Returns
    // {stream, effectiveDeviceId, audioTrackPresent, videoTrackPresent}.
    // An actually-used-but-unselected device is recorded as
    // source:'default' through the selector (never 'user' — the 4.6
    // honesty rule); a recordDefault failure fails this stream honestly
    // rather than silently proceeding unrecorded.
    function acquireDeviceStream(which) {
      var isMic = (which === 'microphone');
      var selector = isMic ? micSelector : cameraSelector;
      var md = readMediaDevices();
      return Promise.resolve()
        .then(function () {
          if (!selector || typeof selector.getState !== 'function') {
            throw new Error('stream_starter: ' + which + ' selector is unavailable');
          }
          return selector.getState();
        })
        .then(function (st) {
          var selection = (st && typeof st.selection === 'string' && st.selection !== '') ?
            st.selection : null;
          var constraints = isMic ?
            (selection ? { audio: { deviceId: { exact: selection } } } : { audio: true }) :
            (selection ? { video: { deviceId: { exact: selection } } } : { video: true });
          return Promise.resolve(md.getUserMedia(constraints))
            .then(function (stream) {
              var presence = observeTracks(stream);
              var effectiveDeviceId = deviceIdOf(stream);
              if (selection) {
                return {
                  stream: stream,
                  effectiveDeviceId: selection,
                  audioTrackPresent: presence.audioTrackPresent,
                  videoTrackPresent: presence.videoTrackPresent,
                  audioTrackCount: presence.audioTrackCount
                };
              }
              // No selection: the system default was used. Record the
              // actually-used device as source:'default' (never 'user').
              if (effectiveDeviceId && typeof selector.recordDefault === 'function') {
                return Promise.resolve(selector.recordDefault(effectiveDeviceId))
                  .then(function () {
                    return {
                      stream: stream,
                      effectiveDeviceId: effectiveDeviceId,
                      audioTrackPresent: presence.audioTrackPresent,
                      videoTrackPresent: presence.videoTrackPresent,
                      audioTrackCount: presence.audioTrackCount
                    };
                  }, function (err) {
                    stopAllTracks(stream);
                    throw codedError('selection-record-failed',
                      'stream_starter: could not record the default ' + which);
                  });
              }
              return {
                stream: stream,
                effectiveDeviceId: effectiveDeviceId,
                audioTrackPresent: presence.audioTrackPresent,
                videoTrackPresent: presence.videoTrackPresent,
                audioTrackCount: presence.audioTrackCount
              };
            });
        });
    }

    // Acquire the screen/tab stream per the 4.3 capture mode.
    function acquireScreenStream() {
      var md = readMediaDevices();
      return Promise.resolve()
        .then(function () {
          if (!captureSelector || typeof captureSelector.getState !== 'function') {
            throw new Error('stream_starter: capture selector is unavailable');
          }
          return captureSelector.getState();
        })
        .then(function (st) {
          var mode = (st && typeof st.captureMode === 'string') ? st.captureMode : null;
          var p;
          if (mode === 'tab') {
            p = acquireTabStream(md);
          } else if (mode === 'screen') {
            p = acquireDisplayStream();
          } else {
            throw codedError('no-capture-mode',
              'stream_starter: no capture mode selected');
          }
          // 4.7 needs the capture mode at manifest-write time (the
          // screen-audio classification is mode-dependent).
          return p.then(function (acq) {
            acq.captureMode = mode;
            return acq;
          });
        });
    }

    function acquireTabStream(md) {
      if (!broker || typeof broker.resolveTargetTab !== 'function' ||
          typeof broker.getStreamId !== 'function') {
        throw new Error('stream_starter: the SW capture broker is unavailable');
      }
      return Promise.resolve()
        .then(function () { return broker.resolveTargetTab(); })
        .then(function (res) {
          if (!res || res.tabId === null || res.tabId === undefined) {
            throw codedError('no-target-tab',
              'stream_starter: no target tab for tab capture');
          }
          return broker.getStreamId(res.tabId);
        })
        .then(function (res) {
          if (!res || res.ok !== true || typeof res.streamId !== 'string' ||
              res.streamId === '') {
            var e = codedError('no-stream-id',
              'stream_starter: the SW broker refused the tab stream id');
            e.brokerError = res && res.error ? res.error : null;
            throw e;
          }
          var streamId = res.streamId;
          // Mirror the 4.3 probe constraints exactly (video + tab audio —
          // 4.7's feed). The streamId is single-use and never persisted.
          var constraints = {
            video: { mandatory: { chromeMediaSource: 'tab',
                                 chromeMediaSourceId: streamId } },
            audio: { mandatory: { chromeMediaSource: 'tab',
                                 chromeMediaSourceId: streamId } }
          };
          return Promise.resolve(md.getUserMedia(constraints));
        })
        .then(function (stream) {
          var presence = observeTracks(stream);
          return {
            stream: stream,
            effectiveDeviceId: null, // tab ids are unstable; never persisted (4.3)
            audioTrackPresent: presence.audioTrackPresent,
            videoTrackPresent: presence.videoTrackPresent,
            audioTrackCount: presence.audioTrackCount
          };
        });
    }

    function acquireDisplayStream() {
      var gdm;
      try {
        gdm = readGetDisplayMedia();
      } catch (e) {
        throw codedError('picker-unavailable',
          'stream_starter: getDisplayMedia is unavailable in this context');
      }
      return Promise.resolve()
        .then(function () { return gdm({ video: true, audio: true }); })
        .then(function (stream) {
          var presence = observeTracks(stream);
          return {
            stream: stream,
            effectiveDeviceId: null,
            audioTrackPresent: presence.audioTrackPresent,
            videoTrackPresent: presence.videoTrackPresent,
            audioTrackCount: presence.audioTrackCount
          };
        }, function (err) {
          // §6.2 honesty: a hidden offscreen document may lack the
          // transient activation the picker needs (Chrome reports
          // InvalidStateError). That is a documented limitation, not a
          // bug to work around — tab mode is the supported path. The
          // coded error keeps the ORIGINAL error name so the response
          // shape names the real failure ({errorName:'InvalidStateError'}).
          var code = (err && err.name === 'InvalidStateError') ?
            'picker-unavailable' : 'acquire-failed';
          var ce = codedError(code,
            'stream_starter: getDisplayMedia failed: ' + errName(err));
          ce.name = errName(err);
          throw ce;
        });
    }

    // One stream's full pipeline. Never rejects: every failure becomes
    // {ok:false, error, errorName, stage} data.
    function startOne(kind, acquire) {
      var result;
      try {
        result = runStartOne(kind, acquire);
      } catch (e) {
        result = Promise.resolve(failResult('verify-formats', e));
      }
      return Promise.resolve(result).then(null, function (e) {
        return failResult('internal', e);
      });
    }

    function runStartOne(kind, acquire) {
      var fs = requireFormatSupport();
      var formats;
      try {
        formats = fs.verifyFormats()[kind];
      } catch (e) {
        return Promise.resolve(failResult('verify-formats', e));
      }
      if (!formats || formats.length === 0) {
        return Promise.resolve({
          ok: false, error: 'no-supported-format', errorName: null,
          stage: 'verify-formats'
        });
      }
      var requestedMimeType = formats[0];
      return Promise.resolve()
        .then(function () { return acquire(); })
        .then(function (acq) {
          var MediaRecorderNs;
          try {
            MediaRecorderNs = readMediaRecorder();
          } catch (e) {
            stopAllTracks(acq.stream);
            return failResult('construct-recorder', e);
          }
          var recorder;
          try {
            recorder = new MediaRecorderNs(acq.stream,
              { mimeType: requestedMimeType });
          } catch (e) {
            stopAllTracks(acq.stream);
            return failResult('construct-recorder', e);
          }
          // The REAL negotiated MIME type (4.5's V2 deferred this proof
          // to 4.6): read from the instance, never from the request.
          var actualMimeType = null;
          try {
            actualMimeType = (typeof recorder.mimeType === 'string' &&
              recorder.mimeType !== '') ? recorder.mimeType : null;
          } catch (e) { actualMimeType = null; }
          var startedAtUtc;
          var startedAtMonotonicMs;
          try {
            // No timeslice; ondataavailable deliberately unset — 4.8
            // owns chunk extraction.
            recorder.start();
            startedAtUtc = nowUtcIso();
            startedAtMonotonicMs = perfNowMs();
          } catch (e) {
            stopAllTracks(acq.stream);
            return failResult('start-recorder', e);
          }
          var segmentId;
          try {
            segmentId = newUuidV4();
          } catch (e) {
            try { recorder.stop(); } catch (w) { /* ignore */ }
            stopAllTracks(acq.stream);
            return failResult('write-manifest', e);
          }
          // 4.7: classify what this stream's audio CAN contain, from the
          // real acquisition observations (capture mode + track
          // presence). Never content analysis; never fails the stream.
          var audioClass = classifyStreamAudio(kind, acq);
          // 4.10: link this recording segment to the active
          // recording-context clock segment. Identity-only (no time
          // arithmetic); null when the anchor cannot be captured —
          // linking never fails the stream.
          var clockSegmentId = linkStreamClock(segmentId);
          var record = {
            segmentId: segmentId,
            sessionId: getSessionId(),
            gameId: getGameId(),
            streamKind: kind,
            requestedMimeType: requestedMimeType,
            actualMimeType: actualMimeType,
            streamStartedAtUtc: startedAtUtc,
            streamStartedAtMonotonicMs: startedAtMonotonicMs,
            effectiveDeviceId: acq.effectiveDeviceId,
            audioTrackPresent: acq.audioTrackPresent,
            videoTrackPresent: acq.videoTrackPresent,
            // 4.7: audio-content policy classification (by construction,
            // never content analysis). Pure — cannot fail the stream.
            screenAudioContent: audioClass.screenAudioContent,
            micAudioContent: audioClass.micAudioContent,
            // 4.10: the recording-context clock segment this recording
            // segment is linked to (identity-only).
            clockSegmentId: clockSegmentId
          };
          return Promise.resolve()
            .then(function () { return fs.recordSegmentFormat(record); })
            .then(function (wr) {
              if (!wr || wr.ok !== true) {
                // A live recorder with no manifest record is worse than
                // no recorder: stop everything, report honestly.
                try { recorder.stop(); } catch (w) { /* ignore */ }
                stopAllTracks(acq.stream);
                return {
                  ok: false,
                  error: (wr && typeof wr.error === 'string') ?
                    wr.error : 'manifest-write-failed',
                  errorName: null,
                  stage: 'write-manifest'
                };
              }
              registry[kind] = {
                stream: acq.stream,
                recorder: recorder,
                segmentId: segmentId,
                startedAtUtc: startedAtUtc,
                startedAtMonotonicMs: startedAtMonotonicMs
              };
              return {
                ok: true,
                segmentId: segmentId,
                streamStartedAtUtc: startedAtUtc,
                streamStartedAtMonotonicMs: startedAtMonotonicMs,
                requestedMimeType: requestedMimeType,
                actualMimeType: actualMimeType,
                fileExtension: wr.fileExtension,
                audioTrackPresent: acq.audioTrackPresent,
                videoTrackPresent: acq.videoTrackPresent,
                // 4.7: the audio-content classifications ride the
                // response (no new event types, no new channel).
                screenAudioContent: audioClass.screenAudioContent,
                micAudioContent: audioClass.micAudioContent,
                // 4.10: the clock link rides the response alongside
                // the record (4.6/4.7 precedent).
                clockSegmentId: clockSegmentId
              };
            }, function (err) {
              try { recorder.stop(); } catch (w) { /* ignore */ }
              stopAllTracks(acq.stream);
              return failResult('write-manifest', err);
            });
        }, function (err) {
          // acquire() stops its own partial tracks before throwing.
          return failResult('acquire-stream', err);
        });
    }

    // Start all three streams. Each runs its own pipeline; failures are
    // per-stream and never block the others.
    function startStreams() {
      var sid = getSessionId();
      var gid = getGameId();
      if (!sid || !gid) {
        return Promise.resolve({ ok: false, error: 'no-session' });
      }
      if (startInFlight) {
        return Promise.resolve({ ok: false, error: 'start-in-progress' });
      }
      if (Object.keys(registry).length > 0) {
        return Promise.resolve({ ok: false, error: 'already-started' });
      }
      startInFlight = true;
      return Promise.all([
        startOne('microphone', function () { return acquireDeviceStream('microphone'); }),
        startOne('screen', acquireScreenStream),
        startOne('webcam', function () { return acquireDeviceStream('webcam'); })
      ]).then(function (results) {
        startInFlight = false;
        var streams = {
          microphone: results[0],
          screen: results[1],
          webcam: results[2]
        };
        return {
          ok: !!(results[0].ok && results[1].ok && results[2].ok),
          streams: streams
        };
      }, function (err) {
        // startOne never rejects (defensive): a rejection here is a
        // genuine internal fault.
        startInFlight = false;
        return { ok: false, error: 'internal-error', errorName: errName(err) };
      });
    }

    return {
      startStreams: startStreams,
      getActiveStreams: getActiveStreams,
      getStreamRecord: getStreamRecord,
      discardActiveStream: discardActiveStream,
      // 4.8/4.9/4.13 seam introspection (Node tests drive these).
      _isStartInFlight: function () { return startInFlight; }
    };
  }

  BlindfoldSession.STREAM_STARTER_KINDS = STREAM_KINDS;
  BlindfoldSession.STREAM_STARTER_STAGES = STAGES;
  BlindfoldSession.createStreamStarter = createStreamStarter;
})();

// Node test shim. The offscreen document loads this via <script>; only
// environments that provide CommonJS get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
