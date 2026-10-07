import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Request, Response } from "express";
import { Router } from "express";
import type { StatusResult } from "simple-git";
import {
	type RepoRoot,
	resolveRepoInRoots,
	resolveSafePath,
} from "../pathUtils.js";
import { repoGit } from "../repoGit.js";

const MAX_DIFF_SIZE = 1024 * 1024; // 1 MB
// The limits /api/files/content puts on a file, which a base copy of one
// shares: its size, and how much of it is read for a NUL that marks it
// binary.
const MAX_BASE_SIZE = 1024 * 1024; // 1 MB
const BINARY_CHECK_SIZE = 8192; // 8 KB

type FileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

interface StatusEntry {
	path: string;
	status: FileStatus;
	staged: boolean;
}

// Git's `<rev>:<path>` syntax only understands forward slashes, so a Windows
// path.relative() result has to be converted before it can name a blob.
function toGitPath(relativePath: string): string {
	return relativePath.split(path.sep).join("/");
}

function mapIndexStatus(code: string): FileStatus | null {
	switch (code) {
		case "A":
			return "added";
		case "M":
			return "modified";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		default:
			return null;
	}
}

function mapWorkingTreeStatus(code: string): FileStatus | null {
	switch (code) {
		case "M":
			return "modified";
		case "D":
			return "deleted";
		case "?":
			return "untracked";
		default:
			return null;
	}
}

function buildStatusEntries(status: StatusResult): StatusEntry[] {
	const entries: StatusEntry[] = [];

	for (const file of status.files) {
		// Staged change
		const stagedStatus = mapIndexStatus(file.index);
		if (stagedStatus) {
			entries.push({ path: file.path, status: stagedStatus, staged: true });
		}

		// Unstaged change
		const unstagedStatus = mapWorkingTreeStatus(file.working_dir);
		if (unstagedStatus) {
			entries.push({ path: file.path, status: unstagedStatus, staged: false });
		}
	}

	return entries;
}

async function resolveGitRepo(
	roots: RepoRoot[],
	req: Request,
	res: Response,
): Promise<ReturnType<typeof repoGit> | null> {
	const repoName = req.query.repo as string;
	if (!repoName) {
		res.status(400).json({
			error: {
				code: "MISSING_REPO",
				message: "repo query parameter is required",
			},
		});
		return null;
	}
	const result = await resolveRepoInRoots(roots, repoName);
	if (!result.ok) {
		const status = result.reason === "forbidden" ? 403 : 404;
		const code = result.reason === "forbidden" ? "REPO_FORBIDDEN" : "NOT_FOUND";
		const message =
			result.reason === "forbidden"
				? "Invalid repo name"
				: "Repository not found";
		res.status(status).json({ error: { code, message } });
		return null;
	}
	return repoGit(result.path);
}

// A [start, end] pair of inclusive, 1-based line numbers naming lines in the
// working-tree file.
type LineRange = [number, number];

// Validates the optional `ranges` field on a stage request. Returns the parsed
// ranges, or null when the field is malformed so the caller can reject it.
function validateRanges(value: unknown): LineRange[] | null {
	if (!Array.isArray(value)) return null;
	const ranges: LineRange[] = [];
	for (const entry of value) {
		if (!Array.isArray(entry) || entry.length !== 2) return null;
		const [start, end] = entry;
		if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
		if (start < 1 || end < start) return null;
		ranges.push([start, end]);
	}
	return ranges;
}

function lineSelected(line: number, ranges: LineRange[]): boolean {
	for (const [start, end] of ranges) {
		if (line >= start && line <= end) return true;
	}
	return false;
}

/**
 * Rebuilds a partial patch from a `git diff` that keeps only the lines the
 * selection covers. Context lines stay context; a selected `+` stays `+` and a
 * selected `-` stays `-`. Deletions anchor to the new-file line they sit in
 * front of, matching the editor's widgets, so a modification (delete paired
 * with an add) is kept as a unit and a pure deletion is kept when the line
 * just below it is selected.
 *
 * Staging (the default) reads an index→worktree diff and reconstructs the old
 * (index) side exactly, so the patch applies cleanly with `git apply --cached`:
 * an unselected `+` is dropped, an unselected `-` becomes context. Unstaging
 * (`reverse`) reads an index→HEAD diff and reconstructs the new (index) side
 * exactly, so the patch applies cleanly with `git apply --cached --reverse`:
 * an unselected `+` becomes context, an unselected `-` is dropped. Both use
 * `--recount` to derive the hunk counts from the rebuilt body.
 *
 * A new file's diff, whether of an untracked file or a staged one, has only
 * additions. Staging part of it creates the file holding just the selected
 * lines. Unstaging part of it leaves the rest in the index, so the patch
 * reverses a change to the file rather than its creation, which git refuses
 * to reverse while lines would remain. Unstaging all of it reverses the
 * creation, which takes the file out of the index, as unstaging it whole does.
 *
 * Splitting on `\n` preserves any `\r`, keeping a CRLF working tree
 * byte-faithful. Returns null when the selection covers no change.
 */
