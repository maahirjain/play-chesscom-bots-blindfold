// sw.js — extension service worker (task 2.1: registration stub).
//
// This file exists so the manifest's "background.service_worker" entry
// points at a real file. It intentionally does NOTHING yet. Chrome
// registers an empty service worker without error; it activates and
// goes idle.
//
// Intentionally absent (owned by later PLAN.md tasks):
//   - 2.2: IndexedDB database for metadata, events, and media chunks
//   - 2.3: content-script event sender / message intake
//   - 2.4: transactional event writer, dedup by event ID, write acks
//   - 2.5: retry of unacknowledged events
//   - 2.6: restore session metadata and sequence state after worker restart
//   - 2.7: page/context start and clean-end events, unclean-discontinuity marking
//   - 2.8: write-failure / storage-capacity surfacing in the status indicator
//   - 2.9: retention and export semantics
// Do not add message listeners, storage access, or imports here until the
// owning task's contract says so.
'use strict';
