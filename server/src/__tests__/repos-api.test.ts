import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import supertest from "supertest";
import { type AppConfig, createApp } from "../app.js";

function makeConfig(reposRoot: string): AppConfig {
	return {
		port: 3000,
		reposRoot,
	};
}

describe("GET /api/repos", () => {
	let reposRoot: string;
	let app: ReturnType<typeof createApp>;

	beforeAll(async () => {
		reposRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rift-repos-api-"));

		// Create a flat git repo: reposRoot/alpha/.git
		await fs.mkdir(path.join(reposRoot, "alpha", ".git"), {
			recursive: true,
		});

		// Create a nested git repo: reposRoot/org/beta/.git
		await fs.mkdir(path.join(reposRoot, "org", "beta", ".git"), {
			recursive: true,
		});

		// Create another nested git repo: reposRoot/org/gamma/.git
		await fs.mkdir(path.join(reposRoot, "org", "gamma", ".git"), {
			recursive: true,
		});

		// Create a plain directory (no .git) — should NOT appear in results
		await fs.mkdir(path.join(reposRoot, "not-a-repo"), { recursive: true });

		// Create a regular file at the top level — should be ignored
		await fs.writeFile(path.join(reposRoot, "some-file.txt"), "hello");

		app = createApp(makeConfig(reposRoot));
	});

	afterAll(async () => {
		await fs.rm(reposRoot, { recursive: true, force: true });
	});

	test("returns repos found in nested git-initialised subdirs", async () => {
		const res = await supertest(app).get("/api/repos");
		expect(res.status).toBe(200);
		expect(res.body.repos).toBeArray();

		const names = res.body.repos.map((r: { name: string }) => r.name);
		expect(names).toContain("alpha");
		expect(names).toContain(path.join("org", "beta"));
		expect(names).toContain(path.join("org", "gamma"));
	});

	test("returns repos sorted alphabetically by name", async () => {
		const res = await supertest(app).get("/api/repos");
		expect(res.status).toBe(200);

		const names = res.body.repos.map((r: { name: string }) => r.name);
		const sorted = [...names].sort((a: string, b: string) =>
			a.localeCompare(b),
		);
		expect(names).toEqual(sorted);
	});

	test("each repo entry has name and path fields", async () => {
		const res = await supertest(app).get("/api/repos");
		expect(res.status).toBe(200);

		for (const repo of res.body.repos) {
			expect(typeof repo.name).toBe("string");
			expect(typeof repo.path).toBe("string");
			expect(repo.name.length).toBeGreaterThan(0);
			expect(path.isAbsolute(repo.path)).toBe(true);
		}
	});

	test("repo path is the absolute path to the repo directory", async () => {
		const res = await supertest(app).get("/api/repos");
		const alpha = res.body.repos.find(
			(r: { name: string }) => r.name === "alpha",
		);
		expect(alpha).toBeDefined();
		expect(alpha.path).toBe(path.join(reposRoot, "alpha"));
	});

	test("non-git subdirectories are recursed into but not returned", async () => {
		const res = await supertest(app).get("/api/repos");
		const names = res.body.repos.map((r: { name: string }) => r.name);

		// "org" is a non-git directory — it should NOT appear as a repo
		expect(names).not.toContain("org");
		// "not-a-repo" has no .git — it should NOT appear either
		expect(names).not.toContain("not-a-repo");
	});

	test("directories containing .git are returned and not recursed further", async () => {
		// Add a nested .git inside alpha to verify no further recursion
		await fs.mkdir(path.join(reposRoot, "alpha", "sub", ".git"), {
			recursive: true,
		});

		const res = await supertest(app).get("/api/repos");
		const names = res.body.repos.map((r: { name: string }) => r.name);

		// alpha should appear but alpha/sub should NOT (recursion stops at alpha)
		expect(names).toContain("alpha");
		expect(names).not.toContain(path.join("alpha", "sub"));

		// Clean up
		await fs.rm(path.join(reposRoot, "alpha", "sub"), {
			recursive: true,
			force: true,
		});
	});

	test("non-directory entries are excluded", async () => {
		const res = await supertest(app).get("/api/repos");
		const names = res.body.repos.map((r: { name: string }) => r.name);

		// The file "some-file.txt" must not appear
		expect(names).not.toContain("some-file.txt");
	});

	test("unreadable directories do not crash the endpoint", async () => {
		const unreadable = path.join(reposRoot, "unreadable");
		await fs.mkdir(unreadable);
		await fs.chmod(unreadable, 0o000);

		const res = await supertest(app).get("/api/repos");
		expect(res.status).toBe(200);
		expect(res.body.repos).toBeArray();

		// Restore permissions and clean up
		await fs.chmod(unreadable, 0o755);
		await fs.rm(unreadable, { recursive: true, force: true });
	});

	test("returns empty array when reposRoot has no repos", async () => {
		const emptyRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "rift-repos-empty-"),
		);
		const emptyApp = createApp(makeConfig(emptyRoot));

		const res = await supertest(emptyApp).get("/api/repos");
		expect(res.status).toBe(200);
		expect(res.body.repos).toEqual([]);

		await fs.rm(emptyRoot, { recursive: true, force: true });
	});

	test("follows symlinks to git repos", async () => {
		const externalDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "rift-repos-ext-"),
		);
		await fs.mkdir(path.join(externalDir, "ext-repo", ".git"), {
			recursive: true,
		});

		// Create a symlink inside reposRoot pointing to the external repo
		await fs.symlink(
			path.join(externalDir, "ext-repo"),
			path.join(reposRoot, "linked-repo"),
		);

		const res = await supertest(app).get("/api/repos");
		const names = res.body.repos.map((r: { name: string }) => r.name);
		expect(names).toContain("linked-repo");

		// Clean up
		await fs.rm(path.join(reposRoot, "linked-repo"));
		await fs.rm(externalDir, { recursive: true, force: true });
	});

	test("detects .git files (worktrees and submodules)", async () => {
		// Git worktrees and submodules use a .git file instead of a directory
		const worktreeDir = path.join(reposRoot, "worktree-repo");
		await fs.mkdir(worktreeDir);
		await fs.writeFile(
			path.join(worktreeDir, ".git"),
			"gitdir: /some/other/path",
		);

		const res = await supertest(app).get("/api/repos");
		const names = res.body.repos.map((r: { name: string }) => r.name);
		expect(names).toContain("worktree-repo");

		// Clean up
		await fs.rm(worktreeDir, { recursive: true, force: true });
	});

	test("respects max depth limit", async () => {
		// Create a repo at depth 5 (beyond the MAX_DEPTH of 4)
		// Root = depth 1, so level1/level2/level3/level4/deep-repo = depth 5
		const deepPath = path.join(
			reposRoot,
			"level1",
			"level2",
			"level3",
			"level4",
			"deep-repo",
			".git",
		);
		await fs.mkdir(deepPath, { recursive: true });

		// Also create a repo exactly at depth 4 (should be found)
		const atLimitPath = path.join(
			reposRoot,
			"level1",
			"level2",
			"level3",
			"at-limit",
			".git",
		);
		await fs.mkdir(atLimitPath, { recursive: true });

		const res = await supertest(app).get("/api/repos");
		const names = res.body.repos.map((r: { name: string }) => r.name);

		// Repo at depth 4 should be found
		expect(names).toContain(
			path.join("level1", "level2", "level3", "at-limit"),
		);
		// Repo at depth 5 should NOT be found (beyond MAX_DEPTH)
		expect(names).not.toContain(
			path.join("level1", "level2", "level3", "level4", "deep-repo"),
		);

		// Clean up
		await fs.rm(path.join(reposRoot, "level1"), {
			recursive: true,
			force: true,
		});
	});
});
