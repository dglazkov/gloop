import { LABELS } from "./config.js";
import * as github from "./github.js";
import type { Issue, IssueComment } from "./github.js";
import { info, warn } from "./render.js";

/** Marker line identifying the gloop-posted epic checklist comment (see design.ts buildChecklistComment). */
export const CHECKLIST_MARKER = "🧩 Decomposed into:";

/** One sub-issue reference parsed from the epic checklist comment. */
export interface ChecklistItem {
	number: number;
	checked: boolean;
}

const CHECKLIST_ITEM_RE = /^\s*-\s*\[([ xX])\]\s*#(\d+)/;

/**
 * Sub-issues referenced by the gloop checklist comment, or undefined when no
 * comment carries the checklist marker. Uses the most recent matching comment
 * (comments arrive oldest-first). Plain-text bullets without an issue ref —
 * e.g. unfiled overflow titles — are ignored.
 */
export function parseChecklist(comments: readonly IssueComment[]): ChecklistItem[] | undefined {
	let checklist: string | undefined;
	for (const c of comments) {
		if (c.body.includes(CHECKLIST_MARKER)) checklist = c.body;
	}
	if (checklist === undefined) return undefined;
	const items: ChecklistItem[] = [];
	for (const line of checklist.split("\n")) {
		const m = line.match(CHECKLIST_ITEM_RE);
		if (m) items.push({ number: Number(m[2]), checked: m[1].toLowerCase() === "x" });
	}
	return items;
}

export type EpicAction =
	| { action: "close"; children: number[] }
	| { action: "keep"; openChildren: number[] }
	/** No parseable checklist: escalate to gloop:needs-human. */
	| { action: "flag-malformed" };

/**
 * Close/keep decision for one epic. Closes only when every referenced child
 * issue is CLOSED; a child whose state is unknown (missing from `states`)
 * counts as open — never close on partial information. An epic without a
 * parseable checklist (no marker comment, or a marker comment with zero issue
 * refs) is malformed.
 */
export function decideEpicAction(
	items: readonly ChecklistItem[] | undefined,
	states: ReadonlyMap<number, string>,
): EpicAction {
	if (items === undefined || items.length === 0) return { action: "flag-malformed" };
	const children = items.map((i) => i.number);
	const openChildren = children.filter((n) => states.get(n) !== "CLOSED");
	return openChildren.length === 0 ? { action: "close", children } : { action: "keep", openChildren };
}

/**
 * Epic lifecycle sweep, run on each scan: close open gloop:epic tracking
 * issues once every checklist sub-issue is closed, and escalate malformed
 * epics (no parseable checklist) to gloop:needs-human exactly once — the
 * needs-human label itself is the re-comment guard. Dry-run reports what
 * would happen and performs no GitHub writes.
 */
export async function sweepEpics(issues: readonly Issue[], cwd: string, dryRun = false): Promise<void> {
	for (const issue of issues) {
		if (!issue.labels.includes(LABELS.epic)) continue;
		// Already escalated: a human owns this epic now; do not re-comment.
		if (issue.labels.includes(LABELS.needsHuman)) continue;
		try {
			await sweepOneEpic(issue, cwd, dryRun);
		} catch (err) {
			// The sweep is housekeeping; never let one bad epic kill the run.
			warn(`#${issue.number}: epic sweep failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

async function sweepOneEpic(issue: Issue, cwd: string, dryRun: boolean): Promise<void> {
	const detail = await github.viewIssue(cwd, issue.number);
	const items = parseChecklist(detail.comments);
	const states = new Map<number, string>();
	for (const item of items ?? []) states.set(item.number, await github.getIssueState(cwd, item.number));
	const decision = decideEpicAction(items, states);

	if (decision.action === "keep") return;

	if (decision.action === "flag-malformed") {
		if (dryRun) {
			warn(`#${issue.number}: epic has no parseable checklist; would mark ${LABELS.needsHuman} (--dry-run)`);
			return;
		}
		warn(`#${issue.number}: epic has no parseable checklist; marking ${LABELS.needsHuman}`);
		await github.commentOnIssue(
			cwd,
			issue.number,
			`🔴 gloop: this \`${LABELS.epic}\` issue has no parseable "${CHECKLIST_MARKER}" checklist comment, so its lifecycle cannot be tracked. Marking \`${LABELS.needsHuman}\`.`,
		);
		await github.addLabels(cwd, issue.number, [LABELS.needsHuman]);
		return;
	}

	const list = decision.children.map((n) => `#${n}`).join(", ");
	if (dryRun) {
		info(`#${issue.number}: all sub-issues closed (${list}); would close this epic (--dry-run)`);
		return;
	}
	info(`#${issue.number}: all sub-issues closed (${list}); closing this epic`);
	await github.closeIssue(cwd, issue.number, `All sub-issues complete: ${list}. Closing this tracking epic. 🤖 gloop`);
}
