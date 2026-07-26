#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { type CliArgs, HELP, parseArgs } from "./args.js";
import { ConsecutiveFailureBreaker } from "./breaker.js";
import { type GloopConfig, LABELS, loadConfig } from "./config.js";
import { applyDesignResult, designFailureReason, getDepth, MAX_DESIGN_DEPTH, runDesign } from "./design.js";
import { sweepEpics } from "./epic.js";
import * as git from "./git.js";
import * as github from "./github.js";
import { landBlocked, landDone, landSplit, type LandOutcome, recordFailure } from "./land.js";
import { appendRun, readRuns, type RunRecord, totalCost } from "./ledger.js";
import { buildQueue, decideLeaseReclaim, decidePreClaim, getAttempts, issuePriority, leaseMarker, sortQueue } from "./queue.js";
import { banner, c, error, formatCost, info, warn } from "./render.js";
import { applyTriagePlan, planTriage, printTriagePlan, runTriage } from "./triage.js";
import { getVersion } from "./version.js";
import { runWorker, type SessionRunResult, type WorkResult } from "./worker.js";

function stopRequested(cwd: string): boolean {
	return fs.existsSync(path.join(cwd, ".gloop", "STOP"));
}

async function preflight(cwd: string, config: GloopConfig, dryRun = false): Promise<{ defaultBranch: string }> {
	if (!(await git.isGitRepo(cwd))) throw new Error("Not a git repository.");
	await github.checkGhAuth(cwd);
	const repo = await github.getRepoInfo(cwd);
	// Recover from a crashed run: a leftover gloop work branch means the previous
	// run never reached its cleanup; reset to the default branch. Never auto-reset
	// any other branch — a dirty tree there is human work, so refuse to run.
	// Dry-run is strictly read-only: leftover state only produces a warning.
	const branch = await git.currentBranch(cwd);
	const recovery = git.decidePreflightRecovery(branch, await git.isCleanTree(cwd), config.branchPrefix, dryRun);
	if (recovery.action === "error") throw new Error(recovery.message);
	if (recovery.action === "warn") {
		warn(`leftover state from a previous run (${recovery.reason}); skipping recovery (--dry-run)`);
	}
	if (recovery.action === "recover") {
		warn(`recovering from a previous run (${recovery.reason}); resetting to ${repo.defaultBranch}`);
		await git.abandonBranch(cwd, branch, repo.defaultBranch);
	}
	// Dry-run performs no GitHub writes, so no label creation either.
	if (!dryRun) await github.ensureLabels(cwd);
	return { defaultBranch: repo.defaultBranch };
}

/**
 * Un-wedge issues left gloop:in-progress by a crashed run once their lease
 * expires. In dry-run mode the reclaim is simulated in memory only (so the
 * queue printout matches what a real run would pick) — no GitHub write.
 */
async function reclaimStaleLeases(issues: github.Issue[], config: GloopConfig, cwd: string, dryRun = false): Promise<void> {
	for (const issue of issues) {
		if (!issue.labels.includes(LABELS.inProgress)) continue;
		const detail = await github.viewIssue(cwd, issue.number);
		const decision = decideLeaseReclaim(issue.labels, detail.comments, config.leaseTtlMinutes, dryRun);
		if (decision.action === "keep") continue;
		warn(
			`#${issue.number}: lease older than ${config.leaseTtlMinutes}m; reclaiming${decision.action === "simulate" ? " (--dry-run: simulated, label left in place)" : ""}`,
		);
		if (decision.action === "reclaim") await github.removeLabels(cwd, issue.number, [LABELS.inProgress]);
		issue.labels = issue.labels.filter((l) => l !== LABELS.inProgress);
	}
}

