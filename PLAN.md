# 1. Context

This project is a Chrome extension for playing Chess.com bots blindfold, using keyboard move input, spoken move announcements, piece visibility toggles, and spoken help.

The experiment is a longitudinal self-study by a roughly 2000-rated chess player who does not have aphantasia but does not consider their visualization particularly strong. The question is whether combining visualization with a relational mental map can improve blindfold chess. Inspiration: https://youtu.be/9EYGJ4IGfWg.

The overall journey is to record three strict blindfold baseline games, develop square associations/stories, practice relational think-aloud mapping with occasional peeks, gradually reduce verbal scaffolding, and periodically repeat standardized blindfold evaluations. At the end, analyze the evidence and make a YouTube video about the process and findings. All baseline, training, and evaluation games are against Chess.com bots; the labels describe purpose, not opponent type.

The implementation scope is **raw data collection only**. Preserve enough original observations, inputs, and synchronized media to calculate reasonable cross-game metrics later. Daily use should be Start → play → Stop/export, with no manual tallying during play.

Do not implement analysis commands, metrics, transcription, engine analysis, charts, dashboards, reconstruction-test interfaces, or enforcement of strict blindfold rules. Do not refactor unrelated gameplay. Make only the changes necessary for reliable collection, recording, and export.

Store original data once. Starting FEN plus confirmed coordinate moves is sufficient to derive SAN, PGN, subsequent positions, and move numbers. Event timestamps support durations and counts. Original audio supports later transcription. Do not persist those derived products in the collection implementation. Keep actual observed outcomes even if later replay could produce an expected outcome: an input's actual rejection or a recording failure is evidence that cannot be reconstructed reliably.

Limits: a rejected entry is not necessarily a memory error; a revealed board does not prove the player looked at it; speech does not directly measure mental imagery. Reconstruction accuracy requires an explicit test response. The recorder supports later investigation, not proof of a psychological mechanism.

# 2. Plan

The numbers below are implementation task identifiers. Each leaf is a small implementation task. This document specifies future work; creating it does not implement or authorize unrelated features.

## 1. Define the raw-data contract

1.1. Define session and game identity.

1.1.1. Generate a unique session ID when Start is clicked.

1.1.2. Generate a unique game ID for each detected game; use one game per recording session in the normal workflow.

1.1.3. Define metadata fields for schema version, extension version, protocol version, and session category.

1.2. Define session conditions.

1.2.1. Store the selected training approach and verbal scaffolding level once at session start.

1.2.2. Store bot identity/displayed rating, player color, time control, and assistance settings, with their source marked observed or manually supplied.

1.2.3. Represent unavailable conditions as unknown rather than guessing.

1.2.4. Store later condition changes as events instead of repeating all conditions on every event.

1.3. Define event identity and time.

1.3.1. Define a common envelope containing event ID, event type, session/game reference, source context, source sequence, and event payload.

1.3.2. Store a UTC and monotonic-clock anchor for each page/recorder context segment.

1.3.3. Timestamp each event at its source using elapsed monotonic time and its clock-segment reference.

1.3.4. Assign a persistent append sequence when storing events; preserve source times because delivery order may differ from occurrence order.

1.3.5. Define references connecting attempts, confirmed moves, help requests, speech utterances, and recording segments without repeating their contents.

1.4. Define game reconstruction records.

1.4.1. Store the starting FEN once per game.

1.4.2. Store each confirmed move as from-square, to-square, and optional promotion, with an observation timestamp.

1.4.3. Define history-recovery and history-revision events for reloads, takebacks, and corrections; preserve the original event stream.

1.4.4. Define a recovery-position checkpoint only for cases where a logging gap cannot be bridged with verified moves.

1.4.5. Define observed game-end fields for result, termination reason, and evidence source; allow unknown or manual completion.

## 2. Add persistent event storage

2.1. Add the smallest required extension background/service-worker entry to the manifest.

2.2. Create an extension-owned IndexedDB database for metadata, events, and media chunks; do not use Chess.com's localStorage for experiment records.

2.3. Add a content-script event sender that timestamps and queues observations immediately.

2.4. Add a transactional event writer that deduplicates by event ID and acknowledges durable writes.

2.5. Retry unacknowledged events while the originating context remains available.

2.6. Restore session metadata and stored sequence state after background-worker restart.

2.7. Record page/context start and clean-end events; mark an unclean discontinuity when recovery detects a missing end.

2.8. Surface write failures and storage-capacity problems in the session status indicator.

2.9. Keep saved records until deliberate deletion; export must not delete the originals.

