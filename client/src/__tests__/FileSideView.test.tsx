import { afterEach, describe, expect, test } from "bun:test";
import {
	act,
	cleanup,
	render,
	renderHook,
	waitFor,
} from "@testing-library/react";
import { FileSideView, useChangeContext } from "../pages/FileSideView.tsx";

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

	test("hands over no diff for a side with none to read, once its comparison lands", async () => {
		const diffs = serve();
		// Nothing of the file is staged.
		const { result } = renderContext(options({ staged: true, status: null }));

		await waitFor(() => {
			expect(result.current.diffLoading).toBe(false);
		});
		expect(result.current.comparisonContent).toBe("a\nb\n");
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
