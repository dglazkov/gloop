import { execFile, spawn } from "node:child_process";

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

/** Run a command, capture output. Never throws; check .code. */
export function exec(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<ExecResult> {
	return new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ cwd: opts.cwd, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				let code = 0;
				if (error) {
					const raw = (error as { code?: number | string }).code;
					code = typeof raw === "number" ? raw : 1;
				}
				resolve({ stdout, stderr, code });
			},
		);
	});
}

/** Run a command, throw with stderr on failure, return trimmed stdout. */
export async function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
	const result = await exec(cmd, args, opts);
	if (result.code !== 0) {
		throw new Error(`${cmd} ${args.join(" ")} failed (exit ${result.code}):\n${result.stderr || result.stdout}`);
	}
	return result.stdout.trim();
}

/** Run a shell command with inherited stdio (for verify commands). Returns exit code. */
export function runShellInherit(command: string, cwd: string): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(command, { shell: true, cwd, stdio: "inherit" });
		child.on("close", (code) => resolve(code ?? 1));
		child.on("error", () => resolve(1));
	});
}
