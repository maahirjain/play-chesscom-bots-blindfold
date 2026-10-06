# Exporting Session Data

After you click **Stop** on a recording session, you can download the full
raw-data bundle as a single ZIP file. This document explains where the ZIP
goes, what's inside it, and how to work with it.

## Downloading the ZIP

1. After Stop completes, a **Download** button appears in the session
   controls (enabled only when the session has fully stopped).
2. Click **Download**. The browser's download manager saves the ZIP to
   your configured download location (usually `~/Downloads`).
3. The button shows **Exporting…** while the bundle is built, then
   returns to **Download**.

**If the download is interrupted** (you cancel it, the browser crashes,
the disk fills up): click **Download** again. The export is rebuilt from
scratch using the retained local data — nothing is lost, and no cleanup
is needed. Every export is a complete, independent build.

## Where to put it

**You** extract the ZIP into your experiment directory — the folder where
you keep your blindfold-chess experiment data. The extension does not do
this for you.

The extension **never writes to arbitrary filesystem paths**. It has no
filesystem access beyond offering a download through the browser's
download manager. It cannot choose where the ZIP lands, create
directories, or write anywhere else on your system.

The ZIP contains a single top-level directory:

```
<category>/<YYYY-MM-DD>_<gameId>/
```

For sessions with multiple games (you started a new game before
stopping), the directory is named for the session instead:

```
<category>/<YYYY-MM-DD>_session-<sessionId>/
```

The media is stored once and shared across games — it is never
duplicated.

## What's inside the bundle

| File | Contents |
|------|----------|
| `metadata.json` | Session identity (session/game IDs), category, training fields, the verbatim initial conditions, per-game starting positions (where known), completion status (`complete`, `complete-with-warnings`, or `unknown`), and a media inventory. |
| `events.jsonl` | The full event stream in persistent append order — one JSON object per line. This is the raw observation log: moves, game boundaries, lifecycle events, markers, clock anchors. No computed metrics. |
| `media-sync.json` | Media filenames, formats, clock anchors, per-segment timing offsets (for aligning media with events), and known gaps (e.g. a stream whose final flush timed out, undelivered events). |
| `microphone-NNN.webm` | Assembled microphone audio, original format, no transcoding. |
| `screen-NNN.webm` | Assembled screen recording, original format, no transcoding. |
| `webcam-NNN.webm` | Assembled webcam recording, original format, no transcoding. |

Numbered files (`-001`, `-002`, …) correspond to recording segments.
If a recording was interrupted, every segment is still listed — the
numbering reflects what was actually captured, and `media-sync.json`
documents any gaps honestly.

## What the extension does NOT do

- **No arbitrary filesystem writes.** The only output is the browser
  download. The extension cannot write to your experiment directory,
  create folders, or touch any other path.
- **No deletion on export.** Exporting never deletes or modifies the
  stored recording data. The local copy remains until the extension's
  retention policy removes it.
- **No upload, sync, or backup.** The bundle never leaves your machine
  through the extension. Copy the ZIP to your backup location yourself.
- **No transcoding.** Media files are byte-concatenations of the
  originally recorded chunks. What you hear/see is exactly what was
  captured.
- **No analysis.** The bundle contains raw observations only — no
  metrics, no transcripts, no engine evaluations. Analysis happens in
  your own tools, outside the extension.

## Re-exporting

You can click **Download** any number of times. Each export rebuilds
the bundle from the retained local data. Two exports of the same
session are byte-identical except for the `exportedAtUtc` timestamps
in `metadata.json` and `media-sync.json` (which honestly record when
each export ran).
