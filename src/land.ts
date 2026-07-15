import * as fs from "node:fs";
import * as path from "node:path";
import { type GloopConfig, LABELS } from "./config.js";
import { runShellInherit } from "./exec.js";
import * as git from "./git.js";
import * as github from "./github.js";
import type { IssueDetail } from "./github.js";
import { attemptsMarker } from "./queue.js";
import { c, info, warn } from "./render.js";
import type { WorkReport, WorkResult } from "./worker.js";

export interface LandOutcome {
	kind: "landed" | "split" | "blocked" | "failed";
	detail: string;
}

/** Trust but verify: independently re-run the test suite before landing. */
export async function verify(config: GloopConfig, cwd: string): Promise<{ ok: boolean; command?: string }> {
	let command = config.verifyCommand;
	if (!command) {
		// Auto-detect: npm test if package.json declares a test script.
		const pkgPath = path.join(cwd, "package.json");
		if (fs.existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
				if (pkg.scripts?.test) command = "npm test";
			} catch {
				// fall through
			}
		}
	}
	if (!command) {
		warn("no verify command configured or detected; skipping independent verification");
		return { ok: true };
	}
	info(`verifying: ${c.bold(command)}`);
	const code = await runShellInherit(command, cwd);
	return { ok: code === 0, command };
}

function runSummary(result: WorkResult): string {
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
				warn(`PR left open; merge it manually: ${merge.message}`);
				mergeNote = " (left open)";
				break;
		}
	}

	await git.checkout(cwd, defaultBranch);
	return { kind: "landed", detail: `${prUrl}${mergeNote}` };
}

export async function landSplit(
	issue: IssueDetail,
	report: WorkReport,
	result: WorkResult,
	config: GloopConfig,
	cwd: string,
): Promise<LandOutcome> {
	if (report.followUps.length === 0) {
		return { kind: "failed", detail: "agent reported split but declared no follow-up issues" };
	}
	const filed = await fileFollowUps(report, issue, config, cwd);
	const list = filed.map((n) => `- #${n}`).join("\n");
	await github.closeIssue(
		cwd,
		issue.number,
		`Decomposed into smaller issues:\n\n${list}\n\n${report.summary}\n\n---\n🤖 gloop · ${runSummary(result)}`,
	);
	return { kind: "split", detail: `decomposed into ${filed.length} issue(s)` };
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
	result: WorkResult,
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
