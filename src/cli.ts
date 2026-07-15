#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { ConsecutiveFailureBreaker } from "./breaker.js";
import { type GloopConfig, LABELS, loadConfig } from "./config.js";
import * as git from "./git.js";
import * as github from "./github.js";
import { landBlocked, landDone, landSplit, type LandOutcome, recordFailure } from "./land.js";
import { appendRun, readRuns, type RunRecord, totalCost } from "./ledger.js";
import { buildQueue, decidePreClaim, getAttempts, isLeaseStale, issuePriority, leaseMarker } from "./queue.js";
import { banner, c, error, formatCost, info, warn } from "./render.js";
import { getVersion } from "./version.js";
import { runWorker, type WorkResult } from "./worker.js";

const HELP = `gloop — GitHub-issue-powered agent loop

Usage:
  gloop [options]           work the issue queue until empty or budget hit
  gloop status              show queue order and gloop-labeled issue states
  gloop triage              (coming in M2) prioritize/decompose issues

Options:
  --once                    work one issue, then exit
  --issue <n>               work a specific issue
  --dry-run                 show what would be picked; do no work
  --label <name>            only work issues carrying this label
  --model <spec>            pi model, e.g. anthropic/claude-opus-4-5:high
  --direct                  commit to the default branch instead of a PR
  --auto-merge / --no-auto-merge   enable/disable PR auto-merge (default: on)
  --verify <cmd>            verification command (default: auto-detect npm test/typecheck/lint)
  --max-issues <n>          max issues this run
  --max-cost <usd>          max total cost this run
  --max-turns <n>           max agent turns per issue
  --max-attempts <n>        attempts before gloop:needs-human
  -v, --version             show version
  -h, --help                show this help
`;

interface CliArgs {
	command: "run" | "status" | "triage";
	once: boolean;
	issue?: number;
	dryRun: boolean;
	overrides: Partial<GloopConfig>;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = { command: "run", once: false, dryRun: false, overrides: {} };
	const rest = [...argv];
	while (rest.length > 0) {
		const arg = rest.shift() as string;
		const next = () => {
			const v = rest.shift();
			if (v === undefined) throw new Error(`${arg} requires a value`);
			return v;
		};
		switch (arg) {
			case "status":
			case "triage":
				args.command = arg;
				break;
			case "--once":
				args.once = true;
				break;
			case "--issue":
				args.issue = Number(next());
				args.once = true;
				break;
			case "--dry-run":
				args.dryRun = true;
				break;
			case "--label":
				args.overrides.label = next();
				break;
			case "--model":
				args.overrides.model = next();
				break;
			case "--direct":
				args.overrides.direct = true;
				break;
			case "--auto-merge":
				args.overrides.autoMerge = true;
				break;
			case "--no-auto-merge":
				args.overrides.autoMerge = false;
				break;
			case "--verify":
				args.overrides.verifyCommand = next();
				break;
			case "--max-issues":
				args.overrides.maxIssuesPerRun = Number(next());
				break;
			case "--max-cost":
				args.overrides.maxCostPerRun = Number(next());
				break;
			case "--max-turns":
				args.overrides.maxTurnsPerIssue = Number(next());
				break;
			case "--max-attempts":
				args.overrides.maxAttempts = Number(next());
				break;
			case "-h":
			case "--help":
				console.log(HELP);
				process.exit(0);
				break;
			case "-v":
			case "--version":
				console.log(getVersion());
				process.exit(0);
				break;
			default:
				throw new Error(`Unknown argument: ${arg} (try --help)`);
		}
	}
	return args;
}

function stopRequested(cwd: string): boolean {
	return fs.existsSync(path.join(cwd, ".gloop", "STOP"));
}

async function preflight(cwd: string, config: GloopConfig): Promise<{ defaultBranch: string }> {
	if (!(await git.isGitRepo(cwd))) throw new Error("Not a git repository.");
	await github.checkGhAuth(cwd);
	const repo = await github.getRepoInfo(cwd);
	// Recover from a crashed run: a leftover gloop work branch means the previous
	// run never reached its cleanup; reset to the default branch. Never auto-reset
	// any other branch — a dirty tree there is human work, so refuse to run.
	const branch = await git.currentBranch(cwd);
	const recovery = git.decidePreflightRecovery(branch, await git.isCleanTree(cwd), config.branchPrefix);
	if (recovery.action === "error") throw new Error(recovery.message);
	if (recovery.action === "recover") {
		warn(`recovering from a previous run (${recovery.reason}); resetting to ${repo.defaultBranch}`);
		await git.abandonBranch(cwd, branch, repo.defaultBranch);
	}
	await github.ensureLabels(cwd);
	return { defaultBranch: repo.defaultBranch };
}

/** Un-wedge issues left gloop:in-progress by a crashed run once their lease expires. */
async function reclaimStaleLeases(issues: github.Issue[], config: GloopConfig, cwd: string): Promise<void> {
	for (const issue of issues) {
		if (!issue.labels.includes(LABELS.inProgress)) continue;
		const detail = await github.viewIssue(cwd, issue.number);
		if (!isLeaseStale(detail.comments, config.leaseTtlMinutes)) continue;
		warn(`#${issue.number}: lease older than ${config.leaseTtlMinutes}m; reclaiming`);
		await github.removeLabels(cwd, issue.number, [LABELS.inProgress]);
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
	const { defaultBranch } = await preflight(cwd, config);

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
		if (target === undefined) {
			const [issues, linkedPrIssues] = await Promise.all([
				github.listOpenIssues(cwd),
				github.listIssueNumbersWithLinkedPr(cwd),
			]);
			await reclaimStaleLeases(issues, config, cwd);
			const excluded = new Set([...linkedPrIssues, ...handledThisRun]);
			const queue = buildQueue(issues, config, excluded);
			if (queue.length === 0) {
				info(worked === 0 ? "no eligible open issues" : `queue empty · worked ${worked} issue(s) · ${formatCost(totalCost)}`);
				break;
			}
			if (args.dryRun) {
				info(`queue (${queue.length}):`);
				for (const [i, iss] of queue.entries()) {
					console.log(`  ${i + 1}. #${iss.number} [p${issuePriority(iss)}] ${iss.title} ${c.dim(iss.labels.join(","))}`);
				}
				return;
			}
			target = queue[0].number;
		} else if (args.dryRun) {
			info(`would work #${target}`);
			return;
		}

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

const RECENT_RUNS = 10;

function formatRun(run: RunRecord): string {
	const when = run.timestamp.replace("T", " ").slice(0, 16);
	const color = run.kind === "landed" || run.kind === "split" ? c.green : run.kind === "failed" ? c.red : c.yellow;
	const extra = run.prUrl ? ` ${c.dim(run.prUrl)}` : ` ${c.dim(run.detail)}`;
	return `${c.dim(when)}  #${run.issue} ${color(run.kind)} ${formatCost(run.cost)}${extra}`;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const cwd = process.cwd();

	if (args.command === "status") {
		await commandStatus(args, cwd);
	} else if (args.command === "triage") {
		warn("gloop triage is coming in M2");
	} else {
		await commandRun(args, cwd);
	}
}

main().catch((err) => {
	error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
