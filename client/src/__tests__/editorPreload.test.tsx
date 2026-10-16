import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ErrorBannerProvider } from "../components/ErrorBanner.tsx";
import { preloadEditor } from "../components/TextFileEditor.tsx";
import { SessionProvider, useSession } from "../contexts/SessionContext.tsx";
import { FilesPage } from "../pages/FilesPage.tsx";

const originalFetch = globalThis.fetch;

// The page's idle callbacks, which each test runs as the browser would once
// it is idle.
const idleCallbacks = new Map<number, () => void>();
let nextIdle = 1;
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
	idleCallbacks.clear();
	globalThis.requestIdleCallback = ((callback: IdleRequestCallback) => {
		const handle = nextIdle++;
		idleCallbacks.set(handle, () =>
			callback({ didTimeout: false, timeRemaining: () => 50 }),
		);
		return handle;
	}) as typeof requestIdleCallback;
	globalThis.cancelIdleCallback = (handle: number) => {
		idleCallbacks.delete(handle);
	};
	visibility = "visible";
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		get: () => visibility,
	});
});

afterEach(() => {
	cleanup();
	globalThis.fetch = originalFetch;
	globalThis.localStorage.clear();
	const idle = globalThis as Partial<typeof globalThis>;
	delete idle.requestIdleCallback;
	delete idle.cancelIdleCallback;
	visibility = "visible";
});

function json(body: unknown) {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * Serves a status listing each path given as modified and unstaged, and an
 * empty folder, and answers anything a file opened over the list asks for.
 * Returns how many times the status has been read.
 */
function serve(paths: string[]) {
	const reads = { status: 0 };
	globalThis.fetch = mock(async (input: string | URL | Request) => {
		const { pathname } = new URL(String(input), "http://localhost");
		if (pathname.endsWith("/api/git/status")) {
			reads.status += 1;
			return json({
				files: paths.map((path) => ({
					path,
					status: "modified",
					staged: false,
				})),
			});
		}
		if (pathname.endsWith("/api/files")) {
			return json({ entries: [], truncated: false });
		}
		if (pathname.endsWith("/api/git/open")) {
			return json({
				file: { content: "x\n", mtimeMs: 1 },
				index: { content: "y\n" },
				unstagedDiff: { diff: "@@ -1 +1 @@\n-y\n+x\n", truncated: false },
			});
		}
		return json({});
	}) as unknown as typeof fetch;
	return reads;
}

function SelectRepo({ children }: { children: React.ReactNode }) {
	const { selectRepo } = useSession();
	useEffect(() => {
		selectRepo("test-repo");
	}, [selectRepo]);
	return <>{children}</>;
}

function page(hidden: boolean, initialEntry = "/files") {
	return (
		<MemoryRouter initialEntries={[initialEntry]}>
			<ErrorBannerProvider>
				<SessionProvider>
					<Routes>
						<Route
							path="/files"
							element={
								<SelectRepo>
									<FilesPage hidden={hidden} writesAllowed />
								</SelectRepo>
							}
						/>
					</Routes>
				</SessionProvider>
			</ErrorBannerProvider>
		</MemoryRouter>
	);
}

async function renderPage(hidden = false, initialEntry = "/files") {
	globalThis.localStorage.setItem("rift:selected-repo", "test-repo");
	const result = render(page(hidden, initialEntry));
	await waitFor(() => {
		expect(result.container.querySelector(".changes-file-row") !== null).toBe(
			true,
		);
	});
	return result;
}

// Lets anything the page was about to schedule be scheduled.
async function settle() {
	await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
}

async function runIdle() {
	const callbacks = [...idleCallbacks.values()];
	idleCallbacks.clear();
	await act(async () => {
		for (const callback of callbacks) callback();
	});
	return callbacks.length;
}

describe("loading the editor's code ahead", () => {
	test("loads the editor's code and the changed files' languages once the list is idle", async () => {
		serve(["main.go", "styles/site.scss", "Makefile"]);
		await renderPage();
		await settle();
		// Nothing loads before the browser is idle: Go's support is still
		// there for another caller to load.
		expect(await preloadEditor(["other.go"])).toContain("go");
		expect(await runIdle()).toBe(1);
		// SCSS's has been loaded, or is loading, already.
		expect(await preloadEditor(["theme.scss"])).toEqual([]);
	});

	test("asks once, and not again for a status that lists the same files", async () => {
		const reads = serve(["main.py"]);
		await renderPage();
		await settle();
		expect(await runIdle()).toBe(1);

		const before = reads.status;
		await act(async () => {
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await waitFor(() => {
			expect(reads.status).toBe(before + 1);
		});
		await settle();
		expect(idleCallbacks.size).toBe(0);
	});

	test("loads nothing while the list is hidden behind another tab", async () => {
		serve(["page.html"]);
		const { rerender } = await renderPage(true);
		await settle();
		expect(idleCallbacks.size).toBe(0);

		rerender(page(false));
		await settle();
		expect(await runIdle()).toBe(1);
		expect(await preloadEditor(["index.html"])).toEqual([]);
	});

	test("loads nothing while a file is open over the list, or the page is hidden", async () => {
		serve(["app.json"]);
		globalThis.localStorage.setItem("rift:selected-repo", "test-repo");
		const { container } = render(
			page(false, "/files?path=app.json&staged=false"),
		);
		await waitFor(() => {
			expect(container.querySelector(".changes-diff-view") !== null).toBe(true);
		});
		await settle();
		expect(idleCallbacks.size).toBe(0);

		cleanup();
		visibility = "hidden";
		await renderPage();
		await settle();
		expect(idleCallbacks.size).toBe(0);

		await act(async () => {
			visibility = "visible";
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await settle();
		expect(await runIdle()).toBe(1);
	});

	test("stops waiting for idle once a file opens", async () => {
		serve(["script.sh"]);
		const { container } = await renderPage();
		await settle();
		expect(idleCallbacks.size).toBe(1);

		const row = container.querySelector(".changes-file-entry");
		await act(async () => {
			(row as HTMLElement).click();
		});
		await settle();
		expect(idleCallbacks.size).toBe(0);
	});
});

describe("preloadEditor", () => {
	test("loads the editor's code and each language once", async () => {
		const first = await preloadEditor(["lib.rs", "main.rs", "Makefile"]);
		expect(first).toContain("rs");
		expect(first.filter((name) => name === "rs")).toHaveLength(1);
		expect(first).not.toContain("makefile");
		expect(await preloadEditor(["lib.rs"])).toEqual([]);
	});
});
