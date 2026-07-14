import * as fs from "node:fs";
import * as path from "node:path";

export interface GloopConfig {
	/** Only work issues carrying this label (undefined = all open issues). */
	label?: string;
	/** pi model spec, e.g. "anthropic/claude-opus-4-5:high". Undefined = pi default. */
	model?: string;
	/** Commit straight to the default branch instead of opening a PR. */
	direct: boolean;
	/** Enable GitHub auto-merge on created PRs (default true). */
	autoMerge: boolean;
	/** Command to verify the agent's work. Undefined = auto-detect (npm test). */
	verifyCommand?: string;
	/** Per-issue budgets. */
	maxTurnsPerIssue: number;
	maxCostPerIssue: number;
	maxMinutesPerIssue: number;
	/** Attempts before an issue is labeled gloop:needs-human. */
	maxAttempts: number;
	/** Minutes before a gloop:in-progress lease is considered stale and reclaimed. */
	leaseTtlMinutes: number;
	/** Max follow-up issues filed per worked issue. */
	maxFollowUps: number;
	/** Per-run budgets. */
	maxIssuesPerRun: number;
	maxCostPerRun: number;
	/** Branch naming. */
	branchPrefix: string;
}

export const DEFAULT_CONFIG: GloopConfig = {
	direct: false,
	autoMerge: true,
	maxTurnsPerIssue: 100,
	maxCostPerIssue: 5,
	maxMinutesPerIssue: 30,
	maxAttempts: 2,
	leaseTtlMinutes: 60,
	maxFollowUps: 5,
	maxIssuesPerRun: Number.POSITIVE_INFINITY,
	maxCostPerRun: Number.POSITIVE_INFINITY,
	branchPrefix: "gloop/issue-",
};

/** Load .gloop.json from the repo root and merge over defaults. Flags merge on top elsewhere. */
export function loadConfig(cwd: string): GloopConfig {
	const file = path.join(cwd, ".gloop.json");
	let fromFile: Partial<GloopConfig> = {};
	if (fs.existsSync(file)) {
		try {
			fromFile = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch (err) {
			throw new Error(`Failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return { ...DEFAULT_CONFIG, ...fromFile };
}

/** Labels that make up gloop's state machine. */
export const LABELS = {
	inProgress: "gloop:in-progress",
	blocked: "gloop:blocked",
	needsHuman: "gloop:needs-human",
	next: "gloop:next",
	filed: "gloop:filed",
} as const;

export const LABEL_DEFS: Array<{ name: string; color: string; description: string }> = [
	{ name: LABELS.inProgress, color: "1D76DB", description: "Claimed by a running gloop" },
	{ name: LABELS.blocked, color: "B60205", description: "Agent hit an external blocker" },
	{ name: LABELS.needsHuman, color: "D93F0B", description: "Needs a human decision or repeated failures" },
	{ name: LABELS.next, color: "0E8A16", description: "Human override: work this next" },
	{ name: LABELS.filed, color: "C5DEF5", description: "Issue filed by gloop" },
];
