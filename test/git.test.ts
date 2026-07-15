import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPushError, decidePreflightRecovery } from "../src/git.js";

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
