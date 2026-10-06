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
//   - 4.2–4.14: device selection, formats, streams, chunks, sync marker,
//     timecode, Stop finalization, per-stream status (recording_host.js
//     owns the offscreen document lifecycle only)
// Do not add other message listeners, storage access, or other imports here
// until the owning task's contract says so.
'use strict';

importScripts('db.js', 'event_envelope.js', 'writer.js', 'session_identity.js', 'session_conditions.js', 'session_store.js', 'lifecycle.js', 'recording_host.js');
// The handle exists so tests can remove the listener to simulate a genuine
// no-ack state. Production code must NEVER remove the writer's listener
// (a worker restart recreates the whole JS context and re-installs anyway).
BlindfoldSession.writerListener = BlindfoldSession.installWriterListener();

// Task 4.1: supervise the dedicated recording context (MV3 offscreen
// document). start() installs the recorder-channel listener and ensures the
// document lazily; it never throws at startup.
BlindfoldSession.recordingHost = BlindfoldSession.createRecordingHost(globalThis.chrome || {});
BlindfoldSession.recordingHost.start();
