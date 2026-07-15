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
	/** Command to verify the agent's work. Superseded by verifyCommands; kept for back-compat. */
	verifyCommand?: string;
	/** Commands to verify the agent's work, run in order. Undefined = auto-detect (npm test / typecheck / lint). */
	verifyCommands?: string[];
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
	/** Suppress assistant text deltas; show only tool and lifecycle lines. */
	quiet: boolean;
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
	quiet: false,
	maxIssuesPerRun: Number.POSITIVE_INFINITY,
	maxCostPerRun: Number.POSITIVE_INFINITY,
	branchPrefix: "gloop/issue-",
};

type FieldKind = "string" | "boolean" | "positive-number" | "string-array";

/** Expected shape of each valid .gloop.json key. */
const CONFIG_FIELDS: Record<keyof GloopConfig, FieldKind> = {
	label: "string",
	model: "string",
	direct: "boolean",
	autoMerge: "boolean",
	verifyCommand: "string",
	verifyCommands: "string-array",
	maxTurnsPerIssue: "positive-number",
	maxCostPerIssue: "positive-number",
	maxMinutesPerIssue: "positive-number",
	maxAttempts: "positive-number",
	leaseTtlMinutes: "positive-number",
	maxFollowUps: "positive-number",
	quiet: "boolean",
	maxIssuesPerRun: "positive-number",
	maxCostPerRun: "positive-number",
	branchPrefix: "string",
};

const KIND_DESCRIPTIONS: Record<FieldKind, string> = {
	string: "a non-empty string",
	boolean: "a boolean",
	"positive-number": "a positive number",
	"string-array": "an array of non-empty strings",
};

function describeValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return `${JSON.stringify(value)} (${typeof value})`;
}

function matchesKind(value: unknown, kind: FieldKind): boolean {
	switch (kind) {
		case "string":
			return typeof value === "string" && value.trim() !== "";
		case "boolean":
			return typeof value === "boolean";
		case "positive-number":
			return typeof value === "number" && Number.isFinite(value) && value > 0;
		case "string-array":
			return Array.isArray(value) && value.every((v) => typeof v === "string" && v.trim() !== "");
	}
}

/** Validate a parsed .gloop.json object. Throws with a friendly message naming `file` on any problem. */
export function validateConfigFile(raw: unknown, file: string): Partial<GloopConfig> {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Invalid ${file}: expected a JSON object at the top level.`);
	}
	const validKeys = Object.keys(CONFIG_FIELDS);
	const problems: string[] = [];
	for (const [key, value] of Object.entries(raw)) {
		const kind = (CONFIG_FIELDS as Record<string, FieldKind | undefined>)[key];
		if (kind === undefined) {
			problems.push(`Unknown key "${key}". Valid keys: ${validKeys.join(", ")}.`);
		} else if (!matchesKind(value, kind)) {
			problems.push(`"${key}" must be ${KIND_DESCRIPTIONS[kind]}, got ${describeValue(value)}.`);
		}
	}
	if (problems.length > 0) {
		throw new Error(`Invalid ${file}:\n  - ${problems.join("\n  - ")}`);
	}
	return raw as Partial<GloopConfig>;
}

/** Load .gloop.json from the repo root, validate it, and merge over defaults. Flags merge on top elsewhere. */
export function loadConfig(cwd: string): GloopConfig {
	const file = path.join(cwd, ".gloop.json");
	let fromFile: Partial<GloopConfig> = {};
	if (fs.existsSync(file)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch (err) {
			throw new Error(`Failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
		}
		fromFile = validateConfigFile(parsed, file);
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
