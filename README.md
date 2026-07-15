# gloop

A GitHub-issue-powered autonomous agent loop, built on
[pi](https://pi.dev). Run `gloop` from a repo checkout: it picks the
highest-priority open issue, spins up a pi agent to fix it end-to-end (code +
tests, no human in the loop), verifies the work, lands it as an auto-merging
PR, files follow-up issues, and repeats until the queue is empty.

See [PROPOSAL.md](./PROPOSAL.md) for the full design.

## Quick start

```bash
npm install && npm run build
gh auth login                 # gloop drives GitHub via the gh CLI

node dist/cli.js --dry-run    # show the queue, do nothing
node dist/cli.js --once       # work the top issue, then exit
node dist/cli.js              # work the queue until empty
node dist/cli.js --issue 42   # work a specific issue
node dist/cli.js status       # queue + gloop label states
```

Model/auth comes from your pi setup (`~/.pi/agent`), or pass
`--model provider/id:thinking`.

> **Safety:** gloop runs an agent with full tool access and no permission
> prompts. Run it in a container or on repos where auto-merged agent commits
> are acceptable. Budgets (`--max-cost`, `--max-turns`, `--max-issues`) are
> your friends.

> **CI gating:** this repo ships a CI workflow
> ([.github/workflows/ci.yml](./.github/workflows/ci.yml)) that runs
> typecheck, tests, and build on PRs. Enable branch protection on `main`
> with CI as a required status check to make gloop's auto-merge wait for CI
> to pass instead of merging immediately.

## How it works

```
scan issues → filter/sort → claim (gloop:in-progress) → branch gloop/issue-N
  → pi agent works (read/bash/edit/write + report_result tool)
  → independent test verification → PR + auto-merge (or --direct)
  → file follow-up issues → repeat
```

- The agent must finish by calling `report_result` with `done`, `split`
  (decompose into follow-ups), or `blocked`.
- A guard extension blocks the agent from pushing, merging, touching GitHub
  issue/PR state, or editing gloop's own configuration — gloop lands, the
  agent codes.
- Failures bump a per-issue attempt counter (hidden comment marker); after
  `--max-attempts` the issue is labeled `gloop:needs-human` and skipped.
- Claims are leases: a hidden comment marker timestamps each claim, and issues
  stuck in `gloop:in-progress` by a crashed run are reclaimed after
  `leaseTtlMinutes` (default 60). Startup also resets any leftover work branch
  or dirty tree back to the default branch.
- `gloop:next` label jumps the queue; `priority:critical|high|medium|low`
  (or `P0`–`P3`) labels order it; FIFO breaks ties.
- Stop gracefully with Ctrl+C (finishes current issue) or `touch .gloop/STOP`.

## Configuration

`.gloop.json` in the repo root (all optional; flags override):

```json
{
  "label": "agent-ok",
  "model": "anthropic/claude-opus-4-5:high",
  "autoMerge": true,
  "verifyCommands": ["npm test", "npm run typecheck", "npm run lint"],
  "maxTurnsPerIssue": 100,
  "maxCostPerIssue": 5,
  "maxMinutesPerIssue": 30,
  "maxAttempts": 2,
  "leaseTtlMinutes": 60,
  "maxFollowUps": 5,
  "quiet": false
}
```

Override the agent's system prompt with `.gloop/PROMPT.md`.