## 3. Instrument existing gameplay

3.1. Make confirmed history tracking reliable in chess_utils.js.

3.1.1. Compare move-list contents rather than only list length.

3.1.2. Validate each move before advancing the internal game state.

3.1.3. Emit one confirmed-move event per successfully observed history addition, including moves made by mouse.

3.1.4. Detect a revised history and record a revision rather than treating it as ordinary new play.

3.1.5. Distinguish a temporarily missing move-list element from a genuine reset or new game.

3.1.6. Mark moves discovered in a batch or recovered after reload as such; do not invent their original occurrence times.

3.1.7. Emit synchronization failures when the observed history cannot be reconciled with the internal board.

3.2. Instrument move input in content.js.

3.2.1. Record the first edit time for each submitted attempt; do not collect every keystroke.

3.2.2. Capture exact submitted text before normalization or clearing the input field.

3.2.3. Record the actual validation outcome without storing a duplicate normalized string.

3.2.4. Record dispatch start and actual board-interaction failure, including promotion-selection failure where observable.

3.2.5. Link a submitted attempt to the matching confirmed history move only after acceptance is observed.

3.2.6. Mark unresolved submissions as unconfirmed; do not label them confirmed illegal moves merely because confirmation is absent.

3.2.7. Keep rejected mouse attempts outside guaranteed coverage unless Chess.com exposes a reliable signal; document this limitation.

3.3. Instrument visibility and assistance.

3.3.1. Record the initial extension piece-visibility state.

3.3.2. Record each reveal/hide transition at setPieceSet, with its source.

3.3.3. Record each existing help shortcut and whether the request had usable content.

3.3.4. Record reliably observable Chess.com hints and assistance-setting changes; mark unsupported coverage explicitly.

3.3.5. Audit what the current DOM can expose for other visual aids; document that extension visibility events do not prove complete absence of visual information.

3.4. Instrument speech in sounds.js.

3.4.1. Give each utterance an ID linked to its move, help request, or game-result event.

3.4.2. Record utterance start and end callbacks.

3.4.3. Record cancellation requests and speech errors, distinguishing requested cancellation from an observed completion.

3.4.4. Save spoken text only when its actual content cannot be reproduced from the referenced event and versioned speech logic.

3.4.5. Record initial voice/rate settings and subsequent changes needed to interpret delivery.

3.5. Instrument lifecycle events.

3.5.1. Record document visibility and focus changes without treating them as proof of a cognitive pause.

3.5.2. Record page reload/reconnect and detected game resets or takebacks.

3.5.3. Observe Chess.com result/termination information where available, including endings not implied by chess rules.

3.5.4. Allow a termination reason at Stop when the ending is unknown, such as abandonment.

## 4. Add synchronized recording

4.1. Create a dedicated extension recording context that remains alive across Chess.com page refreshes; do not host recording solely in the content script or a transient popup.

4.2. Add microphone selection and permission handling.

4.3. Add screen/tab capture selection and permission handling.

4.4. Add webcam selection and permission handling so the player's face is saved separately from the screen.

4.5. Verify supported recording formats at runtime and save the actual MIME type/file extension in the recording manifest.

4.6. Start separate microphone, screen, and webcam recording streams, saving actual start times rather than assuming simultaneous starts.

4.7. Capture game/extension audio with the screen where supported, keeping it out of the microphone stream's intentional mix; document device-specific limitations and possible acoustic bleed.

4.8. Save recorder chunks incrementally in extension-owned storage.

4.9. Log recording track mute/end, recorder errors, and explicit recording discontinuities.

4.10. Give every recording segment an ID and link it to the corresponding clock anchor.

4.11. Add a visible/audible synchronization marker at session start and stop and save its source timestamps.

4.12. Save timecode/offset information needed to align each media segment with event time; do not use chunk-arrival time as exact frame time.

4.13. Finalize available chunks on Stop; keep discontinuous or restarted recordings as separate numbered segments.

4.14. Report each stream's status separately so microphone, screen, or webcam failure cannot masquerade as complete recording.

## 5. Add minimal session controls

5.1. Add a compact Start/Stop control and recording/saving health indicator.

5.2. Add baseline/training/evaluation selection, with training approach and verbal scaffolding fields.

5.3. Remember previous selections without silently changing a game's recorded conditions.

5.4. Show detected game conditions and allow manual completion of unavailable fields before recording.

5.5. Prevent a duplicate Start from creating overlapping recording sessions.

5.6. Show readiness only after required media streams have started and an initial storage write has succeeded.

