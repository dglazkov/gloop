import * as fs from "node:fs";
import * as path from "node:path";
import { type GloopConfig, LABELS } from "./config.js";
import { getDepth } from "./design.js";
import { runShellInherit } from "./exec.js";
import * as git from "./git.js";
import * as github from "./github.js";
import type { IssueDetail } from "./github.js";
import { attemptsMarker } from "./queue.js";
import { c, info, warn } from "./render.js";
import type { SessionRunResult, WorkReport, WorkResult } from "./worker.js";

export interface LandOutcome {
	kind: "landed" | "split" | "blocked" | "failed";
	detail: string;
	/** Set when landing opened a pull request. */
	prUrl?: string;
}

/** Auto-detect verify commands from package.json scripts: test, typecheck, lint (in that order). */
export function detectVerifyCommands(pkgJson: string): string[] {
	const commands: string[] = [];
	try {
		const pkg = JSON.parse(pkgJson);
		if (pkg.scripts?.test) commands.push("npm test");
		if (pkg.scripts?.typecheck) commands.push("npm run typecheck");
		if (pkg.scripts?.lint) commands.push("npm run lint");
	} catch {
		// unparseable package.json: nothing detected
	}
	return commands;
}

/** Resolve which verify commands to run: verifyCommands > verifyCommand > auto-detect. */
export function resolveVerifyCommands(config: GloopConfig, cwd: string): string[] {
	if (config.verifyCommands && config.verifyCommands.length > 0) return config.verifyCommands;
	if (config.verifyCommand) return [config.verifyCommand];
	const pkgPath = path.join(cwd, "package.json");
	if (!fs.existsSync(pkgPath)) return [];
	return detectVerifyCommands(fs.readFileSync(pkgPath, "utf8"));
}

/** Trust but verify: independently re-run the test suite before landing. */
export async function verify(config: GloopConfig, cwd: string): Promise<{ ok: boolean; command?: string }> {
	const commands = resolveVerifyCommands(config, cwd);
	if (commands.length === 0) {
		warn("no verify command configured or detected; skipping independent verification");
		return { ok: true };
	}
	for (const command of commands) {
		info(`verifying: ${c.bold(command)}`);
		const code = await runShellInherit(command, cwd);
		if (code !== 0) return { ok: false, command };
	}
	return { ok: true };
}

function runSummary(result: SessionRunResult): string {
	const parts = [`turns: ${result.turns}`, `cost: $${result.cost.toFixed(2)}`];
	if (result.sessionId) parts.push(`session: ${result.sessionId}`);
	return parts.join(" · ");
}

export async function fileFollowUps(
	report: WorkReport,
	parent: IssueDetail,
	config: GloopConfig,
	cwd: string,
): Promise<number[]> {
	const filed: number[] = [];
	for (const fu of report.followUps.slice(0, config.maxFollowUps)) {
		const labels = [...new Set([...(fu.labels ?? []), LABELS.filed])];
		const body = `${fu.body}\n\n---\n_Filed by gloop while working #${parent.number}._`;
		const num = await github.createIssue(cwd, fu.title, body, labels);
		filed.push(num);
		info(`filed follow-up #${num}: ${fu.title}`);
	}
	return filed;
}

export async function landDone(
	issue: IssueDetail,
	report: WorkReport,
	result: WorkResult,
	config: GloopConfig,
	cwd: string,
	branch: string,
	defaultBranch: string,
): Promise<LandOutcome> {
	if (!(await git.hasChanges(cwd))) {
		return { kind: "failed", detail: "agent reported done but made no changes" };
	}

	const verification = await verify(config, cwd);
	if (!verification.ok) {
		return { kind: "failed", detail: `verification failed (${verification.command})` };
	}

	const followUps = await fileFollowUps(report, issue, config, cwd);
	const followUpNote = followUps.length > 0 ? `\n\nFollow-ups filed: ${followUps.map((n) => `#${n}`).join(", ")}` : "";

	const title = `Fix #${issue.number}: ${issue.title}`;
	const testsNote = report.testsRun ? `\n\n**Tests:** ${report.testsRun}` : "";
	const footer = `\n\n---\n🤖 gloop · ${runSummary(result)}`;

	if (config.direct) {
		await git.commitAll(cwd, `${title}\n\n${report.summary}`);
		await git.squashMergeToBase(cwd, branch, defaultBranch, `${title}\n\n${report.summary}`);
		await git.deleteLocalBranch(cwd, branch);
		await github.closeIssue(cwd, issue.number, `Fixed on \`${defaultBranch}\`.\n\n${report.summary}${testsNote}${followUpNote}${footer}`);
		return { kind: "landed", detail: `committed to ${defaultBranch}` };
	}

	await git.commitAll(cwd, `${title}\n\n${report.summary}`);
	const push = await git.pushBranch(cwd, branch);
	if (!push.ok) {
		if (push.reason === "non-fast-forward") {
			return { kind: "failed", detail: `branch ${branch} already exists remotely — likely duplicate work` };
		}
		return { kind: "failed", detail: `git push failed: ${push.detail}` };
	}
	const prBody = `Fixes #${issue.number}\n\n${report.summary}${testsNote}${followUpNote}${footer}`;
	const prUrl = await github.createPr(cwd, branch, title, prBody);
	info(`opened PR: ${prUrl}`);

	let mergeNote = "";
	if (config.autoMerge) {
		const merge = await github.enableAutoMerge(cwd, prUrl);
		if (merge.hint) warn(merge.hint);
		switch (merge.outcome) {
			case "merged":
				info("PR merged");
				mergeNote = " (merged)";
				break;
			case "auto-merge-armed":
				info("auto-merge armed; GitHub will merge once checks pass");
				mergeNote = " (auto-merge armed)";
				break;
			case "left-open":
				warn(
					`PR left open (classified: ${merge.classification ?? "unknown"}); merge it manually: ${merge.message}`,
				);
				mergeNote = " (left open)";
				break;
		}
	}

	await git.checkout(cwd, defaultBranch);
	return { kind: "landed", detail: `${prUrl}${mergeNote}`, prUrl };
}

