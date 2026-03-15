import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import supertest from "supertest";
import { type AppConfig, createApp } from "../app.js";

const repoName = "test-repo";

function makeConfig(reposRoot: string): AppConfig {
	return {
		port: 3000,
		reposRoot,
	};
}

describe("GET /api/git/status", () => {
	let reposRoot: string;
	let repoDir: string;
	let app: ReturnType<typeof createApp>;

	beforeAll(async () => {
		reposRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rift-git-status-"));
		repoDir = path.join(reposRoot, repoName);
		await fs.mkdir(repoDir);

		execSync("git init", { cwd: repoDir });
		execSync("git config user.email 'test@test.com'", { cwd: repoDir });
		execSync("git config user.name 'Test'", { cwd: repoDir });

		// Create an initial commit so HEAD exists
		await fs.writeFile(path.join(repoDir, "init.txt"), "init");
		execSync("git add init.txt", { cwd: repoDir });
		execSync('git commit -m "initial"', { cwd: repoDir });

		app = createApp(makeConfig(reposRoot));
	});

	afterAll(async () => {
		await fs.rm(reposRoot, { recursive: true, force: true });
	});

	test("returns empty files array when working tree is clean", async () => {
		const res = await supertest(app).get(`/api/git/status?repo=${repoName}`);

		expect(res.status).toBe(200);
		expect(res.body.files).toEqual([]);
	});

	test("returns untracked file as unstaged", async () => {
		await fs.writeFile(path.join(repoDir, "new.txt"), "hello");

		const res = await supertest(app).get(`/api/git/status?repo=${repoName}`);

		expect(res.status).toBe(200);
		const entries = res.body.files.filter(
			(f: { path: string }) => f.path === "new.txt",
		);
		expect(entries.length).toBe(1);
		expect(entries[0].status).toBe("untracked");
		expect(entries[0].staged).toBe(false);

		// Clean up
		await fs.unlink(path.join(repoDir, "new.txt"));
	});

	test("returns staged added file with staged=true", async () => {
		await fs.writeFile(path.join(repoDir, "staged.txt"), "staged content");
		execSync("git add staged.txt", { cwd: repoDir });

		const res = await supertest(app).get(`/api/git/status?repo=${repoName}`);

		expect(res.status).toBe(200);
		const entry = res.body.files.find(
			(f: { path: string }) => f.path === "staged.txt",
		);
		expect(entry).toBeDefined();
		expect(entry.status).toBe("added");
		expect(entry.staged).toBe(true);

		// Clean up
		execSync("git reset HEAD staged.txt", { cwd: repoDir });
		await fs.unlink(path.join(repoDir, "staged.txt"));
	});

	test("returns modified file as unstaged", async () => {
		// Modify an existing committed file
		await fs.writeFile(path.join(repoDir, "init.txt"), "modified content");

		const res = await supertest(app).get(`/api/git/status?repo=${repoName}`);

		expect(res.status).toBe(200);
		const entry = res.body.files.find(
			(f: { path: string; staged: boolean }) =>
				f.path === "init.txt" && !f.staged,
		);
		expect(entry).toBeDefined();
		expect(entry.status).toBe("modified");
		expect(entry.staged).toBe(false);

		// Clean up
		execSync("git checkout -- init.txt", { cwd: repoDir });
	});

	test("returns deleted file as unstaged", async () => {
		// Delete a committed file without staging the deletion
		await fs.unlink(path.join(repoDir, "init.txt"));

		const res = await supertest(app).get(`/api/git/status?repo=${repoName}`);

		expect(res.status).toBe(200);
		const entry = res.body.files.find(
			(f: { path: string; staged: boolean }) =>
				f.path === "init.txt" && !f.staged,
		);
		expect(entry).toBeDefined();
		expect(entry.status).toBe("deleted");
		expect(entry.staged).toBe(false);

		// Clean up
		execSync("git checkout -- init.txt", { cwd: repoDir });
	});

	test("returns both staged and unstaged entries for same file", async () => {
		// Stage a modification, then modify again
		await fs.writeFile(path.join(repoDir, "init.txt"), "first change");
		execSync("git add init.txt", { cwd: repoDir });
		await fs.writeFile(path.join(repoDir, "init.txt"), "second change");

		const res = await supertest(app).get(`/api/git/status?repo=${repoName}`);

		expect(res.status).toBe(200);
		const stagedEntry = res.body.files.find(
			(f: { path: string; staged: boolean }) =>
				f.path === "init.txt" && f.staged,
		);
		const unstagedEntry = res.body.files.find(
			(f: { path: string; staged: boolean }) =>
				f.path === "init.txt" && !f.staged,
		);
		expect(stagedEntry).toBeDefined();
		expect(stagedEntry.status).toBe("modified");
		expect(unstagedEntry).toBeDefined();
		expect(unstagedEntry.status).toBe("modified");

		// Clean up
		execSync("git checkout -- init.txt", { cwd: repoDir });
		execSync("git reset HEAD init.txt", { cwd: repoDir });
	});
});

