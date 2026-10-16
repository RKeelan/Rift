import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitLog, gitStatus, parseLog, parseStatus } from "../gitOutput.js";
import { GitError } from "../runGit.js";

describe("parseStatus", () => {
	// `git status --porcelain -u -z` from git 2.46, for a repo holding each
	// kind of change.
	const output = [
		" M  lead.txt", // a path that starts with a space, modified
		"AM added.txt", // added, then modified again
		"MM both.txt", // modified, staged, and modified again
		" D gone.txt", // deleted, not staged
		" R ita-dst.txt", // renamed after `git add -N`, then its source
		"ita-src.txt",
		" M keep.txt",
		"R  new name.txt", // renamed with `git mv`, then its source
		"old name.txt",
		"D  staged-gone.txt", // deleted with `git rm`
		"RM thé.txt", // renamed to a name that is not ASCII, then modified
		"café.txt",
		"?? naïve.txt",
		"?? sub dir/untracked one.txt",
		"",
	].join("\0");

	test("reads each path with its index and working-tree codes", () => {
		expect(parseStatus(output)).toEqual([
			{ path: " lead.txt", index: " ", workingTree: "M" },
			{ path: "added.txt", index: "A", workingTree: "M" },
			{ path: "both.txt", index: "M", workingTree: "M" },
			{ path: "gone.txt", index: " ", workingTree: "D" },
			{
				path: "ita-dst.txt",
				index: " ",
				workingTree: "R",
				from: "ita-src.txt",
			},
			{ path: "keep.txt", index: " ", workingTree: "M" },
			{
				path: "new name.txt",
				index: "R",
				workingTree: " ",
				from: "old name.txt",
			},
			{ path: "staged-gone.txt", index: "D", workingTree: " " },
			{ path: "thé.txt", index: "R", workingTree: "M", from: "café.txt" },
			{ path: "naïve.txt", index: "?", workingTree: "?" },
			{ path: "sub dir/untracked one.txt", index: "?", workingTree: "?" },
		]);
	});

	test("reads a clean repository as no paths", () => {
		expect(parseStatus("")).toEqual([]);
	});

	test("leaves out a branch header", () => {
		// With --branch, before the first commit.
		expect(parseStatus("## No commits yet on main\0?? a.txt\0")).toEqual([
			{ path: "a.txt", index: "?", workingTree: "?" },
		]);
	});

	test("reads every conflict code a merge leaves", () => {
		// From git 2.46, after a merge with a conflict of each kind: the last
		// three are one path renamed differently on each side.
		const conflicts = [
			"AA both-added.txt",
			"UU both-modified.txt",
			"UD deleted-by-them.txt",
			"DU deleted-by-us.txt",
			"AU renamed-ours.txt",
			"UA renamed-theirs.txt",
			"DD renamed-twice.txt",
			"",
		].join("\0");

		expect(parseStatus(conflicts)).toEqual([
			{ path: "both-added.txt", index: "A", workingTree: "A" },
			{ path: "both-modified.txt", index: "U", workingTree: "U" },
			{ path: "deleted-by-them.txt", index: "U", workingTree: "D" },
			{ path: "deleted-by-us.txt", index: "D", workingTree: "U" },
			{ path: "renamed-ours.txt", index: "A", workingTree: "U" },
			{ path: "renamed-theirs.txt", index: "U", workingTree: "A" },
			{ path: "renamed-twice.txt", index: "D", workingTree: "D" },
		]);
	});

	test("reads a copy's source as a rename's", () => {
		expect(parseStatus("C  copy.txt\0original.txt\0")).toEqual([
			{
				path: "copy.txt",
				index: "C",
				workingTree: " ",
				from: "original.txt",
			},
		]);
	});
});

describe("parseLog", () => {
	test("reads each commit's hash, author, date and subject", () => {
		// `git log -z` in the format gitLog asks for, from git 2.46.
		const output = [
			"7e0de56aff0693baf4a496779168308fd78585de",
			"You Person",
			"2026-10-15T19:52:40-04:00",
			"Ünïcode subject, with a comma",
			"f6ef6f0d80c9cac18eae93f0e191b715ebfdd6d4",
			"You Person",
			"2026-10-15T19:52:40-04:00",
			"Initial commit",
			"",
		].join("\0");

		expect(parseLog(output)).toEqual([
			{
				hash: "7e0de56aff0693baf4a496779168308fd78585de",
				author: "You Person",
				date: "2026-10-15T19:52:40-04:00",
				subject: "Ünïcode subject, with a comma",
			},
			{
				hash: "f6ef6f0d80c9cac18eae93f0e191b715ebfdd6d4",
				author: "You Person",
				date: "2026-10-15T19:52:40-04:00",
				subject: "Initial commit",
			},
		]);
	});

	test("reads no output as no commits", () => {
		expect(parseLog("")).toEqual([]);
	});
});

describe("reading a repository", () => {
	let repoDir: string;

	function git(...args: string[]): string {
		return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
	}

	beforeEach(async () => {
		repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "rift-git-output-"));
		git("init", "-q");
		git("config", "user.email", "you@example.com");
		git("config", "user.name", "You Person");
	});

	afterEach(async () => {
		await fs.rm(repoDir, { recursive: true, force: true });
	});

	test("gitStatus reads renames, spaces and names that are not ASCII", async () => {
		await fs.writeFile(path.join(repoDir, "old name.txt"), "one\n");
		await fs.writeFile(path.join(repoDir, "café.txt"), "two\n");
		git("add", "-A");
		git("commit", "-q", "-m", "initial");
		git("mv", "old name.txt", "new name.txt");
		git("mv", "café.txt", "thé.txt");
		await fs.mkdir(path.join(repoDir, "sub dir"));
		await fs.writeFile(path.join(repoDir, "sub dir", "naïve.txt"), "u\n");

		const files = await gitStatus(repoDir);

		expect(files).toEqual([
			{
				path: "new name.txt",
				index: "R",
				workingTree: " ",
				from: "old name.txt",
			},
			{ path: "thé.txt", index: "R", workingTree: " ", from: "café.txt" },
			{ path: "sub dir/naïve.txt", index: "?", workingTree: "?" },
		]);
	});

	test("gitLog lists commits newest first", async () => {
		await fs.writeFile(path.join(repoDir, "a.txt"), "one\n");
		git("add", "a.txt");
		git("commit", "-q", "-m", "First");
		await fs.writeFile(path.join(repoDir, "a.txt"), "two\n");
		git("commit", "-q", "-a", "-m", "Ünïcode subject\n\nA body.");
		const head = git("rev-parse", "HEAD").trim();

		const commits = await gitLog(repoDir, ["--max-count=5"]);

		expect(commits.map((commit) => commit.subject)).toEqual([
			"Ünïcode subject",
			"First",
		]);
		expect(commits[0].hash).toBe(head);
		expect(commits[0].author).toBe("You Person");
		expect(Number.isNaN(Date.parse(commits[0].date))).toBe(false);
	});

	test("gitLog fails before the first commit", async () => {
		await expect(gitLog(repoDir, [])).rejects.toBeInstanceOf(GitError);
	});
});
