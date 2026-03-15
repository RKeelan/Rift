import path from "node:path";
import type { Request, Response } from "express";
import { Router } from "express";
import { simpleGit } from "simple-git";
import { resolveRepo, resolveSafePath } from "../pathUtils.js";

const MAX_DIFF_SIZE = 1024 * 1024; // 1 MB

type FileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

interface StatusEntry {
	path: string;
	status: FileStatus;
	staged: boolean;
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

async function resolveGitRepo(
	reposRoot: string,
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
	const result = await resolveRepo(reposRoot, repoName);
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

export function gitRoutes(reposRoot: string): Router {
	const router = Router();

	// GET /api/git/status?repo=<name>
	router.get("/status", async (req, res) => {
		const git = await resolveGitRepo(reposRoot, req, res);
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
		const entries: StatusEntry[] = [];

		for (const file of status.files) {
			const index = file.index;
			const working = file.working_dir;

			// Staged change
			const stagedStatus = mapIndexStatus(index);
			if (stagedStatus) {
				entries.push({
					path: file.path,
					status: stagedStatus,
					staged: true,
				});
			}

			// Unstaged change
			const unstagedStatus = mapWorkingTreeStatus(working);
			if (unstagedStatus) {
				entries.push({
					path: file.path,
					status: unstagedStatus,
					staged: false,
				});
			}
		}

		res.json({ files: entries });
	});

	// GET /api/git/log?repo=<name>&limit=<n>&offset=<n>
	router.get("/log", async (req, res) => {
		const git = await resolveGitRepo(reposRoot, req, res);
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

		const git = await resolveGitRepo(reposRoot, req, res);
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

		const git = await resolveGitRepo(reposRoot, req, res);
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
		const resolved = resolveSafePath(toplevel, filePath);
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

		const git = await resolveGitRepo(reposRoot, req, res);
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
		const resolved = resolveSafePath(toplevel, filePath);
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
			const revision = `HEAD:${relativePath}`;
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

		const git = await resolveGitRepo(reposRoot, req, res);
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
		const resolved = resolveSafePath(toplevel, filePath);
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
