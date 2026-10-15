import { describe, expect, test } from "bun:test";
import { buildPartialPatch } from "../../../server/src/routes/git.ts";
import {
	deletionPickLines,
	getPickTargets,
	pickedLinesToRanges,
} from "../components/linePicking.ts";
import {
	getChangeRegions,
	getEditorChangeDecorations,
} from "../components/TextFileEditor.tsx";
import { applyDiff } from "../diff.ts";
import { GIT_DIFF_CASES } from "./gitDiffCases.ts";

type Decorations = ReturnType<typeof getEditorChangeDecorations>;

/** The added and deleted lines of a diff or patch, sorted for comparison. */
function changedLines(diff: string | null): string[] {
	if (diff === null) return [];
	const lines = diff.split("\n");
	const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
	return lines
		.slice(firstHunk)
		.filter(
			(line) =>
				(line.startsWith("+") || line.startsWith("-")) &&
				!line.startsWith("@@"),
		)
		.sort();
}

/** The deleted lines the editor shows as picked through any of `lines`. */
function deletedLinesPickedBy(
	chunks: readonly { anchorIndex: number; added: number; lines: string[] }[],
	docLines: number,
	picked: (line: number) => boolean,
): string[] {
	return chunks.flatMap((chunk) => {
		const pickLines = deletionPickLines(chunk, docLines);
		return chunk.lines
			.filter((_deleted, index) => picked(pickLines[index]))
			.map((deleted) => `-${deleted}`);
	});
}

/** Splits text into lines, and whether the last of them ends with a newline. */
function splitLines(text: string): { lines: string[]; finalNewline: boolean } {
	if (text === "") return { lines: [], finalNewline: false };
	const lines = text.split("\n");
	const finalNewline = lines[lines.length - 1] === "";
	if (finalNewline) lines.pop();
	return { lines, finalNewline };
}

/**
 * What staging the picked lines should leave in the index, worked out from
 * the editor's decorations rather than from the patch: each picked added line
 * in place of the deleted lines that go with it, a picked pure deletion gone,
 * and every other change left as the base has it. Each line keeps the newline
 * it has where it comes from, except that the base's last line, which may
 * lack one, gains one when lines come after it. The patch has to delete and
 * re-add such a line, so they are returned too.
 */
function expectedStaging(
	base: string,
	current: string,
	decorations: Decorations,
	docLines: number,
	picked: (line: number) => boolean,
): { text: string; newlineAdded: string[] } {
	const old = splitLines(base);
	const now = splitLines(current);
	const addedLines = new Set(
		decorations.lineHighlights
			.filter(({ kind }) => kind === "added")
			.map(({ lineNumber }) => lineNumber),
	);
	const out: { text: string; newline: boolean; fromBase: boolean }[] = [];
	const currentLine = (line: number) => ({
		text: now.lines[line - 1],
		newline: line < now.lines.length || now.finalNewline,
		fromBase: false,
	});

	let baseIndex = 0;
	let line = 1;
	while (line <= now.lines.length + 1) {
		const chunk = decorations.deletedChunks.find(
			({ anchorIndex }) => anchorIndex === line - 1,
		);
		if (chunk) {
			const pickLines = deletionPickLines(chunk, docLines);
			const deleted = chunk.lines.map((text, index) => ({
				text,
				newline: baseIndex + index < old.lines.length - 1 || old.finalNewline,
				fromBase: true,
				pickLine: pickLines[index],
			}));
			baseIndex += chunk.lines.length;
			if (chunk.added > 0) {
				for (let unit = 0; unit < chunk.added; unit += 1) {
					const pickLine = line + unit;
					if (picked(pickLine)) {
						out.push(currentLine(pickLine));
					} else {
						out.push(...deleted.filter((entry) => entry.pickLine === pickLine));
					}
				}
				line += chunk.added;
				continue;
			}
			if (!picked(pickLines[0])) out.push(...deleted);
		}
		if (line > now.lines.length) break;
		if (addedLines.has(line)) {
			if (picked(line)) out.push(currentLine(line));
		} else {
			out.push(currentLine(line));
			baseIndex += 1;
		}
		line += 1;
	}

	const last = out.length - 1;
	return {
		text: out
			.map(
				({ text, newline }, at) => `${text}${newline || at < last ? "\n" : ""}`,
			)
			.join(""),
		newlineAdded: out
			.filter(({ newline, fromBase }, at) => fromBase && !newline && at < last)
			.map(({ text }) => text),
	};
}

