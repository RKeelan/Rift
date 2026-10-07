import { describe, expect, test } from "bun:test";
import { applyDiff, type DiffOp, getDiffOps, getWordChanges } from "../diff.ts";
import { GIT_DIFF_CASES, type GitDiffCase } from "./gitDiffCases.ts";

function render(ops: DiffOp[]): string[] {
	return ops.map(
		(op) =>
			`${op.type === "equal" ? " " : op.type === "insert" ? "+" : "-"}${op.line}`,
	);
}

function editCount(ops: DiffOp[]): number {
	return ops.filter((op) => op.type !== "equal").length;
}

/**
 * The O(N * M) LCS table the Myers implementation replaced. Slow, but its edit
 * count is minimal by construction, which makes it a usable oracle in tests.
 */
function minimalEditCount(a: string[], b: string[]): number {
	const rowCount = a.length;
	const columnCount = b.length;
	const table = Array.from({ length: rowCount + 1 }, () =>
		Array<number>(columnCount + 1).fill(0),
	);
	for (let row = rowCount - 1; row >= 0; row -= 1) {
		for (let column = columnCount - 1; column >= 0; column -= 1) {
			table[row][column] =
				a[row] === b[column]
					? table[row + 1][column + 1] + 1
					: Math.max(table[row + 1][column], table[row][column + 1]);
		}
	}
	const lcs = table[0][0];
	return rowCount - lcs + (columnCount - lcs);
}

describe("getDiffOps", () => {
	test("reports no edits for identical input", () => {
		const ops = getDiffOps(["a", "b", "c"], ["a", "b", "c"]);

		expect(ops).not.toBeNull();
		expect(editCount(ops as DiffOp[])).toBe(0);
	});

	test("handles an empty side in each direction", () => {
		expect(render(getDiffOps([], ["a", "b"]) as DiffOp[])).toEqual([
			"+a",
			"+b",
		]);
		expect(render(getDiffOps(["a", "b"], []) as DiffOp[])).toEqual([
			"-a",
			"-b",
		]);
		expect(getDiffOps([], [])).toEqual([]);
	});

	test("places an insertion between the lines that surround it", () => {
		const ops = getDiffOps(
			["function f() {", "\ta();", "}"],
			["function f() {", "\ta();", "\tb();", "}"],
		);

		expect(render(ops as DiffOp[])).toEqual([
			" function f() {",
			" \ta();",
			"+\tb();",
			" }",
		]);
	});

	test("pairs a replacement as a delete followed by an insert", () => {
		const ops = getDiffOps(["a", "b", "c"], ["a", "B", "c"]);

		expect(render(ops as DiffOp[])).toEqual([" a", "-b", "+B", " c"]);
	});

	// The quadratic predecessor gave up once the changed span exceeded roughly
	// 200 lines, so two edits far apart in one file reported the entire span
	// between them as rewritten.
	test("diffs two edits separated by a long unchanged span", () => {
		const original = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
		const current = original.slice();
		current[100] = "line 100 changed";
		current[1500] = "line 1500 changed";

		const ops = getDiffOps(original, current);

		expect(ops).not.toBeNull();
		expect(editCount(ops as DiffOp[])).toBe(4);
	});

	test("returns null once the edit script exceeds the budget", () => {
		const original = Array.from({ length: 1200 }, (_, i) => `old ${i}`);
		const current = Array.from({ length: 1200 }, (_, i) => `new ${i}`);

		expect(getDiffOps(original, current)).toBeNull();
	});

	test("produces a minimal script that rebuilds both sides", () => {
		// A deliberately small alphabet makes repeated lines, and so ties in the
		// search, far more common than they would be in real text.
		let seed = 20260722;
		const random = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		const lines = (length: number, alphabet: number) =>
			Array.from({ length }, () => `L${Math.floor(random() * alphabet)}`);

		for (let trial = 0; trial < 2000; trial += 1) {
			const alphabet = 1 + Math.floor(random() * 6);
			const original = lines(Math.floor(random() * 12), alphabet);
			const current = lines(Math.floor(random() * 12), alphabet);

			const ops = getDiffOps(original, current);
			expect(ops).not.toBeNull();
			const script = ops as DiffOp[];

			expect(
				script.filter((op) => op.type !== "insert").map((op) => op.line),
			).toEqual(original);
			expect(
				script.filter((op) => op.type !== "delete").map((op) => op.line),
			).toEqual(current);
			expect(editCount(script)).toBe(minimalEditCount(original, current));
		}
	});
});

