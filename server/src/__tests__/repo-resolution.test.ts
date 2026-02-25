import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import supertest from "supertest";
import { type AppConfig, createApp } from "../app.js";
import { resolveRepo } from "../pathUtils.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeConfig(reposRoot: string): AppConfig {
	return {
		port: 3000,
		agentCommand: "echo",
		reposRoot,
		basePath: "",
	};
}

// ---------------------------------------------------------------------------
// Unit tests for resolveRepo
// ---------------------------------------------------------------------------

describe("resolveRepo (unit)", () => {
	let reposRoot: string;

	beforeAll(async () => {
		reposRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rift-resolve-unit-"));
		// Create a simple repo directory
		await fs.mkdir(path.join(reposRoot, "simple-repo"));
		// Create a nested org/repo directory
		await fs.mkdir(path.join(reposRoot, "org"), { recursive: true });
		await fs.mkdir(path.join(reposRoot, "org", "nested-repo"));
		// Create a file (not a directory)
		await fs.writeFile(path.join(reposRoot, "not-a-dir"), "file content");
	});

	afterAll(async () => {
		await fs.rm(reposRoot, { recursive: true, force: true });
	});

	test("resolves a simple repo name to an absolute path", async () => {
		const result = await resolveRepo(reposRoot, "simple-repo");
		expect(result).toEqual({
			ok: true,
			path: path.join(reposRoot, "simple-repo"),
		});
	});

	test("resolves a multi-level repo name (org/repo)", async () => {
		const result = await resolveRepo(reposRoot, "org/nested-repo");
		expect(result).toEqual({
			ok: true,
			path: path.join(reposRoot, "org", "nested-repo"),
		});
	});

	test("rejects empty repo name as forbidden", async () => {
		const result = await resolveRepo(reposRoot, "");
		expect(result).toEqual({ ok: false, reason: "forbidden" });
	});

	test("rejects repo name with .. as forbidden", async () => {
		const result = await resolveRepo(reposRoot, "../etc");
		expect(result).toEqual({ ok: false, reason: "forbidden" });
	});

	test("rejects repo name with embedded .. as forbidden", async () => {
		const result = await resolveRepo(reposRoot, "foo/../../../etc");
		expect(result).toEqual({ ok: false, reason: "forbidden" });
	});

	test("rejects absolute path as forbidden", async () => {
		const result = await resolveRepo(reposRoot, "/etc/passwd");
		expect(result).toEqual({ ok: false, reason: "forbidden" });
	});

	test("rejects nonexistent repo as not_found", async () => {
		const result = await resolveRepo(reposRoot, "does-not-exist");
		expect(result).toEqual({ ok: false, reason: "not_found" });
	});

	test("rejects path that resolves to a file as not_found", async () => {
		const result = await resolveRepo(reposRoot, "not-a-dir");
		expect(result).toEqual({ ok: false, reason: "not_found" });
	});
});

// ---------------------------------------------------------------------------
// Integration tests: repo resolution across all route families
// ---------------------------------------------------------------------------

