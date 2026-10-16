import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	act,
	cleanup,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ErrorBannerProvider } from "../components/ErrorBanner.tsx";
import { SessionProvider, useSession } from "../contexts/SessionContext.tsx";
import { hashText, writeDraft } from "../drafts.ts";
import { openFile, useChangeContext } from "../pages/FileSideView.tsx";
import { FilesPage } from "../pages/FilesPage.tsx";

const originalFetch = globalThis.fetch;

afterEach(() => {
	cleanup();
	globalThis.fetch = originalFetch;
	globalThis.localStorage.clear();
});

// A file of the scratch repository: its text in the working tree, the index
// and HEAD, each left out where git has none, and git's diffs of it.
interface FileModel {
	working?: string;
	index?: string;
	head?: string;
	unstagedDiff?: string;
	stagedDiff?: string;
	untrackedDiff?: string;
	// git's diff of the working tree once a save has added a first line.
	savedDiff?: string;
}

const REPO: Record<string, FileModel> = {
	"modified.txt": {
		working: "a\nB\nc\nd\ne\n",
		index: "a\nb\nc\nd\ne\n",
		head: "a\nb\nc\nd\ne\n",
		unstagedDiff: "@@ -1,5 +1,5 @@\n a\n-b\n+B\n c\n d\n e\n",
		savedDiff: "@@ -1,5 +1,6 @@\n+X\n a\n-b\n+B\n c\n d\n e\n",
	},
	"both.txt": {
		working: "a\nB\nc\nD\ne\n",
		index: "a\nB\nc\nd\ne\n",
		head: "a\nb\nc\nd\ne\n",
		unstagedDiff: "@@ -1,5 +1,5 @@\n a\n B\n c\n-d\n+D\n e\n",
		stagedDiff: "@@ -1,5 +1,5 @@\n a\n-b\n+B\n c\n d\n e\n",
	},
	"untracked.txt": {
		working: "x\ny\n",
		untrackedDiff: "@@ -0,0 +1,2 @@\n+x\n+y\n",
	},
	"gone.txt": { index: "g\nh\n", head: "g\nh\n" },
	"removed.txt": { working: "r\ns\n", head: "r\ns\n" },
	"added.txt": {
		working: "n\nm\n",
		index: "n\nm\n",
		stagedDiff: "@@ -0,0 +1,2 @@\n+n\n+m\n",
	},
	"unchanged.txt": { working: "u\nv\n", index: "u\nv\n", head: "u\nv\n" },
};

const STATUS = [
	{ path: "both.txt", status: "modified", staged: true },
	{ path: "removed.txt", status: "deleted", staged: true },
	{ path: "added.txt", status: "added", staged: true },
	{ path: "modified.txt", status: "modified", staged: false },
	{ path: "both.txt", status: "modified", staged: false },
	{ path: "gone.txt", status: "deleted", staged: false },
	{ path: "untracked.txt", status: "untracked", staged: false },
];

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const notFound = (message: string) => ({
	status: 404,
	error: { code: "NOT_FOUND", message },
});

// The open request's answer, each part as its endpoint would give it.
function openAnswer(model: FileModel, parts: string[], untracked: boolean) {
	const copy = (text: string | undefined) =>
		text === undefined ? notFound("Base file not found") : { content: text };
	const answer: Record<string, unknown> = {};
	for (const part of parts) {
		if (part === "file") {
			answer.file =
				model.working === undefined
					? notFound("File not found")
					: { content: model.working, mtimeMs: 1 };
		} else if (part === "unstagedDiff") {
			answer.unstagedDiff = untracked
				? { diff: model.untrackedDiff ?? "", truncated: false, exact: true }
				: { diff: model.unstagedDiff ?? "", truncated: false };
		} else if (part === "stagedDiff") {
			answer.stagedDiff = { diff: model.stagedDiff ?? "", truncated: false };
		} else if (part === "index" || part === "head") {
			answer[part] = copy(model[part]);
		}
	}
	return answer;
}

