import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import {
	getChangeRegionLines,
	getEditorChangeDecorations,
	getLineChanges,
	TextFileEditor,
} from "../components/TextFileEditor.tsx";
import { GIT_DIFF_CASES } from "./gitDiffCases.ts";

// git's diff for "a\nb\nc\n" becoming "a\nB\nc\n".
const B_MODIFIED_DIFF = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";

function gitCase(name: string) {
	const found = GIT_DIFF_CASES.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`no case named ${name}`);
	return found;
}

describe("getEditorChangeDecorations", () => {
	test("removes a prior addition when the editor returns to the git baseline", () => {
		const decorations = getEditorChangeDecorations({
			currentContent: "line 1\n",
			loadedContent: "line 1\nadded line\n",
			comparisonContent: "line 1\n",
		});

		expect(decorations.lineHighlights).toEqual([]);
		expect(decorations.deletedChunks).toEqual([]);
	});

	test("returns no decorations when no diff context is provided", () => {
		const decorations = getEditorChangeDecorations({
			currentContent: "line 1\n",
			loadedContent: "line 1\nadded line\n",
		});

		expect(decorations.lineHighlights).toEqual([]);
		expect(decorations.deletedChunks).toEqual([]);
	});

	test("falls back to the loaded file when no git baseline is available", () => {
		const decorations = getEditorChangeDecorations({
			currentContent: "line 1\n",
			loadedContent: "line 1\nadded line\n",
			changeType: "modified",
		});

		expect(decorations.lineHighlights).toEqual([]);
		expect(decorations.deletedChunks).toEqual([
			{
				anchorIndex: 1,
				lines: ["added line"],
			},
		]);
	});

	test("ignores the line endings of the file on disk", () => {
		const lines = ["line 1", "line 2", "line 3"];

		const decorations = getEditorChangeDecorations({
			currentContent: lines.join("\n"),
			loadedContent: lines.join("\r\n"),
			changeType: "modified",
		});

		expect(decorations.lineHighlights).toEqual([]);
		expect(decorations.deletedChunks).toEqual([]);
	});

	test("ignores the line endings of the git baseline", () => {
		const lines = ["line 1", "line 2", "line 3"];

		const decorations = getEditorChangeDecorations({
			currentContent: lines.join("\n"),
			loadedContent: lines.join("\n"),
			comparisonContent: lines.join("\r\n"),
		});

		expect(decorations.lineHighlights).toEqual([]);
		expect(decorations.deletedChunks).toEqual([]);
	});

	test("marks every line of a deleted file as removed", () => {
		const decorations = getEditorChangeDecorations({
			currentContent: "line 1\nline 2",
			loadedContent: "line 1\nline 2",
			changeType: "deleted",
		});

		expect(decorations.lineHighlights).toEqual([
			{ kind: "deleted", lineNumber: 1 },
			{ kind: "deleted", lineNumber: 2 },
		]);
		expect(decorations.deletedChunks).toEqual([]);
	});

	test("reads changed lines that begin with dashes or pluses from git's diff", () => {
		const content = "a\n++i;\nb\n";

		const decorations = getEditorChangeDecorations({
			currentContent: content,
			loadedContent: content,
			changeType: "modified",
			changeDiff: [
				"--- a/f.c",
				"+++ b/f.c",
				"@@ -1,3 +1,3 @@",
				" a",
				"--- note",
				"+++i;",
				" b",
				"",
			].join("\n"),
		});

		expect(decorations.lineHighlights).toEqual([
			{ kind: "added", lineNumber: 2 },
		]);
		expect(decorations.deletedChunks).toEqual([
			{ anchorIndex: 1, lines: ["-- note"] },
		]);
	});

	test("anchors the deletions of an emptied file to line 1", () => {
		const decorations = getEditorChangeDecorations({
			currentContent: "",
			loadedContent: "",
			changeType: "modified",
			changeDiff: "--- a/f\n+++ b/f\n@@ -1,2 +0,0 @@\n-a\n-b\n",
		});

		expect(decorations.lineHighlights).toEqual([]);
		expect(decorations.deletedChunks).toEqual([
			{ anchorIndex: 0, lines: ["a", "b"] },
		]);
	});

	test("marks only the edited lines when two edits sit far apart", () => {
		const baseline = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
		const edited = baseline.slice();
		edited[100] = "line 100 changed";
		edited[1500] = "line 1500 changed";

		const decorations = getEditorChangeDecorations({
			currentContent: edited.join("\n"),
			loadedContent: baseline.join("\n"),
			comparisonContent: baseline.join("\n"),
		});

		expect(decorations.lineHighlights).toEqual([
			{ kind: "added", lineNumber: 101 },
			{ kind: "added", lineNumber: 1501 },
		]);
		expect(decorations.deletedChunks).toEqual([
			{ anchorIndex: 100, lines: ["line 100"] },
			{ anchorIndex: 1500, lines: ["line 1500"] },
		]);
	});

	test("anchors a run's deletion at its first line, as git does", () => {
		// The editor's diff lists this run as two insertions and then the deletion.
		const decorations = getEditorChangeDecorations({
			currentContent: "f\nR\nn\n}",
			loadedContent: "f\nR\nn\n}",
			comparisonContent: "f\nr\n}",
		});

		expect(decorations.lineHighlights).toEqual([
			{ kind: "added", lineNumber: 2 },
			{ kind: "added", lineNumber: 3 },
		]);
		expect(decorations.deletedChunks).toEqual([
			{ anchorIndex: 1, lines: ["r"] },
		]);
	});

	describe("with git's diff", () => {
		// git deletes c() whole, just above d(). The editor's own diff, left to
		// itself, deletes from b()'s closing brace to the middle of c().
		const GIT_PLACEMENT = { anchorIndex: 5, lines: ["c() {", "\ts", "}", ""] };

		test("follows git's placement when its diff describes the buffer", () => {
			const { base, current, diff } = gitCase(
				"a block deleted from between two similar ones",
			);

			const decorations = getEditorChangeDecorations({
				currentContent: current,
				loadedContent: current,
				comparisonContent: base,
				changeDiff: diff,
			});

			expect(decorations.matchesGitDiff).toBe(true);
			expect(decorations.lineHighlights).toEqual([
				{ kind: "added", lineNumber: 2 },
			]);
			expect(decorations.deletedChunks).toEqual([GIT_PLACEMENT]);
		});

		test("matches git's diff of a file that starts with a byte order mark", () => {
			// Reading the file as text drops the mark, but git's diff, which
			// arrives inside JSON, keeps it after the prefix of each line 1.
			const decorations = getEditorChangeDecorations({
				currentContent: "Title\nb\nC\n",
				loadedContent: "Title\nb\nC\n",
				comparisonContent: "title\nb\nc\n",
				changeDiff: [
					"--- a/f",
					"+++ b/f",
					"@@ -1,3 +1,3 @@",
					"-\uFEFFtitle",
					"+\uFEFFTitle",
					" b",
					"-c",
					"+C",
					"",
				].join("\n"),
			});

			expect(decorations.matchesGitDiff).toBe(true);
			expect(decorations.lineHighlights).toEqual([
				{ kind: "added", lineNumber: 1 },
				{ kind: "added", lineNumber: 3 },
			]);
			expect(decorations.deletedChunks).toEqual([
				{ anchorIndex: 0, lines: ["title"] },
				{ anchorIndex: 2, lines: ["c"] },
			]);
		});

		test("keeps a byte order mark that starts a later line", () => {
			// Only a mark at the start of the file is dropped on reading; one that
			// starts a later line is content, and stays in the buffer.
			const decorations = getEditorChangeDecorations({
				currentContent: "a\n\uFEFFB\n",
				loadedContent: "a\n\uFEFFB\n",
				comparisonContent: "a\n\uFEFFb\n",
				changeDiff: [
					"--- a/f",
					"+++ b/f",
					"@@ -1,2 +1,2 @@",
					" a",
					"-\uFEFFb",
					"+\uFEFFB",
					"",
				].join("\n"),
			});

			expect(decorations.matchesGitDiff).toBe(true);
			expect(decorations.lineHighlights).toEqual([
				{ kind: "added", lineNumber: 2 },
			]);
		});

		test("follows git's placement in a file without a final newline", () => {
			const { base, current, diff } = gitCase(
				"a block deleted near the end of a file without a final newline",
			);

			const decorations = getEditorChangeDecorations({
				currentContent: current,
				loadedContent: current,
				comparisonContent: base,
				changeDiff: diff,
			});

			expect(decorations.deletedChunks).toEqual([GIT_PLACEMENT]);
		});

		test("falls back to its own diff once the buffer moves on", () => {
			const { base, current, diff } = gitCase(
				"a block deleted from between two similar ones",
			);

			const decorations = getEditorChangeDecorations({
				currentContent: `${current}e\n`,
				loadedContent: current,
				comparisonContent: base,
				changeDiff: diff,
			});

			// The new last line is something only the editor's diff knows about,
			// and its line numbers are not the ones staging would act on.
			expect(decorations.matchesGitDiff).toBe(false);
			expect(decorations.lineHighlights).toContainEqual({
				kind: "added",
				lineNumber: 8,
			});
		});
	});
});

