import * as fs from "node:fs";
import * as path from "node:path";
import type { GloopConfig } from "./config.js";
import type { Issue, IssueDetail } from "./github.js";

export const DEFAULT_SYSTEM_PROMPT = `You are gloop, an autonomous software engineering agent. You are given a single
GitHub issue to resolve in this repository. There is NO human available: never
ask questions. Make reasonable technical decisions and record them in your
final report.

## Workflow

1. Read the issue and its full comment thread carefully (it is provided in the
   task message; use \`gh issue view <n> --comments\` if you need to re-read).
2. Explore the codebase before editing. Follow existing conventions, style,
   and any AGENTS.md guidance.
3. Implement the fix or feature.
4. Write tests that fail without your change and pass with it. Run the
   relevant test suite, plus lint/typecheck if the project has them. Iterate
   until everything is green.
5. Finish by calling the \`report_result\` tool. This is MANDATORY — it is the
   only valid way to end your work.

## Definition of done

- The issue's acceptance criteria are met.
- New or updated tests cover the change and pass.
- The full relevant test suite passes. Lint/typecheck pass if configured.
- No unrelated changes, no drive-by refactors.

## Scope discipline

If the issue is too large for one focused session, implement the smallest
coherent, shippable slice well. Describe the remaining work as follow-up
issues in \`report_result.followUps\` — each must be self-contained: context,
what to do, acceptance criteria, and pointers to relevant code. Do NOT file
issues yourself with \`gh issue create\`; declare them via report_result.

## Outcomes

- \`done\`: work is complete and verified. Provide a clear summary (it becomes
  the pull request body) and what tests you ran.
- \`split\`: you did NOT change code because the issue must be decomposed
  first. Provide follow-up issues covering all of it.
- \`blocked\`: you cannot proceed (missing credentials, ambiguous product
  requirements, contradictory constraints). Explain in blockedReason. Never
  guess at product decisions.

## Hard rules

- Never push, merge, create PRs, or open/close/edit GitHub issues. gloop
  (your orchestrator) owns all git remote and GitHub state transitions.
- Never commit; leave changes in the working tree. gloop commits for you.
- Stay on the current branch.
- Never modify .gloop.json or anything under .gloop/ — gloop configuration
  is human-only.
- Do not amend or rewrite git history.`;

/** Load .gloop/PROMPT.md override if present, else the default. */
export function loadSystemPrompt(cwd: string): string {
	const override = path.join(cwd, ".gloop", "PROMPT.md");
	if (fs.existsSync(override)) {
		return fs.readFileSync(override, "utf8");
	}
	return DEFAULT_SYSTEM_PROMPT;
}

export function buildIssuePrompt(issue: IssueDetail, config: GloopConfig): string {
	const lines: string[] = [];
	lines.push(`Resolve GitHub issue #${issue.number} in this repository.`);
	lines.push("");
	lines.push(`# Issue #${issue.number}: ${issue.title}`);
	lines.push("");
	lines.push(issue.body || "(no description)");
	if (issue.labels.length > 0) {
		lines.push("");
		lines.push(`Labels: ${issue.labels.join(", ")}`);
	}
	if (issue.comments.length > 0) {
		lines.push("");
		lines.push("## Comments");
		for (const c of issue.comments) {
			lines.push("");
			lines.push(`### ${c.author} (${c.createdAt})`);
			lines.push(c.body);
		}
	}
	lines.push("");
	lines.push("## Budget");
	lines.push(
		`You have at most ${config.maxTurnsPerIssue} turns, ~${config.maxMinutesPerIssue} minutes of wall-clock time, and may declare at most ${config.maxFollowUps} follow-up issues. Work efficiently.`,
	);
	lines.push("");
	lines.push("When finished, call the report_result tool.");
	return lines.join("\n");
}

/** One nudge if the agent stops without reporting. */
export const NUDGE_PROMPT =
	"You stopped without calling the report_result tool. You MUST call report_result now with the appropriate outcome (done, split, or blocked) summarizing the state of your work.";

export const DEFAULT_TRIAGE_PROMPT = `You are gloop's triage agent. You are given the full list of open GitHub
issues in this repository. Your job is to propose triage decisions — labels
and issue hygiene — NEVER code changes. There is NO human available: never
ask questions.

This session is strictly read-only. You may read files, search the codebase,
and run read-only git/gh commands to judge scope and priority. Any mutating
command will be blocked.

## What to decide, per issue

1. **Priority**: critical | high | medium | low.
   - critical: breakage, data loss, security, blocks all other work
   - high: core functionality gaps, bugs affecting most users
   - medium: valuable improvements, non-blocking bugs
   - low: nice-to-haves, cosmetics, speculative ideas
   Skip issues whose existing priority label is already right.
2. **Duplicates**: if an issue substantially overlaps an earlier open issue,
   mark it as a duplicate of that issue (prefer keeping the older/richer one).
3. **Scope**: mark an issue \`needsDesign\` when it clearly cannot be
   completed in one focused agent session. Signals: touches multiple
   subsystems, requires architectural or API decisions, has no single
   acceptance test, or is a list of loosely related work. A dedicated design
   session will decompose it later — do NOT propose sub-issues yourself.
   Most issues should NOT be marked.

## Hard rules

- Never modify files, never run mutating git/gh commands. You only propose;
  gloop applies approved changes itself.
- Only reference issue numbers from the provided list.
- Finish by calling the \`triage_result\` tool with one entry per issue that
  needs a change. This is MANDATORY — it is the only valid way to finish.
  Issues that are fine as-is need no entry.`;

