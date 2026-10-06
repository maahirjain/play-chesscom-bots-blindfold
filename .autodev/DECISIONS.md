# DECISIONS.md

Consequential engineering decisions with reasoning and evidence. Newest first.

## 2026-10-06 — Task 1.3 review decisions (from independent review)

1. **Malformed IDs → TypeError (not RangeError).** The 1.3 contract's §2.10
   parenthetical listed "non-uuid IDs" under RangeError, but AC5/AC15
   explicitly require TypeError for missing/malformed sessionId/gameId/
   clockSegmentId, and the 1.1 precedent (`requireValidMetadata`) throws
   TypeError for malformed IDs. Decision: the builder was right; the
   contract parenthetical was the outlier. Contract amended: TypeError =
   wrong type/shape *including malformed IDs*; RangeError = value outside
   an allowed domain (bad event-type syntax, bad sourceContext,
   negative/non-integer sequences, malformed refs role names).

2. **Envelope has 11 keys, not 12.** The 1.3 contract repeatedly said "(12)"
   but its own §3.3 shape lists 11 keys; the implementation, key-order test,
   and createEvent literal all agree on 11. Corrected the contract,
   build report, code comments, and test names. No behavior change.

## 2026-10-06 — Task 1.2 repair decisions (from independent review)

1. **`normalizePlayerColor` uses the 1.1 domain model (RangeError for all
   out-of-domain values).** The builder had routed non-string playerColor
   through the string normalizer's type gate (TypeError), but the contract's
   own 1.1 anchor throws RangeError for `sessionCategory: 1`, the convention
   table lists "bad color" under RangeError, and AC6 says "anything else →
   RangeError". Decision: null/undefined → null; whitespace-only → null;
   'white'/'black' (trimmed) pass; everything else including non-strings →
   RangeError. `normalizeBotRating` keeps TypeError for floats/negatives
   (AC7 explicitly mandates it — a deliberate, documented asymmetry).

