import { gitText } from "./runGit.js";

/** A path `git status` reports, with its index and working-tree codes. */
export interface StatusFile {
	path: string;
	/** The index's code, X in `git status --short`: what is staged. */
	index: string;
	/** The working tree's code, Y: what is not staged. */
	workingTree: string;
	/** Where a renamed or copied path came from. */
	from?: string;
}

/**
 * Reads `git status --porcelain -z`. Each entry is `XY PATH` ended by a NUL,
 * X being the index's code and Y the working tree's, and a rename or copy,
 * coded R or C on either side, is followed by the path it came from as an
 * entry of its own. Under -z git leaves paths unquoted, so a path is read as
 * it is, spaces at either end included. A branch header (`##`) or an ignored
 * path (`!!`) names no change and is left out.
 */
export function parseStatus(output: string): StatusFile[] {
	const fields = output.split("\0");
	const files: StatusFile[] = [];
	for (let at = 0; at < fields.length; at++) {
		const field = fields[at];
		if (field.length < 4) continue;
		const codes = field.slice(0, 2);
		if (codes === "##" || codes === "!!") continue;
		const [index, workingTree] = codes;
		const file: StatusFile = { path: field.slice(3), index, workingTree };
		if (/[RC]/.test(index) || /[RC]/.test(workingTree)) {
			at += 1;
			file.from = fields[at];
		}
		files.push(file);
	}
	return files;
}

/**
 * The repository's status: every changed path, and every untracked file
 * rather than only its directory.
 */
export async function gitStatus(cwd: string): Promise<StatusFile[]> {
	return parseStatus(
		await gitText(cwd, [
			"status",
			"--porcelain",
			"--untracked-files=all",
			"-z",
		]),
	);
}

/** A commit as the History tab lists it. */
export interface LogEntry {
	hash: string;
	/** The author's name, after any `.mailmap`. */
	author: string;
	/** The author date, in strict ISO 8601. */
	date: string;
	subject: string;
}

// Each commit's hash, author, date and subject, each ended by a NUL, which
// none of them can hold.
const LOG_FORMAT = "--format=%H%x00%aN%x00%aI%x00%s";

/** Reads `git log -z` in LOG_FORMAT. */
export function parseLog(output: string): LogEntry[] {
	const fields = output.split("\0");
	const entries: LogEntry[] = [];
	for (let at = 0; at + 4 <= fields.length; at += 4) {
		const [hash, author, date, subject] = fields.slice(at, at + 4);
		entries.push({ hash, author, date, subject });
	}
	return entries;
}

/**
 * The commits `git log` lists with the arguments given, such as a count or
 * a revision. Fails as git does, as on a branch with no commits yet.
 */
export async function gitLog(
	cwd: string,
	args: readonly string[],
): Promise<LogEntry[]> {
	return parseLog(await gitText(cwd, ["log", "-z", LOG_FORMAT, ...args]));
}
