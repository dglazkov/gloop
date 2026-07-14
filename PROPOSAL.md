# gloop — a GitHub-issue-powered agent loop

`gloop` turns a repo's issue tracker into a work queue for an autonomous coding
agent. Run `gloop` from a repo checkout; it picks the highest-priority open
issue, spins up a pi agent to fix it end-to-end (code + tests, no human in the
loop), lands the work, files follow-up issues, and repeats until the queue is
empty.

## Why pi's SDK (not shelling out to `pi -p`)

pi exposes `createAgentSession()` from `@earendil-works/pi-coding-agent`, which
gives gloop everything it needs in-process:

- **`systemPromptOverride`** via `DefaultResourceLoader` — full control of the
  harness prompt, while still inheriting the repo's `AGENTS.md` context files.
- **Custom tools** via `defineTool()` — a structured `report_result` tool so
  the agent ends every run with machine-readable outcome data (done / blocked /
  split) instead of us parsing prose.
- **Event subscription** — live progress rendering (tool calls, text deltas)
  plus per-issue token/cost accounting for budget enforcement.
- **Session persistence** — every issue run is a normal pi session JSONL under
  `~/.pi/agent/sessions/`, so you can `pi --session <id>` to inspect or resume,
  and `/export` to HTML for audits.
- **`session.abort()`** — clean enforcement of turn/cost/wall-clock budgets.

Fallback/alternative: spawn `pi --mode json -p` as a subprocess for process
isolation. Deferred — the SDK path is strictly more capable and we can add a
`--subprocess` isolation mode later.

## GitHub integration: `gh` CLI

Use the `gh` CLI (JSON output mode) rather than octokit:

- Auth is already solved (`gh auth login`), works with SSO/enterprise.
- The **agent itself** also uses `gh` through its bash tool (reading issue
  threads, filing follow-ups, creating PRs) — one mechanism, one auth story.
- gloop's orchestrator calls: `gh issue list/view/edit/comment`,
  `gh pr create/merge`, `gh label create`.

## The loop

```
┌─► 1. SCAN     gh issue list --state open --json ...
│   2. FILTER   drop gloop:blocked / gloop:needs-human / in-progress / PR-linked
│   3. SORT     priority labels → explicit order → oldest first
│   4. CLAIM    add gloop:in-progress label + claim comment (crash-safe lease)
│   5. BRANCH   git checkout -b gloop/issue-<n> from default branch (clean tree required)
│   6. WORK     pi AgentSession: read issue → plan → implement → test → iterate
│   7. REPORT   agent calls report_result({ outcome, summary, followUps[] })
│   8. LAND     done    → commit, push, gh pr create --body "Fixes #<n>" (or --direct commit)
│               split   → file child issues, comment + close/relabel parent
│               blocked → label gloop:needs-human, comment with reason
│   9. CLEANUP  remove in-progress label, comment run summary (cost, session id)
└── 10. REPEAT  until no eligible issues, budget exhausted, or stop requested
```

### Issue selection & priority

Deterministic v1 sort (no LLM needed to pick):

1. `priority:critical|high|medium|low` (also recognizes `P0`–`P3`)
2. `gloop:next` label as a manual "do this now" override
3. Oldest first (FIFO) as tiebreaker

Optional `gloop triage` subcommand runs a cheap read-only agent pass over the
open issues to: assign priority labels, detect duplicates, and **decompose
oversized issues** into linked sub-issues before any coding starts. This keeps
triage explicit and auditable rather than buried inside the fix loop.

### Label protocol (gloop's state machine, visible to humans)

| Label | Meaning |
|---|---|
| `gloop:in-progress` | claimed by a running gloop (lease; stale after `--lease-ttl`) |
| `gloop:blocked` | agent hit an external blocker; skipped until label removed |
| `gloop:needs-human` | failed `maxAttempts` times or needs a decision; skipped |
| `gloop:next` | human override: jump the queue |
| `gloop:filed` | issue was created by gloop itself (provenance) |

