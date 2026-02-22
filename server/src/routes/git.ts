import path from "node:path";
import { Router } from "express";
import { simpleGit } from "simple-git";
import { resolveSafePath } from "../pathUtils.js";

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

export function gitRoutes(workingDir: string): Router {
	const router = Router();
	const git = simpleGit(workingDir);

	// GET /api/git/status
	router.get("/status", async (_req, res) => {
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

	// GET /api/git/diff?path=<file>&staged=<bool>
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
