import { type GloopConfig, LABELS } from "./config.js";
import type { Issue, IssueComment } from "./github.js";

const PRIORITY_LABELS: Record<string, number> = {
	"priority:critical": 0,
	p0: 0,
	"priority:high": 1,
	p1: 1,
	"priority:medium": 2,
	p2: 2,
	"priority:low": 3,
	p3: 3,
};

const DEFAULT_PRIORITY = 2.5; // between medium and low

export function issuePriority(issue: Issue): number {
	let best: number | undefined;
	for (const label of issue.labels) {
		const p = PRIORITY_LABELS[label.toLowerCase()];
		if (p !== undefined && (best === undefined || p < best)) best = p;
	}
	return best ?? DEFAULT_PRIORITY;
}

export function isEligible(issue: Issue, config: GloopConfig, linkedPrIssues?: ReadonlySet<number>): boolean {
	const labels = issue.labels;
	if (labels.includes(LABELS.blocked)) return false;
	if (labels.includes(LABELS.needsHuman)) return false;
	if (labels.includes(LABELS.inProgress)) return false;
	if (config.label && !labels.includes(config.label)) return false;
	// An open linked PR means work already landed and is awaiting merge; re-picking would duplicate it.
	if (linkedPrIssues?.has(issue.number)) return false;
	return true;
}

/**
 * Deterministic queue order:
 * 1. gloop:next (human override) first
 * 2. priority labels (critical > high > medium > low)
 * 3. oldest first (FIFO)
 */
export function sortQueue(issues: Issue[]): Issue[] {
	return [...issues].sort((a, b) => {
		const aNext = a.labels.includes(LABELS.next) ? 0 : 1;
		const bNext = b.labels.includes(LABELS.next) ? 0 : 1;
		if (aNext !== bNext) return aNext - bNext;
		const ap = issuePriority(a);
		const bp = issuePriority(b);
		if (ap !== bp) return ap - bp;
		return Date.parse(a.createdAt) - Date.parse(b.createdAt);
	});
}

export function buildQueue(issues: Issue[], config: GloopConfig, linkedPrIssues?: ReadonlySet<number>): Issue[] {
	return sortQueue(issues.filter((i) => isEligible(i, config, linkedPrIssues)));
}

const ATTEMPTS_RE = /<!--\s*gloop:attempts=(\d+)\s*-->/;

/** Attempts survive gloop restarts via a hidden marker in issue comments. */
export function getAttempts(comments: IssueComment[]): number {
	let attempts = 0;
	for (const c of comments) {
		const m = c.body.match(ATTEMPTS_RE);
		if (m) attempts = Math.max(attempts, Number(m[1]));
	}
	return attempts;
}

export function attemptsMarker(n: number): string {
	return `<!-- gloop:attempts=${n} -->`;
}

const LEASE_RE = /<!--\s*gloop:lease=(\S+)\s*-->/g;

/** Hidden marker posted when claiming an issue; lets future scans detect crashed runs. */
export function leaseMarker(now: Date = new Date()): string {
	return `<!-- gloop:lease=${now.toISOString()} -->`;
}

/** Newest lease timestamp across all comments, or undefined if none was ever posted. */
export function getLatestLease(comments: IssueComment[]): Date | undefined {
	let latest: number | undefined;
	for (const c of comments) {
		for (const m of c.body.matchAll(LEASE_RE)) {
			const t = Date.parse(m[1]);
			if (!Number.isNaN(t) && (latest === undefined || t > latest)) latest = t;
		}
	}
	return latest === undefined ? undefined : new Date(latest);
}

/**
 * A gloop:in-progress claim is stale when its newest lease marker is older than
 * the TTL — or missing entirely (claim from a run that crashed mid-claim, or
 * from a gloop version that predates leases).
 */
export function isLeaseStale(comments: IssueComment[], ttlMinutes: number, now: Date = new Date()): boolean {
	const lease = getLatestLease(comments);
	if (lease === undefined) return true;
	return now.getTime() - lease.getTime() > ttlMinutes * 60_000;
}
