/**
 * Small edits with the diff `git diff` prints for each, captured from git
 * itself, for tests that have to agree with git rather than with a diff of
 * their own. Only the file headers are simplified.
 */
export interface GitDiffCase {
	name: string;
	base: string;
	current: string;
	diff: string;
}

function gitDiff(...hunks: string[]): string {
	return ["diff --git a/f b/f", "--- a/f", "+++ b/f", ...hunks, ""].join("\n");
}

const NO_NEWLINE = "\\ No newline at end of file";

const numbered = Array.from({ length: 40 }, (_, index) => String(index + 1));

export const GIT_DIFF_CASES: GitDiffCase[] = [
	{
		name: "a modified line",
		base: "a\nb\nc\n",
		current: "a\nB\nc\n",
		diff: gitDiff("@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"),
	},
	{
		name: "a block deleted from between two similar ones",
		base: "b() {\n\tr\n}\n\nc() {\n\ts\n}\n\nd() {\n}\n",
		current: "b() {\n\tn\n\tr\n}\n\nd() {\n}\n",
		diff: gitDiff(
			"@@ -1,10 +1,7 @@",
			" b() {",
			"+\tn",
			" \tr",
			" }",
			" ",
			"-c() {",
			"-\ts",
			"-}",
			"-",
			" d() {",
			" }",
		),
	},
	{
		name: "a deleted line that begins with dashes",
		base: "a\n-- note\nb\nc\n",
		current: "a\nB\nC\n",
		diff: gitDiff("@@ -1,4 +1,3 @@", " a", "--- note", "-b", "-c", "+B", "+C"),
	},
	{
		name: "an added line that begins with pluses",
		base: "a\nb\n",
		current: "a\n++i;\nX\nb\n",
		diff: gitDiff("@@ -1,2 +1,4 @@", " a", "+++i;", "+X", " b"),
	},
	{
		name: "a deletion at the end of the file",
		base: "a\nb\nc\n",
		current: "a\nb\n",
		diff: gitDiff("@@ -1,3 +1,2 @@", " a", " b", "-c"),
	},
	{
		name: "an emptied file",
		base: "a\nb\n",
		current: "",
		diff: gitDiff("@@ -1,2 +0,0 @@", "-a", "-b"),
	},
	{
		name: "a block deleted near the end of a file without a final newline",
		base: "b() {\n\tr\n}\n\nc() {\n\ts\n}\n\nd() {\n}",
		current: "b() {\n\tn\n\tr\n}\n\nd() {\n}",
		diff: gitDiff(
			"@@ -1,10 +1,7 @@",
			" b() {",
			"+\tn",
			" \tr",
			" }",
			" ",
			"-c() {",
			"-\ts",
			"-}",
			"-",
			" d() {",
			" }",
			NO_NEWLINE,
		),
	},
	{
		name: "a modified line above an unchanged last line without a newline",
		base: "a\nb\nc",
		current: "a\nB\nc",
		diff: gitDiff("@@ -1,3 +1,3 @@", " a", "-b", "+B", " c", NO_NEWLINE),
	},
	{
		name: "a modified last line without a newline",
		base: "a\nb",
		current: "a\nB",
		diff: gitDiff("@@ -1,2 +1,2 @@", " a", "-b", NO_NEWLINE, "+B", NO_NEWLINE),
	},
	{
		name: "a final newline added",
		base: "a\nb",
		current: "a\nb\n",
		diff: gitDiff("@@ -1,2 +1,2 @@", " a", "-b", NO_NEWLINE, "+b"),
	},
	{
		name: "a final newline removed",
		base: "a\nb\n",
		current: "a\nb",
		diff: gitDiff("@@ -1,2 +1,2 @@", " a", "-b", "+b", NO_NEWLINE),
	},
	{
		name: "edits in three hunks",
		base: `${numbered.join("\n")}\n`,
		current: `${numbered
			.map((line) => (line === "5" ? "five" : line))
			.filter((line) => line !== "20")
			.flatMap((line) => (line === "34" ? [line, "x"] : [line]))
			.join("\n")}\n`,
		diff: gitDiff(
			"@@ -2,7 +2,7 @@",
			" 2",
			" 3",
			" 4",
			"-5",
			"+five",
			" 6",
			" 7",
			" 8",
			"@@ -17,7 +17,6 @@",
			" 17",
			" 18",
			" 19",
			"-20",
			" 21",
			" 22",
			" 23",
			"@@ -32,6 +31,7 @@",
			" 32",
			" 33",
			" 34",
			"+x",
			" 35",
			" 36",
			" 37",
		),
	},
];

/** A new file's diff, which Rift stages whole rather than by line. */
export const CREATED_FILE_CASE: GitDiffCase = {
	name: "a created file",
	base: "",
	current: "a\nb\n",
	diff: gitDiff("@@ -0,0 +1,2 @@", "+a", "+b"),
};