describe("repo resolution across endpoints", () => {
	let reposRoot: string;
	let repoDir: string;
	let app: ReturnType<typeof createApp>;
	let commitHash: string;
	const repoName = "test-repo";

	beforeAll(async () => {
		reposRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rift-repo-res-"));
		repoDir = path.join(reposRoot, repoName);
		await fs.mkdir(repoDir);

		// Initialise a git repo with one commit
		execSync("git init", { cwd: repoDir });
		execSync("git config user.email 'test@test.com'", { cwd: repoDir });
		execSync("git config user.name 'Test'", { cwd: repoDir });
		await fs.writeFile(path.join(repoDir, "file.txt"), "content\n");
		execSync("git add file.txt", { cwd: repoDir });
		execSync('git commit -m "init"', { cwd: repoDir });
		commitHash = execSync("git rev-parse HEAD", { cwd: repoDir })
			.toString()
			.trim();

		app = createApp(makeConfig(reposRoot));
	});

	afterAll(async () => {
		await fs.rm(reposRoot, { recursive: true, force: true });
	});

	// -----------------------------------------------------------------------
	// Helper: endpoints that require a commit hash are computed lazily so
	// commitHash (set in beforeAll) is available.
	// -----------------------------------------------------------------------

	function absolutePathEndpoints(): Array<{ endpoint: string; label: string }> {
		return [
			{ endpoint: "/api/files?repo=/etc&path=.", label: "files listing" },
			{
				endpoint: "/api/files/content?repo=/etc&path=passwd",
				label: "files content",
			},
			{ endpoint: "/api/git/status?repo=/etc", label: "git status" },
			{ endpoint: "/api/git/log?repo=/etc", label: "git log" },
			{
				endpoint: `/api/git/commit/${commitHash}?repo=/etc`,
				label: "git commit",
			},
			{
				endpoint: `/api/git/commit/${commitHash}/diff?repo=/etc&path=file.txt`,
				label: "git commit diff",
			},
			{
				endpoint: "/api/git/diff?repo=/etc&path=file.txt",
				label: "git diff",
			},
		];
	}

	// -----------------------------------------------------------------------
	// Absolute path in repo parameter (should be 403)
	// -----------------------------------------------------------------------

	test("returns 403 for absolute path in repo across all endpoints", async () => {
		for (const { endpoint, label } of absolutePathEndpoints()) {
			const res = await supertest(app).get(endpoint);
			expect(res.status).toBe(403);
			expect(res.body.error.code).toBe("REPO_FORBIDDEN");
		}
	});

	// -----------------------------------------------------------------------
	// Path traversal with .. in repo parameter (should be 403)
	// -----------------------------------------------------------------------

	function traversalEndpoints(): Array<{ endpoint: string; label: string }> {
		return [
			{
				endpoint: "/api/files/content?repo=../etc&path=passwd",
				label: "files content",
			},
			{ endpoint: "/api/git/log?repo=../etc", label: "git log" },
			{
				endpoint: `/api/git/commit/${commitHash}?repo=../etc`,
				label: "git commit",
			},
			{
				endpoint: `/api/git/commit/${commitHash}/diff?repo=../etc&path=file.txt`,
				label: "git commit diff",
			},
			{
				endpoint: "/api/git/diff?repo=../etc&path=file.txt",
				label: "git diff",
			},
		];
	}

	test("returns 403 for .. in repo across all endpoints", async () => {
		for (const { endpoint, label } of traversalEndpoints()) {
			const res = await supertest(app).get(endpoint);
			expect(res.status).toBe(403);
			expect(res.body.error.code).toBe("REPO_FORBIDDEN");
		}
	});

	// -----------------------------------------------------------------------
	// Missing repo parameter (should be 400)
	// -----------------------------------------------------------------------

	function missingRepoEndpoints(): Array<{ endpoint: string; label: string }> {
		return [
			{ endpoint: "/api/git/log", label: "git log" },
			{
				endpoint: `/api/git/commit/${commitHash}`,
				label: "git commit",
			},
			{
				endpoint: `/api/git/commit/${commitHash}/diff?path=file.txt`,
				label: "git commit diff",
			},
			{ endpoint: "/api/git/diff?path=file.txt", label: "git diff" },
		];
	}

	test("returns 400 when repo parameter is missing across git endpoints", async () => {
		for (const { endpoint, label } of missingRepoEndpoints()) {
			const res = await supertest(app).get(endpoint);
			expect(res.status).toBe(400);
			expect(res.body.error.code).toBe("MISSING_REPO");
		}
	});

	// -----------------------------------------------------------------------
	// Nonexistent repo (should be 404)
	// -----------------------------------------------------------------------

	function nonexistentRepoEndpoints(): Array<{
		endpoint: string;
		label: string;
	}> {
		return [
			{
				endpoint: "/api/files/content?repo=no-such-repo&path=foo",
				label: "files content",
			},
			{ endpoint: "/api/git/log?repo=no-such-repo", label: "git log" },
			{
				endpoint: `/api/git/commit/${commitHash}?repo=no-such-repo`,
				label: "git commit",
			},
			{
				endpoint: `/api/git/commit/${commitHash}/diff?repo=no-such-repo&path=file.txt`,
				label: "git commit diff",
			},
			{
				endpoint: "/api/git/diff?repo=no-such-repo&path=file.txt",
				label: "git diff",
			},
			{
				endpoint: "/api/health?repo=no-such-repo",
				label: "health",
			},
		];
	}

	test("returns 404 for nonexistent repo across all endpoints", async () => {
		for (const { endpoint, label } of nonexistentRepoEndpoints()) {
			const res = await supertest(app).get(endpoint);
			expect(res.status).toBe(404);
			expect(res.body.error.code).toBe("NOT_FOUND");
		}
	});

	// -----------------------------------------------------------------------
	// Multi-level repo name (org/repo)
	// -----------------------------------------------------------------------

	test("files listing works with multi-level repo name", async () => {
		// Create org/nested-repo under the same reposRoot
		const nestedDir = path.join(reposRoot, "org", "nested-repo");
		await fs.mkdir(nestedDir, { recursive: true });
		await fs.writeFile(path.join(nestedDir, "hello.txt"), "hi");

		const res = await supertest(app).get(
			"/api/files?repo=org/nested-repo&path=.",
		);

		expect(res.status).toBe(200);
		const names = res.body.entries.map((e: { name: string }) => e.name);
		expect(names).toContain("hello.txt");

		// Clean up
		await fs.rm(path.join(reposRoot, "org"), { recursive: true, force: true });
	});

	// -----------------------------------------------------------------------
	// Health endpoint edge cases
	// -----------------------------------------------------------------------

	test("health returns ok without gitRepo when no repo specified", async () => {
		const res = await supertest(app).get("/api/health");
		expect(res.status).toBe(200);
		expect(res.body.status).toBe("ok");
		expect(res.body.gitRepo).toBeUndefined();
	});

	test("health returns 403 for absolute repo path", async () => {
		const res = await supertest(app).get("/api/health?repo=/etc");
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("REPO_FORBIDDEN");
	});

	test("health returns gitRepo: true for valid git repo", async () => {
		const res = await supertest(app).get(`/api/health?repo=${repoName}`);
		expect(res.status).toBe(200);
		expect(res.body.status).toBe("ok");
		expect(res.body.gitRepo).toBe(true);
	});

	test("health returns gitRepo: false for non-git directory", async () => {
		await fs.mkdir(path.join(reposRoot, "plain-dir"));
		const res = await supertest(app).get("/api/health?repo=plain-dir");
		expect(res.status).toBe(200);
		expect(res.body.status).toBe("ok");
		expect(res.body.gitRepo).toBe(false);
		await fs.rm(path.join(reposRoot, "plain-dir"), {
			recursive: true,
			force: true,
		});
	});
});
