import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import {
	clearPickedLines,
	countPickedLines,
	deletionPickGroups,
	deletionPickLines,
	getPickTargets,
	livePickedLines,
	pickedLines,
	pickedLinesToRanges,
	rangesCoverTarget,
	togglePickedLine,
} from "../components/linePicking.ts";

describe("pickedLines", () => {
	function createState() {
		return EditorState.create({
			doc: "a\nB\nc\nD\ne",
			extensions: pickedLines,
		});
	}

	test("starts with nothing picked", () => {
		expect([...createState().field(pickedLines)]).toEqual([]);
	});

	test("toggling a line picks it, and toggling it again unpicks it", () => {
		let state = createState();

		state = state.update({ effects: togglePickedLine.of(2) }).state;
		state = state.update({ effects: togglePickedLine.of(4) }).state;
		expect([...state.field(pickedLines)].sort()).toEqual([2, 4]);

		state = state.update({ effects: togglePickedLine.of(2) }).state;
		expect([...state.field(pickedLines)]).toEqual([4]);
	});

	test("keeps the picks across transactions that do not edit the document", () => {
		let state = createState();
		state = state.update({ effects: togglePickedLine.of(2) }).state;

		state = state.update({ selection: { anchor: 3 } }).state;

		expect([...state.field(pickedLines)]).toEqual([2]);
	});

	test("clears the picks on any edit", () => {
		let state = createState();
		state = state.update({
			effects: [togglePickedLine.of(2), togglePickedLine.of(4)],
		}).state;

		state = state.update({ changes: { from: 0, insert: "x" } }).state;

		expect([...state.field(pickedLines)]).toEqual([]);
	});

	test("clears the picks on request", () => {
		let state = createState();
		state = state.update({ effects: togglePickedLine.of(2) }).state;

		state = state.update({ effects: clearPickedLines.of(null) }).state;

		expect([...state.field(pickedLines)]).toEqual([]);
	});
});

describe("getPickTargets", () => {
	test("offers every added line and nothing else", () => {
		const targets = getPickTargets(
			{
				lineHighlights: [
					{ kind: "added", lineNumber: 2 },
					{ kind: "added", lineNumber: 4 },
					// Out of range, as a stale highlight can be mid-edit.
					{ kind: "added", lineNumber: 9 },
				],
				deletedChunks: [],
			},
			5,
		);

		expect([...targets.lines]).toEqual([2, 4]);
		expect([...targets.deletions]).toEqual([]);
	});

	test("does not offer the struck-through lines of a deleted file", () => {
		const targets = getPickTargets(
			{
				lineHighlights: [
					{ kind: "deleted", lineNumber: 1 },
					{ kind: "deleted", lineNumber: 2 },
				],
				deletedChunks: [],
			},
			2,
		);

		expect([...targets.lines]).toEqual([]);
	});

	test("offers a deletion through the line below it", () => {
		const targets = getPickTargets(
			{
				lineHighlights: [],
				deletedChunks: [
					{ anchorIndex: 1, added: 0, lines: ["gone", "also gone"] },
				],
			},
			5,
		);

		expect([...targets.lines]).toEqual([]);
		expect([...targets.deletions]).toEqual([[2, 2]]);
	});

	test("offers each deleted line of a modified run through the line in its place", () => {
		const targets = getPickTargets(
			{
				lineHighlights: [6, 7, 8].map((lineNumber) => ({
					kind: "added" as const,
					lineNumber,
				})),
				deletedChunks: [{ anchorIndex: 5, added: 3, lines: ["6", "7", "8"] }],
			},
			10,
		);

		expect([...targets.lines]).toEqual([6, 7, 8]);
		expect([...targets.deletions]).toEqual([
			[6, 1],
			[7, 1],
			[8, 1],
		]);
	});
});

describe("livePickedLines", () => {
	test("drops picks that no longer name a target", () => {
		const targets = getPickTargets(
			{
				lineHighlights: [{ kind: "added", lineNumber: 2 }],
				deletedChunks: [{ anchorIndex: 5, added: 0, lines: ["gone"] }],
			},
			8,
		);

		// Line 4 picked a deletion before git's diff moved it to line 6.
		expect(livePickedLines(new Set([2, 4, 6]), targets)).toEqual([2, 6]);
	});
});