/**
 * Serves the repository: the status, the tree's top folder, the open
 * request, and the endpoints that read each part alone. `requests` gathers
 * every request but the status and the folder listings, and `aborted` those
 * the page stopped. With `refuseOpen`, the server refuses the open request
 * whole, as one without it does. With `openAfterMs`, it answers the open
 * request that long after it arrives, never if it is Infinity, and it never
 * answers a request to an endpoint `hang` names.
 */
function serve({
	refuseOpen = false,
	openAfterMs = 0,
	hang = [] as string[],
} = {}) {
	const requests: string[] = [];
	const aborted: string[] = [];
	// Holds a request back for the time given, or for good, until the page
	// stops it.
	const after = (url: string, ms: number, signal?: AbortSignal | null) =>
		new Promise<void>((resolve, reject) => {
			if (ms !== Number.POSITIVE_INFINITY) setTimeout(resolve, ms);
			signal?.addEventListener("abort", () => {
				aborted.push(url);
				reject(new DOMException("The request was stopped", "AbortError"));
			});
		});
	globalThis.fetch = mock(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const { pathname, searchParams } = new URL(url, "http://localhost");
			if (pathname.endsWith("/api/git/status")) return json({ files: STATUS });
			if (pathname.endsWith("/api/files")) {
				return json({
					entries: Object.keys(REPO).map((name) => ({
						name,
						type: "file",
						size: 1,
					})),
					truncated: false,
				});
			}
			requests.push(url);
			const model = REPO[searchParams.get("path") ?? ""] ?? {};
			const staged = searchParams.get("staged") === "true";
			if (hang.some((endpoint) => pathname.endsWith(endpoint))) {
				await after(url, Number.POSITIVE_INFINITY, init?.signal);
			}
			if (pathname.endsWith("/api/git/open")) {
				if (openAfterMs > 0) await after(url, openAfterMs, init?.signal);
				if (refuseOpen) {
					return json(
						{ error: { code: "NOT_FOUND", message: "Endpoint not found" } },
						404,
					);
				}
				return json(
					openAnswer(
						model,
						(searchParams.get("parts") ?? "").split(","),
						searchParams.get("untracked") === "true",
					),
				);
			}
			if (pathname.endsWith("/api/files/content") && init?.method === "PUT") {
				// A save answers with the repo's changes and the working tree's
				// new diff.
				return json({
					mtimeMs: 2,
					files: STATUS,
					context: {
						unstagedDiff: { diff: model.savedDiff ?? "", truncated: false },
					},
				});
			}
			if (pathname.endsWith("/api/files/content")) {
				return model.working === undefined
					? json({ error: notFound("File not found").error }, 404)
					: new Response(model.working, {
							headers: { "x-file-mtime-ms": "1" },
						});
			}
			if (pathname.endsWith("/api/git/base-content")) {
				const text = staged ? model.head : model.index;
				return text === undefined
					? json({ error: notFound("Base file not found").error }, 404)
					: new Response(text);
			}
			if (pathname.endsWith("/api/git/diff")) {
				const diff =
					searchParams.get("untracked") === "true"
						? model.untrackedDiff
						: staged
							? model.stagedDiff
							: model.unstagedDiff;
				return json({ diff: diff ?? "", truncated: false });
			}
			return json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
		},
	) as unknown as typeof fetch;
	return Object.assign(requests, { aborted });
}

function SelectRepo({ children }: { children: React.ReactNode }) {
	const { selectRepo } = useSession();
	useEffect(() => {
		selectRepo("test-repo");
	}, [selectRepo]);
	return <>{children}</>;
}

function renderPage(writesAllowed = true) {
	globalThis.localStorage.setItem("rift:selected-repo", "test-repo");
	return render(
		<MemoryRouter initialEntries={["/files"]}>
			<ErrorBannerProvider>
				<SessionProvider>
					<Routes>
						<Route
							path="/files"
							element={
								<SelectRepo>
									<FilesPage writesAllowed={writesAllowed} />
								</SelectRepo>
							}
						/>
					</Routes>
				</SessionProvider>
			</ErrorBannerProvider>
		</MemoryRouter>,
	);
}

