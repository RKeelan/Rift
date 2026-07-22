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
	TextFileEditor,
	getEditorChangeDecorations,
} from "../components/TextFileEditor.tsx";

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
