import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getVersion } from "../src/version.js";

const pkg = JSON.parse(
	fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
) as { version: string };

test("getVersion returns the package.json version", () => {
	assert.equal(getVersion(), pkg.version);
});

test("getVersion resolves package.json relative to the module URL", () => {
	// Simulate the compiled output living in dist/: package.json is one level up.
	const distUrl = new URL("../dist/version.js", import.meta.url).href;
	assert.equal(getVersion(distUrl), pkg.version);
});

test("getVersion returns a semver-ish string", () => {
	assert.match(getVersion(), /^\d+\.\d+\.\d+/);
});
