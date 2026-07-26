import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChecklistComment } from "../src/design.js";
import { CHECKLIST_MARKER, decideEpicAction, parseChecklist } from "../src/epic.js";
import type { IssueComment } from "../src/github.js";

function comment(body: string, createdAt = "2025-01-01T00:00:00Z"): IssueComment {
	return { author: "gloop", body, createdAt };
}

/* -------------------------------------------------------- parseChecklist --- */

test("parseChecklist: no checklist comment means undefined", () => {
	assert.equal(parseChecklist([]), undefined);
	assert.equal(parseChecklist([comment("just a regular comment"), comment("- [ ] #7 not a gloop checklist")]), undefined);
});

test("parseChecklist: parses checked and unchecked issue refs", () => {
	const items = parseChecklist([comment(`${CHECKLIST_MARKER}\n\n- [ ] #41\n- [x] #42\n- [X] #43`)]);
	assert.deepEqual(items, [
		{ number: 41, checked: false },
		{ number: 42, checked: true },
		{ number: 43, checked: true },
	]);
});

test("parseChecklist: ignores plain-text bullets without issue refs", () => {
	const body = [
		CHECKLIST_MARKER,
		"",
		"- [ ] #10",
		"",
		"Additional work beyond the follow-up cap (not filed — a human should file these):",
		"- Add caching layer",
		"- #11 mentioned but not a checkbox",
	].join("\n");
	assert.deepEqual(parseChecklist([comment(body)]), [{ number: 10, checked: false }]);
});

test("parseChecklist: uses the most recent checklist comment", () => {
	const items = parseChecklist([
		comment(`${CHECKLIST_MARKER}\n- [ ] #1\n- [ ] #2`),
		comment("unrelated chatter"),
		comment(`${CHECKLIST_MARKER}\n- [ ] #3`),
	]);
	assert.deepEqual(items, [{ number: 3, checked: false }]);
});

test("parseChecklist: checklist comment with no refs yields an empty list (malformed)", () => {
	assert.deepEqual(parseChecklist([comment(`${CHECKLIST_MARKER}\n\n- nothing filed`)]), []);
});

test("parseChecklist: tolerates trailing text after the issue ref", () => {
	assert.deepEqual(parseChecklist([comment(`${CHECKLIST_MARKER}\n- [x] #5 landed via PR #99`)]), [
		{ number: 5, checked: true },
	]);
});

test("parseChecklist: round-trips buildChecklistComment, ignoring overflow bullets", () => {
	const body = buildChecklistComment([41, 42, 43], ["Unfiled extra work"]);
	assert.deepEqual(parseChecklist([comment(body)]), [
		{ number: 41, checked: false },
		{ number: 42, checked: false },
		{ number: 43, checked: false },
	]);
});

/* ------------------------------------------------------ decideEpicAction --- */

const items = (...nums: number[]) => nums.map((n) => ({ number: n, checked: false }));

test("decideEpicAction: closes when all children are CLOSED", () => {
	const states = new Map([
		[41, "CLOSED"],
		[42, "CLOSED"],
		[43, "CLOSED"],
	]);
	assert.deepEqual(decideEpicAction(items(41, 42, 43), states), { action: "close", children: [41, 42, 43] });
});

test("decideEpicAction: keeps the epic open while any child is open", () => {
	const states = new Map([
		[41, "CLOSED"],
		[42, "OPEN"],
		[43, "CLOSED"],
	]);
	assert.deepEqual(decideEpicAction(items(41, 42, 43), states), { action: "keep", openChildren: [42] });
});

test("decideEpicAction: a child with unknown state counts as open", () => {
	const states = new Map([[41, "CLOSED"]]);
	assert.deepEqual(decideEpicAction(items(41, 42), states), { action: "keep", openChildren: [42] });
});

test("decideEpicAction: checked state in the checklist is not trusted — only real issue states count", () => {
	// A checklist may say [x] while the issue was reopened; the decision uses states, not checkboxes.
	const checked = [{ number: 41, checked: true }];
	assert.deepEqual(decideEpicAction(checked, new Map([[41, "OPEN"]])), { action: "keep", openChildren: [41] });
});

test("decideEpicAction: missing or empty checklist is malformed", () => {
	assert.deepEqual(decideEpicAction(undefined, new Map()), { action: "flag-malformed" });
	assert.deepEqual(decideEpicAction([], new Map()), { action: "flag-malformed" });
});
