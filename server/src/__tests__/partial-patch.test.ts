import { describe, expect, test } from "bun:test";
import { buildPartialPatch } from "../routes/git.js";

const PREAMBLE = [
	"diff --git a/file.txt b/file.txt",
	"index 1111111..2222222 100644",
	"--- a/file.txt",
	"+++ b/file.txt",
].join("\n");

function diff(...body: string[]): string {
	return `${PREAMBLE}\n${body.join("\n")}\n`;
}

describe("buildPartialPatch", () => {
	test("stages a modification as a unit, dropping the rest", () => {
		const input = diff(
			"@@ -1,4 +1,4 @@",
			" one",
			"-two",
			"+TWO",
			" three",
			"-four",
			"+FOUR",
		);

		expect(buildPartialPatch(input, [[2, 2]])).toBe(
			diff("@@ -1,4 +1,4 @@", " one", "-two", "+TWO", " three", " four"),
		);
	});

	test("stages an addition without the neighbouring modification", () => {
		const input = diff("@@ -1,2 +1,3 @@", " alpha", "-beta", "+BETA", "+gamma");

		expect(buildPartialPatch(input, [[3, 3]])).toBe(
			diff("@@ -1,2 +1,3 @@", " alpha", " beta", "+gamma"),
		);
	});

	test("stages a pure deletion when the line below it is selected", () => {
		const input = diff("@@ -1,3 +1,2 @@", " a", "-b", " c");

		expect(buildPartialPatch(input, [[2, 2]])).toBe(
			diff("@@ -1,3 +1,2 @@", " a", "-b", " c"),
		);
	});

	test("returns null when the selection covers no change", () => {
		const input = diff(
			"@@ -1,4 +1,4 @@",
			" one",
			"-two",
			"+TWO",
			" three",
			"-four",
			"+FOUR",
		);

		// Line 1 is unchanged context, so nothing is staged.
		expect(buildPartialPatch(input, [[1, 1]])).toBeNull();
	});

	test("returns null for an empty diff", () => {
		expect(buildPartialPatch("", [[1, 1]])).toBeNull();
	});

	test("preserves carriage returns in a CRLF diff", () => {
		const input = diff(
			"@@ -1,3 +1,3 @@",
			" one\r",
			"-two\r",
			"+TWO\r",
			" three\r",
		);

		expect(buildPartialPatch(input, [[2, 2]])).toBe(
			diff("@@ -1,3 +1,3 @@", " one\r", "-two\r", "+TWO\r", " three\r"),
		);
	});

	test("drops the no-newline marker of a dropped addition", () => {
		const input = diff(
			"@@ -1,1 +1,3 @@",
			" alpha",
			"+beta",
			"+gamma",
			"\\ No newline at end of file",
		);

		// Selecting beta keeps it; gamma and its trailing marker are dropped.
		expect(buildPartialPatch(input, [[2, 2]])).toBe(
			diff("@@ -1,1 +1,3 @@", " alpha", "+beta"),
		);
	});

	test("keeps the no-newline marker of a kept addition", () => {
		const input = diff(
			"@@ -1,1 +1,3 @@",
			" alpha",
			"+beta",
			"+gamma",
			"\\ No newline at end of file",
		);

		// Selecting gamma drops beta but keeps gamma's trailing marker.
		expect(buildPartialPatch(input, [[3, 3]])).toBe(
			diff(
				"@@ -1,1 +1,3 @@",
				" alpha",
				"+gamma",
				"\\ No newline at end of file",
			),
		);
	});

	test("half-stages a multi-line replacement", () => {
		const input = diff("@@ -1,3 +1,2 @@", "-x1", "-x2", "-x3", "+y1", "+y2");

		expect(buildPartialPatch(input, [[1, 1]])).toBe(
			diff("@@ -1,3 +1,2 @@", "-x1", "-x2", "-x3", "+y1"),
		);
	});

	test("reads a deleted line that begins with dashes as a deletion", () => {
		const input = diff(
			"@@ -1,4 +1,3 @@",
			" a",
			"--- note",
			"-b",
			"-c",
			"+B",
			"+C",
		);

		expect(buildPartialPatch(input, [[3, 3]])).toBe(
			diff("@@ -1,4 +1,3 @@", " a", " -- note", " b", " c", "+C"),
		);
	});

	test("reads an added line that begins with pluses as an addition", () => {
		const input = diff("@@ -1,2 +1,4 @@", " a", "+++i;", "+X", " b");

		expect(buildPartialPatch(input, [[3, 3]])).toBe(
			diff("@@ -1,2 +1,4 @@", " a", "+X", " b"),
		);
	});

	test("anchors the deletions of an emptied file to line 1", () => {
		const input = diff("@@ -1,2 +0,0 @@", "-a", "-b");

		expect(buildPartialPatch(input, [[1, 1]])).toBe(input);
	});

	test("keeps only the hunks a range touches", () => {
		const input = diff(
			"@@ -1,2 +1,2 @@",
			" a",
			"-b",
			"+B",
			"@@ -10,2 +10,2 @@",
			" j",
			"-k",
			"+K",
		);

		// Range 2 selects the first hunk's change; the second hunk is dropped.
		expect(buildPartialPatch(input, [[2, 2]])).toBe(
			diff("@@ -1,2 +1,2 @@", " a", "-b", "+B"),
		);
	});
});

