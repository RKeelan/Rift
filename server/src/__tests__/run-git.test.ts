import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findGit, GitError, gitCommand, gitText, runGit } from "../runGit.js";

describe("runGit", () => {
	let repoDir: string;

	function git(...args: string[]): string {
		return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
	}

	beforeEach(async () => {
		repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "rift-run-git-"));
		git("init", "-q");
		git("config", "user.email", "you@example.com");
		git("config", "user.name", "You");
		git("config", "core.autocrlf", "false");
	});

	afterEach(async () => {
		await fs.rm(repoDir, { recursive: true, force: true });
	});

	test("returns stdout as bytes, and as text with any byte order mark", async () => {
		const bytes = Buffer.from("\uFEFFone\r\ntwo\n", "utf8");
		await fs.writeFile(path.join(repoDir, "bom.txt"), bytes);
		git("add", "bom.txt");

		const result = await runGit(repoDir, ["show", ":bom.txt"]);
		const text = await gitText(repoDir, ["show", ":bom.txt"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.equals(bytes)).toBe(true);
		expect(text).toBe("\uFEFFone\r\ntwo\n");
	});

	test("passes input on stdin", async () => {
		const hash = await gitText(repoDir, ["hash-object", "--stdin"], {
			input: "hello\n",
		});

		expect(hash).toBe("ce013625030ba8dba906f756967f9e9ca394464a\n");
	});

	test("rejects a failing command with git's own message", async () => {
		const error = await runGit(repoDir, ["rev-parse", "--verify", "nope"]).then(
			() => null,
			(err: unknown) => err,
		);

		expect(error).toBeInstanceOf(GitError);
		expect((error as GitError).exitCode).toBe(128);
		expect((error as GitError).message).toBe("fatal: Needed a single revision");
	});

	test("rejects a command that fails with its message on stdout", async () => {
		// Committing with nothing staged exits 1 and says why on stdout alone.
		const error = await runGit(repoDir, ["commit", "-m", "Nothing"]).then(
			() => null,
			(err: unknown) => err,
		);

		expect(error).toBeInstanceOf(GitError);
		expect((error as GitError).exitCode).toBe(1);
		expect((error as GitError).message).toContain("nothing to commit");
	});

	test("carries megabytes each way", async () => {
		const content = randomBytes(6 * 1024 * 1024);
		const hash = createHash("sha1")
			.update(`blob ${content.length}\0`)
			.update(content)
			.digest("hex");

		const written = await gitText(repoDir, ["hash-object", "-w", "--stdin"], {
			input: content,
		});
		const read = await runGit(repoDir, ["cat-file", "blob", hash]);

		expect(written).toBe(`${hash}\n`);
		expect(read.stdout.equals(content)).toBe(true);
	});

	test("finishes once git exits, though a job it started holds its output", async () => {
		// A job a hook leaves running inherits git's stderr and keeps it open.
		const hook = path.join(repoDir, ".git", "hooks", "post-commit");
		await fs.writeFile(
			hook,
			"#!/bin/sh\n(cd / && sleep 3 && echo late >&2) &\necho 'hook done' >&2\n",
		);
		await fs.chmod(hook, 0o755);
		await fs.writeFile(path.join(repoDir, "a.txt"), "a\n");
		git("add", "a.txt");

		const start = performance.now();
		const result = await runGit(repoDir, ["commit", "-q", "-m", "Add a"]);

		expect(performance.now() - start).toBeLessThan(2000);
		expect(result.stderr).toContain("hook done");
		expect(result.stderr).not.toContain("late");
		expect(git("log", "-1", "--format=%s")).toBe("Add a\n");
	});

	test("takes an exit code the caller accepts as success", async () => {
		await fs.writeFile(path.join(repoDir, "a.txt"), "a\n");
		// check-ignore exits 1 when it ignores none of the paths.
		const args = ["check-ignore", "--verbose", "--non-matching", "--", "a.txt"];

		const result = await runGit(repoDir, args, {
			accept: ({ exitCode }) => exitCode === 1,
		});

		expect(result.exitCode).toBe(1);
		expect(result.stdout.toString("utf8")).toBe("::\ta.txt\n");
		await expect(runGit(repoDir, args)).rejects.toBeInstanceOf(GitError);
	});

	test("takes a warning on stderr from a command that succeeds as success", async () => {
		git("config", "core.autocrlf", "true");
		await fs.writeFile(path.join(repoDir, "a.txt"), "a\n");

		const result = await runGit(repoDir, ["add", "a.txt"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("LF will be replaced by CRLF");
		expect(git("diff", "--cached", "--name-only")).toBe("a.txt\n");
	});

	test("leaves a stale index alone when reading the status", async () => {
		await fs.writeFile(path.join(repoDir, "a.txt"), "a\n");
		git("add", "a.txt");
		git("commit", "-q", "-m", "initial");
		// Touching the file leaves the index's record of it out of date, which
		// a status with optional locks would refresh by rewriting the index.
		const later = new Date(Date.now() + 60_000);
		await fs.utimes(path.join(repoDir, "a.txt"), later, later);
		const indexFile = path.join(repoDir, ".git", "index");
		const before = await fs.readFile(indexFile);

		await runGit(repoDir, ["status", "--porcelain"]);

		expect((await fs.readFile(indexFile)).equals(before)).toBe(true);
	});

	test("runs hooks that use Git's shell tools", async () => {
		const hook = path.join(repoDir, ".git", "hooks", "pre-commit");
		await fs.writeFile(
			hook,
			"#!/bin/sh\necho abc | sed s/b/X/ | grep -q aXc || exit 1\n",
		);
		await fs.chmod(hook, 0o755);
		await fs.writeFile(path.join(repoDir, "a.txt"), "a\n");
		git("add", "a.txt");

		await runGit(repoDir, ["commit", "-q", "-F", "-"], { input: "Add a\n" });

		expect(git("log", "-1", "--format=%s")).toBe("Add a\n");
	});
});

describe("gitCommand", () => {
	test.if(process.platform === "win32")(
		"starts Git for Windows' real git, with its tools at the front of the PATH",
		async () => {
			const { binary, env } = await gitCommand();
			const pathKey =
				Object.keys(env ?? {}).find((key) => key.toUpperCase() === "PATH") ??
				"PATH";
			const [first, second] = (env?.[pathKey] ?? "").split(path.delimiter);

			// <Git>/mingw64/bin/git.exe, not the launcher in <Git>/cmd.
			expect(path.basename(binary)).toBe("git.exe");
			expect(path.basename(path.dirname(binary))).toBe("bin");
			expect(first).toBe(path.dirname(binary));
			expect(second).toBe(path.join(binary, "..", "..", "..", "usr", "bin"));
			expect((await fs.stat(path.join(second, "sed.exe"))).isFile()).toBe(true);
		},
	);

	test.if(process.platform !== "win32")(
		"starts the git on the PATH",
		async () => {
			expect(await gitCommand()).toEqual({ binary: "git" });
		},
	);
});

describe("findGit", () => {
	const gitCore = async () => "C:/Git/mingw64/libexec/git-core";
	const realGit = "C:\\Git\\mingw64\\bin\\git.exe";

	test("starts the real git, with Git's tools in front of the PATH under its own key", async () => {
		const found = await findGit(
			"win32",
			gitCore,
			async (file) => file === realGit,
			{ Path: "C:\\Windows", EDITOR: "notepad" },
		);

		expect(found).toEqual({
			binary: realGit,
			env: {
				Path: "C:\\Git\\mingw64\\bin;C:\\Git\\usr\\bin;C:\\Windows",
				EDITOR: "notepad",
			},
		});
	});

	test("starts the git on the PATH when that git cannot say where it lives", async () => {
		const found = await findGit(
			"win32",
			async () => null,
			async () => true,
			{ PATH: "C:\\Windows" },
		);

		expect(found).toEqual({ binary: "git" });
	});

	test("starts the git on the PATH when the real git is not where it should be", async () => {
		const found = await findGit("win32", gitCore, async () => false, {
			PATH: "C:\\Windows",
		});

		expect(found).toEqual({ binary: "git" });
	});

	test("starts the git on the PATH on other platforms, without asking it", async () => {
		let asked = false;
		const found = await findGit(
			"linux",
			async () => {
				asked = true;
				return "/usr/lib/git-core";
			},
			async () => true,
			{ PATH: "/usr/bin" },
		);

		expect(found).toEqual({ binary: "git" });
		expect(asked).toBe(false);
	});
});
