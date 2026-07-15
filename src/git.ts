import { exec, run } from "./exec.js";

/**
 * Decide how preflight should handle the current branch/tree state.
 * Pure decision logic: only branches gloop itself created (branchPrefix) are ever
 * auto-reset; a dirty tree anywhere else is a hard error so we never destroy
 * work gloop did not create. In dry-run mode recovery is never performed —
 * dry-run must be strictly read-only — so leftover state only produces a warning.
 */
export type PreflightRecovery =
	| { action: "none" }
	| { action: "recover"; reason: string }
	| { action: "warn"; reason: string }
	| { action: "error"; message: string };

export function decidePreflightRecovery(
	branch: string,
	isClean: boolean,
	branchPrefix: string,
	dryRun = false,
): PreflightRecovery {
	if (branch.startsWith(branchPrefix)) {
		const reason = `leftover branch ${branch}${isClean ? "" : " with dirty tree"}`;
		if (dryRun) return { action: "warn", reason };
		return { action: "recover", reason };
	}
	if (!isClean) {
		return { action: "error", message: "Working tree is dirty. Commit or stash your changes first." };
	}
	return { action: "none" };
}

export async function isGitRepo(cwd: string): Promise<boolean> {
	const result = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
	return result.code === 0 && result.stdout.trim() === "true";
}

export async function isCleanTree(cwd: string): Promise<boolean> {
	const out = await run("git", ["status", "--porcelain"], { cwd });
	return out === "";
}

export async function currentBranch(cwd: string): Promise<string> {
	return run("git", ["branch", "--show-current"], { cwd });
}

export async function checkoutFreshBranch(cwd: string, branch: string, base: string): Promise<void> {
	await run("git", ["fetch", "origin", base], { cwd });
	await run("git", ["checkout", base], { cwd });
	await run("git", ["pull", "--ff-only", "origin", base], { cwd });
	// Delete a stale local branch from a previous crashed run, if any.
	await exec("git", ["branch", "-D", branch], { cwd });
	await run("git", ["checkout", "-b", branch], { cwd });
}

export async function hasChanges(cwd: string): Promise<boolean> {
	const out = await run("git", ["status", "--porcelain"], { cwd });
	return out !== "";
}

export async function commitAll(cwd: string, message: string): Promise<void> {
	await run("git", ["add", "-A"], { cwd });
	await run("git", ["commit", "-m", message], { cwd });
}

export type PushOutcome =
	| { ok: true }
	| { ok: false; reason: "non-fast-forward" | "unknown"; detail: string };

/**
 * Classify a failed `git push` from its stderr. A rejected non-fast-forward
 * push means the branch already exists remotely with different history —
 * almost always duplicate work from a previous run, not a transient error.
 */
export function classifyPushError(stderr: string): "non-fast-forward" | "unknown" {
	const s = stderr.toLowerCase();
	if (s.includes("non-fast-forward") || s.includes("fetch first") || s.includes("[rejected]")) {
		return "non-fast-forward";
	}
	return "unknown";
}

/** Push a branch. Never throws; returns a structured outcome so one bad push cannot kill the run. */
export async function pushBranch(cwd: string, branch: string): Promise<PushOutcome> {
	const result = await exec("git", ["push", "-u", "origin", branch], { cwd });
	if (result.code === 0) return { ok: true };
	const detail = (result.stderr || result.stdout).trim();
	return { ok: false, reason: classifyPushError(detail), detail };
}

export async function checkout(cwd: string, branch: string): Promise<void> {
	await run("git", ["checkout", branch], { cwd });
}

/** Squash-merge `branch` into `base` and push. Used by --direct. */
export async function squashMergeToBase(cwd: string, branch: string, base: string, message: string): Promise<void> {
	await run("git", ["checkout", base], { cwd });
	await run("git", ["merge", "--squash", branch], { cwd });
	await run("git", ["commit", "-m", message], { cwd });
	await run("git", ["push", "origin", base], { cwd });
}

/** Discard everything and return to base. Used on failure/abort. */
export async function abandonBranch(cwd: string, branch: string, base: string): Promise<void> {
	await exec("git", ["reset", "--hard"], { cwd });
	await exec("git", ["clean", "-fd"], { cwd });
	await exec("git", ["checkout", base], { cwd });
	await exec("git", ["branch", "-D", branch], { cwd });
}

export async function deleteLocalBranch(cwd: string, branch: string): Promise<void> {
	await exec("git", ["branch", "-D", branch], { cwd });
}
