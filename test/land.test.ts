import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { detectVerifyCommands, resolveVerifyCommands } from "../src/land.js";

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