export function buildPartialPatch(
	diff: string,
	ranges: LineRange[],
	reverse = false,
): string | null {
	if (!diff) return null;

	const hasTrailingNewline = diff.endsWith("\n");
	const lines = diff.split("\n");
	if (hasTrailingNewline) lines.pop();

	const preamble: string[] = [];
	const out: string[] = [];
	let index = 0;

	// Preamble: the file headers before the first hunk.
	while (index < lines.length && !lines[index].startsWith("@@")) {
		preamble.push(lines[index]);
		index += 1;
	}
	if (index === lines.length) return null;

	let anyChange = false;
	// Whether unstaging leaves any staged addition in the index.
	let keptAddition = false;

	while (index < lines.length && lines[index].startsWith("@@")) {
		const header = lines[index];
		index += 1;
		const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(header);
		// A hunk with no new lines, as when a file is emptied, names the line
		// before it, so its deletions sit in front of the line after that.
		let newLine = match ? Number(match[1]) + (match[2] === "0" ? 1 : 0) : 1;

		const body: string[] = [];
		let hunkChanged = false;
		let lastDropped = false;

		while (
			index < lines.length &&
			!lines[index].startsWith("@@") &&
			!lines[index].startsWith("diff --git")
		) {
			const line = lines[index];
			index += 1;

			if (line.startsWith("\\")) {
				// A "\ No newline at end of file" marker follows the fate of the
				// line it trails: keep it only when that line survived.
				if (!lastDropped) body.push(line);
				continue;
			}

			// The preamble loop consumed the file headers, so inside a hunk a line
			// starting "+++" or "---" is a changed line beginning with "++" or "--".
			if (line.startsWith("+")) {
				if (lineSelected(newLine, ranges)) {
					body.push(line);
					hunkChanged = true;
					lastDropped = false;
				} else if (reverse) {
					// Unstaging leaves an unselected staged addition in the index, so
					// it stays as context to reconstruct the index side exactly.
					body.push(` ${line.slice(1)}`);
					keptAddition = true;
					lastDropped = false;
				} else {
					lastDropped = true;
				}
				newLine += 1;
				continue;
			}

			if (line.startsWith("-")) {
				if (lineSelected(newLine, ranges)) {
					body.push(line);
					hunkChanged = true;
					lastDropped = false;
				} else if (reverse) {
					// The index omits an unselected staged deletion, so drop it to keep
					// the reconstructed index side matching what git reverses against.
					lastDropped = true;
				} else {
					body.push(` ${line.slice(1)}`);
					lastDropped = false;
				}
				continue;
			}

			// Context line (present in both index and working tree).
			body.push(line);
			lastDropped = false;
			newLine += 1;
		}

		if (hunkChanged) {
			out.push(header, ...body);
			anyChange = true;
		}
	}

	if (!anyChange) return null;
	const header =
		reverse && keptAddition && preamble.includes("--- /dev/null")
			? asModificationHeader(preamble)
			: preamble;
	return `${[...header, ...out].join("\n")}\n`;
}

/**
 * Turns a new file's patch headers into those of a change to the file, by
 * dropping what marks a creation: the new file's mode, the null blob it starts
 * from, and /dev/null as its old name, which the new name replaces.
 */
function asModificationHeader(preamble: string[]): string[] {
	const newName = preamble.find((line) => line.startsWith("+++ "))?.slice(4);
	return preamble.flatMap((line) => {
		if (line.startsWith("new file mode ") || line.startsWith("index ")) {
			return [];
		}
		return line === "--- /dev/null" && newName ? [`--- ${newName}`] : [line];
	});
}

