import { useEffect, useSyncExternalStore } from "react";
import { preloadEditor } from "../components/TextFileEditor.tsx";

// Runs the callback once the browser is idle, and returns what cancels it.
// A browser that cannot tell when it is idle runs none, and so loads nothing
// ahead.
function whenIdle(callback: () => void): () => void {
	if (typeof globalThis.requestIdleCallback !== "function") return () => {};
	const handle = globalThis.requestIdleCallback(callback);
	return () => globalThis.cancelIdleCallback(handle);
}

function subscribeToVisibility(onChange: () => void) {
	document.addEventListener("visibilitychange", onChange);
	return () => document.removeEventListener("visibilitychange", onChange);
}

const pageVisible = () => document.visibilityState === "visible";

/**
 * Loads the editor's code, and the language support of the changed files,
 * once the browser is idle while the Files list is on screen and the page is
 * visible, so that the first file opened need not wait on loading either.
 * Each loads once, so a later status that lists a file of another language
 * loads only that language.
 */
export function useEditorPreload({
	changedPaths,
	idle,
}: {
	// The changed files' paths, one to a line.
	changedPaths: string;
	// Whether the list is on screen, drawn, with no file open over it.
	idle: boolean;
}) {
	const visible = useSyncExternalStore(subscribeToVisibility, pageVisible);
	useEffect(() => {
		if (!idle || !visible) return;
		return whenIdle(() => {
			void preloadEditor(changedPaths.split("\n"));
		});
	}, [changedPaths, idle, visible]);
}
