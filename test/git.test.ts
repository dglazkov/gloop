import assert from "node:assert/strict";
import { test } from "node:test";
import { decidePreflightRecovery } from "../src/git.js";

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