/**
 * The `<from>..<to>` blob ids on a single-file diff's `index` line, or null
 * when it has none, as an empty diff does. Two diffs that name the same blobs
 * on both sides are the same diff, so their line numbers mean the same lines.
 */
function diffBlobs(diff: string): string | null {
	return /^index ([0-9a-f]+\.\.[0-9a-f]+)/m.exec(diff)?.[1] ?? null;
}

// Thrown when the diff about to be acted on is not the one the caller read
// its line numbers from.
class StaleDiffError extends Error {}

function checkDiffBlobs(diff: string, expectedBlobs: string | null): void {
	if (expectedBlobs !== null && diffBlobs(diff) !== expectedBlobs) {
		throw new StaleDiffError("The diff changed since it was read");
	}
}

/**
 * An untracked file's diff against nothing, which is the diff it would have
 * once added: a new-file patch of its lines, put through the clean filters
 * and line-ending conversion that `git add` applies. The flags keep the
 * user's diff settings, such as a textconv driver, an external diff, colour,
 * or other prefixes, from changing the text that staging slices.
 */
async function untrackedDiff(
	toplevel: string,
	relativePath: string,
): Promise<string> {
	// `git diff --no-index` exits 1 whenever its sides differ, which against
	// /dev/null they always do, and simple-git takes a failing exit with
	// anything on stderr, such as a line-ending warning, for an error. So the
	// exit is a failure only when it comes without a diff, as for a missing file.
	const git = repoGit(toplevel, (error, result) =>
		result.exitCode === 1 && result.stdOut.length > 0 ? undefined : error,
	);
	return git.diff([
		"--no-index",
		"--full-index",
		"--no-textconv",
		"--no-ext-diff",
		"--no-color",
		"--src-prefix=a/",
		"--dst-prefix=b/",
		"--",
		"/dev/null",
		toGitPath(relativePath),
	]);
}

/**
 * Whether a new file's diff, as text, rebuilds exactly the file that git
 * hashed for the new side of its `index` line. Git's output reaches Rift
 * decoded as UTF-8, and a patch goes back encoded as UTF-8, so the lines of a
 * file that is not UTF-8 would be staged with their undecodable bytes
 * replaced. So would text that is not the file's at all, such as a textconv
 * driver's, or a diff read while the file was being written.
 */
export function newFileDiffIsExact(diff: string): boolean {
	const blob = /^index [0-9a-f]+\.\.([0-9a-f]+)$/m.exec(diff)?.[1];
	if (!blob) return false;

	const lines = diff.split("\n");
	let index = lines.findIndex((line) => line.startsWith("@@"));
	let text = "";
	if (index !== -1) {
		for (index += 1; index < lines.length; index += 1) {
			const line = lines[index];
			if (line.startsWith("+")) {
				text += `${line.slice(1)}\n`;
			} else if (line.startsWith("\\")) {
				text = text.slice(0, -1);
			} else if (line !== "" || index !== lines.length - 1) {
				// A new file's diff is a single hunk of additions.
				return false;
			}
		}
	}

	const content = Buffer.from(text, "utf8");
	// A SHA-256 repository names its blobs with 64 hex digits, SHA-1 with 40.
	const hash = createHash(blob.length === 64 ? "sha256" : "sha1");
	hash.update(`blob ${content.length}\0`);
	hash.update(content);
	return hash.digest("hex") === blob;
}

// Thrown when a new file's diff does not describe the file exactly, so its
// lines cannot be staged from it.
class InexactDiffError extends Error {}

// Stages the selected lines of a change by rebuilding a partial patch from the
// diff the caller read and applying it to the index. A no-op when the
// selection covers no change, so the caller can still return the current
// status. The diff it slices is the same output it checks against
// expectedBlobs, so the patch holds exactly the lines the caller picked. A new
// file's patch also creates the file, so its diff has to describe the file
// exactly.
async function applyPartialStage(
	gitRoot: ReturnType<typeof repoGit>,
	diff: string,
	ranges: LineRange[],
	expectedBlobs: string | null,
	newFile: boolean,
): Promise<void> {
	checkDiffBlobs(diff, expectedBlobs);
	if (newFile && !newFileDiffIsExact(diff)) {
		throw new InexactDiffError("Git's diff does not describe the file exactly");
	}
	const patch = buildPartialPatch(diff, ranges);
	if (patch === null) return;

	const patchFile = path.join(os.tmpdir(), `rift-stage-${randomUUID()}.patch`);
	await fs.writeFile(patchFile, patch);
	try {
		await gitRoot.raw(["apply", "--cached", "--recount", patchFile]);
	} finally {
		await fs.rm(patchFile, { force: true });
	}
}

