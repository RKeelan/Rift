import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Request, Response } from "express";
import { Router } from "express";
import { type StatusResult, simpleGit } from "simple-git";
import {
	type RepoRoot,
	resolveRepoInRoots,
	resolveSafePath,
} from "../pathUtils.js";

const MAX_DIFF_SIZE = 1024 * 1024; // 1 MB

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
): Promise<ReturnType<typeof simpleGit> | null> {
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
	return simpleGit(result.path);
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

	const out: string[] = [];
	let index = 0;

	// Preamble: the file headers before the first hunk.
	while (index < lines.length && !lines[index].startsWith("@@")) {
		out.push(lines[index]);
		index += 1;
	}
	if (index === lines.length) return null;

	let anyChange = false;

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
	return `${out.join("\n")}\n`;
}

// Stages the selected lines of a change by rebuilding a partial patch and
// applying it to the index. A no-op (returning false) when the selection
// covers no change, so the caller can still return the current status.
async function applyPartialStage(
	gitRoot: ReturnType<typeof simpleGit>,
	relativePath: string,
	ranges: LineRange[],
): Promise<void> {
	const diff = await gitRoot.diff(["--", relativePath]);
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
	gitRoot: ReturnType<typeof simpleGit>,
	relativePath: string,
	ranges: LineRange[],
): Promise<void> {
	const diff = await gitRoot.diff(["--cached", "--", relativePath]);
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

	const gitRoot = simpleGit(toplevel);
	const relativePath = path.relative(toplevel, resolved);
	try {
		if (action === "stage") {
			if (ranges !== null) {
				// Line-level staging: an empty selection or one that touches no
				// change stages nothing, falling through to the current status.
				if (ranges.length > 0) {
					await applyPartialStage(gitRoot, relativePath, ranges);
				}
			} else {
				// `git add` stages additions, modifications, and deletions alike.
				await gitRoot.raw(["add", "--", relativePath]);
			}
		} else {
			if (ranges !== null) {
				// Line-level unstaging: an empty selection or one that touches no
				// staged change unstages nothing, falling through to the current
				// status.
				if (ranges.length > 0) {
					await applyPartialUnstage(gitRoot, relativePath, ranges);
				}
			} else {
				// A plain reset (no explicit HEAD) unstages the path whether or not
				// the repo has any commits yet; `reset HEAD` would fail before the
				// first commit.
				await gitRoot.raw(["reset", "-q", "--", relativePath]);
			}
		}
	} catch (err) {
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

	// POST /api/git/stage?repo=<name>  body: { path, ranges? }
	router.post("/stage", async (req, res) => {
		await handleStageAction(roots, req, res, "stage");
	});

	// POST /api/git/unstage?repo=<name>  body: { path }
	router.post("/unstage", async (req, res) => {
		await handleStageAction(roots, req, res, "unstage");
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
			const gitRoot = simpleGit(toplevel);
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

	// GET /api/git/diff?repo=<name>&path=<file>&staged=<bool>
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
			const gitRoot = simpleGit(toplevel);
			// Unstaged edits are compared against the index, matching what
			// `git diff` reports; staged edits are compared against HEAD. A
			// file added but not yet committed has no HEAD version at all.
			const staged = req.query.staged === "true";
			const revision = staged ? `HEAD:${relativePath}` : `:${relativePath}`;
			const content = await gitRoot.raw(["show", revision]);
			res.type("text/plain").send(content);
		} catch {
			res.status(404).json({
				error: { code: "NOT_FOUND", message: "Base file not found" },
			});
		}
	});

	// GET /api/git/diff?repo=<name>&path=<file>&staged=<bool>
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
		const gitRoot = simpleGit(toplevel);
		const relativePath = path.relative(toplevel, resolved);
		const diffArgs = staged
			? ["--cached", "--", relativePath]
			: ["--", relativePath];
		const diff = await gitRoot.diff(diffArgs);

		if (diff.length > MAX_DIFF_SIZE) {
			res.json({
				diff: diff.slice(0, MAX_DIFF_SIZE),
				truncated: true,
			});
			return;
		}

		res.json({ diff, truncated: false });
	});

	return router;
}
