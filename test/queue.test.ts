import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, LABELS } from "../src/config.js";
import type { Issue } from "../src/github.js";
import { attemptsMarker, buildQueue, getAttempts, isEligible, issuePriority, sortQueue } from "../src/queue.js";

function issue(number: number, labels: string[] = [], createdAt = "2024-01-01T00:00:00Z"): Issue {
	return { number, title: `issue ${number}`, body: "", labels, createdAt, url: `https://example.com/${number}` };
}

test("issuePriority maps labels", () => {
	assert.equal(issuePriority(issue(1, ["priority:critical"])), 0);
	assert.equal(issuePriority(issue(2, ["P1"])), 1);
	assert.equal(issuePriority(issue(3, ["priority:low"])), 3);
	assert.equal(issuePriority(issue(4, [])), 2.5);
	assert.equal(issuePriority(issue(5, ["priority:low", "p0"])), 0);
});

test("isEligible filters gloop state labels", () => {
	assert.equal(isEligible(issue(1), DEFAULT_CONFIG), true);
	assert.equal(isEligible(issue(2, [LABELS.blocked]), DEFAULT_CONFIG), false);
	assert.equal(isEligible(issue(3, [LABELS.needsHuman]), DEFAULT_CONFIG), false);
	assert.equal(isEligible(issue(4, [LABELS.inProgress]), DEFAULT_CONFIG), false);
});

test("isEligible excludes issues with an open linked PR", () => {
	const linked = new Set([2]);
	assert.equal(isEligible(issue(1), DEFAULT_CONFIG, linked), true);
	assert.equal(isEligible(issue(2), DEFAULT_CONFIG, linked), false);
	assert.equal(isEligible(issue(2), DEFAULT_CONFIG), true);
});

test("isEligible honors label restriction", () => {
	const config = { ...DEFAULT_CONFIG, label: "agent-ok" };
	assert.equal(isEligible(issue(1, ["agent-ok"]), config), true);
	assert.equal(isEligible(issue(2, ["other"]), config), false);
});

test("sortQueue: gloop:next first, then priority, then FIFO", () => {
	const issues = [
		issue(1, [], "2024-01-03T00:00:00Z"),
		issue(2, ["priority:high"], "2024-01-04T00:00:00Z"),
		issue(3, [], "2024-01-01T00:00:00Z"),
		issue(4, [LABELS.next, "priority:low"], "2024-01-05T00:00:00Z"),
	];
	const sorted = sortQueue(issues).map((i) => i.number);
	assert.deepEqual(sorted, [4, 2, 3, 1]);
});

test("buildQueue filters and sorts", () => {
	const issues = [issue(1, [LABELS.blocked]), issue(2, ["priority:high"]), issue(3)];
	assert.deepEqual(
		buildQueue(issues, DEFAULT_CONFIG).map((i) => i.number),
		[2, 3],
	);
});

test("buildQueue skips issues whose branch has an open PR", () => {
	const issues = [issue(1, ["priority:critical"]), issue(2, ["priority:high"]), issue(3)];
	assert.deepEqual(
		buildQueue(issues, DEFAULT_CONFIG, new Set([1, 3])).map((i) => i.number),
		[2],
	);
});

test("getAttempts parses hidden markers, takes max", () => {
	const comments = [
		{ author: "gloop", body: `${attemptsMarker(1)}\nfailed`, createdAt: "" },
		{ author: "human", body: "try again", createdAt: "" },
		{ author: "gloop", body: `${attemptsMarker(2)}\nfailed again`, createdAt: "" },
	];
	assert.equal(getAttempts(comments), 2);
	assert.equal(getAttempts([]), 0);
});
