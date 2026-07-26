import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type GloopConfig, LABELS } from "./config.js";
import * as github from "./github.js";
import type { Issue } from "./github.js";
import type { ObsContext } from "./obslog.js";
import { buildTriagePrompt, loadTriagePrompt, TRIAGE_NUDGE_PROMPT } from "./prompts.js";
import { c, info } from "./render.js";
import { checkBashCommand, guardExtension, runAgentSession, type SessionRunResult } from "./worker.js";

export type TriagePriority = "critical" | "high" | "medium" | "low";

/** One per-issue decision from the triage agent's triage_result call. */
export interface TriageEntry {
	issue: number;
	priority?: TriagePriority;
	duplicateOf?: number;
	needsDesign?: boolean;
	reason?: string;
}

export interface TriageReport {
	entries: TriageEntry[];
	summary?: string;
}

export interface TriageResult extends SessionRunResult {
	report?: TriageReport;
}

/* ---------------------------------------------------------------- guard --- */

/** git subcommands the triage session may run (strictly read-only). */
const GIT_READONLY = new Set([
	"status",
	"log",
	"diff",
	"show",
	"blame",
	"grep",
	"ls-files",
	"ls-tree",
	"rev-parse",
	"cat-file",
	"describe",
	"shortlog",
	"show-ref",
]);

/** gh subcommands the triage session may run (strictly read-only). */
const GH_READONLY = new Set(["issue list", "issue view", "issue status", "label list", "auth status", "status"]);

/**
 * Read-only sessions (triage, design): on top of the standard worker guard,
 * every git/gh invocation must be an explicitly allow-listed read command.
 * `session` names the session in block messages.
 * Returns a human-readable block reason, or undefined if allowed.
 */
export function checkReadOnlyBashCommand(command: string, session: string): string | undefined {
	const base = checkBashCommand(command);
	if (base) return base;
	for (const m of command.matchAll(/\bgit\s+(?:-\S+\s+)*([\w-]+)/g)) {
		if (!GIT_READONLY.has(m[1])) {
			return `gloop guard: ${session} is read-only (git ${m[1]} is not an allowed read command)`;
		}
	}
	for (const m of command.matchAll(/\bgh\s+([\w-]+)(?:\s+([\w-]+))?/g)) {
		const two = m[2] ? `${m[1]} ${m[2]}` : m[1];
		if (m[1] === "search") continue;
		if (!GH_READONLY.has(two) && !GH_READONLY.has(m[1])) {
			return `gloop guard: ${session} is read-only (gh ${two} is not an allowed read command)`;
		}
	}
	return undefined;
}

export function checkTriageBashCommand(command: string): string | undefined {
	return checkReadOnlyBashCommand(command, "triage");
}

/* ----------------------------------------------------------------- plan --- */

/** Priority label spellings gloop recognizes (see queue.ts issuePriority). */
const PRIORITY_LABELS = new Set([
	"priority:critical",
	"priority:high",
	"priority:medium",
	"priority:low",
	"p0",
	"p1",
	"p2",
	"p3",
]);

export type TriageOp =
	| { kind: "label"; issue: number; add: string; remove: string[] }
	| { kind: "duplicate"; issue: number; of: number }
	| { kind: "design"; issue: number };

/** Labels that make a `needsDesign` mark a no-op: already routed or awaiting a human. */
const DESIGN_SKIP_LABELS = new Set<string>([LABELS.design, LABELS.epic, LABELS.needsHuman]);

export interface TriagePlan {
	ops: TriageOp[];
	skipped: Array<{ issue: number; reason: string }>;
}

/**
 * Map the triage agent's entries onto concrete label/issue operations.
 * Pure: validates against the scanned open issues and drops no-ops (priority
 * already correct, design label already routed).
 */
export function planTriage(entries: TriageEntry[], issues: Issue[]): TriagePlan {
	const byNumber = new Map(issues.map((i) => [i.number, i]));
	const ops: TriageOp[] = [];
	const skipped: TriagePlan["skipped"] = [];
	const seen = new Set<number>();

	for (const entry of entries) {
		const issue = byNumber.get(entry.issue);
		if (!issue) {
			skipped.push({ issue: entry.issue, reason: "not in the scanned open issues" });
			continue;
		}
		if (seen.has(entry.issue)) {
			skipped.push({ issue: entry.issue, reason: "duplicate triage entry" });
			continue;
		}
		seen.add(entry.issue);

		if (entry.priority) {
			const add = `priority:${entry.priority}`;
			const remove = issue.labels.filter((l) => PRIORITY_LABELS.has(l.toLowerCase()) && l.toLowerCase() !== add);
			const already = issue.labels.some((l) => l.toLowerCase() === add);
			if (!already || remove.length > 0) {
				ops.push({ kind: "label", issue: entry.issue, add, remove });
			}
		}

		if (entry.duplicateOf !== undefined) {
			if (entry.duplicateOf === entry.issue) {
				skipped.push({ issue: entry.issue, reason: "cannot be a duplicate of itself" });
			} else if (!byNumber.has(entry.duplicateOf)) {
				skipped.push({ issue: entry.issue, reason: `duplicate-of #${entry.duplicateOf} is not an open issue` });
			} else {
				ops.push({ kind: "duplicate", issue: entry.issue, of: entry.duplicateOf });
			}
		}

		if (entry.needsDesign) {
			const existing = issue.labels.find((l) => DESIGN_SKIP_LABELS.has(l.toLowerCase()));
			if (existing) {
				skipped.push({ issue: entry.issue, reason: `already labeled ${existing}` });
			} else {
				ops.push({ kind: "design", issue: entry.issue });
			}
		}
	}

	return { ops, skipped };
}

