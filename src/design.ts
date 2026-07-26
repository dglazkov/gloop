import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type GloopConfig, LABELS } from "./config.js";
import { CHECKLIST_MARKER } from "./epic.js";
import * as github from "./github.js";
import type { IssueDetail } from "./github.js";
import type { ObsContext } from "./obslog.js";
import { buildDesignPrompt, DESIGN_NUDGE_PROMPT, loadDesignPrompt } from "./prompts.js";
import { info } from "./render.js";
import { checkReadOnlyBashCommand, PRIORITY_LABEL_DEFS } from "./triage.js";
import { guardExtension, runAgentSession, type SessionRunResult } from "./worker.js";

/** One sub-issue declared by the design agent's design_result call. */
export interface DesignSubIssue {
	title: string;
	body: string;
	/** Implementation order: 1 = first. */
	order: number;
	labels?: string[];
}

export interface DesignReport {
	/** Markdown design doc: problem, considered approaches, chosen approach + rationale. */
	design: string;
	subIssues: DesignSubIssue[];
	summary?: string;
}

export interface DesignResult extends SessionRunResult {
	report?: DesignReport;
}

/* ---------------------------------------------------------------- depth --- */

/** Design recursion limit: issues this many levels deep are escalated to a human. */
export const MAX_DESIGN_DEPTH = 2;

const DEPTH_RE = /<!--\s*gloop:depth=(\d+)\s*-->/;

/** Decomposition depth from the hidden body marker. Missing marker = depth 0. */
export function getDepth(body: string): number {
	const m = body.match(DEPTH_RE);
	return m ? Number(m[1]) : 0;
}

export function depthMarker(n: number): string {
	return `<!-- gloop:depth=${n} -->`;
}

/* ---------------------------------------------------------------- guard --- */

/** Design sessions are read-only, same allow-list as triage. */
export function checkDesignBashCommand(command: string): string | undefined {
	return checkReadOnlyBashCommand(command, "design");
}

/* ----------------------------------------------------------------- plan --- */

/** Priority label spellings gloop recognizes (see queue.ts issuePriority). */
const PRIORITY_LABEL_RE = /^(priority:(critical|high|medium|low)|p[0-3])$/i;

/** Order → priority mapping so the existing queue works sub-issues roughly in sequence. */
const ORDER_PRIORITIES = ["priority:high", "priority:medium", "priority:low"];

export interface PlannedSubIssue {
	title: string;
	body: string;
	labels: string[];
}

export interface SubIssuePlan {
	/** Sub-issues to file, in implementation order. */
	file: PlannedSubIssue[];
	/** Titles beyond the maxFollowUps cap, left for a human to file. */
	overflow: string[];
}

/**
 * Turn a design report's sub-issues into concrete issues to file. Pure:
 * sorts by order, encodes order as descending priority labels, stamps each
 * body with a depth marker (parent depth + 1) and a parent-link footer, and
 * caps at maxFollowUps (the remainder becomes plain-text overflow).
 */
export function planSubIssues(
	subIssues: DesignSubIssue[],
	parentNumber: number,
	parentDepth: number,
	maxFollowUps: number,
): SubIssuePlan {
	const ordered = [...subIssues].sort((a, b) => a.order - b.order);
	const file = ordered.slice(0, maxFollowUps).map((si, i) => {
		const priority = ORDER_PRIORITIES[Math.min(i, ORDER_PRIORITIES.length - 1)];
		const labels = [
			...new Set([...(si.labels ?? []).filter((l) => !PRIORITY_LABEL_RE.test(l)), priority, LABELS.filed]),
		];
		const body = `${si.body}\n\n${depthMarker(parentDepth + 1)}\n\n---\n_Filed by gloop design session for #${parentNumber}._`;
		return { title: si.title, body, labels };
	});
	const overflow = ordered.slice(maxFollowUps).map((si) => si.title);
	return { file, overflow };
}

/** Epic checklist comment: filed sub-issues in order, plus unfiled overflow as plain text. */
export function buildChecklistComment(filed: number[], overflow: string[]): string {
	const lines = [CHECKLIST_MARKER, "", ...filed.map((n) => `- [ ] #${n}`)];
	if (overflow.length > 0) {
		lines.push("", "Additional work beyond the follow-up cap (not filed — a human should file these):");
		lines.push(...overflow.map((t) => `- ${t}`));
	}
	return lines.join("\n");
}

/**
 * Why a finished design session counts as a failed attempt, or undefined on
 * success. A design that declares zero sub-issues is a failure.
 */
