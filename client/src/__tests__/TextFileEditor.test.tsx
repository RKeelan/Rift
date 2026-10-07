import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import {
	getChangeRegions,
	getEditorChangeDecorations,
	getLineChanges,
	getWordMarks,
	TextFileEditor,
	WRITES_UNKNOWN_LABEL,
} from "../components/TextFileEditor.tsx";
import { clearDraft, hashText, readDraft, writeDraft } from "../drafts.ts";
import { GIT_DIFF_CASES } from "./gitDiffCases.ts";

// git's diff for "a\nb\nc\n" becoming "a\nB\nc\n".
const B_MODIFIED_DIFF = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";
// The same diff with its headers, as `git diff --full-index` prints it.
const B_MODIFIED_BLOBS = `${"1".repeat(40)}..${"2".repeat(40)}`;
const B_MODIFIED_DIFF_WITH_BLOBS = `diff --git a/notes.txt b/notes.txt\nindex ${B_MODIFIED_BLOBS} 100644\n--- a/notes.txt\n+++ b/notes.txt\n${B_MODIFIED_DIFF}`;

// git's diff of a new file against nothing, as `git diff --no-index` prints
// it for an untracked file and `git diff --cached` for a staged one.
const NEW_FILE_BLOBS = `${"0".repeat(40)}..${"3".repeat(40)}`;
function newFileDiff(...hunk: string[]): string {
	return [
		"diff --git a/notes.txt b/notes.txt",
		"new file mode 100644",
		`index ${NEW_FILE_BLOBS}`,
		"--- /dev/null",
		"+++ b/notes.txt",
		...hunk,
		"",
	].join("\n");
}
const NEW_FILE = {
	file: "one\ntwo\nthree\n",
	comparison: "",
	diff: newFileDiff("@@ -0,0 +1,3 @@", "+one", "+two", "+three"),
};

function gitCase(name: string) {
	const found = GIT_DIFF_CASES.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`no case named ${name}`);
	return found;
}

type View = import("@codemirror/view").EditorView;

// Selects the whole of the given lines, as a drag across them would. A bare
// cursor selects nothing to stage or unstage.
function selectLines(view: View, first: number, last = first) {
	act(() => {
		view.dispatch({
			selection: {
				anchor: view.state.doc.line(first).from,
				head: view.state.doc.line(last).to,
			},
		});
	});
}

// The action bar's buttons in order, each named by its label or its text.
function barButtons(container: HTMLElement) {
	const bar = container.querySelector(".text-file-editor-bar");
	if (!bar) throw new Error("no action bar");
	return [...bar.children]
		.map((child) =>
			child.classList.contains("text-file-editor-menu")
				? child.querySelector("button")
				: child,
		)
		.filter((child) => child?.tagName === "BUTTON")
		.map((button) => button?.getAttribute("aria-label") ?? button?.textContent);
}

function barStatus(container: HTMLElement) {
	return container.querySelector(".text-file-editor-status")?.textContent;
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
		expect(
			button.hasAttribute("disabled") ||
				button.getAttribute("aria-disabled") === "true",
		).toBe(false);
	});
	return button;
}

