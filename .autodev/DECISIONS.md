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