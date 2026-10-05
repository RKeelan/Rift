import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import supertest from "supertest";
import { type AppConfig, createApp } from "../app.js";

const repoName = "test-repo";
const repoRef = `root/${repoName}`;

function makeConfig(reposRoot: string): AppConfig {
	return {
		port: 3000,
		roots: [{ label: "root", path: reposRoot }],
		allowedLogins: [],
		allowWrites: true,
	};
}

// The editor reads the blob ids it sends with a stage or unstage from the
// `index` line of the diff it draws, which comes from this endpoint.
async function blobsFromDiff(
	app: ReturnType<typeof createApp>,
	name: string,
	staged = false,
): Promise<string> {
	const res = await supertest(app).get(
		`/api/git/diff?repo=${repoRef}&path=${name}&staged=${staged}`,
	);
	const blobs = /^index ([0-9a-f]+\.\.[0-9a-f]+)/m.exec(res.body.diff)?.[1];
	if (!blobs) throw new Error(`no index line in the diff of ${name}`);
	return blobs;
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
		const res = await supertest(app).get(`/api/git/status?repo=${repoRef}`);

		expect(res.status).toBe(200);
		expect(res.body.files).toEqual([]);
	});

	test("returns untracked file as unstaged", async () => {
		await fs.writeFile(path.join(repoDir, "new.txt"), "hello");

		const res = await supertest(app).get(`/api/git/status?repo=${repoRef}`);

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

		const res = await supertest(app).get(`/api/git/status?repo=${repoRef}`);

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

		const res = await supertest(app).get(`/api/git/status?repo=${repoRef}`);

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

		const res = await supertest(app).get(`/api/git/status?repo=${repoRef}`);

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

		const res = await supertest(app).get(`/api/git/status?repo=${repoRef}`);

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
		const res = await supertest(app).get(
			"/api/git/status?repo=root/not-a-repo",
		);

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
			`/api/git/diff?repo=${repoRef}&path=file.txt&staged=false`,
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
			`/api/git/diff?repo=${repoRef}&path=file.txt&staged=true`,
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
			`/api/git/diff?repo=${repoRef}&path=file.txt&staged=false`,
		);

		expect(res.status).toBe(200);
		expect(res.body.diff).toBe("");
		expect(res.body.truncated).toBe(false);
	});

	test("returns 400 when path parameter is missing", async () => {
		const res = await supertest(app).get(`/api/git/diff?repo=${repoRef}`);

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("MISSING_PATH");
	});

	test("returns 403 for path traversal with ../", async () => {
		const res = await supertest(app).get(
			`/api/git/diff?repo=${repoRef}&path=../secret.txt`,
		);

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});

	test("returns 403 for absolute path", async () => {
		const res = await supertest(app).get(
			`/api/git/diff?repo=${repoRef}&path=/etc/passwd`,
		);

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});

	test("returns 403 for encoded path traversal", async () => {
		const res = await supertest(app).get(
			`/api/git/diff?repo=${repoRef}&path=subdir/../../secret`,
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
		await fs.mkdir(path.join(repoDir, "nested", "deeper"), { recursive: true });
		await fs.writeFile(
			path.join(repoDir, "nested", "deeper", "file.txt"),
			"nested original\n",
		);
		execSync("git add file.txt nested", { cwd: repoDir });
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
			`/api/git/base-content?repo=${repoRef}&path=file.txt&staged=true`,
		);

		expect(res.status).toBe(200);
		expect(res.text).toBe("original\n");

		execSync("git reset HEAD file.txt", { cwd: repoDir });
		execSync("git checkout -- file.txt", { cwd: repoDir });
	});

	test("returns index content for unstaged comparisons", async () => {
		await fs.writeFile(path.join(repoDir, "file.txt"), "staged change\n");
		execSync("git add file.txt", { cwd: repoDir });
		await fs.writeFile(path.join(repoDir, "file.txt"), "working tree change\n");

		const res = await supertest(app).get(
			`/api/git/base-content?repo=${repoRef}&path=file.txt&staged=false`,
		);

		expect(res.status).toBe(200);
		expect(res.text).toBe("staged change\n");

		execSync("git reset HEAD file.txt", { cwd: repoDir });
		execSync("git checkout -- file.txt", { cwd: repoDir });
	});

	test("resolves files inside subdirectories", async () => {
		const nested = path.join(repoDir, "nested", "deeper", "file.txt");
		await fs.writeFile(nested, "nested working tree change\n");

		const res = await supertest(app).get(
			`/api/git/base-content?repo=${repoRef}&path=nested/deeper/file.txt&staged=false`,
		);

		expect(res.status).toBe(200);
		expect(res.text).toBe("nested original\n");

		execSync("git checkout -- nested/deeper/file.txt", { cwd: repoDir });
	});

	test("returns the index version of a file added but not committed", async () => {
		await fs.writeFile(path.join(repoDir, "added.txt"), "staged addition\n");
		execSync("git add added.txt", { cwd: repoDir });
		await fs.writeFile(path.join(repoDir, "added.txt"), "further edits\n");

		const res = await supertest(app).get(
			`/api/git/base-content?repo=${repoRef}&path=added.txt&staged=false`,
		);

		expect(res.status).toBe(200);
		expect(res.text).toBe("staged addition\n");

		execSync("git reset HEAD added.txt", { cwd: repoDir });
		await fs.rm(path.join(repoDir, "added.txt"));
	});

	test("returns 404 when the file has no committed or staged version", async () => {
		await fs.writeFile(path.join(repoDir, "untracked.txt"), "brand new\n");

		const res = await supertest(app).get(
			`/api/git/base-content?repo=${repoRef}&path=untracked.txt&staged=false`,
		);

		expect(res.status).toBe(404);
		expect(res.body.error.code).toBe("NOT_FOUND");

		await fs.rm(path.join(repoDir, "untracked.txt"));
	});

	test("returns 400 when path parameter is missing", async () => {
		const res = await supertest(app).get(
			`/api/git/base-content?repo=${repoRef}`,
		);

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("MISSING_PATH");
	});

	test("returns 403 for path traversal", async () => {
		const res = await supertest(app).get(
			`/api/git/base-content?repo=${repoRef}&path=../secret.txt`,
		);

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});
});

