import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import supertest from "supertest";
import { createApp } from "../app.js";

// Staging and unstaging by line within a modified run, where git's diff lists
// a change's deleted lines and then the lines added in their place. Each
// added line stages with the deleted line in the same place, the run's last
// added line also with any deleted lines left over, and a pure deletion with
// the line below it.

const repoName = "test-repo";
const repoRef = `root/${repoName}`;

const TEN = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);

/** The lines joined, with a final newline unless `newline` is false. */
function text(lines: string[], { newline = true, eol = "\n" } = {}): string {
	return `${lines.join(eol)}${newline ? eol : ""}`;
}

/** Ten numbered lines with the given ones marked CHANGED. */
function changed(lineNumbers: number[]): string[] {
	return TEN.map((line, index) =>
		lineNumbers.includes(index + 1) ? `${line} CHANGED` : line,
	);
}

/** Ten numbered lines with the given ones replaced. */
function replaced(first: number, last: number, lines: string[]): string[] {
	return [...TEN.slice(0, first - 1), ...lines, ...TEN.slice(last)];
}

interface RunCase {
	name: string;
	/** HEAD's content, and the index's before the action. */
	base: string;
	/** The working tree's content, and when unstaging the index's too. */
	current: string;
	ranges: [number, number][];
	/** The index's content after the action. */
	expected: string;
}

