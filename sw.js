// sw.js — extension service worker.
//
// Registration entry point for the manifest's "background.service_worker".
// Loads the storage layer (db.js, task 2.2), the event contract
// (event_envelope.js, task 1.3) for intake validation, the
// transactional event writer (writer.js, task 2.4), the session-state
// storage primitives (session_identity.js + session_conditions.js for
// record validation, session_store.js, task 2.6), the page/context
// lifecycle detector (lifecycle.js, task 2.7 — SW-side discontinuity
// detection via the writer's post-commit hook), and the recording-context
// supervisor (recording_host.js, task 4.1 — MV3 offscreen document for
// synchronized session recording). Intentionally contains
// NO other behavior: no retry, no lifecycle emission, no status UI, no
// retention logic, no media capture.
//
// Intentionally absent (owned by later PLAN.md tasks):
//   - 2.3: content-script event sender (content-script only; never loaded here)
//   - 2.5: retry of unacknowledged events
//   - 2.8: write-failure / storage-capacity surfacing in the status indicator
//   - 2.9: retention and export semantics
//   - 4.4–4.14: webcam selection, formats, streams, chunks, sync marker,
//     timecode, Stop finalization, per-stream status (capture_broker.js /
//     recording_host.js own the 4.3 SW-side capture broker only)
//   - 6.6: export orchestration (exporter.js) + the export-request channel
// Do not add other message listeners, storage access, or other imports here
// until the owning task's contract says so.
'use strict';

importScripts('db.js', 'event_envelope.js', 'writer.js', 'session_identity.js', 'session_conditions.js', 'session_store.js', 'lifecycle.js', 'capture_broker.js', 'recording_host.js', 'exporter.js');
// The handle exists so tests can remove the listener to simulate a genuine
// no-ack state. Production code must NEVER remove the writer's listener
// (a worker restart recreates the whole JS context and re-installs anyway).
BlindfoldSession.writerListener = BlindfoldSession.installWriterListener();

// Task 4.1: supervise the dedicated recording context (MV3 offscreen
// document). start() installs the recorder-channel listener and ensures the
// document lazily; it never throws at startup.
BlindfoldSession.recordingHost = BlindfoldSession.createRecordingHost(globalThis.chrome || {});
BlindfoldSession.recordingHost.start();

// Task 6.6: export-request channel (SW-side, kind:'export'). This is the
// FIRST chrome.runtime.onMessage listener in sw.js. It handles ONLY the
// export envelope and ignores everything else (return false) so the
// recorder channel (kind:'recorder', owned by recording_host.js) is
// unaffected. The offscreen MSG_* vocabulary is untouched.
(function installExportListener() {
  var chromeNs = globalThis.chrome || {};
  if (!chromeNs.runtime || typeof chromeNs.runtime.onMessage === 'undefined' ||
      typeof chromeNs.runtime.onMessage.addListener !== 'function') {
    return; // non-extension test context; exportSession is tested directly.
  }
  chromeNs.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg === null || typeof msg !== 'object' || msg.kind !== 'export' ||
        msg.msg !== 'export-request') {
      return false; // not ours; do not interfere.
    }
    var exportFn = BlindfoldSession.exportSession;
    if (typeof exportFn !== 'function') {
      sendResponse({ ok: false, error: 'export-unavailable' });
      return false;
    }
    var deps = {
      db: BlindfoldSession.DB,
      downloads: chromeNs.downloads,
      createObjectURL: (typeof URL !== 'undefined' &&
        typeof URL.createObjectURL === 'function') ?
        URL.createObjectURL.bind(URL) : undefined,
      revokeObjectURL: (typeof URL !== 'undefined' &&
        typeof URL.revokeObjectURL === 'function') ?
        URL.revokeObjectURL.bind(URL) : undefined
    };
    Promise.resolve().then(function () {
      return exportFn({
        sessionId: msg.sessionId,
        stopVerdict: msg.stopVerdict,
        deps: deps
      });
    }).then(function (result) {
      sendResponse(result);
    }, function (err) {
      // exportSession only rejects on TypeError (malformed input);
      // map to an honest error response, never a dropped message.
      sendResponse({
        ok: false,
        error: 'export-failed:' + (err && err.message ? err.message : String(err))
      });
    });
    return true; // async sendResponse.
  });
})();
