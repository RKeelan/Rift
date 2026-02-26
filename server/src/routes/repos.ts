import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";

const MAX_DEPTH = 4;

interface RepoEntry {
	name: string;
	path: string;
}

async function scanForRepos(
	root: string,
	dir: string,
	depth: number,
): Promise<RepoEntry[]> {
	if (depth > MAX_DEPTH) return [];

	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		console.warn(`repos: skipping unreadable directory: ${dir}`, err);
		return [];
	}

	const repos: RepoEntry[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

		const fullPath = path.join(dir, entry.name);

		// Resolve symlinks to check if they point to directories
		let stat: import("node:fs").Stats;
		try {
			stat = await fs.stat(fullPath);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) continue;

		// Check if this directory contains .git (directory or file for worktrees/submodules)
		try {
			await fs.stat(path.join(fullPath, ".git"));
			repos.push({
				name: path.relative(root, fullPath),
				path: fullPath,
			});
			// Don't recurse into repos
			continue;
		} catch {
			// No .git entry — recurse deeper
		}

		const nested = await scanForRepos(root, fullPath, depth + 1);
		repos.push(...nested);
	}

	return repos;
}

export function repoRoutes(reposRoot: string): Router {
	const router = Router();

	// GET /api/repos
	router.get("/", async (_req, res) => {
		const repos = await scanForRepos(reposRoot, reposRoot, 1);
		repos.sort((a, b) => a.name.localeCompare(b.name));
		res.json({ repos });
	});

	return router;
}
