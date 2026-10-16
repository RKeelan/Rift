import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/** The time git processes took, summed, and how many there were. */
export interface GitTime {
	ms: number;
	processes: number;
}

const gitTimes = new AsyncLocalStorage<GitTime>();

/**
 * Runs `fn`, adding to `time` each git command that it, or anything it
 * starts, runs. A request handled inside it counts its own commands, and
 * those of no other request.
 */
export function countGitTime(time: GitTime, fn: () => void): void {
	gitTimes.run(time, fn);
}

/** What a git command printed, and how it exited. */
export interface GitResult {
	exitCode: number;
	stdout: Buffer;
	stderr: string;
}

export interface GitOptions {
	/** Written to git's standard input, which is otherwise closed. */
	input?: string | Buffer;
	/**
	 * Whether a non-zero exit is a success after all, for a command whose exit
	 * code means something other than failure.
	 */
	accept?: (result: GitResult) => boolean;
}

/**
 * A git command that failed. Its message is git's own, from stderr, or from
 * stdout when git said nothing on stderr.
 */
export class GitError extends Error {
	readonly exitCode: number;
	readonly stderr: string;

	constructor(args: readonly string[], result: GitResult) {
		super(
			result.stderr.trim() ||
				result.stdout.toString("utf8").trim() ||
				`git ${args.join(" ")} exited with code ${result.exitCode}`,
		);
		this.name = "GitError";
		this.exitCode = result.exitCode;
		this.stderr = result.stderr;
	}
}

/** The git executable Rift starts, and the environment it starts it in. */
export interface GitCommand {
	binary: string;
	env?: NodeJS.ProcessEnv;
}

let located: Promise<GitCommand> | undefined;

/**
 * The git to start, found once. On Windows, the `git` on the PATH is
 * normally Git for Windows' launcher in `<Git>/cmd`, which starts the real
 * git in `<Git>/mingw64/bin` with that directory and `<Git>/usr/bin` at the
 * front of the PATH. Rift starts the real git itself, with the same PATH, so
 * each command is one process rather than two, and what git runs in turn,
 * such as hooks, filters and credential helpers, still finds Git for
 * Windows' tools. Elsewhere, and when the real git cannot be found, it is the
 * `git` on the PATH.
 */
export function gitCommand(): Promise<GitCommand> {
	located ??= findGit(process.platform, gitExecPath, isFile, process.env);
	return located;
}

// Where the git on the PATH keeps its own programs, or null when it cannot
// say.
async function gitExecPath(): Promise<string | null> {
	try {
		const result = await spawnProcess("git", ["--exec-path"], {});
		return result.exitCode === 0 ? result.stdout.toString("utf8").trim() : null;
	} catch {
		return null;
	}
}

function isFile(file: string): Promise<boolean> {
	return fs
		.stat(file)
		.then((stat) => stat.isFile())
		.catch(() => false);
}

/**
 * The git to start on a platform, given the PATH's git's exec path, a check
 * for a file, and the environment: gitCommand's answer, apart from the
 * machine it asks about.
 */
export async function findGit(
	platform: NodeJS.Platform,
	execPath: () => Promise<string | null>,
	exists: (file: string) => Promise<boolean>,
	env: NodeJS.ProcessEnv,
): Promise<GitCommand> {
	const onPath: GitCommand = { binary: "git" };
	if (platform !== "win32") return onPath;

	const gitCore = await execPath();
	if (!gitCore) return onPath;
	// <Git>/mingw64/libexec/git-core, whose mingw64 is named for the build:
	// mingw32 or clangarm64 on other machines.
	const mingw = path.win32.resolve(gitCore, "..", "..");
	const binary = path.win32.join(mingw, "bin", "git.exe");
	if (!(await exists(binary))) return onPath;

	// Windows names its variables without regard to case, and the key may be
	// `Path`, so the PATH is replaced under whatever key it already has.
	const pathKey =
		Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
	const searchPath = [
		path.win32.join(mingw, "bin"),
		path.win32.join(mingw, "..", "usr", "bin"),
		env[pathKey],
	]
		.filter(Boolean)
		.join(path.win32.delimiter);
	return { binary, env: { ...env, [pathKey]: searchPath } };
}

/**
 * Runs a git command in `cwd`, resolving with its output once it exits, or
 * rejecting with a GitError when it fails. A command fails when it exits with
 * a code other than 0 that `options.accept` does not accept; anything it
 * prints on stderr, such as a line-ending warning, is no failure in itself.
 *
 * `git status` refreshes the index when it can, which holds the index's lock
 * for a moment, and a stage or commit that wants the lock meanwhile fails at
 * once. The Files list polls status every few seconds, so every command
 * passes `--no-optional-locks`, which stops status writing the index. A
 * working-tree `git diff` still refreshes it, but Rift runs one only when a
 * file opens or changes, not on a timer. Commands that change the index
 * still take its lock.
 *
 * stdout comes back as bytes, for a caller that needs a file's exact
 * content. One that wants text decodes it as UTF-8 (see gitText).
 */
export async function runGit(
	cwd: string,
	args: readonly string[],
	options: GitOptions = {},
): Promise<GitResult> {
	const { binary, env } = await gitCommand();
	const start = performance.now();
	let result: GitResult;
	try {
		result = await spawnProcess(binary, ["--no-optional-locks", ...args], {
			cwd,
			env,
			input: options.input,
		});
	} finally {
		const time = gitTimes.getStore();
		if (time) {
			time.ms += performance.now() - start;
			time.processes += 1;
		}
	}
	if (result.exitCode !== 0 && !options.accept?.(result)) {
		throw new GitError(args, result);
	}
	return result;
}

/**
 * Runs a git command as runGit does and returns its stdout decoded as UTF-8,
 * which keeps a leading byte order mark.
 */
export async function gitText(
	cwd: string,
	args: readonly string[],
	options: GitOptions = {},
): Promise<string> {
	return (await runGit(cwd, args, options)).stdout.toString("utf8");
}

// How long a command's output pipes may stay open after it exits.
const PIPE_GRACE_MS = 50;

/**
 * Starts a process and collects its output. The process shares the server's
 * console, if it has one: started hidden, with `windowsHide`, each would get
 * a console host of its own on Windows, which costs several milliseconds a
 * process.
 *
 * A process normally closes its output pipes as it exits, and finishes then.
 * One that git starts in turn, such as a job a hook leaves running, can
 * inherit the pipes and hold them open long after git has exited. What it
 * prints is not git's, so a process whose pipes are still open PIPE_GRACE_MS
 * after it exits finishes with what it had printed, and its pipes are closed.
 */
function spawnProcess(
	binary: string,
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer },
): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		const { input } = options;
		const child = spawn(binary, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", reject);

		let exitCode: number | null = null;
		let grace: ReturnType<typeof setTimeout> | undefined;
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			clearTimeout(grace);
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve({
				// A process ended by a signal has no exit code.
				exitCode: exitCode ?? -1,
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		};
		child.on("exit", (code) => {
			exitCode = code;
			// The grace period ends with the output already in the pipes read,
			// however busy the server was when it ran out: a timer runs before
			// the reads of the event loop's turn, and an immediate after them.
			grace = setTimeout(() => setImmediate(finish), PIPE_GRACE_MS);
		});
		child.on("close", (code) => {
			exitCode ??= code;
			finish();
		});
		if (input !== undefined && child.stdin) {
			// A command that fails before reading all its input closes the pipe
			// under the write. The exit code reports the failure.
			child.stdin.on("error", () => {});
			child.stdin.end(input);
		}
	});
}