/**
 * Checks the patch that staging the given ranges builds: it applies to the
 * base and leaves what the editor's picks say it should, and it adds and
 * deletes the picked lines and only them, apart from the base's last line
 * when it gains a newline.
 */
function expectStaging(
	label: unknown,
	{ base, current, diff }: { base: string; current: string; diff: string },
	decorations: Decorations,
	docLines: number,
	ranges: [number, number][],
	picked: string[],
) {
	const within = (line: number) =>
		ranges.some(([start, end]) => line >= start && line <= end);
	const expected = expectedStaging(
		base,
		current,
		decorations,
		docLines,
		within,
	);
	const patch = buildPartialPatch(diff, ranges);

	expect({
		label,
		staged: patch === null ? base : applyDiff(base, patch),
		changed: changedLines(patch),
	}).toEqual({
		label,
		staged: expected.text,
		changed: [
			...picked,
			...expected.newlineAdded.flatMap((line) => [`-${line}`, `+${line}`]),
		].sort(),
	});
}

// Each pick goes through the same steps as in the editor: decorations from
// git's diff, the targets they offer, the ranges a pick sends, and the patch
// the server slices from git's diff with them.
describe("a pick stages exactly the lines it names", () => {
	for (const gitCase of GIT_DIFF_CASES) {
		const { name, base, current, diff } = gitCase;
		test(name, () => {
			const decorations = getEditorChangeDecorations({
				currentContent: current,
				loadedContent: current,
				comparisonContent: base,
				changeDiff: diff,
				changeType: "modified",
			});
			expect(decorations.matchesGitDiff).toBe(true);
			const currentLines = current.split("\n");
			const docLines = currentLines.length;
			const targets = getPickTargets(decorations, docLines);
			const picks = [
				...new Set([...targets.lines, ...targets.deletions.keys()]),
			].sort((left, right) => left - right);

			const pickedBy = (line: number) => [
				...(targets.lines.has(line) ? [`+${currentLines[line - 1]}`] : []),
				...deletedLinesPickedBy(
					decorations.deletedChunks,
					docLines,
					(pickLine) => pickLine === line,
				),
			];

			const covered: string[] = [];
			for (const line of picks) {
				expectStaging(
					{ line },
					gitCase,
					decorations,
					docLines,
					pickedLinesToRanges([line]),
					pickedBy(line),
				);
				covered.push(...pickedBy(line));
			}

			// Every change in git's diff is reachable through some pick.
			expect(covered.sort()).toEqual(changedLines(diff));

			// Two picks together stage what each stages alone.
			for (const first of picks) {
				for (const second of picks.filter((line) => line > first)) {
					expectStaging(
						{ first, second },
						gitCase,
						decorations,
						docLines,
						pickedLinesToRanges([first, second]),
						[...pickedBy(first), ...pickedBy(second)],
					);
				}
			}
		});
	}
});

// A change's strip stages its region whole: every line from its first to its
// last, which picks that change's lines and nothing of any other change.
describe("a change stages exactly its own lines", () => {
	for (const gitCase of GIT_DIFF_CASES) {
		const { name, base, current, diff } = gitCase;
		test(name, () => {
			const decorations = getEditorChangeDecorations({
				currentContent: current,
				loadedContent: current,
				comparisonContent: base,
				changeDiff: diff,
				changeType: "modified",
			});
			expect(decorations.matchesGitDiff).toBe(true);
			const currentLines = current.split("\n");
			const docLines = currentLines.length;
			const targets = getPickTargets(decorations, docLines);

			const covered: string[] = [];
			for (const { start, end } of getChangeRegions(decorations, docLines)) {
				const within = (line: number) => line >= start && line <= end;
				const picked = [
					...[...targets.lines]
						.filter(within)
						.map((line) => `+${currentLines[line - 1]}`),
					...deletedLinesPickedBy(decorations.deletedChunks, docLines, within),
				];

				expectStaging(
					{ start },
					gitCase,
					decorations,
					docLines,
					[[start, end]],
					picked,
				);
				covered.push(...picked);
			}

			// The changes together stage the whole of git's diff.
			expect(covered.sort()).toEqual(changedLines(diff));
		});
	}
});
