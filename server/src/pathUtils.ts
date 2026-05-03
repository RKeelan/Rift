import fs from "node:fs/promises";
import path from "node:path";

// Returns realpath(p), or realpath of the deepest existing ancestor when p
// itself does not yet exist. Used so callers can validate symlink-resolved
// containment for paths that may not exist (e.g. files about to be written).
async function realpathOfNearest(p: string): Promise<string | null> {
	let current = p;
	while (true) {
		try {
			return await fs.realpath(current);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
			const parent = path.dirname(current);
			if (parent === current) return null;
			current = parent;
		}
	}
}

/**
 * Resolves a user-supplied path against the working directory and rejects
 * any result that escapes it (e.g. `../`, absolute paths, or symlinks that
 * point outside the working directory).
 *
 * Returns the resolved absolute path, or `null` if the path is forbidden.
 */
export async function resolveSafePath(
	workingDir: string,
	requestedPath: string,
): Promise<string | null> {
	const normalizedDir = path.resolve(workingDir);
	const resolved = path.resolve(normalizedDir, requestedPath);
	if (
		!resolved.startsWith(normalizedDir + path.sep) &&
		resolved !== normalizedDir
	) {
		return null;
	}

	const realDir = await realpathOfNearest(normalizedDir);
	const realResolved = await realpathOfNearest(resolved);
	if (!realDir || !realResolved) return null;
	if (
		!realResolved.startsWith(realDir + path.sep) &&
		realResolved !== realDir
	) {
		return null;
	}

	return resolved;
}

export type RepoResult =
	| { ok: true; path: string }
	| { ok: false; reason: "forbidden" | "not_found" };

/**
 * Resolves a repo name (relative path like "RKeelan/Rift") against `reposRoot`
 * and validates it. Rejects absolute paths, `..` segments, and names that
 * resolve outside the root.
 */
export async function resolveRepo(
	reposRoot: string,
	repoName: string,
): Promise<RepoResult> {
	if (!repoName || path.isAbsolute(repoName) || repoName.includes("..")) {
		return { ok: false, reason: "forbidden" };
	}
	const normalizedRoot = path.resolve(reposRoot);
	const resolved = path.resolve(normalizedRoot, repoName);
	if (
		!resolved.startsWith(normalizedRoot + path.sep) &&
		resolved !== normalizedRoot
	) {
		return { ok: false, reason: "forbidden" };
	}
	try {
		const stat = await fs.stat(resolved);
		if (!stat.isDirectory()) return { ok: false, reason: "not_found" };
	} catch {
		return { ok: false, reason: "not_found" };
	}
	return { ok: true, path: resolved };
}
