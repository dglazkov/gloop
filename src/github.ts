import { LABEL_DEFS } from "./config.js";
import { exec, type ExecResult, run } from "./exec.js";

export interface Issue {
	number: number;
	title: string;
	body: string;
	labels: string[];
	createdAt: string;
	url: string;
}

export interface IssueComment {
	author: string;
	body: string;
	createdAt: string;
}

export interface IssueDetail extends Issue {
	comments: IssueComment[];
}

export interface RepoInfo {
	nameWithOwner: string;
	defaultBranch: string;
}

function parseLabels(raw: Array<{ name: string }>): string[] {
	return (raw ?? []).map((l) => l.name);
}

export async function checkGhAuth(cwd: string): Promise<void> {
	const result = await exec("gh", ["auth", "status"], { cwd });
	if (result.code !== 0) {
		throw new Error(`gh is not authenticated. Run \`gh auth login\`.\n${result.stderr}`);
	}
}

export async function getRepoInfo(cwd: string): Promise<RepoInfo> {
	const out = await run("gh", ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], { cwd });
	const json = JSON.parse(out);
	return { nameWithOwner: json.nameWithOwner, defaultBranch: json.defaultBranchRef.name };
}

export async function listOpenIssues(cwd: string): Promise<Issue[]> {
	const out = await run(
		"gh",
		["issue", "list", "--state", "open", "--limit", "500", "--json", "number,title,body,labels,createdAt,url"],
		{ cwd },
	);
	const raw = JSON.parse(out) as Array<Record<string, unknown>>;
	return raw.map((r) => ({
		number: r.number as number,
		title: r.title as string,
		body: (r.body as string) ?? "",
		labels: parseLabels(r.labels as Array<{ name: string }>),
		createdAt: r.createdAt as string,
		url: r.url as string,
	}));
}

/**
 * Numbers of open issues that have a linked pull request (closing reference).
 * GitHub drops the link when a PR is closed without merging, so this
 * effectively means "an open PR is already in flight for this issue".
 */
export async function listIssueNumbersWithLinkedPr(cwd: string): Promise<Set<number>> {
	const out = await run(
		"gh",
		["issue", "list", "--state", "open", "--search", "linked:pr", "--limit", "500", "--json", "number"],
		{ cwd },
	);
	const raw = JSON.parse(out) as Array<{ number: number }>;
	return new Set(raw.map((r) => r.number));
}

export async function viewIssue(cwd: string, num: number): Promise<IssueDetail> {
	const out = await run(
		"gh",
		["issue", "view", String(num), "--json", "number,title,body,labels,createdAt,url,comments,state"],
		{ cwd },
	);
	const raw = JSON.parse(out);
	if (raw.state && raw.state !== "OPEN") {
		throw new Error(`Issue #${num} is not open (state: ${raw.state}).`);
	}
	return {
		number: raw.number,
		title: raw.title,
		body: raw.body ?? "",
		labels: parseLabels(raw.labels),
		createdAt: raw.createdAt,
		url: raw.url,
		comments: (raw.comments ?? []).map((c: { author?: { login?: string }; body: string; createdAt: string }) => ({
			author: c.author?.login ?? "unknown",
			body: c.body,
			createdAt: c.createdAt,
		})),
	};
}

export async function addLabels(cwd: string, num: number, labels: string[]): Promise<void> {
	await run("gh", ["issue", "edit", String(num), ...labels.flatMap((l) => ["--add-label", l])], { cwd });
}

export async function removeLabels(cwd: string, num: number, labels: string[]): Promise<void> {
	// Not fatal if the label was already removed.
	await exec("gh", ["issue", "edit", String(num), ...labels.flatMap((l) => ["--remove-label", l])], { cwd });
}

export async function commentOnIssue(cwd: string, num: number, body: string): Promise<void> {
	await run("gh", ["issue", "comment", String(num), "--body", body], { cwd });
}

export async function closeIssue(cwd: string, num: number, comment: string): Promise<void> {
	await run("gh", ["issue", "close", String(num), "--comment", comment], { cwd });
}

/** Returns the created issue number. */
export async function createIssue(cwd: string, title: string, body: string, labels: string[]): Promise<number> {
	const args = ["issue", "create", "--title", title, "--body", body];
	for (const l of labels) args.push("--label", l);
	const out = await run("gh", args, { cwd });
	// gh prints the issue URL, e.g. https://github.com/owner/repo/issues/42
	const match = out.match(/\/issues\/(\d+)/);
	if (!match) throw new Error(`Could not parse issue number from gh output: ${out}`);
	return Number(match[1]);
}