const STAGE_CASES: RunCase[] = [
	...[[6], [7], [8], [6, 7], [7, 8], [6, 8], [6, 7, 8]].map((picked) => ({
		name: `a run of three lines for three, picking ${picked.join(" and ")}`,
		base: text(TEN),
		current: text(changed([6, 7, 8])),
		ranges: picked.map((line): [number, number] => [line, line]),
		expected: text(changed(picked)),
	})),
	{
		name: "a run of three lines for three, picking 6 to 8 as one range",
		base: text(TEN),
		current: text(changed([6, 7, 8])),
		ranges: [[6, 8]],
		expected: text(changed([6, 7, 8])),
	},
	{
		name: "a run of three lines for one, picking its line",
		base: text(TEN),
		current: text(replaced(6, 8, ["lines 6 to 8"])),
		ranges: [[6, 6]],
		expected: text(replaced(6, 8, ["lines 6 to 8"])),
	},
	{
		name: "a run of three lines for one, picking the unchanged line below it",
		base: text(TEN),
		current: text(replaced(6, 8, ["lines 6 to 8"])),
		ranges: [[7, 7]],
		expected: text(TEN),
	},
	{
		name: "a run of three lines for two, picking the second",
		base: text(TEN),
		current: text(replaced(6, 8, ["line 6 CHANGED", "lines 7 and 8"])),
		ranges: [[7, 7]],
		expected: text(replaced(7, 8, ["lines 7 and 8"])),
	},
	...(
		[
			[[6], ["line 6a"]],
			[[7], ["line 6", "line 6b"]],
			[[8], ["line 6", "line 6c"]],
			[
				[6, 7],
				["line 6a", "line 6b"],
			],
			[
				[7, 8],
				["line 6", "line 6b", "line 6c"],
			],
		] as const
	).map(([picked, lines]) => ({
		name: `a run of one line for three, picking ${picked.join(" and ")}`,
		base: text(TEN),
		current: text(replaced(6, 6, ["line 6a", "line 6b", "line 6c"])),
		ranges: picked.map((line): [number, number] => [line, line]),
		expected: text(replaced(6, 6, [...lines])),
	})),
	{
		name: "a pure deletion, picking the line below it",
		base: text(TEN),
		current: text(replaced(6, 8, [])),
		ranges: [[6, 6]],
		expected: text(replaced(6, 8, [])),
	},
	{
		name: "a pure deletion, picking the line above it",
		base: text(TEN),
		current: text(replaced(6, 8, [])),
		ranges: [[5, 5]],
		expected: text(TEN),
	},
	{
		name: "a run at the start of the file, picking its last line",
		base: text(TEN),
		current: text(changed([1, 2, 3])),
		ranges: [[3, 3]],
		expected: text(changed([3])),
	},
	{
		name: "a run at the start of the file, picking its first line",
		base: text(TEN),
		current: text(changed([1, 2, 3])),
		ranges: [[1, 1]],
		expected: text(changed([1])),
	},
	{
		name: "a run at the end of the file, picking its last line",
		base: text(TEN),
		current: text(changed([8, 9, 10])),
		ranges: [[10, 10]],
		expected: text(changed([10])),
	},
	{
		name: "a run at the end of the file, picking its first line",
		base: text(TEN),
		current: text(changed([8, 9, 10])),
		ranges: [[8, 8]],
		expected: text(changed([8])),
	},
	{
		name: "a CRLF file, picking a run's last line",
		base: text(TEN, { eol: "\r\n" }),
		current: text(changed([6, 7, 8]), { eol: "\r\n" }),
		ranges: [[8, 8]],
		expected: text(changed([8]), { eol: "\r\n" }),
	},
	{
		name: "a CRLF file, picking a run's first line",
		base: text(TEN, { eol: "\r\n" }),
		current: text(changed([6, 7, 8]), { eol: "\r\n" }),
		ranges: [[6, 6]],
		expected: text(changed([6]), { eol: "\r\n" }),
	},
	{
		name: "an old side without a final newline, picking the last line",
		base: text(TEN, { newline: false }),
		current: text(changed([8, 9, 10])),
		ranges: [[10, 10]],
		expected: text(changed([10])),
	},
	{
		name: "an old side without a final newline, picking an earlier line",
		base: text(TEN, { newline: false }),
		current: text(changed([8, 9, 10])),
		ranges: [[8, 8]],
		expected: text(changed([8]), { newline: false }),
	},
	{
		name: "a new side without a final newline, picking the last line",
		base: text(TEN),
		current: text(changed([8, 9, 10]), { newline: false }),
		ranges: [[10, 10]],
		expected: text(changed([10]), { newline: false }),
	},
	{
		name: "a new side without a final newline, picking an earlier line",
		base: text(TEN),
		current: text(changed([8, 9, 10]), { newline: false }),
		ranges: [[9, 9]],
		expected: text(changed([9])),
	},
	{
		name: "neither side with a final newline, picking an earlier line",
		base: text(TEN, { newline: false }),
		current: text(changed([8, 9, 10]), { newline: false }),
		ranges: [[9, 9]],
		expected: text(changed([9]), { newline: false }),
	},
	{
		name: "neither side with a final newline, picking the last line",
		base: text(TEN, { newline: false }),
		current: text(changed([8, 9, 10]), { newline: false }),
		ranges: [[10, 10]],
		expected: text(changed([10]), { newline: false }),
	},
	...(
		[
			[[10], ["line 10a"]],
			[[11], ["line 10", "line 10b"]],
			[[12], ["line 10", "line 10c"]],
			[
				[10, 12],
				["line 10a", "line 10c"],
			],
		] as const
	).map(([picked, lines]) => ({
		name: `an old last line without a newline replaced by three, picking ${picked.join(" and ")}`,
		base: text(TEN, { newline: false }),
		current: text(replaced(10, 10, ["line 10a", "line 10b", "line 10c"])),
		ranges: picked.map((line): [number, number] => [line, line]),
		expected: text(replaced(10, 10, [...lines])),
	})),
	{
		name: "three last lines replaced by one without a newline",
		base: text(TEN),
		current: text(replaced(8, 10, ["lines 8 to 10"]), { newline: false }),
		ranges: [[8, 8]],
		expected: text(replaced(8, 10, ["lines 8 to 10"]), { newline: false }),
	},
	{
		name: "a CRLF file's last line without a newline, picking a line added after it",
		base: "a\r\nb",
		current: "a\r\nb\r\nc\r\n",
		ranges: [[3, 3]],
		// b gains the file's own line ending.
		expected: "a\r\nb\r\nc\r\n",
	},
];

