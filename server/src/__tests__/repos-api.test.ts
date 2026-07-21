import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import supertest from "supertest";
import { type AppConfig, createApp } from "../app.js";

function makeConfig(reposRoot: string): AppConfig {
	return {
		port: 3000,
		roots: [{ label: "root", path: reposRoot }],
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

	test("returns immediate child repos qualified by root label", async () => {
		const res = await supertest(app).get("/api/repos");
		expect(res.status).toBe(200);
		expect(res.body.repos).toBeArray();

		const names = res.body.repos.map((r: { name: string }) => r.name);
		expect(names).toContain("root/alpha");
	});

	test("does not descend past immediate children", async () => {
		const res = await supertest(app).get("/api/repos");
		const names = res.body.repos.map((r: { name: string }) => r.name);

		// org/beta and org/gamma sit one level too deep for a depth-1 scan.
		expect(names).not.toContain("root/org/beta");
		expect(names).not.toContain("root/org/gamma");
	});

	test("names use forward slashes on every platform", async () => {
		const res = await supertest(app).get("/api/repos");
		for (const repo of res.body.repos) {
			expect(repo.name).not.toInclude("\\");
		}
	});

	test("merges repos from every configured root", async () => {
		const secondRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "rift-repos-second-"),
		);
		await fs.mkdir(path.join(secondRoot, "delta", ".git"), { recursive: true });

		const multiApp = createApp({
			port: 3000,
			roots: [
				{ label: "root", path: reposRoot },
				{ label: "other", path: secondRoot },
			],
		});

		const res = await supertest(multiApp).get("/api/repos");
		const names = res.body.repos.map((r: { name: string }) => r.name);
		expect(names).toContain("root/alpha");
		expect(names).toContain("other/delta");

		await fs.rm(secondRoot, { recursive: true, force: true });
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
			(r: { name: string }) => r.name === "root/alpha",
		);
		expect(alpha).toBeDefined();
		expect(alpha.path).toBe(path.join(reposRoot, "alpha"));
	});

	test("non-git subdirectories are not returned", async () => {
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
		expect(names).toContain("root/alpha");
		expect(names).not.toContain("root/alpha/sub");

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

		// Create a symlink inside reposRoot pointing to the external repo.
		// Use "junction" on Windows (works without elevated privileges).
		const linkPath = path.join(reposRoot, "linked-repo");
		try {
			await fs.symlink(
				path.join(externalDir, "ext-repo"),
				linkPath,
				"junction",
			);
		} catch {
			// Symlinks may require elevated privileges; skip gracefully
			await fs.rm(externalDir, { recursive: true, force: true });
			return;
		}

		const res = await supertest(app).get("/api/repos");
		const names = res.body.repos.map((r: { name: string }) => r.name);
		expect(names).toContain("root/linked-repo");

		// Clean up — junctions/symlinks must be unlinked, not rm'd
		await fs.unlink(linkPath);
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
		expect(names).toContain("root/worktree-repo");

		// Clean up
		await fs.rm(worktreeDir, { recursive: true, force: true });
	});

	test("respects max depth limit", async () => {
		// A repo one level below the root is already past the depth-1 scan, so a
		// large non-repo tree beside the checkouts is never walked.
		await fs.mkdir(path.join(reposRoot, "level1", "deep-repo", ".git"), {
			recursive: true,
		});

		const res = await supertest(app).get("/api/repos");
		const names = res.body.repos.map((r: { name: string }) => r.name);

		expect(names).not.toContain("root/level1/deep-repo");
		expect(names).not.toContain("root/level1");

		// Clean up
		await fs.rm(path.join(reposRoot, "level1"), {
			recursive: true,
			force: true,
		});
	});
});
