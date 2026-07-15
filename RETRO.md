# gloop v0.1.0 — a retrospective, pitched

## The bet

An issue tracker is already an agent harness: prioritized, self-documenting,
crash-safe, and legible to humans. So don't build an orchestration database —
make GitHub Issues *the* work queue, make one pi agent session *the* unit of
work, and make a PR *the* unit of landing. If the loop is sound, the project
should be able to build itself.

## What happened (about two hours, ~$18)

- **Bootstrap:** pi built the M0 scaffold by hand. Its acceptance test was
  literal self-hosting: *gloop completes one issue from its own tracker.*
  Issue #1 landed for $0.41.
- **Self-hosting:** every subsequent change — 18 more issues — was designed as
  an issue, worked by gloop, verified independently, and landed as a squash
  PR. 19/19 issues closed, 20 commits, tests grew 6 → 119.
- **Self-healing:** the loop's own failures became its backlog. A crashed run
  (GitHub search lag → duplicate work → non-fast-forward push) turned into
  three issues (#16, #21, #22) that gloop then fixed. Agents filed bugs they
  noticed mid-task (#29, #31) via `report_result.followUps`, and the same run
  picked them up and fixed them. Recursion depth 2; converged to empty queue.

## What made it work

1. **Structured exits.** Agents must finish by calling `report_result`
   (done / split / blocked + follow-ups). No prose parsing, no ambiguity, and
   decomposition is a first-class outcome rather than scope creep.
2. **The agent codes; gloop lands.** A guard extension blocks push, commit,
   PR/issue mutation, branch switching, and edits to gloop's own config. All
   state transitions live in the orchestrator. The guard also produced honest
   behavior: one agent noted it couldn't simulate a crash end-to-end *because
   the guard stopped it*, and said so in its PR.
3. **Trust but verify.** gloop re-runs tests/typecheck itself before landing.
   Cheap, and it makes "tests pass" a fact rather than a claim.
4. **Failure is a tracker entry.** Attempt markers, `gloop:blocked`,
   `gloop:needs-human`, lease reclaim — every bad outcome degrades into an
   issue a human can see and un-stick, not a lost stack trace.
5. **Last-known-good execution.** The running process never executes the code
   it's editing; new gloop takes effect on restart from merged main. Twice, a
   fix for a landing bug was itself stranded by that bug — and the design
   made that safe, not fatal.

## What surprised us

- **GitHub was the flaky component, not the model.** Every orchestration bug
  was an API edge case: search-index lag, three distinct auto-merge GraphQL
  rejections. The model's code quality was consistently mergeable; one agent
  found and fixed a real pre-existing bug (regex miss in the guard) because
  the issue demanded tests.
- **Issue quality is the real prompt.** Well-scoped issues with acceptance
  criteria and code pointers landed in 8–16 turns for under $1. The one vague
  spec we wrote (#5's recovery clause) produced a data-destroying behavior —
  correctly implemented, explicitly flagged by the agent, and fixed as #17.
  Garbage in, hazard out; the agent is not your spec reviewer, but it will
  warn you.
- **Cost is boring** (in the best way): $0.17–$3.39 per issue, median ≈ $0.85.

## What we'd bet on next

- PR-review feedback loop: agents responding to review comments.
- Parallel issues via git worktrees.
- `gloop triage` (shipped in v0.1.0) as the default front door for messy
  backlogs.
- Running inside the shipped Dockerfile as the recommended posture.

## The number that matters

From empty repo to a self-hosting, self-healing, tested, CI-gated,
containerizable system: **about two hours, 19 issues, ~$18 in tokens,
and one human who mostly said "y".**
