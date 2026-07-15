import * as fs from "node:fs";
import * as path from "node:path";

/** One line in .gloop/runs.jsonl: the record of a single worked issue. */
export interface RunRecord {
	/** ISO 8601 timestamp of when the record was written. */
	timestamp: string;
	issue: number;
	kind: "landed" | "split" | "blocked" | "failed" | "aborted";
	detail: string;
	turns: number;
	cost: number;
	sessionId?: string;
	prUrl?: string;
}

const LEDGER_FILE = "runs.jsonl";

export function ledgerPath(cwd: string): string {
	return path.join(cwd, ".gloop", LEDGER_FILE);
}

/**
 * Append one run record to the ledger. Only the orchestrator calls this —
 * the worker guard blocks agents from touching .gloop/. Never throws: a
 * ledger write must not take down a run.
 */
export function appendRun(cwd: string, record: RunRecord): void {
	try {
		const file = ledgerPath(cwd);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		// Best effort; losing a ledger line is better than losing the run.
	}
}

/** Read all run records, oldest first. Corrupt or foreign lines are skipped. */
export function readRuns(cwd: string): RunRecord[] {
	const file = ledgerPath(cwd);
	if (!fs.existsSync(file)) return [];
	const runs: RunRecord[] = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed = JSON.parse(line);
			if (typeof parsed?.issue === "number" && typeof parsed?.kind === "string") {
				runs.push(parsed as RunRecord);
			}
		} catch {
			// Skip corrupt lines rather than failing the whole read.
		}
	}
	return runs;
}

/** Lifetime cost across all recorded runs. */
export function totalCost(runs: RunRecord[]): number {
	return runs.reduce((sum, r) => sum + (typeof r.cost === "number" ? r.cost : 0), 0);
}
