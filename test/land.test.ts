import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, LABELS } from "../src/config.js";
import { depthMarker } from "../src/design.js";
import type { IssueDetail } from "../src/github.js";
import { buildSplitComment, detectVerifyCommands, planSplitEscalation, resolveVerifyCommands } from "../src/land.js";
import type { WorkReport } from "../src/worker.js";

function pkg(scripts: Record<string, string>): string {
	return JSON.stringify({ name: "fixture", scripts });
}

test("detectVerifyCommands: test only", () => {
	assert.deepEqual(detectVerifyCommands(pkg({ test: "node --test" })), ["npm test"]);
});

test("detectVerifyCommands: test, typecheck, and lint in order", () => {
	assert.deepEqual(detectVerifyCommands(pkg({ lint: "biome check", test: "node --test", typecheck: "tsc --noEmit" })), [
		"npm test",
		"npm run typecheck",
		"npm run lint",
	]);
});

test("detectVerifyCommands: typecheck and lint without test", () => {
	assert.deepEqual(detectVerifyCommands(pkg({ typecheck: "tsc --noEmit", lint: "eslint ." })), [
		"npm run typecheck",
		"npm run lint",
	]);
});

test("detectVerifyCommands: no relevant scripts", () => {
	assert.deepEqual(detectVerifyCommands(pkg({ build: "tsc" })), []);
	assert.deepEqual(detectVerifyCommands(JSON.stringify({ name: "no-scripts" })), []);
});

test("detectVerifyCommands: unparseable package.json detects nothing", () => {
	assert.deepEqual(detectVerifyCommands("not json"), []);
});

test("resolveVerifyCommands: verifyCommands wins over verifyCommand", () => {
	const config = {
		...DEFAULT_CONFIG,
		verifyCommands: ["make check", "make lint"],
		verifyCommand: "npm test",
	};
	assert.deepEqual(resolveVerifyCommands(config, "/nonexistent"), ["make check", "make lint"]);
});

test("resolveVerifyCommands: singular verifyCommand still works", () => {
	const config = { ...DEFAULT_CONFIG, verifyCommand: "make check" };
	assert.deepEqual(resolveVerifyCommands(config, "/nonexistent"), ["make check"]);
});

test("resolveVerifyCommands: empty verifyCommands falls through", () => {
	const config = { ...DEFAULT_CONFIG, verifyCommands: [], verifyCommand: "make check" };
	assert.deepEqual(resolveVerifyCommands(config, "/nonexistent"), ["make check"]);
});

test("resolveVerifyCommands: auto-detects from package.json on disk", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gloop-land-test-"));
	try {
		fs.writeFileSync(path.join(dir, "package.json"), pkg({ test: "node --test", lint: "eslint ." }));
		assert.deepEqual(resolveVerifyCommands(DEFAULT_CONFIG, dir), ["npm test", "npm run lint"]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveVerifyCommands: no package.json yields no commands", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gloop-land-test-"));
	try {
		assert.deepEqual(resolveVerifyCommands(DEFAULT_CONFIG, dir), []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function makeIssue(overrides: Partial<IssueDetail> = {}): IssueDetail {
	return {
		number: 7,
		title: "Big feature",
		body: "Do the big thing.",
		labels: [],
		createdAt: "2024-01-01T00:00:00Z",
		url: "https://github.com/o/r/issues/7",
		comments: [],
		...overrides,
	};
}

function makeSplitReport(overrides: Partial<WorkReport> = {}): WorkReport {
	return {
		outcome: "split",
		summary: "Too big for one session; needs an architecture pass.",
		followUps: [
			{ title: "Part one", body: "Do part one." },
			{ title: "Part two", body: "Do part two.\nWith details." },
		],
		...overrides,
	};
}

test("planSplitEscalation: normal split escalates to a design session", () => {
	const plan = planSplitEscalation(makeIssue(), makeSplitReport());
	assert.equal(plan.action, "escalate");
	if (plan.action !== "escalate") return;
	assert.equal(plan.label, LABELS.design);
	assert.equal(plan.detail, "escalated to design session");
	assert.ok(
		plan.comment.startsWith(
			"↪️ gloop: worker escalated this issue for a design pass. Its notes and rough decomposition below are input, not the plan.",
		),
	);
	assert.ok(plan.comment.includes("Too big for one session; needs an architecture pass."));
	assert.ok(plan.comment.includes("- **Part one**"));
	assert.ok(plan.comment.includes("- **Part two**"));
	assert.ok(plan.comment.includes("Do part two."));
});

test("planSplitEscalation: depth marker in body escalates to needs-human", () => {
	const issue = makeIssue({ body: `Do the sub-thing.\n\n${depthMarker(1)}` });
	const plan = planSplitEscalation(issue, makeSplitReport());
	assert.equal(plan.action, "escalate");
	if (plan.action !== "escalate") return;
	assert.equal(plan.label, LABELS.needsHuman);
	assert.ok(plan.detail.includes("escalated to human"));
});

test("planSplitEscalation: epic label escalates to needs-human (routing bug)", () => {
	const issue = makeIssue({ labels: [LABELS.epic] });
	const plan = planSplitEscalation(issue, makeSplitReport());
	assert.equal(plan.action, "escalate");
	if (plan.action !== "escalate") return;
	assert.equal(plan.label, LABELS.needsHuman);
	assert.ok(plan.detail.includes("routing bug"));
});

test("planSplitEscalation: no follow-ups and empty summary is a failure", () => {
	const plan = planSplitEscalation(makeIssue(), makeSplitReport({ summary: "  ", followUps: [] }));
	assert.equal(plan.action, "fail");
	if (plan.action !== "fail") return;
	assert.ok(plan.reason.includes("no findings"));
});

test("planSplitEscalation: summary alone is enough to escalate", () => {
	const plan = planSplitEscalation(makeIssue(), makeSplitReport({ followUps: [] }));
	assert.equal(plan.action, "escalate");
	if (plan.action !== "escalate") return;
	assert.equal(plan.label, LABELS.design);
	assert.ok(!plan.comment.includes("Proposed decomposition:"));
});

test("buildSplitComment: renders follow-ups as a markdown list with indented bodies", () => {
	const comment = buildSplitComment(makeSplitReport());
	assert.ok(comment.includes("Proposed decomposition:"));
	assert.ok(comment.includes("- **Part one**\n  Do part one."));
	assert.ok(comment.includes("- **Part two**\n  Do part two.\n  With details."));
});
