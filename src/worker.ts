import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	getAgentDir,
	type InlineExtension,
	ModelRegistry,
	resolveCliModel,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GloopConfig } from "./config.js";
import type { IssueDetail } from "./github.js";
import { buildIssuePrompt, loadSystemPrompt, NUDGE_PROMPT } from "./prompts.js";
import { c, toolLine } from "./render.js";

export interface FollowUp {
	title: string;
	body: string;
	labels?: string[];
}

export interface WorkReport {
	outcome: "done" | "blocked" | "split";
	summary: string;
	testsRun?: string;
	followUps: FollowUp[];
	blockedReason?: string;
}

export interface SessionRunResult {
	cost: number;
	turns: number;
	/** Set when a budget forced an abort. */
	abortedBy?: "turns" | "cost" | "time" | "signal";
	sessionFile?: string;
	sessionId?: string;
	errorMessage?: string;
}

export interface WorkResult extends SessionRunResult {
	report?: WorkReport;
}

/** Commands the agent must not run: gloop owns git remote + GitHub state. */
const FORBIDDEN_BASH: Array<{ re: RegExp; reason: string }> = [
	{ re: /\bgit\s+push\b/, reason: "gloop pushes for you; leave changes in the working tree" },
	{ re: /\bgit\s+commit\b/, reason: "gloop commits for you; leave changes in the working tree" },
	{ re: /\bgit\s+(rebase|reset\s+--hard|filter-branch)\b/, reason: "do not rewrite history" },
	{ re: /\bgh\s+pr\b/, reason: "gloop owns pull requests" },
	{ re: /\bgh\s+issue\s+(create|close|edit|reopen|delete|transfer|pin|unpin|lock|unlock)\b/, reason: "declare follow-ups via report_result; gloop owns issue state" },
	{ re: /\bgh\s+(repo|release|api)\b/, reason: "repository administration is out of scope" },
	{ re: /\bgit\s+remote\b/, reason: "remotes are managed by gloop" },
	{ re: /\bgit\s+(checkout|switch)\s+(?!--\s|\.\s*$|\S*--\s)(-b\s+)?\S+/, reason: "stay on the work branch (git checkout -- <file> to revert files is fine)" },
];

const GLOOP_CONFIG_PATH_RE = /(^|[\\/])\.gloop([\\/.]|$)/;
/** Like GLOOP_CONFIG_PATH_RE, but also matches paths embedded in a shell command (after whitespace). */
const GLOOP_CONFIG_IN_COMMAND_RE = /(^|[\s\\/])\.gloop([\\/.]|\s|$)/;

/**
 * Check a bash command against the guard rules.
 * Returns a human-readable block reason, or undefined if the command is allowed.
 */
export function checkBashCommand(command: string): string | undefined {
	for (const { re, reason } of FORBIDDEN_BASH) {
		if (re.test(command)) {
			return `gloop guard: blocked (${reason})`;
		}
	}
	if (GLOOP_CONFIG_IN_COMMAND_RE.test(command) && /(>|>>|\btee\b|\brm\b|\bmv\b|\bcp\b|\bsed\s+-i)/.test(command)) {
		return "gloop guard: gloop configuration is human-only";
	}
	return undefined;
}

/**
 * Check a write/edit target path against the guard rules.
 * Returns a human-readable block reason, or undefined if the path is allowed.
 */
export function checkWritePath(path: string): string | undefined {
	if (GLOOP_CONFIG_PATH_RE.test(path)) {
		return "gloop guard: gloop configuration is human-only";
	}
	return undefined;
}

/**
 * Build a tool_call guard extension. `checkBash` decides whether a bash
 * command is allowed; write/edit tool calls are checked against `checkWrite`
 * (or blocked entirely when `checkWrite` is "block-all", for read-only runs).
 */
export function guardExtension(
	checkBash: (command: string) => string | undefined = checkBashCommand,
	checkWrite: ((path: string) => string | undefined) | "block-all" = checkWritePath,
): InlineExtension {
	return {
		name: "gloop-guard",
		factory: (pi) => {
			pi.on("tool_call", async (event) => {
				if (event.toolName === "bash") {
					const command = String((event.input as { command?: string })?.command ?? "");
					const reason = checkBash(command);
					if (reason) return { block: true, reason };
				}
				if (event.toolName === "write" || event.toolName === "edit") {
					if (checkWrite === "block-all") {
						return { block: true, reason: "gloop guard: this session is read-only" };
					}
					const p = String(
						(event.input as { path?: string; file_path?: string })?.path ??
							(event.input as { file_path?: string })?.file_path ??
							"",
					);
					const reason = checkWrite(p);
					if (reason) return { block: true, reason };
				}
				return undefined;
			});
		},
	};
}

type CreateSessionParams = NonNullable<Parameters<typeof createAgentSession>[0]>;

export interface AgentSessionOptions {
	cwd: string;
	config: GloopConfig;
	systemPrompt: string;
	tools: CreateSessionParams["tools"];
	customTools: CreateSessionParams["customTools"];
	guard: InlineExtension;
	prompt: string;
	nudgePrompt: string;
	/** Whether the run's result tool has been called (skips the nudge). */
	reported: () => boolean;
}

