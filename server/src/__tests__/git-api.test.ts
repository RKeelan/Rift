import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import supertest from "supertest";
import { type AppConfig, createApp } from "../app.js";

function makeConfig(workingDir: string): AppConfig {
	return {
		port: 3000,
		agentCommand: "echo",
		workingDir,
	};
}

describe("GET /api/git/status", () => {
	let tmpDir: string;
	let app: ReturnType<typeof createApp>;

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rift-git-status-"));

		execSync("git init", { cwd: tmpDir });
		execSync("git config user.email 'test@test.com'", { cwd: tmpDir });
		execSync("git config user.name 'Test'", { cwd: tmpDir });

		// Create an initial commit so HEAD exists
		await fs.writeFile(path.join(tmpDir, "init.txt"), "init");
		execSync("git add init.txt", { cwd: tmpDir });
		execSync('git commit -m "initial"', { cwd: tmpDir });

		app = createApp(makeConfig(tmpDir));
	});

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("returns empty files array when working tree is clean", async () => {
		const res = await supertest(app).get("/api/git/status");

		expect(res.status).toBe(200);
		expect(res.body.files).toEqual([]);
	});

	test("returns untracked file as unstaged", async () => {
		await fs.writeFile(path.join(tmpDir, "new.txt"), "hello");

		const res = await supertest(app).get("/api/git/status");

		expect(res.status).toBe(200);
		const entries = res.body.files.filter(
			(f: { path: string }) => f.path === "new.txt",
		);
		expect(entries.length).toBe(1);
		expect(entries[0].status).toBe("untracked");
		expect(entries[0].staged).toBe(false);

		// Clean up
		await fs.unlink(path.join(tmpDir, "new.txt"));
	});

	test("returns staged added file with staged=true", async () => {
		await fs.writeFile(path.join(tmpDir, "staged.txt"), "staged content");
		execSync("git add staged.txt", { cwd: tmpDir });

		const res = await supertest(app).get("/api/git/status");

		expect(res.status).toBe(200);
		const entry = res.body.files.find(
			(f: { path: string }) => f.path === "staged.txt",
		);
		expect(entry).toBeDefined();
		expect(entry.status).toBe("added");
		expect(entry.staged).toBe(true);

		// Clean up
		execSync("git reset HEAD staged.txt", { cwd: tmpDir });
		await fs.unlink(path.join(tmpDir, "staged.txt"));
	});

	test("returns modified file as unstaged", async () => {
		// Modify an existing committed file
		await fs.writeFile(path.join(tmpDir, "init.txt"), "modified content");

		const res = await supertest(app).get("/api/git/status");

		expect(res.status).toBe(200);
		const entry = res.body.files.find(
			(f: { path: string; staged: boolean }) =>
				f.path === "init.txt" && !f.staged,
		);
		expect(entry).toBeDefined();
		expect(entry.status).toBe("modified");
		expect(entry.staged).toBe(false);

		// Clean up
		execSync("git checkout -- init.txt", { cwd: tmpDir });
	});

	test("returns deleted file as unstaged", async () => {
		// Delete a committed file without staging the deletion
		await fs.unlink(path.join(tmpDir, "init.txt"));

		const res = await supertest(app).get("/api/git/status");

		expect(res.status).toBe(200);
		const entry = res.body.files.find(
			(f: { path: string; staged: boolean }) =>
				f.path === "init.txt" && !f.staged,
		);
		expect(entry).toBeDefined();
		expect(entry.status).toBe("deleted");
		expect(entry.staged).toBe(false);

		// Clean up
		execSync("git checkout -- init.txt", { cwd: tmpDir });
	});

	test("returns both staged and unstaged entries for same file", async () => {
		// Stage a modification, then modify again
		await fs.writeFile(path.join(tmpDir, "init.txt"), "first change");
		execSync("git add init.txt", { cwd: tmpDir });
		await fs.writeFile(path.join(tmpDir, "init.txt"), "second change");

		const res = await supertest(app).get("/api/git/status");

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
		execSync("git checkout -- init.txt", { cwd: tmpDir });
		execSync("git reset HEAD init.txt", { cwd: tmpDir });
	});
});

