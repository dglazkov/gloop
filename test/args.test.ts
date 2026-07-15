import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../src/args.js";

test("no arguments: run command with empty overrides", () => {
	const args = parseArgs([]);
	assert.equal(args.command, "run");
	assert.equal(args.once, false);
	assert.equal(args.dryRun, false);
	assert.deepEqual(args.overrides, {});
});

test("--quiet sets the quiet override", () => {
	const args = parseArgs(["--quiet"]);
	assert.equal(args.overrides.quiet, true);
});

test("quiet defaults to unset so config/file values win", () => {
	const args = parseArgs(["--once"]);
	assert.equal("quiet" in args.overrides, false);
});

test("--issue implies --once and parses the number", () => {
	const args = parseArgs(["--issue", "42"]);
	assert.equal(args.issue, 42);
	assert.equal(args.once, true);
});

test("subcommands are recognized", () => {
	assert.equal(parseArgs(["status"]).command, "status");
	assert.equal(parseArgs(["triage", "--apply"]).command, "triage");
	assert.equal(parseArgs(["triage", "--apply"]).apply, true);
});

test("value flags populate overrides", () => {
	const args = parseArgs([
		"--label", "bug",
		"--model", "anthropic/claude-opus-4-5:high",
		"--verify", "npm test",
		"--max-issues", "3",
		"--max-cost", "1.5",
		"--max-turns", "50",
		"--max-attempts", "4",
	]);
	assert.deepEqual(args.overrides, {
		label: "bug",
		model: "anthropic/claude-opus-4-5:high",
		verifyCommand: "npm test",
		maxIssuesPerRun: 3,
		maxCostPerRun: 1.5,
		maxTurnsPerIssue: 50,
		maxAttempts: 4,
	});
});

test("boolean flags populate overrides", () => {
	assert.equal(parseArgs(["--direct"]).overrides.direct, true);
	assert.equal(parseArgs(["--auto-merge"]).overrides.autoMerge, true);
	assert.equal(parseArgs(["--no-auto-merge"]).overrides.autoMerge, false);
});

test("help and version map to commands without side effects", () => {
	assert.equal(parseArgs(["--help"]).command, "help");
	assert.equal(parseArgs(["-h"]).command, "help");
	assert.equal(parseArgs(["--version"]).command, "version");
	assert.equal(parseArgs(["-v"]).command, "version");
});

test("missing value for a flag throws", () => {
	assert.throws(() => parseArgs(["--label"]), /--label requires a value/);
});

test("unknown argument throws", () => {
	assert.throws(() => parseArgs(["--nope"]), /Unknown argument: --nope/);
});