5.7. Keep recording through game end until the user clicks Stop, allowing a spoken reflection.

5.8. Add an optional timestamped note/moment marker without requiring its use during play.

5.9. If a new game is started before Stop, assign a new game ID and preserve its boundary; flag the shared recording session rather than mixing move histories.

5.10. After Stop, await final storage acknowledgments and media finalization before presenting export as complete.

## 6. Export a self-contained raw-data bundle

6.1. Generate metadata.json from stored context and observed completion status.

6.2. Export events.jsonl in persistent append order without computed metrics or per-move position duplication.

6.3. Export media-sync.json with media filenames, formats, clock anchors, segment offsets, and known gaps.

6.4. Assemble stored chunks into original-format microphone, screen, and webcam files without unnecessary transcoding.

6.5. Use numbered files for interrupted recordings and list every segment in media-sync.json.

6.6. Package the files into one ZIP with a category/date/game-ID path; use export that does not require loading an entire long recording into memory at once.

6.7. Provide repeatable export from retained local data if a download is interrupted.

6.8. Document that the user extracts ZIPs into the experiment directory; do not assume arbitrary filesystem write access.

## 7. Verify collection before baseline

7.1. Verify legal, rejected, ambiguous, and repeated submissions produce distinct correct event records.

7.2. Verify promotions, castling, and en passant replay correctly from starting FEN and confirmed moves.

7.3. Verify accepted mouse moves are captured even without a keyboard attempt.

7.4. Verify batched DOM updates and same-length history revisions are handled without duplicate moves.

7.5. Verify new games, takebacks, reloads, and late attachment do not create fabricated timings.

7.6. Verify reveal/hide events and every existing help shortcut are captured.

7.7. Verify speech cancellation and actual delivery are distinguishable.

7.8. Verify microphone, screen, webcam, and game audio on the actual computer/browser setup.

7.9. Verify visible/audible markers align with event timestamps at both ends of a recording.

7.10. Verify a page refresh does not stop the independent recording context.

7.11. Verify permission denial, device loss, storage failure, and interrupted sessions produce explicit incomplete status and recoverable saved data.

7.12. Run a realistic-length disposable recording and confirm bounded memory use and successful export.

7.13. Open each exported media file and reconstruct the game from exported raw moves as a collection correctness check, not a shipped analysis command.

7.14. Update README with setup, recording controls, export instructions, and verified coverage limitations.

# 3. Flow

## (a) Directory structure and stored data

Normal usage produces one recording session and one self-contained export folder per game. Example after extracting the ZIPs:

```text
blindfold-experiment/
  protocol.md                         # User-maintained evaluation rules
  associations/                       # Optional user-maintained training materials
    2026-10-06-square-stories.md       # Dated snapshot; preserve older versions
  practice-notes.md                   # Optional outside-game practice log
  baseline/
    2026-10-05_game-001_<unique-id>/
      metadata.json
      events.jsonl
      media-sync.json
      microphone.webm
      screen.webm
      webcam.webm
  training/
    2026-10-06_game-004_<unique-id>/
      metadata.json
      events.jsonl
      media-sync.json
      microphone.webm
      screen.webm
      webcam.webm
  evaluation/
    2026-10-12_game-015_<unique-id>/
      metadata.json
      events.jsonl
      media-sync.json
      microphone.webm
      screen.webm
      webcam.webm
```

Dates and sequence numbers are illustrative; unique IDs establish identity. WebM is illustrative: filenames must match the actual supported capture format. The top-level protocol, associations, and practice notes are simple user-maintained documents, not new extension editors or automated outputs.

The export ZIP contains the category/game path so extraction into the experiment root places it correctly. For interrupted media, use microphone-001.webm, microphone-002.webm, screen-001.webm, etc. Missing or failed streams must be explicitly identified. If multiple games share a recording session accidentally, retain the media once and map all game boundaries to it; do not duplicate the same recording into multiple bundles.

| File | Raw data retained |
| --- | --- |
| metadata.json | IDs; session category; protocol/schema/extension versions; initial conditions; observed/manual sources; game starting FEN; media inventory and collection coverage/completeness. |
| events.jsonl | Confirmed coordinate moves; raw submitted attempts and actual validation outcomes; first-edit/submission/confirmation events; dispatch failures; initial visibility and transitions; help requests; speech lifecycle; observed assistance changes; history revisions; game endings; focus/visibility and page lifecycle events; clock anchors; errors/gaps; optional notes. |
| media-sync.json | Media/segment IDs and filenames, actual formats, links to clock anchors, alignment offsets/timecodes, synchronization markers, and discontinuities. References underlying events where possible rather than duplicating their payloads. |
| microphone.* | Full original voice audio from recording start to stop, subject to explicitly recorded gaps. No transcript is generated now. |
| screen.* | Full original captured screen/tab video, including game/extension audio where verified supported. The board appears exactly as seen by the player, including hidden pieces. |
| webcam.* | Full original face-camera recording, synchronized but separate for later video composition. |

