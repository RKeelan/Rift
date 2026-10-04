// Chunk filenames are hashed, so a redeploy removes the chunks an already-open
// page still wants. Reloading fetches the current build, which knows the new
// names. The timestamp stops a chunk that is genuinely missing from looping.
const RELOAD_KEY = "rift:stale-chunk-reload";
export const RELOAD_GUARD_MS = 10_000;

/**
 * Reloads the page unless it was already reloaded for this reason within
 * `RELOAD_GUARD_MS`. Returns whether a reload was started.
 */
export function reloadForStaleChunk(now: number = Date.now()): boolean {
	try {
		const last = Number(window.sessionStorage.getItem(RELOAD_KEY));
		if (Number.isFinite(last) && last > 0 && now - last < RELOAD_GUARD_MS) {
			return false;
		}
		window.sessionStorage.setItem(RELOAD_KEY, String(now));
	} catch {
		// Without storage the loop guard is unavailable, so do not reload.
		return false;
	}
	window.location.reload();
	return true;
}

/**
 * Whether `cause` is the browser's report of a failed dynamic import. The
 * wording differs by engine: Chromium, Firefox, and Safari respectively.
 */
export function isChunkLoadError(cause: unknown): boolean {
	if (!(cause instanceof Error)) return false;
	return /dynamically imported module|Importing a module script failed/i.test(
		cause.message,
	);
}

/**
 * Vite dispatches `vite:preloadError` when a lazy chunk or its CSS fails to
 * load. Imports with no dependencies skip Vite's preload helper and never
 * raise it, so callers that await such imports should also pass failures to
 * `isChunkLoadError` and `reloadForStaleChunk`.
 */
export function installStaleChunkReload(): void {
	window.addEventListener("vite:preloadError", (event) => {
		if (reloadForStaleChunk()) event.preventDefault();
	});
}