describe("getChangeRegionLines", () => {
	test("merges adjacent changed lines and splits on a gap", () => {
		const regions = getChangeRegionLines(
			{
				lineHighlights: [
					{ kind: "added", lineNumber: 2 },
					{ kind: "added", lineNumber: 3 },
					{ kind: "added", lineNumber: 7 },
				],
				deletedChunks: [],
			},
			10,
		);

		expect(regions).toEqual([2, 7]);
	});

	test("treats a deletion beside an addition as one region", () => {
		const regions = getChangeRegionLines(
			{
				lineHighlights: [{ kind: "added", lineNumber: 4 }],
				deletedChunks: [{ anchorIndex: 3, lines: ["old"] }],
			},
			10,
		);

		expect(regions).toEqual([4]);
	});

	test("anchors a pure deletion at the following line", () => {
		const regions = getChangeRegionLines(
			{
				lineHighlights: [],
				deletedChunks: [{ anchorIndex: 4, lines: ["gone"] }],
			},
			10,
		);

		expect(regions).toEqual([5]);
	});
});

describe("change navigation", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		cleanup();
		globalThis.fetch = originalFetch;
	});

	async function renderWithChanges() {
		globalThis.fetch = (async () =>
			new Response("a\nB\nc\nD\ne\n", {
				headers: { "x-file-mtime-ms": "1" },
			})) as typeof fetch;

		const { container } = render(
			<TextFileEditor
				filePath="notes.txt"
				repo="test-repo"
				comparisonContent={"a\nb\nc\nd\ne\n"}
			/>,
		);
		await waitFor(() => {
			expect(container.querySelector(".cm-content")).not.toBeNull();
		});
		await screen.findByRole("button", { name: "Next change" });

		const { EditorView } = await import("@codemirror/view");
		const view = EditorView.findFromDOM(
			container.querySelector(".cm-editor") as HTMLElement,
		);
		if (!view) throw new Error("editor view not found");
		return view;
	}

	function selectedLine(view: import("@codemirror/view").EditorView) {
		return view.state.doc.lineAt(view.state.selection.main.head).number;
	}

	test("Next and Previous cycle through the changes and wrap around", async () => {
		const view = await renderWithChanges();

		const next = screen.getByRole("button", { name: "Next change" });
		const previous = screen.getByRole("button", { name: "Previous change" });

		fireEvent.click(next);
		expect(selectedLine(view)).toBe(2);

		fireEvent.click(next);
		expect(selectedLine(view)).toBe(4);

		// Past the last change, Next wraps to the first.
		fireEvent.click(next);
		expect(selectedLine(view)).toBe(2);

		// Before the first, Previous wraps to the last.
		fireEvent.click(previous);
		expect(selectedLine(view)).toBe(4);

		fireEvent.click(previous);
		expect(selectedLine(view)).toBe(2);
	});

	test("hides the change controls when there are no changes", async () => {
		globalThis.fetch = (async () =>
			new Response("a\nb\nc\n", {
				headers: { "x-file-mtime-ms": "1" },
			})) as typeof fetch;

		const { container } = render(
			<TextFileEditor
				filePath="notes.txt"
				repo="test-repo"
				comparisonContent={"a\nb\nc\n"}
			/>,
		);
		await waitFor(() => {
			expect(container.querySelector(".cm-content")).not.toBeNull();
		});

		expect(screen.queryByRole("button", { name: "Next change" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Previous change" }),
		).toBeNull();
	});
});