2. **`'__proto__'` assistance-setting key is rejected loudly (TypeError).**
   Assigning `out['__proto__'] = val` hits the inherited setter and silently
   drops the observation — the wrong failure mode for a never-silently-drop
   contract. Only JSON.parse-style own data properties can carry this key
   (object literals can't), but the validation function must still be
   robust. Rejection surfaces the problem instead of corrupting the record.

## 2026-10-06 — Task 1.1 repair decisions (from independent review)

1. **`addGameToSession` throws on duplicate explicit gameId.**
   Reviewer found silent double-append of the same UUID would violate PLAN
   §3(a) "unique IDs establish identity". Decision: throw plain `Error`
   (not TypeError — the module's convention is TypeError = wrong type;
   a duplicate is a logic/detection bug). A duplicate at the §3.5 detection
   layer must surface as evidence, not silent corruption. Normal flow
   (fresh `newGameId()` per detection) never triggers it.

2. **Identity records are frozen (append-only).**
   Reviewer found returned records were caller-mutable, risking §5/§2 call
   sites pushing into `gameIds`. Decision: `Object.freeze` the record and
   its `gameIds` array at creation. Verified storage-safe: structuredClone,
   JSON, and IndexedDB do not preserve frozenness, and `addGameToSession`
   tolerates frozen inputs (tested). If §1.2 later extends the record shape,
   the contract needs an amendment — flagged in 1.1 evidence, not fixed now.

## 2026-10-06 — Preflight decisions (coordinator)

1. **Local git is the durable engineering store; GitHub sync is batched.**
   `gh` is unauthenticated and the MCP `github` CLI exposes no token for
   `git push`. Local commits/checkpoint refs give full durability now;
   remote sync via MCP `push_files`/`create_branch` is batched for when the
   owner can approve. Rationale: owner instruction §10 explicitly permits
   this; never block engineering on remote sync.

2. **Coordinator = top-level chat agent; phase subagents per X.X task.**
   A separate long-lived coordinator subagent was considered, but live-browser
   Chess.com work and GitHub writes must be initiated at the top level
   (subagents must not drive the managed browser; write approvals surface to
   the user). The chat agent coordinates; planner/builder/reviewer/verifier
   subagents do phase work and report back.

3. **Behavioral verification in two tiers.**
   The managed browser cannot load unpacked extensions. Tier 1: headless
   Chrome (via puppeteer, `--load-extension`) for V2/V3 synthetic verification
   of content scripts, service worker, IndexedDB, and media recording with
   fake devices. Tier 2: managed-browser tasks for real Chess.com DOM/session
   checks (selectors, bot-game observation) — browser tasks report
   observations; they cannot run the extension. Real-DOM replay: capture
   Chess.com DOM snapshots via browser task, replay under Tier 1.

   Concrete harness (2026-10-06, verified working): `~/workspace/tools/ext-verify/`
   with puppeteer + Chrome 154 headless. `smoke.js <scripts...>` loads repo
   scripts as classic scripts in a real renderer (file:// secure context) and
   asserts contract behavior incl. structuredClone round-trips. Extension also
   launches cleanly under `--load-extension`. Real content-script injection
   tests (matching-URL pages, DOM fixtures) to be added as tasks require.

4. **ZIP export: hand-rolled store-only writer, no dependency.**
   Keeps the extension dependency-free (matches current repo: zero deps) and
   works offline in the extension context. Deflate via `CompressionStream`
   only if needed; stored entries are sufficient for raw bundles.

5. **Tests: `node --test` for pure logic; no test framework dependency.**
   Extension-context tests run under headless Chrome. Keeps the repo
   dependency-free and reproducible.

6. **Credential hygiene.** Chess.com credentials live only in the Secure
   Vault and the managed browser's fill flow. They must never appear in chat,
   repo files, evidence, logs, or agent context. Browser tasks use the saved
   login; no agent ever sees the values.

7. **Puppeteer `--load-extension` needs `--disable-extensions` removed.**
   Puppeteer's default args include `--disable-extensions`, which silently
   neuters `--load-extension` (no targets register, no errors). Extension-load
   harnesses must pass `ignoreDefaultArgs: ['--disable-extensions']`
   (found during 2.1 AC5 verification).

8. **`about:blank` is an opaque origin for IndexedDB probes.** In
   `about:blank`, `indexedDB.databases()` throws SecurityError. Origin-
   isolation probes (e.g. proving the extension DB is invisible to pages)
   need a real localhost origin, not `about:blank`. (Found during 2.2
   V2 verification.)

9. **Notes for the §2.4 (transactional writer) contract.** (a) `db.js`'s
   `withStore` resolves on request success, not `transaction.oncomplete`;
   the 2.4 writer must require commit-awaiting semantics. (b) A record
   missing its keyPath makes `store.put` throw a raw DOMException
   (DataError) synchronously rather than a wrapped plain Error — the
   2.4 contract should wrap or document this surface. (Found during 2.2
   review + behavioral verification.)

10. **Content-script→SW `sendMessage` with no listener REJECTS.**
    When no `onMessage` listener is installed in the SW, a content
    script's `chrome.runtime.sendMessage` rejects with a generic Error
    ("Could not establish connection" / "Receiving end does not exist"),
    it does NOT resolve `undefined`. Senders must treat rejection as
    "unacknowledged, keep queued". (Found during 2.3 V2 verification —
    the sender records `transport-error:Error` and stops the pump.)
    **Nuance:** when a listener IS installed but returns `false` without
    calling `sendResponse`, the promise *resolves `undefined`* (this
    Chrome build) rather than hanging. `undefined` is never an ack —
    the 2.3 sender already treats it as unacknowledged. (Found during
    2.4 behavioral verification.)

11. **Sender retry policy (§2.5): 10 s send timeout + 5 s fixed retry.**
    Each send races the transport against a 10 s timeout (`Promise.race`,
    loser discarded — a late ack cannot double-dequeue; if it was
    `{ok:true}` the retry's byte-identical resend is absorbed by the
    writer's eventId dedup). Failed head-of-queue attempts schedule one
    fixed 5 s retry timer (at most one pending); retry is uniform — no
    classification of transport errors, timeouts, or writer `{ok:false}`
    rejections. Fixed interval, not backoff: one sender per context, no
    herd; failures are transient-seconds or persistent-forever. No
    `pagehide`/unload flush was added (considered and rejected): the ack
    path is dead at unload so durability can't be confirmed; the honest
    mechanism is `sourceSeq` gaps plus 2.7's discontinuity marking.
    Background-tab timer throttling (~1 s observed) slows the cadence but
    doesn't break it. (Built 2026-10-06.)
    - **For 2.8:** under uniform retry, a permanently-rejected head
      (e.g. quota exhaustion) wedges the queue loudly but indefinitely.
      2.8's status surfacing should distinguish persistent `{ok:false}`
      (`lastError` writer string, retrying forever) from transient
      transport failure. `getStatus()` already provides `pendingCount`,
      `lastError`, `retryScheduled`. (2.5 review NOTE-1.)
    - **Refactor warning:** `err === timeoutError` identity
      discrimination is safe only because `timeoutError` is
      per-attempt closure-private. If the timeout mechanism is ever
      refactored (e.g. shared error instance), this must become a
      generation token. (2.5 review NOTE-3.)

## 2.6 SF-1: writer fails honestly on corrupt sequence_state (was: silent renumber to 0)

- **Decision:** `writer.js` seqReq.onsuccess now distinguishes absent
  counter (new session → `next = 0`, legitimate) from present-but-malformed
  counter (`nextAppendSeq` non-numeric/non-integer/negative, or
  `rec.sessionId` mismatch → `fail()` with a `CorruptSequenceState`-named
  error, producing ack `write-failed:CorruptSequenceState`).
- **Why:** the 2.6 adversarial review (SF-1) found the old fallback
  incoherent with 2.6's restore-side corruption honesty: the writer would
  silently fork the append sequence (duplicate `appendSeq` values, silently
  corrupted §6.2 ordering) while `restoreSessionState`/`getSequenceState`
  threw on the same condition. Failing the write routes through the 2.5
  retry path and gives 2.8 a stable machine-matchable code.
- **Unreachable via mission code paths** (writer is sole writer, always
  writes well-formed counters) — only external corruption (devtools,
  foreign code, disk failure) can trigger it. Defense in depth, not a
  live-path change.
- **Test evolution:** 2 new writer tests (corrupt counter, sessionId
  mismatch); session_store.test.js byte-identical pin for writer.js →
  exact-diff pin for the repair; sender/session_store git-status
  allowlists admit writer.js. All honest cumulative evolution.

## 2.7: page/context lifecycle — start/end events + SW-side discontinuity detection

- **Three event types** (`page_start`, `page_end_clean`,
  `page_discontinuity`), owned by the new `lifecycle.js` per the 1.3
  task-owns-constants precedent; `event_envelope.js` untouched.
- **2.5 tension resolved**: `page_end_clean` is a single best-effort
  `emit()` on `pagehide` — `flush()` is NEVER called at unload. Its loss
  is the designed-for trigger case. bfcache `pagehide` (`persisted=true`)
  skips emission. Conservative by design: may flag a clean reload whose
  end lost the race; never hides a real gap.
- **Detection runs on every committed `page_start`** (via the writer's
  generic post-commit hook `fireAfterEventStored`), not just after SW
  restarts — the next start subsumes the restart case. No eager SW-startup
  check (no new information without a new start).
- **Marker's honest meaning**: "when context N started, context M (older)
  had no clean end and no prior marker on record" — NOT "M crashed".
  Concurrent tabs / lost races / late ends documented; markers are
  point-in-time, never retracted (append-only history).
- **Deviation from the 2.6 contract's downstream note**: lifecycle state
  lives in the event stream (queried via the `bySessionId` index), not the
  2.6 triple — the triple is untouched. `session_store.js` byte-identical.
- **SW anchor**: lazy per-(SW-instance,session), sourceSeq 0, written via
  `writeEvent`; discontinuities at 1, 2, …. lifecycle.js performs zero
  raw IDB writes (sole-writer invariant). Per-session promise-chain
  serialization prevents double-marking; temporal guard (anchor
  `utcEpochMs` strict `<`) handles out-of-order delayed starts.
- **§5 seam**: `BlindfoldSession.activeSessionId` (null until §5 sets it
  at Start); content.js gains one line (`installPageEndHook`); §5 owns
  calling `emitPageStart` and session continuity.

## 2.7 review NOTEs (carried forward, no action now)

- **Refactor warning:** the per-session promise-chain keepalive in
  `lifecycle.js` is incidentally protected against unhandled rejections
  (the chain-keepalive `.catch()` shields the discarded promise), not
  explicitly. Any future refactor of the chaining must preserve this or
  add an explicit guard. (2.7 review.)
- **§5 decision needed:** session scoping across tabs controls the
  `page_discontinuity` marker noise rate (concurrent tabs on the same
  session = conservative false positives by design). §5 should define
  whether tabs share a session or get distinct sessions.
- Spurious-marker rate on clean reloads is unmeasured until V3/AC18
  (real-browser lifecycle timing).

## 2.8: manifest.json gains status_indicator.js (deviation from 2.8 contract AC10)

- **Decision:** the 2.8 contract's AC10 said `manifest.json` byte-identical
  to HEAD, but `status_indicator.js` must be in the content_scripts js list
  to load in the content-script world (no `importScripts` there; inlining
  into content.js would break module conventions). The js list gains exactly
  one entry after `'lifecycle.js'`; the manifest pin is exact-diff, not
  byte-identical.
- **Also:** repaired 7 stale 2.7 post-commit diff-discipline pins (they
  asserted on `git diff HEAD`, empty after the 2.7 commit) by converting
  them to durable content assertions. No pin weakened.
- **Harness finding:** the sender only keeps a writer's error string when
  the ack's `eventId` matches the head event (`recordAckFailure`); a
  writer bug dropping eventId would surface as transient-amber (`no-ack`)
  rather than red. Possible §5/2.9 follow-up: treat `no-ack` after N
  attempts as persistent. (2.8 build note #2.)

## 2.9 retention: no deletion paths; export must not delete originals

- **Survey (2026-10-06):** zero deletion paths in product code — no
  `indexedDB.deleteDatabase`, no `objectStore.clear()`/`delete()`, no
  TTL/expiry/pruning logic. `db.js` `closeDatabase()` closes the cached
  connection handle only (verified callable with no indexedDB; never
  touches data). Pinned by `tests/retention.test.js` (AC1–AC4).
- **No deletion API added.** PLAN.md mentions deletion exactly once
  (§2.9 itself); "until deliberate deletion" is a retention guarantee,
  not a feature request. A deletion API would be new footgun surface
  against the mission's data-preservation bias. "Deliberate deletion" =
  explicit owner/developer action outside the extension (e.g. devtools
  → Application → IndexedDB → delete; profile wipe). If the owner wants
  in-extension deletion, that is a §7/owner decision.
- **Binding constraint on §6 export:** export must read through readonly
  transactions/cursors only (`db.js` `getAll`/`get`), must never call
  `delete`/`clear`/`deleteDatabase`, and §6's tests must assert store
  record counts are identical before and after export (the concrete,
  testable form of "export must not delete the originals"; also implied
  by §6.7 repeatable export). Authority: 2.9.contract.md §6.

## 3.1: history tracker design decisions

- **updateGame removed** (not wrapped): its contract — silent
  reset-on-shorter, unvalidated `game.move()` with ignored return —
  is exactly what 3.1.1/3.1.2/3.1.5 replace. A wrapper is impossible
  (the tracker owns its game instance); dead code is worse. Flagged
  explicitly in 3.1.contract.md §2.10.
- **Shorter-divergent observations go to the suspect window, not
  correction**: the contract's step 5/6 boundary was ambiguous for O
  divergent but shorter than C. A truncated divergent list is the
  ambiguous case 3.1.5 names; a complete divergent history is a
  revision. (3.1.build.md deviation 2.)
- **manifest.json gains game_records.js**: the 1.4 payload factories
  were not loaded in the content-script world; the tracker needs them.
  Minimal necessary change (3.1.build.md deviation 1).
- **Immediate takeback on strict prefix** (contract §2.4 rationale): a
  clean strict prefix is semantically a takeback; a transient
  shorter-prefix glitch self-corrects via a follow-up correction
  revision, and the stream stays honest about what the DOM showed.
- **Null gameId = track-but-don't-emit**: gameplay (board, speech)
  works without §5; recording waits for game identities. Honest
  phased-mission seam, not a defect.

## 3.2 design decisions

- **Attempt lifecycle**: `createAttemptTracker` in chess_utils.js —
  pending → matched | unconfirmed | terminal-at-birth. Emission gated on
  non-empty sessionId AND gameId via thunks (pre-§5 inert; no dangling
  half-lifecycles). Matching is FIFO on (from, to, promotion); null
  eventIds never link (3.2.5 honesty).
- **First-edit time** (3.2.1): one monotonic timestamp per attempt from
  the first `input` event; programmatic field clears don't fire `input`.
  No keystroke contents/counts/timings, ever.
- **No normalized string stored** (3.2.3): `submittedText` is verbatim;
  the normalized form is derivable from submittedText + position via the
  versioned `normalizeMove`.
- **makeMoveOnBoard returns `true` | DISPATCH_FAILURE_REASONS member**
  (3.2.4): the five `return false` sites now return their specific
  reason. Single caller (content.js) updated; Enter handler is async.
- **3.2.7 — rejected mouse attempts outside guaranteed coverage**:
  mouse input goes directly to Chess.com's own handlers; the extension
  observes only the resulting move list (3.1 covers confirmed mouse
  moves). There is no reliable DOM signal for a *rejected* mouse attempt
  — no error element or state change observable without speculating from
  click coordinates (which would be fabrication, violating the mission's
  honesty rule). Guaranteed coverage: keyboard attempts only. V3 (§7)
  will audit the live DOM and document findings.
- **Minor implementation deviation**: `createFirstEditCapture` helper
  extracted in chess_utils.js (not named in the contract) to make the
  first-write-wins/reset logic unit-testable; content.js wires it to the
  input listener.

## 3.3 visibility and assistance (PLAN.md §3.3)

- **3.3.4 unsupported-coverage marking (explicit):** codebase survey found
  zero references to Chess.com hints, assistance settings, or
  engine-evaluation DOM in product code. The extension does not observe
  Chess.com hints or assistance-setting changes, and no observer was built:
  recording unreliably-observed "hints" would manufacture evidence. The
  1.2 `assistanceSettings` conditions field is a session-level record, not
  a DOM observation. If a V3 live pass finds a reliable DOM signal, this
  marking is revisited (see 3.3.domaudit.md).
- **Epistemic disclaimer (3.3.5):** extension visibility events
  (`piece_visibility_changed`) record what the extension did to the board's
  piece rendering. They do **not** prove the player had no other visual
  information: Chess.com's own highlights, eval bar, arrows, a second
  monitor, screen-reader output, or anything else outside the extension's
  observation is invisible to these events. Any analysis treating "pieces
  hidden" as "player saw nothing" is unsound.
- **Help = spoken-assistance shortcuts only** (`w/m/z/i/s`); `j`
  (navigation), `v` (visibility), `Escape` (3.4 speech cancellation) are
  explicitly excluded. Content-less requests record `hadUsableContent:
  false` — the request happened (3.2.6 precedent).
- **`setPieceSet(mode, source)`:** source vocabulary
  `init/keyboard/session_start/api`; unchanged mode emits nothing; board
  re-render re-application emits nothing (no state change).
- **3.2 SF-1 precedent applied:** all recorder calls in keydown handlers
  are failure-isolated; instrumentation never breaks speech/UX.

## 3.4 speech instrumentation

- **SPEECH_LOGIC_VERSION bump rule (3.4.4):** `BlindfoldSession.SPEECH_LOGIC_VERSION`
  (currently `'1'`) versions the speech-text generation logic. Any change to
  `sanToSpeech`, `getResultAnnouncement`, `positionToSpeechText`,
  `getDisambiguation`, or the shortcut text templates REQUIRES bumping the
  version — otherwise analysts cannot replay historical utterances from the
  linked events. `utterance_started` records the version with every utterance.
- **Spoken-text rule (3.4.4):** `utterance_started.text` is null unless the
  call site opts in. The single production opt-in is `speakPosition`'s
  `"Board not found."` DOM-failure text (not reproducible from any event).
  Everything else is reproducible from the linked event + versioned logic.
- **Cancel correlation (3.4.3):** requested cancellation is recorded per
  in-flight utterance at `speechSynthesis.cancel()` time; the later
  onend/onerror maps to `cancelled` only if a request was recorded —
  otherwise `completed`/`error`. Never trust callback names alone.

## 3.5 game/session lifecycle (PLAN.md §3.5)

- **3.5.1 honesty:** `document_visibility_changed` records raw document
  state (`visibilityState`, `focused`) only. The payload and event names
  contain no `pause`/`attention`/`away` tokens, and the code carries an
  explicit epistemic disclaimer: these events do not imply, and must not
  be interpreted as, a cognitive pause, attention shift, or player
  absence. No debouncing or aggregation — raw observations only.
- **3.5.2:** 3.1's `onGameReset` now receives `{ confirmedMoveCount }`
  (additive; captured before `confirmed` is cleared). Existing nullary
  stubs keep working. Takebacks stay `history_revised` (3.1.4); reloads
  stay `page_start` (2.7) — no duplication.
- **3.5.3 result-dialog audit — UNSUPPORTED (explicit marking):** no
  reliable Chess.com game-over dialog signal could be verified. The 3.3
  domaudit §6 already placed result dialogs outside current selectors
  [code-analysis]; public research surfaced only unverified third-party
  candidates (e.g. `.game-over-modal`, `.board-modal-container` from
  community userscripts — not verified against the live page, and
  Chess.com changes its DOM frequently). Per the 3.3.4 precedent, no
  observer is fabricated: content.js installs no dialog observer, and
  `recordDialogEnded` is a designed-but-unwired recorder method. **Revisit
  in §7** with live-page verification.
- **"Reconnect" — UNSUPPORTED (explicit marking):** no reliable
  Chess.com reconnection signal was found during the 3.5 audit; page
  reloads are already recorded as new page contexts (`page_start`, 2.7).
  **Revisit in §7** if a verified signal emerges.
- **3.5 SF-1 repair — game_ended schema reconciliation (adversarial
  review):** 3.5 initially shipped a second, incompatible `game_ended`
  schema (`{termination, source, speechLogicVersion}`) with its own
  `TERMINATIONS` vocabulary and a same-named
  `requireValidGameEndedPayload` that silently shadowed 1.4's validator
  on the merged namespace. Repaired: 1.4 owns the `game_ended` schema
  (`{result, terminationReason, evidenceSource, observedText}`,
  `TERMINATION_REASONS`, `EVIDENCE_SOURCES`, factory + validator in
  game_records.js — untouched). The 3.5 recorder binds 1.4's factory via
  `sharedBS()` (3.1 precedent) and never redefines the schema; the
  shadowing regression is pinned in tests/game_lifecycle.test.js AC0.
  Termination vocabulary is 1.4's 9-member `TERMINATION_REASONS`
  (`checkmate`, `stalemate`, `resignation`, `timeout`, `draw_agreed`,
  `draw_insufficient_material`, `draw_fifty_move`, `draw_threefold`,
  `abandoned`) with null = unknown (1.2's unknown convention). The
  3.5 `GAME_END_SOURCES` (`chess_rules`, `chesscom_dialog`, `stop`) is a
  recorder-internal dedup vocabulary only — never persisted; the persisted
  evidence source is 1.4's `EVIDENCE_SOURCES`.
- **Dedup semantics (SF-1):** per-SOURCE idempotency — each source
  records at most once per game — but multiple `game_ended` events per
  game are permitted across sources, per 1.4's consumer contract
  (consumers take the latest by occurrence time). A manual Stop
  completion therefore supersedes an earlier auto-detection instead of
  being suppressed. `resetEnded()` re-arms all sources for a new game.
- **Source mapping onto 1.4's schema:** chess_rules →
  `evidenceSource: 'observed'`, `observedText: null`, result/termination
  derived from the board (`chessRulesTermination`/`chessRulesResult`,
  mirroring `getResultAnnouncement`'s conditions — covered by 3.4.4's
  `SPEECH_LOGIC_VERSION` bump rule); chesscom_dialog → `'observed'` with
  the raw display string in `observedText` (exactly what 1.4 designed it
  for; §7); stop → `'manual'`, result default `'*'`. `game_ended` refs
  stay sparse (`{ terminalMoveEventId }` or null).
- **3.5.4 §5 seam:** `recordStopTermination(reason, result)` — reason is
  a 1.4 `TERMINATION_REASONS` member or null (null = unknown; PLAN §7
  suggests `abandoned`/`resignation`), result is a PGN result or `'*'`
  (default `'*'`). Exposed as `BlindfoldSession.gameLifecycleRecorder`;
  §5 calls it from the Stop control and `resetEnded()` when minting a
  new game identity.
- **3.2 SF-1 precedent applied:** all 3.5 recorder calls from DOM
  listeners/wiring are failure-isolated; instrumentation never breaks
  the page.
## 4.1 dedicated recording context (PLAN.md §4.1)

- **Offscreen document, supervised by the SW.** The recording context is an
  MV3 offscreen document (`recorder.html` + `recorder.js`), created and
  supervised by `recording_host.js` (imported by `sw.js`). This is the
  sanctioned Chrome pattern for `getUserMedia`/`getDisplayMedia` +
  `MediaRecorder` in MV3: the SW is killable and lacks media APIs; content
  scripts and popups are explicitly forbidden by PLAN 4.1 (they die on
  refresh/focus loss); a persistent extension tab would be user-visible and
  user-closable. The document is extension-owned and independent of every
  content tab, so Chess.com page refreshes cannot touch it.
- **Full reason set up front.** `createDocument` is called once with
  `USER_MEDIA` (4.2 mic, 4.4 webcam) + `DISPLAY_MEDIA` (4.3 screen/tab) +
  `AUDIO_PLAYBACK` (4.7 game/extension audio, 4.11 audible sync marker) and a
  justification citing synchronized session recording. There is exactly one
  offscreen document per extension and it hosts all of Section 4, so
  declaring the full set up front is honest and avoids a later recreate to
  widen reasons. 4.1 itself performs no capture (pin-tested absent).
- **Recording platform APIs live ONLY in recorder.js.** Never in content
  scripts, never in the SW. `recording_host.js` touches `chrome.offscreen` /
  `chrome.runtime` only and is self-sufficient (it does not import
  recorder.js; its envelope check is local, avoiding a cross-module
  dependency in the SW).
- **Chrome 116+ constraint (documented, not solved).** `chrome.offscreen`
  requires Chrome 109+, but `hasDocument()` is Chrome 150+; the supervisor
  therefore detects the document via `chrome.runtime.getContexts()` on
  Chrome 116–149 (review SF-1). The repo declares no
  `minimum_chrome_version`; `ensureRecordingContext()` degrades honestly
  with `{ok:false, reason:'offscreen-unavailable'}` (plain data, never
  throws) instead of changing the manifest floor.
- **Chunk bytes never travel through SW messaging.** Media chunk bytes
  (potentially hundreds of MB) are written by the offscreen document
  directly to the extension-owned IndexedDB (2.2) — same extension origin,
  shared storage partition. 4.8 defines the chunk schema; 4.1 only
  establishes the path. Recording-*lifecycle* events reuse the existing
  transactional writer intake (`{kind:'event', ...}` direct from the
  offscreen document to writer.js) — no relay, preserving append-sequence
  guarantees. 4.1 builds no new pipeline.
- **Message channel namespacing.** `{kind:'recorder', msg, v:1}` can never
  collide with the writer's `{kind:'event'}` on the shared
  `chrome.runtime.onMessage` bus. Receivers are lenient-on-input (unknown
  kinds/msgs ignored, no response) and reject unknown protocol versions
  with `{ok:false}` — never throw. The `recorder-pong` carries a
  `performance.now()` hook for 4.10/4.12 clock-anchor alignment.
- **SW-startup wiring never throws.** `start()` installs the
  recorder-channel listener and kicks a lazy `ensureRecordingContext()`;
  failures are swallowed (retried on demand), so a broken recording context
  can never break SW boot.
- **Harness limitation (documented).** Forcing a true SW-process death via
  CDP proved flaky in headless Chrome (`Target.closeTarget` kills the
  worker but wake-up is unreliable; a DevTools-attached browser does not
  apply the 30s idle timeout). V2 therefore proves re-discovery with a
  fresh `createRecordingHost` (blank in-memory state — exactly what a
  restarted SW has) against the real document: same bootId adopted, zero
  duplicate `createDocument` calls. The restart path executes the identical
  `start()` → `ensure()` code; a natural restart on the owner device (§7)
  will exercise the true process boundary.

## 4.2 microphone selection and permission handling

- **4.2 delivers a selected, permitted microphone — not a recording.**
  `device_selection.js` (`createDeviceSelector`, `audioinput` for 4.2,
  reusable for 4.4 `videoinput`) handles enumeration, user selection,
  persisted selection, the permission probe, and queryable state. Every
  probe stream's tracks are stopped before `requestPermission` resolves;
  4.6 re-acquires at Start and owns stream lifetime.
- **Persistence: the offscreen document's `localStorage`, not
  `chrome.storage.local`.** V2 proved offscreen documents expose only
  `chrome.runtime` — `chrome.storage` is undefined there even with the
  `"storage"` manifest permission — so the contract's chrome.storage
  plan could not work. The selection persists under the same
  `blindfold.micDeviceId.v1` key in document localStorage (same extension
  origin; §5's popup reads the same store). No manifest change, no
  event-DB schema change; the selector's injected storage interface is
  unchanged. (A brief `"storage"` permission addition was reverted.)
- **Permission honesty.** `permissions.query` is advisory;
  `getUserMedia` outcome is ground truth. Denial is a persisted *state*,
  not an exception; a probe-observed `'denied'` persists until a later
  probe succeeds (an advisory query never clears it). Stale selections
  are invalidated on `OverconstrainedError`. Labels are `null`
  pre-permission (never fabricated). 4.2 never silently defaults.
- **Events** (`microphone_permission_changed`,
  `microphone_device_selected`) travel the existing writer intake
  directly from the offscreen document (`{kind:'event', event}`,
  `sourceContext:'recording_context'`, lazy per-session `clock_anchor`);
  pre-session inertness follows the 3.x precedent. Session-activation
  announces the current selection once per session with its ACTUAL
  source (`'user'` vs `'restored'`, never relabeled); the
  restore/set-session race is closed by announcing on whichever
  completes last (idempotent dedup).
- **No UI in 4.2** (§5 owns it). Five channel messages
  (`recorder-set-session`, `mic-list-devices`, `mic-select`,
  `mic-request-permission`, `mic-get-state`); all failure-isolated.
  `recording_host.js` gained no 4.2 behavior.

## 4.3 screen/tab capture selection and permission handling

- **Surface: `chrome.tabCapture` primary, `getDisplayMedia` user-driven
  fallback.** Tab capture is deterministic (no per-session picker),
  install-time queryable, and carries tab audio (4.7's feed).
  `chrome.desktopCapture` excluded (Chrome-Apps-only). The persisted
  `captureMode ∈ {'tab','screen'}` is the selection; 4.3 delivers selection
  and permission handling, not recording.
- **chrome.* split, verified live.** CDP `Runtime.evaluate` inside the real
  offscreen `recorder.html` target proves it exposes only `chrome.runtime`
  (`chrome.tabs`/`chrome.tabCapture`/`chrome.permissions` all absent); the
  SW exposes `chrome.tabs` + `chrome.tabCapture`. All `chrome.*` calls
  therefore live SW-side in the new `capture_broker.js`
  (`resolveTargetTab`, `queryCapturePermission`, `getStreamId`); the
  offscreen document only runs `getUserMedia` with `chromeMediaSource`
  constraints and stops every track (probe-then-stop, no retention — 4.2
  precedent).
- **Manifest:** `"tabCapture"` permission (V2: `permissions.contains`
  reports `'granted'`, install-time effective) + `host_permissions:
  ["https://www.chess.com/*"]` (lets `chrome.tabs.query({url})` see the
  game tab). Both required, both kept.
- **Empirical tab-probe outcome (observed, not fabricated).** Headless
  Chrome refuses `getMediaStreamId` with "Extension has not been invoked
  for the current page" (no toolbar invocation headless); the probe
  honestly reports `{ok:true, permissionState:'unknown', errorName:'Error'}`.
  The doc-leg API surface is proven independently: a bogus-streamId
  `getUserMedia({chromeMediaSource:'tab', ...})` in the offscreen document
  returns `AbortError: "Error starting tab capture"` — the constraint
  format is recognized and capture is attempted. No BLOCKER declared.
- **Permission honesty.** Tab mode queryable (granted/denied); screen mode
  inherently `'prompt'` — `capture-request-permission` for `'screen'`
  performs no media call and returns `note:'picker-at-start'`. Denial is a
  state. Tab ids re-resolved per boot/Start, never persisted; no-target-tab
  → honest `tabId:null`, no active-tab fallback. Persistence in document
  localStorage (`blindfold.captureMode.v1`, 4.2 precedent); never silently
  defaults.
- **Events** (`screen_capture_permission_changed`,
  `screen_capture_selected`) travel the existing writer intake from the
  offscreen document, session-gated (4.2's recorder-set-session reused);
  `event_envelope.js` untouched. 4.7 consumes the probe's `audioIncluded`
  flag. Four channel messages, all failure-isolated; the three SW-leg
  broker messages route through `recording_host.js` with async `{ok}`
  responses.
- **V2 harness note:** `offscreenTarget.page()` does not attach to
  offscreen documents in this Puppeteer version; use
  `target.createCDPSession()` + `Runtime.evaluate` instead
  (`~/workspace/tools/ext-verify/sw-screencapture.js`, 42/42 checks).

## 4.4 webcam selection and permission handling

- **Near-mechanical 4.2 reuse.** `createDeviceSelector({kind:'videoinput'})`
  instantiated beside the mic selector in the offscreen recorder; persisted
  key `blindfold.cameraDeviceId.v1` (document localStorage, 4.2 precedent);
  event types `camera_permission_changed` / `camera_device_selected`;
  channel family `cam-list-devices` / `cam-select` /
  `cam-request-permission` / `cam-get-state`; `recorder-set-session`
  shared across both selectors (independent instances). No UI (§5), no
  manifest changes, no resolution/framerate/facingMode policy (4.6's).
- **The one genuine factory gap:** `runPermissionProbe` hardcoded
  `{ audio: ... }`; it is now kind-branched so a camera probe requests
  `{ video: ... }` (exact deviceId when selected, `true` otherwise) and
  never carries an `audio` key. Probe-then-stop holds: every track
  stopped before the probe resolves; no stream retained; 4.6 re-acquires
  at Start (the probe→start revocation race is 4.6's case).
- **Validator messages parameterized.** The shared payload validators
  took an optional event-type name (microphone_* defaults preserved for
  backward compatibility); the factory passes each instance's names so
  camera failures never mislabel themselves.
- **"Saved separately from the screen" is 4.6's boundary.** 4.4 delivers
  a selected, permitted camera and stops; the separate-stream wiring
  does not exist yet and 4.4 builds none of it.
- **Repair during V1: `restoreDevices()` awaited only the first
  selector's restore (real race).** A 4.4 restore test failed because the
  camera restore was still in flight when the caller proceeded. Repaired
  to `Promise.all` over all three selectors' best-effort restores (each
  rejection swallowed; still never throws).

## 4.5 recording format verification and the recording manifest

- **Manifest = a mutable IDB store, not events.** `recording_manifest`
  (keyPath `segmentId`, `bySessionId` index) in the extension-owned DB;
  `DB_VERSION` 1 → 2. Events are append-only and immutable (2.4) — the
  wrong home for a record that 4.5 writes at stream start, 4.10 anchors,
  4.12 timecodes, and 4.13 finalizes. `applySchema()` creates the store
  idempotently on upgrade; no user data touched (§2.9). §6.3 reads this
  store for media-sync.json.
- **4.5 owns eight format-identity fields** (`segmentId`, `sessionId`,
  `gameId`, `streamKind`, `requestedMimeType`, `actualMimeType`,
  `fileExtension`, `createdAtUtc`); 4.10/4.12/4.13's fields are reserved
  and their later validator-widening must be deliberate (exact-keys
  convention rejects anything else).
- **Format verification is always re-probed** (`isTypeSupported` is
  synchronous and cheap) — no cache, no staleness. Frozen prioritized
  candidate lists per kind (VP9 → VP8 → H.264 → bare container; Opus
  audio); an empty list is an honest "cannot start", never a silent
  fallback to an unverified type. Unavailable API → plain Error, never a
  fabricated list.
- **`fileExtension` derives from the ACTUAL negotiated MIME type**
  (`recorder.mimeType`), never the requested string; unknown → `null`,
  never fabricated. 4.6 must pass the real `recorder.mimeType` at stream
  start (4.6's V2 proves the read; 4.5's V2 honestly stops at the store
  existing and a synthetic-payload write).
- **No new event types.** Format support is queryable state
  (`recorder-get-formats` on the recorder channel), not an event; 4.14
  owns status reporting. No `MediaRecorder` construction in 4.5 (only
  `isTypeSupported` probing); no manifest-permission changes.
- **V2 finding:** the offscreen document loads `db.js` and writes the
  manifest direct to the extension-owned IDB (4.1's direct-IDB path) —
  proven readable from the SW, same origin, same partition.

## 4.6 stream start

- **4.5 §2 amendment: 4.6 mints the segmentId, not 4.10.** 4.5's contract
  said "4.10 assigns segmentIds," but the manifest record must be written
  *at stream start* and its keyPath *is* `segmentId` — a record cannot be
  written without its key. 4.6 mints uuid-v4 segmentIds at stream start;
  4.10 links clock anchors to these IDs instead of minting new ones; 4.13
  mints only post-discontinuity segments. (Flagged for the section-4
  auditor by the 4.6 contract itself.)
- **`MANIFEST_KEYS` 8 → 13 is deliberate, not drift.** 4.5's exact-keys
  validator was the mechanism that *forced* this to be a deliberate
  decision: 4.6 widens the shape with nullable start-time fields
  (`streamStartedAtUtc`, `streamStartedAtMonotonicMs`,
  `audioTrackPresent`, `videoTrackPresent`, `captureMode`) that later
  tasks fill without another silent widening. The exact-keys convention
  holds — any future widening must be equally deliberate (4.10/4.12/4.13).
- **4.6 = plumbing, 4.7 = audio-content policy.** 4.6 passes through
  whatever audio tracks acquisition yields and records their presence
  (`audioTrackPresent` per stream); 4.7 verifies game-audio content,
  bleed, and mix policy. No AudioContext, no track merging in 4.6 —
  V1-pinned separateness (three streams, three recorders).
- **`recorder.start()` with NO timeslice; `ondataavailable` unset.** 4.6
  owns starting the recorders; 4.8 owns all data availability
  (`requestData()` polling recommended over timeslices). The
  `getActiveStreams()` registry (`{stream, recorder, segmentId}`) is the
  seam 4.8/4.9/4.13 consume.
- **Screen-mode picker honesty.** Whether `getDisplayMedia` works in a
  hidden offscreen document was genuinely unknown; probed empirically —
  it resolved under headless/fake-ui, so V2 exercised the real
  screen-mode path. On a real headed device the picker may need
  transient activation; the `picker-unavailable` degradation (honest,
  V1-pinned) is the answer, not a fabricated workaround. AC12 (real
  device) stays deferred to §7.
- **Failure isolation is per-stage and leak-free.** Five failure stages
  (verify-formats → acquire-stream → construct-recorder → start-recorder
  → write-manifest); one stream's failure never blocks the others;
  partial tracks are stopped; a manifest-write failure stops the live
  recorder (no orphans, no record-without-recorder). `recorder.js`
  references zero media-capture APIs — the starter reads document
  globals lazily — so the 4.1/4.2/4.3 boundary pins pass unmodified.
- **V2-found real bug:** the document-global `getDisplayMedia` fallback
  returned the method unbound → `TypeError: Illegal invocation` in the
  real document (V1's injected fakes never caught it). Repaired to a
  bound caller + V1 regression test.

## 4.7 audio-content policy

- **4.7 = policy, not acquisition.** 4.6 already acquires the screen
  stream's audio wherever the platform offers it (tab mode requests tab
  audio through the SW broker; screen mode requests `{audio:true}` via
  getDisplayMedia). 4.7 classifies what that audio track *can* contain
  by construction and writes the classification into the manifest —
  it acquires nothing new, builds no mixer, and performs no content
  analysis (the mission's raw-collection rule forbids it).
- **New module `audio_policy.js`** (DOM-free, repo module pattern):
  `classifyScreenAudio({captureMode, audioTrackPresent})` →
  `'tab-audio' | 'system-audio' | 'none' | null`;
  `assertMicAudio({audioTrackPresent, audioTrackCount})` →
  `'device-only' | null`. Pure functions; classification can never fail
  a stream (malformed input → `null`; a policy throw is swallowed by the
  starter and yields nulls — V1-pinned).
- **Mode×content matrix (contract §1.1):** tab+track → `'tab-audio'`
  (the tab's rendered audio only — game sounds; system/extension audio
  EXCLUDED by platform construction); screen+track → `'system-audio'`
  (whatever the OS mixer delivers — MAY include game sounds and
  extension speech IFF the user ticked "Share system audio"; the
  checkbox is outside our observation boundary); either mode without a
  track → `'none'`; unknown/unrecorded mode with a track → `null`
  (never guessed).
- **`speechSynthesis` routing fact (contract §1.3):** 3.4's spoken
  announcements render through the platform TTS engine to the SYSTEM
  audio output — not through any tab's audio pipeline, not a
  MediaStream we own. Tab-mode capture therefore CANNOT contain
  extension speech by platform construction; screen mode can, iff
  system audio is shared. 4.7 must not fabricate an audio pipeline (no
  routing speechSynthesis into a MediaStream — the platform offers
  none to an extension offscreen document). 3.4's event log says what
  was spoken and when; 4.7 says which recordings could possibly contain
  the sound; correlation is §6/§7 territory.
- **Acoustic bleed is a physical reality, not a defect (contract
  §1.4).** The microphone transduces whatever sound reaches it,
  including speaker output. No software suppression, filtering, or
  echo-cancellation policy is attempted (no mic-constraint changes);
  mitigation is the owner's (headphones, mic placement). Device caveat:
  if the owner's selected "mic" is itself a loopback / stereo-mix /
  virtual-cable device, the mic stream may contain game/extension audio
  by DEVICE CONFIGURATION — traceable via `effectiveDeviceId` (4.6),
  never second-guessed here.
- **Manifest widens deliberately 13 → 15:** `screenAudioContent`
  (screen records only) and `micAudioContent` (mic records only), both
  nullable, uniform record shape (null elsewhere). format_support.js
  resolves the validators at call time from the shared namespace
  (sender.js precedent); absence is a wiring defect (plain Error).
- **The "intentional mix" prohibition is testable:** V1 code-scan pin
  over all seven offscreen scripts forbids `AudioContext`,
  `webkitAudioContext`, `AudioDestinationNode`,
  `createMediaStreamDestination`, and `AnalyserNode` in executable
  code (4.6's separateness re-pinned). The mic recorder carries exactly
  the mic device's audio track(s) — structural.
- **No new event types, no new channel message:** classifications ride
  `recorder-start-streams` responses + the manifest record; 4.14/§6.3
  read from there. The MSG_* vocabulary and the nine event names are
  V1-pinned unchanged.

## 4.8 incremental chunk extraction

- **Storage: the 2.2 `media_chunks` store, ratified — no schema change.**
  Task 2.2 created `media_chunks` (compound keyPath
  `[segmentId, chunkIndex]`) with the comment "§4.8 incremental chunks;
  §6.4 ordered assembly"; 4.8 ratifies it. No OPFS (second storage
  mechanism, second quota/retention story, no functional gain — IDB
  structured-clones Blobs natively and §6.6's streaming export works over
  an IDB cursor), no in-memory (defeats the purpose), no DB_VERSION bump,
  no new index (export scoping: manifest `bySessionId` → segmentIds →
  chunks by compound-key prefix). `DB_VERSION` stays 2.
- **`requestData()` polling, not timeslice (4.6's recommendation,
  contracted in 4.8).** One `setInterval` per stream at the named,
  V1-pinned `CHUNK_POLL_MS = 5000` ± 10% jitter (lockstep avoidance);
  ticks skip when `recorder.state !== 'recording'`; a `requestData()`
  throw is a missed tick, never a stream failure. A timeslice fires on
  the recorder's clock whether or not data exists and cannot be aligned
  with write backpressure; polling gives 4.8 control (skip, back off,
  stop per stream). 5 s balances incremental durability against IDB
  write volume; tuning is §7 territory.
- **Chunk identity = `[segmentId, chunkIndex]`, 0-based per segment.**
  The index is reserved synchronously at chunk acceptance — a V1 test
  caught the alternative (assigning the index in the write's `.then`)
  allowing two rapid chunks to share a key, which IDB `put` would
  silently overwrite (data loss). A failed write therefore leaves a gap,
  never a duplicate; 4.13 reads in key order. 0-byte Blobs are dropped
  before acceptance (not stored, index not consumed, counted in
  `emptyPolls`); they are not misses. `streamKind`/`sessionId`/`gameId`/
  `byteLength` are not persisted (derivable rule); `timecodeMs` is stored
  raw from the event for 4.12, never analyzed.
- **Miss and failure semantics are fail-loud / fail-closed.** No
  `dataavailable` within `CHUNK_REQUEST_TIMEOUT_MS = 2000` counts a
  miss; 3 consecutive misses → `chunk-stalled`, loop stopped (4.9 decides
  the durable log shape). `QuotaExceededError` on write → stop that
  stream's loop immediately (`chunk-quota-exceeded`, no retry spin
  against a full quota); other rejections → `chunk-write-error` with
  name/message preserved in state. The recorder is untouched — the
  recording continues; the failure is visible (4.14 reports it per
  stream), never silent. No new event type in 4.8 ("recorder errors" is
  4.9's PLAN language).
- **Restart honesty.** Already-written chunks persist (extension-owned
  IDB); in-flight data the encoder holds but 4.8 has not yet requested
  dies with the document — no API recovers it, none is fabricated. Poll
  timers die with the document; 4.8 does not resurrect recorders. 4.9
  logs the discontinuity; 4.13 re-segments; §5 decides restarts.
- **4.13 seam.** `stopForStream()`/`stopAll()` stop the poll loops, but
  the `ondataavailable` handler stays attached: the final `dataavailable`
  from `recorder.stop()` is stored as a chunk like any other, and 4.13
  must await it before declaring a segment finalized. `getChunkState()`
  exposes exactly `{status, lastChunkIndex, lastWriteAtUtc,
  consecutiveMisses, emptyPolls, lastErrorName, lastErrorMessage}`
  (in-memory; the durable trace is the chunks) for 4.9/4.13/4.14.
- **No new channel message.** Chunking starts automatically for every
  successfully started stream (recorder.js kicks it off after
  `recorder-start-streams` resolves — Start implies record; §5 surface
  stays minimal). The kickoff is best-effort and wrapped: chunking can
  never fail the streams or the channel response. The MSG_* vocabulary
  and the nine event names are V1-pinned unchanged. `recorder.js`
  references no media-capture APIs (4.1 boundary holds).
- **No manifest widening** (chunk counts are derivable via key-prefix
  count; standing rule). No concatenation, no Blob assembly, no
  playback UI, no transcoding, no chunk deletion (4.13 / §2.9).
- **Forward note for 4.13:** there is no awaitable for the final `stop()`
  flush — the ondataavailable handler stores it as a chunk but 4.8
  exposes no promise for it. 4.13's contract must address how finalization
  waits for (or times out on) that last chunk. 4.13 must also tolerate
  non-contiguous chunk indexes (failed writes leave gaps by design).

## 4.9 track/error/discontinuity monitoring

- **Log-shape decision: events, not the manifest.** All 4.9
  observations (track mute/unmute/end, recorder errors, discontinuity
  flags) go to the append-only event log (2.4); the manifest gains
  nothing. Rationale: observations are timestamped occurrences (the
  event system's purpose); `emitRecorderEvent` already stamps
  `clockSegmentId` + `monotonicMs` at the source, which is exactly the
  time model 4.10/4.12 need; §6.3 export and 4.14 status read one
  timeline, not two stores; the `{kind:'event'}` writer transport is
  proven by the 4.2/4.3/4.4 selector events, so no new channel message
  and the `MSG_*` vocabulary is unchanged. Known limitation: sends are
  best-effort (no retry queue); chunk/manifest records are the backstop
  for gap detection.
- **Three new event types** (1.3 convention, own constants in
  `track_monitor.js`): `recorder_track_state_changed`
  `{streamKind, trackKind, muted, ended, baseline}` (every transition,
  no debounce — a debounce policy would be lossy; baseline at attach so
  4.14 knows the starting state; listeners detached after `onended`),
  `recorder_error` `{streamKind, errorName, errorMessage,
  recorderState}` (verbatim platform strings, no diagnosis), and
  `stream_discontinuity` `{streamKind, reason, lastChunkIndex,
  supersededSegmentIds, detail}`. The six reasons: `track-ended`,
  `recorder-error`, `chunk-stalled`, `chunk-quota-exceeded`,
  `chunk-write-error` (exactly chunk_writer.js's terminal statuses —
  the mapping is the identity), `restart`.
- **Chained emission is deliberate:** the observation event
  (`recorder_track_state_changed` / `recorder_error`) fires *then* the
  `stream_discontinuity` flag, same tick. Different consumers read
  different events (4.14 status vs 4.13 re-segmentation); deriving
  discontinuities instead of logging them would violate "explicit".
- **Chunk-writer terminal seam:** optional `onTerminalState` factory
  option on chunk_writer.js, exact-once per stream per terminal
  generation (a re-started kind gets a fresh state), never throws into
  the chunker. Rationale for a callback over monitor-side polling:
  exact-once, no second timer, no timing ambiguity. Absent → 4.8's
  behavior is unchanged.
- **Restart detection:** the manifest (extension-owned IDB) survives
  document death; the dead document's recorders do not. So the new
  document's `recorder-start-streams` handler pre-checks the manifest
  for this sessionId *before* starting new streams
  (`getManifestRecordsBySession`, additive on format_support.js);
  pre-existing unfinalized records → one `stream_discontinuity`
  `{reason:'restart', supersededSegmentIds}` per affected kind, with
  `refs.segmentId` = the new segmentId (null when that kind failed —
  the old generation is dead either way). 4.13's finalized marker is
  4.13's to define; until defined the exclusion matches nothing.
  Streams that never start (4.6 failure stages) get no 4.9 logging —
  the start-streams response is the record.
- **muted ≠ silent; no why.** `track.muted` is a platform flag; 4.9
  logs the flag, never claims silence (the 4.7 no-content-inference
  rule, applied to track state). No device diagnostics, no
  "the user unplugged the mic" claims. `recorder.onstop` at Stop is the
  expected end — 4.13's territory, not a discontinuity.
- **Monitoring can never fail the pipeline** (the 4.8 precedent,
  extended): every handler body try/catch-guarded, malformed tracks
  skipped, throwing emitEvent tolerated, and recorder.js's
  monitoring attach + restart emission are independently best-effort
  from 4.8's chunking kickoff.

## 4.10 clock-segment linking

- **One new manifest field, 15 → 16 (`clockSegmentId`, `// 4.10-owned:`).**
  The link between the two identity systems: at stream start the
  active recording-context clock segment's ID (the `clock_anchor`'s
  `segmentId`) is written into the recording's manifest record, so
  4.12 can convert any recording-relative timestamp
  (`streamStartedAtMonotonicMs`, chunk `timecodeMs`) to wall clock via
  the named anchor. Everything else the link needs is already present
  or derivable: `streamStartedAtMonotonicMs` (4.6) is on the same
  monotonic clock, the anchor row lives in the event log, link time =
  `createdAtUtc`.
- **The linker forces the lazy anchor capture.** The offscreen
  document captures its anchor lazily at first emission; the linker
  calls recorder.js's `ensureAnchor()` before writing the link —
  honest, because the anchor describes the document's already-running
  clock. Capture failure → `null` link, never a stream failure.
- **Identity-only, no arithmetic.** The linker reads `anchor.segmentId`
  and nothing else — V1 code-scan-pinned (no `utcEpochMs`, no
  `monotonicMs`, no `deriveWallUtcMs` in executable code). Offset
  computation is 4.12's.
- **Links survive media gaps; restart = new link.** A mid-recording
  discontinuity (4.9) does not change the clock segment — the clock
  continues; only the media timeline has a gap. Document restart = new
  `performance.now()` origin → new anchor → new `clockSegmentId`;
  old manifest records keep their old links (the manifest survives in
  extension-owned IDB) — which is why the link belongs in the manifest,
  not document memory. V2-proven: kill/recreate → new anchor → new
  links; superseded records keep old links.
- **4.13 seam:** 4.10 owns ALL linking. 4.13 calls the same
  `linkClockSegment({segmentId, getAnchor})` for each post-discontinuity
  segmentId it mints (same document → same anchor id, still written
  fresh so the record is self-describing). Exposed via recorder.js's
  `getClockLink()`; new additive `getManifestRecord(segmentId)` read
  on format_support (keyPath IS segmentId — no new index, DB_VERSION
  stays 2). No new event types, no new channel messages, no manifest
  writes outside the starter's write stage (4.9's modules are
  scan-pinned to never touch the manifest).
- **PLAN reading note (for the section-4 auditor):** PLAN.md §4.10's
  "Give every recording segment an ID" half was already satisfied by
  the 4.5 §2 amendment (4.6 mints uuid-v4 segmentIds at stream start);
  4.10's work is the link half. PLAN.md itself is never modified.

## 4.11 audible/visible sync markers at start and stop

- **PLAN says both ends.** PLAN.md §4.11 requires markers at session
  start AND stop (the §7.9 check is "markers align with event timestamps
  at both ends of a recording"). 4.11 builds the mechanism, wires the
  START marker into the start-streams final `.then` (iff ≥1 stream
  started), and defines the exact `emitStopMarker()` seam 4.13 must call
  BEFORE `recorder.stop()` — so the stop marker is captured before the
  final flush. 4.11 does not wire the stop marker itself (auditor check,
  not a defect).
- **One markerId, two modalities, two source timestamps.** Audible:
  880 Hz sine, 250 ms per beep, 44.1 kHz 16-bit mono WAV
  (`sync_beep.wav`, generated deterministically — the generation command
  is in the 4.11 build report), 1× at start / 2× at stop (150 ms
  onset-to-onset; the two beeps share the markerId, ordered by the event
  log's own sequence). Visible: 200 ms fullscreen white flash on the
  Chess.com page (`sync_flash.js` content script). Each modality emits
  its own `sync_marker` event synchronously with play/flash — the
  envelope's `monotonicMs` + `clockSegmentId` ARE the source timestamps
  (standing rule: no derivable values persisted).
- **Audible plays in the offscreen document** (`AUDIO_PLAYBACK`
  rationale — it survives page refreshes, 4.1's whole point) via
  `HTMLAudioElement` ONLY. **Not a mixer** (4.7 re-pin): the tone is
  played into the room through the speakers — acoustic, like 4.7's
  bleed reality. Nothing is routed into any MediaStream; the 4.7
  no-`AudioContext` code-scan pin passes UNMODIFIED.
- **Visible flash is a page overlay** because the flash must be ON the
  captured surface: the offscreen document is never visible, the SW
  cannot show UI, and notifications would miss tab mode. New content
  script `sync_flash.js` (manifest `content_scripts` gains it;
  `content.js` stays byte-identical); 200 ms of photons, not UI —
  `pointer-events: none`, no focus calls, no overlay listeners, so the
  3.2 move-input path and 3.3 visibility instrumentation are untouched.
- **Exactly one new channel message** (`recorder-sync-flash`):
  offscreen → SW relay via `recording_host.js`'s `onRuntimeMessage`
  (the 4.3 broker precedent); the SW resolves the target tab through
  the 4.3 capture broker and `chrome.tabs.sendMessage`s
  `{kind:'blindfold-sync-flash', markerId, phase, sessionId}`.
  `sessionId` rides the relay additively: the visible event's envelope
  requires it and the page's `activeSessionId` is not set pre-§5 — the
  offscreen document's 4.6 no-session guard is the authority at marker
  time. `MSG_*` snapshot gains exactly one value (deliberate).
- **Failure honesty (marker never fails recording).** `play()` is async:
  the 'played' event is emitted synchronously with the call (the honest
  record of the attempt, timestamped at the beep time); a later
  rejection emits a second event with `status: 'failed'` and the
  verbatim error (the honest record of the outcome) — events are
  append-only, nothing is rewritten. Relay `{relayed:false}` →
  visible `status: 'skipped'` with the honest reason (`no-target-tab`,
  `send-failed`, …). Zero started streams → no marker at all.
- **Honest capture matrix.** Mic captures the beep acoustically;
  screen-mode system audio may include it iff shared (never tab mode —
  the tone is not tab audio); the webcam is video-only by design and
  its alignment rests on the flash-if-in-frame (physical, not promised)
  or 4.10/4.6/4.12. Audibility/visibility IN the recordings needs human
  senses — AC11/§7.9.
- **No manifest widening** (markers are per-generation, events-only —
  the 4.9 precedent); `DB_VERSION` stays 2; no offset computation (the
  marker module does no timestamp arithmetic — 4.12's territory); no
  marker detection in recordings (content analysis, forbidden). §6.3's
  `media-sync.json` reads marker events from the log; 4.12 consumes
  them for per-stream offsets.
- **Forward requirement for 4.13 (PLAN §4.11 covers stop too):**
  `emitStopMarker()` is defined but NOT wired — 4.13 must call it
  before `recorder.stop()`, allowing enough capture time for the
  double-beep (150 ms onset-to-onset) to be distinguishable. The
  section-4 auditor must verify this wiring; until then the stop
  marker is mechanism-only. 4.12's contract should state the
  played-vs-failed disambiguation rule for marker events.

## 4.12 timecode/offset arithmetic

- **4.12 persists nothing — the §0.1 PLAN reading note.** PLAN §4.12
  says "save timecode/offset information," but every offset is a pure
  function of already-stored values (4.6 stream starts, 4.8 raw
  `timecodeMs`, 4.10 clock link, 4.11 marker source timestamps), so
  persisting computed offsets would violate the standing
  no-derivable-values rule. The "save" half is satisfied in aggregate;
  4.12's distinctive contribution is the calculation half: the
  canonical nine-function `timecode.js` library. `MANIFEST_KEYS` stays
  16, `DB_VERSION` stays 2. (If the section-4 auditor disagrees, the
  remedy is a deliberate documented widening — not silent drift.)
- **First task allowed timestamp arithmetic.** All prior tasks were
  identity-only by pin; `timecode.js` is the single home for
  recording-alignment math. `wallUtcMs` is V1-pinned equal to
  `event_envelope.deriveWallUtcMs` — one formula, one home for
  alignment use.
- **Chunk-arrival time is never frame time** (PLAN's prohibition):
  `receivedAtMonotonicMs` is ordering evidence only; no 4.12 function
  takes it. Null/unusable `timecodeMs` → exact media time honestly
  unknown (`null`), never arrival-time-as-truth.
- **Marker disambiguation (required by the 4.11 review):** only
  `'played'`/`'shown'` sync markers participate in alignment;
  `'failed'` means no acoustic/optical anchor exists — its timestamp
  is not a media landmark. Stop double-beep: earliest `'played'` per
  `markerId` by `appendSeq`.
- **A library, not a pipeline stage:** `timecode.js` has zero platform
  surface and is deliberately NOT wired into `recorder.html` — 4.13's
  contract decides. Consumers: 4.13 (per-piece wall times), 4.14
  (status), §6.3 `media-sync.json` (the alignment timeline; §6.3 owns
  the join logic, 4.12 owns the math).
- **V2 characterization (headless Chrome 154, fake devices):**
  `timecodeMs` = [0, 0, 4654.8, 4831.4] over 4 chunks — first chunks
  carry 0 (initial `requestData()` flush before the encoder advanced),
  then genuinely advancing media times. One implementation's behavior
  is not a spec guarantee; §7/AC11 re-characterizes on the owner's
  device.

## 4.13 finalize recordings at Stop

- **Module name is `finalizer.js` (contract wins over the spawn brief).**
  The parent brief said `stream_stopper.js`; the contract (§1, §8, AC8)
  is authoritative and names `finalizer.js` / `tests/finalizer.test.js`.
  Flagged in the build report; no functional impact.
- **"Finalize" closes the chunk set; it never assembles a file.**
  4.13 stops, splits, numbers, marks. No §6.4 assembly, no §6.6 ZIP, no
  downloads/OPFS writes — the contract's §6.4/§6.6 prohibitions are
  V1-pinned by code scan.
- **`finalizedAtUtc` IS 4.9's reserved `MANIFEST_FINALIZED_FIELD`.**
  `recorder.js` sets the reservation to the literal `'finalizedAtUtc'`;
  4.9's `isManifestRecordFinalized()` exclusion then works as designed
  (restart pre-check skips finalized segments; finalize passes skip
  them — idempotence). No other 4.9 change.
- **MANIFEST_KEYS 16 → 18 is the deliberate widening** (`segmentNumber`,
  `finalizedAtUtc`, `// 4.13-owned:`). `DB_VERSION` stays 2, no new
  store/index. `recordSegmentFormat` accepts/defaults both to null.
  **Contract inconsistency flagged:** AC8's file list omits
  `format_support.js`, but AC2 requires the widening — the change was
  made; the build report records the inconsistency.
- **The atomic split re-key needs raw indexedDB.** `BlindfoldSession.DB`
  exposes only `put`/`get`/`getAll` — no delete, no multi-store
  transaction — so the finalizer uses the injected `indexedDB` directly
  (lazy `globalThis.indexedDB`, the db.js pattern) for the single
  readwrite transaction over `['media_chunks', 'recording_manifest']`.
  Targeted `delete([seg,idx])` + `put(rekeyed)` by explicit key (no
  cursor, no IDBKeyRange). A mid-split document death leaves either the
  old keys or the new keys — never a mixture.
- **Splits only on media-both-sides; 'restart' never splits.**
  A non-'restart' discontinuity with `maxIdx > lastChunkIndex` mints a
  new uuid-v4 piece (fresh `segmentId`/`createdAtUtc`, fresh clock link
  via 4.10's linker — never copied, null on linker failure),
  re-keys post-gap chunks 0-based. Multi-gap segments split
  sequentially with original-coordinate base tracking. Split failure →
  best-effort unsplit finalize (the gap stays flagged in the event log).
- **Numbering is per (sessionId, streamKind), chronological by
  (createdAtUtc, segmentId), 1-based, assigned at finalize.**
  Deterministic and idempotent: finalized records are never renumbered.
  One `finalizedAtUtc` per pass.
- **Final-flush await is bounded and honest.** Poll `recorder.state` →
  `'inactive'` (≤5 s, 100 ms cadence), then 1 s write grace. Timeout →
  `flushTimedOut:true`, still finalizes with available chunks. No
  `lastChunkIndex` polling (0-byte flushes are legitimately index-less).
- **Stop-marker wait is once, globally (1000 ms).** After
  `emitStopMarker()`, before any `recorder.stop()`. Marker failure →
  `markerId:null`, never a Stop failure.
- **Monitor detach precedes track stop.** A clean Stop emits no
  spurious track-ended discontinuities (4.9 logs mid-session ends).
- **Crash recovery without marker.** No active streams + unfinalized
  orphans → finalize orphans (`note:'finalized-orphans'`, no marker —
  no media to align to). Double Stop → `note:'nothing-to-finalize'`.
- **Exactly one new channel message** (`recorder-stop-streams`;
  MSG_* 22→23). No new event types (manifest mark + 4.11's stop marker
  events are the trace). No `timecode.js` use (ordering by ISO string
  is not timestamp arithmetic). `finalizer.js` references no
  media-capture APIs (V1 code-scan pin).
- **V2 (headless Chrome 154, fake devices): 54/54.** Real start →
  chunks → real stop → response shape, stop-marker events with matching
  markerId, manifest `segmentNumber:1` + `finalizedAtUtc` per kind,
  registry discard (new start not already-started), double Stop
  no-op, second-generation numbering. The mid-segment split path is
  V1-pinned (post-gap media not forceable headless — documented
  honestly). Regressions: sw-chunks 42/42, sw-streams 57/57,
  sw-track-monitor 46/46, sw-sync-marker 43/43.

## 4.14 — Report per-stream recording status (PLAN.md §4.14)

- **The masquerade-driven design.** PLAN line 181: "Report each
  stream's status separately so microphone, screen, or webcam failure
  cannot masquerade as complete recording." The contract's §1.2
  masquerade table maps each failure mode to the exact status field
  that surfaces it — especially chunk-terminal states with a
  still-"recording" recorder (chunk-stalled while `recorderState` is
  'recording': lifecycle stays 'recording', the stall is a fact in
  `chunk.*` + `lastDiscontinuity`).
- **No smoothed 'error' lifecycle.** Lifecycle is `idle | recording |
  stopped | finalized`, derived mechanically from the §1.1 truth table
  (live registry entry → recording; no live + unfinalized manifest
  segments → stopped; no live + all finalized → finalized; nothing →
  idle). Failures surface as facts (`chunk.*`, `lastRecorderError`,
  `lastDiscontinuity`, `tracks[]`) — smoothing is how failures
  masquerade. A dead recorder ('inactive' state, still registered)
  still reports `recording` (the registry is the authority) with the
  true `recorderState` beside it.
- **Offscreen-local reads only, no event-log dependency.** The event
  log is SW-side; 4.14 reads the registry, chunk state, live tracks,
  manifest, and one new additive in-memory seam. Deliberate honesty
  boundary: status reports document-local live state, not a durable
  cross-generation timeline (the manifest tells that story; the SW
  log tells the event story).
- **Additive `track_monitor.getStreamHealth(streamKind)`.** Retains
  the last observed recorder error + discontinuity per kind,
  generation-scoped (cleared on detach/attach). No new listeners, no
  new emissions, monitor behavior otherwise unchanged. After a
  document restart the mirror is empty by construction.
- **"Required streams" is §5's policy, not 4.14's.** 4.14 reports
  facts per kind; §5 applies its required-set policy over them. The
  module contains no readiness/required vocabulary (V1 code-scan pin).
- **Status is read-only by construction.** `stream_status.js`
  references no `chrome.*`, no `document`, no indexedDB; the factory
  is fully injected and every injected read is guarded (a throwing
  read degrades to null/[] — a query must never fail because a live
  read did). The manifest read failing rejects, and the channel
  handler maps that to `{ok:false}` (the 3.2 SF-1 precedent); sync
  kind validation throws TypeError/RangeError (repo convention).
- **Exactly one new channel message** (`recorder-get-status`; MSG_*
  23→24, the recorder-get-formats precedent). Session-gated: no
  session → `{ok:false, error:'no-session'}`. The handler never throws
  into the channel. No new event types, no manifest widening (18
  keys), `DB_VERSION` stays 2, content scripts byte-identical, no
  gameplay change.
- **Record selection honesty.** Manifest identity/timing prefers the
  live registry (segmentId, startedAt*); manifest-only fields prefer
  the live segment's record, else the most recently created record
  (createdAtUtc is stamped at stream start so it orders generations —
  including the in-progress one whose segmentNumber is still null).
- **V1: 45/45.** Exact 17-key shape per kind, lifecycle truth table
  incl. the no-smoothing masquerade case, live `tracks[]` reads,
  health generation scoping (attach→retained, detach→null,
  re-attach→fresh), read-only code-scan pin, MSG_* 24-entry
  vocabulary, `RECORDER_MSG_GET_STATUS` export, no-session guard +
  `{ok:false}` mapping, MANIFEST_KEYS 18, DB_VERSION 2, double-query
  determinism, and diff discipline (22 suites evolved with
  justification comments).

## 5.1 — Compact Start/Stop control and per-stream health lights

- **In-page control, not a browser-action popup.** PLAN §(c) steps 3/4/7
  (click Start, wait for the four indicators, click Stop) all happen on
  the game page mid-play — a popup closes on focus loss. The 2.8 contract
  §3.7 already rejected a popup for the status surface. The 2.8 saving
  light keeps working; 5.1's cluster (Start/Stop button + mic/screen/
  webcam lights) sits beside it: four lights total, exactly PLAN §(c)
  step 4.
- **No-smoothing discipline carried from 4.14.** `classifyStreamStatus`
  is pure: lifecycle × adverse facts → the closed 7-state set
  (off-idle, failed-not-started, recording-healthy, recording-degraded,
  stopped-finalizing, finalized, unknown). The chunk-stalled-with-
  recorderState-'recording' masquerade case stays recording-degraded
  (amber), never green; `detail` carries raw fact strings as the
  tooltip. "Ready" is not defined here — 5.6 owns the required-set
  policy.
- **New SW-side message `recorder-ensure`** (in the existing
  {kind:'recorder', v:1} envelope; SW-side vocabulary 5→6). Only the SW
  can call chrome.offscreen.createDocument; without it Start's messages
  would go to a non-existent listener and fail silently — the exact
  masquerade §4.14 exists to prevent. No new offscreen-document
  messages: offscreen MSG_* stays at 24.
- **Open question closures.**
  1. Session-metadata persistence: there is no SW-side session intake
     message, content scripts cannot reach extension IDB, and
     createSessionMetadata requires a category in
     {baseline,training,evaluation} (no 'unknown' exists — fabricating
     one would violate 1.2.3). So 5.1 does NOT write session_metadata;
     session start is recorded through the sender event stream
     (emitPageStart, the 2.7 seam). The metadata record is 5.2's
     (category selection).
  2. GameId adoption on boot: the recorder now echoes `gameId`
     (additive, null when unset) in the recorder-get-status response;
     the reloaded control adopts {sessionId, gameId} honestly.
  3. 5.10 seam shape: `onStopComplete(stopResponse)` callback option on
     installSessionControls (default no-op) + `handle.getLastStopResponse()`.
     The FULL recorder-stop-streams response — including flushTimedOut —
     is handed over (the Section 4 audit carry-forward); content.js's
     install forwards to `BlindfoldSession.onSessionStopComplete` when
     present, which 5.10 will own.
- **Additive chess_utils.js getter** (`getLastObservedEnd`, a documented
  AC7 deviation): the 3.5.4 seam requires "null reason unless a
  game_ended was already observed". The observed ending is recorder
  state, so the getter lives on createGameLifecycleRecorder —
  read-only, set only for the observed sources (chess_rules,
  chesscom_dialog; never manual 'stop'), re-armed by resetEnded().
- **Additive recorder.js seams**: `ownerTabId` captured from
  sender.tab.id at set-session time (5.5's duplicate-Start guard seam;
  exposed via getOwnerTabId(); cleared when the session clears),
  plus the gameId echo above. No behavior change otherwise.
- **Stop-channel failure never silently reverts to idle** (contract
  §3.4.5): the control stays in 'stopping' with the honest failure as
  the button detail; the button stays enabled so the stop can be
  retried.
- **Boot adoption** (4.1 refresh survival): one recorder-get-status at
  install; {ok:true, sessionId} adopts (no new IDs minted, polling
  starts); {ok:false} → idle.
- **Known interim gap** (contract §6, 5.5-owned): between 5.1 and 5.5,
  a second tab's set-session could overwrite the active session
  identity — 5.1 provides the local interlock + ownerTabId; 5.5 owns
  the cross-tab refusal policy.
- **Manual termination-reason UI is unassigned by PLAN's task list**:
  5.1 passes null (unknown) per 3.5.4 — a §5 follow-up for owner
  decision, not a 5.1 defect.
- **V1: 43/43** (new tests/session_controls.test.js). Classifier truth
  table incl. the masquerade case; install guards; Start order
  (ensure → set-session → start-streams → slots + emitPageStart +
  poll); per-stream failure isolation; honest ensure/channel aborts;
  Stop with observed-reason passthrough; flushTimedOut handoff;
  stop-failure no-silent-idle + retry; throwing onStopComplete
  isolation; boot adoption incl. null-gameId honesty; diff discipline
  (content.js diff = install block only; recorder.js = ownerTabId +
  gameId echo; recording_host.js = recorder-ensure; chess_utils.js =
  getter; offscreen MSG_* still 24; SW-side envelope vocabulary 6).
  ~30 earlier suites' pins evolved with justification comments.

## 5.2 — Baseline/training/evaluation selection + training approach & verbal scaffolding

- **New module `session_fields.js`** (contract pattern): `buildInitialConditions(selection, detectedFields)` — 2 selected fields trimmed to `{value, source:'manual'}`; 5 detected fields passed through untouched; `detectedFields` required (no silent default); bad category → RangeError. `UNDETECTED_CONDITION_FIELDS` stores the five 5.4-owned fields as `{value:null, source:'manual'}` — `'manual'` not `'observed'` because the closed source vocabulary has no "not yet attempted" value and `'observed'` would falsely claim a detection attempt. 5.4 corrects sources via the 1.2.4 change path.
- **Metadata-first minting**: `createSessionMetadata({extensionVersion, protocolVersion:null, sessionCategory})` → `addGameToSession(metadata, gameId)`; the sessionId sent to recorder-set-session IS `metadata.sessionId` (single-sourced identity). No new adopt-ID factory.
- **One new SW-side message `session-save`** ({metadata, conditions}) in the existing `{kind:'recorder', v:1}` envelope → recording_host validates BOTH records before saving either → `saveSessionMetadata` + `saveConditions` (2.6 primitives, previously unwritten). SW-side envelope vocabulary 6→7, pinned. Never throws into the listener.
- **Start order**: interlock → validate selection (no category → honest abort, nothing minted/persisted, no recorder message) → build records → recorder-ensure → session-save → recorder-set-session (now carries `sessionCategory` for the boot-adoption echo) → recorder-start-streams → slots + emitPageStart + poll. `options.sessionFields` optional (5.1 fallback preserved); `options.extensionVersion` required when fields present.
- **Closed the 3 open questions**: (1) DOM order = fields before the control cluster via `beforeElement` ("select then Start"); (2) session-save has no client-side timeout — the SW handler is total (every path answers), so SW death surfaces as rejected sendMessage, the 5.1 channel-failure pattern; a second timer would add double-handling risk; (3) emitPageStart keeps an empty payload — category/conditions live in the stores (§6.1 reads them).
- **5.3 seam**: install handle `{getSelection, setSelection, setEnabled}` (+ `getDetectedConditions` 5.4 plug-in); write-once rule: `setSelection` is a no-op while disabled; fields disabled while active, re-enabled on Stop.
- **Defect found & fixed in 5.2 (V2)**: after a successful Stop the recorder-side session was never cleared, so a page loaded after Stop adopted the dead (finalized) session with a stale category echo. The Stop success path now calls the existing best-effort `clearRecorderSession()` (set-session{null,null}); a failed stop keeps the session for retry. Pinned by 2 new V1 tests; all 5.1 stop tests unchanged.
- **V1: 1179/1179** (33 new session_fields tests + 2 new Stop-clear tests; ~30 earlier suites' pins evolved with justification comments). **V2: 53/53** (new `sw-session-fields.js`: exact IDB records, message order, honest no-category abort, mid-session disable, Stop re-enable, reload adoption with echoed category). **V2 regressions**: sw-session-controls 56/56, sw-stream-status 64/64, sw-stop 54/54, sw-chunks 42/42. Diff discipline: 0 deletions on main-origin files; AC11 V3 deferred to §7.

## 5.3 — Remember previous selections (chrome.storage.local)

- **New module `selection_memory.js`** (contract pattern): `createSelectionMemory({storage})` → `{restore, capture, STORAGE_KEY}`; `validateRememberedSelection` is a total function (never throws) returning a clean `{sessionCategory, trainingApproach, verbalScaffolding}` or `null`. `STORAGE_KEY = 'blindfold.sessionSelection.v1'` — versioned in the key, not the value.
- **Storage decision**: `chrome.storage.local` (extension-scoped, invisible to page JS, survives restarts) via an injected promise-shaped `{get,set,remove}` adapter built inline in content.js — the module never touches the `chrome` global directly (V1 comment-stripped pin). One additive manifest change: `"storage"` appended to `permissions` (exact value pinned cumulatively). IDB rejected (it's §2's raw-data store; reusing session_metadata/conditions would conflate defaults with records — the exact confusion §5.3 forbids); page-localStorage rejected (lives in chess.com's origin store, clobberable).
- **Remembered-fields set**: all three 5.2 fields as one record (PLAN says "previous selections" unqualified; editability answers the session-specific-text worry — remembered values are pre-filled but always editable pre-Start).
- **Capture timing**: once per session, at the Start-success point (`phase → 'active'`), via the single additive `onSessionStarted` option on `installSessionControls` (guarded in try/catch — a throwing callback can never break Start; optional so 5.1/5.2-era callers stay compatible). Aborted Starts capture nothing; no capture on edit or Stop; adopted sessions are not captured (known NOTE: after an adopted session stops and the page reloads, cold-boot restore may lag one session).
- **No-silent-change invariant, four independent mechanisms (all V1-pinned)**: (1) write-once (5.2) — setSelection while disabled is a no-op, so restore needs no enabled-check and both boot-adoption orderings are safe; (2) no record-write path — comment-stripped scan pins the absence of `session-save`, `saveSessionMetadata`, `saveConditions`, `indexedDB`, `chrome.runtime.sendMessage`; (3) capture reads the live form at Start — the only defaults→record flow is the explicit Start path; (4) no load-past-session path exists.
- **Failure honesty**: unreadable storage at boot → restore no-ops (fields stay blank); unwritable at capture → swallowed; `chrome.storage.local` unavailable → TypeError at construction, caught in content.js's install try/catch (degraded: no remembered defaults — the 4.2 selector precedent).
- **Non-goals**: no clear-defaults UI (one-line `storage.remove` — a §5 follow-up if the owner wants it); no device selections; no `chrome.storage.sync`; remembered prefs excluded from §6 export (local-only).
- **V1: 34 new selection_memory tests** (AC1–AC7 incl. the full Start harness: exactly-once firing with the recorded selection, no fire on abort paths, throwing-callback fault injection, and the capture→restore end-to-end loop). **V2: new `sw-selection-memory.js`** (AC8–AC10 + regressions). ~30 earlier suites' pins evolved with justification comments (5.3 allowlist blocks; permissions `['offscreen','tabCapture','storage']`; manifest js-list + storage-permission delta; kw53 content.js pin). AC11 V3 deferred to §7.

## 5.4 — Detected game conditions + manual completion (detected_conditions.js)

- **Detection verdicts (the 3.3.4 precedent)**: only `playerColor` is detected — `wc-chess-board` + `flipped` class, selector and logic both with in-repo precedent (chess_utils.js getBoardElement/squareToXY). `botName`/`botDisplayedRating`/`timeControl` are manual-only (deferred): no verified in-game selector exists; inventing one would risk matching the wrong element and fabricating a condition. `assistanceSettings` is manual-only by design (3.3.4 marks hints/assistance DOM observation as unsupported; never attempted).
- **Frozen `CONDITION_PROBES` table**: one entry per field; only playerColor `verified:true` (with a `verification:` citation); the rest `verified:false` with documented reasons and empty selectors. A future V3 probe populates entries without new architecture. AC3 code-scan pin forbids `verified:true` without a citation.
- **Source semantics (1.2)**: detection attempted ⇒ `'observed'` even on failure (`{null,'observed'}` = "we looked, found nothing"); `'manual'`-sourced nulls mean exactly "no detection attempted for this field in 5.4". 5.2's `{null,'manual'}` placeholders are corrected through the initial record at Start — no `conditions_changed` events in 5.4 (scope is "before recording"); the 1.2.4 path stays available for 5.9.
- **Merge at Start**: fresh `detectGameConditions(document)` merged with manual overrides — manual-dirty wins over detection; cleared-to-blank falls back to detection. Successful playerColor detection is read-only (no override affordance; PLAN's manual completion is for *unavailable* fields).
- **No silent fallback**: the 5.2 plug-in wrapper try/catches into placeholders, so the panel never throws for invalid manual input and never coerces it to null — invalid values pass through un-coerced; the 1.2 normalizers are the backstop (honest Start abort as `record-build-failed`). Builder clarification: a valid rating `"250"` is parsed to the number `250` (the 1.2 normalizer requires a number — passing the string through would abort an honest Start; this is type normalization of valid input, not the forbidden silent null-coercion).
- **assistanceSettings row editor**: (name, value, remove) rows with an always-present empty trailing row (no Add button); strict value parsing (`'true'`→true, `'false'`→false, finite numeric string→number, else trimmed string; empty→null); `"null"`/`"NaN"`/`"Infinity"` stay strings (1.2 "no sentinel" rule); blank-name rows ignored; `__proto__` names pass through to the 1.2 normalizer which rejects them loudly (no silent drop).
- **Wiring**: `installConditionsPanel` renders [fields → panel → Start → lights]; `attachConditionsPanel(fieldsHandle, panelHandle)` composite preserves the `isFieldsHandle` shape (setEnabled/showAdoptedCategory drive both forms, each in try/catch) so `session_controls.js` stays byte-identical. content.js installs the panel before the fields, passes the plug-in, and wraps; if the fields install fails the panel element is removed (no inert display). Manual completions are NOT remembered (5.3's scope fixed at three fields). Boot adoption disables the panel with the adopted note; install-time detection stays visible but labeled as current-page detection.
- **Closed the 3 open questions**: (1) panel anchors before the 5.1 control cluster via `beforeElement` (fields anchor before the panel); 2.8 fixed-corner fallback otherwise; (2) `"null"`/`"undefined"`/`"NaN"` parse as strings, never null/NaN; (3) Re-detect button labeled "Re-detect" (aria-label "Re-detect game conditions") — a manual refresh affordance, not a status.
- **V1: new tests/detected_conditions.test.js** (AC1–AC7). **V2: new `sw-detected-conditions.js`** (AC8–AC10 + regressions). ~30 earlier suites' pins evolved with justification comments (5.4 allowlist blocks; js-list pins; retention load-surface; clock_link/timecode working-tree pins). No new channel messages (offscreen MSG_* stays 24; SW envelope stays 7); no new event types; PLAN.md unmodified. AC11 V3 deferred to §7.
