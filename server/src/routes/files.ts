import fs from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import { Router } from "express";
import { simpleGit } from "simple-git";
import { resolveRepo, resolveSafePath } from "../pathUtils.js";

const MAX_ENTRIES = 1000;
const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const BINARY_CHECK_SIZE = 8192; // 8 KB

interface DirEntry {
	name: string;
	type: "file" | "directory";
	size: number;
}

async function isGitRepo(dir: string): Promise<boolean> {
	try {
		const git = simpleGit(dir);
		return await git.checkIsRepo();
	} catch {
		return false;
	}
}

async function getIgnoredPaths(
	workingDir: string,
	entries: string[],
): Promise<Set<string>> {
	const git = simpleGit(workingDir);
	const ignored = new Set<string>();

	if (entries.length === 0) return ignored;

	try {
		const result = await git.checkIgnore(entries);
		for (const entry of result) {
			// git may return paths with or without trailing slash;
			// add both forms so the filter matches regardless
			ignored.add(entry);
			if (entry.endsWith("/")) {
				ignored.add(entry.slice(0, -1));
			} else {
				ignored.add(`${entry}/`);
			}
		}
	} catch {
		// If git check-ignore fails, treat nothing as ignored
	}

	return ignored;
}

async function isBinaryFile(filePath: string): Promise<boolean> {
	const handle = await fs.open(filePath, "r");
	try {
		const buffer = Buffer.alloc(BINARY_CHECK_SIZE);
		const { bytesRead } = await handle.read(buffer, 0, BINARY_CHECK_SIZE, 0);
		for (let i = 0; i < bytesRead; i++) {
			if (buffer[i] === 0) return true;
		}
		return false;
	} finally {
		await handle.close();
	}
}

async function requireRepo(
	reposRoot: string,
	req: Request,
	res: Response,
): Promise<string | null> {
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
	return result.path;
}

export function fileRoutes(reposRoot: string): Router {
	const router = Router();

	// GET /api/files?repo=<name>&path=<dir>
	router.get("/", async (req, res) => {
		const workingDir = await requireRepo(reposRoot, req, res);
		if (!workingDir) return;

		const requestedPath = (req.query.path as string) || ".";
		const resolved = resolveSafePath(workingDir, requestedPath);

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
			const stat = await fs.stat(resolved);
			if (!stat.isDirectory()) {
				res.status(400).json({
					error: {
						code: "NOT_A_DIRECTORY",
						message: "The specified path is not a directory",
					},
				});
				return;
			}

			const dirents = await fs.readdir(resolved, { withFileTypes: true });

			// Filter to only files and directories, build entries
			let entries: DirEntry[] = [];
			const relativePaths: string[] = [];

			for (const dirent of dirents) {
				if (!dirent.isFile() && !dirent.isDirectory()) continue;

				const entryType = dirent.isDirectory() ? "directory" : "file";
				const entryPath = path.join(resolved, dirent.name);

				// Build relative path from working dir for gitignore check
				const relPath = path.relative(workingDir, entryPath);
				relativePaths.push(entryType === "directory" ? `${relPath}/` : relPath);

				let size = 0;
				if (dirent.isFile()) {
					try {
						const fileStat = await fs.stat(entryPath);
						size = fileStat.size;
					} catch {
						// Skip files we can't stat
						continue;
					}
				}

				entries.push({ name: dirent.name, type: entryType, size });
			}

			// Filter by gitignore if in a git repo
			if (await isGitRepo(workingDir)) {
				const ignored = await getIgnoredPaths(workingDir, relativePaths);
				entries = entries.filter((_entry, i) => !ignored.has(relativePaths[i]));
			}

			// Sort: directories first, then alphabetically
			entries.sort((a, b) => {
				if (a.type !== b.type) {
					return a.type === "directory" ? -1 : 1;
				}
				return a.name.localeCompare(b.name);
			});

			// Truncate if needed
			const truncated = entries.length > MAX_ENTRIES;
			if (truncated) {
				entries = entries.slice(0, MAX_ENTRIES);
			}

			res.json({ entries, truncated });
		} catch (err) {
			if (
				err instanceof Error &&
				"code" in err &&
				(err as NodeJS.ErrnoException).code === "ENOENT"
			) {
				res.status(404).json({
					error: { code: "NOT_FOUND", message: "Directory not found" },
				});
				return;
			}
			throw err;
		}
	});

	// GET /api/files/content?repo=<name>&path=<file>
	router.get("/content", async (req, res) => {
		const workingDir = await requireRepo(reposRoot, req, res);
		if (!workingDir) return;

		const requestedPath = req.query.path as string;
		if (!requestedPath) {
			res.status(400).json({
				error: { code: "MISSING_PATH", message: "path parameter is required" },
			});
			return;
		}

		const resolved = resolveSafePath(workingDir, requestedPath);

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
			const stat = await fs.stat(resolved);

			if (stat.isDirectory()) {
				res.status(400).json({
					error: {
						code: "IS_DIRECTORY",
						message: "The specified path is a directory, not a file",
					},
				});
				return;
			}

			if (stat.size > MAX_FILE_SIZE) {
				res.status(413).json({
					error: {
						code: "FILE_TOO_LARGE",
						message: `File exceeds maximum size of ${MAX_FILE_SIZE / (1024 * 1024)} MB`,
					},
				});
				return;
			}

			if (await isBinaryFile(resolved)) {
				res.status(415).json({
					error: {
						code: "BINARY_FILE",
						message: "Binary files are not supported",
					},
				});
				return;
			}

			const content = await fs.readFile(resolved, "utf-8");
			res.type("text/plain").send(content);
		} catch (err) {
			if (
				err instanceof Error &&
				"code" in err &&
				(err as NodeJS.ErrnoException).code === "ENOENT"
			) {
				res.status(404).json({
					error: { code: "NOT_FOUND", message: "File not found" },
				});
				return;
			}
			throw err;
		}
	});

	return router;
}
