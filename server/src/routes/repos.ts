import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import type { RepoRoot } from "../pathUtils.js";

// Roots point directly at a directory of checkouts, so repos are immediate
// children. Staying at depth 1 keeps the scan off large non-repo trees such as
// photo or archive folders that may sit alongside them.
const MAX_DEPTH = 1;

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

export function repoRoutes(roots: RepoRoot[]): Router {
	const router = Router();

	// GET /api/repos
	router.get("/", async (_req, res) => {
		const perRoot = await Promise.all(
			roots.map(async (root) => {
				const found = await scanForRepos(root.path, root.path, 1);
				// Qualify with the root label and use forward slashes so names are
				// stable across platforms and safe to put in a URL.
				return found.map((repo) => ({
					name: `${root.label}/${repo.name.split(path.sep).join("/")}`,
					path: repo.path,
				}));
			}),
		);

		const repos = perRoot.flat();
		repos.sort((a, b) => a.name.localeCompare(b.name));
		res.json({ repos });
	});

	return router;
}
