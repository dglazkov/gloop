import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { appendRun, ledgerPath, readRuns, type RunRecord, totalCost } from "../src/ledger.js";

function tempRepo(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gloop-ledger-"));
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		timestamp: "2024-06-01T12:00:00.000Z",
		issue: 7,
		kind: "landed",
		detail: "https://example.com/pr/1 (merged)",
		turns: 12,
		cost: 0.42,
		sessionId: "abc123",
		prUrl: "https://example.com/pr/1",
		...overrides,
	};
}

test("readRuns returns empty when no ledger exists", () => {
	const cwd = tempRepo();
	assert.deepEqual(readRuns(cwd), []);
});

test("appendRun/readRuns round-trip preserves records in order", () => {
	const cwd = tempRepo();
	const first = record();
	const second = record({ issue: 8, kind: "failed", detail: "verification failed", cost: 1.5, prUrl: undefined });
	appendRun(cwd, first);
	appendRun(cwd, second);

	const runs = readRuns(cwd);
	assert.equal(runs.length, 2);
	assert.deepEqual(runs[0], first);
	assert.equal(runs[1].issue, 8);
	assert.equal(runs[1].kind, "failed");
	assert.equal(runs[1].prUrl, undefined);
});

test("appendRun creates .gloop/runs.jsonl with one JSON line per record", () => {
	const cwd = tempRepo();
	appendRun(cwd, record());
	appendRun(cwd, record({ issue: 9 }));

	const file = ledgerPath(cwd);
	assert.equal(file, path.join(cwd, ".gloop", "runs.jsonl"));
	const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
	assert.equal(lines.length, 2);
	for (const line of lines) JSON.parse(line); // each line is valid JSON
});

test("readRuns skips corrupt lines", () => {
	const cwd = tempRepo();
	appendRun(cwd, record());
	fs.appendFileSync(ledgerPath(cwd), "not json\n{\"half\":\n", "utf8");
	appendRun(cwd, record({ issue: 10, kind: "aborted", detail: "interrupted by user" }));

	const runs = readRuns(cwd);
	assert.equal(runs.length, 2);
	assert.equal(runs[0].issue, 7);
	assert.equal(runs[1].issue, 10);
});

test("totalCost sums across runs", () => {
	const runs = [record({ cost: 0.5 }), record({ cost: 1.25 }), record({ cost: 0 })];
	assert.equal(totalCost(runs), 1.75);
	assert.equal(totalCost([]), 0);
});
