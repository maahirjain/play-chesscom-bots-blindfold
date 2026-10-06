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
