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
		basePath: "",
	};
}

// Helper to get the short hash of a commit by its message
function getHash(cwd: string, msg: string): string {
	return execSync(`git log --all --format=%H --grep="${msg}"`, { cwd })
		.toString()
		.trim();
}

describe("GET /api/git/log", () => {
	let tmpDir: string;
	let app: ReturnType<typeof createApp>;

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rift-git-log-"));

		execSync("git init", { cwd: tmpDir });
		execSync("git config user.email 'test@test.com'", { cwd: tmpDir });
		execSync("git config user.name 'Test Author'", { cwd: tmpDir });

		// Create 5 commits for pagination testing
		for (let i = 1; i <= 5; i++) {
			await fs.writeFile(path.join(tmpDir, `file${i}.txt`), `content ${i}`);
			execSync(`git add file${i}.txt`, { cwd: tmpDir });
			execSync(`git commit -m "commit ${i}"`, { cwd: tmpDir });
		}

		app = createApp(makeConfig(tmpDir));
	});

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("returns all commits with default pagination", async () => {
		const res = await supertest(app).get("/api/git/log");

		expect(res.status).toBe(200);
		expect(res.body.commits).toBeArray();
		expect(res.body.commits.length).toBe(5);
		// Most recent commit first
		expect(res.body.commits[0].subject).toBe("commit 5");
		expect(res.body.commits[4].subject).toBe("commit 1");
	});

	test("each commit has expected fields", async () => {
		const res = await supertest(app).get("/api/git/log");

		expect(res.status).toBe(200);
		const commit = res.body.commits[0];
		expect(commit.hash).toMatch(/^[0-9a-f]{40}$/);
		expect(commit.author).toBe("Test Author");
		expect(commit.date).toBeTruthy();
		expect(commit.subject).toBe("commit 5");
	});

	test("respects limit parameter", async () => {
		const res = await supertest(app).get("/api/git/log?limit=2");

		expect(res.status).toBe(200);
		expect(res.body.commits.length).toBe(2);
		expect(res.body.commits[0].subject).toBe("commit 5");
		expect(res.body.commits[1].subject).toBe("commit 4");
	});

	test("respects offset parameter", async () => {
		const res = await supertest(app).get("/api/git/log?limit=2&offset=2");

		expect(res.status).toBe(200);
		expect(res.body.commits.length).toBe(2);
		expect(res.body.commits[0].subject).toBe("commit 3");
		expect(res.body.commits[1].subject).toBe("commit 2");
	});

	test("offset past end returns empty array", async () => {
		const res = await supertest(app).get("/api/git/log?offset=100");

		expect(res.status).toBe(200);
		expect(res.body.commits).toEqual([]);
	});

	test("invalid limit defaults gracefully", async () => {
		const res = await supertest(app).get("/api/git/log?limit=abc");

		expect(res.status).toBe(200);
		// Should fall back to default (25) and return all 5
		expect(res.body.commits.length).toBe(5);
	});
});

describe("GET /api/git/log (not a git repo)", () => {
	let tmpDir: string;
	let app: ReturnType<typeof createApp>;

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rift-log-norepo-"));
		app = createApp(makeConfig(tmpDir));
	});

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("returns NOT_GIT_REPO error with status 400", async () => {
		const res = await supertest(app).get("/api/git/log");

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("NOT_GIT_REPO");
	});
});

describe("GET /api/git/commit/:hash", () => {
	let tmpDir: string;
	let app: ReturnType<typeof createApp>;
	let commitHash: string;

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rift-git-commit-"));

		execSync("git init", { cwd: tmpDir });
		execSync("git config user.email 'test@test.com'", { cwd: tmpDir });
		execSync("git config user.name 'Test Author'", { cwd: tmpDir });

		// First commit: add a file
		await fs.writeFile(path.join(tmpDir, "alpha.txt"), "alpha content\n");
		execSync("git add alpha.txt", { cwd: tmpDir });
		execSync('git commit -m "add alpha"', { cwd: tmpDir });

		// Second commit: add another file, modify alpha
		await fs.writeFile(path.join(tmpDir, "alpha.txt"), "alpha modified\n");
		await fs.writeFile(path.join(tmpDir, "beta.txt"), "beta content\n");
		execSync("git add alpha.txt beta.txt", { cwd: tmpDir });
		execSync('git commit -m "update alpha add beta"', { cwd: tmpDir });

		commitHash = getHash(tmpDir, "update alpha add beta");

		app = createApp(makeConfig(tmpDir));
	});

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("returns commit metadata and file list", async () => {
		const res = await supertest(app).get(`/api/git/commit/${commitHash}`);

		expect(res.status).toBe(200);
		expect(res.body.hash).toBe(commitHash);
		expect(res.body.author).toBe("Test Author");
		expect(res.body.subject).toBe("update alpha add beta");
		expect(res.body.date).toBeTruthy();
		expect(res.body.files).toBeArray();
		expect(res.body.files.length).toBe(2);
	});

	test("file entries have path, status, additions, deletions", async () => {
		const res = await supertest(app).get(`/api/git/commit/${commitHash}`);

		const alpha = res.body.files.find(
			(f: { path: string }) => f.path === "alpha.txt",
		);
		expect(alpha).toBeDefined();
		expect(alpha.status).toBe("M");
		expect(typeof alpha.additions).toBe("number");
		expect(typeof alpha.deletions).toBe("number");

		const beta = res.body.files.find(
			(f: { path: string }) => f.path === "beta.txt",
		);
		expect(beta).toBeDefined();
		expect(beta.status).toBe("A");
	});

	test("works with short hash (7 chars)", async () => {
		const shortHash = commitHash.slice(0, 7);
		const res = await supertest(app).get(`/api/git/commit/${shortHash}`);

		expect(res.status).toBe(200);
		expect(res.body.hash).toBe(commitHash);
	});

	test("returns 400 for malformed hash", async () => {
		const res = await supertest(app).get("/api/git/commit/not-a-hash!");

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("INVALID_HASH");
	});

	test("returns 400 for too-short hash (6 chars)", async () => {
		const res = await supertest(app).get("/api/git/commit/abcdef");

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("INVALID_HASH");
	});

	test("returns 400 for uppercase hex", async () => {
		const res = await supertest(app).get("/api/git/commit/ABCDEF1");

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("INVALID_HASH");
	});

	test("returns file list for root commit", async () => {
		const rootHash = getHash(tmpDir, "add alpha");
		const res = await supertest(app).get(`/api/git/commit/${rootHash}`);

		expect(res.status).toBe(200);
		expect(res.body.files).toBeArray();
		expect(res.body.files.length).toBe(1);
		expect(res.body.files[0].path).toBe("alpha.txt");
		expect(res.body.files[0].status).toBe("A");
	});

	test("returns 404 for valid but nonexistent hash", async () => {
		const res = await supertest(app).get(
			"/api/git/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		);

		expect(res.status).toBe(404);
		expect(res.body.error.code).toBe("NOT_FOUND");
	});
});

