import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import supertest from "supertest";
import { type AppConfig, createApp } from "../app.js";

const repoName = "test-repo";
const repoRef = `root/${repoName}`;

function makeConfig(reposRoot: string, allowWrites = true): AppConfig {
	return {
		port: 3000,
		roots: [{ label: "root", path: reposRoot }],
		allowedLogins: [],
		allowWrites,
	};
}

describe("POST /api/git/commit", () => {
	let reposRoot: string;
	let repoDir: string;
	let app: ReturnType<typeof createApp>;

	function git(command: string): string {
		return execSync(`git ${command}`, { cwd: repoDir, encoding: "utf8" });
	}

	async function initRepo({ withCommit = true } = {}) {
		await fs.mkdir(repoDir);
		git("init");
		git("config user.email 'test@test.com'");
		git("config user.name 'Test'");
		if (withCommit) {
			await fs.writeFile(path.join(repoDir, "a.txt"), "one\n");
			git("add a.txt");
			git('commit -m "initial"');
		}
	}

	function commit(message: unknown) {
		return supertest(app)
			.post(`/api/git/commit?repo=${repoRef}`)
			.send({ message });
	}

	beforeEach(async () => {
		reposRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rift-git-commit-"));
		repoDir = path.join(reposRoot, repoName);
		app = createApp(makeConfig(reposRoot));
	});

	afterEach(async () => {
		await fs.rm(reposRoot, { recursive: true, force: true });
	});

	test("commits what is staged, leaving unstaged edits alone", async () => {
		await initRepo();
		await fs.writeFile(path.join(repoDir, "a.txt"), "two\n");
		await fs.writeFile(path.join(repoDir, "b.txt"), "new\n");
		git("add a.txt");

		const res = await commit("Change a");

		expect(res.status).toBe(200);
		expect(res.body.commit).toBe(git("rev-parse HEAD").trim());
		expect(git("log -1 --format=%s").trim()).toBe("Change a");
		expect(git("show --name-only --format= HEAD").trim()).toBe("a.txt");
		expect(res.body.files).toEqual([
			{ path: "b.txt", status: "untracked", staged: false },
		]);
	});

	test("keeps a message's body", async () => {
		await initRepo();
		await fs.writeFile(path.join(repoDir, "a.txt"), "two\n");
		git("add a.txt");
		const message = "Subject line\n\n- First point.\n- Second point.";

		const res = await commit(message);

		expect(res.status).toBe(200);
		expect(git("log -1 --format=%B").trim()).toBe(message);
	});

	// Four commits spawn git a few dozen times, which can outlast the default
	// five seconds on a busy machine.
	test("commits a message as written, apart from git's whitespace cleanup", async () => {
		await initRepo();
		for (const [message, stored] of [
			["#42 Fix the thing", "#42 Fix the thing"],
			["--amend", "--amend"],
			["Café naïve — 日本語 🎉", "Café naïve — 日本語 🎉"],
			["Subject\r\n\r\nBody  ", "Subject\n\nBody"],
		]) {
			await fs.writeFile(path.join(repoDir, "a.txt"), `${message}\n`);
			git("add a.txt");

			const res = await commit(message);

			expect(res.status).toBe(200);
			expect(git("log -1 --format=%B").trimEnd()).toBe(stored);
		}
	}, 20_000);

	test("commits a message too long for a command line", async () => {
		await initRepo();
		await fs.writeFile(path.join(repoDir, "a.txt"), "two\n");
		git("add a.txt");
		const body = Array.from({ length: 600 }, () =>
			"word ".repeat(15).trim(),
		).join("\n");
		const message = `Long message\n\n${body}`;
		expect(message.length).toBeGreaterThan(40_000);

		const res = await commit(message);

		expect(res.status).toBe(200);
		expect(git("log -1 --format=%B").trimEnd()).toBe(message);
	});

	test("makes a repo's first commit", async () => {
		await initRepo({ withCommit: false });
		await fs.writeFile(path.join(repoDir, "a.txt"), "one\n");
		git("add a.txt");

		const res = await commit("First");

		expect(res.status).toBe(200);
		expect(res.body.commit).toBe(git("rev-parse HEAD").trim());
		expect(res.body.files).toEqual([]);
	});

	test("refuses a missing or blank message", async () => {
		await initRepo();
		await fs.writeFile(path.join(repoDir, "a.txt"), "two\n");
		git("add a.txt");
		const head = git("rev-parse HEAD");

		for (const message of [undefined, "", " \n\t", 42]) {
			const res = await commit(message);

			expect(res.status).toBe(400);
			expect(res.body.error.code).toBe("MISSING_MESSAGE");
		}
		expect(git("rev-parse HEAD")).toBe(head);
	});

	test("refuses when nothing is staged", async () => {
		await initRepo();
		await fs.writeFile(path.join(repoDir, "a.txt"), "two\n");
		const head = git("rev-parse HEAD");

		const res = await commit("Change a");

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("NO_STAGED_CHANGES");
		expect(git("rev-parse HEAD")).toBe(head);
	});

	test("reports git's own message when the commit fails", async () => {
		await initRepo();
		const hook = path.join(repoDir, ".git", "hooks", "pre-commit");
		await fs.writeFile(
			hook,
			"#!/bin/sh\necho 'the hook refused' >&2\nexit 1\n",
		);
		await fs.chmod(hook, 0o755);
		await fs.writeFile(path.join(repoDir, "a.txt"), "two\n");
		git("add a.txt");
		const head = git("rev-parse HEAD");

		const res = await commit("Change a");

		expect(res.status).toBe(500);
		expect(res.body.error.code).toBe("GIT_ERROR");
		expect(res.body.error.message).toContain("the hook refused");
		expect(git("rev-parse HEAD")).toBe(head);
	});

	test("refuses outside a git repository", async () => {
		await fs.mkdir(repoDir);

		const res = await commit("Change a");

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("NOT_GIT_REPO");
	});

	test("refuses when the server does not allow writes", async () => {
		await initRepo();
		await fs.writeFile(path.join(repoDir, "a.txt"), "two\n");
		git("add a.txt");
		const head = git("rev-parse HEAD");
		app = createApp(makeConfig(reposRoot, false));

		const res = await commit("Change a");

		expect(res.status).toBe(403);
		expect(git("rev-parse HEAD")).toBe(head);
	});
});