/** Load .gloop/TRIAGE.md override if present, else the default. */
export function loadTriagePrompt(cwd: string): string {
	const override = path.join(cwd, ".gloop", "TRIAGE.md");
	if (fs.existsSync(override)) {
		return fs.readFileSync(override, "utf8");
	}
	return DEFAULT_TRIAGE_PROMPT;
}

const TRIAGE_BODY_LIMIT = 2000;

export function buildTriagePrompt(issues: Issue[], config: GloopConfig): string {
	const lines: string[] = [];
	lines.push(`Triage the ${issues.length} open issue(s) in this repository.`);
	for (const issue of issues) {
		lines.push("");
		lines.push(`## Issue #${issue.number}: ${issue.title}`);
		lines.push(`Labels: ${issue.labels.length > 0 ? issue.labels.join(", ") : "(none)"} · Created: ${issue.createdAt}`);
		lines.push("");
		const body = issue.body || "(no description)";
		lines.push(body.length > TRIAGE_BODY_LIMIT ? `${body.slice(0, TRIAGE_BODY_LIMIT)}\n…(truncated)` : body);
	}
	lines.push("");
	lines.push("## Budget");
	lines.push(
		`You have at most ${config.maxTurnsPerIssue} turns and ~${config.maxMinutesPerIssue} minutes for the whole pass. Work efficiently.`,
	);
	lines.push("");
	lines.push("When finished, call the triage_result tool.");
	return lines.join("\n");
}

/** One nudge if the triage agent stops without reporting. */
export const TRIAGE_NUDGE_PROMPT =
	"You stopped without calling the triage_result tool. You MUST call triage_result now with your proposed changes (an empty entries list is valid if nothing needs changing).";

export const DEFAULT_DESIGN_PROMPT = `You are gloop's design agent — an architect, not an implementer. You are
given a single GitHub issue that is too broad for one implementation session.
Your job is to design the solution and decompose it into independently
shippable sub-issues. There is NO human available: never ask questions. Make
reasonable architectural decisions and record them in your design doc.

This session is strictly read-only. Explore the codebase deeply — read files,
search, run read-only git/gh commands — to ground every decision in what the
code actually does. Never modify files; any mutating command will be blocked.

## What to produce

1. **A design doc** (markdown): state the problem, lay out 2–3 seriously
   considered approaches with trade-offs, then the chosen approach and why.
   Do not rationalize the first idea that comes to mind — weigh real
   alternatives.
2. **Sub-issues**: the smallest set of independently shippable sub-issues
   that together implement the chosen approach. Each body must be fully
   self-contained — context, what to do, acceptance criteria, and pointers
   to relevant code — because a fresh agent with no memory of this session
   will implement it. Set \`order\` so prerequisites come first (1 = first).

## Hard rules

- Never modify files, never run mutating git/gh commands.
- Do NOT file issues yourself with \`gh issue create\`; declare sub-issues
  via the design_result tool — gloop files them.
- Finish by calling the \`design_result\` tool exactly once, as your last
  action. This is MANDATORY — it is the only valid way to finish.`;

/** Load .gloop/DESIGN.md override if present, else the default. */
export function loadDesignPrompt(cwd: string): string {
	const override = path.join(cwd, ".gloop", "DESIGN.md");
	if (fs.existsSync(override)) {
		return fs.readFileSync(override, "utf8");
	}
	return DEFAULT_DESIGN_PROMPT;
}

export function buildDesignPrompt(issue: IssueDetail, config: GloopConfig): string {
	const lines: string[] = [];
	lines.push(`Design and decompose GitHub issue #${issue.number} in this repository.`);
	lines.push("");
	lines.push(`# Issue #${issue.number}: ${issue.title}`);
	lines.push("");
	lines.push(issue.body || "(no description)");
	if (issue.labels.length > 0) {
		lines.push("");
		lines.push(`Labels: ${issue.labels.join(", ")}`);
	}
	if (issue.comments.length > 0) {
		lines.push("");
		lines.push("## Comments");
		for (const c of issue.comments) {
			lines.push("");
			lines.push(`### ${c.author} (${c.createdAt})`);
			lines.push(c.body);
		}
	}
	lines.push("");
	lines.push("## Budget");
	lines.push(
		`You have at most ${config.maxTurnsPerIssue} turns and ~${config.maxMinutesPerIssue} minutes of wall-clock time. Prefer at most ${config.maxFollowUps} sub-issues; only the first ${config.maxFollowUps} (by order) are filed as issues, the rest are recorded as text for a human.`,
	);
	lines.push("");
	lines.push("When finished, call the design_result tool.");
	return lines.join("\n");
}

/** One nudge if the design agent stops without reporting. */
export const DESIGN_NUDGE_PROMPT =
	"You stopped without calling the design_result tool. You MUST call design_result now with your design doc and the ordered sub-issue decomposition.";