Do not store routine per-move FEN, SAN, PGN, normalized input, move numbers, durations, illegal-attempt counts, peek/help counts, transcripts, scores, or charts. Derive them at the end. Validation outcomes remain raw observed facts. Checkpoints are permitted for recovery across otherwise irrecoverable history gaps.

Keep media separate so the final YouTube edit can independently crop the board, arrange the face camera, adjust voice/game audio, and reference exact gameplay moments. The screen recording does not expose a reconstructed visible board during blindfold play; that can be generated later from moves.

## (b) Overall experiment flow

1. Complete one-time setup and a disposable collection check before collecting research games.
2. Write down strict baseline/evaluation rules: bot/settings, colors or color schedule, time control, permitted announcements/repeats, visual aids, and verbalization instructions. Keep these consistent for later evaluations. The recorder logs deviations but does not enforce these rules.
3. Record three strict blindfold baseline games before beginning the training intervention. Select Baseline for each. Retain incomplete games and deviations with their explanation.
4. Build square associations/stories and preserve dated versions as they change.
5. Train with visualization plus relational think-aloud mapping. Use occasional peeks/help as intended and let the recorder capture them. Select Training and the current scaffolding level.
6. Gradually reduce verbal scaffolding, recording each condition change. Optionally note practice outside recorded games so elapsed training exposure is not invisible.
7. At a preselected cadence, play Evaluation games using baseline conditions. These are still Chess.com bot games. Keep evaluation verbalization instructions stable even as training scaffolding changes.
8. If reconstruction or relational tests are desired, conduct them using a separate chosen procedure and preserve the target, exact answer before feedback, timings, instructions, prior exposure, and assistance used. Building test interfaces is outside this implementation. Without these inputs, later reconstruction-accuracy metrics are unavailable.
9. Stop collecting at the chosen endpoint and retain all raw bundles and original media.
10. Only then transcribe/analyze and calculate desired metrics across games. Distinguish training from evaluation, assistance exposure from unassisted performance, and input errors from inferred memory failures.
11. Use synchronized footage and the strongest supported findings to create the YouTube narrative, including uncertainty about why performance changed.

## (c) One-time setup and per-game flow

### One-time setup

1. Install/reload the extension after the collection implementation is complete.
2. Select microphone, webcam, and screen/tab capture source; grant the browser's required permissions. The browser may request capture selection again for later sessions.
3. Verify voice, face, board, and game/extension audio in a disposable export. Check that announcements remain audible during capture and that microphone audio is usable separately.
4. Choose a local experiment directory and a backup location for exported bundles.
5. Define the protocol and remembered session defaults. Audit Chess.com visual aids/settings for strict baseline/evaluation play; hiding pieces alone does not hide move history or every aid.
6. Complete the collection validation before recording baseline game one. Do not count disposable setup games as baseline.

### Each game

1. Set up the Chess.com bot game and ensure intended blindfold/assistance settings are in place. Do not make the first move yet.
2. Select Baseline, Training, or Evaluation and confirm remembered conditions; fill in any unavailable bot/settings fields.
3. Click Start and approve capture prompts if required.
4. Wait for the microphone, screen, webcam, and saving indicators to show ready. The sync marker is generated automatically. If the bot can move first, start recording before triggering the game so its first move is captured; otherwise flag the late start.
5. Play normally. Think aloud according to the session protocol. The recorder automatically saves game events and the full media streams. No manual counts or per-move notes are required.
6. After the game, optionally give a short spoken reflection while recording continues.
7. Click Stop. If the ending is unknown, supply a brief reason such as abandoned or resigned.
8. Wait for media finalization and download the game ZIP. Check whether the bundle reports complete or interrupted recording.
9. Extract the ZIP into the experiment root and retain the bundle/media in the backup location. No analysis is required at this stage.
10. Repeat for the next game. Conditions are remembered, but each game receives its own identity and normally its own media files.

The same flow applies to all three baseline games, practice games, and later evaluation games. Neither a detected game ending nor a result announcement stops recording automatically; the explicit Stop action preserves the opportunity for post-game commentary.
