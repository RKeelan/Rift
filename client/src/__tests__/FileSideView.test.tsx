import { afterEach, describe, expect, test } from "bun:test";
import {
	act,
	cleanup,
	render,
	renderHook,
	waitFor,
} from "@testing-library/react";
import type { FileContext } from "../components/TextFileEditor.tsx";
import {
	type AnsweredContext,
	FileSideView,
	type SavedDiff,
	useChangeContext,
} from "../pages/FileSideView.tsx";

type Options = Parameters<typeof useChangeContext>[0];

const DIFF = "@@ -1,2 +1,2 @@\n a\n-b\n+B\n";
// git's diff once a save has added a first line.
const SAVED_DIFF = "@@ -1,2 +1,3 @@\n+X\n a\n-b\n+B\n";

const originalFetch = globalThis.fetch;

afterEach(() => {
	cleanup();
	globalThis.fetch = originalFetch;
});

// Answers each request for the comparison at once, and holds each request
// for git's diff until the test answers it.
function serve() {
	const diffs: { url: string; answer: (response: Response) => void }[] = [];
	globalThis.fetch = (async (input: string) => {
		if (input.includes("/api/git/base-content")) {
			return new Response("a\nb\n");
		}
		return await new Promise<Response>((resolve) => {
			diffs.push({ url: input, answer: resolve });
		});
	}) as unknown as typeof fetch;
	return diffs;
}

function diffResponse(diff: string) {
	return new Response(JSON.stringify({ diff, truncated: false }), {
		headers: { "Content-Type": "application/json" },
	});
}

function options(overrides: Partial<Options> = {}): Options {
	return {
		repoName: "test-repo",
		path: "notes.txt",
		staged: false,
		status: "modified",
		refreshToken: 0,
		diffRefreshToken: 0,
		headToken: 0,
		showError: () => {},
		...overrides,
	};
}

function renderContext(initial: Options) {
	return renderHook((props: Options) => useChangeContext(props), {
		initialProps: initial,
	});
}

