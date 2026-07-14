import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, LABELS } from "../src/config.js";
import type { Issue } from "../src/github.js";
import {
	attemptsMarker,
	buildQueue,
	getAttempts,
	getLatestLease,
	isEligible,
	isLeaseStale,
	issuePriority,
	leaseMarker,
	sortQueue,
} from "../src/queue.js";

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

test("leaseMarker round-trips through getLatestLease", () => {
	const t = new Date("2024-06-01T12:00:00.000Z");
	const comments = [{ author: "gloop", body: `${leaseMarker(t)}\n\u{1F916} gloop claimed this issue.`, createdAt: "" }];
	assert.deepEqual(getLatestLease(comments), t);
});

test("getLatestLease takes the newest marker and ignores garbage", () => {
	const comments = [
		{ author: "gloop", body: leaseMarker(new Date("2024-01-01T00:00:00Z")), createdAt: "" },
		{ author: "gloop", body: "<!-- gloop:lease=not-a-date -->", createdAt: "" },
		{ author: "gloop", body: leaseMarker(new Date("2024-03-01T00:00:00Z")), createdAt: "" },
		{ author: "human", body: "unrelated comment", createdAt: "" },
		{ author: "gloop", body: leaseMarker(new Date("2024-02-01T00:00:00Z")), createdAt: "" },
	];
	assert.deepEqual(getLatestLease(comments), new Date("2024-03-01T00:00:00Z"));
	assert.equal(getLatestLease([]), undefined);
	assert.equal(getLatestLease([{ author: "human", body: "hi", createdAt: "" }]), undefined);
});

test("isLeaseStale: fresh lease is kept, expired lease is stale", () => {
	const now = new Date("2024-06-01T12:00:00Z");
	const fresh = [{ author: "gloop", body: leaseMarker(new Date("2024-06-01T11:30:00Z")), createdAt: "" }];
	const expired = [{ author: "gloop", body: leaseMarker(new Date("2024-06-01T10:59:00Z")), createdAt: "" }];
	assert.equal(isLeaseStale(fresh, 60, now), false);
	assert.equal(isLeaseStale(expired, 60, now), true);
});

test("isLeaseStale: newest lease wins over older expired ones", () => {
	const now = new Date("2024-06-01T12:00:00Z");
	const comments = [
		{ author: "gloop", body: leaseMarker(new Date("2024-06-01T08:00:00Z")), createdAt: "" },
		{ author: "gloop", body: leaseMarker(new Date("2024-06-01T11:45:00Z")), createdAt: "" },
	];
	assert.equal(isLeaseStale(comments, 60, now), false);
});

test("isLeaseStale: a claim without any lease marker is stale", () => {
	assert.equal(isLeaseStale([], 60), true);
	assert.equal(isLeaseStale([{ author: "gloop", body: attemptsMarker(1), createdAt: "" }], 60), true);
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
