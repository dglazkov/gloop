import { exec, run } from "./exec.js";

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

export async function pushBranch(cwd: string, branch: string): Promise<void> {
	await run("git", ["push", "-u", "origin", branch], { cwd });
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
