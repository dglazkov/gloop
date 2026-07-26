import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildChecklistComment,
	checkDesignBashCommand,
	depthMarker,
	designFailureReason,
	type DesignResult,
	getDepth,
	planSubIssues,
} from "../src/design.js";

/* ------------------------------------------------------------- getDepth --- */

test("getDepth: missing marker means depth 0", () => {
	assert.equal(getDepth(""), 0);
	assert.equal(getDepth("Just an ordinary issue body."), 0);
});

test("getDepth: parses the hidden depth marker", () => {
	assert.equal(getDepth("Context.\n\n<!-- gloop:depth=1 -->\n\nMore."), 1);
});

test("getDepth: tolerates whitespace variations", () => {
	assert.equal(getDepth("<!--gloop:depth=2-->"), 2);
	assert.equal(getDepth("<!--   gloop:depth=3   -->"), 3);
});

test("depthMarker: round-trips through getDepth", () => {
	assert.equal(getDepth(depthMarker(2)), 2);
});

/* ---------------------------------------------------------------- guard --- */

test("guard: allows read-only git and gh commands", () => {
	assert.equal(checkDesignBashCommand("git log --oneline -20"), undefined);
	assert.equal(checkDesignBashCommand("git grep -n 'runWorker' src"), undefined);
	assert.equal(checkDesignBashCommand("gh issue view 12 --comments"), undefined);
	assert.equal(checkDesignBashCommand("rg 'planSubIssues' src"), undefined);
});

test("guard: blocks mutating git commands, naming the design session", () => {
	const reason = checkDesignBashCommand("git add -A");
	assert.ok(reason?.includes("design is read-only"), reason);
	assert.ok(checkDesignBashCommand("git stash"));
});

test("guard: blocks mutating gh commands", () => {
	const reason = checkDesignBashCommand("gh label create foo");
	assert.ok(reason?.includes("design is read-only"), reason);
	assert.ok(checkDesignBashCommand("gh issue edit 3 --add-label bug"));
});

test("guard: base worker guard still applies", () => {
	assert.ok(checkDesignBashCommand("git commit -m 'x'"));
	assert.ok(checkDesignBashCommand("gh issue create --title x"));
});

/* ---------------------------------------------------------- planSubIssues --- */

const sub = (title: string, order: number, labels?: string[]) => ({
	title,
	body: `Body of ${title}`,
	order,
	labels,
});

test("planSubIssues: sorts by order and maps order to descending priority labels", () => {
	const plan = planSubIssues([sub("second", 2), sub("first", 1), sub("third", 3), sub("fourth", 4)], 40, 0, 5);
	assert.deepEqual(
		plan.file.map((s) => s.title),
		["first", "second", "third", "fourth"],
	);
	assert.ok(plan.file[0].labels.includes("priority:high"));
	assert.ok(plan.file[1].labels.includes("priority:medium"));
	assert.ok(plan.file[2].labels.includes("priority:low"));
	assert.ok(plan.file[3].labels.includes("priority:low"));
	assert.deepEqual(plan.overflow, []);
});

test("planSubIssues: bodies get a depth marker (parent depth + 1) and a parent footer", () => {
	const plan = planSubIssues([sub("one", 1)], 40, 1, 5);
	assert.equal(getDepth(plan.file[0].body), 2);
	assert.ok(plan.file[0].body.includes("_Filed by gloop design session for #40._"));
	assert.ok(plan.file[0].body.startsWith("Body of one"));
});

test("planSubIssues: every filed sub-issue carries the gloop:filed label", () => {
	const plan = planSubIssues([sub("one", 1), sub("two", 2)], 7, 0, 5);
	for (const s of plan.file) assert.ok(s.labels.includes("gloop:filed"));
});

test("planSubIssues: keeps custom labels but strips agent-supplied priority labels", () => {
	const plan = planSubIssues([sub("one", 1, ["bug", "priority:low", "P2"])], 7, 0, 5);
	assert.ok(plan.file[0].labels.includes("bug"));
	assert.ok(plan.file[0].labels.includes("priority:high"));
	assert.ok(!plan.file[0].labels.includes("priority:low"));
	assert.ok(!plan.file[0].labels.includes("P2"));
});

test("planSubIssues: caps at maxFollowUps, remainder becomes overflow titles in order", () => {
	const plan = planSubIssues([sub("d", 4), sub("a", 1), sub("c", 3), sub("b", 2)], 7, 0, 2);
	assert.deepEqual(
		plan.file.map((s) => s.title),
		["a", "b"],
	);
	assert.deepEqual(plan.overflow, ["c", "d"]);
});

/* -------------------------------------------------- buildChecklistComment --- */

test("buildChecklistComment: checklist in order", () => {
	const comment = buildChecklistComment([41, 42, 43], []);
	assert.ok(comment.startsWith("🧩 Decomposed into:"));
	const lines = comment.split("\n");
	assert.deepEqual(lines.slice(2), ["- [ ] #41", "- [ ] #42", "- [ ] #43"]);
});

test("buildChecklistComment: overflow is listed as plain text without issue refs", () => {
	const comment = buildChecklistComment([41], ["Extra work one", "Extra work two"]);
	assert.ok(comment.includes("- [ ] #41"));
	assert.ok(comment.includes("- Extra work one"));
	assert.ok(comment.includes("- Extra work two"));
	assert.ok(!comment.includes("#Extra"));
});

/* --------------------------------------------------- designFailureReason --- */

function result(overrides: Partial<DesignResult>): DesignResult {
	return { cost: 0, turns: 1, ...overrides };
}

test("designFailureReason: zero sub-issues is a failure", () => {
	const r = result({ report: { design: "doc", subIssues: [] } });
	assert.equal(designFailureReason(r), "design declared no sub-issues");
});

test("designFailureReason: missing report is a failure", () => {
	assert.equal(designFailureReason(result({})), "agent never called design_result");
});

test("designFailureReason: budget exhaustion is a failure", () => {
	assert.equal(designFailureReason(result({ abortedBy: "cost" })), "budget exhausted (cost)");
});

test("designFailureReason: agent error is a failure", () => {
	assert.equal(designFailureReason(result({ errorMessage: "boom" })), "agent error: boom");
});

test("designFailureReason: a report with sub-issues succeeds", () => {
	const r = result({ report: { design: "doc", subIssues: [sub("one", 1)] } });
	assert.equal(designFailureReason(r), undefined);
});
