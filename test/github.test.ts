import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAutoMergeError } from "../src/github.js";

// Captured stderr from real `gh pr merge --auto --squash` failures.
const CLEAN_STATUS = "GraphQL: Pull request Pull request is in clean status (enablePullRequestAutoMerge)";
const NO_PROTECTION_RULES =
	"GraphQL: Pull request Protected branch rules not configured for this branch (enablePullRequestAutoMerge)";
const DISALLOWED = "GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)";

test("classifies clean-status: PR is mergeable now, no checks pending", () => {
	assert.equal(classifyAutoMergeError(CLEAN_STATUS), "clean-status");
});

test("classifies no-protection-rules: no branch protection, direct merge works", () => {
	assert.equal(classifyAutoMergeError(NO_PROTECTION_RULES), "no-protection-rules");
});

test("classifies auto-merge-disallowed: repo setting is off", () => {
	assert.equal(classifyAutoMergeError(DISALLOWED), "auto-merge-disallowed");
});

test("classification is case-insensitive and tolerates surrounding output", () => {
	assert.equal(classifyAutoMergeError(`some noise\n${CLEAN_STATUS.toUpperCase()}\nmore noise`), "clean-status");
	assert.equal(classifyAutoMergeError(`X ${DISALLOWED.toLowerCase()} Y`), "auto-merge-disallowed");
	assert.equal(
		classifyAutoMergeError(`noise\n${NO_PROTECTION_RULES.toUpperCase()}\nnoise`),
		"no-protection-rules",
	);
	// "Automerge" (no hyphen/space) variant.
	assert.equal(
		classifyAutoMergeError("GraphQL: Automerge is not allowed for this repository"),
		"auto-merge-disallowed",
	);
});

test("anything else is unknown", () => {
	assert.equal(classifyAutoMergeError(""), "unknown");
	assert.equal(classifyAutoMergeError("GraphQL: Pull request is in dirty status"), "unknown");
	assert.equal(
		classifyAutoMergeError("failed to run git: exit status 128"),
		"unknown",
	);
	assert.equal(
		classifyAutoMergeError("GraphQL: Base branch was modified (mergePullRequest)"),
		"unknown",
	);
});