/** Returns the PR URL. */
export async function createPr(cwd: string, branch: string, title: string, body: string): Promise<string> {
	const out = await run("gh", ["pr", "create", "--head", branch, "--title", title, "--body", body], { cwd });
	const match = out.match(/https:\/\/\S+\/pull\/\d+/);
	return match ? match[0] : out;
}

export type AutoMergeErrorKind = "clean-status" | "auto-merge-disallowed" | "unknown";

/**
 * Classify why `gh pr merge --auto` failed, from its stderr/stdout.
 *
 * Observed failures:
 * - `GraphQL: Pull request Pull request is in clean status (enablePullRequestAutoMerge)`
 *   — nothing is pending, so GitHub refuses to arm auto-merge; a direct merge works.
 * - `GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)`
 *   — the repo's "Allow auto-merge" setting is off.
 */
export function classifyAutoMergeError(output: string): AutoMergeErrorKind {
	if (/pull request is in clean status/i.test(output)) return "clean-status";
	if (/auto[- ]?merge is not allowed for this repository/i.test(output)) return "auto-merge-disallowed";
	return "unknown";
}

export interface MergeResult {
	/**
	 * merged: the PR was merged directly.
	 * auto-merge-armed: GitHub will merge once checks pass.
	 * left-open: neither worked; a human must merge.
	 */
	outcome: "merged" | "auto-merge-armed" | "left-open";
	message?: string;
	/** Actionable advice (e.g. enable the repo's auto-merge setting). */
	hint?: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryDirectMerge(cwd: string, prUrl: string): Promise<ExecResult> {
	return exec("gh", ["pr", "merge", prUrl, "--squash"], { cwd });
}

async function autoMergeDisallowedHint(cwd: string): Promise<string> {
	let repo = "{owner}/{repo}";
	try {
		repo = (await getRepoInfo(cwd)).nameWithOwner;
	} catch {
		// keep the placeholder
	}
	return `auto-merge is not allowed for this repository; enable it with \`gh api -X PATCH repos/${repo} -F allow_auto_merge=true\``;
}

/**
 * Merge a PR as soon as permitted. Tries `gh pr merge --auto --squash` first;
 * falls back to a direct merge when auto-merge is refused (clean status, or
 * the repo has auto-merge disabled — in that case polling briefly in case
 * checks are still registering).
 */
export async function enableAutoMerge(
	cwd: string,
	prUrl: string,
	opts: { pollTimeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<MergeResult> {
	const auto = await exec("gh", ["pr", "merge", prUrl, "--auto", "--squash"], { cwd });
	if (auto.code === 0) return { outcome: "auto-merge-armed" };

	const error = auto.stderr.trim() || auto.stdout.trim();
	const kind = classifyAutoMergeError(error);

	if (kind === "clean-status") {
		// Nothing pending: "merge as soon as permitted" means now.
		const direct = await tryDirectMerge(cwd, prUrl);
		if (direct.code === 0) return { outcome: "merged" };
		return { outcome: "left-open", message: direct.stderr.trim() || direct.stdout.trim() };
	}

	if (kind === "auto-merge-disallowed") {
		const hint = await autoMergeDisallowedHint(cwd);
		// Poll a direct merge briefly in case checks are still registering.
		const timeoutMs = opts.pollTimeoutMs ?? 120_000;
		const intervalMs = opts.pollIntervalMs ?? 10_000;
		const deadline = Date.now() + timeoutMs;
		let lastError = error;
		for (;;) {
			const direct = await tryDirectMerge(cwd, prUrl);
			if (direct.code === 0) return { outcome: "merged", hint };
			lastError = direct.stderr.trim() || direct.stdout.trim();
			if (Date.now() + intervalMs > deadline) break;
			await sleep(intervalMs);
		}
		return { outcome: "left-open", message: lastError, hint };
	}

	return { outcome: "left-open", message: error };
}

/** Idempotently create gloop's state-machine labels. */
export async function ensureLabels(cwd: string): Promise<void> {
	for (const def of LABEL_DEFS) {
		await exec("gh", ["label", "create", def.name, "--color", def.color, "--description", def.description, "--force"], {
			cwd,
		});
	}
}