async function workOneIssue(
	issueNumber: number,
	config: GloopConfig,
	cwd: string,
	defaultBranch: string,
): Promise<{ kind: string; result?: WorkResult }> {
	const issue = await github.viewIssue(cwd, issueNumber);
	const attempts = getAttempts(issue.comments);
	const branch = `${config.branchPrefix}${issue.number}`;

	// Authoritative pre-claim check: the scan's linked-PR exclusion uses GitHub's
	// eventually consistent search API, so a PR landed seconds ago may not show up
	// yet. The REST-backed pr list is read-after-write consistent; if an open PR
	// already exists for this branch, claiming would duplicate the work.
	const preClaim = decidePreClaim(branch, await github.listOpenPrNumbersForBranch(cwd, branch));
	if (!preClaim.claim) {
		info(`#${issue.number}: skipping — ${preClaim.reason}`);
		return { kind: "skipped" };
	}

	banner(`#${issue.number}: ${issue.title}`);
	info(`attempt ${attempts + 1}/${config.maxAttempts} · branch ${branch}`);

	// Claim (lease). The hidden marker lets future scans reclaim the issue if this
	// run crashes; it is posted before the label so a claim without a marker is
	// always safe to treat as stale. A human can also remove the label to un-stick.
	await github.commentOnIssue(cwd, issue.number, `${leaseMarker()}\n🤖 gloop claimed this issue (attempt ${attempts + 1}/${config.maxAttempts}).`);
	await github.addLabels(cwd, issue.number, [LABELS.inProgress]);
	await git.checkoutFreshBranch(cwd, branch, defaultBranch);

	let result: WorkResult | undefined;
	try {
		result = await runWorker(issue, config, cwd);

		info(`agent finished · ${result.turns} turns · ${formatCost(result.cost)}`);

		let outcome: LandOutcome | { kind: "aborted"; detail: string; prUrl?: undefined };
		if (result.abortedBy === "signal") {
			outcome = { kind: "aborted" as const, detail: "interrupted by user" };
			await git.abandonBranch(cwd, branch, defaultBranch);
		} else if (result.abortedBy) {
			outcome = await recordFailure(issue, `budget exhausted (${result.abortedBy})`, result, attempts, config, cwd);
			await git.abandonBranch(cwd, branch, defaultBranch);
		} else if (result.errorMessage) {
			outcome = await recordFailure(issue, `agent error: ${result.errorMessage}`, result, attempts, config, cwd);
			await git.abandonBranch(cwd, branch, defaultBranch);
		} else if (!result.report) {
			outcome = await recordFailure(issue, "agent never called report_result", result, attempts, config, cwd);
			await git.abandonBranch(cwd, branch, defaultBranch);
		} else if (result.report.outcome === "done") {
			outcome = await landDone(issue, result.report, result, config, cwd, branch, defaultBranch);
			if (outcome.kind === "failed") {
				await git.abandonBranch(cwd, branch, defaultBranch);
				outcome = await recordFailure(issue, outcome.detail, result, attempts, config, cwd);
			}
		} else if (result.report.outcome === "split") {
			outcome = await landSplit(issue, result.report, result, config, cwd);
			await git.abandonBranch(cwd, branch, defaultBranch);
			if (outcome.kind === "failed") {
				outcome = await recordFailure(issue, outcome.detail, result, attempts, config, cwd);
			}
		} else {
			outcome = await landBlocked(issue, result.report, result, cwd);
			await git.abandonBranch(cwd, branch, defaultBranch);
		}

		const color = outcome.kind === "landed" || outcome.kind === "split" ? c.green : outcome.kind === "failed" ? c.red : c.yellow;
		info(`outcome: ${color(outcome.kind)} — ${outcome.detail}`);
		appendRun(cwd, {
			timestamp: new Date().toISOString(),
			issue: issue.number,
			kind: outcome.kind,
			detail: outcome.detail,
			turns: result.turns,
			cost: result.cost,
			sessionId: result.sessionId,
			prUrl: outcome.prUrl,
		});
		return { kind: outcome.kind, result };
	} finally {
		await github.removeLabels(cwd, issue.number, [LABELS.inProgress]);
		// Always leave the tree clean on the default branch.
		if (!(await git.isCleanTree(cwd)) || (await git.currentBranch(cwd)) !== defaultBranch) {
			await git.abandonBranch(cwd, branch, defaultBranch);
		}
	}
}

/**
 * Handle one gloop:design issue: escalate over-deep issues to a human,
 * otherwise run a read-only design session and apply its result (design-doc
 * comment, filed sub-issues, checklist, gloop:design → gloop:epic).
 */