describe("GET /api/git/commit/:hash (not a git repo)", () => {
	let tmpDir: string;
	let app: ReturnType<typeof createApp>;

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rift-commit-norepo-"));
		app = createApp(makeConfig(tmpDir));
	});

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("returns NOT_GIT_REPO error with status 400", async () => {
		const res = await supertest(app).get(
			"/api/git/commit/abcdef1234567890abcdef1234567890abcdef12",
		);

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("NOT_GIT_REPO");
	});
});

describe("GET /api/git/commit/:hash/diff", () => {
	let tmpDir: string;
	let app: ReturnType<typeof createApp>;
	let firstHash: string;
	let secondHash: string;

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rift-git-commitdiff-"));

		execSync("git init", { cwd: tmpDir });
		execSync("git config user.email 'test@test.com'", { cwd: tmpDir });
		execSync("git config user.name 'Test'", { cwd: tmpDir });

		// First commit: add a file
		await fs.writeFile(path.join(tmpDir, "hello.txt"), "hello world\n");
		execSync("git add hello.txt", { cwd: tmpDir });
		execSync('git commit -m "add hello"', { cwd: tmpDir });
		firstHash = getHash(tmpDir, "add hello");

		// Second commit: modify the file
		await fs.writeFile(path.join(tmpDir, "hello.txt"), "hello universe\n");
		execSync("git add hello.txt", { cwd: tmpDir });
		execSync('git commit -m "modify hello"', { cwd: tmpDir });
		secondHash = getHash(tmpDir, "modify hello");

		app = createApp(makeConfig(tmpDir));
	});

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("returns unified diff for a modified file", async () => {
		const res = await supertest(app).get(
			`/api/git/commit/${secondHash}/diff?path=hello.txt`,
		);

		expect(res.status).toBe(200);
		expect(res.body.truncated).toBe(false);
		expect(res.body.diff).toContain("-hello world");
		expect(res.body.diff).toContain("+hello universe");
	});

	test("returns diff for the first commit (no parent)", async () => {
		const res = await supertest(app).get(
			`/api/git/commit/${firstHash}/diff?path=hello.txt`,
		);

		expect(res.status).toBe(200);
		expect(res.body.truncated).toBe(false);
		expect(res.body.diff).toContain("+hello world");
	});

	test("returns 400 for malformed hash", async () => {
		const res = await supertest(app).get(
			"/api/git/commit/ZZZZZZZZ/diff?path=hello.txt",
		);

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("INVALID_HASH");
	});

	test("returns 400 when path parameter is missing", async () => {
		const res = await supertest(app).get(`/api/git/commit/${secondHash}/diff`);

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("MISSING_PATH");
	});

	test("returns 403 for path traversal with ../", async () => {
		const res = await supertest(app).get(
			`/api/git/commit/${secondHash}/diff?path=../secret.txt`,
		);

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});

	test("returns 403 for absolute path", async () => {
		const res = await supertest(app).get(
			`/api/git/commit/${secondHash}/diff?path=/etc/passwd`,
		);

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});

	test("returns 403 for encoded path traversal", async () => {
		const res = await supertest(app).get(
			`/api/git/commit/${secondHash}/diff?path=sub/../../secret`,
		);

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});

	test("works with short hash", async () => {
		const shortHash = secondHash.slice(0, 7);
		const res = await supertest(app).get(
			`/api/git/commit/${shortHash}/diff?path=hello.txt`,
		);

		expect(res.status).toBe(200);
		expect(res.body.diff).toContain("-hello world");
		expect(res.body.diff).toContain("+hello universe");
	});
});

describe("GET /api/git/commit/:hash/diff (not a git repo)", () => {
	let tmpDir: string;
	let app: ReturnType<typeof createApp>;

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "rift-commitdiff-norepo-"),
		);
		app = createApp(makeConfig(tmpDir));
	});

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("returns NOT_GIT_REPO error with status 400", async () => {
		const res = await supertest(app).get(
			"/api/git/commit/abcdef1234567890abcdef1234567890abcdef12/diff?path=file.txt",
		);

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("NOT_GIT_REPO");
	});
});
