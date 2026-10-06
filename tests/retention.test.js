// tests/retention.test.js
//
// Task 2.9 (PLAN.md §2.9): "Keep saved records until deliberate deletion;
// export must not delete the originals."
//
// V1 — static. Covers 2.9.contract.md AC1–AC4 (AC5 is the V2 harness
// re-run of sw-restart.js; AC6 is V3-deferred to §7).
//
// This task adds NO product code. The acceptance criteria are negative:
// no deletion path exists in product code, closeDatabase() is
// connection-only, the schema carries no retention metadata, and the
// diff shows no product file modified. The "export must not delete the
// originals" half is a binding architectural constraint on §6 (recorded
// in 2.9.contract.md and DECISIONS.md), since no export code exists yet
// to test.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// The product files the retention guarantee covers, DERIVED at test time
// from the extension's actual load surface (2.9 review SF-1): every script
// the manifest loads into content-script worlds plus every script sw.js
// importScripts into the worker, plus sw.js itself. chess.min.js is
// vendored third-party code (never hand-edited) and is excluded; test
// files and .autodev are not product code. Deriving (not hand-listing)
// means a future task that adds a loaded script cannot silently escape
// the scan.
const VENDORED = new Set(['chess.min.js']);
function loadedProductFiles() {
  const files = new Set(['sw.js']);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  for (const cs of manifest.content_scripts || []) {
    for (const f of cs.js || []) {
      if (!VENDORED.has(f)) files.add(f);
    }
  }
  const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const m = swSrc.match(/importScripts\(([^)]*)\)/);
  if (m) {
    for (const part of m[1].split(',')) {
      const f = part.trim().replace(/^['"]|['"]$/g, '');
      if (f && !VENDORED.has(f)) files.add(f);
    }
  }
  return [...files].sort();
}
const PRODUCT_FILES = loadedProductFiles();

// Strip line and block comments before scanning: the assertion is that no
// deletion CODE exists. A comment that mentions deletion (e.g. db.js's
// "Never delete user data in a schema upgrade (§2.9)") is the opposite of
// a deletion primitive and must not trip the scan. Verified safe: no
// product file contains `//` inside a string literal except `https://`
// URLs, which the [^:] guard protects.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function readStripped(file) {
  return stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

// Split source into identifier tokens: [A-Za-z_$][A-Za-z0-9_$]*.
// Whole-token matching means `settled` never false-positives on `ttl`.
function identifiers(src) {
  const out = [];
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[0]);
  return out;
}