/* ---------------------------------------------------------------- print --- */

export function printTriagePlan(plan: TriagePlan): void {
	if (plan.ops.length === 0) {
		info("no changes proposed");
	} else {
		console.log(c.bold(`proposed changes (${plan.ops.length}):`));
		for (const op of plan.ops) {
			switch (op.kind) {
				case "label": {
					const removals = op.remove.length > 0 ? ` ${c.dim(`(remove ${op.remove.join(", ")})`)}` : "";
					console.log(`  #${op.issue} → ${op.add}${removals}`);
					break;
				}
				case "duplicate":
					console.log(`  #${op.issue} → comment: duplicate of #${op.of}`);
					break;
				case "design":
					console.log(`  #${op.issue} → needs design session (${LABELS.design})`);
					break;
			}
		}
	}
	for (const s of plan.skipped) {
		console.log(c.dim(`  skipped #${s.issue}: ${s.reason}`));
	}
}

/* ---------------------------------------------------------------- apply --- */

export const PRIORITY_LABEL_DEFS: Array<{ name: string; color: string; description: string }> = [
	{ name: "priority:critical", color: "B60205", description: "Work this before anything else" },
	{ name: "priority:high", color: "D93F0B", description: "Core functionality gap or widespread bug" },
	{ name: "priority:medium", color: "FBCA04", description: "Valuable improvement, non-blocking" },
	{ name: "priority:low", color: "C2E0C6", description: "Nice-to-have" },
];

/** Apply a triage plan via gh: labels, duplicate comments, design marks. */
export async function applyTriagePlan(plan: TriagePlan, cwd: string): Promise<void> {
	const needsPriorityLabels = plan.ops.some((op) => op.kind === "label");
	if (needsPriorityLabels) {
		for (const def of PRIORITY_LABEL_DEFS) {
			await github.ensureLabel(cwd, def.name, def.color, def.description);
		}
	}
	for (const op of plan.ops) {
		switch (op.kind) {
			case "label":
				await github.addLabels(cwd, op.issue, [op.add]);
				if (op.remove.length > 0) await github.removeLabels(cwd, op.issue, op.remove);
				info(`#${op.issue}: set ${op.add}`);
				break;
			case "duplicate":
				await github.commentOnIssue(
					cwd,
					op.issue,
					`🔁 gloop triage: this looks like a duplicate of #${op.of}. If so, close this issue in favor of #${op.of}; otherwise disregard this note.`,
				);
				info(`#${op.issue}: commented duplicate of #${op.of}`);
				break;
			case "design":
				await github.addLabels(cwd, op.issue, [LABELS.design]);
				info(`#${op.issue}: marked ${LABELS.design}`);
				break;
		}
	}
}

/* ----------------------------------------------------------------- run ---- */

/** Run the read-only triage agent session over the open issues. */
export async function runTriage(issues: Issue[], config: GloopConfig, cwd: string): Promise<TriageResult> {
	let report: TriageReport | undefined;

	const triageTool = defineTool({
		name: "triage_result",
		label: "Triage Result",
		description:
			"Report your triage decisions for the open issues. Calling this tool is the only valid way to finish. Call it exactly once, as your last action. Include one entry per issue that needs a change; issues that are fine as-is need no entry.",
		parameters: Type.Object({
			entries: Type.Array(
				Type.Object({
					issue: Type.Number({ description: "Issue number from the provided list" }),
					priority: Type.Optional(
						Type.Union(
							[Type.Literal("critical"), Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")],
							{ description: "Suggested priority label (omit if the current priority is right)" },
						),
					),
					duplicateOf: Type.Optional(
						Type.Number({ description: "Open issue number this issue duplicates (prefer the older/richer one)" }),
					),
					needsDesign: Type.Optional(
						Type.Boolean({
							description:
								"True when this issue is too large/ambiguous for one implementation session and needs a design pass first",
						}),
					),
					reason: Type.Optional(Type.String({ description: "One-line rationale for this decision" })),
				}),
			),
			summary: Type.Optional(Type.String({ description: "Brief overall notes about the triage pass" })),
		}),
		execute: async (_id, params) => {
			report = { entries: params.entries, summary: params.summary };
			return {
				content: [{ type: "text" as const, text: "Triage recorded. You are done; stop now." }],
				details: {},
			};
		},
	});

	const obs: ObsContext = { session: "triage" };
	const result = await runAgentSession({
		cwd,
		config,
		systemPrompt: loadTriagePrompt(cwd),
		tools: ["read", "bash", "grep", "find", "ls", "triage_result"],
		customTools: [triageTool],
		guard: guardExtension(checkTriageBashCommand, "block-all", { cwd, ...obs }),
		prompt: buildTriagePrompt(issues, config),
		nudgePrompt: TRIAGE_NUDGE_PROMPT,
		reported: () => report !== undefined,
		obs,
	});

	return { ...result, report };
}
