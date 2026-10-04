import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import {
	clearPickedLines,
	countPickedLines,
	deletionAnchorLine,
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
				deletedChunks: [{ anchorIndex: 1, lines: ["gone", "also gone"] }],
			},
			5,
		);

		expect([...targets.lines]).toEqual([]);
		expect([...targets.deletions]).toEqual([[2, 2]]);
	});
});

describe("livePickedLines", () => {
	test("drops picks that no longer name a target", () => {
		const targets = getPickTargets(
			{
				lineHighlights: [{ kind: "added", lineNumber: 2 }],
				deletedChunks: [{ anchorIndex: 5, lines: ["gone"] }],
			},
			8,
		);

		// Line 4 was a deletion's anchor before git's diff moved it to line 6.
		expect(livePickedLines(new Set([2, 4, 6]), targets)).toEqual([2, 6]);
	});
});

describe("rangesCoverTarget", () => {
	const targets = getPickTargets(
		{
			lineHighlights: [{ kind: "added", lineNumber: 2 }],
			deletedChunks: [{ anchorIndex: 5, lines: ["gone"] }],
		},
		8,
	);

	test("is true when a range takes in an added line or a deletion's anchor", () => {
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

describe("deletionAnchorLine", () => {
	test("anchors a deletion to the line below it", () => {
		expect(deletionAnchorLine({ anchorIndex: 3 }, 10)).toBe(4);
	});

	test("anchors a deletion past the last line to the last line", () => {
		expect(deletionAnchorLine({ anchorIndex: 5 }, 5)).toBe(5);
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
				{ anchorIndex: 1, lines: ["old 2"] },
				// A pure deletion of three lines above line 6.
				{ anchorIndex: 5, lines: ["x", "y", "z"] },
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
