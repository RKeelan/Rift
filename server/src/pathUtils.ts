import fs from "node:fs/promises";
import path from "node:path";

/**
 * Resolves a user-supplied path against the working directory and rejects
 * any result that escapes it (e.g. `../`, absolute paths).
 *
 * Returns the resolved absolute path, or `null` if the path is forbidden.
 */
export function resolveSafePath(
	workingDir: string,
	requestedPath: string,
): string | null {
	const resolved = path.resolve(workingDir, requestedPath);
	if (!resolved.startsWith(workingDir + path.sep) && resolved !== workingDir) {
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
	const resolved = path.resolve(reposRoot, repoName);
	if (!resolved.startsWith(reposRoot + path.sep) && resolved !== reposRoot) {
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
