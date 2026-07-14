#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { type GloopConfig, LABELS, loadConfig } from "./config.js";
import * as git from "./git.js";
import * as github from "./github.js";
import { landBlocked, landDone, landSplit, recordFailure } from "./land.js";
import { buildQueue, getAttempts, issuePriority } from "./queue.js";
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
  --verify <cmd>            verification command (default: auto-detect npm test)
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

async function preflight(cwd: string): Promise<{ defaultBranch: string }> {
	if (!(await git.isGitRepo(cwd))) throw new Error("Not a git repository.");
	await github.checkGhAuth(cwd);
	const repo = await github.getRepoInfo(cwd);
	if (!(await git.isCleanTree(cwd))) {
		throw new Error("Working tree is dirty. Commit or stash your changes first.");
	}
	await github.ensureLabels(cwd);
	return { defaultBranch: repo.defaultBranch };
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

	banner(`#${issue.number}: ${issue.title}`);
	info(`attempt ${attempts + 1}/${config.maxAttempts} · branch ${branch}`);

	// Claim (lease). Crash-safe: a human can remove the label to un-stick.
	await github.addLabels(cwd, issue.number, [LABELS.inProgress]);
	await git.checkoutFreshBranch(cwd, branch, defaultBranch);

	let result: WorkResult | undefined;
	try {
		result = await runWorker(issue, config, cwd);

		info(`agent finished · ${result.turns} turns · ${formatCost(result.cost)}`);

		let outcome;
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
		return { kind: outcome.kind, result };
	} finally {
		await github.removeLabels(cwd, issue.number, [LABELS.inProgress]);
		// Always leave the tree clean on the default branch.
		if (!(await git.isCleanTree(cwd)) || (await git.currentBranch(cwd)) !== defaultBranch) {
			await git.abandonBranch(cwd, branch, defaultBranch);
		}
	}
}

async function commandRun(args: CliArgs, cwd: string): Promise<void> {
	const config = { ...loadConfig(cwd), ...args.overrides };
	const { defaultBranch } = await preflight(cwd);

	let stopAfterCurrent = false;
	const onSigint = () => {
		if (stopAfterCurrent) process.exit(130); // second SIGINT: hard exit
		stopAfterCurrent = true;
		warn("SIGINT: finishing current issue, then stopping (Ctrl+C again to abort)");
	};
	process.on("SIGINT", onSigint);

	let worked = 0;
	let totalCost = 0;

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
			const queue = buildQueue(issues, config, linkedPrIssues);
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

		const { kind, result } = await workOneIssue(target, config, cwd, defaultBranch);
		worked += 1;
		totalCost += result?.cost ?? 0;

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