export type SplitEscalationPlan =
	| { action: "fail"; reason: string }
	| { action: "escalate"; label: string; comment: string; detail: string };

/** The worker's notes and rough decomposition, rendered as input for the design session. */
export function buildSplitComment(report: WorkReport): string {
	const lines = [
		"↪️ gloop: worker escalated this issue for a design pass. Its notes and rough decomposition below are input, not the plan.",
	];
	if (report.summary.trim() !== "") {
		lines.push("", report.summary.trim());
	}
	if (report.followUps.length > 0) {
		lines.push("", "Proposed decomposition:", "");
		for (const fu of report.followUps) {
			const body = fu.body
				.split("\n")
				.map((l) => `  ${l}`.trimEnd())
				.join("\n");
			lines.push(`- **${fu.title}**`, body);
		}
	}
	return lines.join("\n");
}

/**
 * Decide how to escalate a worker split. Pure. A split is not a decomposition
 * of its own: the issue stays open and gets routed to a design session
 * (gloop:design). Exceptions: an epic in the worker path is a routing bug, and
 * a designed sub-issue (depth marker present) that splits again still looks
 * like an epic — both go to a human instead.
 */
export function planSplitEscalation(issue: IssueDetail, report: WorkReport): SplitEscalationPlan {
	if (report.followUps.length === 0 && report.summary.trim() === "") {
		return { action: "fail", reason: "agent reported split with no findings (no follow-ups and empty summary)" };
	}
	const notes = buildSplitComment(report);
	if (issue.labels.includes(LABELS.epic)) {
		return {
			action: "escalate",
			label: LABELS.needsHuman,
			comment: `${notes}\n\n⚠️ This issue carries \`${LABELS.epic}\` — a worker should never have picked it. This indicates a routing bug; marking \`${LABELS.needsHuman}\`.`,
			detail: "escalated to human (worker picked an epic — routing bug)",
		};
	}
	if (getDepth(issue.body) > 0) {
		return {
			action: "escalate",
			label: LABELS.needsHuman,
			comment: `${notes}\n\n⚠️ This issue was already produced by a design session, yet a worker split it again. A designed sub-issue that still looks like an epic needs a human; marking \`${LABELS.needsHuman}\`.`,
			detail: "escalated to human (designed sub-issue split again)",
		};
	}
	return {
		action: "escalate",
		label: LABELS.design,
		comment: notes,
		detail: "escalated to design session",
	};
}

export async function landSplit(
	issue: IssueDetail,
	report: WorkReport,
	result: WorkResult,
	cwd: string,
): Promise<LandOutcome> {
	const plan = planSplitEscalation(issue, report);
	if (plan.action === "fail") {
		return { kind: "failed", detail: plan.reason };
	}
	await github.addLabels(cwd, issue.number, [plan.label]);
	await github.commentOnIssue(cwd, issue.number, `${plan.comment}\n\n---\n🤖 gloop · ${runSummary(result)}`);
	return { kind: "split", detail: plan.detail };
}

export async function landBlocked(
	issue: IssueDetail,
	report: WorkReport,
	result: WorkResult,
	cwd: string,
): Promise<LandOutcome> {
	await github.addLabels(cwd, issue.number, [LABELS.blocked]);
	await github.commentOnIssue(
		cwd,
		issue.number,
		`⛔ gloop is blocked on this issue:\n\n${report.blockedReason ?? report.summary}\n\nRemove the \`${LABELS.blocked}\` label after resolving to let gloop retry.\n\n---\n🤖 gloop · ${runSummary(result)}`,
	);
	return { kind: "blocked", detail: report.blockedReason ?? "blocked" };
}

/** Record a failed attempt; escalate to needs-human after maxAttempts. */
export async function recordFailure(
	issue: IssueDetail,
	reason: string,
	result: SessionRunResult,
	attempts: number,
	config: GloopConfig,
	cwd: string,
): Promise<LandOutcome> {
	const nextAttempts = attempts + 1;
	const escalate = nextAttempts >= config.maxAttempts;
	const header = escalate
		? `🔴 gloop failed attempt ${nextAttempts}/${config.maxAttempts}; marking \`${LABELS.needsHuman}\`.`
		: `🟡 gloop failed attempt ${nextAttempts}/${config.maxAttempts}; will retry.`;
	await github.commentOnIssue(
		cwd,
		issue.number,
		`${attemptsMarker(nextAttempts)}\n${header}\n\nReason: ${reason}\n\n---\n🤖 gloop · ${runSummary(result)}`,
	);
	if (escalate) {
		await github.addLabels(cwd, issue.number, [LABELS.needsHuman]);
	}
	return { kind: "failed", detail: reason };
}