describe("POST /api/git/stage and /api/git/unstage", () => {
	let reposRoot: string;
	let repoDir: string;
	let app: ReturnType<typeof createApp>;

	beforeAll(async () => {
		reposRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rift-git-stage-"));
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

	test("stages an untracked file", async () => {
		await fs.writeFile(path.join(repoDir, "new.txt"), "hello\n");

		const res = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			.send({ path: "new.txt" });

		expect(res.status).toBe(200);
		const entry = res.body.files.find(
			(f: { path: string }) => f.path === "new.txt",
		);
		expect(entry).toEqual({ path: "new.txt", status: "added", staged: true });

		execSync("git reset HEAD new.txt", { cwd: repoDir });
		await fs.unlink(path.join(repoDir, "new.txt"));
	});

	test("stages a modified file", async () => {
		await fs.writeFile(path.join(repoDir, "file.txt"), "modified\n");

		const res = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			.send({ path: "file.txt" });

		expect(res.status).toBe(200);
		const entry = res.body.files.find(
			(f: { path: string }) => f.path === "file.txt",
		);
		expect(entry).toEqual({
			path: "file.txt",
			status: "modified",
			staged: true,
		});

		execSync("git reset HEAD file.txt", { cwd: repoDir });
		execSync("git checkout -- file.txt", { cwd: repoDir });
	});

	test("unstages a staged modification", async () => {
		await fs.writeFile(path.join(repoDir, "file.txt"), "modified\n");
		execSync("git add file.txt", { cwd: repoDir });

		const res = await supertest(app)
			.post(`/api/git/unstage?repo=${repoRef}`)
			.send({ path: "file.txt" });

		expect(res.status).toBe(200);
		const staged = res.body.files.find(
			(f: { path: string; staged: boolean }) =>
				f.path === "file.txt" && f.staged,
		);
		expect(staged).toBeUndefined();
		const unstaged = res.body.files.find(
			(f: { path: string; staged: boolean }) =>
				f.path === "file.txt" && !f.staged,
		);
		expect(unstaged).toEqual({
			path: "file.txt",
			status: "modified",
			staged: false,
		});

		execSync("git checkout -- file.txt", { cwd: repoDir });
	});

	test("resolves files inside subdirectories", async () => {
		await fs.mkdir(path.join(repoDir, "nested"), { recursive: true });
		await fs.writeFile(path.join(repoDir, "nested", "deep.txt"), "deep\n");

		const res = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			.send({ path: "nested/deep.txt" });

		expect(res.status).toBe(200);
		const entry = res.body.files.find(
			(f: { path: string }) => f.path === "nested/deep.txt",
		);
		expect(entry).toEqual({
			path: "nested/deep.txt",
			status: "added",
			staged: true,
		});

		execSync("git reset HEAD nested/deep.txt", { cwd: repoDir });
		await fs.rm(path.join(repoDir, "nested"), { recursive: true, force: true });
	});

	test("returns 400 when path is missing", async () => {
		const res = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			.send({});

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("MISSING_PATH");
	});

	test("returns 403 for path traversal", async () => {
		const res = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			.send({ path: "../secret.txt" });

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});

	test("returns 400 when repo param is missing", async () => {
		const res = await supertest(app)
			.post("/api/git/unstage")
			.send({ path: "file.txt" });

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("MISSING_REPO");
	});
});

describe("POST /api/git/stage (line ranges)", () => {
	let reposRoot: string;
	let repoDir: string;
	let app: ReturnType<typeof createApp>;

	beforeAll(async () => {
		reposRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "rift-git-stage-lines-"),
		);
		repoDir = path.join(reposRoot, repoName);
		await fs.mkdir(repoDir);

		execSync("git init", { cwd: repoDir });
		execSync("git config user.email 'test@test.com'", { cwd: repoDir });
		execSync("git config user.name 'Test'", { cwd: repoDir });
		// Store line endings verbatim so the CRLF case is deterministic.
		execSync("git config core.autocrlf false", { cwd: repoDir });

		app = createApp(makeConfig(reposRoot));
	});

	afterAll(async () => {
		await fs.rm(reposRoot, { recursive: true, force: true });
	});

	async function commitFile(name: string, content: string): Promise<void> {
		await fs.writeFile(path.join(repoDir, name), content);
		execSync(`git add ${name}`, { cwd: repoDir });
		execSync(`git commit -m "add ${name}"`, { cwd: repoDir });
	}

	function indexContent(name: string): string {
		return execSync(`git show :${name}`, { cwd: repoDir }).toString();
	}

	test("stages a single modified line, leaving the rest unstaged", async () => {
		await commitFile("mod.txt", "one\ntwo\nthree\nfour\n");
		await fs.writeFile(
			path.join(repoDir, "mod.txt"),
			"one\nTWO\nthree\nFOUR\n",
		);

		const res = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			.send({ path: "mod.txt", ranges: [[2, 2]] });

		expect(res.status).toBe(200);
		expect(indexContent("mod.txt")).toBe("one\nTWO\nthree\nfour\n");
		// The working tree keeps both edits.
		expect(await fs.readFile(path.join(repoDir, "mod.txt"), "utf8")).toBe(
			"one\nTWO\nthree\nFOUR\n",
		);

		const stagedEntry = res.body.files.find(
			(f: { path: string; staged: boolean }) =>
				f.path === "mod.txt" && f.staged,
		);
		const unstagedEntry = res.body.files.find(
			(f: { path: string; staged: boolean }) =>
				f.path === "mod.txt" && !f.staged,
		);
		expect(stagedEntry?.status).toBe("modified");
		expect(unstagedEntry?.status).toBe("modified");

		execSync("git reset HEAD mod.txt", { cwd: repoDir });
		execSync("git checkout -- mod.txt", { cwd: repoDir });
	});

	test("stages a pure deletion when the following line is selected", async () => {
		await commitFile("del.txt", "a\nb\nc\n");
		await fs.writeFile(path.join(repoDir, "del.txt"), "a\nc\n");

		const res = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			.send({ path: "del.txt", ranges: [[2, 2]] });

		expect(res.status).toBe(200);
		expect(indexContent("del.txt")).toBe("a\nc\n");

		execSync("git reset HEAD del.txt", { cwd: repoDir });
		execSync("git checkout -- del.txt", { cwd: repoDir });
	});

	test("preserves CRLF line endings when staging", async () => {
		await commitFile("crlf.txt", "one\r\ntwo\r\nthree\r\n");
		await fs.writeFile(
			path.join(repoDir, "crlf.txt"),
			"one\r\nTWO\r\nthree\r\n",
		);

		const res = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			.send({ path: "crlf.txt", ranges: [[2, 2]] });

		expect(res.status).toBe(200);
		expect(indexContent("crlf.txt")).toBe("one\r\nTWO\r\nthree\r\n");

		execSync("git reset HEAD crlf.txt", { cwd: repoDir });
		execSync("git checkout -- crlf.txt", { cwd: repoDir });
	});

	test("stages only the picked line after a deleted line that begins with dashes", async () => {
		await commitFile("dash.sql", "a\n-- note\nb\nc\n");
		await fs.writeFile(path.join(repoDir, "dash.sql"), "a\nB\nC\n");

		const res = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			.send({ path: "dash.sql", ranges: [[3, 3]] });

		expect(res.status).toBe(200);
		// Only C is staged; the deletions anchored to line 2 stay in the index.
		expect(indexContent("dash.sql")).toBe("a\n-- note\nb\nc\nC\n");

		execSync("git reset -q HEAD dash.sql", { cwd: repoDir });
		execSync("git checkout -- dash.sql", { cwd: repoDir });
	});

	test("leaves out an unpicked added line that begins with pluses", async () => {
		await commitFile("plus.c", "a\nb\n");
		await fs.writeFile(path.join(repoDir, "plus.c"), "a\n++i;\nX\nb\n");

		const res = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			.send({ path: "plus.c", ranges: [[3, 3]] });

		expect(res.status).toBe(200);
		expect(indexContent("plus.c")).toBe("a\nX\nb\n");

		execSync("git reset -q HEAD plus.c", { cwd: repoDir });
		execSync("git checkout -- plus.c", { cwd: repoDir });
	});

	test("stages the emptying of a file through line 1", async () => {
		await commitFile("emptied.txt", "a\nb\n");
		await fs.writeFile(path.join(repoDir, "emptied.txt"), "");

		const res = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			.send({ path: "emptied.txt", ranges: [[1, 1]] });

		expect(res.status).toBe(200);
		expect(indexContent("emptied.txt")).toBe("");

		execSync("git reset -q HEAD emptied.txt", { cwd: repoDir });
		execSync("git checkout -- emptied.txt", { cwd: repoDir });
	});

	test("names each side of the diff by its full blob id", async () => {
		await commitFile("ids.txt", "one\ntwo\n");
		await fs.writeFile(path.join(repoDir, "ids.txt"), "one\nTWO\n");

		const [from, to] = (await blobsFromDiff(app, "ids.txt")).split("..");

		expect(from).toBe(
			execSync("git rev-parse :ids.txt", { cwd: repoDir }).toString().trim(),
		);
		expect(to).toBe(
			execSync("git hash-object ids.txt", { cwd: repoDir }).toString().trim(),
		);

		execSync("git checkout -- ids.txt", { cwd: repoDir });
	});

	test("stages exactly the picked lines of the diff the caller read", async () => {
		await commitFile("fresh.txt", "one\ntwo\nthree\n");
		await fs.writeFile(path.join(repoDir, "fresh.txt"), "ONE\ntwo\nTHREE\n");
		const expectedBlobs = await blobsFromDiff(app, "fresh.txt");

		const res = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			.send({ path: "fresh.txt", ranges: [[3, 3]], expectedBlobs });

		expect(res.status).toBe(200);
		expect(indexContent("fresh.txt")).toBe("one\ntwo\nTHREE\n");

		execSync("git reset -q HEAD fresh.txt", { cwd: repoDir });
		execSync("git checkout -- fresh.txt", { cwd: repoDir });
	});

	test("refuses to stage lines of a diff that changed since it was read", async () => {
		await commitFile("stale.txt", "one\ntwo\nthree\n");
		await fs.writeFile(path.join(repoDir, "stale.txt"), "one\ntwo\nTHREE\n");
		const expectedBlobs = await blobsFromDiff(app, "stale.txt");
		// An agent deletes line 1 and adds a line after the caller read line
		// numbers from the diff, so line 3 now names the agent's line, not the one
		// the caller picked.
		await fs.writeFile(path.join(repoDir, "stale.txt"), "two\nTHREE\nFOUR\n");

		const res = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			.send({ path: "stale.txt", ranges: [[3, 3]], expectedBlobs });

		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe("DIFF_CHANGED");
		expect(indexContent("stale.txt")).toBe("one\ntwo\nthree\n");

		execSync("git checkout -- stale.txt", { cwd: repoDir });
	});

	test("refuses to stage a whole file whose diff changed since it was read", async () => {
		await commitFile("whole.txt", "one\n");
		await fs.writeFile(path.join(repoDir, "whole.txt"), "ONE\n");
		const expectedBlobs = await blobsFromDiff(app, "whole.txt");
		await fs.writeFile(path.join(repoDir, "whole.txt"), "ONE\nTWO\n");

		const res = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			.send({ path: "whole.txt", expectedBlobs });

		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe("DIFF_CHANGED");
		expect(indexContent("whole.txt")).toBe("one\n");

		execSync("git checkout -- whole.txt", { cwd: repoDir });
	});

	test("stages and unstages lines with the blob ids of the diff the editor reads", async () => {
		await commitFile("round.txt", "one\ntwo\nthree\nfour\n");
		await fs.writeFile(
			path.join(repoDir, "round.txt"),
			"one\nTWO\nthree\nFOUR\n",
		);

		const unstagedBlobs = await blobsFromDiff(app, "round.txt");
		const staged = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			.send({
				path: "round.txt",
				ranges: [[4, 4]],
				expectedBlobs: unstagedBlobs,
			});
		expect(staged.status).toBe(200);
		expect(indexContent("round.txt")).toBe("one\ntwo\nthree\nFOUR\n");

		// The stage moved the index, so the ids read before it no longer name the
		// unstaged diff.
		const again = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			.send({
				path: "round.txt",
				ranges: [[2, 2]],
				expectedBlobs: unstagedBlobs,
			});
		expect(again.status).toBe(409);
		expect(indexContent("round.txt")).toBe("one\ntwo\nthree\nFOUR\n");

		const stagedBlobs = await blobsFromDiff(app, "round.txt", true);
		const unstaged = await supertest(app)
			.post(`/api/git/unstage?repo=${repoRef}`)
			.send({
				path: "round.txt",
				ranges: [[4, 4]],
				expectedBlobs: stagedBlobs,
			});
		expect(unstaged.status).toBe(200);
		expect(indexContent("round.txt")).toBe("one\ntwo\nthree\nfour\n");

		execSync("git checkout -- round.txt", { cwd: repoDir });
	});

	test("requires full blob ids", async () => {
		const res = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			.send({
				path: "mod.txt",
				ranges: [[2, 2]],
				expectedBlobs: "abc1234..def5678",
			});

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("INVALID_BLOBS");
	});

	test("stages an untracked file whole only at the mtime the caller read", async () => {
		await fs.writeFile(path.join(repoDir, "new.txt"), "one\n");
		const { mtimeMs } = await fs.stat(path.join(repoDir, "new.txt"));
		await fs.utimes(
			path.join(repoDir, "new.txt"),
			new Date(),
			new Date(mtimeMs + 5000),
		);

		const stale = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			.send({ path: "new.txt", expectedMtimeMs: mtimeMs });
		expect(stale.status).toBe(409);
		expect(stale.body.error.code).toBe("FILE_MODIFIED");
		expect(
			execSync("git ls-files -- new.txt", { cwd: repoDir }).toString(),
		).toBe("");

		const fresh = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			.send({
				path: "new.txt",
				expectedMtimeMs: (await fs.stat(path.join(repoDir, "new.txt"))).mtimeMs,
			});
		expect(fresh.status).toBe(200);
		expect(indexContent("new.txt")).toBe("one\n");

		execSync("git rm -q --cached new.txt", { cwd: repoDir });
		await fs.rm(path.join(repoDir, "new.txt"));
	});

	test("a selection covering no change stages nothing", async () => {
		await commitFile("noop.txt", "alpha\nbeta\n");
		await fs.writeFile(path.join(repoDir, "noop.txt"), "ALPHA\nbeta\n");

		const res = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			// Line 2 is unchanged, so the modification of line 1 is untouched.
			.send({ path: "noop.txt", ranges: [[2, 2]] });

		expect(res.status).toBe(200);
		expect(indexContent("noop.txt")).toBe("alpha\nbeta\n");
		const stagedEntry = res.body.files.find(
			(f: { path: string; staged: boolean }) =>
				f.path === "noop.txt" && f.staged,
		);
		expect(stagedEntry).toBeUndefined();

		execSync("git checkout -- noop.txt", { cwd: repoDir });
	});

	test("returns INVALID_RANGES for malformed ranges", async () => {
		const res = await supertest(app)
			.post(`/api/git/stage?repo=${repoRef}`)
			.send({ path: "mod.txt", ranges: [[2]] });

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("INVALID_RANGES");
	});
});