async function designOneIssue(
	issueNumber: number,
	config: GloopConfig,
	cwd: string,
): Promise<{ kind: string; result?: SessionRunResult }> {
	const issue = await github.viewIssue(cwd, issueNumber);
	banner(`#${issue.number}: ${issue.title} ${c.dim("(design)")}`);

	// Depth guard: refuse to decompose a decomposition of a decomposition.
	const depth = getDepth(issue.body);
	if (depth >= MAX_DESIGN_DEPTH) {
		warn(`#${issue.number}: design depth ${depth} reached the limit; escalating to a human`);
		await github.commentOnIssue(
			cwd,
			issue.number,
			`🔴 gloop: this issue is already ${depth} level(s) deep in design decomposition; refusing to decompose further. A human should scope it. Marking \`${LABELS.needsHuman}\`.`,
		);
		await github.addLabels(cwd, issue.number, [LABELS.needsHuman]);
		await github.removeLabels(cwd, issue.number, [LABELS.design]);
		return { kind: "escalated" };
	}

	const attempts = getAttempts(issue.comments);
	info(`design attempt ${attempts + 1}/${config.maxAttempts}`);

	// Claim (lease), same protocol as implementation work: marker first, then label.
	await github.commentOnIssue(
		cwd,
		issue.number,
		`${leaseMarker()}\n🤖 gloop claimed this issue for a design session (attempt ${attempts + 1}/${config.maxAttempts}).`,
	);
	await github.addLabels(cwd, issue.number, [LABELS.inProgress]);

	try {
		const result = await runDesign(issue, config, cwd);
		info(`agent finished · ${result.turns} turns · ${formatCost(result.cost)}`);

		if (result.abortedBy === "signal") {
			info("outcome: aborted — interrupted by user");
			return { kind: "aborted", result };
		}

		const failure = designFailureReason(result);
		const outcome =
			failure !== undefined || !result.report
				? await recordFailure(issue, failure ?? "agent never called design_result", result, attempts, config, cwd)
				: await applyDesignResult(issue, result.report, result, config, cwd);

		const color = outcome.kind === "designed" ? c.green : c.red;
		info(`outcome: ${color(outcome.kind)} — ${outcome.detail}`);
		appendRun(cwd, {
			timestamp: new Date().toISOString(),
			issue: issue.number,
			kind: outcome.kind,
			detail: outcome.detail,
			turns: result.turns,
			cost: result.cost,
			sessionId: result.sessionId,
		});
		return { kind: outcome.kind, result };
	} finally {
		await github.removeLabels(cwd, issue.number, [LABELS.inProgress]);
	}
}

/**
 * Best-effort recovery after workOneIssue threw: make sure the tree is back on
 * the default branch, the in-progress label is gone, and a failed attempt is
 * recorded so attempt tracking / gloop:needs-human escalation still works.
 * Every step is independently fenced — recovery must never throw.
 */
