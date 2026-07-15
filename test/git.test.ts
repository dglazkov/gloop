import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { classifyPushError, currentBranch, decidePreflightRecovery, isCleanTree } from "../src/git.js";

const PREFIX = "gloop/issue-";

test("dirty tree on a gloop work branch: auto-recover", () => {
	const decision = decidePreflightRecovery("gloop/issue-42", false, PREFIX);
	assert.equal(decision.action, "recover");
	assert.match((decision as { reason: string }).reason, /gloop\/issue-42/);
	assert.match((decision as { reason: string }).reason, /dirty tree/);
});

test("clean tree on a gloop work branch: auto-recover", () => {
	const decision = decidePreflightRecovery("gloop/issue-42", true, PREFIX);
	assert.equal(decision.action, "recover");
	assert.match((decision as { reason: string }).reason, /gloop\/issue-42/);
});

test("dirty tree on any other branch: hard error", () => {
	for (const branch of ["main", "feature/foo", "gloopish/issue-1", ""]) {
		const decision = decidePreflightRecovery(branch, false, PREFIX);
		assert.equal(decision.action, "error", `branch ${JSON.stringify(branch)}`);
		assert.equal(
			(decision as { message: string }).message,
			"Working tree is dirty. Commit or stash your changes first.",
		);
	}
});

test("clean tree on a non-gloop branch: nothing to do", () => {
	assert.deepEqual(decidePreflightRecovery("main", true, PREFIX), { action: "none" });
	assert.deepEqual(decidePreflightRecovery("feature/foo", true, PREFIX), { action: "none" });
});

test("dry-run: dirty tree on a gloop work branch only warns, never recovers", () => {
	const decision = decidePreflightRecovery("gloop/issue-42", false, PREFIX, true);
	assert.equal(decision.action, "warn");
	assert.match((decision as { reason: string }).reason, /gloop\/issue-42/);
	assert.match((decision as { reason: string }).reason, /dirty tree/);
});

test("dry-run: clean tree on a gloop work branch only warns, never recovers", () => {
	const decision = decidePreflightRecovery("gloop/issue-42", true, PREFIX, true);
	assert.equal(decision.action, "warn");
	assert.match((decision as { reason: string }).reason, /gloop\/issue-42/);
});

test("dry-run: non-gloop branches behave as before", () => {
	assert.deepEqual(decidePreflightRecovery("main", true, PREFIX, true), { action: "none" });
	assert.equal(decidePreflightRecovery("main", false, PREFIX, true).action, "error");
});

test("dry-run: dirty tree on a gloop work branch is left untouched", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gloop-git-test-"));
	const g = (...args: string[]) => execFileSync("git", args, { cwd });
	try {
		g("init", "-b", "main");
		g("config", "user.email", "test@example.com");
		g("config", "user.name", "test");
		fs.writeFileSync(path.join(cwd, "file.txt"), "original\n");
		g("add", "-A");
		g("commit", "-m", "init");
		g("checkout", "-b", "gloop/issue-42");
		fs.writeFileSync(path.join(cwd, "file.txt"), "uncommitted work\n");

		// The preflight decision under --dry-run: warn only, no recovery branch.
		const decision = decidePreflightRecovery(await currentBranch(cwd), await isCleanTree(cwd), PREFIX, true);
		assert.equal(decision.action, "warn");

		// Branch, HEAD, and the dirty tree are all untouched.
		assert.equal(await currentBranch(cwd), "gloop/issue-42");
		assert.equal(await isCleanTree(cwd), false);
		assert.equal(fs.readFileSync(path.join(cwd, "file.txt"), "utf8"), "uncommitted work\n");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// Captured stderr from a real rejected `git push` when gloop/issue-6 already existed remotely.
const NON_FAST_FORWARD =
	"To github.com:example/repo.git\n" +
	" ! [rejected]        gloop/issue-6 -> gloop/issue-6 (non-fast-forward)\n" +
	"error: failed to push some refs to 'github.com:example/repo.git'\n" +
	"hint: Updates were rejected because the tip of your current branch is behind\n" +
	"hint: its remote counterpart.";

test("classifies a rejected non-fast-forward push", () => {
	assert.equal(classifyPushError(NON_FAST_FORWARD), "non-fast-forward");
	assert.equal(classifyPushError("! [rejected] foo -> foo (fetch first)"), "non-fast-forward");
	assert.equal(classifyPushError(NON_FAST_FORWARD.toUpperCase()), "non-fast-forward");
});

test("other push failures are unknown", () => {
	assert.equal(classifyPushError(""), "unknown");
	assert.equal(classifyPushError("fatal: could not read from remote repository"), "unknown");
	assert.equal(classifyPushError("ssh: connect to host github.com port 22: Operation timed out"), "unknown");
});