describe("staging", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		cleanup();
		globalThis.fetch = originalFetch;
	});

	async function renderForStaging(
		props: Partial<Parameters<typeof TextFileEditor>[0]> = {},
		fileContent = "a\nB\nc\n",
	) {
		const requests: RequestInit[] = [];
		globalThis.fetch = (async (_input: string, init?: RequestInit) => {
			if (init?.method === "POST") {
				requests.push(init);
				return new Response(JSON.stringify({ files: [] }), {
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(fileContent, {
				headers: { "x-file-mtime-ms": "1" },
			});
		}) as unknown as typeof fetch;

		const { container } = render(
			<TextFileEditor
				filePath="notes.txt"
				repo="test-repo"
				comparisonContent={"a\nb\nc\n"}
				changeDiff={B_MODIFIED_DIFF}
				changeType="modified"
				onStaged={() => {}}
				{...props}
			/>,
		);
		await waitFor(() => {
			expect(container.querySelector(".cm-content")).not.toBeNull();
		});

		const { EditorView } = await import("@codemirror/view");
		const view = EditorView.findFromDOM(
			container.querySelector(".cm-editor") as HTMLElement,
		);
		if (!view) throw new Error("editor view not found");
		return { view, requests };
	}

	test("sends the selected lines as ranges", async () => {
		const { view, requests } = await renderForStaging();

		const line2 = view.state.doc.line(2);
		act(() => {
			view.dispatch({ selection: { anchor: line2.from, head: line2.to } });
		});

		const stage = await screen.findByRole("button", { name: "Stage" });
		await waitFor(() => {
			expect(stage.hasAttribute("disabled")).toBe(false);
		});
		fireEvent.click(stage);

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(JSON.parse(requests[0].body as string)).toEqual({
			path: "notes.txt",
			ranges: [[2, 2]],
		});
	});

	test("stages an untracked file whole, without ranges", async () => {
		const { requests } = await renderForStaging({
			changeType: "untracked",
			comparisonContent: "",
			changeDiff: null,
		});

		const stage = await screen.findByRole("button", { name: "Stage" });
		await waitFor(() => {
			expect(stage.hasAttribute("disabled")).toBe(false);
		});
		fireEvent.click(stage);

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(JSON.parse(requests[0].body as string)).toEqual({
			path: "notes.txt",
		});
	});

	test("disables staging while the buffer is dirty", async () => {
		const { view } = await renderForStaging();
		act(() => {
			view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
		});

		const stage = await screen.findByRole("button", { name: "Stage" });
		await waitFor(() => {
			expect(stage.hasAttribute("disabled")).toBe(false);
		});

		act(() => {
			view.dispatch({ changes: { from: 0, insert: "x" } });
		});

		await waitFor(() => {
			expect(stage.hasAttribute("disabled")).toBe(true);
		});
	});

	test("enables Stage only when the selection covers a change", async () => {
		const { view } = await renderForStaging();

		// The cursor starts on line 1, which is unchanged, so Stage would do
		// nothing.
		const stage = await screen.findByRole("button", { name: "Pick lines" });
		expect(stage.getAttribute("title")).toBe(
			"Pick changed lines in the gutter, or select them",
		);
		expect(stage.hasAttribute("disabled")).toBe(true);

		act(() => {
			view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
		});
		await waitFor(() => {
			expect(stage.textContent).toBe("Stage");
			expect(stage.hasAttribute("disabled")).toBe(false);
		});
	});

	test("hides the Stage button without an onStaged handler", async () => {
		await renderForStaging({ onStaged: undefined });

		expect(screen.queryByRole("button", { name: "Stage" })).toBeNull();
	});

	test("waits for the comparison and git's diff before staging by line", async () => {
		await renderForStaging({ changeDiff: null });

		const stage = await screen.findByRole("button", { name: "Stage" });
		expect(stage.hasAttribute("disabled")).toBe(true);

		cleanup();
		await renderForStaging({ comparisonContent: undefined });

		expect(
			(await screen.findByRole("button", { name: "Stage" })).hasAttribute(
				"disabled",
			),
		).toBe(true);
	});
});

describe("unstaging", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		cleanup();
		globalThis.fetch = originalFetch;
	});

	async function renderForUnstaging(
		props: Partial<Parameters<typeof TextFileEditor>[0]> = {},
		fileContent = "a\nB\nc\n",
	) {
		const requests: RequestInit[] = [];
		const contentUrls: string[] = [];
		globalThis.fetch = (async (input: string, init?: RequestInit) => {
			if (init?.method === "POST") {
				requests.push(init);
				return new Response(JSON.stringify({ files: [] }), {
					headers: { "Content-Type": "application/json" },
				});
			}
			contentUrls.push(input);
			return new Response(fileContent, {
				headers: { "x-file-mtime-ms": "1" },
			});
		}) as unknown as typeof fetch;

		const { container } = render(
			<TextFileEditor
				filePath="notes.txt"
				repo="test-repo"
				comparisonContent={"a\nb\nc\n"}
				changeDiff={B_MODIFIED_DIFF}
				changeType="modified"
				staged
				onUnstaged={() => {}}
				{...props}
			/>,
		);
		await waitFor(() => {
			expect(container.querySelector(".cm-content")).not.toBeNull();
		});

		const { EditorView } = await import("@codemirror/view");
		const view = EditorView.findFromDOM(
			container.querySelector(".cm-editor") as HTMLElement,
		);
		if (!view) throw new Error("editor view not found");
		return { view, requests, contentUrls };
	}

	test("loads the index content and offers Unstage in place of Save", async () => {
		const { view, contentUrls } = await renderForUnstaging();
		act(() => {
			view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
		});

		// The buffer comes from the staged blob, not the working tree.
		expect(
			contentUrls.some(
				(url) =>
					url.includes("/api/git/base-content") && url.includes("staged=false"),
			),
		).toBe(true);
		expect(
			await screen.findByRole("button", { name: "Unstage" }),
		).toBeDefined();
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Stage" })).toBeNull();
	});

	test("sends the selected lines as ranges", async () => {
		const { view, requests } = await renderForUnstaging();

		const line2 = view.state.doc.line(2);
		act(() => {
			view.dispatch({ selection: { anchor: line2.from, head: line2.to } });
		});

		const unstage = await screen.findByRole("button", { name: "Unstage" });
		await waitFor(() => {
			expect(unstage.hasAttribute("disabled")).toBe(false);
		});
		fireEvent.click(unstage);

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(JSON.parse(requests[0].body as string)).toEqual({
			path: "notes.txt",
			ranges: [[2, 2]],
		});
	});

	test("unstages a staged new file whole, without ranges", async () => {
		const { requests } = await renderForUnstaging(
			{ changeType: "added", comparisonContent: "" },
			"x\ny\n",
		);

		const unstage = await screen.findByRole("button", { name: "Unstage" });
		await waitFor(() => {
			expect(unstage.hasAttribute("disabled")).toBe(false);
		});
		fireEvent.click(unstage);

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(JSON.parse(requests[0].body as string)).toEqual({
			path: "notes.txt",
		});
	});

	test("keeps the editor when an unstage changes the staged content", async () => {
		let index = "a\nB\nc\nD\n";
		globalThis.fetch = (async (_input: string, init?: RequestInit) => {
			if (init?.method === "POST") {
				index = "a\nb\nc\nD\n";
				return new Response(JSON.stringify({ files: [] }), {
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(index);
		}) as unknown as typeof fetch;

		const { container } = render(
			<TextFileEditor
				filePath="notes.txt"
				repo="test-repo"
				comparisonContent={"a\nb\nc\nd\n"}
				changeDiff={"@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n-d\n+D\n"}
				changeType="modified"
				staged
				onUnstaged={() => {}}
			/>,
		);
		await waitFor(() => {
			expect(container.querySelector(".cm-content")).not.toBeNull();
		});
		const { EditorView } = await import("@codemirror/view");
		const view = EditorView.findFromDOM(
			container.querySelector(".cm-editor") as HTMLElement,
		);
		if (!view) throw new Error("editor view not found");

		const line2 = view.state.doc.line(2);
		act(() => {
			view.dispatch({ selection: { anchor: line2.from } });
		});
		const unstage = await screen.findByRole("button", { name: "Unstage" });
		await waitFor(() => {
			expect(unstage.hasAttribute("disabled")).toBe(false);
		});
		fireEvent.click(unstage);

		const currentView = () =>
			EditorView.findFromDOM(
				container.querySelector(".cm-editor") as HTMLElement,
			);
		await waitFor(() => {
			expect(currentView()?.state.doc.toString()).toBe("a\nb\nc\nD\n");
		});
		// A rebuilt editor would start again at the top of the file, so the
		// buffer must change in place. Compared as a boolean, since printing two
		// editor views on a mismatch takes the test runner practically forever.
		expect(currentView() === view).toBe(true);
	});
});

describe("getLineChanges", () => {
	async function apply(previous: string, next: string) {
		const { ChangeSet, Text } = await import("@codemirror/state");
		const changes = getLineChanges(previous, next);
		return ChangeSet.of(changes, previous.length)
			.apply(Text.of(previous.split("\n")))
			.toString();
	}

	test("turns one text into the other", async () => {
		const cases: [string, string][] = [
			["a\nb\nc\n", "a\nB\nc\n"],
			["a\nb\nc\nd\ne\n", "a\nc\nd\nx\ny\ne\n"],
			["a\nb", "a\nb\n"],
			["a\nb\n", "a\nb"],
			["", "a\n"],
			["a\n", ""],
			["a\nb\n", "a\nb\n"],
		];
		for (const [previous, next] of cases) {
			expect(await apply(previous, next)).toBe(next);
		}
	});

	test("leaves unchanged lines out of every edit", () => {
		expect(getLineChanges("a\nb\nc\nd\ne\n", "a\nB\nc\nd\nE\n")).toEqual([
			{ from: 2, to: 4, insert: "B\n" },
			{ from: 8, to: 10, insert: "E\n" },
		]);
	});
});

describe("line picking", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		cleanup();
		globalThis.fetch = originalFetch;
	});

	// Lines 2 and 4 are modified: each has a deletion anchored to it.
	const MODIFIED = {
		file: "a\nB\nc\nD\ne\n",
		comparison: "a\nb\nc\nd\ne\n",
		diff: "@@ -1,5 +1,5 @@\n a\n-b\n+B\n c\n-d\n+D\n e\n",
	};
	// "b" is deleted outright, so the deletion anchors to the unchanged "c".
	const DELETED = {
		file: "a\nc\n",
		comparison: "a\nb\nc\n",
		diff: "@@ -1,3 +1,2 @@\n a\n-b\n c\n",
	};

	function mockFetch(file: string) {
		const requests: unknown[] = [];
		globalThis.fetch = (async (_input: string, init?: RequestInit) => {
			if (init?.method === "POST") {
				requests.push(JSON.parse(init.body as string));
				return new Response(JSON.stringify({ files: [] }), {
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(file, {
				headers: { "x-file-mtime-ms": "1" },
			});
		}) as unknown as typeof fetch;
		return requests;
	}

	async function renderForPicking(
		props: Partial<Parameters<typeof TextFileEditor>[0]> = {},
		{ file, comparison, diff } = MODIFIED,
	) {
		const requests = mockFetch(file);
		const { container } = render(
			<TextFileEditor
				filePath="notes.txt"
				repo="test-repo"
				comparisonContent={comparison}
				changeDiff={diff}
				changeType="modified"
				onStaged={() => {}}
				{...props}
			/>,
		);
		await waitFor(() => {
			expect(container.querySelector(".cm-content")).not.toBeNull();
		});

		const { EditorView } = await import("@codemirror/view");
		const view = EditorView.findFromDOM(
			container.querySelector(".cm-editor") as HTMLElement,
		);
		if (!view) throw new Error("editor view not found");
		return { container, view, requests };
	}

	function pickTargets(container: HTMLElement) {
		return [...container.querySelectorAll<HTMLElement>(".cm-pickTarget")].map(
			(target) => [
				target.classList.contains("cm-pickTarget--deletion")
					? "deletion"
					: "line",
				Number(target.dataset.pickLine),
				target.textContent,
			],
		);
	}

	async function tap(
		container: HTMLElement,
		line: number,
		kind: "line" | "deletion" = "line",
	) {
		const target = await waitFor(() => {
			const found = container.querySelector<HTMLElement>(
				`.cm-pickTarget--${kind}[data-pick-line="${line}"]`,
			);
			if (!found) throw new Error(`no ${kind} pick target for line ${line}`);
			return found;
		});
		act(() => {
			fireEvent.click(target);
		});
	}

	async function enabledButton(name: string) {
		const button = await screen.findByRole("button", { name });
		await waitFor(() => {
			expect(button.hasAttribute("disabled")).toBe(false);
		});
		return button;
	}

	function contentLine(container: HTMLElement, line: number) {
		return container.querySelectorAll(".cm-line")[line - 1];
	}

	test("offers a target beside each changed line and deletion only", async () => {
		const { container } = await renderForPicking();

		await waitFor(() => {
			expect(pickTargets(container)).toEqual([
				["deletion", 2, "−"],
				["line", 2, "+"],
				["deletion", 4, "−"],
				["line", 4, "+"],
			]);
		});
	});

	test("tapping a changed line picks it, and tapping again unpicks it", async () => {
		const { container } = await renderForPicking();

		await tap(container, 2);

		await screen.findByRole("button", { name: "Stage 1 line" });
		expect(contentLine(container, 2).classList.contains("cm-pickedLine")).toBe(
			true,
		);
		// A modified line stages with its deletion, so both show as picked.
		expect(pickTargets(container).slice(0, 2)).toEqual([
			["deletion", 2, "✓"],
			["line", 2, "✓"],
		]);
		expect(
			container
				.querySelector(".cm-deletedChunk")
				?.classList.contains("cm-deletedChunk--picked"),
		).toBe(true);

		await tap(container, 2);

		await screen.findByRole("button", { name: "Pick lines" });
		expect(contentLine(container, 2).classList.contains("cm-pickedLine")).toBe(
			false,
		);
	});

	test("swallows the press so picking does not move focus", async () => {
		const { container } = await renderForPicking();

		const target = await waitFor(() => {
			const found = container.querySelector(".cm-pickTarget");
			if (!found) throw new Error("no pick target");
			return found;
		});

		// fireEvent returns false when the handler prevented the default.
		expect(fireEvent.mouseDown(target)).toBe(false);
	});

	test("stages the picked lines in place of the selection", async () => {
		const { container, view, requests } = await renderForPicking();
		act(() => {
			view.dispatch({ selection: { anchor: 0 } });
		});

		await tap(container, 2);
		await tap(container, 4);

		fireEvent.click(await enabledButton("Stage 2 lines"));

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(requests[0]).toEqual({
			path: "notes.txt",
			ranges: [
				[2, 2],
				[4, 4],
			],
		});
	});

	test("picks a deletion through its own target, staging it with the line below", async () => {
		const { container, requests } = await renderForPicking({}, DELETED);

		await waitFor(() => {
			expect(pickTargets(container)).toEqual([["deletion", 2, "−"]]);
		});

		await tap(container, 2, "deletion");

		const stage = await enabledButton("Stage 1 line");
		expect(
			container
				.querySelector(".cm-deletedChunk")
				?.classList.contains("cm-deletedChunk--picked"),
		).toBe(true);
		// The anchor line itself is unchanged, so it is not marked as picked.
		expect(contentLine(container, 2).classList.contains("cm-pickedLine")).toBe(
			false,
		);

		fireEvent.click(stage);
		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(requests[0]).toEqual({ path: "notes.txt", ranges: [[2, 2]] });
	});

	test("ignores taps until git's diff arrives", async () => {
		const requests = mockFetch(MODIFIED.file);
		const props = {
			filePath: "notes.txt",
			repo: "test-repo",
			comparisonContent: MODIFIED.comparison,
			changeType: "modified" as const,
			onStaged: () => {},
		};
		const { container, rerender } = render(
			<TextFileEditor {...props} changeDiff={null} />,
		);

		// The editor's own diff offers targets, but only git's diff can say which
		// lines staging will act on, so they wait.
		await tap(container, 2);
		expect(pickTargets(container)).toContainEqual(["line", 2, "+"]);
		expect(container.querySelector(".cm-pickTarget--waiting")).not.toBeNull();
		expect(
			screen.getByRole("button", { name: "Stage" }).hasAttribute("disabled"),
		).toBe(true);

		rerender(<TextFileEditor {...props} changeDiff={MODIFIED.diff} />);
		// Presence is compared as a boolean throughout, since printing an editor
		// element on a mismatch would take the test runner practically forever.
		await waitFor(() => {
			expect(container.querySelector(".cm-pickTarget--waiting") === null).toBe(
				true,
			);
		});

		await tap(container, 2);
		fireEvent.click(await enabledButton("Stage 1 line"));
		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(requests[0]).toEqual({ path: "notes.txt", ranges: [[2, 2]] });
	});

	test("refuses to stage lines when git's diff no longer describes the buffer", async () => {
		// git's diff describes "B" on line 2, but the buffer shows "X": the file
		// changed on disk after the editor loaded it.
		const { container } = await renderForPicking(
			{},
			{
				file: "a\nX\nc\nD\ne\n",
				comparison: MODIFIED.comparison,
				diff: MODIFIED.diff,
			},
		);

		await screen.findByText(
			"Git's diff doesn't match this file. Reload, or stage the whole file.",
		);
		expect(
			screen.getByRole("button", { name: "Stage" }).hasAttribute("disabled"),
		).toBe(true);
		expect(container.querySelector(".cm-pickTarget--waiting")).not.toBeNull();

		await tap(container, 2);
		expect(
			screen.queryByRole("button", { name: "Stage 1 line" }) === null,
		).toBe(true);
	});

	test("an edit clears the picks", async () => {
		const { container, view } = await renderForPicking();
		await tap(container, 2);
		await screen.findByRole("button", { name: "Stage 1 line" });

		act(() => {
			view.dispatch({ changes: { from: 0, insert: "x" } });
		});

		await screen.findByRole("button", { name: "Stage" });
		expect(pickTargets(container).filter(([, , text]) => text === "✓")).toEqual(
			[],
		);
	});

	test("offers no targets for an untracked file, which stages whole", async () => {
		const { container } = await renderForPicking({
			changeType: "untracked",
			comparisonContent: "",
			changeDiff: null,
		});

		await screen.findByRole("button", { name: "Stage" });
		expect(pickTargets(container)).toEqual([]);
	});

	test("offers no targets when the server refuses writes", async () => {
		for (const props of [
			{ readOnly: true, readOnlyLabel: "Writes are off" },
			{
				readOnly: true,
				readOnlyLabel: "Writes are off",
				staged: true,
				onStaged: undefined,
				onUnstaged: () => {},
			},
		]) {
			const { container } = await renderForPicking(props, {
				// A buffer git's diff does not describe would otherwise ask for a
				// reload, which a read-only view has no use for.
				file: "a\nX\nc\nD\ne\n",
				comparison: MODIFIED.comparison,
				diff: MODIFIED.diff,
			});
			await screen.findByText("Writes are off");

			expect(pickTargets(container)).toEqual([]);
			expect(screen.queryByRole("button", { name: "Stage" }) === null).toBe(
				true,
			);
			expect(screen.queryByRole("button", { name: "Unstage" }) === null).toBe(
				true,
			);
			expect(container.querySelector(".text-file-editor-notice") === null).toBe(
				true,
			);
			cleanup();
		}
	});

	test("waits for the refetched context after a save rather than reporting a mismatch", async () => {
		const { container, view } = await renderForPicking({ onSaved: () => {} });
		globalThis.fetch = (async (_input: string, init?: RequestInit) =>
			init?.method === "PUT"
				? new Response(JSON.stringify({ mtimeMs: 2 }), {
						headers: { "Content-Type": "application/json" },
					})
				: new Response(MODIFIED.file, {
						headers: { "x-file-mtime-ms": "1" },
					})) as unknown as typeof fetch;

		act(() => {
			view.dispatch({
				changes: { from: view.state.doc.length, insert: "f\n" },
			});
		});
		fireEvent.click(await enabledButton("Save"));
		await screen.findByText("No unsaved changes");

		// The page has yet to refetch git's diff, which the save has outdated.
		expect(container.querySelector(".text-file-editor-notice") === null).toBe(
			true,
		);
	});

	test("the staged view is non-editable and unstages the picked lines", async () => {
		const { container, requests } = await renderForPicking({
			staged: true,
			onStaged: undefined,
			onUnstaged: () => {},
		});

		expect(
			container.querySelector(".cm-content")?.getAttribute("contenteditable"),
		).toBe("false");

		await tap(container, 4);

		fireEvent.click(await enabledButton("Unstage 1 line"));
		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(requests[0]).toEqual({ path: "notes.txt", ranges: [[4, 4]] });
	});

	test("holds Unstage until a pick, rather than unstaging the unseen cursor's line", async () => {
		const { container } = await renderForPicking({
			staged: true,
			onStaged: undefined,
			onUnstaged: () => {},
		});

		// The non-editable view shows no cursor, and the one it has sits on an
		// unchanged first line, so an Unstage now would quietly unstage nothing.
		const unstage = await screen.findByRole("button", { name: "Pick lines" });
		expect(unstage.getAttribute("title")).toBe(
			"Pick staged lines in the gutter",
		);
		expect(unstage.hasAttribute("disabled")).toBe(true);

		await tap(container, 4);
		await enabledButton("Unstage 1 line");
	});
});

describe("refreshed change context", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		cleanup();
		globalThis.fetch = originalFetch;
	});

	async function editorView(container: HTMLElement) {
		const { EditorView } = await import("@codemirror/view");
		const view = EditorView.findFromDOM(
			container.querySelector(".cm-editor") as HTMLElement,
		);
		if (!view) throw new Error("editor view not found");
		return view;
	}

	test("redraws its decorations in place", async () => {
		globalThis.fetch = (async () =>
			new Response("a\nB\nc\n", {
				headers: { "x-file-mtime-ms": "1" },
			})) as typeof fetch;

		const { container, rerender } = render(
			<TextFileEditor
				filePath="notes.txt"
				repo="test-repo"
				comparisonContent={"a\nb\nc\n"}
			/>,
		);
		await waitFor(() => {
			expect(container.querySelector(".cm-changedLine--added")).not.toBeNull();
		});
		const view = await editorView(container);

		// The change was staged, so the index now matches the buffer.
		rerender(
			<TextFileEditor
				filePath="notes.txt"
				repo="test-repo"
				comparisonContent={"a\nB\nc\n"}
			/>,
		);

		await waitFor(() => {
			expect(container.querySelector(".cm-changedLine")).toBeNull();
		});
		// Compared as a boolean, since printing two editor views on a mismatch
		// would take the test runner practically forever.
		expect((await editorView(container)) === view).toBe(true);
	});

	test("keeps an earlier save when a stage refreshes the change context", async () => {
		let disk = "a\nB\n";
		const saves: string[] = [];
		let stages = 0;
		globalThis.fetch = (async (_input: string, init?: RequestInit) => {
			if (init?.method === "PUT") {
				disk = JSON.parse(init.body as string).content;
				saves.push(disk);
				return new Response(JSON.stringify({ mtimeMs: saves.length + 1 }), {
					headers: { "Content-Type": "application/json" },
				});
			}
			if (init?.method === "POST") {
				stages += 1;
				return new Response(JSON.stringify({ files: [] }), {
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(disk, { headers: { "x-file-mtime-ms": "1" } });
		}) as unknown as typeof fetch;

		const props = {
			filePath: "notes.txt",
			repo: "test-repo",
			changeType: "modified" as const,
			onSaved: () => {},
			onStaged: () => {},
		};
		const { container, rerender } = render(
			<TextFileEditor
				{...props}
				comparisonContent={"a\nb\n"}
				changeDiff={"@@ -1,2 +1,2 @@\n a\n-b\n+B\n"}
			/>,
		);
		await waitFor(() => {
			expect(container.querySelector(".cm-content")).not.toBeNull();
		});
		const view = await editorView(container);

		// Edit and save.
		act(() => {
			view.dispatch({ changes: { from: 0, insert: "X\n" } });
		});
		fireEvent.click(await screen.findByRole("button", { name: "Save" }));
		await waitFor(() => {
			expect(saves.length).toBe(1);
		});
		// ChangesPage refetches git's diff after a save.
		rerender(
			<TextFileEditor
				{...props}
				comparisonContent={"a\nb\n"}
				changeDiff={"@@ -1,2 +1,3 @@\n+X\n a\n-b\n+B\n"}
			/>,
		);

		// Stage the new first line, then hand the editor the change context that
		// ChangesPage refetches after a stage.
		act(() => {
			view.dispatch({ selection: { anchor: 0 } });
		});
		const stage = screen.getByRole("button", { name: "Stage" });
		await waitFor(() => {
			expect(stage.hasAttribute("disabled")).toBe(false);
		});
		fireEvent.click(stage);
		await waitFor(() => {
			expect(stages).toBe(1);
		});
		rerender(
			<TextFileEditor
				{...props}
				comparisonContent={"X\na\nb\n"}
				changeDiff={"@@ -1,3 +1,3 @@\n X\n a\n-b\n+B\n"}
			/>,
		);
		await waitFor(() => {
			expect(container.querySelectorAll(".cm-changedLine--added").length).toBe(
				1,
			);
		});

		// Edit and save again.
		const after = await editorView(container);
		act(() => {
			after.dispatch({
				changes: { from: after.state.doc.length, insert: "Y\n" },
			});
		});
		const save = screen.getByRole("button", { name: "Save" });
		await waitFor(() => {
			expect(save.hasAttribute("disabled")).toBe(false);
		});
		fireEvent.click(save);
		await waitFor(() => {
			expect(saves.length).toBe(2);
		});

		expect(saves[1]).toBe("X\na\nB\nY\n");
	});
});

describe("emptied files", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		cleanup();
		globalThis.fetch = originalFetch;
	});

	test("opens a tracked file whose every line was deleted", async () => {
		globalThis.fetch = (async () =>
			new Response("", {
				headers: { "x-file-mtime-ms": "1" },
			})) as typeof fetch;

		const { container } = render(
			<TextFileEditor
				filePath="notes.txt"
				repo="test-repo"
				changeType="modified"
				changeDiff={
					"--- a/notes.txt\n+++ b/notes.txt\n@@ -1,2 +0,0 @@\n-a\n-b\n"
				}
			/>,
		);

		await waitFor(() => {
			expect(container.querySelector(".cm-deletedChunk")).not.toBeNull();
		});
		expect(container.querySelector(".text-file-editor-error")).toBeNull();
	});
});