describe("POST /api/git/unstage (line ranges)", () => {
	let reposRoot: string;
	let repoDir: string;
	let app: ReturnType<typeof createApp>;

	beforeAll(async () => {
		reposRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "rift-git-unstage-lines-"),
		);
		repoDir = path.join(reposRoot, repoName);
		await fs.mkdir(repoDir);

		execSync("git init", { cwd: repoDir });
		execSync("git config user.email 'test@test.com'", { cwd: repoDir });
		execSync("git config user.name 'Test'", { cwd: repoDir });
		// Store line endings verbatim so the CRLF case is deterministic.
		execSync("git config core.autocrlf false", { cwd: repoDir });

		app = createApp(makeConfig(reposRoot));
	});

	afterAll(async () => {
		await fs.rm(reposRoot, { recursive: true, force: true });
	});

	// Commits a file, then stages a modified version of it whole, so the index
	// carries every edit and the working tree matches.
	async function commitAndStage(
		name: string,
		committed: string,
		staged: string,
	): Promise<void> {
		await fs.writeFile(path.join(repoDir, name), committed);
		execSync(`git add ${name}`, { cwd: repoDir });
		execSync(`git commit -m "add ${name}"`, { cwd: repoDir });
		await fs.writeFile(path.join(repoDir, name), staged);
		execSync(`git add ${name}`, { cwd: repoDir });
	}

	function indexContent(name: string): string {
		return execSync(`git show :${name}`, { cwd: repoDir }).toString();
	}

	test("unstages a single line, leaving the rest staged", async () => {
		await commitAndStage(
			"mod.txt",
			"one\ntwo\nthree\nfour\n",
			"one\nTWO\nthree\nFOUR\n",
		);

		const res = await supertest(app)
			.post(`/api/git/unstage?repo=${repoRef}`)
			.send({ path: "mod.txt", ranges: [[2, 2]] });

		expect(res.status).toBe(200);
		// Line 2 reverts to HEAD in the index; line 4 stays staged.
		expect(indexContent("mod.txt")).toBe("one\ntwo\nthree\nFOUR\n");
		// The working tree keeps both edits.
		expect(await fs.readFile(path.join(repoDir, "mod.txt"), "utf8")).toBe(
			"one\nTWO\nthree\nFOUR\n",
		);

		const stagedEntry = res.body.files.find(
			(f: { path: string; staged: boolean }) =>
				f.path === "mod.txt" && f.staged,
		);
		const unstagedEntry = res.body.files.find(
			(f: { path: string; staged: boolean }) =>
				f.path === "mod.txt" && !f.staged,
		);
		expect(stagedEntry?.status).toBe("modified");
		expect(unstagedEntry?.status).toBe("modified");

		execSync("git reset -q HEAD mod.txt", { cwd: repoDir });
		execSync("git checkout -- mod.txt", { cwd: repoDir });
	});

	test("unstages a staged deletion when the following line is selected", async () => {
		await commitAndStage("del.txt", "a\nb\nc\n", "a\nc\n");

		const res = await supertest(app)
			.post(`/api/git/unstage?repo=${repoRef}`)
			.send({ path: "del.txt", ranges: [[2, 2]] });

		expect(res.status).toBe(200);
		// The deletion of b returns to the index, so it matches HEAD again.
		expect(indexContent("del.txt")).toBe("a\nb\nc\n");

		execSync("git reset -q HEAD del.txt", { cwd: repoDir });
		execSync("git checkout -- del.txt", { cwd: repoDir });
	});

	test("preserves CRLF line endings when unstaging", async () => {
		await commitAndStage(
			"crlf.txt",
			"one\r\ntwo\r\nthree\r\n",
			"one\r\nTWO\r\nthree\r\n",
		);

		const res = await supertest(app)
			.post(`/api/git/unstage?repo=${repoRef}`)
			.send({ path: "crlf.txt", ranges: [[2, 2]] });

		expect(res.status).toBe(200);
		expect(indexContent("crlf.txt")).toBe("one\r\ntwo\r\nthree\r\n");

		execSync("git reset -q HEAD crlf.txt", { cwd: repoDir });
		execSync("git checkout -- crlf.txt", { cwd: repoDir });
	});

	test("unstages only the picked line after a deleted line that begins with dashes", async () => {
		await commitAndStage("dash.sql", "a\n-- note\nb\nc\n", "a\nB\nC\n");

		const res = await supertest(app)
			.post(`/api/git/unstage?repo=${repoRef}`)
			.send({ path: "dash.sql", ranges: [[3, 3]] });

		expect(res.status).toBe(200);
		expect(indexContent("dash.sql")).toBe("a\nB\n");

		execSync("git reset -q HEAD dash.sql", { cwd: repoDir });
		execSync("git checkout -- dash.sql", { cwd: repoDir });
	});

	test("keeps an unpicked staged line that begins with pluses", async () => {
		await commitAndStage("plus.c", "a\nb\n", "a\n++i;\nX\nb\n");

		const res = await supertest(app)
			.post(`/api/git/unstage?repo=${repoRef}`)
			.send({ path: "plus.c", ranges: [[3, 3]] });

		expect(res.status).toBe(200);
		expect(indexContent("plus.c")).toBe("a\n++i;\nb\n");

		execSync("git reset -q HEAD plus.c", { cwd: repoDir });
		execSync("git checkout -- plus.c", { cwd: repoDir });
	});

	test("unstages the emptying of a file through line 1", async () => {
		await commitAndStage("emptied.txt", "a\nb\n", "");

		const res = await supertest(app)
			.post(`/api/git/unstage?repo=${repoRef}`)
			.send({ path: "emptied.txt", ranges: [[1, 1]] });

		expect(res.status).toBe(200);
		expect(indexContent("emptied.txt")).toBe("a\nb\n");

		execSync("git reset -q HEAD emptied.txt", { cwd: repoDir });
		execSync("git checkout -- emptied.txt", { cwd: repoDir });
	});

	test("unstages lines of the staged diff the caller read", async () => {
		await commitAndStage("fresh.txt", "one\ntwo\n", "one\nTWO\n");
		const expectedBlobs = await blobsFromDiff(app, "fresh.txt", true);

		const res = await supertest(app)
			.post(`/api/git/unstage?repo=${repoRef}`)
			.send({ path: "fresh.txt", ranges: [[2, 2]], expectedBlobs });

		expect(res.status).toBe(200);
		expect(indexContent("fresh.txt")).toBe("one\ntwo\n");

		execSync("git reset -q HEAD fresh.txt", { cwd: repoDir });
		execSync("git checkout -- fresh.txt", { cwd: repoDir });
	});

	test("refuses to unstage lines once the index has changed", async () => {
		await commitAndStage("stale.txt", "one\ntwo\nthree\n", "one\ntwo\nTHREE\n");
		const expectedBlobs = await blobsFromDiff(app, "stale.txt", true);
		// Something else stages further changes after the caller read the diff,
		// so line 3 now names a line the caller never saw staged.
		await fs.writeFile(path.join(repoDir, "stale.txt"), "two\nTHREE\nFOUR\n");
		execSync("git add stale.txt", { cwd: repoDir });

		const res = await supertest(app)
			.post(`/api/git/unstage?repo=${repoRef}`)
			.send({ path: "stale.txt", ranges: [[3, 3]], expectedBlobs });

		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe("DIFF_CHANGED");
		expect(indexContent("stale.txt")).toBe("two\nTHREE\nFOUR\n");

		execSync("git reset -q HEAD stale.txt", { cwd: repoDir });
		execSync("git checkout -- stale.txt", { cwd: repoDir });
	});

	test("refuses to unstage lines once a commit has moved HEAD", async () => {
		await commitAndStage(
			"moved.txt",
			"one\ntwo\nthree\n",
			"one\nTWO\nthree\nfour\n",
		);
		const expectedBlobs = await blobsFromDiff(app, "moved.txt", true);
		// A commit takes part of the staged change, so the same index blob now
		// differs from HEAD by a different diff.
		const partial = path.join(repoDir, "partial.txt");
		await fs.writeFile(partial, "one\nTWO\nthree\n");
		execSync(
			`git update-index --cacheinfo 100644,${execSync(
				`git hash-object -w "${partial}"`,
				{ cwd: repoDir },
			)
				.toString()
				.trim()},moved.txt`,
			{ cwd: repoDir },
		);
		execSync('git commit -q -m "take part"', { cwd: repoDir });
		execSync("git add moved.txt", { cwd: repoDir });
		await fs.rm(partial);

		const res = await supertest(app)
			.post(`/api/git/unstage?repo=${repoRef}`)
			.send({ path: "moved.txt", ranges: [[2, 2]], expectedBlobs });

		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe("DIFF_CHANGED");
		expect(indexContent("moved.txt")).toBe("one\nTWO\nthree\nfour\n");

		execSync("git reset -q HEAD moved.txt", { cwd: repoDir });
		execSync("git checkout -- moved.txt", { cwd: repoDir });
	});

	test("refuses to unstage a whole file whose staged diff changed since it was read", async () => {
		await commitAndStage("whole.txt", "one\n", "ONE\n");
		const expectedBlobs = await blobsFromDiff(app, "whole.txt", true);
		await fs.writeFile(path.join(repoDir, "whole.txt"), "ONE\nTWO\n");
		execSync("git add whole.txt", { cwd: repoDir });

		const res = await supertest(app)
			.post(`/api/git/unstage?repo=${repoRef}`)
			.send({ path: "whole.txt", expectedBlobs });

		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe("DIFF_CHANGED");
		expect(indexContent("whole.txt")).toBe("ONE\nTWO\n");

		execSync("git reset -q HEAD whole.txt", { cwd: repoDir });
		execSync("git checkout -- whole.txt", { cwd: repoDir });
	});

	test("requires full blob ids", async () => {
		const res = await supertest(app)
			.post(`/api/git/unstage?repo=${repoRef}`)
			.send({ path: "mod.txt", ranges: [[2, 2]], expectedBlobs: "HEAD..HEAD" });

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("INVALID_BLOBS");
	});

	test("a selection covering no staged change unstages nothing", async () => {
		await commitAndStage("noop.txt", "alpha\nbeta\n", "ALPHA\nbeta\n");

		const res = await supertest(app)
			.post(`/api/git/unstage?repo=${repoRef}`)
			// Line 2 is unchanged, so the staged modification of line 1 is untouched.
			.send({ path: "noop.txt", ranges: [[2, 2]] });

		expect(res.status).toBe(200);
		expect(indexContent("noop.txt")).toBe("ALPHA\nbeta\n");
		const stagedEntry = res.body.files.find(
			(f: { path: string; staged: boolean }) =>
				f.path === "noop.txt" && f.staged,
		);
		expect(stagedEntry?.status).toBe("modified");

		execSync("git reset -q HEAD noop.txt", { cwd: repoDir });
		execSync("git checkout -- noop.txt", { cwd: repoDir });
	});

	test("returns INVALID_RANGES for malformed ranges", async () => {
		const res = await supertest(app)
			.post(`/api/git/unstage?repo=${repoRef}`)
			.send({ path: "mod.txt", ranges: [[2]] });

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("INVALID_RANGES");
	});
});

