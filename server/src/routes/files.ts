import fs from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import { Router } from "express";
import {
	type RepoRoot,
	resolveRepoInRoots,
	resolveSafePath,
} from "../pathUtils.js";
import { repoGit } from "../repoGit.js";

const MAX_ENTRIES = 1000;
const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const BINARY_CHECK_SIZE = 8192; // 8 KB
const FILE_MTIME_HEADER = "x-file-mtime-ms";

interface DirEntry {
	name: string;
	type: "file" | "directory";
	size: number;
}

interface TextFileInfo {
	content: string;
	stat: Awaited<ReturnType<typeof fs.stat>>;
}

// A line of `git check-ignore --verbose --non-matching`: the ignore file,
// line number and pattern that matched the path, all empty when none did,
// then a tab and the path.
const CHECK_IGNORE_LINE = /^(.*?):(\d*):(.*)\t(.*)$/;

/**
 * The paths, of those given, that the repo's ignore rules leave out, or null
 * when the directory is not in a repository, where check-ignore fails.
 *
 * `--verbose --non-matching` has git print a line for every path, ignored or
 * not. Without them, check-ignore prints nothing for a folder that ignores
 * nothing, and simple-git waits a further 50 ms for a command that prints
 * nothing. A verbose line names any pattern that matched, including a
 * negated one, starting with "!", which keeps its path.
 */