describe("deleted files", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		cleanup();
		globalThis.fetch = originalFetch;
	});

	async function renderDeleted(
		props: Partial<Parameters<typeof TextFileEditor>[0]> = {},
	) {
		const contentUrls: string[] = [];
		globalThis.fetch = (async (input: string) => {
			contentUrls.push(input);
			return new Response("gone line 1\ngone line 2\n", {
				headers: { "x-file-mtime-ms": "1" },
			});
		}) as unknown as typeof fetch;

		const { container } = render(
			<TextFileEditor
				filePath="notes.txt"
				repo="test-repo"
				changeType="deleted"
				deleted
				{...props}
			/>,
		);
		await waitFor(() => {
			expect(container.querySelector(".cm-content")).not.toBeNull();
		});
		return { container, contentUrls };
	}

	test("loads the index blob for an unstaged deletion and strikes every line", async () => {
		const { container, contentUrls } = await renderDeleted();

		expect(
			contentUrls.some(
				(url) =>
					url.includes("/api/git/base-content") && url.includes("staged=false"),
			),
		).toBe(true);
		await waitFor(() => {
			expect(
				container.querySelector(".cm-changedLine--deleted"),
			).not.toBeNull();
		});
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Stage" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Unstage" })).toBeNull();
	});

	test("loads the HEAD blob for a staged deletion", async () => {
		const { contentUrls } = await renderDeleted({ staged: true });

		expect(
			contentUrls.some(
				(url) =>
					url.includes("/api/git/base-content") && url.includes("staged=true"),
			),
		).toBe(true);
	});
});