export function designFailureReason(result: DesignResult): string | undefined {
	if (result.abortedBy && result.abortedBy !== "signal") return `budget exhausted (${result.abortedBy})`;
	if (result.errorMessage) return `agent error: ${result.errorMessage}`;
	if (!result.report) return "agent never called design_result";
	if (result.report.subIssues.length === 0) return "design declared no sub-issues";
	return undefined;
}

/* ---------------------------------------------------------------- apply --- */

function runSummary(result: SessionRunResult): string {
	const parts = [`turns: ${result.turns}`, `cost: $${result.cost.toFixed(2)}`];
	if (result.sessionId) parts.push(`session: ${result.sessionId}`);
	return parts.join(" · ");
}

export interface DesignOutcome {
	kind: "designed";
	detail: string;
}

/**
 * Apply a successful design result: post the design doc, file the sub-issues,
 * post the epic checklist, and swap gloop:design → gloop:epic. The parent
 * stays open as the tracking epic.
 */
export async function applyDesignResult(
	issue: IssueDetail,
	report: DesignReport,
	result: DesignResult,
	config: GloopConfig,
	cwd: string,
): Promise<DesignOutcome> {
	const plan = planSubIssues(report.subIssues, issue.number, getDepth(issue.body), config.maxFollowUps);

	await github.commentOnIssue(
		cwd,
		issue.number,
		`📐 gloop design\n\n${report.design}\n\n---\n🤖 gloop · ${runSummary(result)}`,
	);

	// Sub-issues carry priority labels; make sure they exist before filing.
	for (const def of PRIORITY_LABEL_DEFS) {
		await github.ensureLabel(cwd, def.name, def.color, def.description);
	}
	const filed: number[] = [];
	for (const si of plan.file) {
		const num = await github.createIssue(cwd, si.title, si.body, si.labels);
		filed.push(num);
		info(`filed sub-issue #${num}: ${si.title}`);
	}

	await github.commentOnIssue(cwd, issue.number, buildChecklistComment(filed, plan.overflow));
	await github.addLabels(cwd, issue.number, [LABELS.epic]);
	await github.removeLabels(cwd, issue.number, [LABELS.design]);

	const overflowNote = plan.overflow.length > 0 ? ` (+${plan.overflow.length} unfiled)` : "";
	return { kind: "designed", detail: `decomposed into ${filed.length} sub-issue(s)${overflowNote}` };
}

/* ----------------------------------------------------------------- run ---- */

/** Run the read-only design agent session over one gloop:design issue. */
export async function runDesign(issue: IssueDetail, config: GloopConfig, cwd: string): Promise<DesignResult> {
	let report: DesignReport | undefined;

	const designTool = defineTool({
		name: "design_result",
		label: "Design Result",
		description:
			"Report your architecture design and sub-issue decomposition. Calling this tool is the only valid way to finish. Call it exactly once, as your last action.",
		parameters: Type.Object({
			design: Type.String({
				description:
					"Markdown design doc: the problem, 2–3 considered approaches with trade-offs, and the chosen approach with its rationale",
			}),
			subIssues: Type.Array(
				Type.Object({
					title: Type.String({ description: "Concise, actionable issue title" }),
					body: Type.String({
						description: "Self-contained issue body: context, what to do, acceptance criteria, code pointers",
					}),
					order: Type.Number({ description: "Implementation order: 1 = work this first" }),
					labels: Type.Optional(Type.Array(Type.String())),
				}),
				{ description: "The smallest set of independently shippable sub-issues implementing the chosen approach" },
			),
			summary: Type.Optional(Type.String({ description: "Brief overall notes about the design pass" })),
		}),
		execute: async (_id, params) => {
			report = { design: params.design, subIssues: params.subIssues, summary: params.summary };
			return {
				content: [{ type: "text" as const, text: "Design recorded. You are done; stop now." }],
				details: {},
			};
		},
	});

	const obs: ObsContext = { session: "design", issue: issue.number };
	const result = await runAgentSession({
		cwd,
		config,
		systemPrompt: loadDesignPrompt(cwd),
		tools: ["read", "bash", "grep", "find", "ls", "design_result"],
		customTools: [designTool],
		guard: guardExtension(checkDesignBashCommand, "block-all", { cwd, ...obs }),
		prompt: buildDesignPrompt(issue, config),
		nudgePrompt: DESIGN_NUDGE_PROMPT,
		reported: () => report !== undefined,
		obs,
	});

	return { ...result, report };
}