async function getIgnoredPaths(
	workingDir: string,
	entries: string[],
): Promise<Set<string> | null> {
	if (entries.length === 0) return new Set();

	let output: string;
	try {
		output = await repoGit(workingDir).raw([
			"-c",
			"core.quotePath=false",
			"check-ignore",
			"--verbose",
			"--non-matching",
			"--",
			...entries,
		]);
	} catch {
		return null;
	}

	const ignored = new Set<string>();
	for (const line of output.split("\n")) {
		const match = CHECK_IGNORE_LINE.exec(line);
		if (!match) continue;
		const [, , , pattern, raw] = match;
		if (pattern === "" || pattern.startsWith("!")) continue;
		// Normalise to forward slashes so Windows backslashes match
		const entry = raw.replaceAll("\\", "/");
		// git may return paths with or without trailing slash;
		// add both forms so the filter matches regardless
		ignored.add(entry);
		if (entry.endsWith("/")) {
			ignored.add(entry.slice(0, -1));
		} else {
			ignored.add(`${entry}/`);
		}
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

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

async function startsWithBom(filePath: string): Promise<boolean> {
	const handle = await fs.open(filePath, "r");
	try {
		const buffer = Buffer.alloc(UTF8_BOM.length);
		const { bytesRead } = await handle.read(buffer, 0, UTF8_BOM.length, 0);
		return bytesRead === UTF8_BOM.length && buffer.equals(UTF8_BOM);
	} finally {
		await handle.close();
	}
}

async function requireRepo(
	roots: RepoRoot[],
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
	return result.path;
}

function isNotFoundError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err && err.code === "ENOENT";
}

async function readTextFile(
	resolved: string,
	res: Response,
): Promise<TextFileInfo | null> {
	try {
		const stat = await fs.stat(resolved);

		if (stat.isDirectory()) {
			res.status(400).json({
				error: {
					code: "IS_DIRECTORY",
					message: "The specified path is a directory, not a file",
				},
			});
			return null;
		}

		if (stat.size > MAX_FILE_SIZE) {
			res.status(413).json({
				error: {
					code: "FILE_TOO_LARGE",
					message: `File exceeds maximum size of ${MAX_FILE_SIZE / (1024 * 1024)} MB`,
				},
			});
			return null;
		}

		if (await isBinaryFile(resolved)) {
			res.status(415).json({
				error: {
					code: "BINARY_FILE",
					message: "Binary files are not supported",
				},
			});
			return null;
		}

		const content = await fs.readFile(resolved, "utf-8");
		return { content, stat };
	} catch (err) {
		if (isNotFoundError(err)) {
			res.status(404).json({
				error: { code: "NOT_FOUND", message: "File not found" },
			});
			return null;
		}
		throw err;
	}
}

export function fileRoutes(roots: RepoRoot[]): Router {
	const router = Router();

	// GET /api/files?repo=<name>&path=<dir>
	router.get("/", async (req, res) => {
		const workingDir = await requireRepo(roots, req, res);
		if (!workingDir) return;

		const requestedPath = (req.query.path as string) || ".";
		const resolved = await resolveSafePath(workingDir, requestedPath);

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
				// Normalise to forward slashes so git check-ignore matches on Windows
				const relPath = path
					.relative(workingDir, entryPath)
					.replaceAll("\\", "/");
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

			// In a git repo, leave out what it ignores, and git's own .git,
			// which it never tracks
			const ignored = await getIgnoredPaths(workingDir, relativePaths);
			if (ignored) {
				entries = entries.filter(
					(entry, i) => entry.name !== ".git" && !ignored.has(relativePaths[i]),
				);
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
		const workingDir = await requireRepo(roots, req, res);
		if (!workingDir) return;

		const requestedPath = req.query.path as string;
		if (!requestedPath) {
			res.status(400).json({
				error: { code: "MISSING_PATH", message: "path parameter is required" },
			});
			return;
		}

		const resolved = await resolveSafePath(workingDir, requestedPath);

		if (!resolved) {
			res.status(403).json({
				error: {
					code: "PATH_FORBIDDEN",
					message: "Path escapes the working directory",
				},
			});
			return;
		}

		const fileInfo = await readTextFile(resolved, res);
		if (!fileInfo) return;

		res.setHeader(FILE_MTIME_HEADER, String(fileInfo.stat.mtimeMs));
		res.type("text/plain").send(fileInfo.content);
	});

	// PUT /api/files/content?repo=<name>&path=<file>
	router.put("/content", async (req, res) => {
		const workingDir = await requireRepo(roots, req, res);
		if (!workingDir) return;

		const requestedPath = req.query.path as string;
		if (!requestedPath) {
			res.status(400).json({
				error: { code: "MISSING_PATH", message: "path parameter is required" },
			});
			return;
		}

		const { content, expectedMtimeMs } = req.body ?? {};
		if (typeof content !== "string") {
			res.status(400).json({
				error: {
					code: "INVALID_CONTENT",
					message: "content must be a string",
				},
			});
			return;
		}

		if (
			typeof expectedMtimeMs !== "number" ||
			!Number.isFinite(expectedMtimeMs)
		) {
			res.status(400).json({
				error: {
					code: "INVALID_MTIME",
					message: "expectedMtimeMs must be a number",
				},
			});
			return;
		}

		if (Buffer.byteLength(content, "utf-8") > MAX_FILE_SIZE) {
			res.status(413).json({
				error: {
					code: "FILE_TOO_LARGE",
					message: `File exceeds maximum size of ${MAX_FILE_SIZE / (1024 * 1024)} MB`,
				},
			});
			return;
		}

		const resolved = await resolveSafePath(workingDir, requestedPath);

		if (!resolved) {
			res.status(403).json({
				error: {
					code: "PATH_FORBIDDEN",
					message: "Path escapes the working directory",
				},
			});
			return;
		}

		const fileInfo = await readTextFile(resolved, res);
		if (!fileInfo) return;

		if (fileInfo.stat.mtimeMs !== expectedMtimeMs) {
			res.status(409).json({
				error: {
					code: "FILE_MODIFIED",
					message: "File changed on disk since it was loaded",
				},
			});
			return;
		}

		// The client's fetch() strips a leading BOM, so restore it when the
		// file on disk had one.
		const toWrite =
			!content.startsWith("\uFEFF") && (await startsWithBom(resolved))
				? `\uFEFF${content}`
				: content;

		await fs.writeFile(resolved, toWrite, "utf-8");
		const updatedStat = await fs.stat(resolved);
		res.json({ mtimeMs: updatedStat.mtimeMs });
	});

	return router;
}