describe("GET /api/git/status (not a git repo)", () => {
	let tmpDir: string;
	let app: ReturnType<typeof createApp>;

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rift-git-norepo-"));
		app = createApp(makeConfig(tmpDir));
	});

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("returns NOT_GIT_REPO error with status 400", async () => {
		const res = await supertest(app).get("/api/git/status");

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("NOT_GIT_REPO");
	});
});

describe("GET /api/git/diff", () => {
	let tmpDir: string;
	let app: ReturnType<typeof createApp>;

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rift-git-diff-"));

		execSync("git init", { cwd: tmpDir });
		execSync("git config user.email 'test@test.com'", { cwd: tmpDir });
		execSync("git config user.name 'Test'", { cwd: tmpDir });

		await fs.writeFile(path.join(tmpDir, "file.txt"), "original\n");
		execSync("git add file.txt", { cwd: tmpDir });
		execSync('git commit -m "initial"', { cwd: tmpDir });

		app = createApp(makeConfig(tmpDir));
	});

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("returns unified diff for unstaged modification", async () => {
		await fs.writeFile(path.join(tmpDir, "file.txt"), "modified\n");

		const res = await supertest(app).get(
			"/api/git/diff?path=file.txt&staged=false",
		);

		expect(res.status).toBe(200);
		expect(res.body.truncated).toBe(false);
		expect(res.body.diff).toContain("-original");
		expect(res.body.diff).toContain("+modified");

		// Clean up
		execSync("git checkout -- file.txt", { cwd: tmpDir });
	});

	test("returns unified diff for staged modification", async () => {
		await fs.writeFile(path.join(tmpDir, "file.txt"), "staged change\n");
		execSync("git add file.txt", { cwd: tmpDir });

		const res = await supertest(app).get(
			"/api/git/diff?path=file.txt&staged=true",
		);

		expect(res.status).toBe(200);
		expect(res.body.truncated).toBe(false);
		expect(res.body.diff).toContain("-original");
		expect(res.body.diff).toContain("+staged change");

		// Clean up: reset index first, then restore working tree
		execSync("git reset HEAD file.txt", { cwd: tmpDir });
		execSync("git checkout -- file.txt", { cwd: tmpDir });
	});

	test("returns empty diff when file has no changes", async () => {
		const res = await supertest(app).get(
			"/api/git/diff?path=file.txt&staged=false",
		);

		expect(res.status).toBe(200);
		expect(res.body.diff).toBe("");
		expect(res.body.truncated).toBe(false);
	});

	test("returns 400 when path parameter is missing", async () => {
		const res = await supertest(app).get("/api/git/diff");

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("MISSING_PATH");
	});

	test("returns 403 for path traversal with ../", async () => {
		const res = await supertest(app).get("/api/git/diff?path=../secret.txt");

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});

	test("returns 403 for absolute path", async () => {
		const res = await supertest(app).get("/api/git/diff?path=/etc/passwd");

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});

	test("returns 403 for encoded path traversal", async () => {
		const res = await supertest(app).get(
			"/api/git/diff?path=subdir/../../secret",
		);

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});
});

describe("GET /api/git/diff (not a git repo)", () => {
	let tmpDir: string;
	let app: ReturnType<typeof createApp>;

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rift-git-diffnr-"));
		await fs.writeFile(path.join(tmpDir, "file.txt"), "content");
		app = createApp(makeConfig(tmpDir));
	});

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("returns NOT_GIT_REPO error with status 400", async () => {
		const res = await supertest(app).get("/api/git/diff?path=file.txt");

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("NOT_GIT_REPO");
	});
});
