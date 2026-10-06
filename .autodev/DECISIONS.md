# DECISIONS.md

Consequential engineering decisions with reasoning and evidence. Newest first.

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