// The side of the open file on screen.
function shownSide(container: HTMLElement) {
	const side = container.querySelector<HTMLElement>(
		".changes-editor-view:not(.changes-editor-view--hidden)",
	);
	if (!side) throw new Error("no side on screen");
	return side;
}

// The text of the editor on screen, its changes, and the line its cursor
// is on, which the view moves to the first change as it opens.
async function shown(container: HTMLElement) {
	const side = shownSide(container);
	const editor = side.querySelector(".cm-editor");
	if (!editor) return null;
	const { EditorView } = await import("@codemirror/view");
	const view = EditorView.findFromDOM(editor as HTMLElement);
	if (!view) return null;
	return {
		text: view.state.doc.toString(),
		waiting:
			side
				.querySelector(".text-file-editor-surface")
				?.classList.contains("text-file-editor-surface--waiting") ?? false,
		changedLines: side.querySelectorAll(".cm-changedLine").length,
		deletedChunks: side.querySelectorAll(".cm-deletedChunk").length,
		strips: side.querySelectorAll(".cm-changeStrip").length,
		cursorLine: view.state.doc.lineAt(view.state.selection.main.head).number,
	};
}

async function openFromList(
	container: HTMLElement,
	path: string,
	staged: boolean,
) {
	await waitFor(() => {
		expect(
			container.querySelector(
				`[aria-label="${staged ? "Unstage" : "Stage"} ${path}"]`,
			),
		).not.toBeNull();
	});
	const row = container
		.querySelector(`[aria-label="${staged ? "Unstage" : "Stage"} ${path}"]`)
		?.closest(".changes-file-row")
		?.querySelector(".changes-file-entry");
	fireEvent.click(row as Element);
}

function openRequests(requests: string[]) {
	return requests.map((url) => {
		const { pathname, searchParams } = new URL(url, "http://localhost");
		return {
			endpoint: pathname,
			path: searchParams.get("path"),
			parts: searchParams.get("parts"),
			untracked: searchParams.get("untracked"),
		};
	});
}