describe("buildPartialPatch (reverse)", () => {
	// Reverse mode reads an index→HEAD diff and reconstructs the index (new)
	// side exactly, so `git apply --cached --reverse` peels the selected lines
	// back out. It mirrors staging: an unselected `+` becomes context and an
	// unselected `-` is dropped.
	test("unstages a modification as a unit, keeping the rest staged", () => {
		const input = diff(
			"@@ -1,4 +1,4 @@",
			" one",
			"-two",
			"+TWO",
			" three",
			"-four",
			"+FOUR",
		);

		expect(buildPartialPatch(input, [[2, 2]], true)).toBe(
			diff("@@ -1,4 +1,4 @@", " one", "-two", "+TWO", " three", " FOUR"),
		);
	});

	test("unstages an addition without the neighbouring modification", () => {
		const input = diff("@@ -1,2 +1,3 @@", " alpha", "-beta", "+BETA", "+gamma");

		expect(buildPartialPatch(input, [[3, 3]], true)).toBe(
			diff("@@ -1,2 +1,3 @@", " alpha", " BETA", "+gamma"),
		);
	});

	test("unstages a staged deletion when the line below it is selected", () => {
		const input = diff("@@ -1,3 +1,2 @@", " a", "-b", " c");

		expect(buildPartialPatch(input, [[2, 2]], true)).toBe(
			diff("@@ -1,3 +1,2 @@", " a", "-b", " c"),
		);
	});

	test("reads a deleted line that begins with dashes as a deletion", () => {
		const input = diff(
			"@@ -1,4 +1,3 @@",
			" a",
			"--- note",
			"-b",
			"-c",
			"+B",
			"+C",
		);

		expect(buildPartialPatch(input, [[3, 3]], true)).toBe(
			diff("@@ -1,4 +1,3 @@", " a", " B", "+C"),
		);
	});

	test("reads an added line that begins with pluses as an addition", () => {
		const input = diff("@@ -1,2 +1,4 @@", " a", "+++i;", "+X", " b");

		expect(buildPartialPatch(input, [[3, 3]], true)).toBe(
			diff("@@ -1,2 +1,4 @@", " a", " ++i;", "+X", " b"),
		);
	});

	test("anchors the deletions of an emptied file to line 1", () => {
		const input = diff("@@ -1,2 +0,0 @@", "-a", "-b");

		expect(buildPartialPatch(input, [[1, 1]], true)).toBe(input);
	});

	test("returns null when the selection covers no staged change", () => {
		const input = diff("@@ -1,2 +1,2 @@", "-alpha", "+ALPHA", " beta");

		// Line 2 is unchanged context, so nothing is unstaged.
		expect(buildPartialPatch(input, [[2, 2]], true)).toBeNull();
	});

	test("keeps the no-newline marker of a surviving context line", () => {
		const input = diff(
			"@@ -1,1 +1,3 @@",
			" alpha",
			"+beta",
			"+gamma",
			"\\ No newline at end of file",
		);

		// Unstaging beta leaves gamma staged, so gamma stays as `+` and keeps its
		// trailing marker.
		expect(buildPartialPatch(input, [[2, 2]], true)).toBe(
			diff(
				"@@ -1,1 +1,3 @@",
				" alpha",
				"+beta",
				" gamma",
				"\\ No newline at end of file",
			),
		);
	});

	test("preserves carriage returns in a CRLF diff", () => {
		const input = diff(
			"@@ -1,3 +1,3 @@",
			" one\r",
			"-two\r",
			"+TWO\r",
			" three\r",
		);

		expect(buildPartialPatch(input, [[2, 2]], true)).toBe(
			diff("@@ -1,3 +1,3 @@", " one\r", "-two\r", "+TWO\r", " three\r"),
		);
	});
});
