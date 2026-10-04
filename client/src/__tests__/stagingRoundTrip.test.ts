import { describe, expect, test } from "bun:test";
import { buildPartialPatch } from "../../../server/src/routes/git.ts";
import {
	deletionAnchorLine,
	getPickTargets,
	pickedLinesToRanges,
} from "../components/linePicking.ts";
import { getEditorChangeDecorations } from "../components/TextFileEditor.tsx";
import { GIT_DIFF_CASES } from "./gitDiffCases.ts";

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

// Each pick goes through the same steps as in the editor: decorations from
// git's diff, the targets they offer, the ranges a pick sends, and the patch
// the server slices from git's diff with them.
describe("a pick stages exactly the lines it names", () => {
	for (const { name, base, current, diff } of GIT_DIFF_CASES) {
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

			const covered: string[] = [];
			for (const line of picks) {
				const expected = [
					...(targets.lines.has(line) ? [`+${currentLines[line - 1]}`] : []),
					...decorations.deletedChunks
						.filter((chunk) => deletionAnchorLine(chunk, docLines) === line)
						.flatMap((chunk) => chunk.lines.map((deleted) => `-${deleted}`)),
				].sort();

				const patch = buildPartialPatch(diff, pickedLinesToRanges([line]));

				expect({ line, staged: changedLines(patch) }).toEqual({
					line,
					staged: expected,
				});
				covered.push(...expected);
			}

			// Every change in git's diff is reachable through some pick.
			expect(covered.sort()).toEqual(changedLines(diff));
		});
	}
});
