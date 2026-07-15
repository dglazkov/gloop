import assert from "node:assert/strict";
import { test } from "node:test";
import type { Issue } from "../src/github.js";
import { checkTriageBashCommand, planTriage, type TriageEntry } from "../src/triage.js";

function issue(number: number, labels: string[] = []): Issue {
	return {
		number,
		title: `Issue ${number}`,
		body: "",
		labels,
		createdAt: "2024-01-01T00:00:00Z",
		url: `https://github.com/o/r/issues/${number}`,
	};
}

/* ------------------------------------------------------------ planTriage --- */

test("planTriage: priority maps to a label op", () => {
	const plan = planTriage([{ issue: 1, priority: "high" }], [issue(1)], 5);
	assert.deepEqual(plan.ops, [{ kind: "label", issue: 1, add: "priority:high", remove: [] }]);
	assert.deepEqual(plan.skipped, []);
});

test("planTriage: replacing an existing priority removes the old label", () => {
	const plan = planTriage([{ issue: 1, priority: "critical" }], [issue(1, ["priority:low", "bug"])], 5);
	assert.deepEqual(plan.ops, [{ kind: "label", issue: 1, add: "priority:critical", remove: ["priority:low"] }]);
});

test("planTriage: recognizes P0-P3 spellings as priority labels to replace", () => {
	const plan = planTriage([{ issue: 1, priority: "medium" }], [issue(1, ["P1"])], 5);
	assert.deepEqual(plan.ops, [{ kind: "label", issue: 1, add: "priority:medium", remove: ["P1"] }]);
});

test("planTriage: priority already correct is a no-op", () => {
	const plan = planTriage([{ issue: 1, priority: "high" }], [issue(1, ["priority:high"])], 5);
	assert.deepEqual(plan.ops, []);
	assert.deepEqual(plan.skipped, []);
});

test("planTriage: duplicate maps to a duplicate op", () => {
	const plan = planTriage([{ issue: 2, duplicateOf: 1 }], [issue(1), issue(2)], 5);
	assert.deepEqual(plan.ops, [{ kind: "duplicate", issue: 2, of: 1 }]);
});

test("planTriage: duplicate of a non-open issue is skipped", () => {
	const plan = planTriage([{ issue: 2, duplicateOf: 99 }], [issue(1), issue(2)], 5);
	assert.deepEqual(plan.ops, []);
	assert.equal(plan.skipped.length, 1);
	assert.equal(plan.skipped[0].issue, 2);
});

test("planTriage: self-duplicate is skipped", () => {
	const plan = planTriage([{ issue: 2, duplicateOf: 2 }], [issue(2)], 5);
	assert.deepEqual(plan.ops, []);
	assert.equal(plan.skipped.length, 1);
});

test("planTriage: decomposition maps to a decompose op, capped at maxFollowUps", () => {
	const followUps = [
		{ title: "a", body: "a" },
		{ title: "b", body: "b" },
		{ title: "c", body: "c" },
	];
	const plan = planTriage([{ issue: 1, followUps }], [issue(1)], 2);
	assert.equal(plan.ops.length, 1);
	const op = plan.ops[0];
	assert.equal(op.kind, "decompose");
	assert.deepEqual(
		(op as { followUps: Array<{ title: string }> }).followUps.map((f) => f.title),
		["a", "b"],
	);
});

test("planTriage: unknown issue numbers are skipped", () => {
	const plan = planTriage([{ issue: 42, priority: "low" }], [issue(1)], 5);
	assert.deepEqual(plan.ops, []);
	assert.equal(plan.skipped[0].issue, 42);
});

test("planTriage: repeated entries for the same issue are skipped", () => {
	const entries: TriageEntry[] = [
		{ issue: 1, priority: "high" },
		{ issue: 1, priority: "low" },
	];
	const plan = planTriage(entries, [issue(1)], 5);
	assert.deepEqual(plan.ops, [{ kind: "label", issue: 1, add: "priority:high", remove: [] }]);
	assert.equal(plan.skipped.length, 1);
});

test("planTriage: one entry can carry priority, duplicate, and decomposition", () => {
	const entries: TriageEntry[] = [
		{ issue: 2, priority: "medium", duplicateOf: 1, followUps: [{ title: "x", body: "y" }] },
	];
	const plan = planTriage(entries, [issue(1), issue(2)], 5);
	assert.deepEqual(
		plan.ops.map((o) => o.kind),
		["label", "duplicate", "decompose"],
	);
});

test("planTriage: empty entries yield an empty plan", () => {
	const plan = planTriage([], [issue(1)], 5);
	assert.deepEqual(plan.ops, []);
	assert.deepEqual(plan.skipped, []);
});

/* --------------------------------------------- checkTriageBashCommand ----- */

function blocked(cmd: string): void {
	const reason = checkTriageBashCommand(cmd);
	assert.equal(typeof reason, "string", `expected blocked: ${cmd}`);
	assert.ok((reason as string).startsWith("gloop guard:"), `reason should be prefixed: ${reason}`);
}

function allowed(cmd: string): void {
	assert.equal(checkTriageBashCommand(cmd), undefined, `expected allowed: ${cmd}`);
}

test("checkTriageBashCommand: inherits the standard worker blocks", () => {
	blocked("git push");
	blocked("git commit -m x");
	blocked("gh pr create");
	blocked("gh issue close 1");
	blocked("echo x > .gloop.json");
});

test("checkTriageBashCommand: blocks mutating git commands", () => {
	blocked("git add -A");
	blocked("git stash");
	blocked("git branch -D feature");
	blocked("git tag v1.0.0");
	blocked("git clean -fd");
	blocked("git merge main");
	blocked("git apply patch.diff");
});

test("checkTriageBashCommand: blocks mutating gh commands", () => {
	blocked("gh issue comment 3 --body hi");
	blocked("gh issue edit 4 --add-label bug");
	blocked("gh label create foo");
	blocked("gh label delete foo");
	blocked("gh workflow run ci");
});

test("checkTriageBashCommand: allows read-only git commands", () => {
	allowed("git status");
	allowed("git log --oneline -20");
	allowed("git diff HEAD~1");
	allowed("git show abc123");
	allowed("git blame src/cli.ts");
	allowed("git grep TODO");
});

test("checkTriageBashCommand: allows read-only gh commands", () => {
	allowed("gh issue list --state open");
	allowed("gh issue view 5 --comments");
	allowed("gh label list");
	allowed("gh search issues foo");
	allowed("gh auth status");
});

test("checkTriageBashCommand: allows ordinary commands", () => {
	allowed("npm test");
	allowed("ls -la src");
	allowed("grep -r pattern src/");
	allowed("cat README.md");
});
