import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import * as realChildProcess from "node:child_process";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import supertest from "supertest";
import { createApp } from "../app.js";
import { isRefusedRepo, locateRepo } from "../gitRepo.js";

// The git commands the server starts, as the arguments after the options Rift
// gives every command. simple-git imports `spawn` by name, so a spy on the
// module's export would not see its calls; replacing the module does.
let started: string[] = [];
const realModule = { ...realChildProcess };
const recordingSpawn = ((
	command: string,
	args: string[],
	...rest: unknown[]
) => {
	started.push(args.filter((arg) => arg !== "--no-optional-locks").join(" "));
	return (realModule.spawn as (...all: unknown[]) => unknown)(
		command,
		args,
		...rest,
	);
}) as typeof realModule.spawn;

describe("finding a repository's top level", () => {
	let work: string;
	let reposRoot: string;
	let app: ReturnType<typeof createApp>;

	// A repository with one commit and one unstaged change.
	async function makeRepo(dir: string) {
		await fs.mkdir(dir, { recursive: true });
		execSync("git init", { cwd: dir });
		execSync("git config user.email 'test@test.com'", { cwd: dir });
		execSync("git config user.name 'Test'", { cwd: dir });
		await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\n");
		execSync("git add a.txt", { cwd: dir });
		execSync('git commit -m "initial"', { cwd: dir });
		await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
	}

	beforeAll(async () => {
		work = await fs.mkdtemp(path.join(os.tmpdir(), "rift-locate-"));
		reposRoot = path.join(work, "repos");
		await makeRepo(path.join(reposRoot, "normal"));

		// A linked worktree, whose .git is a file naming the main repository's.
		execSync("git worktree add ../linked-wt -b linked", {
			cwd: path.join(reposRoot, "normal"),
		});

		await fs.mkdir(path.join(reposRoot, "plain"));
		await fs.writeFile(path.join(reposRoot, "plain", "b.txt"), "b\n");

		// A .git file that names a directory that is not there.
		await fs.mkdir(path.join(reposRoot, "dangling"));
		await fs.writeFile(
			path.join(reposRoot, "dangling", ".git"),
			`gitdir: ${path.join(work, "no-such-gitdir")}\n`,
		);

		// A .git directory that is not a repository.
		await fs.mkdir(path.join(reposRoot, "corrupt", ".git"), {
			recursive: true,
		});

		await fs.mkdir(path.join(reposRoot, "normal", "sub"));
		await fs.writeFile(path.join(reposRoot, "normal", "sub", "c.txt"), "c\n");

		app = createApp({
			port: 3000,
			roots: [{ label: "root", path: reposRoot }],
			allowedLogins: [],
			allowWrites: true,
		});

		mock.module("node:child_process", () => ({
			...realModule,
			spawn: recordingSpawn,
			default: { ...realModule, spawn: recordingSpawn },
		}));
	});

	afterAll(async () => {
		mock.module("node:child_process", () => ({
			...realModule,
			default: realModule,
		}));
		await fs.rm(work, { recursive: true, force: true });
	});

	beforeEach(() => {
		started = [];
	});

	test("a normal repository is found without starting git", async () => {
		const repo = await locateRepo(path.join(reposRoot, "normal"));
		expect(repo?.toplevel).toBe(path.join(reposRoot, "normal"));
		expect(started).toEqual([]);
	});

	test("status in a normal repository starts one git process", async () => {
		const res = await supertest(app).get("/api/git/status?repo=root/normal");
		expect(res.status).toBe(200);
		expect(res.body.files).toEqual([
			{ path: "a.txt", status: "modified", staged: false },
			{ path: "sub/c.txt", status: "untracked", staged: false },
		]);
		expect(started).toHaveLength(1);
		expect(started[0]).toStartWith("status");
	});

	test("a diff in a normal repository starts one git process", async () => {
		const res = await supertest(app).get(
			"/api/git/diff?repo=root/normal&path=a.txt",
		);
		expect(res.status).toBe(200);
		expect(res.body.diff).toContain("+three");
		expect(started).toHaveLength(1);
		expect(started[0]).toContain("diff");
	});

	test("a linked worktree, whose .git is a file, is found without starting git", async () => {
		const dir = path.join(reposRoot, "linked-wt");
		expect((await fs.stat(path.join(dir, ".git"))).isFile()).toBe(true);
		const repo = await locateRepo(dir);
		expect(repo?.toplevel).toBe(dir);
		expect(started).toEqual([]);

		const res = await supertest(app).get("/api/git/log?repo=root/linked-wt");
		expect(res.status).toBe(200);
		expect(res.body.commits).toHaveLength(1);
		expect(started).toHaveLength(1);
	});

	test("a subdirectory of a repository falls back to asking git", async () => {
		const repo = await locateRepo(path.join(reposRoot, "normal", "sub"));
		expect(path.resolve(repo?.toplevel ?? "")).toBe(
			path.join(reposRoot, "normal"),
		);
		expect(started).toHaveLength(2);

		const diff = await supertest(app).get(
			"/api/git/diff?repo=root/normal/sub&path=a.txt",
		);
		expect(diff.status).toBe(200);
		expect(diff.body.diff).toContain("+three");

		const status = await supertest(app).get(
			"/api/git/status?repo=root/normal/sub",
		);
		expect(status.status).toBe(200);
		expect(status.body.files).toEqual([
			{ path: "a.txt", status: "modified", staged: false },
			{ path: "sub/c.txt", status: "untracked", staged: false },
		]);
	});

	test("a directory with no .git is not a repository", async () => {
		expect(await locateRepo(path.join(reposRoot, "plain"))).toBeNull();
		for (const url of [
			"/api/git/status?repo=root/plain",
			"/api/git/log?repo=root/plain",
			"/api/git/diff?repo=root/plain&path=b.txt",
			"/api/git/base-content?repo=root/plain&path=b.txt",
			"/api/git/commit/abcdef1?repo=root/plain",
			"/api/git/commit/abcdef1/diff?repo=root/plain&path=b.txt",
		]) {
			const res = await supertest(app).get(url);
			expect(res.status).toBe(400);
			expect(res.body.error.code).toBe("NOT_GIT_REPO");
		}
		for (const action of ["stage", "unstage", "commit"]) {
			const res = await supertest(app)
				.post(`/api/git/${action}?repo=root/plain`)
				.send({ path: "b.txt", message: "m" });
			expect(res.status).toBe(400);
			expect(res.body.error.code).toBe("NOT_GIT_REPO");
		}
	});

	for (const name of ["dangling", "corrupt"]) {
		test(`a .git that git refuses (${name}) answers NOT_GIT_REPO, not GIT_ERROR`, async () => {
			expect(await isRefusedRepo(path.join(reposRoot, name))).toBe(true);
			for (const url of [
				"status",
				"log",
				"diff",
				"base-content",
				"commit/abcdef1",
				"commit/abcdef1/diff",
			]) {
				const res = await supertest(app).get(
					`/api/git/${url}?repo=root/${name}&path=b.txt`,
				);
				expect(res.status).toBe(400);
				expect(res.body.error.code).toBe("NOT_GIT_REPO");
			}
			for (const action of ["stage", "unstage", "commit"]) {
				const res = await supertest(app)
					.post(`/api/git/${action}?repo=root/${name}`)
					.send({ path: "b.txt", message: "m" });
				expect(res.status).toBe(400);
				expect(res.body.error.code).toBe("NOT_GIT_REPO");
			}
		});
	}

	test("a failure in a sound repository is not taken for a refused one", async () => {
		const res = await supertest(app).get(
			"/api/git/base-content?repo=root/normal&path=missing.txt",
		);
		expect(res.status).toBe(404);
		expect(res.body.error.code).toBe("NOT_FOUND");
	});
});
