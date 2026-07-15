import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadConfig, validateConfigFile } from "../src/config.js";

function tempDirWithConfig(contents?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gloop-config-test-"));
	if (contents !== undefined) {
		fs.writeFileSync(path.join(dir, ".gloop.json"), contents);
	}
	return dir;
}

test("missing .gloop.json yields defaults", () => {
	const dir = tempDirWithConfig();
	assert.deepEqual(loadConfig(dir), DEFAULT_CONFIG);
});

test("valid config loads and merges over defaults", () => {
	const dir = tempDirWithConfig(
		JSON.stringify({
			label: "gloop",
			model: "anthropic/claude-opus-4-5:high",
			direct: true,
			autoMerge: false,
			verifyCommand: "npm test",
			verifyCommands: ["npm test", "npm run typecheck"],
			maxTurnsPerIssue: 50,
			maxCostPerIssue: 2.5,
			maxMinutesPerIssue: 15,
			maxAttempts: 3,
			leaseTtlMinutes: 30,
			maxFollowUps: 2,
			quiet: true,
			maxIssuesPerRun: 4,
			maxCostPerRun: 10,
			branchPrefix: "bot/issue-",
		}),
	);
	const config = loadConfig(dir);
	assert.equal(config.label, "gloop");
	assert.equal(config.direct, true);
	assert.equal(config.autoMerge, false);
	assert.deepEqual(config.verifyCommands, ["npm test", "npm run typecheck"]);
	assert.equal(config.maxCostPerIssue, 2.5);
	assert.equal(config.branchPrefix, "bot/issue-");
});

test("partial config keeps defaults for omitted keys", () => {
	const dir = tempDirWithConfig(JSON.stringify({ maxCostPerIssue: 1 }));
	const config = loadConfig(dir);
	assert.equal(config.maxCostPerIssue, 1);
	assert.equal(config.maxTurnsPerIssue, DEFAULT_CONFIG.maxTurnsPerIssue);
	assert.equal(config.direct, DEFAULT_CONFIG.direct);
});

test("unknown key fails with a message naming the file and listing valid keys", () => {
	const dir = tempDirWithConfig(JSON.stringify({ maxCost: 5 }));
	assert.throws(
		() => loadConfig(dir),
		(err: Error) =>
			err.message.includes(".gloop.json") &&
			err.message.includes('Unknown key "maxCost"') &&
			err.message.includes("maxCostPerIssue"),
	);
});

test("wrong type: string where number expected", () => {
	const dir = tempDirWithConfig(JSON.stringify({ maxTurnsPerIssue: "100" }));
	assert.throws(
		() => loadConfig(dir),
		(err: Error) =>
			err.message.includes(".gloop.json") &&
			err.message.includes('"maxTurnsPerIssue" must be a positive number'),
	);
});

test("wrong type: non-positive numbers rejected", () => {
	for (const bad of [0, -1]) {
		const dir = tempDirWithConfig(JSON.stringify({ maxAttempts: bad }));
		assert.throws(() => loadConfig(dir), /"maxAttempts" must be a positive number/);
	}
});

test("wrong type: non-boolean for boolean field", () => {
	const dir = tempDirWithConfig(JSON.stringify({ quiet: "yes" }));
	assert.throws(() => loadConfig(dir), /"quiet" must be a boolean/);
});

test("wrong type: empty string rejected", () => {
	const dir = tempDirWithConfig(JSON.stringify({ branchPrefix: "" }));
	assert.throws(() => loadConfig(dir), /"branchPrefix" must be a non-empty string/);
});

test("wrong type: verifyCommands must be an array of non-empty strings", () => {
	for (const bad of ["npm test", ["npm test", 3], [""]]) {
		const dir = tempDirWithConfig(JSON.stringify({ verifyCommands: bad }));
		assert.throws(() => loadConfig(dir), /"verifyCommands" must be an array of non-empty strings/);
	}
});

test("non-object top level rejected", () => {
	for (const bad of ["[]", '"hi"', "null", "3"]) {
		const dir = tempDirWithConfig(bad);
		assert.throws(() => loadConfig(dir), /expected a JSON object at the top level/);
	}
});

test("multiple problems are all reported", () => {
	const dir = tempDirWithConfig(JSON.stringify({ maxCost: 5, quiet: 1 }));
	assert.throws(
		() => loadConfig(dir),
		(err: Error) => err.message.includes('Unknown key "maxCost"') && err.message.includes('"quiet" must be a boolean'),
	);
});

test("malformed JSON still reports a parse error", () => {
	const dir = tempDirWithConfig("{ not json");
	assert.throws(() => loadConfig(dir), /Failed to parse/);
});

test("validateConfigFile returns the object unchanged when valid", () => {
	const raw = { direct: true, maxCostPerIssue: 2 };
	assert.deepEqual(validateConfigFile(raw, ".gloop.json"), raw);
});
