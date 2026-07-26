import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { appendObsEvent, type ObsEvent, obsLogPath, recordObsEvent } from "../src/obslog.js";
import { guardExtension } from "../src/worker.js";

function tempRepo(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gloop-obslog-"));
}

function event(overrides: Partial<ObsEvent> = {}): ObsEvent {
	return {
		timestamp: "2024-06-01T12:00:00.000Z",
		session: "worker",
		issue: 47,
		kind: "guard-block",
		detail: "git push — gloop guard: blocked",
		...overrides,
	};
}

function readEvents(cwd: string): ObsEvent[] {
	const file = obsLogPath(cwd);
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line) as ObsEvent);
}

/** Run the guard's tool_call handler directly, without a real agent session. */
async function fireToolCall(
	guard: ReturnType<typeof guardExtension>,
	toolName: string,
	input: Record<string, unknown>,
): Promise<{ block: boolean; reason: string } | undefined> {
	let handler: ((event: unknown) => Promise<{ block: boolean; reason: string } | undefined>) | undefined;
	const fakePi = {
		on: (_name: string, h: typeof handler) => {
			handler = h;
		},
	};
	// Minimal fake of the pi extension API: only `on` is used by the guard.
	(guard.factory as (pi: unknown) => void)(fakePi);
	assert.ok(handler, "guard should register a tool_call handler");
	return await handler({ toolName, input });
}

test("appendObsEvent creates .gloop/observe.jsonl with one JSON line per event", () => {
	const cwd = tempRepo();
	appendObsEvent(cwd, event());
	appendObsEvent(cwd, event({ session: "triage", issue: undefined, kind: "nudge", detail: "no report" }));

	const file = obsLogPath(cwd);
	assert.equal(file, path.join(cwd, ".gloop", "observe.jsonl"));
	const events = readEvents(cwd);
	assert.equal(events.length, 2);
	assert.deepEqual(events[0], event());
	assert.equal(events[1].session, "triage");
	assert.equal(events[1].kind, "nudge");
});

test("appendObsEvent never throws when .gloop is unwritable", () => {
	const cwd = tempRepo();
	// Make .gloop a file so mkdir/append inside it fails.
	fs.writeFileSync(path.join(cwd, ".gloop"), "not a directory", "utf8");
	assert.doesNotThrow(() => appendObsEvent(cwd, event()));
});

test("recordObsEvent stamps a timestamp and omits issue when unknown", () => {
	const cwd = tempRepo();
	recordObsEvent(cwd, { session: "triage" }, "budget-abort", "aborted by turns budget");
	recordObsEvent(cwd, { session: "design", issue: 12 }, "nudge", "agent stopped without calling its report tool");

	const events = readEvents(cwd);
	assert.equal(events.length, 2);
	assert.ok(!Number.isNaN(Date.parse(events[0].timestamp)), "timestamp should be a valid date");
	assert.ok(!("issue" in events[0]), "issue should be omitted when unknown");
	assert.equal(events[0].kind, "budget-abort");
	assert.deepEqual({ session: events[1].session, issue: events[1].issue }, { session: "design", issue: 12 });
});

test("guard emits a guard-block event for a blocked bash command", async () => {
	const cwd = tempRepo();
	const guard = guardExtension(undefined, undefined, { cwd, session: "worker", issue: 47 });

	const res = await fireToolCall(guard, "bash", { command: "git push origin main" });
	assert.equal(res?.block, true);

	const events = readEvents(cwd);
	assert.equal(events.length, 1);
	assert.equal(events[0].session, "worker");
	assert.equal(events[0].issue, 47);
	assert.equal(events[0].kind, "guard-block");
	assert.ok(events[0].detail.includes("git push origin main"), "detail should include the command");
	assert.ok(events[0].detail.includes("gloop guard:"), "detail should include the reason");
});

test("guard emits a write-block event for a blocked write path", async () => {
	const cwd = tempRepo();
	const guard = guardExtension(undefined, undefined, { cwd, session: "worker", issue: 47 });

	const res = await fireToolCall(guard, "write", { path: ".gloop/PROMPT.md" });
	assert.equal(res?.block, true);

	const events = readEvents(cwd);
	assert.equal(events.length, 1);
	assert.equal(events[0].kind, "write-block");
	assert.ok(events[0].detail.includes(".gloop/PROMPT.md"), "detail should include the path");
});

test("guard emits a write-block event for read-only (block-all) sessions", async () => {
	const cwd = tempRepo();
	const guard = guardExtension(undefined, "block-all", { cwd, session: "design", issue: 9 });

	const res = await fireToolCall(guard, "edit", { path: "src/foo.ts" });
	assert.equal(res?.block, true);

	const events = readEvents(cwd);
	assert.equal(events.length, 1);
	assert.equal(events[0].session, "design");
	assert.equal(events[0].issue, 9);
	assert.equal(events[0].kind, "write-block");
	assert.ok(events[0].detail.includes("read-only"), "detail should include the reason");
});

test("guard emits nothing for allowed calls or when obs is absent", async () => {
	const cwd = tempRepo();
	const observed = guardExtension(undefined, undefined, { cwd, session: "worker", issue: 1 });
	assert.equal(await fireToolCall(observed, "bash", { command: "npm test" }), undefined);
	assert.equal(await fireToolCall(observed, "write", { path: "src/ok.ts" }), undefined);
	assert.deepEqual(readEvents(cwd), []);

	const unobserved = guardExtension();
	const res = await fireToolCall(unobserved, "bash", { command: "git push" });
	assert.equal(res?.block, true);
	assert.deepEqual(readEvents(cwd), []);
});