describe("git's diff for one side of a file", () => {
	test("loads until its request is answered", async () => {
		const diffs = serve();
		const { result } = renderContext(options());

		expect(result.current.diff).toBeNull();
		expect(result.current.diffLoading).toBe(true);

		await waitFor(() => {
			expect(diffs.length).toBe(1);
		});
		await act(async () => {
			diffs[0].answer(diffResponse(DIFF));
		});

		await waitFor(() => {
			expect(result.current.diffLoading).toBe(false);
		});
		expect(result.current.diff).toBe(DIFF);
	});

	test("hands over an empty diff, not loading, for a file with no changes", async () => {
		const diffs = serve();
		const { result } = renderContext(options({ status: null }));

		await waitFor(() => {
			expect(diffs.length).toBe(1);
		});
		await act(async () => {
			diffs[0].answer(diffResponse(""));
		});

		await waitFor(() => {
			expect(result.current.diffLoading).toBe(false);
		});
		expect(result.current.diff).toBe("");
	});

	test("hands over an empty diff for the index of a file with nothing staged, without asking git", async () => {
		const diffs = serve();
		// Nothing of the file is staged.
		const { result } = renderContext(options({ staged: true, status: null }));

		await waitFor(() => {
			expect(result.current.diffLoading).toBe(false);
		});
		expect(result.current.comparisonContent).toBe("a\nb\n");
		expect(result.current.diff).toBe("");
		expect(diffs.length).toBe(0);
	});

	test("hands over no diff for a deleted file, which decorates from its content", async () => {
		const diffs = serve();
		const { result } = renderContext(options({ status: "deleted" }));

		await waitFor(() => {
			expect(result.current.diffLoading).toBe(false);
		});
		expect(result.current.diff).toBeNull();
		expect(diffs.length).toBe(0);
	});

	test("ends the load without a diff when the request fails, and reports it", async () => {
		const diffs = serve();
		const errors: string[] = [];
		const { result } = renderContext(
			options({ showError: (message) => errors.push(message) }),
		);

		await waitFor(() => {
			expect(diffs.length).toBe(1);
		});
		await act(async () => {
			diffs[0].answer(
				new Response(
					JSON.stringify({ error: { message: "git diff failed" } }),
					{ status: 500, headers: { "Content-Type": "application/json" } },
				),
			);
		});

		await waitFor(() => {
			expect(result.current.diffLoading).toBe(false);
		});
		expect(result.current.diff).toBeNull();
		expect(errors).toEqual(["git diff failed"]);
	});

	test("hands over the earlier diff, loading, while a save's refetch loads", async () => {
		const diffs = serve();
		const { result, rerender } = renderContext(options());
		await waitFor(() => {
			expect(diffs.length).toBe(1);
		});
		await act(async () => {
			diffs[0].answer(diffResponse(DIFF));
		});
		await waitFor(() => {
			expect(result.current.diff).toBe(DIFF);
		});

		// The save outdates the diff from the render that asks for it again,
		// which reads as loading.
		rerender(options({ diffRefreshToken: 1 }));
		expect(result.current.diff).toBe(DIFF);
		expect(result.current.diffLoading).toBe(true);

		await waitFor(() => {
			expect(diffs.length).toBe(2);
		});
		await act(async () => {
			diffs[1].answer(diffResponse(SAVED_DIFF));
		});
		await waitFor(() => {
			expect(result.current.diffLoading).toBe(false);
		});
		expect(result.current.diff).toBe(SAVED_DIFF);
	});

	test("takes no late answer to an earlier request for the current one's", async () => {
		const diffs = serve();
		const { result, rerender } = renderContext(options());
		await waitFor(() => {
			expect(diffs.length).toBe(1);
		});

		rerender(options({ diffRefreshToken: 1 }));
		await waitFor(() => {
			expect(diffs.length).toBe(2);
		});
		await act(async () => {
			diffs[0].answer(diffResponse(DIFF));
		});
		expect(result.current.diff).toBeNull();
		expect(result.current.diffLoading).toBe(true);

		await act(async () => {
			diffs[1].answer(diffResponse(SAVED_DIFF));
		});
		await waitFor(() => {
			expect(result.current.diffLoading).toBe(false);
		});
		expect(result.current.diff).toBe(SAVED_DIFF);
	});
});

// The working tree changes the second and fourth lines.
const FILE = "a\nB\nc\nD\ne\n";
// Both changes unstaged, and once the second line's is staged.
const BOTH_UNSTAGED = {
	comparison: "a\nb\nc\nd\ne\n",
	diff: "@@ -1,5 +1,5 @@\n a\n-b\n+B\n c\n-d\n+D\n e\n",
};
const ONE_STAGED = {
	comparison: "a\nB\nc\nd\ne\n",
	diff: "@@ -1,5 +1,5 @@\n a\n B\n c\n-d\n+D\n e\n",
};

type Held = { answer: (response: Response) => void };

// Answers each request for the file's content at once, and holds each
// request for the comparison or git's diff until the test answers it.
function serveHeld() {
	const bases: Held[] = [];
	const diffs: Held[] = [];
	globalThis.fetch = (async (input: string) => {
		if (input.includes("/api/files/content")) {
			return new Response(FILE, { headers: { "x-file-mtime-ms": "1" } });
		}
		return await new Promise<Response>((resolve) => {
			(input.includes("/api/git/base-content") ? bases : diffs).push({
				answer: resolve,
			});
		});
	}) as unknown as typeof fetch;
	return { bases, diffs };
}

// The props of a FileSideView for the working tree, beside its context.
const sideProps = {
	active: true,
	canWrite: true,
	readOnlyLabel: "Read-only",
	contentToken: 0,
	onBack: () => {},
	otherSide: { available: false, show: () => {} },
	fileAction: (label: string) => ({ label, onClick: () => {} }),
	onSaved: () => {},
	onStaged: () => {},
	onUntrackedStaged: () => {},
	onUnstaged: () => {},
	onReload: () => {},
	onDirtyChange: () => {},
};

