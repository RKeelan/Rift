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
