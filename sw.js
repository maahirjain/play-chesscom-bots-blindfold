// sw.js — extension service worker.
//
// Registration entry point for the manifest's "background.service_worker".
// Loads the storage layer (db.js, task 2.2), the event contract
// (event_envelope.js, task 1.3) for intake validation, the
// transactional event writer (writer.js, task 2.4), and the session-state
// storage primitives (session_identity.js + session_conditions.js for
// record validation, session_store.js, task 2.6). Intentionally contains
// NO other behavior: no retry, no lifecycle emission, no status UI, no
// retention logic.
//
// Intentionally absent (owned by later PLAN.md tasks):
//   - 2.3: content-script event sender (content-script only; never loaded here)
//   - 2.5: retry of unacknowledged events
//   - 2.7: page/context start and clean-end events, unclean-discontinuity marking
//   - 2.8: write-failure / storage-capacity surfacing in the status indicator
//   - 2.9: retention and export semantics
// Do not add other message listeners, storage access, or other imports here
// until the owning task's contract says so.
'use strict';

importScripts('db.js', 'event_envelope.js', 'writer.js', 'session_identity.js', 'session_conditions.js', 'session_store.js');
// The handle exists so tests can remove the listener to simulate a genuine
// no-ack state. Production code must NEVER remove the writer's listener
// (a worker restart recreates the whole JS context and re-installs anyway).
BlindfoldSession.writerListener = BlindfoldSession.installWriterListener();