describe("the change context as a side first loads", () => {
	const none = {
		comparisonContent: undefined,
		diff: null,
		diffExact: true,
		diffLoading: true,
	};

	for (const first of ["comparison", "diff"] as const) {
		test(`hands over none of it until both parts land, when the ${first} lands first`, async () => {
			const { bases, diffs } = serveHeld();
			const { result } = renderContext(options());
			expect(result.current).toEqual(none);
			await waitFor(() => {
				expect(bases.length).toBe(1);
				expect(diffs.length).toBe(1);
			});

			const answers = {
				comparison: () =>
					bases[0].answer(new Response(BOTH_UNSTAGED.comparison)),
				diff: () => diffs[0].answer(diffResponse(BOTH_UNSTAGED.diff)),
			};
			await act(async () => {
				answers[first]();
			});
			expect(result.current).toEqual(none);

			await act(async () => {
				answers[first === "comparison" ? "diff" : "comparison"]();
			});
			await waitFor(() => {
				expect(result.current).toEqual({
					comparisonContent: BOTH_UNSTAGED.comparison,
					diff: BOTH_UNSTAGED.diff,
					diffExact: true,
					diffLoading: false,
				});
			});
		});
	}

	test("hands over an untracked file's empty comparison only with its diff", async () => {
		const { diffs } = serveHeld();
		const { result } = renderContext(options({ status: "untracked" }));
		expect(result.current).toEqual(none);
		await waitFor(() => {
			expect(diffs.length).toBe(1);
		});

		const diff = "@@ -0,0 +1,1 @@\n+a\n";
		await act(async () => {
			diffs[0].answer(diffResponse(diff));
		});
		await waitFor(() => {
			expect(result.current.diffLoading).toBe(false);
		});
		expect(result.current.comparisonContent).toBe("");
		expect(result.current.diff).toBe(diff);
	});

	for (const first of ["comparison", "diff"] as const) {
		test(`shows the file once both parts land, with its changes drawn and at its first change, when the ${first} lands first`, async () => {
			const { bases, diffs } = serveHeld();
			const { container } = render(
				<FileSideView {...sideProps} {...options()} />,
			);
			await waitFor(() => {
				expect(container.querySelector(".cm-content")).not.toBeNull();
				expect(bases.length).toBe(1);
				expect(diffs.length).toBe(1);
			});
			const surface = container.querySelector(".text-file-editor-surface");
			const waiting = () =>
				surface?.classList.contains("text-file-editor-surface--waiting");
			const drawn = () => ({
				chunks: container.querySelectorAll(".cm-deletedChunk").length,
				strips: container.querySelectorAll(".cm-changeStrip").length,
			});
			const { EditorView } = await import("@codemirror/view");
			const view = EditorView.findFromDOM(
				container.querySelector(".cm-editor") as HTMLElement,
			);
			if (!view) throw new Error("editor view not found");
			const cursorLine = () =>
				view.state.doc.lineAt(view.state.selection.main.head).number;
			expect(waiting()).toBe(true);
			expect(
				container.querySelector(".text-file-editor-message"),
			).not.toBeNull();

			const answers = {
				comparison: () =>
					bases[0].answer(new Response(BOTH_UNSTAGED.comparison)),
				diff: () => diffs[0].answer(diffResponse(BOTH_UNSTAGED.diff)),
			};
			await act(async () => {
				answers[first]();
			});
			expect(waiting()).toBe(true);
			expect(drawn()).toEqual({ chunks: 0, strips: 0 });
			expect(cursorLine()).toBe(1);

			await act(async () => {
				answers[first === "comparison" ? "diff" : "comparison"]();
			});
			await waitFor(() => {
				expect(waiting()).toBe(false);
			});
			// Shown with every change drawn, its strip included, and at the
			// first change.
			expect(container.querySelector(".text-file-editor-message")).toBeNull();
			expect(drawn()).toEqual({ chunks: 2, strips: 2 });
			expect(cursorLine()).toBe(2);
		});
	}
});