const UNSTAGE_CASES: RunCase[] = [
	{
		name: "a CRLF HEAD's last line without a newline, picking the line in its place",
		base: "a\r\nb",
		current: "a\r\nB\r\nc\r\n",
		ranges: [[2, 2]],
		// b returns ahead of the staged c, with the file's own line ending.
		expected: "a\r\nb\r\nc\r\n",
	},
	...[[6], [7], [8], [6, 7], [6, 8], [6, 7, 8]].map((picked) => ({
		name: `a run of three lines for three, picking ${picked.join(" and ")}`,
		base: text(TEN),
		current: text(changed([6, 7, 8])),
		ranges: picked.map((line): [number, number] => [line, line]),
		expected: text(changed([6, 7, 8].filter((line) => !picked.includes(line)))),
	})),
	{
		name: "a run of three lines for one, picking its line",
		base: text(TEN),
		current: text(replaced(6, 8, ["lines 6 to 8"])),
		ranges: [[6, 6]],
		expected: text(TEN),
	},
	...(
		[
			[[6], ["line 6", "line 6b", "line 6c"]],
			[[7], ["line 6a", "line 6c"]],
			[[8], ["line 6a", "line 6b"]],
		] as const
	).map(([picked, lines]) => ({
		name: `a run of one line for three, picking ${picked.join(" and ")}`,
		base: text(TEN),
		current: text(replaced(6, 6, ["line 6a", "line 6b", "line 6c"])),
		ranges: picked.map((line): [number, number] => [line, line]),
		expected: text(replaced(6, 6, [...lines])),
	})),
	{
		name: "a pure deletion, picking the line below it",
		base: text(TEN),
		current: text(replaced(6, 8, [])),
		ranges: [[6, 6]],
		expected: text(TEN),
	},
	{
		name: "a run at the start of the file, picking its first line",
		base: text(TEN),
		current: text(changed([1, 2, 3])),
		ranges: [[1, 1]],
		expected: text(changed([2, 3])),
	},
	{
		name: "a run at the end of the file, picking its last line",
		base: text(TEN),
		current: text(changed([8, 9, 10])),
		ranges: [[10, 10]],
		expected: text(changed([8, 9])),
	},
	{
		name: "a CRLF file, picking a run's last line",
		base: text(TEN, { eol: "\r\n" }),
		current: text(changed([6, 7, 8]), { eol: "\r\n" }),
		ranges: [[8, 8]],
		expected: text(changed([6, 7]), { eol: "\r\n" }),
	},
	{
		name: "HEAD without a final newline, picking the last line",
		base: text(TEN, { newline: false }),
		current: text(changed([8, 9, 10])),
		ranges: [[10, 10]],
		expected: text(changed([8, 9]), { newline: false }),
	},
	{
		name: "HEAD without a final newline, picking an earlier line",
		base: text(TEN, { newline: false }),
		current: text(changed([8, 9, 10])),
		ranges: [[8, 8]],
		expected: text(changed([9, 10])),
	},
	{
		name: "the index without a final newline, picking the last line",
		base: text(TEN),
		current: text(changed([8, 9, 10]), { newline: false }),
		ranges: [[10, 10]],
		expected: text(changed([8, 9])),
	},
	{
		name: "the index without a final newline, picking an earlier line",
		base: text(TEN),
		current: text(changed([8, 9, 10]), { newline: false }),
		ranges: [[9, 9]],
		expected: text(changed([8, 10]), { newline: false }),
	},
	...(
		[
			[[10], ["line 10", "line 10b", "line 10c"], true],
			[[11], ["line 10a", "line 10c"], true],
			[[12], ["line 10a", "line 10b"], true],
			[[10, 12], ["line 10", "line 10b"], true],
			[[10, 11, 12], ["line 10"], false],
		] as const
	).map(([picked, lines, newline]) => ({
		name: `HEAD's last line without a newline replaced by three, picking ${picked.join(" and ")}`,
		base: text(TEN, { newline: false }),
		current: text(replaced(10, 10, ["line 10a", "line 10b", "line 10c"])),
		ranges: picked.map((line): [number, number] => [line, line]),
		expected: text(replaced(10, 10, [...lines]), { newline }),
	})),
];

