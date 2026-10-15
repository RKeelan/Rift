import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useChangeContext } from "../pages/FileSideView.tsx";

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

	test("hands over no diff, without loading, for a side with none to read", () => {
		const diffs = serve();
		// Nothing of the file is staged.
		const { result } = renderContext(options({ staged: true, status: null }));

		expect(result.current.diff).toBeNull();
		expect(result.current.diffLoading).toBe(false);
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

	test("hands over no earlier diff while a save's refetch loads", async () => {
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

		// The save outdates the diff from the render that asks for it again.
		rerender(options({ diffRefreshToken: 1 }));
		expect(result.current.diff).toBeNull();
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