Attempt count is tracked in a hidden HTML comment (`<!-- gloop:attempts=2 -->`)
on the issue, so retries survive gloop restarts.

## The worker agent

One fresh `AgentSession` per issue (isolated context — no bleed between issues).

**Tools:** built-ins (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) plus:

- `report_result` (custom, required to finish):
  ```ts
  {
    outcome: "done" | "blocked" | "split",
    summary: string,              // becomes PR body / issue comment
    testsRun: string,             // what was executed and results
    followUps: Array<{ title, body, labels[] }>,  // gloop files these
    blockedReason?: string
  }
  ```

**System prompt** (override, `.gloop/PROMPT.md` to customize) — key rules:

1. Read the full issue thread first (`gh issue view <n> --comments`).
2. Explore before editing; follow existing conventions and `AGENTS.md`.
3. **Definition of done:** implementation + tests that fail without the change
   and pass with it + full relevant test suite green + lint/typecheck green.
4. **Scope discipline:** if the issue needs > ~1 session of work, do the
   smallest coherent slice well, then file the rest as follow-up issues via
   `report_result.followUps` (each self-contained: context, acceptance
   criteria, pointers into the code).
5. If genuinely stuck (missing credentials, ambiguous requirements,
   contradictory constraints): `report_result({ outcome: "blocked", ... })` —
   never guess at product decisions.
6. Never push, merge, or close issues yourself — gloop owns git/GitHub
   state transitions (enforced by a `tool_call` guard on bash, not just prompt).
7. No human is available. Never ask questions; make reasonable technical
   calls and record them in the summary.

**Guard extension:** an inline extension blocks `git push`, `gh pr merge`,
`gh issue close`, `git checkout` off the work branch, and writes outside the
repo — the agent codes; gloop lands.

## Guardrails & budgets

- **Per issue:** max turns (default 100), max cost (default $5), wall-clock
  timeout (default 30 min). On breach → treated as a failed attempt.
- **Per run:** `--max-issues N`, `--max-cost $X`, `--max-hours H`.
- **Retry ceiling:** `maxAttempts` (default 2) per issue, then
  `gloop:needs-human`.
- **Runaway-issue-spawning cap:** at most `maxFollowUps` (default 5) filed per
  issue; follow-ups get `gloop:filed` and inherit-or-lower priority so the
  queue converges instead of exploding.
- **Clean start:** refuse to run with a dirty tree; each issue starts from
  fresh default branch.
- **Never `--force`**, never touch the default branch directly unless
  `--direct` is passed.
- **Stop controls:** SIGINT finishes the current issue then exits (second
  SIGINT aborts immediately); a `.gloop/STOP` file stops after current issue.
- **Sandboxing:** docs strongly recommend running in a container/VM (pi has no
  permission popups by design); ship a reference `Dockerfile`.

## Landing strategy

Default: **PR per issue** (`gh pr create --fill --body "Fixes #<n>\n\n<summary>"`).
Humans review and merge; issue auto-closes on merge. Flags:

- `--direct` — commit straight to the default branch and close the issue
  (for toy/solo repos and gloop developing itself).
- `--auto-merge` — enable GitHub auto-merge on the PR when checks pass.

## CLI

```
gloop                      # loop until queue empty / budget hit
gloop --once               # one issue, then exit
gloop --issue 123          # target a specific issue
gloop --dry-run            # show queue order + what would be picked, no work
gloop --label agent-ok     # only work issues carrying this label (opt-in mode)
gloop triage               # prioritize/decompose issues, no coding
gloop status               # show gloop-labeled issue states, recent runs, costs

# knobs
--model anthropic/claude-opus-4-5:high   --direct   --auto-merge
--max-issues N  --max-cost X  --max-turns N  --max-attempts N
```

Config file `.gloop.json` in the repo mirrors every flag (flags win).