describe("staging and unstaging lines of a modified run", () => {
	let reposRoot: string;
	let repoDir: string;
	let app: ReturnType<typeof createApp>;
	let fileCount = 0;

	beforeAll(async () => {
		reposRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rift-runs-"));
		repoDir = path.join(reposRoot, repoName);
		await fs.mkdir(repoDir);
		git("init", "-q");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test");
		// Store line endings verbatim so the CRLF cases are deterministic.
		git("config", "core.autocrlf", "false");
		app = createApp({
			port: 3000,
			roots: [{ label: "root", path: reposRoot }],
			allowedLogins: [],
			allowWrites: true,
		});
	});

	afterAll(async () => {
		await fs.rm(reposRoot, { recursive: true, force: true });
	});

	function git(...args: string[]): string {
		return execFileSync("git", args, { cwd: repoDir }).toString();
	}

	// Commits `base` as a file of its own, so each case starts clean.
	async function commitFile(base: string): Promise<string> {
		fileCount += 1;
		const name = `run-${fileCount}.txt`;
		await fs.writeFile(path.join(repoDir, name), base);
		git("add", "--", name);
		git("commit", "-q", "-m", `add ${name}`);
		return name;
	}

	// Sends the ranges with the blob ids of the diff the editor would read, as
	// the editor does.
	async function act(
		action: "stage" | "unstage",
		name: string,
		ranges: [number, number][],
	) {
		const diff = await supertest(app).get(
			`/api/git/diff?repo=${repoRef}&path=${name}&staged=${action === "unstage"}`,
		);
		const expectedBlobs = /^index ([0-9a-f]+\.\.[0-9a-f]+)/m.exec(
			diff.body.diff,
		)?.[1];
		return supertest(app)
			.post(`/api/git/${action}?repo=${repoRef}`)
			.send({ path: name, ranges, expectedBlobs });
	}

	describe("staging", () => {
		for (const { name, base, current, ranges, expected } of STAGE_CASES) {
			test(name, async () => {
				const file = await commitFile(base);
				await fs.writeFile(path.join(repoDir, file), current);

				const res = await act("stage", file, ranges);

				expect(res.status).toBe(200);
				expect(git("show", `:${file}`)).toBe(expected);
				// The working tree is untouched.
				expect(await fs.readFile(path.join(repoDir, file), "utf8")).toBe(
					current,
				);
			});
		}
	});

	describe("unstaging", () => {
		for (const { name, base, current, ranges, expected } of UNSTAGE_CASES) {
			test(name, async () => {
				const file = await commitFile(base);
				await fs.writeFile(path.join(repoDir, file), current);
				git("add", "--", file);

				const res = await act("unstage", file, ranges);

				expect(res.status).toBe(200);
				expect(git("show", `:${file}`)).toBe(expected);
				expect(await fs.readFile(path.join(repoDir, file), "utf8")).toBe(
					current,
				);
			});
		}
	});

	test("unstages a run's last line after staging it alone", async () => {
		const file = await commitFile(text(TEN));
		await fs.writeFile(path.join(repoDir, file), text(changed([6, 7, 8])));

		expect((await act("stage", file, [[8, 8]])).status).toBe(200);
		expect(git("diff", "--cached", "--", file)).toContain(
			["-line 8", "+line 8 CHANGED"].join("\n"),
		);
		expect(git("show", `:${file}`)).toBe(text(changed([8])));

		expect((await act("unstage", file, [[8, 8]])).status).toBe(200);
		expect(git("show", `:${file}`)).toBe(text(TEN));
	});
});