describe("line wrapping", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.localStorage.clear();
		globalThis.fetch = (async () =>
			new Response("alpha\nbeta\n", {
				headers: { "x-file-mtime-ms": "1" },
			})) as typeof fetch;
	});

	afterEach(() => {
		cleanup();
		globalThis.fetch = originalFetch;
	});

	async function renderEditor() {
		const { container } = render(
			<TextFileEditor filePath="notes.md" repo="test-repo" />,
		);
		await waitFor(() => {
			expect(container.querySelector(".cm-content")).not.toBeNull();
		});
		return container;
	}

	function isWrapping(container: HTMLElement) {
		return container
			.querySelector(".cm-content")
			?.classList.contains("cm-lineWrapping");
	}

	test("wraps by default", async () => {
		const container = await renderEditor();

		expect(isWrapping(container)).toBe(true);
	});

	test("toggling off reconfigures the editor and stores the choice", async () => {
		const container = await renderEditor();

		fireEvent.click(
			screen.getByRole("button", { name: "Disable line wrapping" }),
		);

		await waitFor(() => {
			expect(isWrapping(container)).toBe(false);
		});
		expect(globalThis.localStorage.getItem("rift:editor-line-wrap")).toBe(
			"false",
		);
	});

	test("restores a stored preference of off", async () => {
		globalThis.localStorage.setItem("rift:editor-line-wrap", "false");

		const container = await renderEditor();

		expect(isWrapping(container)).toBe(false);
	});
});

