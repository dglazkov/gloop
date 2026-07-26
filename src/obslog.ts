import * as fs from "node:fs";
import * as path from "node:path";

/** Session kinds that emit observation events. */
export type ObsSession = "worker" | "triage" | "design";

/** One line in .gloop/observe.jsonl: a harness-friction signal. */
export interface ObsEvent {
	/** ISO 8601 timestamp of when the event was written. */
	timestamp: string;
	session: ObsSession;
	/** Issue number, when known (triage runs are issue-less). */
	issue?: number;
	kind: "guard-block" | "write-block" | "nudge" | "budget-abort";
	/** Blocked command/path + reason, or the abort kind. */
	detail: string;
}

/** Which session is running (and on which issue), threaded into the guard. */
export interface ObsContext {
	session: ObsSession;
	issue?: number;
}

const OBS_FILE = "observe.jsonl";

export function obsLogPath(cwd: string): string {
	return path.join(cwd, ".gloop", OBS_FILE);
}

/**
 * Append one observation event to .gloop/observe.jsonl. Never throws: an
 * observation write must not take down a run.
 */
export function appendObsEvent(cwd: string, event: ObsEvent): void {
	try {
		const file = obsLogPath(cwd);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
	} catch {
		// Best effort; losing an observation line is better than losing the run.
	}
}

/** Stamp and append an event for the given session context. */
export function recordObsEvent(cwd: string, ctx: ObsContext, kind: ObsEvent["kind"], detail: string): void {
	appendObsEvent(cwd, {
		timestamp: new Date().toISOString(),
		session: ctx.session,
		...(ctx.issue !== undefined ? { issue: ctx.issue } : {}),
		kind,
		detail,
	});
}
