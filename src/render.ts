const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function paint(code: string, text: string): string {
	return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const c = {
	bold: (s: string) => paint("1", s),
	dim: (s: string) => paint("2", s),
	green: (s: string) => paint("32", s),
	yellow: (s: string) => paint("33", s),
	red: (s: string) => paint("31", s),
	cyan: (s: string) => paint("36", s),
	magenta: (s: string) => paint("35", s),
};

export function banner(text: string): void {
	const line = "─".repeat(Math.min(72, Math.max(text.length + 2, 40)));
	console.log("");
	console.log(c.cyan(`┌${line}`));
	console.log(c.cyan("│ ") + c.bold(text));
	console.log(c.cyan(`└${line}`));
}

export function info(text: string): void {
	console.log(`${c.cyan("gloop")} ${text}`);
}

export function warn(text: string): void {
	console.log(`${c.yellow("gloop")} ${text}`);
}

export function error(text: string): void {
	console.error(`${c.red("gloop")} ${text}`);
}

export function toolLine(name: string, args: Record<string, unknown>): void {
	let detail = "";
	if (typeof args?.command === "string") detail = args.command;
	else if (typeof args?.path === "string") detail = args.path;
	else if (typeof args?.pattern === "string") detail = String(args.pattern);
	else if (name === "report_result" && typeof args?.outcome === "string") detail = String(args.outcome);
	const flat = detail.replace(/\s+/g, " ");
	const shown = flat.length > 100 ? `${flat.slice(0, 100)}…` : flat;
	console.log(`  ${c.magenta("●")} ${c.bold(name)} ${c.dim(shown)}`);
}

export function formatCost(cost: number): string {
	return `$${cost.toFixed(2)}`;
}

/** One-line per-turn budget ticker, e.g. "turn 12/100 · $0.34/$5.00". */
export function budgetLine(turns: number, maxTurns: number, cost: number, maxCost: number): string {
	const turnPart = Number.isFinite(maxTurns) ? `turn ${turns}/${maxTurns}` : `turn ${turns}`;
	const costPart = Number.isFinite(maxCost) ? `${formatCost(cost)}/${formatCost(maxCost)}` : formatCost(cost);
	return `${turnPart} · ${costPart}`;
}