describe("the change context through a stage's refetch", () => {
	// Opens the side with both changes unstaged.
	async function openContext() {
		const requests = serveHeld();
		const view = renderContext(options());
		await waitFor(() => {
			expect(requests.bases.length).toBe(1);
			expect(requests.diffs.length).toBe(1);
		});
		await act(async () => {
			requests.bases[0].answer(new Response(BOTH_UNSTAGED.comparison));
			requests.diffs[0].answer(diffResponse(BOTH_UNSTAGED.diff));
		});
		await waitFor(() => {
			expect(view.result.current.diffLoading).toBe(false);
		});
		return { ...requests, ...view };
	}

	const before = {
		comparisonContent: BOTH_UNSTAGED.comparison,
		diff: BOTH_UNSTAGED.diff,
		diffExact: true,
		diffLoading: true,
	};
	const after = {
		comparisonContent: ONE_STAGED.comparison,
		diff: ONE_STAGED.diff,
		diffExact: true,
		diffLoading: false,
	};

	for (const first of ["comparison", "diff"] as const) {
		test(`hands over the context it had until both parts land, when the ${first} lands first`, async () => {
			const { bases, diffs, result, rerender } = await openContext();

			rerender(options({ refreshToken: 1 }));
			expect(result.current).toEqual(before);
			await waitFor(() => {
				expect(bases.length).toBe(2);
				expect(diffs.length).toBe(2);
			});

			const answers = {
				comparison: () => bases[1].answer(new Response(ONE_STAGED.comparison)),
				diff: () => diffs[1].answer(diffResponse(ONE_STAGED.diff)),
			};
			await act(async () => {
				answers[first]();
			});
			expect(result.current).toEqual(before);

			await act(async () => {
				answers[first === "comparison" ? "diff" : "comparison"]();
			});
			await waitFor(() => {
				expect(result.current).toEqual(after);
			});
		});
	}

	test("hands another file none of the context it had", async () => {
		const { result, rerender } = await openContext();

		rerender(options({ path: "other.txt" }));

		expect(result.current.comparisonContent).toBeUndefined();
		expect(result.current.diff).toBeNull();
		expect(result.current.diffLoading).toBe(true);
	});

	test("keeps the changes drawn as they were, and redraws them in one step", async () => {
		const { bases, diffs } = serveHeld();
		const props = {
			active: true,
			canWrite: true,
			readOnlyLabel: "Read-only",
			contentToken: 0,
			onBack: () => {},
			otherSide: { available: false, show: () => {} },
			fileAction: (label: string) => ({ label, onClick: () => {} }),
			onSaved: () => {},
			onStaged: () => {},
			onUntrackedStaged: () => {},
			onUnstaged: () => {},
			onReload: () => {},
			onDirtyChange: () => {},
		};
		const { container, rerender } = render(
			<FileSideView {...props} {...options()} />,
		);
		await waitFor(() => {
			expect(bases.length).toBe(1);
			expect(diffs.length).toBe(1);
		});
		await act(async () => {
			bases[0].answer(new Response(BOTH_UNSTAGED.comparison));
			diffs[0].answer(diffResponse(BOTH_UNSTAGED.diff));
		});
		const drawn = () => ({
			chunks: [...container.querySelectorAll(".cm-deletedChunk")],
			strips: [...container.querySelectorAll(".cm-changeStrip")],
			disabled: [...container.querySelectorAll(".cm-changeStrip button")].map(
				(button) => button.getAttribute("aria-disabled"),
			),
		});
		await waitFor(() => {
			expect(drawn().disabled).toEqual(["false", "false"]);
		});
		const { chunks, strips } = drawn();
		expect(chunks.length).toBe(2);

		// Each batch of chunks and strips the editor takes away from here on.
		const removals: Node[][] = [];
		const observer = new MutationObserver((records) => {
			const removed = records
				.flatMap((record) => [...record.removedNodes])
				.filter(
					(node) =>
						chunks.includes(node as Element) ||
						strips.includes(node as Element),
				);
			if (removed.length > 0) removals.push(removed);
		});
		observer.observe(container, { childList: true, subtree: true });
		// Compared as booleans, since printing DOM nodes on a mismatch would
		// take the test runner practically forever.
		const unchanged = () => {
			const now = drawn();
			return (
				now.chunks.length === 2 &&
				now.chunks.every((chunk, index) => chunk === chunks[index]) &&
				now.strips.length === 2 &&
				now.strips.every((strip, index) => strip === strips[index])
			);
		};

		// The second line's change is staged, which refetches both parts.
		rerender(<FileSideView {...props} {...options({ refreshToken: 1 })} />);
		await waitFor(() => {
			expect(bases.length).toBe(2);
			expect(diffs.length).toBe(2);
		});
		expect(unchanged()).toBe(true);
		expect(drawn().disabled).toEqual(["true", "true"]);

		await act(async () => {
			bases[1].answer(new Response(ONE_STAGED.comparison));
		});
		expect(unchanged()).toBe(true);

		await act(async () => {
			diffs[1].answer(diffResponse(ONE_STAGED.diff));
		});
		await waitFor(() => {
			expect(drawn().disabled).toEqual(["false"]);
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		observer.disconnect();

		// The staged change's strip and deleted line went together, and the
		// other change's stayed.
		expect(removals.length).toBe(1);
		expect(
			removals[0].length === 2 &&
				removals[0].includes(chunks[0]) &&
				removals[0].includes(strips[0]),
		).toBe(true);
		const now = drawn();
		expect(now.chunks[0] === chunks[1] && now.strips[0] === strips[1]).toBe(
			true,
		);
	});
});

describe("the change context a stage or unstage answers with", () => {
	// The second line's change staged, and the fourth line's not.
	const STAGED_DIFF = "@@ -1,5 +1,5 @@\n a\n-b\n+B\n c\n d\n e\n";
	const CONTEXT: FileContext = {
		unstagedDiff: { diff: ONE_STAGED.diff, truncated: false },
		stagedDiff: { diff: STAGED_DIFF, truncated: false },
		index: { content: ONE_STAGED.comparison },
		head: { content: BOTH_UNSTAGED.comparison },
	};

	function answered(overrides: Partial<AnsweredContext> = {}): AnsweredContext {
		return {
			repoName: "test-repo",
			path: "notes.txt",
			refreshToken: 1,
			diffRefreshToken: 0,
			headToken: 0,
			context: CONTEXT,
			...overrides,
		};
	}

	// Gathers every request, and answers none of them.
	function hold() {
		const urls: string[] = [];
		globalThis.fetch = ((input: string) => {
			urls.push(input);
			return new Promise<Response>(() => {});
		}) as unknown as typeof fetch;
		return urls;
	}

	test("hands the working tree its context in the render that makes the refresh, without asking", async () => {
		const { bases, diffs } = serveHeld();
		const { result, rerender } = renderContext(options());
		await waitFor(() => {
			expect(bases.length).toBe(1);
			expect(diffs.length).toBe(1);
		});
		await act(async () => {
			bases[0].answer(new Response(BOTH_UNSTAGED.comparison));
			diffs[0].answer(diffResponse(BOTH_UNSTAGED.diff));
		});
		await waitFor(() => {
			expect(result.current.diffLoading).toBe(false);
		});

		rerender(options({ refreshToken: 1, answeredContext: answered() }));

		expect(result.current).toEqual({
			comparisonContent: ONE_STAGED.comparison,
			diff: ONE_STAGED.diff,
			diffExact: true,
			diffLoading: false,
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(bases.length).toBe(1);
		expect(diffs.length).toBe(1);
	});

	test("hands a staged side that opens with it its context, without asking", () => {
		const urls = hold();
		const { result } = renderContext(
			options({ staged: true, refreshToken: 1, answeredContext: answered() }),
		);

		expect(result.current).toEqual({
			comparisonContent: BOTH_UNSTAGED.comparison,
			diff: STAGED_DIFF,
			diffExact: true,
			diffLoading: false,
		});
		expect(urls).toEqual([]);
	});

	test("asks git again for the working tree's diff once a save outdates it", async () => {
		const urls = hold();
		const { result, rerender } = renderContext(
			options({ refreshToken: 1, answeredContext: answered() }),
		);
		expect(result.current.diffLoading).toBe(false);

		rerender(
			options({
				refreshToken: 1,
				diffRefreshToken: 1,
				answeredContext: answered(),
			}),
		);

		expect(result.current.diff).toBe(ONE_STAGED.diff);
		expect(result.current.diffLoading).toBe(true);
		await waitFor(() => {
			expect(urls.length).toBe(1);
		});
		expect(urls[0]).toContain("/api/git/diff");
	});

	test("takes nothing from an answer for another file, or another refresh", async () => {
		for (const other of [
			answered({ path: "other.txt" }),
			answered({ refreshToken: 2 }),
		]) {
			const urls = hold();
			const { result } = renderContext(
				options({ refreshToken: 1, answeredContext: other }),
			);
			expect(result.current.diffLoading).toBe(true);
			await waitFor(() => {
				expect(urls.length).toBe(2);
			});
			cleanup();
		}
	});

	test("takes a refusal in the answer as the request's answer, and reports it", () => {
		const urls = hold();
		const errors: string[] = [];
		const refused = (status: number, code: string, message: string) => ({
			status,
			error: { code, message },
		});
		const { result } = renderContext(
			options({
				staged: true,
				refreshToken: 1,
				showError: (message) => errors.push(message),
				answeredContext: answered({
					context: {
						...CONTEXT,
						head: refused(404, "NOT_FOUND", "Base file not found"),
						stagedDiff: refused(500, "GIT_ERROR", "git diff failed"),
					},
				}),
			}),
		);

		// A file HEAD has no copy of compares against nothing.
		expect(result.current).toEqual({
			comparisonContent: "",
			diff: null,
			diffExact: true,
			diffLoading: false,
		});
		expect(errors).toEqual(["git diff failed"]);
		expect(urls).toEqual([]);
	});

	test("hands the staged side of a new file unstaged in full nothing to mark", () => {
		hold();
		const notFound = {
			status: 404,
			error: { code: "NOT_FOUND", message: "Base file not found" },
		};
		// Neither HEAD nor the index has a copy of the file, which is untracked
		// again, so the staged side has no change in the status.
		const { result } = renderContext(
			options({
				staged: true,
				status: null,
				refreshToken: 1,
				answeredContext: answered({
					context: {
						unstagedDiff: { diff: "", truncated: false, exact: true },
						stagedDiff: { diff: "", truncated: false },
						index: notFound,
						head: notFound,
					},
				}),
			}),
		);

		// Its empty text compares against nothing, with an empty diff, so the
		// editor draws no change and no strip.
		expect(result.current).toEqual({
			comparisonContent: "",
			diff: "",
			diffExact: true,
			diffLoading: false,
		});
	});

	test("drops a copy's leading byte order mark, as reading it as text does", () => {
		hold();
		const { result } = renderContext(
			options({
				refreshToken: 1,
				answeredContext: answered({
					context: {
						...CONTEXT,
						index: { content: `\uFEFF${ONE_STAGED.comparison}` },
					},
				}),
			}),
		);

		expect(result.current.comparisonContent).toBe(ONE_STAGED.comparison);
	});

	test("redraws a stage's changes in one step from the answer, with no request", async () => {
		const { bases, diffs } = serveHeld();
		const { container, rerender } = render(
			<FileSideView {...sideProps} {...options()} />,
		);
		await waitFor(() => {
			expect(bases.length).toBe(1);
			expect(diffs.length).toBe(1);
		});
		await act(async () => {
			bases[0].answer(new Response(BOTH_UNSTAGED.comparison));
			diffs[0].answer(diffResponse(BOTH_UNSTAGED.diff));
		});
		const strips = () =>
			[...container.querySelectorAll(".cm-changeStrip button")].map(
				(button) =>
					`${button.getAttribute("aria-label")}${button.getAttribute("aria-disabled") === "true" ? " (greyed out)" : ""}`,
			);
		await waitFor(() => {
			expect(strips()).toEqual([
				"Stage the change at line 2",
				"Stage the change at line 4",
			]);
		});

		act(() => {
			rerender(
				<FileSideView
					{...sideProps}
					{...options({ refreshToken: 1, answeredContext: answered() })}
				/>,
			);
		});

		expect(strips()).toEqual(["Stage the change at line 4"]);
		expect(container.querySelectorAll(".cm-deletedChunk").length).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(bases.length).toBe(1);
		expect(diffs.length).toBe(1);
	});

	test("opens the staged side on the index's text the answer gives, without reading it", async () => {
		const urls = hold();
		const { container } = render(
			<FileSideView
				{...sideProps}
				{...options({
					staged: true,
					status: "modified",
					refreshToken: 1,
					answeredContext: answered(),
				})}
			/>,
		);

		await waitFor(() => {
			expect(container.querySelector(".cm-changeStrip")).not.toBeNull();
		});
		const { EditorView } = await import("@codemirror/view");
		const view = EditorView.findFromDOM(
			container.querySelector(".cm-editor") as HTMLElement,
		);
		expect(view?.state.doc.toString()).toBe(ONE_STAGED.comparison);
		expect(urls).toEqual([]);
	});
});

describe("the working tree's diff a save answers with", () => {
	function saved(overrides: Partial<SavedDiff> = {}): SavedDiff {
		return {
			repoName: "test-repo",
			path: "notes.txt",
			refreshToken: 0,
			diffRefreshToken: 1,
			diff: { diff: SAVED_DIFF, truncated: false },
			...overrides,
		};
	}

	// Opens the working tree's side, its comparison and diff answered.
	async function openContext() {
		const requests = serveHeld();
		const view = renderContext(options());
		await waitFor(() => {
			expect(requests.bases.length).toBe(1);
			expect(requests.diffs.length).toBe(1);
		});
		await act(async () => {
			requests.bases[0].answer(new Response("a\nb\n"));
			requests.diffs[0].answer(diffResponse(DIFF));
		});
		await waitFor(() => {
			expect(view.result.current.diffLoading).toBe(false);
		});
		return { ...requests, ...view };
	}

	test("hands the working tree its new diff in the render that makes the refresh, without asking", async () => {
		const { result, rerender, bases, diffs } = await openContext();

		rerender(options({ diffRefreshToken: 1, savedDiff: saved() }));

		expect(result.current).toEqual({
			comparisonContent: "a\nb\n",
			diff: SAVED_DIFF,
			diffExact: true,
			diffLoading: false,
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(bases.length).toBe(1);
		expect(diffs.length).toBe(1);
	});

	test("asks git for the diff when the save's is for another file, or the index has changed since the save was sent", async () => {
		for (const [current, other] of [
			[{}, saved({ path: "other.txt" })],
			[{ refreshToken: 1 }, saved()],
		] as const) {
			const { result, rerender, diffs } = await openContext();

			rerender(options({ ...current, diffRefreshToken: 1, savedDiff: other }));

			expect(result.current.diffLoading).toBe(true);
			await waitFor(() => {
				expect(diffs.length).toBe(2);
			});
			cleanup();
		}
	});

	test("gives the staged side nothing of it", async () => {
		const urls: string[] = [];
		globalThis.fetch = ((input: string) => {
			urls.push(input);
			return new Promise<Response>(() => {});
		}) as unknown as typeof fetch;

		const { result } = renderContext(
			options({ staged: true, diffRefreshToken: 1, savedDiff: saved() }),
		);

		expect(result.current.diffLoading).toBe(true);
		await waitFor(() => {
			expect(urls.filter((url) => url.includes("/api/git/diff")).length).toBe(
				1,
			);
		});
	});

	test("takes a refusal in the save's answer as the request's answer, and reports it", async () => {
		const errors: string[] = [];
		const { result, rerender, diffs } = await openContext();

		rerender(
			options({
				diffRefreshToken: 1,
				showError: (message) => errors.push(message),
				savedDiff: saved({
					diff: {
						status: 500,
						error: { code: "GIT_ERROR", message: "git diff failed" },
					},
				}),
			}),
		);

		expect(result.current.diff).toBeNull();
		expect(result.current.diffLoading).toBe(false);
		await waitFor(() => {
			expect(errors).toEqual(["git diff failed"]);
		});
		expect(diffs.length).toBe(1);
	});
});