describe("GET /api/git/status (not a git repo)", () => {
	let reposRoot: string;
	let app: ReturnType<typeof createApp>;

	beforeAll(async () => {
		reposRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rift-git-norepo-"));
		// Create a non-git directory as the "repo"
		await fs.mkdir(path.join(reposRoot, "not-a-repo"));
		app = createApp(makeConfig(reposRoot));
	});

	afterAll(async () => {
		await fs.rm(reposRoot, { recursive: true, force: true });
	});

	test("returns NOT_GIT_REPO error with status 400", async () => {
		const res = await supertest(app).get("/api/git/status?repo=not-a-repo");

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("NOT_GIT_REPO");
	});
});

describe("GET /api/git/status (missing repo param)", () => {
	test("returns MISSING_REPO error with status 400", async () => {
		const reposRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "rift-git-noparam-"),
		);
		const app = createApp(makeConfig(reposRoot));

		const res = await supertest(app).get("/api/git/status");

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("MISSING_REPO");

		await fs.rm(reposRoot, { recursive: true, force: true });
	});
});

describe("GET /api/git/status (repo traversal)", () => {
	test("returns 403 for repo with ../", async () => {
		const reposRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "rift-git-trav-"),
		);
		const app = createApp(makeConfig(reposRoot));

		const res = await supertest(app).get("/api/git/status?repo=../etc");

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("REPO_FORBIDDEN");

		await fs.rm(reposRoot, { recursive: true, force: true });
	});

	test("returns 404 for nonexistent repo", async () => {
		const reposRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "rift-git-noexist-"),
		);
		const app = createApp(makeConfig(reposRoot));

		const res = await supertest(app).get("/api/git/status?repo=no-such-repo");

		expect(res.status).toBe(404);
		expect(res.body.error.code).toBe("NOT_FOUND");

		await fs.rm(reposRoot, { recursive: true, force: true });
	});
});

describe("GET /api/git/diff", () => {
	let reposRoot: string;
	let repoDir: string;
	let app: ReturnType<typeof createApp>;

	beforeAll(async () => {
		reposRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rift-git-diff-"));
		repoDir = path.join(reposRoot, repoName);
		await fs.mkdir(repoDir);

		execSync("git init", { cwd: repoDir });
		execSync("git config user.email 'test@test.com'", { cwd: repoDir });
		execSync("git config user.name 'Test'", { cwd: repoDir });

		await fs.writeFile(path.join(repoDir, "file.txt"), "original\n");
		execSync("git add file.txt", { cwd: repoDir });
		execSync('git commit -m "initial"', { cwd: repoDir });

		app = createApp(makeConfig(reposRoot));
	});

	afterAll(async () => {
		await fs.rm(reposRoot, { recursive: true, force: true });
	});

	test("returns unified diff for unstaged modification", async () => {
		await fs.writeFile(path.join(repoDir, "file.txt"), "modified\n");

		const res = await supertest(app).get(
			`/api/git/diff?repo=${repoName}&path=file.txt&staged=false`,
		);

		expect(res.status).toBe(200);
		expect(res.body.truncated).toBe(false);
		expect(res.body.diff).toContain("-original");
		expect(res.body.diff).toContain("+modified");

		// Clean up
		execSync("git checkout -- file.txt", { cwd: repoDir });
	});

	test("returns unified diff for staged modification", async () => {
		await fs.writeFile(path.join(repoDir, "file.txt"), "staged change\n");
		execSync("git add file.txt", { cwd: repoDir });

		const res = await supertest(app).get(
			`/api/git/diff?repo=${repoName}&path=file.txt&staged=true`,
		);

		expect(res.status).toBe(200);
		expect(res.body.truncated).toBe(false);
		expect(res.body.diff).toContain("-original");
		expect(res.body.diff).toContain("+staged change");

		// Clean up: reset index first, then restore working tree
		execSync("git reset HEAD file.txt", { cwd: repoDir });
		execSync("git checkout -- file.txt", { cwd: repoDir });
	});

	test("returns empty diff when file has no changes", async () => {
		const res = await supertest(app).get(
			`/api/git/diff?repo=${repoName}&path=file.txt&staged=false`,
		);

		expect(res.status).toBe(200);
		expect(res.body.diff).toBe("");
		expect(res.body.truncated).toBe(false);
	});

	test("returns 400 when path parameter is missing", async () => {
		const res = await supertest(app).get(`/api/git/diff?repo=${repoName}`);

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("MISSING_PATH");
	});

	test("returns 403 for path traversal with ../", async () => {
		const res = await supertest(app).get(
			`/api/git/diff?repo=${repoName}&path=../secret.txt`,
		);

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});

	test("returns 403 for absolute path", async () => {
		const res = await supertest(app).get(
			`/api/git/diff?repo=${repoName}&path=/etc/passwd`,
		);

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});

	test("returns 403 for encoded path traversal", async () => {
		const res = await supertest(app).get(
			`/api/git/diff?repo=${repoName}&path=subdir/../../secret`,
		);

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});
});