describe("POST /api/git/stage (repo with no commits)", () => {
	let reposRoot: string;
	let repoDir: string;
	let app: ReturnType<typeof createApp>;

	beforeAll(async () => {
		reposRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "rift-git-stage-nohead-"),
		);
		repoDir = path.join(reposRoot, repoName);
		await fs.mkdir(repoDir);

		execSync("git init", { cwd: repoDir });
		execSync("git config user.email 'test@test.com'", { cwd: repoDir });
		execSync("git config user.name 'Test'", { cwd: repoDir });

		app = createApp(makeConfig(reposRoot));
	});

	afterAll(async () => {
		await fs.rm(reposRoot, { recursive: true, force: true });
	});

	test("unstages a staged addition before the first commit", async () => {
		await fs.writeFile(path.join(repoDir, "first.txt"), "content\n");
		execSync("git add first.txt", { cwd: repoDir });

		const res = await supertest(app)
			.post(`/api/git/unstage?repo=${repoRef}`)
			.send({ path: "first.txt" });

		expect(res.status).toBe(200);
		const entry = res.body.files.find(
			(f: { path: string }) => f.path === "first.txt",
		);
		expect(entry).toEqual({
			path: "first.txt",
			status: "untracked",
			staged: false,
		});
	});
});

describe("POST /api/git/stage (not a git repo)", () => {
	let reposRoot: string;
	let app: ReturnType<typeof createApp>;

	beforeAll(async () => {
		reposRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rift-git-stagenr-"));
		const repoDir = path.join(reposRoot, "not-a-repo");
		await fs.mkdir(repoDir);
		await fs.writeFile(path.join(repoDir, "file.txt"), "content");
		app = createApp(makeConfig(reposRoot));
	});

	afterAll(async () => {
		await fs.rm(reposRoot, { recursive: true, force: true });
	});

	test("returns NOT_GIT_REPO error with status 400", async () => {
		const res = await supertest(app)
			.post("/api/git/stage?repo=root/not-a-repo")
			.send({ path: "file.txt" });

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("NOT_GIT_REPO");
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
			"/api/git/diff?repo=root/not-a-repo&path=file.txt",
		);

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("NOT_GIT_REPO");
	});
});
