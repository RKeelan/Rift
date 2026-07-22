import { describe, expect, test } from "bun:test";
import { type DiffOp, getDiffOps } from "../diff.ts";

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