/**
 * Run one budgeted agent session: system prompt override, guard extension,
 * cost/turn/time budgets, live rendering. Shared by the fix worker and triage.
 */
export async function runAgentSession(opts: AgentSessionOptions): Promise<SessionRunResult> {
	const { cwd, config } = opts;
	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);

	let model;
	let thinkingLevel;
	if (config.model) {
		const resolved = resolveCliModel({ cliModel: config.model, modelRegistry });
		if (resolved.error) throw new Error(resolved.error);
		model = resolved.model;
		thinkingLevel = resolved.thinkingLevel;
	}

	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		systemPromptOverride: () => opts.systemPrompt,
		extensionFactories: [opts.guard],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd,
		model,
		thinkingLevel,
		authStorage,
		modelRegistry,
		resourceLoader,
		tools: opts.tools,
		customTools: opts.customTools,
		sessionManager: SessionManager.create(cwd),
	});

	const result: SessionRunResult = { cost: 0, turns: 0 };
	result.sessionFile = session.sessionFile;
	result.sessionId = session.sessionId;

	let abortedBy: SessionRunResult["abortedBy"];
	const abortWith = (reason: NonNullable<SessionRunResult["abortedBy"]>) => {
		if (abortedBy) return;
		abortedBy = reason;
		void session.abort();
	};

	const deadline = setTimeout(() => abortWith("time"), config.maxMinutesPerIssue * 60 * 1000);
	const onSigint = () => abortWith("signal");
	process.on("SIGINT", onSigint);

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			toolLine(event.toolName, event.args ?? {});
		}
		if (event.type === "message_end") {
			const msg = event.message as { role?: string; usage?: { cost?: { total?: number } } };
			if (msg.role === "assistant" && msg.usage?.cost?.total) {
				result.cost += msg.usage.cost.total;
				if (result.cost >= config.maxCostPerIssue) abortWith("cost");
			}
		}
		if (event.type === "turn_end") {
			result.turns += 1;
			if (result.turns >= config.maxTurnsPerIssue) abortWith("turns");
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(c.dim(event.assistantMessageEvent.delta));
		}
		if (event.type === "message_end") {
			const msg = event.message as { role?: string };
			if (msg.role === "assistant") process.stdout.write("\n");
		}
	});

	try {
		await session.prompt(opts.prompt);
		if (!opts.reported() && !abortedBy) {
			// One nudge: the model stopped without reporting.
			await session.prompt(opts.nudgePrompt);
		}
	} catch (err) {
		result.errorMessage = err instanceof Error ? err.message : String(err);
	} finally {
		clearTimeout(deadline);
		process.removeListener("SIGINT", onSigint);
		unsubscribe();
		session.dispose();
	}

	result.abortedBy = abortedBy;
	return result;
}

export async function runWorker(issue: IssueDetail, config: GloopConfig, cwd: string): Promise<WorkResult> {
	let report: WorkReport | undefined;

	const reportTool = defineTool({
		name: "report_result",
		label: "Report Result",
		description:
			"Report the final outcome of your work on this issue. Calling this tool is the only valid way to finish. Call it exactly once, as your last action.",
		parameters: Type.Object({
			outcome: Type.Union([Type.Literal("done"), Type.Literal("blocked"), Type.Literal("split")], {
				description:
					"done = implemented and verified; split = issue must be decomposed (no code changed); blocked = cannot proceed",
			}),
			summary: Type.String({
				description: "Clear summary of what was done and why. For done, this becomes the pull request body.",
			}),
			testsRun: Type.Optional(
				Type.String({ description: "What test/lint/typecheck commands were executed and their results" }),
			),
			followUps: Type.Optional(
				Type.Array(
					Type.Object({
						title: Type.String({ description: "Concise, actionable issue title" }),
						body: Type.String({
							description: "Self-contained issue body: context, what to do, acceptance criteria, code pointers",
						}),
						labels: Type.Optional(Type.Array(Type.String())),
					}),
					{ description: "Remaining work to file as new issues" },
				),
			),
			blockedReason: Type.Optional(Type.String({ description: "Required when outcome is blocked" })),
		}),
		execute: async (_id, params) => {
			report = {
				outcome: params.outcome,
				summary: params.summary,
				testsRun: params.testsRun,
				followUps: (params.followUps ?? []).slice(0, config.maxFollowUps),
				blockedReason: params.blockedReason,
			};
			const dropped = (params.followUps?.length ?? 0) - report.followUps.length;
			return {
				content: [
					{
						type: "text" as const,
						text: `Result recorded.${dropped > 0 ? ` Note: ${dropped} follow-up(s) dropped (max ${config.maxFollowUps}).` : ""} You are done; stop now.`,
					},
				],
				details: {},
			};
		},
	});

	const result = await runAgentSession({
		cwd,
		config,
		systemPrompt: loadSystemPrompt(cwd),
		tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "report_result"],
		customTools: [reportTool],
		guard: guardExtension(),
		prompt: buildIssuePrompt(issue, config),
		nudgePrompt: NUDGE_PROMPT,
		reported: () => report !== undefined,
	});

	return { ...result, report };
}