describe("saving", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		cleanup();
		globalThis.fetch = originalFetch;
	});

	async function editAndSave(fileContent: string) {
		const requests: RequestInit[] = [];
		globalThis.fetch = (async (_input: string, init?: RequestInit) => {
			if (init?.method === "PUT") {
				requests.push(init);
				return new Response(JSON.stringify({ mtimeMs: 2 }), {
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(fileContent, {
				headers: { "x-file-mtime-ms": "1" },
			});
		}) as unknown as typeof fetch;

		const { container } = render(
			<TextFileEditor filePath="notes.md" repo="test-repo" />,
		);
		await waitFor(() => {
			expect(container.querySelector(".cm-content")).not.toBeNull();
		});

		const { EditorView } = await import("@codemirror/view");
		const view = EditorView.findFromDOM(
			container.querySelector(".cm-editor") as HTMLElement,
		);
		act(() => {
			view?.dispatch({ changes: { from: 0, insert: "new line\n" } });
		});

		const save = await screen.findByRole("button", { name: "Save" });
		await waitFor(() => {
			expect(save.hasAttribute("disabled")).toBe(false);
		});
		fireEvent.click(save);

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		return JSON.parse(requests[0].body as string).content as string;
	}

	test("keeps a CRLF file in CRLF", async () => {
		expect(await editAndSave("alpha\r\nbeta\r\n")).toBe(
			"new line\r\nalpha\r\nbeta\r\n",
		);
	});

	test("keeps an LF file in LF", async () => {
		expect(await editAndSave("alpha\nbeta\n")).toBe("new line\nalpha\nbeta\n");
	});
});
