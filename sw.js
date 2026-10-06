// sw.js — extension service worker.
//
// Registration entry point for the manifest's "background.service_worker".
// Loads the storage layer (db.js, task 2.2). Intentionally contains NO
// other behavior: no message listeners, no event writing, no retry, no
// restore, no lifecycle emission, no status UI, no retention logic.
//
// Intentionally absent (owned by later PLAN.md tasks):
//   - 2.3: content-script event sender / message intake
//   - 2.4: transactional event writer, dedup by event ID, write acks
//   - 2.5: retry of unacknowledged events
//   - 2.6: restore session metadata and sequence state after worker restart
//   - 2.7: page/context start and clean-end events, unclean-discontinuity marking
//   - 2.8: write-failure / storage-capacity surfacing in the status indicator
//   - 2.9: retention and export semantics
// Do not add message listeners, storage access, or other imports here until
// the owning task's contract says so.
'use strict';

importScripts('db.js');
