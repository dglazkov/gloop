import type { GloopConfig } from "./config.js";

export const HELP = `gloop — GitHub-issue-powered agent loop

Usage:
  gloop [options]           work the issue queue until empty or budget hit
  gloop status              show queue order and gloop-labeled issue states
  gloop triage [--apply]    agent pass over open issues: propose priority labels,
                            duplicates, and design marks (dry-run unless --apply)

Options:
  --once                    work one issue, then exit
  --apply                   triage: apply the proposed changes via gh
  --issue <n>               work a specific issue
  --dry-run                 show what would be picked; do no work
  --label <name>            only work issues carrying this label
  --model <spec>            pi model, e.g. anthropic/claude-opus-4-5:high
  --direct                  commit to the default branch instead of a PR
  --auto-merge / --no-auto-merge   enable/disable PR auto-merge (default: on)
  --verify <cmd>            verification command (default: auto-detect npm test/typecheck/lint)
  --quiet                   hide assistant text; show only tool and lifecycle lines
  --max-issues <n>          max issues this run
  --max-cost <usd>          max total cost this run
  --max-turns <n>           max agent turns per issue
  --max-attempts <n>        attempts before gloop:needs-human
  -v, --version             show version
  -h, --help                show this help
`;

export interface CliArgs {
	command: "run" | "status" | "triage" | "help" | "version";
	once: boolean;
	issue?: number;
	dryRun: boolean;
	apply: boolean;
	overrides: Partial<GloopConfig>;
}

export function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = { command: "run", once: false, dryRun: false, apply: false, overrides: {} };
	const rest = [...argv];
	while (rest.length > 0) {
		const arg = rest.shift() as string;
		const next = () => {
			const v = rest.shift();
			if (v === undefined) throw new Error(`${arg} requires a value`);
			return v;
		};
		switch (arg) {
			case "status":
			case "triage":
				args.command = arg;
				break;
			case "--once":
				args.once = true;
				break;
			case "--issue":
				args.issue = Number(next());
				args.once = true;
				break;
			case "--dry-run":
				args.dryRun = true;
				break;
			case "--apply":
				args.apply = true;
				break;
			case "--label":
				args.overrides.label = next();
				break;
			case "--model":
				args.overrides.model = next();
				break;
			case "--direct":
				args.overrides.direct = true;
				break;
			case "--auto-merge":
				args.overrides.autoMerge = true;
				break;
			case "--no-auto-merge":
				args.overrides.autoMerge = false;
				break;
			case "--verify":
				args.overrides.verifyCommand = next();
				break;
			case "--quiet":
				args.overrides.quiet = true;
				break;
			case "--max-issues":
				args.overrides.maxIssuesPerRun = Number(next());
				break;
			case "--max-cost":
				args.overrides.maxCostPerRun = Number(next());
				break;
			case "--max-turns":
				args.overrides.maxTurnsPerIssue = Number(next());
				break;
			case "--max-attempts":
				args.overrides.maxAttempts = Number(next());
				break;
			case "-h":
			case "--help":
				args.command = "help";
				return args;
			case "-v":
			case "--version":
				args.command = "version";
				return args;
			default:
				throw new Error(`Unknown argument: ${arg} (try --help)`);
		}
	}
	return args;
}
