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

	test("stages a replaced line with the line it replaces", () => {
		const input = diff(
			"@@ -1,3 +1,3 @@",
			"-x1",
			"-x2",
			"-x3",
			"+y1",
			"+y2",
			"+y3",
		);

		expect(buildPartialPatch(input, [[1, 1]])).toBe(
			diff("@@ -1,3 +1,3 @@", "-x1", "+y1", " x2", " x3"),
		);
		expect(buildPartialPatch(input, [[2, 2]])).toBe(
			diff("@@ -1,3 +1,3 @@", " x1", "-x2", "+y2", " x3"),
		);
		expect(buildPartialPatch(input, [[3, 3]])).toBe(
			diff("@@ -1,3 +1,3 @@", " x1", " x2", "-x3", "+y3"),
		);
		expect(buildPartialPatch(input, [[1, 3]])).toBe(
			diff("@@ -1,3 +1,3 @@", "-x1", "+y1", "-x2", "+y2", "-x3", "+y3"),
		);
	});

	test("stages a run's extra deletions with its last added line", () => {
		const input = diff("@@ -1,3 +1,2 @@", "-x1", "-x2", "-x3", "+y1", "+y2");

		expect(buildPartialPatch(input, [[1, 1]])).toBe(
			diff("@@ -1,3 +1,2 @@", "-x1", "+y1", " x2", " x3"),
		);
		expect(buildPartialPatch(input, [[2, 2]])).toBe(
			diff("@@ -1,3 +1,2 @@", " x1", "-x2", "-x3", "+y2"),
		);
	});

	test("stages a run's extra added lines with no deletion", () => {
		const input = diff("@@ -1,1 +1,3 @@", "-x1", "+y1", "+y2", "+y3");

		expect(buildPartialPatch(input, [[1, 1]])).toBe(
			diff("@@ -1,1 +1,3 @@", "-x1", "+y1"),
		);
		expect(buildPartialPatch(input, [[3, 3]])).toBe(
			diff("@@ -1,1 +1,3 @@", " x1", "+y3"),
		);
	});

	test("gives the index's last line a newline when staging a line after it", () => {
		const input = diff(
			"@@ -1,2 +1,3 @@",
			"-x1",
			"-x2",
			"\\ No newline at end of file",
			"+y1",
			"+y2",
			"+y3",
		);

		// y3 goes after x2, which stays, so x2 needs the newline it lacks.
		expect(buildPartialPatch(input, [[3, 3]])).toBe(
			diff(
				"@@ -1,2 +1,3 @@",
				" x1",
				"-x2",
				"\\ No newline at end of file",
				"+x2",
				"+y3",
			),
		);
		// Nothing is staged after x2, so it stays as context, still without one.
		expect(buildPartialPatch(input, [[1, 1]])).toBe(
			diff(
				"@@ -1,2 +1,3 @@",
				"-x1",
				"+y1",
				" x2",
				"\\ No newline at end of file",
			),
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

		// C goes with b, and with c, the deletion past the run's last added line.
		expect(buildPartialPatch(input, [[3, 3]])).toBe(
			diff("@@ -1,4 +1,3 @@", " a", " -- note", "-b", "-c", "+C"),
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

	test("rebuilds a large run in time linear in its size", () => {
		// A run of 40,000 modified lines takes tens of milliseconds each way,
		// where work quadratic in the run's size takes many seconds.
		const n = 40000;
		const old = Array.from({ length: n }, (_, index) => `-old ${index + 1}`);
		const added = Array.from({ length: n }, (_, index) => `+new ${index + 1}`);
		const input = diff(`@@ -1,${n} +1,${n} @@`, ...old, ...added);

		const start = performance.now();
		const staged = buildPartialPatch(input, [[n, n]]);
		const unstaged = buildPartialPatch(input, [[n, n]], true);
		expect(performance.now() - start).toBeLessThan(2000);

		expect(staged?.endsWith(`-old ${n}\n+new ${n}\n`)).toBe(true);
		expect(unstaged?.endsWith(`-old ${n}\n+new ${n}\n`)).toBe(true);
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
			diff("@@ -1,4 +1,3 @@", " a", " B", "-b", "-c", "+C"),
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

	test("unstages a replaced line with the line it replaces", () => {
		const input = diff(
			"@@ -1,3 +1,3 @@",
			"-x1",
			"-x2",
			"-x3",
			"+y1",
			"+y2",
			"+y3",
		);

		expect(buildPartialPatch(input, [[3, 3]], true)).toBe(
			diff("@@ -1,3 +1,3 @@", " y1", " y2", "-x3", "+y3"),
		);
		expect(buildPartialPatch(input, [[1, 1]], true)).toBe(
			diff("@@ -1,3 +1,3 @@", "-x1", "+y1", " y2", " y3"),
		);
	});

	test("gives HEAD's last line a newline when staged lines stay after it", () => {
		const input = diff(
			"@@ -1,1 +1,2 @@",
			"-x1",
			"\\ No newline at end of file",
			"+y1",
			"+y2",
		);

		// y2 stays staged after x1, so x1 returns to the index with a newline.
		expect(buildPartialPatch(input, [[1, 1]], true)).toBe(
			diff("@@ -1,1 +1,2 @@", "-x1", "+y1", " y2"),
		);
		// Unstaging the whole run returns x1 as HEAD has it.
		expect(buildPartialPatch(input, [[1, 2]], true)).toBe(input);
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

describe("buildPartialPatch (new files)", () => {
	const NEW_FILE = [
		"diff --git a/file.txt b/file.txt",
		"new file mode 100644",
		`index ${"0".repeat(40)}..${"2".repeat(40)}`,
		"--- /dev/null",
		"+++ b/file.txt",
	].join("\n");

	function newFile(...body: string[]): string {
		return `${NEW_FILE}\n${body.join("\n")}\n`;
	}

	test("stages the selected lines as a new file holding just them", () => {
		const input = newFile("@@ -0,0 +1,3 @@", "+one", "+two", "+three");

		expect(buildPartialPatch(input, [[2, 2]])).toBe(
			newFile("@@ -0,0 +1,3 @@", "+two"),
		);
	});

	test("unstages part of a new file as a change to it, keeping the rest", () => {
		const input = newFile("@@ -0,0 +1,3 @@", "+one", "+two", "+three");

		expect(buildPartialPatch(input, [[2, 2]], true)).toBe(
			[
				"diff --git a/file.txt b/file.txt",
				"--- b/file.txt",
				"+++ b/file.txt",
				"@@ -0,0 +1,3 @@",
				" one",
				"+two",
				" three",
				"",
			].join("\n"),
		);
	});

	test("unstages all of a new file as its creation, which removes it", () => {
		const input = newFile("@@ -0,0 +1,2 @@", "+one", "+two");

		expect(buildPartialPatch(input, [[1, 2]], true)).toBe(input);
	});
});