async function recoverFromCrashedIssue(
	issueNumber: number,
	reason: string,
	config: GloopConfig,
	cwd: string,
	defaultBranch: string,
): Promise<void> {
	const branch = `${config.branchPrefix}${issueNumber}`;
	try {
		if (!(await git.isCleanTree(cwd)) || (await git.currentBranch(cwd)) !== defaultBranch) {
			await git.abandonBranch(cwd, branch, defaultBranch);
		}
	} catch (err) {
		warn(`#${issueNumber}: branch cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		await github.removeLabels(cwd, issueNumber, [LABELS.inProgress]);
	} catch {
		// Label may never have been added; stale leases are reclaimed on later scans anyway.
	}
	try {
		const issue = await github.viewIssue(cwd, issueNumber);
		const attempts = getAttempts(issue.comments);
		await recordFailure(issue, `unexpected error: ${reason}`, { cost: 0, turns: 0 }, attempts, config, cwd);
	} catch (err) {
		warn(`#${issueNumber}: could not record failed attempt: ${err instanceof Error ? err.message : String(err)}`);
	}
	appendRun(cwd, {
		timestamp: new Date().toISOString(),
		issue: issueNumber,
		kind: "failed",
		detail: `unexpected error: ${reason}`,
		turns: 0,
		cost: 0,
	});
}

async function commandRun(args: CliArgs, cwd: string): Promise<void> {
	const config = { ...loadConfig(cwd), ...args.overrides };
	const { defaultBranch } = await preflight(cwd, config, args.dryRun);

	let stopAfterCurrent = false;
	const onSigint = () => {
		if (stopAfterCurrent) process.exit(130); // second SIGINT: hard exit
		stopAfterCurrent = true;
		warn("SIGINT: finishing current issue, then stopping (Ctrl+C again to abort)");
	};
	process.on("SIGINT", onSigint);

	let worked = 0;
	let totalCost = 0;
	// Stop the run if consecutive issues die with unexpected exceptions — that
	// smells systemic (auth, network, disk), not issue-specific.
	const breaker = new ConsecutiveFailureBreaker(2);
	// Issues gloop has already handled this run (PR landed or open PR detected).
	// The search-based scan exclusion lags fresh PRs, so track them locally too.
	const handledThisRun = new Set<number>();

	while (true) {
		if (stopAfterCurrent) break;
		if (stopRequested(cwd)) {
			warn(".gloop/STOP present; stopping");
			break;
		}
		if (worked >= config.maxIssuesPerRun) {
			info(`run budget reached (${worked} issues)`);
			break;
		}
		if (totalCost >= config.maxCostPerRun) {
			info(`run cost budget reached (${formatCost(totalCost)})`);
			break;
		}

		let target: number | undefined = args.issue;
		let designTarget: number | undefined;
		if (target === undefined) {
			const [issues, linkedPrIssues] = await Promise.all([
				github.listOpenIssues(cwd),
				github.listIssueNumbersWithLinkedPr(cwd),
			]);
			await reclaimStaleLeases(issues, config, cwd, args.dryRun);
			await sweepEpics(issues, cwd, args.dryRun);
			// Design issues are handled before the implementation queue: decomposing
			// a Big Fish unblocks more implementable work.
			const designQueue = sortQueue(
				issues.filter(
					(i) =>
						i.labels.includes(LABELS.design) &&
						!i.labels.includes(LABELS.inProgress) &&
						!i.labels.includes(LABELS.needsHuman) &&
						(!config.label || i.labels.includes(config.label)),
				),
			);
			const excluded = new Set([...linkedPrIssues, ...handledThisRun]);
			const queue = buildQueue(issues, config, excluded);
			if (queue.length === 0 && designQueue.length === 0) {
				info(worked === 0 ? "no eligible open issues" : `queue empty · worked ${worked} issue(s) · ${formatCost(totalCost)}`);
				break;
			}
			if (args.dryRun) {
				if (designQueue.length > 0) {
					info(`design queue (${designQueue.length}):`);
					for (const [i, iss] of designQueue.entries()) {
						console.log(`  ${i + 1}. #${iss.number} ${iss.title} ${c.dim(iss.labels.join(","))}`);
					}
				}
				info(`queue (${queue.length}):`);
				for (const [i, iss] of queue.entries()) {
					console.log(`  ${i + 1}. #${iss.number} [p${issuePriority(iss)}] ${iss.title} ${c.dim(iss.labels.join(","))}`);
				}
				return;
			}
			if (designQueue.length > 0) {
				designTarget = designQueue[0].number;
			} else {
				target = queue[0].number;
			}
		} else if (args.dryRun) {
			info(`would work #${target}`);
			return;
		}

		if (designTarget !== undefined) {
			let kind: string;
			let result: SessionRunResult | undefined;
			try {
				({ kind, result } = await designOneIssue(designTarget, config, cwd));
				breaker.recordSuccess();
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				error(`#${designTarget}: unexpected error — ${reason}`);
				await recoverFromCrashedIssue(designTarget, reason, config, cwd, defaultBranch);
				worked += 1;
				if (breaker.recordFailure()) {
					error("two consecutive issues failed with unexpected errors; stopping the run");
					break;
				}
				if (args.once) break;
				continue;
			}
			if (kind === "escalated") {
				// Depth guard: no agent session ran; the label swap keeps it out of later scans.
				if (args.once) break;
				continue;
			}
			worked += 1;
			totalCost += result?.cost ?? 0;
			if (kind === "aborted") break;
			if (args.once) break;
			continue;
		}
		if (target === undefined) break; // unreachable: the design branch above always breaks or continues

		let kind: string;
		let result: WorkResult | undefined;
		try {
			({ kind, result } = await workOneIssue(target, config, cwd, defaultBranch));
			breaker.recordSuccess();
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			error(`#${target}: unexpected error — ${reason}`);
			await recoverFromCrashedIssue(target, reason, config, cwd, defaultBranch);
			worked += 1;
			if (breaker.recordFailure()) {
				error("two consecutive issues failed with unexpected errors; stopping the run");
				break;
			}
			if (args.once) break;
			continue;
		}
		if (kind === "skipped") {
			// An open PR already exists; exclude the issue from later scans this run.
			handledThisRun.add(target);
			if (args.once) break;
			continue;
		}
		worked += 1;
		totalCost += result?.cost ?? 0;
		if (kind === "landed") handledThisRun.add(target);

		if (kind === "aborted") break;
		if (args.once) break;
	}

	process.removeListener("SIGINT", onSigint);
	info(`done · ${worked} issue(s) · ${formatCost(totalCost)}`);
}

async function commandStatus(args: CliArgs, cwd: string): Promise<void> {
	const config = { ...loadConfig(cwd), ...args.overrides };
	const [issues, linkedPrIssues] = await Promise.all([
		github.listOpenIssues(cwd),
		github.listIssueNumbersWithLinkedPr(cwd),
	]);
	const queue = buildQueue(issues, config, linkedPrIssues);
	const byLabel = (label: string) => issues.filter((i) => i.labels.includes(label));

	console.log(c.bold("queue:"));
	if (queue.length === 0) console.log(c.dim("  (empty)"));
	for (const [i, iss] of queue.entries()) {
		console.log(`  ${i + 1}. #${iss.number} [p${issuePriority(iss)}] ${iss.title}`);
	}
	const awaitingMerge = issues.filter((i) => linkedPrIssues.has(i.number));
	if (awaitingMerge.length > 0) {
		console.log(c.bold("awaiting PR merge:"));
		for (const iss of awaitingMerge) console.log(`  #${iss.number} ${iss.title}`);
	}
	for (const [name, label] of [
		["in progress", LABELS.inProgress],
		["blocked", LABELS.blocked],
		["needs human", LABELS.needsHuman],
	] as const) {
		const list = byLabel(label);
		if (list.length > 0) {
			console.log(c.bold(`${name}:`));
			for (const iss of list) console.log(`  #${iss.number} ${iss.title}`);
		}
	}

	const runs = readRuns(cwd);
	if (runs.length > 0) {
		console.log(c.bold(`recent runs (last ${Math.min(runs.length, RECENT_RUNS)} of ${runs.length}):`));
		for (const run of runs.slice(-RECENT_RUNS)) {
			console.log(`  ${formatRun(run)}`);
		}
		console.log(c.bold("lifetime cost:") + ` ${formatCost(totalCost(runs))} across ${runs.length} run(s)`);
	}
}

async function commandTriage(args: CliArgs, cwd: string): Promise<void> {
	const config = { ...loadConfig(cwd), ...args.overrides };
	if (!(await git.isGitRepo(cwd))) throw new Error("Not a git repository.");
	await github.checkGhAuth(cwd);

	const all = await github.listOpenIssues(cwd);
	const issues = config.label ? all.filter((i) => i.labels.includes(config.label as string)) : all;
	if (issues.length === 0) {
		info("no open issues to triage");
		return;
	}

	banner(`triage: ${issues.length} open issue(s)${args.apply ? "" : " (dry run)"}`);
	const result = await runTriage(issues, config, cwd);
	info(`agent finished · ${result.turns} turns · ${formatCost(result.cost)}`);
	if (result.errorMessage) throw new Error(`triage agent error: ${result.errorMessage}`);
	if (result.abortedBy === "signal") {
		warn("triage interrupted; nothing applied");
		return;
	}
	if (result.abortedBy) throw new Error(`triage aborted: budget exhausted (${result.abortedBy})`);
	if (!result.report) throw new Error("triage agent never called triage_result");
	if (result.report.summary) info(result.report.summary);

	const plan = planTriage(result.report.entries, issues);
	printTriagePlan(plan);
	if (plan.ops.length === 0) return;

	if (!args.apply) {
		info("dry run — re-run with --apply to make these changes");
		return;
	}
	await github.ensureLabels(cwd); // gloop:design for design marks
	await applyTriagePlan(plan, cwd);
	info(`applied ${plan.ops.length} change(s)`);
}

const RECENT_RUNS = 10;

function formatRun(run: RunRecord): string {
	const when = run.timestamp.replace("T", " ").slice(0, 16);
	const color =
		run.kind === "landed" || run.kind === "split" || run.kind === "designed"
			? c.green
			: run.kind === "failed"
				? c.red
				: c.yellow;
	const extra = run.prUrl ? ` ${c.dim(run.prUrl)}` : ` ${c.dim(run.detail)}`;
	return `${c.dim(when)}  #${run.issue} ${color(run.kind)} ${formatCost(run.cost)}${extra}`;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const cwd = process.cwd();

	if (args.command === "help") {
		console.log(HELP);
	} else if (args.command === "version") {
		console.log(getVersion());
	} else if (args.command === "status") {
		await commandStatus(args, cwd);
	} else if (args.command === "triage") {
		await commandTriage(args, cwd);
	} else {
		await commandRun(args, cwd);
	}
}

main().catch((err) => {
	error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