// ------------------------------------------------------------------
// AC1: no deletion primitives in product code.
// ------------------------------------------------------------------
describe('AC1 — no auto-deletion exists', () => {
  it('scan covers the full load surface (meta-assertion)', () => {
    // If the derivation above ever silently misses a loaded script, this
    // fails loudly. The expected set is the union of manifest content-script
    // js + sw.js importScripts + sw.js itself, minus vendored chess.min.js.
    // (4.1 adds recording_host.js to the SW importScripts line per its
    // contract; 4.3 adds capture_broker.js per its contract;
    // recorder.js/recorder.html/device_selection.js/capture_selection.js
    // are the offscreen document, not SW-loaded, so they are outside the
    // retention-scan surface by design.)
    // Honest cumulative evolution: 4.11 appends sync_flash.js to the
    // manifest content_scripts js list per its contract (the visible
    // sync-marker flash) — it joins the load surface and the scan.
    // Honest cumulative evolution: 5.1 adds session_controls.js to the
    // manifest content_scripts js list per its contract (the in-page
    // Start/Stop + per-stream lights) — it joins the load surface and
    // the scan. (session_identity.js was already listed.)
    // Honest cumulative evolution: 5.2 adds session_fields.js to the
    // manifest content_scripts js list per its contract (the
    // baseline/training/evaluation selection fields) — it joins the
    // load surface and the scan.
    // Honest cumulative evolution: 5.3 adds selection_memory.js to the
    // manifest content_scripts js list per its contract (the
    // chrome.storage.local-backed remembered-defaults module) — it
    // joins the load surface and the scan.
    // Honest cumulative evolution: 5.4 adds detected_conditions.js to
    // the manifest content_scripts js list per its contract (the 5.4
    // detected-conditions panel) — it joins the load surface and the
    // scan.
    // Honest cumulative evolution: 6.1 adds exporter.js (the SW-side
    // export bundle builders) to sw.js importScripts per its contract —
    // it joins the load surface and the scan.
    assert.deepEqual(PRODUCT_FILES, [
      'capture_broker.js',
      'chess_utils.js',
      'content.js',
      'db.js',
      'detected_conditions.js',
      'event_envelope.js',
      'exporter.js',
      'game_records.js',
      'lifecycle.js',
      'recording_host.js',
      'selection_memory.js',
      'sender.js',
      'session_conditions.js',
      'session_controls.js',
      'session_fields.js',
      'session_identity.js',
      'session_store.js',
      'sounds.js',
      'status_indicator.js',
      'sw.js',
      'sync_flash.js',
      'writer.js',
    ]);
  });

  it('no deleteDatabase / clear() / delete() calls in product code', () => {
    const hits = [];
    for (const f of PRODUCT_FILES) {
      const src = readStripped(f);
      if (/\bdeleteDatabase\b/.test(src)) hits.push(`${f}: deleteDatabase`);
      // Method-call syntax only (dot + paren): the `delete` operator is a
      // different token and is not an IndexedDB deletion primitive.
      if (/\.clear\s*\(/.test(src)) hits.push(`${f}: .clear(`);
      if (/\.delete\s*\(/.test(src)) hits.push(`${f}: .delete(`);
    }
    assert.deepEqual(hits, [], `deletion primitives found: ${hits.join(', ')}`);
  });

  it('no TTL / expiry / prune tokens in product code', () => {
    const hits = [];
    for (const f of PRODUCT_FILES) {
      const tokens = new Set(identifiers(readStripped(f)));
      // Whole-token, case-sensitive: `settled` (db.js, writer.js,
      // sender.js) contains `ttl` as a substring but is a distinct token
      // and must not trip the scan — this assertion pins that.
      if (tokens.has('ttl') || tokens.has('TTL')) hits.push(`${f}: ttl/TTL`);
      for (const t of tokens) {
        // Case-sensitive per contract: lowercase `expir*` stems and the
        // exact `prune` token.
        if (t.startsWith('expir')) hits.push(`${f}: ${t}`);
        if (t === 'prune') hits.push(`${f}: ${t}`);
      }
    }
    assert.deepEqual(hits, [], `retention tokens found: ${hits.join(', ')}`);
  });

  it('the scan itself is sound: `settled` does not false-positive', () => {
    // Guard the guard: db.js, writer.js and sender.js all use a `settled`
    // flag. If the tokenizer ever regressed to substring matching, this
    // fails loudly instead of silently weakening AC1.
    const tokens = new Set(identifiers(readStripped('db.js')));
    assert.ok(tokens.has('settled'), 'db.js must still use the settled flag');
    assert.ok(!tokens.has('ttl'), 'settled must not tokenize as ttl');
  });
});

// ------------------------------------------------------------------
// AC2: closeDatabase() is connection-only.
// ------------------------------------------------------------------
describe('AC2 — close is not delete', () => {
  function closeSource() {
    const src = readStripped('db.js');
    const m = src.match(/function closeDatabase\(\)\s*\{[\s\S]*?\n  \}/);
    assert.ok(m, 'closeDatabase function body must be extractable');
    return m[0];
  }

  it('closeDatabase closes the cached handle and nulls it; no IDB writes', () => {
    const body = closeSource();
    assert.ok(body.includes('.close()'), 'must close the cached handle');
    assert.ok(body.includes('= null'), 'must null the cached handle');
    assert.ok(!/\.put\s*\(/.test(body), 'must not put');
    assert.ok(!/\.delete\s*\(/.test(body), 'must not delete');
    assert.ok(!/\.clear\s*\(/.test(body), 'must not clear');
    assert.ok(!/deleteDatabase/.test(body), 'must not deleteDatabase');
    assert.ok(!/transaction\s*\(/.test(body), 'must not open a transaction');
  });

  it('closeDatabase is callable with no indexedDB (pure connection teardown)', () => {
    // closeDatabase must not call requireAvailableIDB: closing a
    // never-opened or already-closed handle is a safe no-op. If it ever
    // required the platform, this throws in Node (no globalThis.indexedDB).
    delete globalThis.indexedDB;
    const DB = require('../db.js').DB;
    assert.doesNotThrow(() => DB.closeDatabase(), 'close on empty cache');
    assert.doesNotThrow(() => DB.closeDatabase(), 'close is idempotent');
  });
});

// ------------------------------------------------------------------
// AC3: schema carries no retention metadata.
// ------------------------------------------------------------------
describe('AC3 — no retention metadata in the schema', () => {
  function schemaKeys(obj, prefix, out) {
    if (obj === null || typeof obj !== 'object') return out;
    for (const k of Object.keys(obj)) {
      out.push(prefix + k);
      schemaKeys(obj[k], prefix + k + '.', out);
    }
    return out;
  }

  it('exactly the six stores (2.2 + 4.5 manifest); no store carries TTL/expiry keys', () => {
    // Honest cumulative evolution: 4.5 (PLAN.md §4.5) legitimately adds
    // the recording_manifest store (mutable by design — format identity
    // at stream start, clock anchor/timecode/finalization later). It
    // carries no TTL/expiry keys; retention semantics unchanged (§2.9).
    const SCHEMA = require('../db.js').DB.SCHEMA;
    const names = SCHEMA.stores.map((s) => s.name).sort();
    assert.deepEqual(names, [
      'conditions',
      'events',
      'media_chunks',
      'recording_manifest',
      'sequence_state',
      'session_metadata',
    ]);
    const keys = schemaKeys(SCHEMA, '', []);
    const bad = keys.filter((k) =>
      /(^|\.)(ttl|expiresAt|expires|expiry|retention)([^A-Za-z]|$)/i.test(k));
    assert.deepEqual(bad, [], `retention keys in schema: ${bad.join(', ')}`);
  });
});

// ------------------------------------------------------------------
// AC4: diff discipline — this task modifies no product file.
// ------------------------------------------------------------------
describe('AC4 — diff discipline', () => {
  it('no other repo files modified (git status allowlist)', () => {
    const status = execSync('git status --porcelain', { cwd: ROOT }).toString();
    const changed = status.split('\n').filter((l) => l.trim()).map((l) => l.slice(3).trim());
    const allowed = new Set([
      // Honest cumulative evolution: 4.1 (dedicated recording context)
      // legitimately adds recorder.html/recorder.js/recording_host.js,
      // the "offscreen" manifest permission, and the sw.js supervisor
      // wiring; its files join the allowlists.
      'recorder.html',
      'recorder.js',
      'recording_host.js',
      'manifest.json',
      'sw.js',
      'tests/recording_host.test.js',
      'tests/manifest_sw.test.js',
      '.autodev/evidence/4.1.contract.md',
      '.autodev/evidence/4.1.build.md',
      // Honest cumulative evolution: 4.1's review/behavior
      // evidence lands after the pins were evolved (2.x/3.x precedent).
      '.autodev/evidence/4.1.review.md',
      '.autodev/evidence/4.1.behavior.md',
      // Honest cumulative evolution: 4.2 (microphone selection and
      // permission handling) legitimately adds device_selection.js, routes
      // the five mic commands through recorder.js/recorder.html, and adds
      // its test + evidence; its files join the allowlists.
      'device_selection.js',
      'tests/device_selection.test.js',
      '.autodev/evidence/4.2.contract.md',
      '.autodev/evidence/4.2.build.md',
      // Honest cumulative evolution: 4.2's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1 precedent).
      '.autodev/evidence/4.2.review.md',
      '.autodev/evidence/4.2.behavior.md',
      // Honest cumulative evolution: 4.3 (screen/tab capture selection
      // and permission handling) legitimately adds capture_selection.js
      // (offscreen side) + capture_broker.js (SW side), routes the four
      // capture commands plus the three SW-leg broker messages, adds the
      // tabCapture permission + host_permissions, and adds its tests +
      // evidence; its files join the allowlists.
      'capture_selection.js',
      'capture_broker.js',
      'tests/capture_selection.test.js',
      'tests/capture_broker.test.js',
      'tests/manifest_sw.test.js',
      '.autodev/evidence/4.3.contract.md',
      '.autodev/evidence/4.3.build.md',
      // Honest cumulative evolution: 4.4 (webcam selection and
      // permission handling) modifies device_selection.js (video
      // probe kind-branch + validator messages) and recorder.js
      // (camera selector + cam-* channel), and repairs
      // restoreDevices() to await all selector restores.
      '.autodev/evidence/4.4.contract.md',
      '.autodev/evidence/4.4.build.md',
      // Honest cumulative evolution: 4.4's review/behavior
      // evidence lands after the pins were evolved (2.x/3.x/4.1-4.3 precedent).
      '.autodev/evidence/4.4.review.md',
      '.autodev/evidence/4.4.behavior.md',
      // Honest cumulative evolution: 4.5 (recording format
      // verification + recording manifest) legitimately adds
      // format_support.js, routes recorder-get-formats through
      // recorder.js/recorder.html (which now also load db.js),
      // bumps db.js to version 2 with the recording_manifest
      // store, and adds its test + evidence; its files join
      // the allowlists.
      'format_support.js',
      'db.js',
      'tests/format_support.test.js',
      '.autodev/evidence/4.5.contract.md',
      '.autodev/evidence/4.5.build.md',
      // Honest cumulative evolution: 4.5's review/behavior
      // evidence lands after the pins were evolved (2.x/3.x/4.1-4.4 precedent).
      '.autodev/evidence/4.5.review.md',
      '.autodev/evidence/4.5.behavior.md',
      // Honest cumulative evolution: 4.6 (stream start plumbing)
      // legitimately adds stream_starter.js, routes
      // recorder-start-streams through recorder.js/recorder.html, adds
      // device_selection.recordDefault, widens format_support.js's
      // recording-manifest fields, and adds its test + evidence; its
      // files join the allowlists.
      'stream_starter.js',
      'device_selection.js',
      'format_support.js',
      'recorder.js',
      'recorder.html',
      'tests/stream_starter.test.js',
      '.autodev/evidence/4.6.contract.md',
      '.autodev/evidence/4.6.build.md',
      // Honest cumulative evolution: 4.6's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.5 precedent).
      '.autodev/evidence/4.6.review.md',
      '.autodev/evidence/4.6.behavior.md',
      // Honest cumulative evolution: 4.7 (audio-content policy)
      // legitimately adds audio_policy.js, wires the classifications
      // into stream_starter.js's manifest-write stage, widens
      // format_support.js's manifest validator 13 → 15, loads the new
      // module in recorder.html, resolves it in recorder.js, records
      // the ## 4.7 decisions, and adds its test + evidence; its files
      // join the allowlists.
      'audio_policy.js',
      'tests/audio_policy.test.js',
      '.autodev/evidence/4.7.contract.md',
      '.autodev/evidence/4.7.build.md',
      // Honest cumulative evolution: 4.7's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.6 precedent).
      '.autodev/evidence/4.7.review.md',
      '.autodev/evidence/4.7.behavior.md',
      // Honest cumulative evolution: 4.8 (incremental chunk extraction)
      // legitimately adds chunk_writer.js, wires the automatic chunking
      // kickoff into recorder.js's recorder-start-streams handler, loads
      // the new module in recorder.html, records the ## 4.8 decisions,
      // and adds its test + evidence; its files join the allowlists.
      'chunk_writer.js',
      'tests/chunk_writer.test.js',
      '.autodev/evidence/4.8.contract.md',
      '.autodev/evidence/4.8.build.md',
      // Honest cumulative evolution: 4.8's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.7 precedent).
      '.autodev/evidence/4.8.review.md',
      '.autodev/evidence/4.8.behavior.md',
      // Honest cumulative evolution: 4.9 (track/error/discontinuity
      // monitoring) legitimately adds track_monitor.js, wires it into
      // recorder.js's recorder-start-streams handler (restart pre-check,
      // attach, restart events), adds the onTerminalState seam to
      // chunk_writer.js, the getManifestRecordsBySession read to
      // format_support.js, the script tag in recorder.html, records the
      // ## 4.9 decisions, and adds its test + evidence; its files join
      // the allowlists.
      'track_monitor.js',
      'tests/track_monitor.test.js',
      'tests/timecode.test.js',
      '.autodev/evidence/4.9.contract.md',
      '.autodev/evidence/4.9.build.md',
      // Honest cumulative evolution: 4.9's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.8 precedent).
      '.autodev/evidence/4.9.review.md',
      '.autodev/evidence/4.9.behavior.md',
      // Honest cumulative evolution: 4.10 (clock-segment linking)
      // legitimately adds clock_link.js, wires the link into the
      // stream starter's manifest-write stage, widens MANIFEST_KEYS
      // 15 → 16 with the 4.10-owned clockSegmentId field, adds the
      // getManifestRecord read, loads the new module in
      // recorder.html, exposes getClockLink in recorder.js (the
      // 4.13 seam), records the ## 4.10 decisions, and adds its
      // test + evidence; its files join the allowlists.
      'clock_link.js',
      'tests/clock_link.test.js',
      // 4.10 also modifies the manifest-write stage (stream_starter.js),
      // the manifest writer (format_support.js), the wiring
      // (recorder.js) and the module list (recorder.html); already
      // listed by earlier tasks where applicable — the Set dedupes.
      'stream_starter.js',
      'format_support.js',
      'recorder.js',
      'recorder.html',
      '.autodev/evidence/4.10.contract.md',
      '.autodev/evidence/4.10.build.md',
      // Honest cumulative evolution: 4.10's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.9 precedent).
      '.autodev/evidence/4.10.review.md',
      '.autodev/evidence/4.10.behavior.md',
      // Honest cumulative evolution: 4.11 (audible/visible sync
      // markers) legitimately adds sync_marker.js (offscreen audible
      // marker + SW flash-relay request), sync_flash.js (content-script
      // visible flash), sync_beep.wav (880 Hz beep asset), wires the
      // start marker into recorder.js's start-streams final .then, adds
      // the SW flash-relay leg to recording_host.js, the MSG_SYNC_FLASH
      // vocabulary entry, the script tag in recorder.html, the content
      // script in manifest.json, records the ## 4.11 decisions, and adds
      // its test + evidence; its files join the allowlists.
      'sync_marker.js',
      'sync_flash.js',
      'sync_beep.wav',
      'tests/sync_marker.test.js',
      // 4.11 also touches recorder.js, recording_host.js, recorder.html
      // and manifest.json; already listed by earlier tasks where
      // applicable — the Set dedupes.
      'recorder.js',
      'recording_host.js',
      'recorder.html',
      'manifest.json',
      '.autodev/evidence/4.11.contract.md',
      '.autodev/evidence/4.11.build.md',
      // Honest cumulative evolution: 4.11's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.10 precedent).
      '.autodev/evidence/4.11.review.md',
      '.autodev/evidence/4.11.behavior.md',
      // Honest cumulative evolution: 4.12 (recording timecode/offset
      // arithmetic) legitimately adds timecode.js (the pure nine-function
      // alignment library — media→clock→wall conversions, marker
      // disambiguation, continuity rule), persists nothing new
      // (MANIFEST_KEYS stays 16, DB_VERSION stays 2, no recorder.html
      // wiring — a library, not a pipeline stage), records the ## 4.12
      // decisions, and adds its test + evidence; its files join the
      // allowlists.
      'timecode.js',
      'tests/timecode.test.js',
      '.autodev/evidence/4.12.contract.md',
      '.autodev/evidence/4.12.build.md',
      // Honest cumulative evolution: 4.12's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.11 precedent).
      '.autodev/evidence/4.12.review.md',
      '.autodev/evidence/4.12.behavior.md',
      // Honest cumulative evolution: 4.3's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1/4.2 precedent).
      '.autodev/evidence/4.3.review.md',
      '.autodev/evidence/4.3.behavior.md',
      'tests/retention.test.js',
      '.autodev/evidence/2.9.contract.md',
      '.autodev/evidence/2.9.build.md',
      // Honest cumulative evolution: the adversarial review and
      // behavioral verification evidence land after the builder
      // evolved these pins (2.6/2.7/2.8 precedent).
      '.autodev/evidence/2.9.review.md',
      '.autodev/evidence/2.9.behavior.md',
      // Honest cumulative evolution: 3.1 legitimately touches
      // chess_utils.js (tracker), content.js (wiring), manifest.json
      // (game_records.js for 1.4 factories), and adds the suite.
      'chess_utils.js',
      'content.js',
      'manifest.json',
      'tests/history_tracker.test.js',
      '.autodev/evidence/3.1.contract.md',
      '.autodev/evidence/3.1.build.md',
      // Honest cumulative evolution: the adversarial review and
      // behavioral verification evidence land after the builder
      // evolved these pins (2.x precedent).
      '.autodev/evidence/3.1.review.md',
      '.autodev/evidence/3.1.behavior.md',
      // Honest cumulative evolution: 3.2's planner contract lands
      // before this task's pins evolve (3.1 precedent).
      '.autodev/evidence/3.2.contract.md',
      '.autodev/evidence/3.2.build.md',
      // Honest cumulative evolution: 3.2's review/behavior evidence
      // lands after the pins were evolved (2.x/3.1 precedent).
      '.autodev/evidence/3.2.review.md',
      '.autodev/evidence/3.2.behavior.md',
      // Honest cumulative evolution: 3.3 legitimately touches
      // chess_utils.js + content.js; its files join the allowlists.
      'tests/visibility.test.js',
      'tests/speech.test.js',
      '.autodev/evidence/3.3.contract.md',
      '.autodev/evidence/3.3.build.md',
      // Honest cumulative evolution: 3.3's review/behavior evidence
      // lands after the pins were evolved (2.x/3.1/3.2 precedent).
      '.autodev/evidence/3.3.review.md',
      '.autodev/evidence/3.3.behavior.md',
      '.autodev/evidence/3.3.domaudit.md',
      // Honest cumulative evolution: 3.4 legitimately touches
      // sounds.js + content.js and adds its evidence.
      'sounds.js',
      '.autodev/evidence/3.4.contract.md',
      '.autodev/evidence/3.4.build.md',
      // Honest cumulative evolution: 3.4's review/behavior evidence
      // lands after the pins were evolved (2.x/3.1/3.2/3.3 precedent).
      '.autodev/evidence/3.4.review.md',
      '.autodev/evidence/3.4.behavior.md',
      // Honest cumulative evolution: 3.5 legitimately touches
      // chess_utils.js (game lifecycle recorder + additive onGameReset
      // { confirmedMoveCount } argument) + content.js (visibility/focus
      // listeners, onGameReset recording, chess_rules game-end wiring);
      // adds tests/game_lifecycle.test.js and its evidence; records the
      // 3.5.3 dialog / reconnect audit in DECISIONS.md.
      'chess_utils.js',
      'tests/game_lifecycle.test.js',
      '.autodev/evidence/3.5.contract.md',
      '.autodev/evidence/3.5.build.md',
      // Honest cumulative evolution: 3.5's rereview/behavior
      // evidence lands after the pins were evolved (2.x/3.x precedent).
      '.autodev/evidence/3.5.rereview.md',
      '.autodev/evidence/3.5.behavior.md',
      '.autodev/DECISIONS.md',
      // Honest cumulative evolution: 4.13 (finalize recordings at Stop)
      // legitimately adds finalizer.js (the Stop sequence: stop-marker
      // wait, recorder stop, bounded final-flush await, device release,
      // discontinuous-segment splits, per-(sessionId, streamKind)
      // numbering, finalizedAtUtc mark), widens MANIFEST_KEYS 16 -> 18
      // with the 4.13-owned segmentNumber + finalizedAtUtc fields, adds
      // the MSG_STOP_STREAMS vocabulary entry, wires the
      // recorder-stop-streams handler into recorder.js, adds the
      // discardActiveStream seam to stream_starter.js, loads the new
      // module in recorder.html, records the ## 4.13 decisions, and adds
      // its test + evidence; its files join the allowlists.
      'finalizer.js',
      'tests/finalizer.test.js',
      'format_support.js',
      'recorder.js',
      'stream_starter.js',
      'recorder.html',
      '.autodev/evidence/4.13.contract.md',
      '.autodev/evidence/4.13.build.md',
      // Honest cumulative evolution: 4.13's review evidence lands after
      // the pins were evolved (2.x/3.x/4.1-4.12 precedent).
      '.autodev/evidence/4.13.review.md',
      // Honest cumulative evolution: 3.5's review/behavior evidence
      // lands after the pins were evolved (2.x/3.1/3.2/3.3/3.4 precedent).
      '.autodev/evidence/3.5.review.md',
      '.autodev/evidence/3.5.behavior.md',
      'tests/attempt_tracker.test.js',
      // This task records the binding §6 export constraint in DECISIONS.md.
      '.autodev/DECISIONS.md',
      // Honest cumulative evolution: 4.13 (finalize recordings at Stop)
      // legitimately adds finalizer.js (the Stop sequence: stop-marker
      // wait, recorder stop, bounded final-flush await, device release,
      // discontinuous-segment splits, per-(sessionId, streamKind)
      // numbering, finalizedAtUtc mark), widens MANIFEST_KEYS 16 -> 18
      // with the 4.13-owned segmentNumber + finalizedAtUtc fields, adds
      // the MSG_STOP_STREAMS vocabulary entry, wires the
      // recorder-stop-streams handler into recorder.js, adds the
      // discardActiveStream seam to stream_starter.js, loads the new
      // module in recorder.html, records the ## 4.13 decisions, and adds
      // its test + evidence; its files join the allowlists.
      'finalizer.js',
      'tests/finalizer.test.js',
      'format_support.js',
      'recorder.js',
      'stream_starter.js',
      'recorder.html',
      '.autodev/evidence/4.13.contract.md',
      '.autodev/evidence/4.13.build.md',
      // Honest cumulative evolution: 4.13's review evidence lands after
      // the pins were evolved (2.x/3.x/4.1-4.12 precedent).
      '.autodev/evidence/4.13.review.md',
      // Honest cumulative evolution (2.2–2.8 precedent): earlier tasks'
      // suites pin files 2.9 legitimately touches, so their pins evolve
      // in this task's commit.
      'tests/lifecycle.test.js',
      'tests/session_store.test.js',
      'tests/status_indicator.test.js',
            'tests/writer.test.js',
      // Honest cumulative evolution: 4.1 legitimately extends sw.js and the
      // manifest, so the sw.js/manifest pins in these suites evolve too.
      'tests/db.test.js',
      'tests/session_store.test.js',
      'tests/sender.test.js',
      // This task's own verification evidence lands after the builder ran:
      // '.autodev/evidence/2.9.review.md', '.autodev/evidence/2.9.behavior.md',
      // Honest cumulative evolution: 4.14 (report per-stream
      // recording status) legitimately adds stream_status.js (the
      // read-only per-stream status query over the registry, chunk
      // state, live tracks, health mirror, and manifest — no writes,
      // no events, no UI), the additive track_monitor.getStreamHealth
      // seam (+ the health mirror, nowUtcIso opt, and retention
      // calls), the recorder-get-status channel message + lazy
      // status-reader getter in recorder.js, the script tag in
      // recorder.html, records the ## 4.14 decisions, and adds its
      // test + evidence; its files join the allowlists.
      'stream_status.js',
      'tests/stream_status.test.js',
      // timecode pins tracked diffs only; track_monitor.js is the
      // tracked 4.14-modified file.
      'track_monitor.js',
      '.autodev/evidence/4.14.contract.md',
      '.autodev/evidence/4.14.build.md',
      // Honest cumulative evolution: 4.14's review/behavior evidence
      // lands after the pins were evolved (2.x/3.x/4.1-4.13 precedent).
      '.autodev/evidence/4.14.review.md',
      '.autodev/evidence/4.14.behavior.md',
      // Honest cumulative evolution: 5.1 (compact Start/Stop control +
      // per-stream health lights) legitimately adds session_controls.js
      // (the in-page control cluster + pure classifyStreamStatus), wires
      // the install into content.js, adds session_identity.js (ID minting)
      // and session_controls.js to the manifest content_scripts list,
      // captures ownerTabId + echoes gameId in recorder.js, adds the
      // SW-side recorder-ensure handler to recording_host.js, adds the
      // additive getLastObservedEnd getter to chess_utils.js (the Stop
      // seam for the observed game_ended reason), adds additive classes
      // to overlay.css, records the ## 5.1 decisions, and adds its test
      // + evidence; its files join the allowlists.
      'session_controls.js',
      'tests/session_controls.test.js',
      'manifest.json',
      'content.js',
      'overlay.css',
      'chess_utils.js',
      'recorder.js',
      'recording_host.js',
      '.autodev/evidence/5.1.contract.md',
      '.autodev/evidence/5.1.build.md',
      // Honest cumulative evolution: 5.1's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.x precedent).
      '.autodev/evidence/5.1.review.md',
      '.autodev/evidence/5.1.behavior.md',
      // Honest cumulative evolution: 5.2 (baseline/training/evaluation
      // selection + training approach and verbal scaffolding fields)
      // legitimately adds session_fields.js (pure buildInitialConditions +
      // UNDETECTED_CONDITION_FIELDS placeholders + installSessionFields
      // with the 5.3/5.4 seams), amends session_controls.js's Start
      // sequence (metadata-first minting, session-save, category echo,
      // category-required abort), adds the SW-side session-save handler
      // to recording_host.js, accepts/stores/echoes sessionCategory in
      // recorder.js, wires the fields install into content.js (+
      // extensionVersion pass-through), adds session_fields.js to the
      // manifest content_scripts list, adds additive classes to
      // overlay.css, records the ## 5.2 decisions, and adds its test +
      // evidence; its files join the allowlists.
      'session_fields.js',
      'tests/session_fields.test.js',
      'session_controls.js',
      'recorder.js',
      'recording_host.js',
      'content.js',
      'manifest.json',
      'overlay.css',
      '.autodev/evidence/5.2.contract.md',
      '.autodev/evidence/5.2.build.md',
      // Honest cumulative evolution: 5.2's review/behavior evidence
      // lands after the pins were evolved (2.x/3.x/4.x/5.1 precedent).
      '.autodev/evidence/5.2.review.md',
      '.autodev/evidence/5.2.behavior.md',
      // Honest cumulative evolution: 5.3 (remember previous selections
      // without silently changing a game's recorded conditions)
      // legitimately adds selection_memory.js (createSelectionMemory +
      // validateRememberedSelection, chrome.storage.local-backed
      // remembered defaults, no record-write path), adds the optional
      // onSessionStarted hook to session_controls.js (fired once at the
      // phase → 'active' point, guarded in try/catch), wires the memory
      // construction + restore + onSessionStarted pass-through into
      // content.js, adds the "storage" permission and selection_memory.js
      // to manifest.json, records the ## 5.3 decisions, and adds its test
      // + evidence; its files join the allowlists. (session_controls.js,
      // content.js, manifest.json and .autodev/DECISIONS.md are already
      // allowlisted from 5.1/5.2.)
      'selection_memory.js',
      'tests/selection_memory.test.js',
      // 5.3 also evolves the exact-permissions pins in these suites
      // (they carry no git-status allowlist of their own, so they join
      // here).
      'tests/db.test.js',
      'tests/manifest_sw.test.js',
      // 5.3 also evolves the working-tree diff pins in these suites.
      'tests/clock_link.test.js',
      'tests/timecode.test.js',
      '.autodev/evidence/5.3.contract.md',
      '.autodev/evidence/5.3.build.md',
      // Honest cumulative evolution: 5.3's review/behavior evidence
      // lands after the pins are evolved (2.x/3.x/4.x/5.1/5.2 precedent).
      '.autodev/evidence/5.3.review.md',
      '.autodev/evidence/5.3.behavior.md',
      // Honest cumulative evolution: 5.4 (show detected game conditions
      // and allow manual completion of unavailable fields before
      // recording) legitimately adds detected_conditions.js
      // (detectGameConditions + CONDITION_PROBES + installConditionsPanel
      // + attachConditionsPanel; playerColor detected via the verified
      // wc-chess-board/flipped probe, the other four fields manual-only),
      // wires the panel install + getDetectedConditions plug-in +
      // attachConditionsPanel composite into content.js, adds
      // detected_conditions.js to manifest.json, adds additive panel
      // classes to overlay.css, records the ## 5.4 decisions, and adds
      // its test + evidence; its files join the allowlists.
      // (content.js, manifest.json, overlay.css and .autodev/DECISIONS.md
      // are already allowlisted from 5.1/5.2/5.3.)
      'detected_conditions.js',
      'tests/detected_conditions.test.js',
      '.autodev/evidence/5.4.contract.md',
      '.autodev/evidence/5.4.build.md',
      '.autodev/evidence/5.4.review.md',
      '.autodev/evidence/5.4.behavior.md',
      // 5.4 also evolves the cumulative pins in these suites (each
      // carries its own git-status allowlist, so they join here).
      'tests/attempt_tracker.test.js',
      'tests/audio_policy.test.js',
      'tests/capture_selection.test.js',
      'tests/chunk_writer.test.js',
      'tests/device_selection.test.js',
      'tests/finalizer.test.js',
      'tests/format_support.test.js',
      'tests/game_lifecycle.test.js',
      'tests/history_tracker.test.js',
      'tests/lifecycle.test.js',
      'tests/recording_host.test.js',
      'tests/retention.test.js',
      'tests/selection_memory.test.js',
      'tests/sender.test.js',
      'tests/session_controls.test.js',
      'tests/session_fields.test.js',
      'tests/session_store.test.js',
      'tests/speech.test.js',
      'tests/status_indicator.test.js',
      'tests/stream_starter.test.js',
      'tests/stream_status.test.js',
      'tests/sync_marker.test.js',
      'tests/track_monitor.test.js',
      'tests/visibility.test.js',
      'tests/writer.test.js',
      // 5.4 also evolves the working-tree diff pins in these suites.
      'tests/clock_link.test.js',
      'tests/timecode.test.js',
      // Honest cumulative evolution: 5.5 (prevent a duplicate Start
      // from creating overlapping recording sessions) legitimately adds
      // the atomic duplicate-Start guard to recorder.js's
      // handleSetSession (sessionId-equality discriminator, synchronous
      // check-and-set, nothing overwritten on refusal), adds the
      // content-side pre-check + mint reorder + localAbortStart +
      // refusal-detail mapping to session_controls.js, records the
      // ## 5.5 decisions, and adds its test + evidence; its files join
      // the allowlists. No new channel messages, events, stores, or
      // permissions.
      'recorder.js',
      'session_controls.js',
      'tests/duplicate_start.test.js',
      '.autodev/DECISIONS.md',
      '.autodev/evidence/5.5.contract.md',
      '.autodev/evidence/5.5.build.md',
      // Honest cumulative evolution: 5.5's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.4 precedent).
      '.autodev/evidence/5.5.review.md',
      '.autodev/evidence/5.5.behavior.md',
      // 5.5 also evolves the cumulative pins in these suites (each
      // carries its own git-status allowlist, so they join here).
      'tests/attempt_tracker.test.js',
      'tests/audio_policy.test.js',
      'tests/capture_selection.test.js',
      'tests/chunk_writer.test.js',
      'tests/device_selection.test.js',
      'tests/finalizer.test.js',
      'tests/format_support.test.js',
      'tests/game_lifecycle.test.js',
      'tests/history_tracker.test.js',
      'tests/lifecycle.test.js',
      'tests/recording_host.test.js',
      'tests/retention.test.js',
      'tests/selection_memory.test.js',
      'tests/sender.test.js',
      'tests/session_controls.test.js',
      'tests/session_fields.test.js',
      'tests/session_store.test.js',
      'tests/speech.test.js',
      'tests/status_indicator.test.js',
      'tests/stream_starter.test.js',
      'tests/stream_status.test.js',
      'tests/sync_marker.test.js',
      'tests/track_monitor.test.js',
      'tests/visibility.test.js',
      'tests/writer.test.js',
      // 5.5 also evolves the working-tree diff pins in these suites.
      'tests/clock_link.test.js',
      'tests/timecode.test.js',
      // Honest cumulative evolution: 5.6 (show readiness only after
      // required media streams have started and an initial storage
      // write has succeeded) legitimately adds the pure
      // computeReadiness() policy function + readiness badge
      // presentation + poll-loop wiring to session_controls.js, adds
      // its unit/integration tests, and records its evidence; its
      // files join the allowlists. No new channel messages, events,
      // stores, or permissions.
      '.autodev/evidence/5.6.contract.md',
      '.autodev/evidence/5.6.build.md',
      // Honest cumulative evolution: 5.6's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.5 precedent).
      '.autodev/evidence/5.6.review.md',
      '.autodev/evidence/5.6.behavior.md',
      // Honest cumulative evolution: 5.7 (keep recording through game
      // end until the user clicks Stop) is primarily a pinning task —
      // it adds no product-code changes, only the 5.7 no-auto-stop
      // tests to tests/session_controls.test.js, and records its
      // evidence; its files join the allowlists. No new channel
      // messages, events, stores, or permissions.
      '.autodev/evidence/5.7.contract.md',
      '.autodev/evidence/5.7.build.md',
      // Honest cumulative evolution: 5.7's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.6 precedent).
      '.autodev/evidence/5.7.review.md',
      '.autodev/evidence/5.7.behavior.md',
      // Honest cumulative evolution: 5.8 (optional timestamped
      // note/moment marker) legitimately adds the moment_marker event
      // type + marker UI to session_controls.js, its test + evidence;
      // its files join the allowlists. No new channel messages,
      // stores, or permissions.
      '.autodev/evidence/5.8.contract.md',
      '.autodev/evidence/5.8.build.md',
      // Honest cumulative evolution: 5.8's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.7 precedent).
      '.autodev/evidence/5.8.review.md',
      '.autodev/evidence/5.8.behavior.md',
      // Honest cumulative evolution: 5.9 (mid-session game transition)
      // legitimately implements the onGameReset placeholder in content.js
      // (mint new gameId + install fresh tracker) and adds handleGameReset
      // + activeMetadata/activeConditions to session_controls.js (the
      // specified deliverable; 5.7 named the placeholder as 5.9's input),
      // adds its unit/integration tests, and records its evidence; its
      // files join the allowlists. No new channel messages, event types,
      // stores, or permissions.
      '.autodev/evidence/5.9.contract.md',
      '.autodev/evidence/5.9.build.md',
      // Honest cumulative evolution: 5.9's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.8 precedent).
      '.autodev/evidence/5.9.review.md',
      '.autodev/evidence/5.9.behavior.md',
      // Honest cumulative evolution: 5.10 (Stop completion verdict)
      // legitimately adds the sender.flush() await + transitional
      // "Finalizing…" UI + pure computeCompletion() + enriched
      // lastStopResponse retention to session_controls.js's Stop
      // sequence, adds its unit/integration tests, and records its
      // evidence; its files join the allowlists. No new channel
      // messages, event types, stores, or permissions.
      '.autodev/evidence/5.10.contract.md',
      '.autodev/evidence/5.10.build.md',
      // Honest cumulative evolution: 5.10's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.9 precedent).
      '.autodev/evidence/5.10.review.md',
      '.autodev/evidence/5.10.behavior.md',
      // Honest cumulative evolution: 6.1 (generate metadata.json from
      // stored context and observed completion status) legitimately adds
      // the new SW-side exporter.js module (pure buildMetadataJson
      // builder; 6.6 owns the orchestration/permission/message), its
      // test file, and its evidence; its files join the allowlists.
      // No new channel messages, event types, stores, or permissions
      // in 6.1. The section audit/architecture evidence files
      // (section-5.audit.md, created by the section auditor after 5.10's
      // pins; section-6.architecture.md, the §6 planner's) are
      // allowlisted here to repair the stale pins.
      'exporter.js',
      'tests/exporter.test.js',
      '.autodev/evidence/6.1.contract.md',
      '.autodev/evidence/6.1.build.md',
      '.autodev/evidence/section-5.audit.md',
      '.autodev/evidence/section-6.architecture.md',
      // Honest cumulative evolution: 6.1's review/behavior evidence lands
      // after the pins are evolved (2.x-5.x precedent).
      '.autodev/evidence/6.1.review.md',
      '.autodev/evidence/6.1.behavior.md',
      // Honest cumulative evolution: 6.2 (export events.jsonl) and
      // 6.3 (export media-sync.json) extend the 6.1 exporter.js module
      // with pure builder functions; their evidence files join the
      // allowlists. No new channel messages, event types, stores, or
      // permissions in 6.2/6.3.
      '.autodev/evidence/6.2.contract.md',
      '.autodev/evidence/6.2.build.md',
      '.autodev/evidence/6.2+6.3.review.md',
      '.autodev/evidence/6.2+6.3.behavior.md',
      '.autodev/evidence/6.3.contract.md',
      '.autodev/evidence/6.4.contract.md',
      '.autodev/evidence/6.4.build.md',
      '.autodev/evidence/6.5.contract.md',
      '.autodev/evidence/6.5.build.md',
      // 6.6 (ZIP packaging) adds the ZIP writer + exportSession to
      // exporter.js, the export-request listener to sw.js, the
      // downloads permission to manifest.json, and the Download
      // affordance to session_controls.js.
      '.autodev/evidence/6.6.contract.md',
      '.autodev/evidence/6.6.build.md',
      // 6.4+6.5 review/behavior use combined naming (reviewer/verifier
      // wrote single files for the pair, 6.2+6.3 precedent).
      '.autodev/evidence/6.4+6.5.review.md',
      '.autodev/evidence/6.4+6.5.behavior.md',
      '.autodev/evidence/6.3.build.md',
      
      
    ]);
    for (const f of changed) {
      assert.ok(allowed.has(f), `unexpected modified file: ${f}`);
    }
    assert.ok(fs.existsSync(path.join(ROOT, 'tests', 'retention.test.js')));
  });

  it('no product file differs from HEAD (except legitimately changed files)', () => {
    // Honest cumulative evolution: 3.1 legitimately modifies
    // chess_utils.js, content.js, and manifest.json (pinned by
    // tests/history_tracker.test.js AC13); 3.4 legitimately modifies
    // sounds.js (speech tracker + link threading) and content.js
    // (link threading + tracker install); 4.1 legitimately modifies
    // manifest.json (the "offscreen" permission) and sw.js (the
    // recording-context supervisor wiring); 4.2 legitimately modifies
    // recorder.js/recorder.html (mic channel); 4.3 legitimately modifies
    // manifest.json (tabCapture + host_permissions), sw.js (the capture
    // broker import), recording_host.js (the SW-leg broker routing), and
    // recorder.js/recorder.html (capture channel); 4.4 legitimately
    // modifies device_selection.js (video probe kind-branch) and
    // recorder.js (camera channel); 4.5 legitimately modifies db.js
    // (DB_VERSION 1 → 2 + recording_manifest store) and
    // recorder.js/recorder.html (recorder-get-formats channel + db.js and
    // format_support.js script tags). 4.11 legitimately modifies
    // manifest.json (sync_flash.js content script), recorder.js
    // (start-marker wiring + MSG_SYNC_FLASH), recording_host.js (the
    // SW-leg flash relay), and recorder.html (sync_marker.js script
    // tag); 4.11's sync_marker.js/sync_flash.js are new files (no HEAD
    // content to differ from — see below). All other product files
    // must remain byte-identical — the retention guarantee. New files that
    // do not exist at HEAD (4.1's recording_host.js, 4.2's
    // device_selection.js, 4.3's capture_selection.js/capture_broker.js,
    // 4.5's format_support.js, 4.11's sync_marker.js/sync_flash.js)
    // are skipped: they have no HEAD content to differ from, and their
    // scan coverage comes from the deletion-primitive / TTL scans above.
    // Honest cumulative evolution (5.1): session_controls.js is a new
    // file (no HEAD content to differ from — same skip rule); 5.1
    // legitimately modifies content.js (install wiring), chess_utils.js
    // (additive getLastObservedEnd), recording_host.js (recorder-ensure),
    // manifest.json (content_scripts list), and overlay.css (additive
    // classes) — all already in or joining the skip set below.
    // Honest cumulative evolution (5.2): session_fields.js is a new
    // file (same skip rule); 5.2's modifications to content.js,
    // manifest.json, recording_host.js, recorder.js, overlay.css, and
    // session_controls.js are already covered by the set.
    // Honest cumulative evolution (5.3): selection_memory.js is a new
    // file (same skip rule — no HEAD content to differ from); 5.3's
    // modifications to content.js, manifest.json, and
    // session_controls.js are already covered by the set.
    // Honest cumulative evolution (5.4): detected_conditions.js is a
    // new file (same skip rule — no HEAD content to differ from);
    // 5.4's modifications to content.js, manifest.json, and
    // overlay.css are already covered by the set.
    // Honest cumulative evolution (6.1): exporter.js is a new file
    // (same skip rule — no HEAD content to differ from); 6.6's
    // modifications to exporter.js, sw.js, manifest.json, and
    // session_controls.js are already covered by the set.
    const changedByTasks = new Set(['chess_utils.js', 'content.js',
                                    'manifest.json', 'sounds.js', 'sw.js',
                                    'recording_host.js', 'recorder.js',
                                    'recorder.html', 'device_selection.js',
                                    'capture_selection.js', 'db.js',
                                    'format_support.js', 'sync_marker.js',
                                    'sync_flash.js',
                                    'session_controls.js',
                                    'session_fields.js',
                                    'selection_memory.js',
                                    'detected_conditions.js',
                                    'overlay.css',
                                    'capture_broker.js',
                                    'exporter.js']);
    for (const f of PRODUCT_FILES) {
      if (changedByTasks.has(f)) continue;
      const head = execSync(`git show HEAD:${f}`, { cwd: ROOT, stdio: 'pipe' }).toString();
      const current = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.strictEqual(current, head, `${f} changed but 3.1/3.4/4.x must not touch it`);
    }
  });
});