describe("rangesCoverTarget", () => {
	const targets = getPickTargets(
		{
			lineHighlights: [{ kind: "added", lineNumber: 2 }],
			deletedChunks: [{ anchorIndex: 5, added: 0, lines: ["gone"] }],
		},
		8,
	);

	test("is true when a range takes in an added line or a deletion's pick line", () => {
		expect(rangesCoverTarget([[2, 2]], targets)).toBe(true);
		expect(rangesCoverTarget([[5, 7]], targets)).toBe(true);
	});

	test("is false when every range holds only unchanged lines", () => {
		expect(rangesCoverTarget([[1, 1]], targets)).toBe(false);
		expect(
			rangesCoverTarget(
				[
					[3, 5],
					[7, 8],
				],
				targets,
			),
		).toBe(false);
	});
});

describe("deletionPickLines", () => {
	test("picks a pure deletion through the line below it", () => {
		expect(
			deletionPickLines({ anchorIndex: 3, added: 0, lines: ["a", "b"] }, 10),
		).toEqual([4, 4]);
	});

	test("picks a deletion past the last line through the last line", () => {
		expect(
			deletionPickLines({ anchorIndex: 5, added: 0, lines: ["a"] }, 5),
		).toEqual([5]);
	});

	test("pairs a modified run's deleted lines with its added lines in order", () => {
		expect(
			deletionPickLines(
				{ anchorIndex: 5, added: 3, lines: ["a", "b", "c"] },
				10,
			),
		).toEqual([6, 7, 8]);
	});

	test("picks the deletions past a run's last added line through that line", () => {
		expect(
			deletionPickLines(
				{ anchorIndex: 5, added: 1, lines: ["a", "b", "c"] },
				10,
			),
		).toEqual([6, 6, 6]);
		expect(
			deletionPickLines(
				{ anchorIndex: 5, added: 2, lines: ["a", "b", "c", "d"] },
				10,
			),
		).toEqual([6, 7, 7, 7]);
	});

	test("leaves a run's added lines past its last deletion without one", () => {
		expect(
			deletionPickLines({ anchorIndex: 5, added: 3, lines: ["a"] }, 10),
		).toEqual([6]);
	});
});

describe("deletionPickGroups", () => {
	test("splits a chunk into the lines picked through each line", () => {
		expect(
			deletionPickGroups(
				{ anchorIndex: 5, added: 2, lines: ["a", "b", "c", "d"] },
				10,
			),
		).toEqual([
			{ pickLine: 6, from: 0, to: 1 },
			{ pickLine: 7, from: 1, to: 4 },
		]);
	});

	test("keeps a pure deletion whole", () => {
		expect(
			deletionPickGroups({ anchorIndex: 5, added: 0, lines: ["a", "b"] }, 10),
		).toEqual([{ pickLine: 6, from: 0, to: 2 }]);
	});
});

describe("pickedLinesToRanges", () => {
	test("returns no ranges when nothing is picked", () => {
		expect(pickedLinesToRanges([])).toEqual([]);
	});

	test("sorts the picks and merges runs of consecutive lines", () => {
		expect(pickedLinesToRanges(new Set([9, 3, 2, 4, 7]))).toEqual([
			[2, 4],
			[7, 7],
			[9, 9],
		]);
	});
});

describe("countPickedLines", () => {
	const targets = getPickTargets(
		{
			lineHighlights: [
				{ kind: "added", lineNumber: 2 },
				{ kind: "added", lineNumber: 3 },
			],
			deletedChunks: [
				// A modification: line 2 replaces this deleted line.
				{ anchorIndex: 1, added: 1, lines: ["old 2"] },
				// A pure deletion of three lines above line 6.
				{ anchorIndex: 5, added: 0, lines: ["x", "y", "z"] },
			],
		},
		8,
	);

	test("counts each picked added line once", () => {
		expect(countPickedLines(new Set([3]), targets)).toBe(1);
	});

	test("counts a modified line once, with its deletion", () => {
		expect(countPickedLines(new Set([2]), targets)).toBe(1);
	});

	test("counts a pure deletion by the lines it removes", () => {
		expect(countPickedLines(new Set([6]), targets)).toBe(3);
		expect(countPickedLines(new Set([2, 3, 6]), targets)).toBe(5);
	});
});