## Project structure

```
gloop/
├── package.json           # bin: gloop; dep: @earendil-works/pi-coding-agent
├── src/
│   ├── cli.ts             # arg parsing, subcommands
│   ├── config.ts          # .gloop.json + defaults + flag merge
│   ├── github.ts          # gh wrappers (typed issue/PR/label ops)
│   ├── queue.ts           # scan → filter → sort; claim/release/attempts
│   ├── worker.ts          # one issue: branch, AgentSession, budgets, events
│   ├── prompts.ts         # system prompt + per-issue prompt builders
│   ├── tools.ts           # report_result tool; bash guard extension
│   ├── land.ts            # commit/push/PR/close/comment flows
│   ├── triage.ts          # gloop triage subcommand
│   └── render.ts          # console progress + run summaries
├── prompts/PROMPT.md      # default system prompt (user-overridable via .gloop/)
└── Dockerfile             # reference sandbox
```

## Milestones

1. **M0 — happy path:** `gloop --once --issue N`: claim → branch → SDK session
   with prompt + `report_result` → verify tests → PR + auto-merge. Prove it on
   gloop's own repo, then seed the backlog from this proposal.
2. **M1 — the loop:** scan/sort/claim/release, label protocol, attempts,
   budgets, `--dry-run`, `status`.
3. **M2 — decomposition & triage:** follow-up filing, `gloop triage`,
   bash-guard extension, run summary comments.
4. **M3 — hardening:** Dockerfile, stale-lease recovery, `--auto-merge`,
   nicer live rendering, HTML session export links in PR comments.
5. **Future:** parallel issues via `git worktree`, PR-review-feedback loop
   (agent responds to review comments), cross-repo mode, CI-failure triage.

## Decisions (v1)

1. **Scope:** work all open issues by default; `--label` restricts.
2. **Landing:** PR per issue with **auto-merge enabled by default**
   (`--no-auto-merge` to require human review; `--direct` still available).
3. **Prioritization:** deterministic sort (labels → `gloop:next` → FIFO).
   LLM triage stays a separate opt-in subcommand.
4. **Verification:** trust but verify — gloop independently re-runs the test
   suite (configurable command, e.g. `npm test`) after the agent reports
   `done` and before opening the PR. Verification failure = failed attempt.
5. **Execution:** in-process SDK. Subprocess isolation deferred.

## Self-hosting: gloop runs gloop

The project bootstraps on itself as soon as M0 lands:

1. **Bootstrap:** M0 is built by hand (with pi, interactively). M0's
   acceptance test is literally *"gloop completes one issue from its own
   tracker."* After that, M1–M3 milestones are decomposed into seed issues
   with priority labels, and gloop works its own backlog.
2. **Last-known-good execution:** the running gloop process loads its code at
   startup; agents work on branches, so the running loop is never editing the
   code it executes. New gloop code takes effect only on process restart from
   merged `main`. Combined with trust-but-verify, a change that breaks the
   test suite cannot merge — **the test suite is gloop's self-preservation
   mechanism**, so test scaffolding is one of the first seed issues.
3. **Self-modification guard:** the bash-guard extension also blocks agent
   writes to `.gloop/` and `.gloop.json` in *any* repo — an agent must not be
   able to edit its own budgets, prompt, or guardrails and have auto-merge
   land it. Changes to gloop configuration require a human.
4. **Convergence as the test:** gloop-on-gloop is recursive (issues spawn
   follow-ups). `maxFollowUps`, priority inheritance, and the attempt ceiling
   are what make the recursion well-founded. If gloop can't drive its own
   backlog toward empty, those knobs are miscalibrated — dogfooding surfaces
   that immediately.
5. **Issue-shape validation:** if a milestone can't be expressed as a
   gloop-workable issue (context, acceptance criteria, ~one session of work),
   the milestone or the issue format is wrong. Self-hosting validates the
   protocol, not just the code.
