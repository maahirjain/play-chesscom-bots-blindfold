# MISSION.md — autonomous logging-instrumentation mission (durable copy)

Condensed from the owner's mission prompt (2026-10-06). The full prompt lives
in the originating chat; this file is the durable reference for agents.

## Objective

Implement the entire logging/data-collection specification in `PLAN.md` end to
end in `maahirjain/play-chesscom-bots-blindfold`, working from branch
`autodev/logging-instrumentation`. Never autonomously modify `main`.

## Prime directives

1. `PLAN.md` is the human-owned source of truth. Do not silently change,
   weaken, reinterpret, omit, or remove requirements. Do not modify it without
   explicit owner approval.
2. Scope: raw data collection only. Preserve original observations/inputs.
   Do not persist derivable values. No analysis/metrics/transcription/engine/
   charts/dashboards/reconstruction-test UIs. No unrelated refactoring.
3. Represent unknown as unknown. Preserve actual failures, rejections,
   interruptions, uncertainty. Never infer stronger evidence than observed.
4. Optimize for correctness and verified quality over speed. Continue
   autonomously while the owner is away; contact them only for genuine owner
   judgment.

## Per-task workflow (every X.X subsection is one task)

A. Fresh planner/investigator: reads the PLAN subsection, inspects repo,
   prior decisions, regressions, dependencies; produces a task contract with
   acceptance criteria and how each is verifiable; flags what a later section
   must provide.
B. One builder: smallest coherent change for this task only; preserves
   unrelated behavior; adds automated tests where useful.
C. Mechanical verification: unit/integration/static/lint/schema/event-ordering/
   lifecycle/regression tests actually run; never claim an unrun test.
D. Fresh independent adversarial reviewer (not the implementer): objective is
   to find why the task is NOT complete (missed requirements, false
   assumptions, fabricated timing, duplicated persisted data, races,
   lifecycle/reload issues, scope creep, weak tests...). Implementation cannot
   self-certify.
E. Fresh behavioral verifier: exercises the real system where practical
   (real Chrome-extension behavior; controlled Chess.com bot games via the
   authenticated session). Labels simulated verification as simulated.
F. Repair loop: every substantive finding becomes a defect; fix, re-verify,
   re-review. After THREE failed repair attempts on the same problem, escalate
   to the owner.
G. Coordinator-only completion: all applicable requirements pass; deferred
   requirements explicitly named with dependencies; evidence written to
   `.autodev/evidence/<task-id>.md`; regressions recorded; decisions recorded;
   clean local commit; SHA recorded in STATE.json.

If a task references behavior from a later PLAN section: implement only the
current task, verify what is verifiable now, record the dependency, revisit
automatically later. Never claim planned/deferred work as verified.

## Verification levels

V1 static/code reasoning + targeted automated tests. V2 integration/runtime in
available environment. V3 black-box/browser behavior independently exercised.
V4 actual owner device/hardware. Record `AUTOMATED/SIMULATED: PASS` vs
`ACTUAL DEVICE: PENDING`; batch device checks for final acceptance.

## Human escalation (owner may be asleep)

Decide autonomously: implementation choices, naming, debugging, failing tests,
researchable APIs, experimentally determinable browser behavior,
reviewer-resolvable disagreements, git organization, engineering tradeoffs.

Ask the owner ONLY when: PLAN.md is contradictory/materially ambiguous;
choices materially change experiment semantics or user-facing behavior;
a requirement needs a spec/scope change; privacy/security/destructive/
irreversible owner judgment needed; 3 repair attempts failed; a critical
external limitation blocks all useful progress.

Escalation format: Decision ID, affected requirement, problem, evidence,
2–3 options with consequences, recommendation, blocked tasks, independent
work that can continue. Mark only affected work BLOCKED_HUMAN.

## Chess.com testing authorization

Authenticated session via Muse secure mechanisms, for this project only.
Allowed: controlled bot games, disposable test games/sessions, keyboard/mouse
move testing, visibility/help behavior, reloads, move-history observation,
game termination observation. Forbidden: live/rated human games, messaging,
purchases, unrelated account settings changes, credential exposure/copying.
On CAPTCHA/2FA/security challenge: notify owner, pause only affected work.

## Git and checkpoints

Work on `autodev/logging-instrumentation`. One clean local commit per
verified X.X task. Four cumulative immutable checkpoint branches:

- `autodev/checkpoint-01-data-contract` — after §1, milestone-audited.
- `autodev/checkpoint-02-instrumentation` — after §2+3, audited.
- `autodev/checkpoint-03-implementation` — after §4+5+6, audited.
- `autodev/checkpoint-04-auto-acceptance` — after §7 autonomous acceptance.
- `autodev/checkpoint-05-device-verified` — after owner device results pass.

Create checkpoints locally first; record SHAs in STATE.json. Remote GitHub
sync may need owner approval → mark PENDING_REMOTE_SYNC, batch it, never
block engineering on it. Do not stop at checkpoints for review.

## Milestone audits

Before each checkpoint: fresh milestone auditor reviews the ENTIRE accumulated
implementation (requirements, commits, architecture, storage semantics,
regressions, integration, dead code, scope creep, weak tests). Run the
regression suite. Fix issues, re-verify, re-audit. Only then checkpoint.

## Section 7 acceptance

Independent fresh agents adversarially falsify the implementation; real
Chess.com browser testing where practical; exercise failure/unusual cases.
Distinguish VERIFIED AUTONOMOUSLY / VERIFIED USING SIMULATION /
NOT VERIFIABLE WITHOUT OWNER DEVICE. Never fake device verification.

## Final device acceptance

Collect remaining manual checks into ONE checklist (build/commit, actions,
expected behavior, evidence to report, time estimate). Notify owner; mark
mission AUTO_COMPLETE_PENDING_DEVICE_ACCEPTANCE; preserve state.

## Calibration

Preserve honest evidence for workflow calibration: reviewer defects, repair
cycles, deferred verification, failed assumptions, autonomous vs human
decisions, environment limitations. Do not optimize evidence to look good.

## Stop conditions

Stop only when: (A) PLAN.md fully implemented + §7 autonomous acceptance
complete; (B) a genuine owner decision blocks all remaining useful progress;
(C) only actual-device/manual acceptance remains. Do not stop at section ends,
checkpoints, routine failures, or pending remote sync.
