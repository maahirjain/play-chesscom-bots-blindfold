// audio_policy.js
//
// Task 4.7 (PLAN.md §4.7): audio-content policy for the recording
// streams. "Capture game/extension audio with the screen where
// supported, keeping it out of the microphone stream's intentional mix;
// document device-specific limitations and possible acoustic bleed."
//
// 4.7 is a POLICY layer, not an acquisition layer: 4.6 already acquires
// the screen stream's audio wherever the platform offers it (tab-mode
// requests tab audio via the SW broker; screen mode requests
// {audio:true} via getDisplayMedia). This module classifies, honestly
// and by construction, what the screen stream's audio track CAN
// contain given the capture mode, and asserts structurally that the
// microphone stream contains only what the mic device captured (no
// intentional mix of game/extension audio). The classification is
// written into the manifest record by 4.6's stream starter at stream
// start (the same write stage); classification can never fail a stream
// (malformed input → null, recorded honestly).
//
// What 4.7 can and cannot claim (the sharp honest line):
//   - CAN: whether the screen stream has an audio track + the capture
//     mode → by-construction classification ('tab-audio' |
//     'system-audio' | 'none'). The mic recorder has exactly the mic
//     device's audio track(s) — structural, V1-pinned by code scan.
//   - CANNOT: which sounds were actually captured. That would require
//     audio content analysis, which the mission's raw-collection rule
//     forbids. No AnalyserNode, no level metering, no VAD, and no claim
//     that any particular spoken announcement ended up audible in a
//     recording — anywhere.
// By-construction platform facts (documented, not measured):
//   - tab audio is the tab's rendered audio only — it CANNOT contain
//     system audio or extension speech output.
//   - screen-mode system audio MAY contain game sounds AND extension
//     speech output, IFF the user ticked "Share system audio" in the
//     picker. That checkbox is outside our observation boundary.
//   - speechSynthesis (3.4) renders through the platform TTS engine to
//     the system audio output — it does not travel through any tab's
//     audio pipeline, so tab-mode capture cannot contain announcements.
//   - Acoustic bleed (the mic transducing speaker output) is a physical
//     reality, not a defect: no software suppression is attempted. If
//     the owner's selected "mic" device is itself a loopback /
//     stereo-mix / virtual-cable device, the mic stream may contain
//     game/extension audio by DEVICE CONFIGURATION, not by our mixing —
//     traceable via effectiveDeviceId (4.6), never second-guessed here.
//
// No new event types; no new channel message; no new permissions; no
// Web Audio graph anywhere (AudioContext and friends are forbidden in
// the offscreen scripts — code-scan-pinned).
//
// Dependency-free classic script → guarded BlindfoldSession global → IIFE
// 'use strict' → Node module.exports shim (repo house convention).
//
// Error conventions (AGENTS.md): TypeError = wrong type/shape;
// RangeError = bad domain value; plain Error = unavailable platform
// capability (never a weak fallback). Pure functions — no platform
// capability is involved, so no plain Error is thrown.

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Constants.
  // ------------------------------------------------------------------

  // Screen-audio classification vocabulary. 'system-audio' is a
  // POSSIBILITY classification (the mode permits system audio and a
  // track exists), never a content claim.
  var SCREEN_AUDIO_CONTENTS = [
    'tab-audio',
    'system-audio',
    'none'
  ];

  // Mic-audio classification vocabulary. A single value: the mic
  // recorder's audio is exactly what the mic device captured.
  var MIC_AUDIO_CONTENTS = [
    'device-only'
  ];

  // Capture modes 4.3 defines. Any other string is unknown — never
  // guessed (classifyScreenAudio returns null).
  var CAPTURE_MODES = ['tab', 'screen'];

  function freezeConstants() {
    Object.freeze(SCREEN_AUDIO_CONTENTS);
    Object.freeze(MIC_AUDIO_CONTENTS);
    Object.freeze(CAPTURE_MODES);
  }
  freezeConstants();

  // ------------------------------------------------------------------
  // Private helpers.
  // ------------------------------------------------------------------

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function requireInputObject(input, fnName) {
    if (!isPlainObject(input)) {
      throw new TypeError(fnName + ': input must be a plain object');
    }
  }

  function requireBoolean(v, name, fnName) {
    if (typeof v !== 'boolean') {
      throw new TypeError(fnName + ': ' + name + ' must be a boolean');
    }
  }

  // ------------------------------------------------------------------
  // createAudioPolicy.
  //
  // Returns {classifyScreenAudio, assertMicAudio}. Pure functions —
  // no media APIs, no DOM, fully unit-testable in Node.
  // ------------------------------------------------------------------

  function createAudioPolicy() {

    // classifyScreenAudio({captureMode, audioTrackPresent}) →
    // 'tab-audio' | 'system-audio' | 'none' | null.
    //
    // By-construction truth table (contract §1.1):
    //   tab    + track → 'tab-audio'    (tab audio only — system/
    //                                     extension audio excluded by
    //                                     platform construction)
    //   screen + track → 'system-audio' (whatever the OS mixer delivers
    //                                     — MAY include game sounds and
    //                                     extension speech IFF the user
    //                                     shared system audio)
    //   either + no track → 'none'      (video-only capture)
    //   unknown/malformed mode + track → null (never a guess)
    //
    // null means "classification not possible," never a guess.
    function classifyScreenAudio(input) {
      requireInputObject(input, 'classifyScreenAudio');
      requireBoolean(input.audioTrackPresent, 'audioTrackPresent',
        'classifyScreenAudio');
      var mode = input.captureMode;
      if (mode === undefined || mode === null) {
        // No track → 'none' regardless of mode; a present track with an
        // unrecorded mode is unclassifiable — null, never guessed.
        return input.audioTrackPresent ? null : 'none';
      }
      if (typeof mode !== 'string') {
        throw new TypeError(
          'classifyScreenAudio: captureMode must be a string or null');
      }
      if (!input.audioTrackPresent) {
        return 'none';
      }
      if (mode === 'tab') {
        return 'tab-audio';
      }
      if (mode === 'screen') {
        return 'system-audio';
      }
      // Unknown mode with a track present: honest null, not a guess.
      return null;
    }

    // assertMicAudio({audioTrackPresent, audioTrackCount}) →
    // 'device-only' | null.
    //
    // 'device-only' iff an audio track is present from the device
    // acquisition. The policy module adds no tracks and 4.6 wires no
    // mixer (no AudioContext, no track merging — V1 code-scan-pinned),
    // so "device-only" is structural: every audio track on the mic
    // stream originates from the mic device. null when no audio track
    // is present (nothing to assert about).
    //
    // audioTrackCount is a sanity observation from 4.6's observeTracks;
    // it must be a non-negative integer when provided. It does not
    // change the outcome — one track or many, all are device tracks.
    function assertMicAudio(input) {
      requireInputObject(input, 'assertMicAudio');
      requireBoolean(input.audioTrackPresent, 'audioTrackPresent',
        'assertMicAudio');
      if (input.audioTrackCount !== undefined &&
          input.audioTrackCount !== null) {
        if (typeof input.audioTrackCount !== 'number' ||
            Math.floor(input.audioTrackCount) !== input.audioTrackCount) {
          throw new TypeError(
            'assertMicAudio: audioTrackCount must be an integer or null');
        }
        if (input.audioTrackCount < 0) {
          throw new RangeError(
            'assertMicAudio: audioTrackCount must be non-negative');
        }
      }
      if (!input.audioTrackPresent) {
        return null;
      }
      return 'device-only';
    }

    return {
      classifyScreenAudio: classifyScreenAudio,
      assertMicAudio: assertMicAudio
    };
  }

  // Validators for the manifest record fields (format_support.js calls
  // these shapes). Kept here so the vocabulary lives with the policy.

  function requireScreenAudioContent(v, name) {
    if (v === null || v === undefined) {
      return null;
    }
    if (typeof v !== 'string' ||
        SCREEN_AUDIO_CONTENTS.indexOf(v) === -1) {
      throw new RangeError(name + ' must be one of: ' +
        SCREEN_AUDIO_CONTENTS.join(', ') + ' or null');
    }
    return v;
  }

  function requireMicAudioContent(v, name) {
    if (v === null || v === undefined) {
      return null;
    }
    if (typeof v !== 'string' ||
        MIC_AUDIO_CONTENTS.indexOf(v) === -1) {
      throw new RangeError(name + ' must be one of: ' +
        MIC_AUDIO_CONTENTS.join(', ') + ' or null');
    }
    return v;
  }

  BlindfoldSession.SCREEN_AUDIO_CONTENTS = SCREEN_AUDIO_CONTENTS;
  BlindfoldSession.MIC_AUDIO_CONTENTS = MIC_AUDIO_CONTENTS;
  BlindfoldSession.createAudioPolicy = createAudioPolicy;
  BlindfoldSession.requireScreenAudioContent = requireScreenAudioContent;
  BlindfoldSession.requireMicAudioContent = requireMicAudioContent;
})();

// Node test shim. The offscreen document loads this via <script>; only
// environments that provide CommonJS get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