// Unstages the selected lines of a staged change by rebuilding a partial patch
// from the index→HEAD diff and reversing it out of the index. Mirrors
// applyPartialStage. A no-op (returning early) when the selection covers no
// staged change, so the caller can still return the current status.
async function applyPartialUnstage(
	gitRoot: ReturnType<typeof repoGit>,
	relativePath: string,
	ranges: LineRange[],
	expectedBlobs: string | null,
): Promise<void> {
	const diff = await gitRoot.diff([
		"--cached",
		"--full-index",
		"--",
		relativePath,
	]);
	checkDiffBlobs(diff, expectedBlobs);
	const patch = buildPartialPatch(diff, ranges, true);
	if (patch === null) return;

	const patchFile = path.join(
		os.tmpdir(),
		`rift-unstage-${randomUUID()}.patch`,
	);
	await fs.writeFile(patchFile, patch);
	try {
		await gitRoot.raw([
			"apply",
			"--cached",
			"--reverse",
			"--recount",
			patchFile,
		]);
	} finally {
		await fs.rm(patchFile, { force: true });
	}
}

async function handleStageAction(
	roots: RepoRoot[],
	req: Request,
	res: Response,
	action: "stage" | "unstage",
): Promise<void> {
	const git = await resolveGitRepo(roots, req, res);
	if (!git) return;

	const isRepo = await git.checkIsRepo();
	if (!isRepo) {
		res.status(400).json({
			error: {
				code: "NOT_GIT_REPO",
				message: "The working directory is not a git repository",
			},
		});
		return;
	}

	const filePath = req.body?.path;
	if (typeof filePath !== "string" || filePath.length === 0) {
		res.status(400).json({
			error: { code: "MISSING_PATH", message: "path parameter is required" },
		});
		return;
	}

	// An optional `ranges` field opts either action into line granularity;
	// staging slices the worktree diff, unstaging reverses the index diff.
	let ranges: LineRange[] | null = null;
	if (req.body?.ranges !== undefined) {
		ranges = validateRanges(req.body.ranges);
		if (ranges === null) {
			res.status(400).json({
				error: {
					code: "INVALID_RANGES",
					message: "ranges must be an array of [start, end] line pairs",
				},
			});
			return;
		}
	}

	// Line numbers only mean something against the diff they were read from,
	// and a stale number applies cleanly to whatever line now sits there. So a
	// caller may name that diff by the full blob ids on its `index` line, and
	// the action is refused unless the diff about to be acted on names the same
	// blobs. Staging a file whole may name the file's modification time instead.
	const expectedBlobs: unknown = req.body?.expectedBlobs;
	if (
		expectedBlobs !== undefined &&
		(typeof expectedBlobs !== "string" ||
			!/^(?:[0-9a-f]{40}|[0-9a-f]{64})\.\.(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(
				expectedBlobs,
			))
	) {
		res.status(400).json({
			error: {
				code: "INVALID_BLOBS",
				message: "expectedBlobs must name two full object ids, as <from>..<to>",
			},
		});
		return;
	}
	const expectedMtimeMs: unknown = req.body?.expectedMtimeMs;
	if (
		action === "stage" &&
		expectedMtimeMs !== undefined &&
		(typeof expectedMtimeMs !== "number" || !Number.isFinite(expectedMtimeMs))
	) {
		res.status(400).json({
			error: {
				code: "INVALID_MTIME",
				message: "expectedMtimeMs must be a number",
			},
		});
		return;
	}
	// An untracked file has no diff against the index, so a caller staging it
	// says the file is untracked, and its line numbers and blob ids then name
	// the file's diff against nothing.
	const untracked: unknown = req.body?.untracked;
	if (
		action === "stage" &&
		untracked !== undefined &&
		typeof untracked !== "boolean"
	) {
		res.status(400).json({
			error: {
				code: "INVALID_UNTRACKED",
				message: "untracked must be a boolean",
			},
		});
		return;
	}

	// git status reports repo-root-relative paths, so validate and run against
	// the repo root even when the server was started from a subdirectory.
	const toplevel = (await git.revparse(["--show-toplevel"])).trim();
	const resolved = await resolveSafePath(toplevel, filePath);
	if (!resolved) {
		res.status(403).json({
			error: {
				code: "PATH_FORBIDDEN",
				message: "Path escapes the working directory",
			},
		});
		return;
	}

	const gitRoot = repoGit(toplevel);
	const relativePath = path.relative(toplevel, resolved);

	if (
		action === "stage" &&
		ranges === null &&
		typeof expectedMtimeMs === "number"
	) {
		const stat = await fs.stat(resolved).catch(() => null);
		if (stat?.mtimeMs !== expectedMtimeMs) {
			res.status(409).json({
				error: {
					code: "FILE_MODIFIED",
					message: "File changed on disk since it was loaded",
				},
			});
			return;
		}
	}

	const blobs = typeof expectedBlobs === "string" ? expectedBlobs : null;
	// The diff a stage's line numbers and blob ids come from.
	const stageDiff = () =>
		untracked === true
			? untrackedDiff(toplevel, relativePath)
			: gitRoot.diff(["--full-index", "--", relativePath]);
	try {
		if (action === "stage") {
			if (ranges !== null) {
				// Line-level staging: an empty selection or one that touches no
				// change stages nothing, falling through to the current status.
				if (ranges.length > 0) {
					await applyPartialStage(
						gitRoot,
						await stageDiff(),
						ranges,
						blobs,
						untracked === true,
					);
				}
			} else {
				// A whole-file action is checked and then run by separate commands,
				// so a change landing between the two still goes through. It has no
				// line numbers to misapply, so the window can only let through
				// content the caller never saw, not stage the wrong lines.
				if (blobs !== null) {
					checkDiffBlobs(await stageDiff(), blobs);
				}
				// `git add` stages additions, modifications, and deletions alike.
				await gitRoot.raw(["add", "--", relativePath]);
			}
		} else {
			if (ranges !== null) {
				// Line-level unstaging: an empty selection or one that touches no
				// staged change unstages nothing, falling through to the current
				// status.
				if (ranges.length > 0) {
					await applyPartialUnstage(gitRoot, relativePath, ranges, blobs);
				}
			} else {
				// Checked and then run separately, as staging a whole file is.
				if (blobs !== null) {
					checkDiffBlobs(
						await gitRoot.diff([
							"--cached",
							"--full-index",
							"--",
							relativePath,
						]),
						blobs,
					);
				}
				// A plain reset (no explicit HEAD) unstages the path whether or not
				// the repo has any commits yet; `reset HEAD` would fail before the
				// first commit.
				await gitRoot.raw(["reset", "-q", "--", relativePath]);
			}
		}
	} catch (err) {
		if (err instanceof StaleDiffError) {
			res.status(409).json({
				error: {
					code: "DIFF_CHANGED",
					message: "The diff changed since it was read",
				},
			});
			return;
		}
		if (err instanceof InexactDiffError) {
			res.status(422).json({
				error: {
					code: "DIFF_INEXACT",
					message:
						"Git's diff doesn't describe this file exactly, so it can only be staged whole",
				},
			});
			return;
		}
		res.status(500).json({
			error: {
				code: "GIT_ERROR",
				message: err instanceof Error ? err.message : "Git command failed",
			},
		});
		return;
	}

	const status = await gitRoot.status();
	res.json({ files: buildStatusEntries(status) });
}

export function gitRoutes(roots: RepoRoot[]): Router {
	const router = Router();

	// GET /api/git/status?repo=<name>
	router.get("/status", async (req, res) => {
		const git = await resolveGitRepo(roots, req, res);
		if (!git) return;

		const isRepo = await git.checkIsRepo();
		if (!isRepo) {
			res.status(400).json({
				error: {
					code: "NOT_GIT_REPO",
					message: "The working directory is not a git repository",
				},
			});
			return;
		}

		const status = await git.status();
		res.json({ files: buildStatusEntries(status) });
	});

	// POST /api/git/stage?repo=<name>
	//   body: { path, ranges?, expectedBlobs?, expectedMtimeMs?, untracked? }
	// Responds 409 DIFF_CHANGED when the diff's index line no longer names
	// expectedBlobs, and FILE_MODIFIED when a whole-file stage finds the file's
	// mtime is no longer expectedMtimeMs. With `untracked`, the diff is the
	// file's diff against nothing, so ranges stage its lines as a new file, and
	// the stage answers 422 DIFF_INEXACT when that diff does not describe the
	// file exactly.
	router.post("/stage", async (req, res) => {
		await handleStageAction(roots, req, res, "stage");
	});

	// POST /api/git/unstage?repo=<name>  body: { path, ranges?, expectedBlobs? }
	// Responds 409 DIFF_CHANGED when the staged diff's index line no longer
	// names expectedBlobs.
	router.post("/unstage", async (req, res) => {
		await handleStageAction(roots, req, res, "unstage");
	});

	// POST /api/git/commit?repo=<name>  body: { message }
	// Commits whatever the index holds. The message goes to git whole, so its
	// first line is the subject and the rest the body, as git reads it.
	// Responds 400 MISSING_MESSAGE for a blank message and NO_STAGED_CHANGES
	// when nothing is staged, and with the new commit's hash on success.
	router.post("/commit", async (req, res) => {
		const git = await resolveGitRepo(roots, req, res);
		if (!git) return;

		const isRepo = await git.checkIsRepo();
		if (!isRepo) {
			res.status(400).json({
				error: {
					code: "NOT_GIT_REPO",
					message: "The working directory is not a git repository",
				},
			});
			return;
		}

		const message: unknown = req.body?.message;
		if (typeof message !== "string" || message.trim() === "") {
			res.status(400).json({
				error: {
					code: "MISSING_MESSAGE",
					message: "A commit message is required",
				},
			});
			return;
		}

		const toplevel = (await git.revparse(["--show-toplevel"])).trim();
		const gitRoot = repoGit(toplevel);
		const before = buildStatusEntries(await gitRoot.status());
		if (!before.some((entry) => entry.staged)) {
			res.status(400).json({
				error: {
					code: "NO_STAGED_CHANGES",
					message: "There are no staged changes to commit",
				},
			});
			return;
		}

		// The message goes through a file, as a patch does, because a command
		// line has a length limit that a long message can pass.
		const messageFile = path.join(
			os.tmpdir(),
			`rift-commit-${randomUUID()}.txt`,
		);
		let commit: string;
		try {
			await fs.writeFile(messageFile, message);
			await gitRoot.raw(["commit", "-F", messageFile]);
			commit = (await gitRoot.revparse(["HEAD"])).trim();
		} catch (err) {
			// A failing hook or a missing identity reads best in git's own words.
			res.status(500).json({
				error: {
					code: "GIT_ERROR",
					message: err instanceof Error ? err.message : "Git command failed",
				},
			});
			return;
		} finally {
			await fs.rm(messageFile, { force: true });
		}

		const status = await gitRoot.status();
		res.json({ commit, files: buildStatusEntries(status) });
	});

	// GET /api/git/log?repo=<name>&limit=<n>&offset=<n>
	router.get("/log", async (req, res) => {
		const git = await resolveGitRepo(roots, req, res);
		if (!git) return;

		const isRepo = await git.checkIsRepo();
		if (!isRepo) {
			res.status(400).json({
				error: {
					code: "NOT_GIT_REPO",
					message: "The working directory is not a git repository",
				},
			});
			return;
		}

		const limit = Math.min(Math.max(1, Number(req.query.limit) || 25), 100);
		const offset = Math.max(0, Number(req.query.offset) || 0);

		try {
			const log = await git.log([`--skip=${offset}`, `--max-count=${limit}`]);

			const commits = log.all.map((entry) => ({
				hash: entry.hash,
				author: entry.author_name,
				date: entry.date,
				subject: entry.message,
			}));

			res.json({ commits });
		} catch {
			// No commits yet (empty repo)
			res.json({ commits: [] });
		}
	});

	// GET /api/git/commit/:hash?repo=<name>
	router.get("/commit/:hash", async (req, res) => {
		const { hash } = req.params;
		if (!/^[0-9a-f]{7,40}$/.test(hash)) {
			res.status(400).json({
				error: {
					code: "INVALID_HASH",
					message: "Hash must be 7-40 lowercase hex characters",
				},
			});
			return;
		}

		const git = await resolveGitRepo(roots, req, res);
		if (!git) return;

		const isRepo = await git.checkIsRepo();
		if (!isRepo) {
			res.status(400).json({
				error: {
					code: "NOT_GIT_REPO",
					message: "The working directory is not a git repository",
				},
			});
			return;
		}

		try {
			// Get commit metadata
			const logResult = await git.log(["-1", hash]);
			const commit = logResult.latest;
			if (!commit) {
				res.status(404).json({
					error: { code: "NOT_FOUND", message: "Commit not found" },
				});
				return;
			}

			// Get changed files with stats
			const raw = await git.raw([
				"diff-tree",
				"--root",
				"--no-commit-id",
				"-r",
				"--numstat",
				"--diff-filter=ACDMRT",
				hash,
			]);

			const files = raw
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [add, del, ...pathParts] = line.split("\t");
					const filePath = pathParts.join("\t"); // handle renames with tabs
					return {
						path: filePath,
						additions: add === "-" ? 0 : Number(add),
						deletions: del === "-" ? 0 : Number(del),
					};
				});

			// Get file statuses (A/M/D/R)
			const statusRaw = await git.raw([
				"diff-tree",
				"--root",
				"--no-commit-id",
				"-r",
				"--name-status",
				"--diff-filter=ACDMRT",
				hash,
			]);

			const statusMap = new Map<string, string>();
			for (const line of statusRaw.trim().split("\n").filter(Boolean)) {
				const [status, ...pathParts] = line.split("\t");
				const filePath = pathParts[pathParts.length - 1]; // for renames, use destination
				statusMap.set(filePath, status.charAt(0));
			}

			const filesWithStatus = files.map((f) => ({
				...f,
				status: statusMap.get(f.path) ?? "M",
			}));

			res.json({
				hash: commit.hash,
				author: commit.author_name,
				date: commit.date,
				subject: commit.message,
				files: filesWithStatus,
			});
		} catch {
			res.status(404).json({
				error: { code: "NOT_FOUND", message: "Commit not found" },
			});
		}
	});

	// GET /api/git/commit/:hash/diff?repo=<name>&path=<file>
	router.get("/commit/:hash/diff", async (req, res) => {
		const { hash } = req.params;
		if (!/^[0-9a-f]{7,40}$/.test(hash)) {
			res.status(400).json({
				error: {
					code: "INVALID_HASH",
					message: "Hash must be 7-40 lowercase hex characters",
				},
			});
			return;
		}

		const filePath = req.query.path as string;
		if (!filePath) {
			res.status(400).json({
				error: {
					code: "MISSING_PATH",
					message: "path parameter is required",
				},
			});
			return;
		}

		const git = await resolveGitRepo(roots, req, res);
		if (!git) return;

		const isRepo = await git.checkIsRepo();
		if (!isRepo) {
			res.status(400).json({
				error: {
					code: "NOT_GIT_REPO",
					message: "The working directory is not a git repository",
				},
			});
			return;
		}

		const toplevel = (await git.revparse(["--show-toplevel"])).trim();
		const resolved = await resolveSafePath(toplevel, filePath);
		if (!resolved) {
			res.status(403).json({
				error: {
					code: "PATH_FORBIDDEN",
					message: "Path escapes the working directory",
				},
			});
			return;
		}

		try {
			const relativePath = path.relative(toplevel, resolved);
			const gitRoot = repoGit(toplevel);
			// Use git show which handles root commits (no parent) naturally
			const diff = await gitRoot.raw([
				"show",
				"--format=",
				"-p",
				hash,
				"--",
				relativePath,
			]);

			if (diff.length > MAX_DIFF_SIZE) {
				res.json({
					diff: diff.slice(0, MAX_DIFF_SIZE),
					truncated: true,
				});
				return;
			}

			res.json({ diff, truncated: false });
		} catch {
			res.status(404).json({
				error: { code: "NOT_FOUND", message: "Commit or file not found" },
			});
		}
	});

	// GET /api/git/base-content?repo=<name>&path=<file>&staged=<bool>
	// Responds 413 FILE_TOO_LARGE and 415 BINARY_FILE for a copy the editor
	// would not show, as /api/files/content does for the file itself.
	router.get("/base-content", async (req, res) => {
		const filePath = req.query.path as string;
		if (!filePath) {
			res.status(400).json({
				error: {
					code: "MISSING_PATH",
					message: "path parameter is required",
				},
			});
			return;
		}

		const git = await resolveGitRepo(roots, req, res);
		if (!git) return;

		const isRepo = await git.checkIsRepo();
		if (!isRepo) {
			res.status(400).json({
				error: {
					code: "NOT_GIT_REPO",
					message: "The working directory is not a git repository",
				},
			});
			return;
		}

		const toplevel = (await git.revparse(["--show-toplevel"])).trim();
		const resolved = await resolveSafePath(toplevel, filePath);
		if (!resolved) {
			res.status(403).json({
				error: {
					code: "PATH_FORBIDDEN",
					message: "Path escapes the working directory",
				},
			});
			return;
		}

		try {
			const relativePath = toGitPath(path.relative(toplevel, resolved));
			const gitRoot = repoGit(toplevel);
			// Unstaged edits are compared against the index, matching what
			// `git diff` reports; staged edits are compared against HEAD. A
			// file added but not yet committed has no HEAD version at all.
			const staged = req.query.staged === "true";
			const revision = staged ? `HEAD:${relativePath}` : `:${relativePath}`;
			const content = await gitRoot.showBuffer(revision);
			// The editor shows no file that is too large or binary, so a copy
			// of one is refused as /api/files/content refuses the file
			// itself, rather than sent whole.
			if (content.length > MAX_BASE_SIZE) {
				res.status(413).json({
					error: {
						code: "FILE_TOO_LARGE",
						message: `File exceeds maximum size of ${MAX_BASE_SIZE / (1024 * 1024)} MB`,
					},
				});
				return;
			}
			if (content.subarray(0, BINARY_CHECK_SIZE).includes(0)) {
				res.status(415).json({
					error: {
						code: "BINARY_FILE",
						message: "Binary files are not supported",
					},
				});
				return;
			}
			res.type("text/plain").send(content.toString("utf-8"));
		} catch {
			res.status(404).json({
				error: { code: "NOT_FOUND", message: "Base file not found" },
			});
		}
	});

	// GET /api/git/diff?repo=<name>&path=<file>&staged=<bool>&untracked=<bool>
	// With `untracked`, an unstaged diff is the file's diff against nothing,
	// since an untracked file has none against the index, and the response
	// says whether it is exact. Responds 404 NOT_FOUND when there is no such
	// file to diff.
	router.get("/diff", async (req, res) => {
		const filePath = req.query.path as string;
		if (!filePath) {
			res.status(400).json({
				error: {
					code: "MISSING_PATH",
					message: "path parameter is required",
				},
			});
			return;
		}

		const git = await resolveGitRepo(roots, req, res);
		if (!git) return;

		const isRepo = await git.checkIsRepo();
		if (!isRepo) {
			res.status(400).json({
				error: {
					code: "NOT_GIT_REPO",
					message: "The working directory is not a git repository",
				},
			});
			return;
		}

		// git status returns paths relative to the repo root, which may
		// differ from workingDir when the server runs from a subdirectory.
		// Validate and resolve against the repo root so git diff finds
		// the correct file.
		const toplevel = (await git.revparse(["--show-toplevel"])).trim();
		const resolved = await resolveSafePath(toplevel, filePath);
		if (!resolved) {
			res.status(403).json({
				error: {
					code: "PATH_FORBIDDEN",
					message: "Path escapes the working directory",
				},
			});
			return;
		}

		const staged = req.query.staged === "true";
		// Run the diff from the repo root so path interpretation is
		// consistent with git status output (both repo-root-relative).
		const gitRoot = repoGit(toplevel);
		const relativePath = path.relative(toplevel, resolved);
		// Full blob ids on the index line let a caller name this diff when it
		// stages or unstages lines read from it.
		const diffArgs = staged
			? ["--cached", "--full-index", "--", relativePath]
			: ["--full-index", "--", relativePath];
		const untracked = !staged && req.query.untracked === "true";
		let diff: string;
		if (untracked) {
			try {
				diff = await untrackedDiff(toplevel, relativePath);
			} catch {
				// There is no file to diff, as when it has gone or the path names a
				// directory.
				res.status(404).json({
					error: { code: "NOT_FOUND", message: "File not found" },
				});
				return;
			}
		} else {
			diff = await gitRoot.diff(diffArgs);
		}
		const truncated = diff.length > MAX_DIFF_SIZE;
		// An untracked file's lines stage from its diff only when the diff, as
		// sent, describes the file exactly, which `exact` says.
		const exact = untracked
			? { exact: !truncated && newFileDiffIsExact(diff) }
			: {};

		res.json({
			diff: truncated ? diff.slice(0, MAX_DIFF_SIZE) : diff,
			truncated,
			...exact,
		});
	});

	return router;
}
