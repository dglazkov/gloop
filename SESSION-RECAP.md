# Session recap: "let's build a gloop"

**Session:** `019f62d9-0b35-7471-94b5-1c5cf2be5acc`
**When:** 2026-07-14, 23:01 → 00:41 UTC (~1h 40m)
**Model:** claude-fable-5, thinking level high
**Outcome:** gloop v0.1.0 released, self-hosting, 19/19 issues closed, 119 tests, ~$18 in tokens

---

## Turn 1 — 23:01

> let's build a gloop: a github issue-powered agent harness based on pi-mono (you). The core idea is that the user launches `gloop` from a github repo cwd, and then gloop reads open issues, sorts them by priority, then picks the top item and launches the pi agent harness to go fix the issue. The harness will have some system instruction / prompt to read the issue, write code, ensure that the code is solid with tests, run tests, iterate, all without human intervention. Once done, the harness will file issues that are remaining (we need to teach it to break up complex tasks into smaller issues, etc.) and exit. Then, gloop repeats until no more issues remain. Spelunk pi-mono docs, ideate, and get back to me with a proposal. Let's then discuss it

*(Sent twice — turn 2 at 23:03 is an identical retry; the first got no response.)*

**Agent:** Spelunked the pi docs (README, sdk.md, extensions.md, json.md, SDK/extension examples), inspected the empty repo, and wrote **`PROPOSAL.md`**: gloop = orchestrator loop + in-process pi SDK worker (`createAgentSession()`) + `gh` CLI for GitHub, with label-based priority queue, lease labels, trust-but-verify, and auto-merge. Ended with 5 open questions for discussion.

## Turn 3 — 23:08

> 1. yup, 2. yup, auto-merge, 3. deterministic sort ok, 4. yes, 5. no, this is a good first v1. We can always increment. As a reflection exercise, consider this: can this project be run by gloop?

**Agent:** Answered the reflection: **yes, and self-hosting should be the explicit goal of M0** (compiler-style bootstrap: pi builds gloop by hand, then gloop builds gloop). Identified four wrinkles (bootstrap, guard rules, verify story, backlog seeding) and updated `PROPOSAL.md` with the decisions plus a "Self-hosting" section.

## Turn 4 — 23:09

> y

**Agent:** Built the M0 scaffold. Verified SDK type shapes (`usage.cost.total`, `resolveCliModel`), then wrote the whole project: `package.json`, `tsconfig.json`, and `src/{cli,config,exec,github,git,queue,prompts,render,worker,land}.ts` plus `test/queue.test.ts`. Typecheck passed; the first test run caught a real priority-sort bug (explicit `priority:low` losing to the unlabeled default) and fixed it. Added README, committed, created the repo labels, and filed issue #1 (`--version` flag) as the acceptance test. `--dry-run` showed a working queue.

## Turn 5 — 23:20

> fire it

**Agent:** Ran `gloop --issue 1`. The loop closed end-to-end: claimed #1, branched, pi agent wrote `src/version.ts` + tests, gloop independently re-verified, opened PR #2 with auto-merge, PR merged, issue closed. **M0 acceptance test passed — gloop is self-hosting.**

## Turn 6 — 23:23

> y

**Agent:** Seeded the backlog: created priority labels and filed 10 issues (#3–#12: linked-PR re-pick bug, CI, stale lease recovery, guard tests, run ledger, multi-command verify, triage, Dockerfile, render polish, config validation). Confirmed the queue sorts exactly as designed and laid out the roadmap order with rationale.

## Turn 7 — 23:26

> let's run two or three with --once and check the results, then evaluate

**Agent:** Ran `gloop --once` for #3 (linked-PR re-pick bug), landed it, then reviewed the actual diff for quality rather than just trusting green tests.

## Turn 8 — 23:36

> continue

**Agent:** Ran two more `--once` cycles: #4 (CI workflow — exactly to spec; also enabled repo auto-merge) and #5 (stale lease recovery — the hardest one, 26 turns, $1.86). Manually merged where CI/auto-merge wasn't wired yet, reviewed diffs, and filed new issues for bugs discovered along the way. Delivered the evaluation: **3 runs, 3 landed PRs, 2 real bugs discovered.**

## Turn 9 — 23:46

> fire

**Agent:** Unleashed the full unattended loop (`gloop --max-cost 15`). It ran the queue down, with the agent merging a few PRs stranded by auto-merge gaps and re-firing until empty. Debrief: **11 issues landed in one unattended run (~$12.30), including two gloop discovered and filed itself** — robustness fixes (#21, #22), features (#7 ledger, #8 multi-verify, #9 triage, #10 Dockerfile, #11 --quiet), and safety fixes (dry-run bugs #29/#31).

## Turn 10 — 00:34

> let's eat, then write a retrospective in a brief pitch format, then v0.1.0

**Agent:** Fed gloop the last issue (#37 — auto-merge fix, stranded by the very bug it fixed): queue empty, 19/19 closed, 119 tests green. Wrote **`RETRO.md`** (pitch format), committed, tagged `v0.1.0`, and published the GitHub release with notes: https://github.com/dglazkov/gloop/releases/tag/v0.1.0

## Turn 11 — 00:39

> yup. And it was less than a day. It's been 2 hours give or take

**Agent:** Corrected the retro and release notes: **"19 issues closed · 119 tests · ~$18 in tokens · about two hours"** — noting the original closing line undersold the result by ~4x. 🎬
