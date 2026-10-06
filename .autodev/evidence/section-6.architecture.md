# Section 6 architecture — Export a self-contained raw-data bundle

**Planner:** section planner subagent. **Date:** 2026-10-06.
**Scope:** PLAN.md §6.1–§6.8. **Branch:** `autodev/logging-instrumentation`.
**Status:** ARCHITECTURE ONLY. No implementation code written. PLAN.md unmodified.

## 0. What Section 6 builds (one paragraph)

After Stop, the user downloads one ZIP per recording session containing
`metadata.json` (6.1), `events.jsonl` (6.2), `media-sync.json` (6.3), and the
assembled original-format media files (6.4, numbered per 6.5). The ZIP is
built SW-side from readonly IndexedDB reads, assembled incrementally as Blob
parts so a long recording is never fully materialized in JS memory (6.6), and
delivered via `chrome.downloads.download()` — the extension never writes to
the user's filesystem directly (6.8). Export never deletes or mutates the
stores, so a failed download can be retried byte-identically (6.7).

## 1. Where export lives

**A new SW-side module (`exporter.js`, name at the builder's discretion),
loaded via `importScripts()` in `sw.js`.** Rationale:

- **The data lives in the SW origin.** All six stores (`events`,
  `session_metadata`, `conditions`, `sequence_state`, `media_chunks`,
  `recording_manifest`) are in the extension service worker's IndexedDB.
  The SW reads them directly with the existing `BlindfoldSession.DB`
  API — no new data channel, no serialization round-trip.
- **`chrome.downloads` is SW-available.** In MV3, `chrome.downloads`
  is exposed to extension pages and the service worker — not to
  content scripts and not to offscreen documents. The download must
  therefore be triggered from the SW. (This also keeps the new
  `"downloads"` permission's use in one place.)
- **The offscreen document is the wrong home.** It owns capture, not
  storage; it cannot call `chrome.downloads`; routing multi-megabyte
  media through it would add a pointless hop.
- **The content script is the trigger, not the builder.** It knows the
  sessionId and holds 5.10's in-memory stop verdict, but it must not
  see media bytes (discretion) and cannot download.

**Trigger path:** content (`session_controls.js`, 6.6's affordance) →
new SW-side channel message `export-request` `{sessionId, stopVerdict}`
→ exporter builds the bundle → `chrome.downloads.download()`.
The 5.10 `lastStopResponse` (in-memory only, per the audit
carry-forward: "§6 must read it from the retained verdict, not from any
store") travels in the request message. If the verdict is absent
(re-export long after Stop, SW restart), the exporter degrades
honestly: media-sync.json's "known gaps" are derived from the stores
only, with an explicit `stopVerdict: null` marker — never fabricated.

## 2. Data flow (one export)

```
content: user clicks Download (6.6 affordance, after Stop-complete)
  → channelCall('export-request', {sessionId, stopVerdict})
SW exporter:
  1. snapshot store counts (events, media_chunks, recording_manifest
     for sessionId) — the before-proof (standing readonly rule)
  2. read session_metadata + conditions (6.1)
  3. read events via bySessionId, order by appendSeq (6.2)
  4. read recording_manifest via bySessionId (6.3, 6.4, 6.5)
  5. for each segment, in segmentNumber order: read media_chunks in
     chunkIndex order, concatenate raw bytes (6.4) → Blob part(s)
  6. build metadata.json / events.jsonl / media-sync.json (6.1–6.3)
  7. ZIP: local headers + file data (Blob parts, §4) + central
     directory; internal path <category>/<date>_<gameIdShort>/
  8. re-count stores — the after-proof; counts must match §2's
     snapshot exactly (readonly discipline)
  9. new Blob(parts, {type:'application/zip'}) →
     URL.createObjectURL → chrome.downloads.download({url, filename})
  10. response {ok:true, filename, bytes, fileCount} (or honest error)
```

Export is **read-only end to end**: no `put`, no `delete`, no manifest
mutation. 2.9 retention owns deletion; export never deletes originals
(PLAN §2.9: "export must not delete the originals").

## 3. Store access discipline (standing rule)

Carried from the mission brief and the §4 audit: **export uses readonly
reads and proves identical store counts before/after.**

- Reads go through `BlindfoldSession.DB.getAll` / `DB.get` only.
  No new DB API is needed (`getAll` with `{index:'bySessionId'}`
  covers events and the manifest; `get` covers the three
  session-keyed stores).
- Before building, the exporter counts the session's rows in
  `events`, `media_chunks`, and `recording_manifest`; after building
  (before responding), it counts again. Any mismatch → honest
  `{ok:false, error:'store-changed-during-export'}` — never a
  silently inconsistent bundle. (A concurrent writer is not
  expected post-Stop, but the proof is cheap and the rule is
  standing.)
- Corrupt/malformed records encountered during export are surfaced
  as export errors naming the store and key — never silently
  skipped, never silently repaired (the 2.6 corruption-honesty
  precedent).

## 4. The ZIP builder (6.6's streaming requirement)

**Hand-rolled minimal ZIP writer, STORE method (no compression) only.**
Rationale:

- The repo is dependency-free; vendoring a ZIP library would break
  the convention for no benefit.
- Media is already compressed (webm/mp4/m4a) — DEFLATE would gain
  ~nothing on the bulk of the bytes. JSON files are small.
- STORE (method 0) needs no compression code at all: local file
  header + raw data + central directory. CRC-32 is ~30 lines
  (table-driven); the builder writes it, V1 pins it against known
  vectors.

**Streaming without full-memory load (6.6):** the ZIP is assembled as
an ordered array of `Blob` parts, not as one ArrayBuffer:

```
parts = [localHeader(file1), ...chunkBlobs(file1)...,
         localHeader(file2), ...chunkBlobs(file2)...,
         ..., centralDirectory, endRecord]
final = new Blob(parts, {type: 'application/zip'})
```

- Media bytes flow IDB → Blob (one chunk at a time, in key order) →
  parts array. JS-heap memory holds only headers and the parts
  *references*; the bytes live in the browser's blob storage
  (disk-backed in Chrome). A multi-hour recording never sits in the
  SW's JS heap as a single buffer.
- The central directory requires file offsets: the exporter tracks a
  running byte offset as parts are appended (header sizes are known;
  chunk Blob sizes via `blob.size`). Deterministic and exact.
- Filenames inside the ZIP use forward slashes; the top-level
  directory is `<category>/<YYYY-MM-DD>_<gameId>/` per PLAN §6.6
  ("category/date/game-ID path"). For multi-game sessions (5.9),
  the directory uses the *session's* identity: `<category>/<date>_session-<shortId>/`
  (builder's exact scheme, but it must not duplicate media per the
  Flow rule — see §6).

**Download:** `chrome.downloads.download({url: blobUrl, filename:
'<category>-<date>-<shortId>.zip', saveAs: false})`. `saveAs: false`
respects the user's configured download location without prompting
every export; the user extracts the ZIP into the experiment root
themselves (6.8). Requires the `"downloads"` permission (new in
6.6's diff).

## 5. Task decomposition (6.1–6.8)

| Task | Owner | Reads | Writes (new files) |
|------|-------|-------|--------------------|
| 6.1 metadata.json | exporter (pure builder fn) | session_metadata, conditions, recording_manifest (inventory), stopVerdict (from request) | metadata.json |
| 6.2 events.jsonl | exporter (pure builder fn) | events bySessionId, ordered by appendSeq | events.jsonl |
| 6.3 media-sync.json | exporter (pure builder fn) | recording_manifest, clock_anchor events, stream_discontinuity events, stopVerdict.warnings | media-sync.json |
| 6.4 chunk assembly | exporter (assembly fn) | media_chunks per segment, chunkIndex order | media Blobs (in-memory parts) |
| 6.5 numbered files | exporter (naming fn) | manifest.segmentNumber (4.13); on-the-fly numbering for segmentNumber:null (4.13 §3 rule) | `microphone-001.webm` … |
| 6.6 ZIP + download | exporter + sw.js wiring + manifest permission + content affordance | (assembled parts) | the ZIP download |
| 6.7 repeatability | discipline (no new code beyond §3's proof) | same as above | identical bytes on re-run |
| 6.8 documentation | README (7.14 owns the README; 6.8 contributes the export section) | — | docs |

**6.1–6.3 are pure builder functions** (input: plain records;
output: string/Blob) — unit-testable in Node without IndexedDB,
following the `computeReadiness`/`computeCompletion` precedent.
6.4–6.6 are the SW-side orchestration around them.

**Multi-game sessions (5.9, Flow rule):** "retain the media once and
map all game boundaries to it; do not duplicate the same recording
into multiple bundles." One session → one ZIP. `metadata.json`
carries the full `gameIds` array; `events.jsonl` partitions by
`gameId` with `game_reset` boundaries (already in the stream);
`media-sync.json` maps each gameId to the shared segments. The ZIP
directory names the session, not a single game.

**Unfinalized/crashed sessions:** 4.13 numbers segments only at
finalize; a session that never finalized keeps `segmentNumber: null`.
Per 4.13 §3, §6.5 numbers on the fly (chronological by
`(createdAtUtc, segmentId)`, 1-based per streamKind) and marks them
honestly in media-sync.json (`finalized: false`). Export does not
require finalization — raw data is raw data.

**Late chunks after finalize:** 4.13's contract §0.1.1 and the §4
audit carry-forward ("late-chunk-after-finalize handling is §6's
concern"): the chunk set is append-only; §6 reads the store, not the
finalize tally. A chunk that landed after finalization is included
in its segment's file (key order is the truth), and media-sync.json
notes `chunksAfterFinalize: <count>` for that segment when nonzero.

## 6. New surfaces (exact)

1. **`"downloads"` permission** in manifest.json (6.6). Justification:
   the only way to deliver a file download from an MV3 SW.
2. **One new SW-side channel message** `export-request`
   `{sessionId, stopVerdict|null}` → `{ok:true, filename, bytes,
   fileCount} | {ok:false, error}` (6.6). Offscreen MSG_* vocabulary
   is untouched (this is SW-side, like 5.1's `recorder-ensure`).
3. **One content-side affordance** (6.6): a Download button in the
   session-controls cluster, enabled when a completed session exists
   (after Stop-complete; 5.10's idle-with-verdict state). It sends the
   request with the retained `lastStopResponse`. No new permissions
   on the content side.
4. **One new event type: none.** §6 adds zero event types (5.8's
   `moment_marker` was the last one).

## 7. Non-goals and honest limitations

- No transcoding, ever (6.4: "without unnecessary transcoding" —
  the design does zero transcoding; concatenation of MediaRecorder
  chunks from one recorder is byte-appendable by construction).
- No playback UI, no bundle preview, no selective export (whole
  session or nothing — partial export would be a new requirement).
- No upload, no cloud sync, no automatic backup (the user copies the
  ZIP to their backup location per §(c) step 9).
- No deletion on export (2.9 owns retention/deletion).
- No progress UI beyond the download shelf's native progress
  (a progress channel would be a new message; the builder may add
  one only if the contract for 6.6 requires it — default: no).
- `chrome.downloads.download` can still fail (user cancels, disk
  full, policy blocks): the response reports it honestly; the
  sources are untouched so 6.7's retry works.
- Very large sessions: Blob-parts keep the SW heap bounded, but the
  browser still materializes the final Blob for download — this is
  the platform's download path, not the extension's memory.
  7.12 (realistic-length recording) will characterize it on the
  device.

## 8. Verification strategy for the section

- **V1 (per task):** pure builder functions tested in Node with
  fixture records (no IndexedDB): metadata.json golden shape,
  events.jsonl ordering/dedup-free passthrough, media-sync.json
  gap accounting, ZIP writer against known CRC vectors and a
  real unzip round-trip (Node zlib can *read* the STORE zip).
  Static pins: readonly discipline (no `DB.put`/`DB.delete` in
  exporter.js), `"downloads"` the only manifest permission delta,
  PLAN.md unmodified.
- **V2 (per task):** headless-Chrome harnesses driving the real SW:
  seed a session's stores via the real writer/manifest paths,
  run export, download the ZIP (harness intercepts via
  `chrome.downloads` in the test context or reads the built Blob),
  unzip and assert contents. 6.7: export twice → byte-identical.
  6.4: assembled media byte-equals concatenated chunks.
- **V3 (§7 / owner device):** real bot-game session → Stop →
  download → extract → open media files, reconstruct game from
  events.jsonl (7.13); realistic-length recording for memory
  bounds (7.12).

## 9. Task order within §6

6.1 → 6.2 → 6.3 (pure builders, independent) → 6.4+6.5 (assembly +
naming) → 6.6 (ZIP + download + permission + affordance) → 6.7
(repeatability proof; mostly verification) → 6.8 (docs; lands with
7.14's README but the export section is written here). Each task
follows the mission workflow: planner → builder → mechanical →
review → behavior → commit.