describe("opening a file", () => {
	const kinds = [
		{
			kind: "a file with unstaged changes",
			path: "modified.txt",
			staged: false,
			parts: "file,index,unstagedDiff",
			untracked: null,
			text: "a\nB\nc\nd\ne\n",
			drawn: { deletedChunks: 1, strips: 1 },
			cursorLine: 2,
		},
		{
			kind: "an untracked file",
			path: "untracked.txt",
			staged: false,
			parts: "file,unstagedDiff",
			untracked: "true",
			text: "x\ny\n",
			drawn: { deletedChunks: 0, strips: 1 },
			cursorLine: 1,
		},
		{
			kind: "a file deleted in the working tree",
			path: "gone.txt",
			staged: false,
			parts: "index",
			untracked: null,
			text: "g\nh\n",
			drawn: { deletedChunks: 0, strips: 0 },
			cursorLine: 1,
		},
		{
			kind: "a staged deletion",
			path: "removed.txt",
			staged: true,
			parts: "head",
			untracked: null,
			text: "r\ns\n",
			drawn: { deletedChunks: 0, strips: 0 },
			cursorLine: 1,
		},
		{
			kind: "a new file, staged",
			path: "added.txt",
			staged: true,
			parts: "index,head,stagedDiff",
			untracked: null,
			text: "n\nm\n",
			drawn: { deletedChunks: 0, strips: 1 },
			cursorLine: 1,
		},
	];

	for (const {
		kind,
		path,
		staged,
		parts,
		untracked,
		text,
		drawn,
		cursorLine,
	} of kinds) {
		test(`sends one request for ${kind}, and draws the file from it`, async () => {
			const requests = serve();
			const { container } = renderPage();
			await openFromList(container, path, staged);

			await waitFor(async () => {
				const side = await shown(container);
				expect(side?.text).toBe(text);
				expect(side?.waiting).toBe(false);
				expect(side?.changedLines).toBeGreaterThan(0);
			});
			const side = await shown(container);
			expect(side).toMatchObject({ ...drawn, cursorLine });
			expect(openRequests(requests)).toEqual([
				{ endpoint: "/api/git/open", path, parts, untracked },
			]);
		});
	}

	test("sends one request for both sides of a file with staged and unstaged changes", async () => {
		const requests = serve();
		const { container } = renderPage();
		await openFromList(container, "both.txt", false);

		await waitFor(async () => {
			const side = await shown(container);
			expect(side?.text).toBe("a\nB\nc\nD\ne\n");
			expect(side?.waiting).toBe(false);
			expect(side?.strips).toBe(1);
		});
		expect((await shown(container))?.cursorLine).toBe(4);

		// The staged side is built behind it from the same answer, and shows
		// the index's text with the staged change.
		fireEvent.click(
			within(shownSide(container)).getByRole("button", {
				name: /both\.txt/,
			}),
		);
		await waitFor(async () => {
			const side = await shown(container);
			expect(side?.text).toBe("a\nB\nc\nd\ne\n");
			expect(side?.waiting).toBe(false);
			expect(side?.deletedChunks).toBe(1);
			expect(side?.strips).toBe(1);
		});
		expect((await shown(container))?.cursorLine).toBe(2);
		expect(openRequests(requests)).toEqual([
			{
				endpoint: "/api/git/open",
				path: "both.txt",
				parts: "file,index,unstagedDiff,head,stagedDiff",
				untracked: null,
			},
		]);
	});

	test("sends one request for an unchanged file opened from the tree", async () => {
		const requests = serve();
		const { container } = renderPage();
		await waitFor(() => {
			expect(screen.getByText("unchanged.txt")).not.toBeNull();
		});
		fireEvent.click(screen.getByText("unchanged.txt"));

		await waitFor(async () => {
			const side = await shown(container);
			expect(side?.text).toBe("u\nv\n");
			expect(side?.waiting).toBe(false);
		});
		expect(await shown(container)).toMatchObject({
			changedLines: 0,
			strips: 0,
		});
		expect(openRequests(requests)).toEqual([
			{
				endpoint: "/api/git/open",
				path: "unchanged.txt",
				parts: "file,index,unstagedDiff",
				untracked: null,
			},
		]);
	});

	test("offers a draft left from earlier, from the text the request read", async () => {
		writeDraft("test-repo", "modified.txt", {
			text: "a\nB\nc\nd\ne\nf\n",
			baseHash: hashText("a\nB\nc\nd\ne\n"),
		});
		const requests = serve();
		const { container } = renderPage();
		await openFromList(container, "modified.txt", false);

		await waitFor(() => {
			expect(
				screen.getByText(
					"Unsaved edits from earlier are kept for this file. Restore or discard them to keep editing.",
				),
			).not.toBeNull();
		});
		fireEvent.click(screen.getByRole("button", { name: "Restore" }));
		await waitFor(async () => {
			expect((await shown(container))?.text).toBe("a\nB\nc\nd\ne\nf\n");
		});
		expect(requests).toHaveLength(1);
	});

	test("opens read-only when the server refuses writes", async () => {
		serve();
		const { container } = renderPage(false);
		await openFromList(container, "modified.txt", false);

		await waitFor(async () => {
			expect((await shown(container))?.text).toBe("a\nB\nc\nd\ne\n");
		});
		expect(
			shownSide(container)
				.querySelector(".cm-content")
				?.getAttribute("contenteditable"),
		).toBe("false");
	});

	test("asks for each part alone when the server refuses the open request", async () => {
		const requests = serve({ refuseOpen: true });
		const { container } = renderPage();
		await openFromList(container, "modified.txt", false);

		await waitFor(async () => {
			const side = await shown(container);
			expect(side?.text).toBe("a\nB\nc\nd\ne\n");
			expect(side?.waiting).toBe(false);
			expect(side?.strips).toBe(1);
		});
		expect(
			openRequests(requests)
				.map(({ endpoint }) => endpoint)
				.sort(),
		).toEqual([
			"/api/files/content",
			"/api/git/base-content",
			"/api/git/diff",
			"/api/git/open",
		]);
	});

	test("draws a save's changes from its answer, after the file opens with one request", async () => {
		const requests = serve();
		const { container } = renderPage();
		await openFromList(container, "modified.txt", false);
		await waitFor(async () => {
			expect((await shown(container))?.strips).toBe(1);
		});

		const { EditorView } = await import("@codemirror/view");
		const view = EditorView.findFromDOM(
			shownSide(container).querySelector(".cm-editor") as HTMLElement,
		);
		act(() => {
			view?.dispatch({ changes: { from: 0, insert: "X\n" } });
		});
		const save = within(shownSide(container)).getByRole("button", {
			name: "Save",
		});
		await waitFor(() => {
			expect(save.getAttribute("aria-disabled")).not.toBe("true");
		});
		fireEvent.click(save);

		await waitFor(async () => {
			const side = await shown(container);
			expect(side?.text).toBe("X\na\nB\nc\nd\ne\n");
			expect(side?.strips).toBe(2);
		});
		expect(openRequests(requests).map(({ endpoint }) => endpoint)).toEqual([
			"/api/git/open",
			"/api/files/content",
		]);
	});

	test("takes no part of the answer that a save has outdated", async () => {
		const requests = serve();
		const opened = openFile({
			repoName: "test-repo",
			path: "both.txt",
			parts: ["file", "index", "unstagedDiff", "head", "stagedDiff"],
			untracked: false,
			refreshToken: 0,
			diffRefreshToken: 0,
			headToken: 0,
			contentToken: 0,
		});
		const options = (staged: boolean, diffRefreshToken: number) => ({
			repoName: "test-repo",
			path: "both.txt",
			staged,
			status: "modified" as const,
			refreshToken: 0,
			diffRefreshToken,
			headToken: 0,
			opened: { ...opened, answer: undefined },
			showError: () => {},
		});
		const unstaged = renderHook((props) => useChangeContext(props), {
			initialProps: options(false, 0),
		});
		const staged = renderHook((props) => useChangeContext(props), {
			initialProps: options(true, 0),
		});
		expect(unstaged.result.current.diffLoading).toBe(true);
		expect(requests).toEqual([]);

		const answer = await opened.request.read();
		const landed = (props: ReturnType<typeof options>) => ({
			...props,
			opened: { ...opened, answer },
		});
		unstaged.rerender(landed(options(false, 0)));
		staged.rerender(landed(options(true, 0)));
		expect(unstaged.result.current).toEqual({
			comparisonContent: REPO["both.txt"].index,
			diff: REPO["both.txt"].unstagedDiff,
			diffExact: true,
			diffLoading: false,
		});
		expect(staged.result.current).toEqual({
			comparisonContent: REPO["both.txt"].head,
			diff: REPO["both.txt"].stagedDiff,
			diffExact: true,
			diffLoading: false,
		});
		expect(openRequests(requests).map(({ endpoint }) => endpoint)).toEqual([
			"/api/git/open",
		]);

		// A save outdates the working tree's diff alone.
		unstaged.rerender(landed(options(false, 1)));
		staged.rerender(landed(options(true, 1)));
		await waitFor(() => {
			expect(unstaged.result.current.diffLoading).toBe(false);
		});
		expect(staged.result.current.diffLoading).toBe(false);
		expect(openRequests(requests).map(({ endpoint }) => endpoint)).toEqual([
			"/api/git/open",
			"/api/git/diff",
		]);
	});

	test("reads the file afresh, part by part, when it reloads", async () => {
		const requests = serve();
		const { container } = renderPage();
		await openFromList(container, "modified.txt", false);
		await waitFor(async () => {
			expect((await shown(container))?.waiting).toBe(false);
		});
		requests.length = 0;

		fireEvent.click(
			within(shownSide(container)).getByRole("button", {
				name: "More actions",
			}),
		);
		fireEvent.click(screen.getByRole("menuitem", { name: "Reload" }));

		await waitFor(() => {
			expect(
				openRequests(requests)
					.map(({ endpoint }) => endpoint)
					.sort(),
			).toEqual([
				"/api/files/content",
				"/api/git/base-content",
				"/api/git/diff",
			]);
		});
	});

	test("shows the text a moment after it opens while the open request hangs, and its changes from requests of their own", async () => {
		const requests = serve({ openAfterMs: Number.POSITIVE_INFINITY });
		const { container } = renderPage();
		await openFromList(container, "modified.txt", false);

		await waitFor(
			async () => {
				const side = await shown(container);
				expect(side?.text).toBe("a\nB\nc\nd\ne\n");
				expect(side?.waiting).toBe(false);
				expect(side?.strips).toBe(1);
				expect(side?.cursorLine).toBe(2);
			},
			{ timeout: 3000 },
		);
		expect(
			shownSide(container).querySelector(".text-file-editor-message"),
		).toBeNull();
		expect(
			openRequests(requests)
				.map(({ endpoint }) => endpoint)
				.sort(),
		).toEqual([
			"/api/files/content",
			"/api/git/base-content",
			"/api/git/diff",
			"/api/git/open",
		]);
	});

	test("takes what a side still lacks from an open request that answers late", async () => {
		// The diff asked for alone never comes, so the late answer gives it.
		serve({ openAfterMs: 1500, hang: ["/api/git/diff"] });
		const { container } = renderPage();
		await openFromList(container, "modified.txt", false);

		await waitFor(
			async () => {
				const side = await shown(container);
				expect(side?.text).toBe("a\nB\nc\nd\ne\n");
				expect(side?.waiting).toBe(false);
			},
			{ timeout: 3000 },
		);
		// The text shows without the strips that git's diff places.
		expect((await shown(container))?.strips).toBe(0);

		await waitFor(
			async () => {
				expect((await shown(container))?.strips).toBe(1);
			},
			{ timeout: 3000 },
		);
	});

	test("stops the open request when its file closes", async () => {
		const requests = serve({ openAfterMs: Number.POSITIVE_INFINITY });
		const { container } = renderPage();
		await openFromList(container, "modified.txt", false);
		await waitFor(() => {
			expect(requests).toHaveLength(1);
		});

		fireEvent.click(
			within(shownSide(container)).getByRole("button", {
				name: "Back to file list",
			}),
		);

		await waitFor(() => {
			expect(requests.aborted).toEqual(requests.slice(0, 1));
		});
	});

	// A MutationObserver's callback runs once the task that changed the page
	// is done with it, before anything a later task does, so each call sees
	// the page as the frame that follows would draw it.
	function watchFrames(container: HTMLElement, look: () => void) {
		const observer = new MutationObserver(look);
		observer.observe(container, {
			subtree: true,
			childList: true,
			attributes: true,
			characterData: true,
		});
		return () => observer.disconnect();
	}

	test("says it is loading until the file is drawn, with no empty pane between", async () => {
		serve();
		const { container } = renderPage();
		const frames: string[] = [];
		const stop = watchFrames(container, () => {
			const side = container.querySelector(
				".changes-editor-view:not(.changes-editor-view--hidden)",
			);
			if (!side) return;
			const state = side.querySelector(".text-file-editor-message")
				? "loading"
				: side.querySelector(
							".text-file-editor-surface:not(.text-file-editor-surface--waiting) .cm-line",
						)
					? "drawn"
					: "empty";
			if (frames.at(-1) !== state) frames.push(state);
		});
		await openFromList(container, "modified.txt", false);
		await waitFor(async () => {
			expect((await shown(container))?.strips).toBe(1);
		});
		stop();

		expect(frames).toEqual(["loading", "drawn"]);
	});

	test("draws the strips acting in the frame that first draws them", async () => {
		serve();
		const { container } = renderPage();
		let firstStrip: string | null | undefined;
		const stop = watchFrames(container, () => {
			const button = container.querySelector(
				".changes-editor-view:not(.changes-editor-view--hidden) .cm-changeStripButton",
			);
			if (button && firstStrip === undefined) {
				firstStrip = button.getAttribute("aria-disabled");
			}
		});
		await openFromList(container, "modified.txt", false);
		await waitFor(async () => {
			expect((await shown(container))?.strips).toBe(1);
		});
		stop();

		expect(firstStrip).toBe("false");
	});
});
