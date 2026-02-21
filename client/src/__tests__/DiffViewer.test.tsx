import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { DiffViewer, containsUnifiedDiff } from "../components/DiffViewer.tsx";

afterEach(cleanup);

const SAMPLE_DIFF = `--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 import express from "express";
+import cors from "cors";
 const app = express();
-app.listen(3000);
+app.listen(8080);`;

describe("containsUnifiedDiff", () => {
	test("returns true for a valid unified diff", () => {
		expect(containsUnifiedDiff(SAMPLE_DIFF)).toBe(true);
	});

	test("returns true when diff is embedded in other text", () => {
		const text = `Some preamble text\n${SAMPLE_DIFF}\nTrailing text`;
		expect(containsUnifiedDiff(text)).toBe(true);
	});

	test("returns false for plain text with just ---", () => {
		expect(containsUnifiedDiff("---\nSome content")).toBe(false);
	});

	test("returns false for --- and +++ without file paths", () => {
		expect(containsUnifiedDiff("---\n+++\n@@ something")).toBe(false);
	});

	test("returns false for --- a/file and +++ b/file without @@ hunk header", () => {
		expect(
			containsUnifiedDiff("--- a/file.ts\n+++ b/file.ts\nno hunk header"),
		).toBe(false);
	});

	test("returns false for empty string", () => {
		expect(containsUnifiedDiff("")).toBe(false);
	});

	test("returns false for unrelated content", () => {
		expect(containsUnifiedDiff("Hello world\nfoo bar")).toBe(false);
	});
});

describe("DiffViewer", () => {
	test("returns null for empty diff string", () => {
		const { container } = render(<DiffViewer diff="" />);
		expect(container.innerHTML).toBe("");
	});

	test("renders a <pre> element with diff-viewer class", () => {
		const { container } = render(<DiffViewer diff={SAMPLE_DIFF} />);
		const pre = container.querySelector("pre.diff-viewer");
		expect(pre).not.toBeNull();
	});

	test("renders added lines with diff-add class", () => {
		const { container } = render(<DiffViewer diff={SAMPLE_DIFF} />);
		const addLines = container.querySelectorAll(".diff-add");
		// Two added lines: +import cors and +app.listen(8080)
		expect(addLines.length).toBe(2);
		expect(addLines[0].textContent).toContain('+import cors from "cors";');
		expect(addLines[1].textContent).toContain("+app.listen(8080);");
	});

	test("renders removed lines with diff-remove class", () => {
		const { container } = render(<DiffViewer diff={SAMPLE_DIFF} />);
		const removeLines = container.querySelectorAll(".diff-remove");
		// One removed line: -app.listen(3000)
		expect(removeLines.length).toBe(1);
		expect(removeLines[0].textContent).toContain("-app.listen(3000);");
	});

	test("renders hunk headers with diff-hunk class", () => {
		const { container } = render(<DiffViewer diff={SAMPLE_DIFF} />);
		const hunkLines = container.querySelectorAll(".diff-hunk");
		expect(hunkLines.length).toBe(1);
		expect(hunkLines[0].textContent).toContain("@@ -1,3 +1,4 @@");
	});

	test("does not apply diff-add to +++ header lines", () => {
		const { container } = render(<DiffViewer diff={SAMPLE_DIFF} />);
		const addLines = container.querySelectorAll(".diff-add");
		for (const line of addLines) {
			expect(line.textContent).not.toContain("+++");
		}
	});

	test("does not apply diff-remove to --- header lines", () => {
		const { container } = render(<DiffViewer diff={SAMPLE_DIFF} />);
		const removeLines = container.querySelectorAll(".diff-remove");
		for (const line of removeLines) {
			expect(line.textContent).not.toContain("---");
		}
	});

	test("renders plain (context) lines with only diff-line class", () => {
		const { container } = render(<DiffViewer diff={SAMPLE_DIFF} />);
		const allLines = container.querySelectorAll(".diff-line");
		const contextLines = Array.from(allLines).filter(
			(el) =>
				!el.classList.contains("diff-add") &&
				!el.classList.contains("diff-remove") &&
				!el.classList.contains("diff-hunk"),
		);
		// Context lines: --- a/..., +++ b/..., " import express", " const app"
		expect(contextLines.length).toBeGreaterThan(0);
	});

	test("renders plain text content for non-diff strings", () => {
		const plainText = "Just some regular text\nwith multiple lines";
		const { container } = render(<DiffViewer diff={plainText} />);
		const pre = container.querySelector("pre.diff-viewer");
		expect(pre).not.toBeNull();
		expect(pre?.textContent).toContain("Just some regular text");
		// No coloured lines
		expect(container.querySelectorAll(".diff-add").length).toBe(0);
		expect(container.querySelectorAll(".diff-remove").length).toBe(0);
		expect(container.querySelectorAll(".diff-hunk").length).toBe(0);
	});
});