describe("getWordChanges", () => {
	// The text of each range, so a failure shows words rather than offsets.
	function marked(before: string, after: string) {
		const changes = getWordChanges(before, after);
		if (!changes) return null;
		return {
			before: changes.before.map(([from, to]) => before.slice(from, to)),
			after: changes.after.map(([from, to]) => after.slice(from, to)),
		};
	}

	test("marks the word that changed on each side", () => {
		expect(getWordChanges("the quick brown fox", "the quick red fox")).toEqual({
			before: [[10, 15]],
			after: [[10, 13]],
		});
	});

	test("joins changed words with only unchanged whitespace between them", () => {
		expect(marked("a b c d e f", "a X Y d e f")).toEqual({
			before: ["b c"],
			after: ["X Y"],
		});
	});

	test("marks punctuation on its own", () => {
		expect(marked("call(a, b)", "call(a, b, c)")).toEqual({
			before: [],
			after: [", c"],
		});
		expect(marked("if (x > 1) {", "if (x >= 1) {")).toEqual({
			before: [],
			after: ["="],
		});
	});

	test("marks nothing on a line that did not change", () => {
		expect(getWordChanges("same words", "same words")).toEqual({
			before: [],
			after: [],
		});
	});

	test("marks nothing on a line that was rewritten", () => {
		expect(getWordChanges("alpha beta gamma", "one two three")).toBeNull();
		expect(getWordChanges("", "something new")).toBeNull();
	});

	test("counts offsets as the editor does, in UTF-16 code units", () => {
		expect(getWordChanges("naïve café 🎉 ok", "naïve café 🎉 fine")).toEqual({
			before: [[14, 16]],
			after: [[14, 18]],
		});
	});
});

describe("applyDiff", () => {
	function gitCase(name: string): GitDiffCase {
		const found = GIT_DIFF_CASES.find((candidate) => candidate.name === name);
		if (!found) throw new Error(`no case named ${name}`);
		return found;
	}

	function applies(name: string) {
		const { base, diff, current } = gitCase(name);
		expect(applyDiff(base, diff)).toBe(current);
	}

	test("rebuilds the new side of every captured git diff", () => {
		for (const { name, base, diff, current } of GIT_DIFF_CASES) {
			expect({ name, result: applyDiff(base, diff) }).toEqual({
				name,
				result: current,
			});
		}
	});

	test("applies each of several hunks", () => {
		applies("edits in three hunks");
	});

	test("fills an empty old side and empties a new one", () => {
		applies("a created file");
		applies("a created file without a final newline");
		applies("an emptied file");
	});

	test("follows the no-newline marker after context, a deletion, and an addition", () => {
		applies("a modified line above an unchanged last line without a newline");
		applies("a modified last line without a newline");
		applies("a final newline added");
		applies("a final newline removed");
	});

	test("rejects a diff that does not fit the original", () => {
		const { diff } = gitCase("a modified line");

		// A context line that differs.
		expect(applyDiff("x\nb\nc\n", diff)).toBeNull();
		// A deleted line that differs.
		expect(applyDiff("a\nx\nc\n", diff)).toBeNull();
		// A hunk that starts past the end.
		expect(applyDiff("", diff)).toBeNull();
		// A marker that says the old side lacks a final newline when it has one.
		expect(
			applyDiff(
				"a\nb\n",
				gitCase("a modified last line without a newline").diff,
			),
		).toBeNull();
	});
});