describe("GET /api/git/base-content", () => {
	let reposRoot: string;
	let repoDir: string;
	let app: ReturnType<typeof createApp>;

	beforeAll(async () => {
		reposRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "rift-git-base-content-"),
		);
		repoDir = path.join(reposRoot, repoName);
		await fs.mkdir(repoDir);

		execSync("git init", { cwd: repoDir });
		execSync("git config user.email 'test@test.com'", { cwd: repoDir });
		execSync("git config user.name 'Test'", { cwd: repoDir });

		await fs.writeFile(path.join(repoDir, "file.txt"), "original\n");
		execSync("git add file.txt", { cwd: repoDir });
		execSync('git commit -m "initial"', { cwd: repoDir });

		app = createApp(makeConfig(reposRoot));
	});

	afterAll(async () => {
		await fs.rm(reposRoot, { recursive: true, force: true });
	});

	test("returns HEAD content for staged comparisons", async () => {
		await fs.writeFile(path.join(repoDir, "file.txt"), "staged change\n");
		execSync("git add file.txt", { cwd: repoDir });

		const res = await supertest(app).get(
			`/api/git/base-content?repo=${repoName}&path=file.txt&staged=true`,
		);

		expect(res.status).toBe(200);
		expect(res.text).toBe("original\n");

		execSync("git reset HEAD file.txt", { cwd: repoDir });
		execSync("git checkout -- file.txt", { cwd: repoDir });
	});

	test("returns HEAD content for unstaged comparisons", async () => {
		await fs.writeFile(path.join(repoDir, "file.txt"), "staged change\n");
		execSync("git add file.txt", { cwd: repoDir });
		await fs.writeFile(path.join(repoDir, "file.txt"), "working tree change\n");

		const res = await supertest(app).get(
			`/api/git/base-content?repo=${repoName}&path=file.txt&staged=false`,
		);

		expect(res.status).toBe(200);
		expect(res.text).toBe("original\n");

		execSync("git reset HEAD file.txt", { cwd: repoDir });
		execSync("git checkout -- file.txt", { cwd: repoDir });
	});

	test("returns 400 when path parameter is missing", async () => {
		const res = await supertest(app).get(
			`/api/git/base-content?repo=${repoName}`,
		);

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("MISSING_PATH");
	});

	test("returns 403 for path traversal", async () => {
		const res = await supertest(app).get(
			`/api/git/base-content?repo=${repoName}&path=../secret.txt`,
		);

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});
});

describe("GET /api/git/diff (not a git repo)", () => {
	let reposRoot: string;
	let app: ReturnType<typeof createApp>;

	beforeAll(async () => {
		reposRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rift-git-diffnr-"));
		const repoDir = path.join(reposRoot, "not-a-repo");
		await fs.mkdir(repoDir);
		await fs.writeFile(path.join(repoDir, "file.txt"), "content");
		app = createApp(makeConfig(reposRoot));
	});

	afterAll(async () => {
		await fs.rm(reposRoot, { recursive: true, force: true });
	});

	test("returns NOT_GIT_REPO error with status 400", async () => {
		const res = await supertest(app).get(
			"/api/git/diff?repo=not-a-repo&path=file.txt",
		);

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("NOT_GIT_REPO");
	});
});