// An editor closed with unsaved edits keeps them as a draft in local storage,
// which a later test opening the same file would be offered. This runs after
// each block's own cleanup, which closes the editors.
afterEach(() => {
	globalThis.localStorage.clear();
});

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

	test("marks every line of a new file as added, and none as deleted", () => {
		// Split into lines, the empty comparison would be one empty line, which
		// would show as deleted above a file without a final newline, or match a
		// new empty line and leave it unmarked.
		for (const [current, added] of [
			["a\nb", [1, 2]],
			["\nb\n", [1, 2]],
			["a\n\nb", [1, 2, 3]],
			["a\n", [1]],
			["", []],
		] as const) {
			const decorations = getEditorChangeDecorations({
				currentContent: current,
				loadedContent: current,
				comparisonContent: "",
				changeType: "untracked",
			});

			expect({ current, ...decorations }).toEqual({
				current,
				lineHighlights: added.map((lineNumber) => ({
					kind: "added",
					lineNumber,
				})),
				deletedChunks: [],
				matchesGitDiff: false,
			});
		}
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

		test("follows git's diff of a new file without a final newline", () => {
			const decorations = getEditorChangeDecorations({
				currentContent: "a\nb",
				loadedContent: "a\nb",
				comparisonContent: "",
				changeType: "untracked",
				changeDiff: newFileDiff(
					"@@ -0,0 +1,2 @@",
					"+a",
					"+b",
					"\\ No newline at end of file",
				),
			});

			expect(decorations).toEqual({
				lineHighlights: [
					{ kind: "added", lineNumber: 1 },
					{ kind: "added", lineNumber: 2 },
				],
				deletedChunks: [],
				matchesGitDiff: true,
			});
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

describe("getChangeRegions", () => {
	test("merges adjacent changed lines and splits on a gap", () => {
		const regions = getChangeRegions(
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

		expect(regions).toEqual([
			{ start: 2, end: 3 },
			{ start: 7, end: 7 },
		]);
	});

	test("treats a deletion beside an addition as one region", () => {
		const regions = getChangeRegions(
			{
				lineHighlights: [{ kind: "added", lineNumber: 4 }],
				deletedChunks: [{ anchorIndex: 3, lines: ["old"] }],
			},
			10,
		);

		expect(regions).toEqual([{ start: 4, end: 4 }]);
	});

	test("anchors a pure deletion at the following line", () => {
		const regions = getChangeRegions(
			{
				lineHighlights: [],
				deletedChunks: [{ anchorIndex: 4, lines: ["gone"] }],
			},
			10,
		);

		expect(regions).toEqual([{ start: 5, end: 5 }]);
	});

	test("joins a deletion to an addition just below its unchanged anchor", () => {
		const regions = getChangeRegions(
			{
				lineHighlights: [{ kind: "added", lineNumber: 5 }],
				deletedChunks: [{ anchorIndex: 3, lines: ["gone"] }],
			},
			10,
		);

		expect(regions).toEqual([{ start: 4, end: 5 }]);
	});
});

describe("getWordMarks", () => {
	// Indexed by line number, so line 1 is "the quick red fox".
	const lines = ["", "the quick red fox", "two", "lines", "same"];
	const lineText = (lineNumber: number) => lines[lineNumber];

	test("pairs a changed line with the line it replaced", () => {
		const chunk = { anchorIndex: 0, lines: ["the quick brown fox"] };
		const marks = getWordMarks(
			{
				lineHighlights: [{ kind: "added", lineNumber: 1 }],
				deletedChunks: [chunk],
			},
			lineText,
		);

		expect([...marks.added]).toEqual([[1, [[10, 13]]]]);
		expect(marks.deleted.get(chunk)).toEqual([[[10, 15]]]);
	});

	test("pairs the lines of a multi-line replacement in order", () => {
		const chunk = { anchorIndex: 1, lines: ["one", "lines"] };
		const marks = getWordMarks(
			{
				lineHighlights: [
					{ kind: "added", lineNumber: 2 },
					{ kind: "added", lineNumber: 3 },
				],
				deletedChunks: [chunk],
			},
			lineText,
		);

		// "one" and "two" share nothing, so that pair is left unmarked, and
		// "lines" is unchanged, so it has nothing to mark.
		expect(marks.deleted.get(chunk)).toEqual([null, []]);
		expect(marks.added.has(2)).toBe(false);
		expect(marks.added.get(3)).toEqual([]);
	});

	test("leaves a change that adds more lines than it removes unmarked", () => {
		const chunk = { anchorIndex: 1, lines: ["one"] };
		const marks = getWordMarks(
			{
				lineHighlights: [
					{ kind: "added", lineNumber: 2 },
					{ kind: "added", lineNumber: 3 },
				],
				deletedChunks: [chunk],
			},
			lineText,
		);

		expect(marks.added.size).toBe(0);
		expect(marks.deleted.size).toBe(0);
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

	test("opens at the first change, and Next and Previous cycle through the changes", async () => {
		const view = await renderWithChanges();

		const next = screen.getByRole("button", { name: "Next change" });
		const previous = screen.getByRole("button", { name: "Previous change" });

		await waitFor(() => {
			expect(selectedLine(view)).toBe(2);
		});

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

	// The comparison arrives after the file, as it does from the server.
	async function renderWithLateComparison() {
		globalThis.fetch = (async () =>
			new Response("a\nB\nc\nD\ne\n", {
				headers: { "x-file-mtime-ms": "1" },
			})) as typeof fetch;

		const props = { filePath: "notes.txt", repo: "test-repo" };
		const { container, rerender } = render(<TextFileEditor {...props} />);
		await waitFor(() => {
			expect(container.querySelector(".cm-content")).not.toBeNull();
		});
		const { EditorView } = await import("@codemirror/view");
		const view = EditorView.findFromDOM(
			container.querySelector(".cm-editor") as HTMLElement,
		);
		if (!view) throw new Error("editor view not found");
		const addComparison = () =>
			rerender(
				<TextFileEditor {...props} comparisonContent={"a\nb\nc\nd\ne\n"} />,
			);
		return { view, addComparison };
	}

	test("opens at the first change once the comparison arrives", async () => {
		const { view, addComparison } = await renderWithLateComparison();
		expect(selectedLine(view)).toBe(1);

		addComparison();

		await waitFor(() => {
			expect(selectedLine(view)).toBe(2);
		});
	});

	test("leaves a reader who has already moved the cursor where they are", async () => {
		const { view, addComparison } = await renderWithLateComparison();
		act(() => {
			view.dispatch({ selection: { anchor: view.state.doc.line(5).from } });
		});

		addComparison();
		await screen.findByRole("button", { name: "Next change" });

		expect(selectedLine(view)).toBe(5);
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

		selectLines(view, 2);

		fireEvent.click(await enabledButton("Stage selection"));

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(JSON.parse(requests[0].body as string)).toEqual({
			path: "notes.txt",
			ranges: [[2, 2]],
		});
	});

	test("names the diff its line numbers come from", async () => {
		const { view, requests } = await renderForStaging({
			changeDiff: B_MODIFIED_DIFF_WITH_BLOBS,
		});
		selectLines(view, 2);

		fireEvent.click(await enabledButton("Stage selection"));

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(JSON.parse(requests[0].body as string)).toEqual({
			path: "notes.txt",
			ranges: [[2, 2]],
			expectedBlobs: B_MODIFIED_BLOBS,
		});
	});

	test("explains a refusal because the file changed since it was loaded", async () => {
		let staged = 0;
		const { view } = await renderForStaging({
			changeDiff: B_MODIFIED_DIFF_WITH_BLOBS,
			onStaged: () => {
				staged += 1;
			},
		});
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					error: {
						code: "DIFF_CHANGED",
						message: "The diff changed since it was read",
					},
				}),
				{ status: 409, headers: { "Content-Type": "application/json" } },
			)) as unknown as typeof fetch;
		selectLines(view, 2);

		fireEvent.click(await enabledButton("Stage selection"));

		expect(
			await screen.findByText(
				"The file changed since it was loaded. Reload before staging.",
			),
		).toBeDefined();
		expect(staged).toBe(0);
	});

	test("stages an untracked file whole, without ranges", async () => {
		const { requests } = await renderForStaging({
			changeType: "untracked",
			comparisonContent: "",
			changeDiff: null,
		});

		fireEvent.click(await enabledButton("Stage file"));

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(JSON.parse(requests[0].body as string)).toEqual({
			path: "notes.txt",
			expectedMtimeMs: 1,
		});
	});

	test("stages an empty untracked file, which marks no lines", async () => {
		const { view, requests } = await renderForStaging(
			{
				changeType: "untracked",
				comparisonContent: "",
				// An empty file's diff has headers but no hunk.
				changeDiff: newFileDiff(),
			},
			"",
		);

		const stageFile = await enabledButton("Stage file");
		// With no lines, there is nothing to pick or to stage by line.
		expect(view.dom.querySelector(".cm-pickTarget") === null).toBe(true);
		expect(view.dom.querySelector(".cm-changeStrip") === null).toBe(true);
		fireEvent.click(stageFile);

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(JSON.parse(requests[0].body as string)).toEqual({
			path: "notes.txt",
			expectedMtimeMs: 1,
		});
	});

	test("hands on the repo's changes that a stage answers with", async () => {
		const changes = [
			{ path: "notes.txt", status: "modified", staged: true },
			{ path: "notes.txt", status: "modified", staged: false },
		];
		const handed: unknown[] = [];
		const { view } = await renderForStaging({
			onStaged: (files) => handed.push(files),
		});
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ files: changes }), {
				headers: { "Content-Type": "application/json" },
			})) as unknown as typeof fetch;
		selectLines(view, 2);

		fireEvent.click(await enabledButton("Stage selection"));

		// The page shows them as they are, without asking for the status again.
		await waitFor(() => {
			expect(handed).toEqual([changes]);
		});
	});

	test("offers Save in place of staging while the buffer is dirty", async () => {
		const { view } = await renderForStaging();
		selectLines(view, 2);
		await enabledButton("Stage selection");

		act(() => {
			view.dispatch({ changes: { from: 0, insert: "x" } });
		});

		// Staging acts on the file as saved, so the edits are saved first.
		await enabledButton("Save");
		expect(
			screen.queryByRole("button", { name: /^Stage (selection|file|\d)/ }) ===
				null,
		).toBe(true);
	});

	test("offers Stage selection only when a selection covers a change", async () => {
		const { view } = await renderForStaging();
		const stageSelection = () =>
			screen.queryByRole("button", { name: "Stage selection" });

		selectLines(view, 1, 2);
		await enabledButton("Stage selection");

		// Line 1 is unchanged, so staging it alone would do nothing.
		selectLines(view, 1);
		expect(stageSelection() === null).toBe(true);

		// A cursor selects nothing, even on a changed line.
		act(() => {
			view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
		});
		expect(stageSelection() === null).toBe(true);
	});

	test("hides the Stage button without an onStaged handler", async () => {
		const { view } = await renderForStaging({ onStaged: undefined });
		await screen.findByRole("button", { name: "Next change" });

		selectLines(view, 2);

		expect(screen.queryByRole("button", { name: /^Stage/ }) === null).toBe(
			true,
		);
	});

	test("waits for the comparison and git's diff before staging by line", async () => {
		const first = await renderForStaging({ changeDiff: null });
		selectLines(first.view, 2);

		const stage = await screen.findByRole("button", {
			name: "Stage selection",
		});
		expect(stage.hasAttribute("disabled")).toBe(true);

		cleanup();
		const second = await renderForStaging({ comparisonContent: undefined });
		selectLines(second.view, 2);

		expect(
			(
				await screen.findByRole("button", { name: "Stage selection" })
			).hasAttribute("disabled"),
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
		return { container, view, requests, contentUrls };
	}

	test("loads the index content and offers Unstage in place of Save", async () => {
		const { view, contentUrls } = await renderForUnstaging();
		selectLines(view, 2);

		// The buffer comes from the staged blob, not the working tree.
		expect(
			contentUrls.some(
				(url) =>
					url.includes("/api/git/base-content") && url.includes("staged=false"),
			),
		).toBe(true);
		expect(
			await screen.findByRole("button", { name: "Unstage selection" }),
		).toBeDefined();
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
		expect(screen.queryByRole("button", { name: /^Stage/ }) === null).toBe(
			true,
		);
	});

	test("sends the selected lines as ranges", async () => {
		const { view, requests } = await renderForUnstaging();

		selectLines(view, 2);

		fireEvent.click(await enabledButton("Unstage selection"));

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(JSON.parse(requests[0].body as string)).toEqual({
			path: "notes.txt",
			ranges: [[2, 2]],
		});
	});

	test("names the staged diff its line numbers come from", async () => {
		const { view, requests } = await renderForUnstaging({
			changeDiff: B_MODIFIED_DIFF_WITH_BLOBS,
		});

		selectLines(view, 2);
		fireEvent.click(await enabledButton("Unstage selection"));

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(JSON.parse(requests[0].body as string)).toEqual({
			path: "notes.txt",
			ranges: [[2, 2]],
			expectedBlobs: B_MODIFIED_BLOBS,
		});
	});

	test("explains a refusal because the staged change is different now", async () => {
		let unstaged = 0;
		const { view } = await renderForUnstaging({
			changeDiff: B_MODIFIED_DIFF_WITH_BLOBS,
			onUnstaged: () => {
				unstaged += 1;
			},
		});
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					error: {
						code: "DIFF_CHANGED",
						message: "The diff changed since it was read",
					},
				}),
				{ status: 409, headers: { "Content-Type": "application/json" } },
			)) as unknown as typeof fetch;
		selectLines(view, 2);

		fireEvent.click(await enabledButton("Unstage selection"));

		expect(
			await screen.findByText(
				"The staged change is different now. Reload before unstaging.",
			),
		).toBeDefined();
		// Nothing was unstaged, so the buffer still shows the staged content.
		expect(unstaged).toBe(0);
		expect(view.state.doc.toString()).toBe("a\nB\nc\n");
	});

	test("names the refetched staged diff after unstaging in place", async () => {
		const header = (blobs: string) =>
			`diff --git a/notes.txt b/notes.txt\nindex ${blobs} 100644\n--- a/notes.txt\n+++ b/notes.txt\n`;
		const before = `${"1".repeat(40)}..${"2".repeat(40)}`;
		const after = `${"1".repeat(40)}..${"3".repeat(40)}`;
		let index = "a\nB\nc\nD\n";
		const requests: unknown[] = [];
		globalThis.fetch = (async (_input: string, init?: RequestInit) => {
			if (init?.method === "POST") {
				requests.push(JSON.parse(init.body as string));
				index = "a\nb\nc\nD\n";
				return new Response(JSON.stringify({ files: [] }), {
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(index);
		}) as unknown as typeof fetch;

		const props = {
			filePath: "notes.txt",
			repo: "test-repo",
			comparisonContent: "a\nb\nc\nd\n",
			changeType: "modified" as const,
			staged: true,
			onUnstaged: () => {},
		};
		const { container, rerender } = render(
			<TextFileEditor
				{...props}
				changeDiff={`${header(before)}@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n-d\n+D\n`}
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

		selectLines(view, 2);
		fireEvent.click(await enabledButton("Unstage selection"));
		await waitFor(() => {
			expect(view.state.doc.toString()).toBe("a\nb\nc\nD\n");
		});
		expect(requests[0]).toEqual({
			path: "notes.txt",
			ranges: [[2, 2]],
			expectedBlobs: before,
		});

		// The buffer now holds the new staged content, which the old diff no
		// longer describes, so nothing is unstaged by line until the page hands
		// over the diff it refetches.
		selectLines(view, 4);
		expect(
			(
				await screen.findByRole("button", { name: "Unstage selection" })
			).hasAttribute("disabled"),
		).toBe(true);

		rerender(
			<TextFileEditor
				{...props}
				changeDiff={`${header(after)}@@ -1,4 +1,4 @@\n a\n b\n c\n-d\n+D\n`}
			/>,
		);
		fireEvent.click(await enabledButton("Unstage selection"));
		await waitFor(() => {
			expect(requests.length).toBe(2);
		});
		expect(requests[1]).toEqual({
			path: "notes.txt",
			ranges: [[4, 4]],
			expectedBlobs: after,
		});
	});

	test("unstages a staged new file by line, or whole through the page's action", async () => {
		let unstagedWhole = 0;
		const { container, requests } = await renderForUnstaging(
			{
				changeType: "added",
				comparisonContent: "",
				changeDiff: NEW_FILE.diff,
				fileAction: {
					label: "Unstage file",
					onClick: () => {
						unstagedWhole += 1;
					},
				},
			},
			NEW_FILE.file,
		);

		await waitFor(() => {
			expect(pickTargets(container)).toEqual([
				["line", 1, "+"],
				["line", 2, "+"],
				["line", 3, "+"],
			]);
		});
		fireEvent.click(await enabledButton("Unstage file"));
		expect(unstagedWhole).toBe(1);
		expect(requests.length).toBe(0);

		await tap(container, 2);
		fireEvent.click(await enabledButton("Unstage 1 line"));

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(JSON.parse(requests[0].body as string)).toEqual({
			path: "notes.txt",
			ranges: [[2, 2]],
			expectedBlobs: NEW_FILE_BLOBS,
		});
	});

	test("empties the staged view of a new file once all of it is unstaged", async () => {
		let inIndex = true;
		globalThis.fetch = (async (_input: string, init?: RequestInit) => {
			if (init?.method === "POST") {
				inIndex = false;
				return new Response(JSON.stringify({ files: [] }), {
					headers: { "Content-Type": "application/json" },
				});
			}
			// The index holds nothing of a file it no longer tracks.
			return inIndex
				? new Response(NEW_FILE.file)
				: new Response("Not found", { status: 404 });
		}) as unknown as typeof fetch;

		const { container } = render(
			<TextFileEditor
				filePath="notes.txt"
				repo="test-repo"
				comparisonContent=""
				changeDiff={NEW_FILE.diff}
				changeType="added"
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

		fireEvent.click(await enabledButton("Unstage the change at line 1"));

		await waitFor(() => {
			expect(view.state.doc.toString()).toBe("");
		});
		expect(container.querySelector(".text-file-editor-error") === null).toBe(
			true,
		);
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

		selectLines(view, 2);
		fireEvent.click(await enabledButton("Unstage selection"));

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

		await waitFor(() => {
			expect(
				screen.queryByRole("button", { name: "Stage 1 line" }) === null,
			).toBe(true);
		});
		expect(contentLine(container, 2).classList.contains("cm-pickedLine")).toBe(
			false,
		);
	});

	test("tapping a changed line's number picks it too", async () => {
		const { container } = await renderForPicking();
		const lineNumber = (line: number) =>
			waitFor(() => {
				const found = [
					...container.querySelectorAll<HTMLElement>(
						".cm-lineNumbers .cm-gutterElement",
					),
				].find((element) => element.textContent === String(line));
				if (!found) throw new Error(`no number for line ${line}`);
				return found;
			});

		// Line 1 is unchanged, so its number picks nothing and lets the press
		// through.
		const unchanged = await lineNumber(1);
		expect(fireEvent.mouseDown(unchanged)).toBe(true);
		act(() => {
			fireEvent.click(unchanged);
		});
		expect(screen.queryByRole("button", { name: "Stage 1 line" })).toBeNull();

		// Line 2 is modified, so its number picks it, swallowing the press as
		// the gutter's own target does.
		const changed = await lineNumber(2);
		expect(fireEvent.mouseDown(changed)).toBe(false);
		act(() => {
			fireEvent.click(changed);
		});
		await screen.findByRole("button", { name: "Stage 1 line" });
		expect(contentLine(container, 2).classList.contains("cm-pickedLine")).toBe(
			true,
		);
	});

	test("swallows the press, and takes focus from the editor", async () => {
		const { container, view } = await renderForPicking();

		const target = await waitFor(() => {
			const found = container.querySelector(".cm-pickTarget");
			if (!found) throw new Error("no pick target");
			return found;
		});

		// fireEvent returns false when the handler prevented the default.
		expect(fireEvent.mouseDown(target)).toBe(false);

		// A tap while the editor has focus would raise Android's keyboard. The
		// selection outlasts the focus.
		act(() => view.focus());
		selectLines(view, 1, 2);
		const selection = view.state.selection;
		expect(document.activeElement === view.contentDOM).toBe(true);
		fireEvent.mouseDown(target);
		expect(document.activeElement === view.contentDOM).toBe(false);
		expect(view.state.selection.eq(selection)).toBe(true);
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

	test("names the diff the picked lines come from", async () => {
		const blobs = `${"a".repeat(40)}..${"b".repeat(40)}`;
		const { container, requests } = await renderForPicking(
			{},
			{
				...MODIFIED,
				diff: `diff --git a/notes.txt b/notes.txt\nindex ${blobs} 100644\n--- a/notes.txt\n+++ b/notes.txt\n${MODIFIED.diff}`,
			},
		);

		await tap(container, 4);
		fireEvent.click(await enabledButton("Stage 1 line"));

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(requests[0]).toEqual({
			path: "notes.txt",
			ranges: [[4, 4]],
			expectedBlobs: blobs,
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
			screen.queryByRole("button", { name: "Stage 1 line" }) === null,
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
		const { container, view } = await renderForPicking(
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
		expect(container.querySelector(".cm-pickTarget--waiting")).not.toBeNull();

		// The editor's own diff still shows line 2 as changed, but a selection
		// of it cannot be staged.
		selectLines(view, 2);
		expect(
			(
				await screen.findByRole("button", { name: "Stage selection" })
			).hasAttribute("disabled"),
		).toBe(true);

		await tap(container, 2);
		expect(
			screen.queryByRole("button", { name: "Stage 1 line" }) === null,
		).toBe(true);
	});

	test("says why lines picked before git's diff stopped matching cannot be staged", async () => {
		mockFetch(MODIFIED.file);
		const props = {
			filePath: "notes.txt",
			repo: "test-repo",
			comparisonContent: MODIFIED.comparison,
			changeType: "modified" as const,
			onStaged: () => {},
		};
		const { container, rerender } = render(
			<TextFileEditor {...props} changeDiff={MODIFIED.diff} />,
		);
		await tap(container, 2);
		expect((await enabledButton("Stage 1 line")).hasAttribute("title")).toBe(
			false,
		);

		// git's diff now has "X" on line 2, where the buffer still shows "B".
		rerender(
			<TextFileEditor
				{...props}
				changeDiff={"@@ -1,5 +1,5 @@\n a\n-b\n+X\n c\n-d\n+D\n e\n"}
			/>,
		);

		await waitFor(() => {
			const stage = screen.getByRole("button", { name: "Stage 1 line" });
			expect(stage.hasAttribute("disabled")).toBe(true);
			expect(stage.title).toBe("Git's diff doesn't match this file");
		});
	});

	test("an edit clears the picks", async () => {
		const { container, view } = await renderForPicking();
		await tap(container, 2);
		await screen.findByRole("button", { name: "Stage 1 line" });

		act(() => {
			view.dispatch({ changes: { from: 0, insert: "x" } });
		});

		await screen.findByRole("button", { name: "Save" });
		expect(pickTargets(container).filter(([, , text]) => text === "✓")).toEqual(
			[],
		);
	});

	test("offers a target beside every line of an untracked file", async () => {
		const { container, requests } = await renderForPicking(
			{ changeType: "untracked" },
			NEW_FILE,
		);

		await waitFor(() => {
			expect(pickTargets(container)).toEqual([
				["line", 1, "+"],
				["line", 2, "+"],
				["line", 3, "+"],
			]);
		});
		// With nothing picked, the file stages whole.
		await enabledButton("Stage file");

		await tap(container, 1);
		await tap(container, 3);
		fireEvent.click(await enabledButton("Stage 2 lines"));

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		// The lines are those of the file's diff against nothing, which the
		// server reads in place of its diff against the index.
		expect(requests[0]).toEqual({
			path: "notes.txt",
			ranges: [
				[1, 1],
				[3, 3],
			],
			expectedBlobs: NEW_FILE_BLOBS,
			untracked: true,
		});
	});

	test("offers only Stage file for an untracked file its diff does not describe exactly", async () => {
		// As for a file that is not UTF-8: the server says its diff is not exact.
		const { container } = await renderForPicking(
			{ changeType: "untracked", changeDiffExact: false },
			NEW_FILE,
		);

		await enabledButton("Stage file");
		await waitFor(() => {
			expect(pickTargets(container)).toEqual([]);
		});
		// Its lines are marked from its content, with nothing to stage alone.
		expect(container.querySelectorAll(".cm-changedLine--added").length).toBe(3);
		expect(container.querySelector(".cm-changeStrip") === null).toBe(true);
		expect(container.querySelector(".text-file-editor-notice") === null).toBe(
			true,
		);
	});

	test("offers only Stage file, with no notice, for an untracked file its diff does not describe", async () => {
		// As a clean filter that changes the file's text would.
		const { container } = await renderForPicking(
			{ changeType: "untracked" },
			{
				file: "one\ntwo\n",
				comparison: "",
				diff: newFileDiff("@@ -0,0 +1,2 @@", "+ONE", "+TWO"),
			},
		);

		await enabledButton("Stage file");
		await waitFor(() => {
			expect(pickTargets(container)).toEqual([]);
		});
		expect(container.querySelectorAll(".cm-changedLine--added").length).toBe(2);
		expect(container.querySelector(".cm-changeStrip") === null).toBe(true);
		expect(container.querySelector(".text-file-editor-notice") === null).toBe(
			true,
		);
	});

	test("keeps an untracked file's targets while its buffer is edited", async () => {
		const { container, view } = await renderForPicking(
			{ changeType: "untracked" },
			NEW_FILE,
		);
		await waitFor(() => {
			expect(container.querySelector(".cm-pickTarget--waiting") === null).toBe(
				true,
			);
		});

		act(() => {
			view.dispatch({ changes: { from: 0, insert: "x" } });
		});

		await screen.findByRole("button", { name: "Save" });
		// git's diff no longer describes the buffer, so the targets wait, but
		// they stay, and no notice comes.
		expect(pickTargets(container).length).toBe(3);
		expect(container.querySelector(".text-file-editor-notice") === null).toBe(
			true,
		);
	});

	test("stays in an untracked file staged by line, and leaves one staged whole", async () => {
		let stagedByLine = 0;
		let stagedWhole = 0;
		const { container } = await renderForPicking(
			{
				changeType: "untracked",
				onStaged: () => {
					stagedByLine += 1;
				},
				onFileStaged: () => {
					stagedWhole += 1;
				},
			},
			NEW_FILE,
		);

		await tap(container, 2);
		fireEvent.click(await enabledButton("Stage 1 line"));
		await waitFor(() => {
			expect(stagedByLine).toBe(1);
		});

		fireEvent.click(await enabledButton("Stage file"));
		await waitFor(() => {
			expect(stagedWhole).toBe(1);
		});
		expect(stagedByLine).toBe(1);
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

			expect(barStatus(container)).toBe("Writes are off");
			expect(pickTargets(container)).toEqual([]);
			expect(screen.queryByRole("button", { name: /^Stage/ }) === null).toBe(
				true,
			);
			expect(screen.queryByRole("button", { name: /^Unstage/ }) === null).toBe(
				true,
			);
			expect(container.querySelector(".text-file-editor-notice") === null).toBe(
				true,
			);
			cleanup();
		}
	});

	describe("with a draft from earlier", () => {
		// The draft changes line 3, which is otherwise unchanged.
		const DRAFT = "a\nB\nC\nD\ne\n";

		beforeEach(() => {
			writeDraft("test-repo", "notes.txt", {
				text: DRAFT,
				baseHash: hashText(MODIFIED.file),
			});
		});

		test("offers no targets and no Stage until the offer is answered", async () => {
			const { container, view } = await renderForPicking();
			await screen.findByRole("button", { name: "Restore" });
			await waitFor(() => {
				expect(container.querySelector(".cm-changedLine")).not.toBeNull();
			});

			expect(pickTargets(container)).toEqual([]);
			// Restoring the draft would replace the lines a selection names.
			selectLines(view, 2);
			expect(
				(
					await screen.findByRole("button", { name: "Stage selection" })
				).hasAttribute("disabled"),
			).toBe(true);

			fireEvent.click(screen.getByRole("button", { name: "Discard" }));

			await waitFor(() => {
				expect(pickTargets(container).length).toBe(4);
			});
			await enabledButton("Stage selection");
		});

		test("restoring it edits the buffer in place, as typing would", async () => {
			const { container, view } = await renderForPicking();
			await screen.findByRole("button", { name: "Restore" });
			// The cursor sits on line 4, past the line the draft changes.
			const cursor = view.state.doc.line(4).from + 1;
			act(() => {
				view.dispatch({ selection: { anchor: cursor } });
			});

			fireEvent.click(screen.getByRole("button", { name: "Restore" }));

			await screen.findByText("Unsaved changes");
			expect(view.state.doc.toString()).toBe(DRAFT);
			expect(view.state.selection.main.head).toBe(cursor);
			await waitFor(() => {
				expect(
					contentLine(container, 3).classList.contains("cm-changedLine"),
				).toBe(true);
			});
			// Staging acts on the file as saved, so Save stands in for it.
			await enabledButton("Save");
			expect(
				screen.queryByRole("button", { name: /^Stage (selection|file|\d)/ }) ===
					null,
			).toBe(true);
		});
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
		await waitFor(() => {
			expect(barStatus(container)).toBe("");
		});

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

	test("offers no Unstage for the unseen cursor's line, only for a pick", async () => {
		const { container, view } = await renderForPicking({
			staged: true,
			onStaged: undefined,
			onUnstaged: () => {},
		});
		await waitFor(() => {
			expect(pickTargets(container).length).toBe(4);
		});

		// The non-editable view shows no cursor, so the cursor names nothing to
		// unstage, even on a changed line.
		act(() => {
			view.dispatch({ selection: { anchor: view.state.doc.line(4).from } });
		});
		expect(
			screen.queryByRole("button", { name: /^Unstage (selection|\d)/ }) ===
				null,
		).toBe(true);

		await tap(container, 4);
		await enabledButton("Unstage 1 line");
	});
});

describe("change strips", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		cleanup();
		globalThis.fetch = originalFetch;
	});

	// Line 2 is modified, lines 5 and 6 are added, and "g" is deleted outright,
	// so its deletion anchors to the unchanged "h" on line 9.
	const THREE_CHANGES = {
		file: "a\nB\nc\nd\nX\nY\ne\nf\nh\n",
		comparison: "a\nb\nc\nd\ne\nf\ng\nh\n",
		diff: "@@ -1,8 +1,9 @@\n a\n-b\n+B\n c\n d\n+X\n+Y\n e\n f\n-g\n h\n",
	};

	// With `hold` set, each POST waits for `release`, so a test can look at the
	// editor while a stage is in flight.
	function mockFetch(file: string, hold: boolean) {
		const requests: { url: string; body: unknown }[] = [];
		const pending: (() => void)[] = [];
		globalThis.fetch = (async (input: string, init?: RequestInit) => {
			if (init?.method === "POST") {
				requests.push({ url: input, body: JSON.parse(init.body as string) });
				if (hold) {
					await new Promise<void>((resolve) => pending.push(resolve));
				}
				return new Response(JSON.stringify({ files: [] }), {
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(file, {
				headers: { "x-file-mtime-ms": "1" },
			});
		}) as unknown as typeof fetch;
		return {
			requests,
			release: () => {
				for (const resolve of pending.splice(0)) resolve();
			},
		};
	}

	const baseProps = {
		filePath: "notes.txt",
		repo: "test-repo",
		comparisonContent: THREE_CHANGES.comparison,
		changeType: "modified" as const,
	};

	async function renderWithStrips(
		props: Partial<Parameters<typeof TextFileEditor>[0]> = {},
		{ hold = false, file = THREE_CHANGES.file } = {},
	) {
		const { requests, release } = mockFetch(file, hold);
		const { container, rerender } = render(
			<TextFileEditor
				{...baseProps}
				changeDiff={THREE_CHANGES.diff}
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
		return { container, rerender, view, requests, release };
	}

	function strips(container: HTMLElement) {
		return [...container.querySelectorAll(".cm-changeStrip")].map((strip) => [
			strip.querySelector(".cm-changeStripLabel")?.textContent,
			strip.querySelector("button")?.textContent,
		]);
	}

	function stripStates(container: HTMLElement) {
		return [...container.querySelectorAll(".cm-changeStrip")].map((strip) => [
			strip.querySelector(".cm-changeStripLabel")?.textContent,
			strip.querySelector("button")?.getAttribute("aria-disabled") === "true"
				? "disabled"
				: "enabled",
		]);
	}

	test("draws a strip above each change, naming its first line", async () => {
		const { container } = await renderWithStrips();

		await waitFor(() => {
			expect(strips(container)).toEqual([
				["Line 2", "Stage"],
				["Line 5", "Stage"],
				["Line 9", "Stage"],
			]);
		});
		// A modified line's strip sits above its deleted lines too.
		expect(
			container
				.querySelector(".cm-changeStrip")
				?.nextElementSibling?.classList.contains("cm-deletedChunk"),
		).toBe(true);
	});

	test("stages a change whole, naming the diff it comes from", async () => {
		const blobs = `${"a".repeat(40)}..${"b".repeat(40)}`;
		const { requests } = await renderWithStrips({
			changeDiff: `diff --git a/notes.txt b/notes.txt\nindex ${blobs} 100644\n--- a/notes.txt\n+++ b/notes.txt\n${THREE_CHANGES.diff}`,
		});

		fireEvent.click(await enabledButton("Stage the change at line 5"));

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(requests[0].url).toContain("/api/git/stage");
		expect(requests[0].body).toEqual({
			path: "notes.txt",
			ranges: [[5, 6]],
			expectedBlobs: blobs,
		});
	});

	test("stages a deletion with the line below it", async () => {
		const { requests } = await renderWithStrips();

		fireEvent.click(await enabledButton("Stage the change at line 9"));

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(requests[0].body).toEqual({ path: "notes.txt", ranges: [[9, 9]] });
	});

	test("stages a deletion and the addition below its unchanged anchor together", async () => {
		// git anchors the deletion of "b" to the unchanged "c", and "X" is added
		// just below it, so the two read as one change.
		const { container, requests } = await renderWithStrips(
			{
				comparisonContent: "a\nb\nc\nd\n",
				changeDiff: "@@ -1,4 +1,4 @@\n a\n-b\n c\n+X\n d\n",
			},
			{ file: "a\nc\nX\nd\n" },
		);

		await waitFor(() => {
			expect(strips(container)).toEqual([["Line 2", "Stage"]]);
		});
		fireEvent.click(await enabledButton("Stage the change at line 2"));

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(requests[0].body).toEqual({ path: "notes.txt", ranges: [[2, 3]] });
	});

	test("drops the picks within the change it stages, and keeps the rest", async () => {
		const { container, requests } = await renderWithStrips();
		await tap(container, 2);
		await tap(container, 5);
		await screen.findByRole("button", { name: "Stage 2 lines" });

		fireEvent.click(await enabledButton("Stage the change at line 2"));

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(requests[0].body).toEqual({ path: "notes.txt", ranges: [[2, 2]] });
		expect(await enabledButton("Stage 1 line")).toBeDefined();
	});

	test("follows its change when the context is refetched", async () => {
		const { container, rerender, requests } = await renderWithStrips();
		await enabledButton("Stage the change at line 5");

		// "X" has been staged, so the change at line 5 is now "Y" on line 6.
		rerender(
			<TextFileEditor
				{...baseProps}
				comparisonContent={"a\nb\nc\nd\nX\ne\nf\ng\nh\n"}
				changeDiff={
					"@@ -1,9 +1,9 @@\n a\n-b\n+B\n c\n d\n X\n+Y\n e\n f\n-g\n h\n"
				}
				onStaged={() => {}}
			/>,
		);
		await waitFor(() => {
			expect(strips(container).map(([label]) => label)).toEqual([
				"Line 2",
				"Line 6",
				"Line 9",
			]);
		});

		fireEvent.click(await enabledButton("Stage the change at line 6"));

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(requests[0].body).toEqual({ path: "notes.txt", ranges: [[6, 6]] });
	});

	test("stages after the language support loads", async () => {
		const { language } = await import("@codemirror/language");
		const { view, requests } = await renderWithStrips({
			filePath: "notes.md",
		});
		// Loading the language replaces the editor's state.
		await waitFor(() => {
			expect(view.state.facet(language) !== null).toBe(true);
		});

		fireEvent.click(await enabledButton("Stage the change at line 5"));

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(requests[0].body).toEqual({ path: "notes.md", ranges: [[5, 6]] });
	});

	test("swallows the press, and takes focus from the editor", async () => {
		const { container, view } = await renderWithStrips();
		const strip = await waitFor(() => {
			const found = container.querySelector(".cm-changeStrip");
			if (!found) throw new Error("no change strip");
			return found;
		});

		// fireEvent returns false when the handler prevented the default.
		expect(fireEvent.mouseDown(strip)).toBe(false);
		expect(
			fireEvent.mouseDown(await enabledButton("Stage the change at line 2")),
		).toBe(false);

		// A tap while the editor has focus would raise Android's keyboard. The
		// selection outlasts the focus.
		act(() => view.focus());
		selectLines(view, 1, 2);
		const selection = view.state.selection;
		expect(document.activeElement === view.contentDOM).toBe(true);
		fireEvent.mouseDown(strip);
		expect(document.activeElement === view.contentDOM).toBe(false);
		expect(view.state.selection.eq(selection)).toBe(true);
	});

	test("disables the strips while a stage is in flight", async () => {
		const { container, release, requests } = await renderWithStrips(
			{},
			{ hold: true },
		);

		fireEvent.click(await enabledButton("Stage the change at line 2"));

		await waitFor(() => {
			expect(stripStates(container).map(([, state]) => state)).toEqual([
				"disabled",
				"disabled",
				"disabled",
			]);
		});
		// A disabled strip still swallows the press, and its button does nothing.
		const other = screen.getByRole("button", {
			name: "Stage the change at line 5",
		});
		expect(fireEvent.mouseDown(other)).toBe(false);
		fireEvent.click(other);
		expect(requests.length).toBe(1);

		act(() => release());
		await enabledButton("Stage the change at line 5");
	});

	test("keeps its strips in place, disabled, while git's diff does not describe the buffer", async () => {
		const { container, rerender, view, requests } = await renderWithStrips({
			changeDiff: null,
		});
		await screen.findByRole("button", { name: "Next change" });
		// Only git's diff names lines that staging acts on.
		expect(strips(container)).toEqual([]);

		const withDiff = (changeDiff: string | null) =>
			rerender(
				<TextFileEditor
					{...baseProps}
					changeDiff={changeDiff}
					onStaged={() => {}}
				/>,
			);
		withDiff(THREE_CHANGES.diff);
		await enabledButton("Stage the change at line 5");

		// Refetching the context, as after a stage, leaves them where they are.
		withDiff(null);
		await waitFor(() => {
			expect(stripStates(container)).toEqual([
				["Line 2", "disabled"],
				["Line 5", "disabled"],
				["Line 9", "disabled"],
			]);
		});
		withDiff(THREE_CHANGES.diff);
		await enabledButton("Stage the change at line 5");

		// Unsaved edits move them with the text below them, and start no new
		// ones.
		act(() => {
			view.dispatch({ changes: { from: 0, insert: "x\n" } });
		});
		await screen.findByRole("button", { name: "Save" });
		expect(stripStates(container)).toEqual([
			["Line 3", "disabled"],
			["Line 6", "disabled"],
			["Line 10", "disabled"],
		]);
		fireEvent.click(
			screen.getByRole("button", { name: "Stage the change at line 6" }),
		);
		expect(requests.length).toBe(0);
	});

	test("draws one strip above an untracked file, which stages all of it", async () => {
		const { container, view, requests } = await renderWithStrips(
			{
				changeType: "untracked",
				comparisonContent: NEW_FILE.comparison,
				changeDiff: NEW_FILE.diff,
			},
			{ file: NEW_FILE.file },
		);

		await waitFor(() => {
			expect(strips(container)).toEqual([["Line 1", "Stage"]]);
		});
		const strip = container.querySelector(".cm-changeStrip") as HTMLElement;
		// The press takes focus from the editor, so it raises no keyboard.
		act(() => view.focus());
		expect(fireEvent.mouseDown(strip)).toBe(false);
		expect(document.activeElement === view.contentDOM).toBe(false);

		fireEvent.click(await enabledButton("Stage the change at line 1"));

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(requests[0].body).toEqual({
			path: "notes.txt",
			ranges: [[1, 3]],
			expectedBlobs: NEW_FILE_BLOBS,
			untracked: true,
		});
	});

	test("draws no strips without a Stage", async () => {
		for (const props of [
			{ onStaged: undefined },
			{ readOnly: true, readOnlyLabel: "Writes are off" },
		]) {
			const { container } = await renderWithStrips(props);
			await screen.findByRole("button", { name: "Next change" });

			expect(strips(container)).toEqual([]);
			cleanup();
		}
	});

	test("unstages a change whole from the staged view", async () => {
		const { container, requests } = await renderWithStrips({
			staged: true,
			onStaged: undefined,
			onUnstaged: () => {},
		});

		await waitFor(() => {
			expect(strips(container).map(([, button]) => button)).toEqual([
				"Unstage",
				"Unstage",
				"Unstage",
			]);
		});
		fireEvent.click(await enabledButton("Unstage the change at line 5"));

		await waitFor(() => {
			expect(requests.length).toBe(1);
		});
		expect(requests[0].url).toContain("/api/git/unstage");
		expect(requests[0].body).toEqual({ path: "notes.txt", ranges: [[5, 6]] });
	});
});

describe("word marks", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		cleanup();
		globalThis.fetch = originalFetch;
	});

	function markedWords(container: HTMLElement, scope: string) {
		return [...container.querySelectorAll(`${scope} .cm-changedWord`)].map(
			(word) => word.textContent,
		);
	}

	test("marks a modified line's changed words, in the line and in its deleted text", async () => {
		globalThis.fetch = (async () =>
			new Response("the quick red fox\nsame\n", {
				headers: { "x-file-mtime-ms": "1" },
			})) as unknown as typeof fetch;
		const { container } = render(
			<TextFileEditor
				filePath="notes.txt"
				repo="test-repo"
				comparisonContent={"the quick brown fox\nsame\n"}
				changeDiff={
					"@@ -1,2 +1,2 @@\n-the quick brown fox\n+the quick red fox\n same\n"
				}
				changeType="modified"
			/>,
		);

		await waitFor(() => {
			expect(markedWords(container, ".cm-line")).toEqual(["red"]);
			expect(markedWords(container, ".cm-deletedChunk")).toEqual(["brown"]);
		});

		// Unsaved edits are marked the same way.
		const { EditorView } = await import("@codemirror/view");
		const view = EditorView.findFromDOM(
			container.querySelector(".cm-editor") as HTMLElement,
		);
		if (!view) throw new Error("editor view not found");
		act(() => {
			view.dispatch({ changes: { from: 10, to: 13, insert: "green" } });
		});
		await waitFor(() => {
			expect(markedWords(container, ".cm-line")).toEqual(["green"]);
		});
	});
});

describe("action bar", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		cleanup();
		globalThis.fetch = originalFetch;
	});

	// Lines 2 and 4 are modified.
	async function renderBar(
		props: Partial<Parameters<typeof TextFileEditor>[0]> = {},
		respond: () => Promise<Response> = async () =>
			new Response(JSON.stringify({ files: [] }), {
				headers: { "Content-Type": "application/json" },
			}),
	) {
		globalThis.fetch = (async (_input: string, init?: RequestInit) =>
			init?.method === "POST"
				? respond()
				: new Response("a\nB\nc\nD\ne\n", {
						headers: { "x-file-mtime-ms": "1" },
					})) as unknown as typeof fetch;
		const { container } = render(
			<TextFileEditor
				filePath="notes.txt"
				repo="test-repo"
				comparisonContent={"a\nb\nc\nd\ne\n"}
				changeDiff={"@@ -1,5 +1,5 @@\n a\n-b\n+B\n c\n-d\n+D\n e\n"}
				changeType="modified"
				onStaged={() => {}}
				{...props}
			/>,
		);
		await screen.findByRole("button", { name: "Next change" });

		const { EditorView } = await import("@codemirror/view");
		const view = EditorView.findFromDOM(
			container.querySelector(".cm-editor") as HTMLElement,
		);
		if (!view) throw new Error("editor view not found");
		return { container, view };
	}

	function isPrimary(name: string) {
		return screen
			.getByRole("button", { name })
			.classList.contains("text-file-editor-button--primary");
	}

	test("offers the page's file action after the change controls when nothing is picked", async () => {
		let clicks = 0;
		const { container } = await renderBar({
			fileAction: {
				label: "Stage file",
				onClick: () => {
					clicks += 1;
				},
			},
		});

		expect(barStatus(container)).toBe("");
		expect(barButtons(container)).toEqual([
			"More actions",
			"Previous change",
			"Next change",
			"Stage file",
		]);
		expect(isPrimary("Stage file")).toBe(true);

		fireEvent.click(screen.getByRole("button", { name: "Stage file" }));
		expect(clicks).toBe(1);
	});

	test("shows the file action as the page gives it", async () => {
		await renderBar({
			fileAction: {
				label: "Stage file",
				onClick: () => {},
				disabled: true,
				title: "The server does not allow changes",
			},
		});

		const stage = screen.getByRole("button", { name: "Stage file" });
		expect(stage.hasAttribute("disabled")).toBe(true);
		expect(stage.title).toBe("The server does not allow changes");
	});

	test("offers a disabled Save when there is nothing else to do", async () => {
		const { container } = await renderBar();

		expect(barButtons(container)).toEqual([
			"More actions",
			"Previous change",
			"Next change",
			"Save",
		]);
		expect(
			screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
		).toBe(true);
	});

	test("offers no line action for a bare cursor, even on a changed line", async () => {
		const { container, view } = await renderBar({
			fileAction: { label: "Stage file", onClick: () => {} },
		});

		act(() => {
			view.dispatch({ selection: { anchor: view.state.doc.line(2).from + 1 } });
		});

		expect(barButtons(container)).toEqual([
			"More actions",
			"Previous change",
			"Next change",
			"Stage file",
		]);
	});

	test("offers Stage selection ahead of the file action for a selection on a change", async () => {
		const { container, view } = await renderBar({
			fileAction: { label: "Stage file", onClick: () => {} },
		});

		selectLines(view, 2);

		await enabledButton("Stage selection");
		expect(barButtons(container)).toEqual([
			"More actions",
			"Previous change",
			"Next change",
			"Stage selection",
			"Stage file",
		]);
		expect(isPrimary("Stage selection")).toBe(true);
		expect(isPrimary("Stage file")).toBe(false);

		// A selection of unchanged lines names nothing to stage.
		selectLines(view, 3);
		expect(barButtons(container)).toEqual([
			"More actions",
			"Previous change",
			"Next change",
			"Stage file",
		]);
		expect(isPrimary("Stage file")).toBe(true);
	});

	test("offers the picked lines and Clear picks in place of the file action", async () => {
		const { container } = await renderBar({
			fileAction: { label: "Stage file", onClick: () => {} },
		});

		await tap(container, 2);
		await tap(container, 4);

		await enabledButton("Stage 2 lines");
		expect(barButtons(container)).toEqual([
			"More actions",
			"Clear picks",
			"Previous change",
			"Next change",
			"Stage 2 lines",
		]);

		fireEvent.click(screen.getByRole("button", { name: "Clear picks" }));

		await waitFor(() => {
			expect(barButtons(container)).toEqual([
				"More actions",
				"Previous change",
				"Next change",
				"Stage file",
			]);
		});
		expect(pickTargets(container).filter(([, , text]) => text === "✓")).toEqual(
			[],
		);
	});

	test("offers only Save while the buffer holds unsaved edits", async () => {
		const { container, view } = await renderBar({
			fileAction: { label: "Stage file", onClick: () => {} },
		});
		selectLines(view, 2);
		await enabledButton("Stage selection");

		act(() => {
			view.dispatch({
				changes: { from: view.state.doc.length, insert: "f\n" },
			});
		});

		await enabledButton("Save");
		expect(barStatus(container)).toBe("Unsaved changes");
		expect(barButtons(container)).toEqual([
			"More actions",
			"Previous change",
			"Next change",
			"Save",
		]);
		expect(isPrimary("Save")).toBe(true);
	});

	test("says so while the picked lines stage or unstage", async () => {
		for (const [props, label, busy] of [
			[{}, "Stage 1 line", "Staging..."],
			[
				{ staged: true, onStaged: undefined, onUnstaged: () => {} },
				"Unstage 1 line",
				"Unstaging...",
			],
		] as const) {
			let finish = () => {};
			const { container } = await renderBar(
				props,
				() =>
					new Promise<Response>((resolve) => {
						finish = () =>
							resolve(
								new Response(JSON.stringify({ files: [] }), {
									headers: { "Content-Type": "application/json" },
								}),
							);
					}),
			);

			await tap(container, 2);
			fireEvent.click(await enabledButton(label));

			const pending = await screen.findByRole("button", { name: busy });
			expect(pending.hasAttribute("disabled")).toBe(true);

			await act(async () => {
				finish();
			});
			await waitFor(() => {
				expect(screen.queryByRole("button", { name: busy }) === null).toBe(
					true,
				);
			});
			cleanup();
		}
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
		selectLines(view, 1);
		fireEvent.click(await enabledButton("Stage selection"));
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
		expect(barStatus(container)).toBe("Deleted file");
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
		expect(screen.queryByRole("button", { name: /^Stage/ }) === null).toBe(
			true,
		);
		expect(screen.queryByRole("button", { name: /^Unstage/ }) === null).toBe(
			true,
		);
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

	test("every open editor follows the choice", async () => {
		// Both sides of a file are open at once, one of them out of sight.
		const { container } = render(
			<>
				<div data-testid="first">
					<TextFileEditor filePath="notes.md" repo="test-repo" />
				</div>
				<div data-testid="second">
					<TextFileEditor filePath="notes.md" repo="test-repo" staged />
				</div>
			</>,
		);
		await waitFor(() => {
			expect(container.querySelectorAll(".cm-content").length).toBe(2);
		});
		const first = screen.getByTestId("first");
		const second = screen.getByTestId("second");

		fireEvent.click(
			within(first).getByRole("button", { name: "More actions" }),
		);
		fireEvent.click(
			within(first).getByRole("menuitemcheckbox", { name: "Wrap lines" }),
		);

		await waitFor(() => {
			expect(isWrapping(first)).toBe(false);
			expect(isWrapping(second)).toBe(false);
		});
	});

	test("toggling off reconfigures the editor and stores the choice", async () => {
		const container = await renderEditor();
		const more = screen.getByRole("button", { name: "More actions" });

		fireEvent.click(more);
		const wrap = screen.getByRole("menuitemcheckbox", { name: "Wrap lines" });
		expect(wrap.getAttribute("aria-checked")).toBe("true");
		fireEvent.click(wrap);

		await waitFor(() => {
			expect(isWrapping(container)).toBe(false);
		});
		expect(globalThis.localStorage.getItem("rift:editor-line-wrap")).toBe(
			"false",
		);
		// Choosing an item closes the menu, which shows the new state when it
		// opens again.
		expect(screen.queryByRole("menu") === null).toBe(true);
		fireEvent.click(more);
		expect(
			screen
				.getByRole("menuitemcheckbox", { name: "Wrap lines" })
				.getAttribute("aria-checked"),
		).toBe("false");
	});

	test("restores a stored preference of off", async () => {
		globalThis.localStorage.setItem("rift:editor-line-wrap", "false");

		const container = await renderEditor();

		expect(isWrapping(container)).toBe(false);
	});
});

describe("menu", () => {
	const originalFetch = globalThis.fetch;
	let contentUrls: string[] = [];

	beforeEach(() => {
		contentUrls = [];
		globalThis.fetch = (async (input: string) => {
			contentUrls.push(input);
			return new Response("alpha\nbeta\n", {
				headers: { "x-file-mtime-ms": "1" },
			});
		}) as unknown as typeof fetch;
	});

	afterEach(() => {
		cleanup();
		globalThis.fetch = originalFetch;
	});

	async function renderEditor(
		props: Partial<Parameters<typeof TextFileEditor>[0]> = {},
	) {
		const { container } = render(
			<TextFileEditor filePath="notes.md" repo="test-repo" {...props} />,
		);
		await waitFor(() => {
			expect(container.querySelector(".cm-content")).not.toBeNull();
		});
		return container;
	}

	function menuItems() {
		return [...screen.getByRole("menu").querySelectorAll("button")].map(
			(item) => [item.getAttribute("role"), item.textContent],
		);
	}

	test("opens from More actions at the start of the bar, and closes again", async () => {
		const container = await renderEditor();
		const more = screen.getByRole("button", { name: "More actions" });
		expect(more.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByRole("menu") === null).toBe(true);

		fireEvent.click(more);

		expect(more.getAttribute("aria-expanded")).toBe("true");
		expect(
			container
				.querySelector(".text-file-editor-bar")
				?.firstElementChild?.contains(screen.getByRole("menu")),
		).toBe(true);
		expect(menuItems()).toEqual([
			["menuitemcheckbox", "Wrap lines"],
			["menuitem", "Reload"],
		]);

		fireEvent.click(more);
		expect(screen.queryByRole("menu") === null).toBe(true);
	});

	test("Reload rereads the file and closes the menu", async () => {
		let reloads = 0;
		await renderEditor({
			onReload: () => {
				reloads += 1;
			},
		});
		expect(contentUrls.length).toBe(1);

		fireEvent.click(screen.getByRole("button", { name: "More actions" }));
		fireEvent.click(screen.getByRole("menuitem", { name: "Reload" }));

		await waitFor(() => {
			expect(contentUrls.length).toBe(2);
		});
		expect(contentUrls[1]).toContain("_reload=1");
		expect(reloads).toBe(1);
		expect(screen.queryByRole("menu") === null).toBe(true);
	});

	test("closes on a tap outside it, but not on one inside it", async () => {
		const container = await renderEditor();
		const more = screen.getByRole("button", { name: "More actions" });
		fireEvent.click(more);

		fireEvent.pointerDown(screen.getByRole("menu"));
		fireEvent.pointerDown(more);
		expect(screen.queryByRole("menu") === null).toBe(false);

		fireEvent.pointerDown(container.querySelector(".cm-content") as Element);
		expect(screen.queryByRole("menu") === null).toBe(true);
		expect(more.getAttribute("aria-expanded")).toBe("false");
	});

	test("goes in the page's host for it when given one", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		try {
			const container = await renderEditor({ menuHost: host });
			const more = screen.getByRole("button", { name: "More actions" });
			expect(host.contains(more)).toBe(true);
			expect(container.contains(more)).toBe(false);

			fireEvent.click(more);
			expect(host.contains(screen.getByRole("menu"))).toBe(true);

			// A tap in the editor is outside the menu, wherever the menu is.
			fireEvent.pointerDown(container.querySelector(".cm-content") as Element);
			expect(screen.queryByRole("menu") === null).toBe(true);
		} finally {
			cleanup();
			host.remove();
		}
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

	describe("drafts", () => {
		const REPO = "test-repo";
		const PATH = "notes.md";
		// Drafts are written once typing pauses for half a second.
		const PAUSE_MS = 650;

		beforeEach(() => {
			globalThis.localStorage.clear();
		});

		function saved() {
			return new Response(JSON.stringify({ mtimeMs: 2 }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		async function renderEditable(
			onDisk: string,
			save: () => Promise<Response> = async () => saved(),
		) {
			globalThis.fetch = (async (_input: string, init?: RequestInit) => {
				if (init?.method === "PUT") {
					return save();
				}
				return new Response(onDisk, { headers: { "x-file-mtime-ms": "1" } });
			}) as unknown as typeof fetch;

			const rendered = render(<TextFileEditor filePath={PATH} repo={REPO} />);
			await waitFor(() => {
				expect(rendered.container.querySelector(".cm-content")).not.toBeNull();
			});
			const { EditorView } = await import("@codemirror/view");
			const view = EditorView.findFromDOM(
				rendered.container.querySelector(".cm-editor") as HTMLElement,
			);
			if (!view) throw new Error("editor view not found");
			return { ...rendered, view };
		}

		function pause(ms: number) {
			return new Promise((resolve) => setTimeout(resolve, ms));
		}

		test("keeps unsaved edits as a draft once typing pauses, until they are saved", async () => {
			const { view } = await renderEditable("alpha\n");

			act(() => {
				view.dispatch({ changes: { from: 0, insert: "x" } });
			});
			expect(readDraft(REPO, PATH)).toBeNull();
			await pause(PAUSE_MS);
			expect(readDraft(REPO, PATH)).toEqual({
				text: "xalpha\n",
				baseHash: hashText("alpha\n"),
			});

			const save = screen.getByRole("button", { name: "Save" });
			await waitFor(() => {
				expect(save.hasAttribute("disabled")).toBe(false);
			});
			fireEvent.click(save);
			await waitFor(() => {
				expect(readDraft(REPO, PATH)).toBeNull();
			});
		});

		test("keeps edits made while a save is in flight unsaved, as a draft of the saved text", async () => {
			let finishSave = () => {};
			const { view } = await renderEditable(
				"alpha\n",
				() =>
					new Promise<Response>((resolve) => {
						finishSave = () => resolve(saved());
					}),
			);

			act(() => {
				view.dispatch({ changes: { from: 0, insert: "x" } });
			});
			const save = screen.getByRole("button", { name: "Save" });
			await waitFor(() => {
				expect(save.hasAttribute("disabled")).toBe(false);
			});
			fireEvent.click(save);
			await screen.findByRole("button", { name: "Saving..." });
			act(() => {
				view.dispatch({ changes: { from: 0, insert: "y" } });
			});
			await act(async () => {
				finishSave();
			});

			await screen.findByRole("button", { name: "Save" });
			expect(view.state.doc.toString()).toBe("yxalpha\n");
			expect(screen.getByText("Unsaved changes")).toBeDefined();
			await pause(PAUSE_MS);
			expect(readDraft(REPO, PATH)).toEqual({
				text: "yxalpha\n",
				baseHash: hashText("xalpha\n"),
			});
		});

		describe("a save answered after the buffer is loaded afresh", () => {
			const OTHER = "other.md";

			// Serves each file with its own mtime, holding every save until the
			// test lets it finish.
			function mockFiles(
				files: Record<string, { text: string; mtime: number }>,
			) {
				const saves: { path: string; expectedMtimeMs: number }[] = [];
				let finishSave = () => {};
				globalThis.fetch = (async (input: string, init?: RequestInit) => {
					const path = new URL(input, "http://rift.test").searchParams.get(
						"path",
					) as string;
					if (init?.method === "PUT") {
						const { expectedMtimeMs } = JSON.parse(init.body as string);
						saves.push({ path, expectedMtimeMs });
						return new Promise<Response>((resolve) => {
							finishSave = () => resolve(saved());
						});
					}
					return new Response(files[path].text, {
						headers: { "x-file-mtime-ms": String(files[path].mtime) },
					});
				}) as unknown as typeof fetch;
				return { saves, finishSave: () => finishSave() };
			}

			async function currentView(container: HTMLElement) {
				const { EditorView } = await import("@codemirror/view");
				return await waitFor(() => {
					const editor = container.querySelector<HTMLElement>(".cm-editor");
					const view = editor ? EditorView.findFromDOM(editor) : null;
					if (!view) throw new Error("editor view not found");
					return view;
				});
			}

			async function editAndStartSave(container: HTMLElement) {
				const view = await currentView(container);
				act(() => {
					view.dispatch({ changes: { from: 0, insert: "x" } });
				});
				const save = screen.getByRole("button", { name: "Save" });
				await waitFor(() => {
					expect(save.hasAttribute("disabled")).toBe(false);
				});
				fireEvent.click(save);
				await screen.findByRole("button", { name: "Saving..." });
			}

			async function opened(container: HTMLElement, text: string) {
				await waitFor(async () => {
					expect((await currentView(container)).state.doc.toString()).toBe(
						text,
					);
				});
			}

			test("leaves another file opened meanwhile alone", async () => {
				const server = mockFiles({
					[PATH]: { text: "alpha\n", mtime: 1 },
					[OTHER]: { text: "bravo\n", mtime: 7 },
				});
				const { container, rerender } = render(
					<TextFileEditor filePath={PATH} repo={REPO} />,
				);
				await editAndStartSave(container);

				rerender(<TextFileEditor filePath={OTHER} repo={REPO} />);
				await opened(container, "bravo\n");
				await act(async () => {
					server.finishSave();
				});
				await pause(PAUSE_MS);

				expect(barStatus(container)).toBe("");
				expect(readDraft(REPO, OTHER)).toBeNull();
				// The saved file's draft, kept as it was left, held just what was
				// saved.
				expect(readDraft(REPO, PATH)).toBeNull();

				// The other file saves against its own mtime.
				await editAndStartSave(container);
				expect(server.saves.at(-1)).toEqual({
					path: OTHER,
					expectedMtimeMs: 7,
				});
			});

			test("keeps no draft of the text from before the save when the file loads again", async () => {
				// The server has not written the save when the file loads again, so
				// the buffer holds the text from before it.
				const server = mockFiles({
					[PATH]: { text: "alpha\n", mtime: 1 },
					[OTHER]: { text: "bravo\n", mtime: 7 },
				});
				const { container, rerender } = render(
					<TextFileEditor filePath={PATH} repo={REPO} />,
				);
				await editAndStartSave(container);
				rerender(<TextFileEditor filePath={OTHER} repo={REPO} />);
				await opened(container, "bravo\n");
				rerender(<TextFileEditor filePath={PATH} repo={REPO} />);
				await opened(container, "alpha\n");

				await act(async () => {
					server.finishSave();
				});
				await pause(PAUSE_MS);

				expect(barStatus(container)).toBe("");
				expect(readDraft(REPO, PATH)?.text).not.toBe("alpha\n");
			});
		});

		describe("a save answered after its editor closed", () => {
			// Holds each save's response until the test releases it, as a stalled
			// connection would. The save reaches the disk as it arrives, or, when
			// the request itself stalled, only with the response.
			function slowServer(initial: string, { writesOnArrival = true } = {}) {
				let disk = initial;
				let mtime = 1;
				let release = () => {};
				globalThis.fetch = (async (_input: string, init?: RequestInit) => {
					if (init?.method === "PUT") {
						const { content } = JSON.parse(init.body as string);
						const write = () => {
							disk = content;
							mtime += 1;
							return mtime;
						};
						const written = writesOnArrival ? write() : null;
						return new Promise<Response>((resolve) => {
							release = () =>
								resolve(
									new Response(
										JSON.stringify({ mtimeMs: written ?? write() }),
										{ headers: { "Content-Type": "application/json" } },
									),
								);
						});
					}
					return new Response(disk, {
						headers: { "x-file-mtime-ms": String(mtime) },
					});
				}) as unknown as typeof fetch;
				return { release: () => release() };
			}

			async function openEditor() {
				const rendered = render(<TextFileEditor filePath={PATH} repo={REPO} />);
				const { EditorView } = await import("@codemirror/view");
				const view = await waitFor(() => {
					const editor =
						rendered.container.querySelector<HTMLElement>(".cm-editor");
					const found = editor ? EditorView.findFromDOM(editor) : null;
					if (!found) throw new Error("editor view not found");
					return found;
				});
				return { ...rendered, view };
			}

			async function typeAndStartSave(
				view: Awaited<ReturnType<typeof openEditor>>["view"],
			) {
				act(() => {
					view.dispatch({ changes: { from: 0, insert: "x" } });
				});
				const save = screen.getByRole("button", { name: "Save" });
				await waitFor(() => {
					expect(save.hasAttribute("disabled")).toBe(false);
				});
				fireEvent.click(save);
				await screen.findByRole("button", { name: "Saving..." });
			}

			test("keeps the edits of the editor that reopened the file", async () => {
				const server = slowServer("alpha\n");
				const first = await openEditor();
				await typeAndStartSave(first.view);
				// A back gesture closes the editor while it saves.
				first.unmount();

				const second = await openEditor();
				await waitFor(() => {
					expect(second.view.state.doc.toString()).toBe("xalpha\n");
				});
				act(() => {
					second.view.dispatch({ changes: { from: 0, insert: "Q" } });
				});
				await screen.findByText("Unsaved changes");

				await act(async () => {
					server.release();
				});
				window.dispatchEvent(new Event("pagehide"));

				expect(readDraft(REPO, PATH)?.text).toBe("Qxalpha\n");
			});

			test("keeps its own older edits out of the reopened editor's draft", async () => {
				const server = slowServer("alpha\n");
				const first = await openEditor();
				await typeAndStartSave(first.view);
				act(() => {
					first.view.dispatch({ changes: { from: 0, insert: "y" } });
				});
				first.unmount();

				const second = await openEditor();
				fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
				await waitFor(() => {
					expect(second.view.state.doc.toString()).toBe("yxalpha\n");
				});
				act(() => {
					second.view.dispatch({ changes: { from: 0, insert: "Q" } });
				});

				await act(async () => {
					server.release();
				});
				window.dispatchEvent(new Event("pagehide"));

				expect(readDraft(REPO, PATH)?.text).toBe("Qyxalpha\n");
			});

			test("keeps the reopened editor's newer edits when its older draft is what was saved", async () => {
				const server = slowServer("alpha\n", { writesOnArrival: false });
				const first = await openEditor();
				await typeAndStartSave(first.view);
				first.unmount();

				// The file reopens before the save reaches the disk, so the closed
				// editor's edits come back as a draft.
				const second = await openEditor();
				fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
				await waitFor(() => {
					expect(second.view.state.doc.toString()).toBe("xalpha\n");
				});
				act(() => {
					second.view.dispatch({ changes: { from: 0, insert: "Q" } });
				});

				await act(async () => {
					server.release();
				});
				window.dispatchEvent(new Event("pagehide"));

				expect(readDraft(REPO, PATH)?.text).toBe("Qxalpha\n");
			});

			test("leaves a discarded draft discarded", async () => {
				const server = slowServer("alpha\n");
				const first = await openEditor();
				await typeAndStartSave(first.view);
				act(() => {
					first.view.dispatch({ changes: { from: 0, insert: "y" } });
				});
				// As the page's Discard does: drop the draft, then close the editor.
				clearDraft(REPO, PATH);
				first.unmount();

				await act(async () => {
					server.release();
				});
				await pause(PAUSE_MS);

				expect(readDraft(REPO, PATH)).toBeNull();
			});
		});

		test("keeps the draft at once when the page hides", async () => {
			const { view } = await renderEditable("alpha\n");
			act(() => {
				view.dispatch({ changes: { from: 0, insert: "x" } });
			});

			const visibility = Object.getOwnPropertyDescriptor(
				document,
				"visibilityState",
			);
			Object.defineProperty(document, "visibilityState", {
				configurable: true,
				get: () => "hidden",
			});
			try {
				document.dispatchEvent(new Event("visibilitychange"));
			} finally {
				if (visibility) {
					Object.defineProperty(document, "visibilityState", visibility);
				} else {
					delete (document as { visibilityState?: unknown }).visibilityState;
				}
			}

			expect(readDraft(REPO, PATH)?.text).toBe("xalpha\n");
		});

		test("keeps the draft at once when the page is left", async () => {
			const { view } = await renderEditable("alpha\n");
			act(() => {
				view.dispatch({ changes: { from: 0, insert: "x" } });
			});

			window.dispatchEvent(new Event("pagehide"));

			expect(readDraft(REPO, PATH)?.text).toBe("xalpha\n");
		});

		test("keeps the draft at once when the editor closes", async () => {
			const { view, unmount } = await renderEditable("alpha\n");
			act(() => {
				view.dispatch({ changes: { from: 0, insert: "x" } });
			});

			unmount();

			expect(readDraft(REPO, PATH)?.text).toBe("xalpha\n");
		});

		test("says so when a draft cannot be kept", async () => {
			// A full store: reads find nothing and every write is refused.
			const full = {
				length: 0,
				key: () => null,
				getItem: () => null,
				removeItem: () => {},
				setItem: () => {
					throw new DOMException("Storage is full", "QuotaExceededError");
				},
			};
			const original = Object.getOwnPropertyDescriptor(window, "localStorage");
			Object.defineProperty(window, "localStorage", {
				configurable: true,
				value: full,
			});
			try {
				const { view } = await renderEditable("alpha\n");
				act(() => {
					view.dispatch({ changes: { from: 0, insert: "x" } });
				});
				act(() => {
					window.dispatchEvent(new Event("pagehide"));
				});

				expect(
					await screen.findByText(
						"This browser couldn't keep a copy of your unsaved edits, so save before leaving the file.",
					),
				).toBeDefined();
			} finally {
				if (original) {
					Object.defineProperty(window, "localStorage", original);
				} else {
					delete (window as { localStorage?: Storage }).localStorage;
				}
			}
		});

		test("offers a draft back when the file is reopened", async () => {
			writeDraft(REPO, PATH, {
				text: "edited\n",
				baseHash: hashText("alpha\n"),
			});

			const { view } = await renderEditable("alpha\n");

			await screen.findByText(
				"Unsaved edits from earlier are kept for this file. Restore or discard them to keep editing.",
			);
			fireEvent.click(screen.getByRole("button", { name: "Restore" }));

			await waitFor(() => {
				expect(view.state.doc.toString()).toBe("edited\n");
			});
			await screen.findByText("Unsaved changes");
		});

		test("keeps the buffer read-only and the draft untouched until the offer is answered", async () => {
			const draft = { text: "edited\n", baseHash: hashText("alpha\n") };
			writeDraft(REPO, PATH, draft);

			const { view } = await renderEditable("alpha\n");
			await screen.findByRole("button", { name: "Restore" });
			await waitFor(() => {
				expect(view.state.readOnly).toBe(true);
			});
			expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");

			// Even a change that gets through leaves the older draft alone.
			act(() => {
				view.dispatch({ changes: { from: 0, insert: "y" } });
			});
			await pause(PAUSE_MS);
			expect(readDraft(REPO, PATH)).toEqual(draft);
			expect(screen.queryByRole("button", { name: "Restore" }) === null).toBe(
				false,
			);

			fireEvent.click(screen.getByRole("button", { name: "Restore" }));
			await waitFor(() => {
				expect(view.state.readOnly).toBe(false);
			});
		});

		test("says so when the file has changed since the draft", async () => {
			writeDraft(REPO, PATH, {
				text: "edited\n",
				baseHash: hashText("alpha\n"),
			});

			await renderEditable("alpha, as an agent left it\n");

			expect(
				await screen.findByText(
					"Unsaved edits from earlier are kept for this file, but the file has changed since. Restoring puts your edited version in place of the current one.",
				),
			).toBeDefined();
		});

		test("offers no draft when the server refuses writes, and keeps it for later", async () => {
			const draft = { text: "edited\n", baseHash: hashText("alpha\n") };
			writeDraft(REPO, PATH, draft);
			globalThis.fetch = (async () =>
				new Response("alpha\n", {
					headers: { "x-file-mtime-ms": "1" },
				})) as unknown as typeof fetch;

			const props = { filePath: PATH, repo: REPO };
			const { container, rerender } = render(<TextFileEditor {...props} />);
			// The server's refusal can arrive after the file has loaded.
			await screen.findByRole("button", { name: "Restore" });

			rerender(
				<TextFileEditor
					{...props}
					readOnly
					readOnlyLabel="Read-only: writes are disabled"
				/>,
			);

			await waitFor(() => {
				expect(screen.queryByRole("button", { name: "Restore" }) === null).toBe(
					true,
				);
			});
			expect(container.querySelector(".text-file-editor-notice") === null).toBe(
				true,
			);
			expect(readDraft(REPO, PATH)).toEqual(draft);
		});

		test("waits for the server to allow writes before offering a draft", async () => {
			const draft = { text: "edited\n", baseHash: hashText("alpha\n") };
			writeDraft(REPO, PATH, draft);
			globalThis.fetch = (async () =>
				new Response("alpha\n", {
					headers: { "x-file-mtime-ms": "1" },
				})) as unknown as typeof fetch;
			const { EditorView } = await import("@codemirror/view");
			function isReadOnly(container: HTMLElement) {
				const editor = container.querySelector<HTMLElement>(".cm-editor");
				return editor ? EditorView.findFromDOM(editor)?.state.readOnly : null;
			}

			// Until the server answers, the file opens read-only, without
			// claiming that writes are disabled.
			const props = { filePath: PATH, repo: REPO };
			const { container, rerender } = render(
				<TextFileEditor
					{...props}
					readOnly
					readOnlyLabel={WRITES_UNKNOWN_LABEL}
				/>,
			);
			await waitFor(() => {
				expect(isReadOnly(container)).toBe(true);
			});
			expect(screen.getByText(WRITES_UNKNOWN_LABEL)).toBeDefined();
			expect(screen.queryByRole("button", { name: "Restore" }) === null).toBe(
				true,
			);
			expect(screen.queryByRole("button", { name: "Save" }) === null).toBe(
				true,
			);

			// An answer that allows writes brings the offer, which holds the
			// buffer until it is answered.
			rerender(<TextFileEditor {...props} />);
			await screen.findByRole("button", { name: "Restore" });
			await waitFor(() => {
				expect(isReadOnly(container)).toBe(true);
			});
			expect(readDraft(REPO, PATH)).toEqual(draft);
		});

		test("discarding the offer drops the draft and unlocks the buffer", async () => {
			writeDraft(REPO, PATH, {
				text: "edited\n",
				baseHash: hashText("alpha\n"),
			});

			const { view } = await renderEditable("alpha\n");

			fireEvent.click(await screen.findByRole("button", { name: "Discard" }));

			expect(readDraft(REPO, PATH)).toBeNull();
			expect(view.state.doc.toString()).toBe("alpha\n");
			await waitFor(() => {
				expect(view.state.readOnly).toBe(false);
			});
		});
	});

	test("reports unsaved edits to its page", async () => {
		const reports: boolean[] = [];
		globalThis.fetch = (async (_input: string, init?: RequestInit) => {
			if (init?.method === "PUT") {
				return new Response(JSON.stringify({ mtimeMs: 2 }), {
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("alpha\n", { headers: { "x-file-mtime-ms": "1" } });
		}) as unknown as typeof fetch;

		const { container } = render(
			<TextFileEditor
				filePath="notes.md"
				repo="test-repo"
				onDirtyChange={(dirty) => reports.push(dirty)}
			/>,
		);
		await waitFor(() => {
			expect(container.querySelector(".cm-content")).not.toBeNull();
		});
		const { EditorView } = await import("@codemirror/view");
		const view = EditorView.findFromDOM(
			container.querySelector(".cm-editor") as HTMLElement,
		);

		act(() => {
			view?.dispatch({ changes: { from: 0, insert: "x" } });
		});
		await waitFor(() => {
			expect(reports.at(-1)).toBe(true);
		});

		const save = screen.getByRole("button", { name: "Save" });
		await waitFor(() => {
			expect(save.hasAttribute("disabled")).toBe(false);
		});
		fireEvent.click(save);
		await waitFor(() => {
			expect(reports.at(-1)).toBe(false);
		});
	});

	test("keeps an LF file in LF", async () => {
		expect(await editAndSave("alpha\nbeta\n")).toBe("new line\nalpha\nbeta\n");
	});
});
