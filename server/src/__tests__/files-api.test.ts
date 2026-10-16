import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import supertest from "supertest";
import { type AppConfig, createApp } from "../app.js";
import { SAVE_CONTEXT_TIMEOUT_MS } from "../routes/files.js";

let reposRoot: string;
let repoDir: string;
const repoName = "test-repo";
const repoRef = `root/${repoName}`;
let app: ReturnType<typeof createApp>;

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
	return {
		port: 3000,
		roots: [{ label: "root", path: reposRoot }],
		allowedLogins: [],
		allowWrites: true,
		...overrides,
	};
}

beforeAll(async () => {
	reposRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rift-files-test-"));
	repoDir = path.join(reposRoot, repoName);
	await fs.mkdir(repoDir);

	// Create directory structure:
	// repoDir/
	//   alpha.txt        (text file)
	//   beta.ts          (text file)
	//   gamma/           (directory)
	//     nested.txt     (text file)
	//   delta/           (directory)
	//   binary.bin       (binary file with null bytes)

	await fs.writeFile(path.join(repoDir, "alpha.txt"), "Hello, alpha!");
	await fs.writeFile(path.join(repoDir, "beta.ts"), "const x = 42;");
	await fs.writeFile(path.join(repoDir, "editable.txt"), "Original text\n");
	await fs.mkdir(path.join(repoDir, "gamma"));
	await fs.writeFile(path.join(repoDir, "gamma", "nested.txt"), "Nested file");
	await fs.mkdir(path.join(repoDir, "delta"));

	// Binary file: valid text then a null byte
	const binaryContent = Buffer.from("text\x00binary");
	await fs.writeFile(path.join(repoDir, "binary.bin"), binaryContent);

	app = createApp(makeConfig());
});

afterAll(async () => {
	await fs.rm(reposRoot, { recursive: true, force: true });
});

describe("GET /api/files (directory listing)", () => {
	test("returns entries sorted: directories first, then alphabetically", async () => {
		const res = await supertest(app).get(`/api/files?repo=${repoRef}`);

		expect(res.status).toBe(200);
		expect(res.body.truncated).toBe(false);

		const names = res.body.entries.map((e: { name: string }) => e.name);

		// Directories first (delta, gamma), then files (alpha.txt, beta.ts, binary.bin)
		const dirs = res.body.entries.filter(
			(e: { type: string }) => e.type === "directory",
		);
		const files = res.body.entries.filter(
			(e: { type: string }) => e.type === "file",
		);

		// All directories come before all files
		const lastDirIndex = names.lastIndexOf(dirs[dirs.length - 1]?.name);
		const firstFileIndex = names.indexOf(files[0]?.name);
		expect(lastDirIndex).toBeLessThan(firstFileIndex);

		// Directories are alphabetically sorted
		const dirNames = dirs.map((d: { name: string }) => d.name);
		expect(dirNames).toEqual([...dirNames].sort());

		// Files are alphabetically sorted
		const fileNames = files.map((f: { name: string }) => f.name);
		expect(fileNames).toEqual([...fileNames].sort());
	});

	test("lists every entry of a directory outside a repository", async () => {
		const res = await supertest(app).get(`/api/files?repo=${repoRef}`);

		expect(res.status).toBe(200);
		expect(res.body.entries.map((e: { name: string }) => e.name)).toEqual([
			"delta",
			"gamma",
			"alpha.txt",
			"beta.ts",
			"binary.bin",
			"editable.txt",
		]);
	});

	test("returns entries with name, type, and size fields", async () => {
		const res = await supertest(app).get(`/api/files?repo=${repoRef}`);

		expect(res.status).toBe(200);
		for (const entry of res.body.entries) {
			expect(typeof entry.name).toBe("string");
			expect(["file", "directory"]).toContain(entry.type);
			expect(typeof entry.size).toBe("number");
		}
	});

	test("returns subdirectory contents when path is specified", async () => {
		const res = await supertest(app).get(
			`/api/files?repo=${repoRef}&path=gamma`,
		);

		expect(res.status).toBe(200);
		expect(res.body.entries).toHaveLength(1);
		expect(res.body.entries[0].name).toBe("nested.txt");
		expect(res.body.entries[0].type).toBe("file");
	});

	test("returns 404 for nonexistent directory", async () => {
		const res = await supertest(app).get(
			`/api/files?repo=${repoRef}&path=nonexistent`,
		);

		expect(res.status).toBe(404);
		expect(res.body.error.code).toBe("NOT_FOUND");
	});

	test("returns 400 when path points to a file", async () => {
		const res = await supertest(app).get(
			`/api/files?repo=${repoRef}&path=alpha.txt`,
		);

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("NOT_A_DIRECTORY");
	});

	test("returns 403 for path traversal with ../", async () => {
		const res = await supertest(app).get(`/api/files?repo=${repoRef}&path=../`);

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});

	test("returns 403 for path traversal with absolute path", async () => {
		const res = await supertest(app).get(
			`/api/files?repo=${repoRef}&path=/etc`,
		);

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});

	test("returns 403 for encoded path traversal", async () => {
		const res = await supertest(app).get(
			`/api/files?repo=${repoRef}&path=gamma/../../`,
		);

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});

	test("returns 400 when repo parameter is missing", async () => {
		const res = await supertest(app).get("/api/files?path=.");

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("MISSING_REPO");
	});

	test("returns 404 for nonexistent repo", async () => {
		const res = await supertest(app).get("/api/files?repo=no-such-repo");

		expect(res.status).toBe(404);
		expect(res.body.error.code).toBe("NOT_FOUND");
	});

	test("returns 403 for repo with path traversal", async () => {
		const res = await supertest(app).get("/api/files?repo=../etc");

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("REPO_FORBIDDEN");
	});
});

describe("GET /api/files (truncation)", () => {
	let bigReposRoot: string;
	let bigApp: ReturnType<typeof createApp>;

	beforeAll(async () => {
		bigReposRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "rift-files-trunc-"),
		);
		const bigDir = path.join(bigReposRoot, "big-repo");
		await fs.mkdir(bigDir);
		// Create 1,005 files to exceed the 1,000 limit
		const promises = [];
		for (let i = 0; i < 1005; i++) {
			const name = `file-${String(i).padStart(5, "0")}.txt`;
			promises.push(fs.writeFile(path.join(bigDir, name), `content ${i}`));
		}
		await Promise.all(promises);
		bigApp = createApp(
			makeConfig({ roots: [{ label: "root", path: bigReposRoot }] }),
		);
	});

	afterAll(async () => {
		await fs.rm(bigReposRoot, { recursive: true, force: true });
	});

	test("truncates to 1,000 entries and sets truncated flag", async () => {
		const res = await supertest(bigApp).get("/api/files?repo=root/big-repo");

		expect(res.status).toBe(200);
		expect(res.body.entries).toHaveLength(1000);
		expect(res.body.truncated).toBe(true);
	});
});

describe("GET /api/files (gitignore filtering)", () => {
	let gitReposRoot: string;
	let gitApp: ReturnType<typeof createApp>;

	beforeAll(async () => {
		gitReposRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rift-files-git-"));
		const gitDir = path.join(gitReposRoot, "git-repo");
		await fs.mkdir(gitDir);

		// Initialize a git repo
		const { execSync } = await import("node:child_process");
		execSync("git init", { cwd: gitDir });
		execSync("git config user.email 'test@test.com'", { cwd: gitDir });
		execSync("git config user.name 'Test'", { cwd: gitDir });

		// Create .gitignore
		await fs.writeFile(
			path.join(gitDir, ".gitignore"),
			"ignored.txt\nignored_dir/\n*.log\n!keep.log\n",
		);

		// Create files
		await fs.writeFile(path.join(gitDir, "visible.txt"), "visible");
		await fs.writeFile(path.join(gitDir, "ignored.txt"), "ignored");
		await fs.writeFile(path.join(gitDir, "other.log"), "ignored by *.log");
		await fs.writeFile(path.join(gitDir, "keep.log"), "kept by !keep.log");
		await fs.mkdir(path.join(gitDir, "ignored_dir"));
		await fs.writeFile(path.join(gitDir, "ignored_dir", "inner.txt"), "inner");
		await fs.mkdir(path.join(gitDir, "visible_dir"));
		await fs.writeFile(path.join(gitDir, "visible_dir", "file.txt"), "file");

		// Commit .gitignore so git recognizes the repo properly
		execSync("git add .gitignore", { cwd: gitDir });
		execSync('git commit -m "init"', { cwd: gitDir });

		gitApp = createApp(
			makeConfig({ roots: [{ label: "root", path: gitReposRoot }] }),
		);
	});

	afterAll(async () => {
		await fs.rm(gitReposRoot, { recursive: true, force: true });
	});

	test("excludes gitignored files from directory listing", async () => {
		const res = await supertest(gitApp).get("/api/files?repo=root/git-repo");

		expect(res.status).toBe(200);

		const names = res.body.entries.map((e: { name: string }) => e.name);

		expect(names).toContain("visible.txt");
		expect(names).toContain(".gitignore");
		expect(names).toContain("visible_dir");
		expect(names).not.toContain("ignored.txt");
		expect(names).not.toContain("ignored_dir");
	});

	test("keeps a file a negated pattern matches", async () => {
		const res = await supertest(gitApp).get("/api/files?repo=root/git-repo");

		const names = res.body.entries.map((e: { name: string }) => e.name);
		expect(names).toContain("keep.log");
		expect(names).not.toContain("other.log");
	});

	test("leaves out git's own directory", async () => {
		const res = await supertest(gitApp).get("/api/files?repo=root/git-repo");

		const names = res.body.entries.map((e: { name: string }) => e.name);
		expect(names).not.toContain(".git");
	});

	test("lists a folder that ignores nothing in full", async () => {
		const res = await supertest(gitApp).get(
			"/api/files?repo=root/git-repo&path=visible_dir",
		);

		expect(res.status).toBe(200);
		expect(res.body.entries).toEqual([
			{ name: "file.txt", type: "file", size: 4 },
		]);
	});

	test("lists nothing of a folder that is ignored whole", async () => {
		const res = await supertest(gitApp).get(
			"/api/files?repo=root/git-repo&path=ignored_dir",
		);

		expect(res.status).toBe(200);
		expect(res.body.entries).toEqual([]);
	});
});

describe("GET /api/files/content", () => {
	test("returns file content as plain text", async () => {
		const res = await supertest(app).get(
			`/api/files/content?repo=${repoRef}&path=alpha.txt`,
		);

		expect(res.status).toBe(200);
		expect(res.headers["content-type"]).toMatch(/text\/plain/);
		expect(Number(res.headers["x-file-mtime-ms"])).toBeGreaterThan(0);
		expect(res.text).toBe("Hello, alpha!");
	});

	test("returns 400 when path parameter is missing", async () => {
		const res = await supertest(app).get(`/api/files/content?repo=${repoRef}`);

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("MISSING_PATH");
	});

	test("returns 404 for nonexistent file", async () => {
		const res = await supertest(app).get(
			`/api/files/content?repo=${repoRef}&path=nonexistent.txt`,
		);

		expect(res.status).toBe(404);
		expect(res.body.error.code).toBe("NOT_FOUND");
	});

	test("returns 400 when path is a directory", async () => {
		const res = await supertest(app).get(
			`/api/files/content?repo=${repoRef}&path=gamma`,
		);

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("IS_DIRECTORY");
	});

	test("returns 403 for path traversal with ../", async () => {
		const res = await supertest(app).get(
			`/api/files/content?repo=${repoRef}&path=../secret.txt`,
		);

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});

	test("returns 403 for absolute path", async () => {
		const res = await supertest(app).get(
			`/api/files/content?repo=${repoRef}&path=/etc/passwd`,
		);

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});

	test("returns 415 for binary file", async () => {
		const res = await supertest(app).get(
			`/api/files/content?repo=${repoRef}&path=binary.bin`,
		);

		expect(res.status).toBe(415);
		expect(res.body.error.code).toBe("BINARY_FILE");
	});

	test("returns 400 when repo parameter is missing", async () => {
		const res = await supertest(app).get("/api/files/content?path=alpha.txt");

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("MISSING_REPO");
	});
});

describe("GET /api/files/content (oversized file)", () => {
	let bigFileReposRoot: string;
	let bigFileApp: ReturnType<typeof createApp>;

	beforeAll(async () => {
		bigFileReposRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "rift-files-big-"),
		);
		const bigDir = path.join(bigFileReposRoot, "big-file-repo");
		await fs.mkdir(bigDir);

		// Create a file larger than 1 MB
		const onePointFiveMB = Buffer.alloc(1.5 * 1024 * 1024, "x");
		await fs.writeFile(path.join(bigDir, "large.txt"), onePointFiveMB);

		bigFileApp = createApp(
			makeConfig({ roots: [{ label: "root", path: bigFileReposRoot }] }),
		);
	});

	afterAll(async () => {
		await fs.rm(bigFileReposRoot, { recursive: true, force: true });
	});

	test("returns 413 for file exceeding 1 MB", async () => {
		const res = await supertest(bigFileApp).get(
			"/api/files/content?repo=root/big-file-repo&path=large.txt",
		);

		expect(res.status).toBe(413);
		expect(res.body.error.code).toBe("FILE_TOO_LARGE");
	});
});

describe("PUT /api/files/content", () => {
	test("writes updated text content", async () => {
		const initialStat = await fs.stat(path.join(repoDir, "editable.txt"));

		const res = await supertest(app)
			.put(`/api/files/content?repo=${repoRef}&path=editable.txt`)
			.send({
				content: "Updated text\n",
				expectedMtimeMs: initialStat.mtimeMs,
			});

		expect(res.status).toBe(200);
		expect(typeof res.body.mtimeMs).toBe("number");

		const saved = await fs.readFile(
			path.join(repoDir, "editable.txt"),
			"utf-8",
		);
		expect(saved).toBe("Updated text\n");
	});

	test("returns 409 when the file changed after load", async () => {
		const filePath = path.join(repoDir, "editable.txt");
		await fs.writeFile(filePath, "Conflict base\n");
		const initialStat = await fs.stat(filePath);

		await new Promise((resolve) => setTimeout(resolve, 10));
		await fs.writeFile(filePath, "Newer content\n");

		const res = await supertest(app)
			.put(`/api/files/content?repo=${repoRef}&path=editable.txt`)
			.send({
				content: "Stale write\n",
				expectedMtimeMs: initialStat.mtimeMs,
			});

		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe("FILE_MODIFIED");

		const saved = await fs.readFile(filePath, "utf-8");
		expect(saved).toBe("Newer content\n");
	});

	test("returns 400 when content is missing", async () => {
		const initialStat = await fs.stat(path.join(repoDir, "editable.txt"));

		const res = await supertest(app)
			.put(`/api/files/content?repo=${repoRef}&path=editable.txt`)
			.send({ expectedMtimeMs: initialStat.mtimeMs });

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("INVALID_CONTENT");
	});

	test("returns 404 for nonexistent file", async () => {
		const res = await supertest(app)
			.put(`/api/files/content?repo=${repoRef}&path=missing.txt`)
			.send({
				content: "Hello\n",
				expectedMtimeMs: 1,
			});

		expect(res.status).toBe(404);
		expect(res.body.error.code).toBe("NOT_FOUND");
	});

	test("returns 413 when the updated content exceeds 1 MB", async () => {
		const initialStat = await fs.stat(path.join(repoDir, "editable.txt"));
		const tooLarge = "x".repeat(1024 * 1024 + 1);

		const res = await supertest(app)
			.put(`/api/files/content?repo=${repoRef}&path=editable.txt`)
			.send({
				content: tooLarge,
				expectedMtimeMs: initialStat.mtimeMs,
			});

		expect(res.status).toBe(413);
		expect(res.body.error.code).toBe("FILE_TOO_LARGE");
	});

	describe("byte order mark", () => {
		const bom = Buffer.from([0xef, 0xbb, 0xbf]);

		async function putContent(name: string, content: string) {
			const stat = await fs.stat(path.join(repoDir, name));
			return supertest(app)
				.put(`/api/files/content?repo=${repoRef}&path=${name}`)
				.send({ content, expectedMtimeMs: stat.mtimeMs });
		}

		test("keeps the BOM when the saved content lacks one", async () => {
			const filePath = path.join(repoDir, "bom.cs");
			await fs.writeFile(filePath, Buffer.concat([bom, Buffer.from("old\n")]));

			const res = await putContent("bom.cs", "new\n");

			expect(res.status).toBe(200);
			const saved = await fs.readFile(filePath);
			expect(saved.equals(Buffer.concat([bom, Buffer.from("new\n")]))).toBe(
				true,
			);
			const stat = await fs.stat(filePath);
			expect(res.body.mtimeMs).toBe(stat.mtimeMs);
		});

		test("does not add a BOM to a file that had none", async () => {
			const filePath = path.join(repoDir, "nobom.txt");
			await fs.writeFile(filePath, "old\n");

			const res = await putContent("nobom.txt", "new\n");

			expect(res.status).toBe(200);
			const saved = await fs.readFile(filePath);
			expect(saved.equals(Buffer.from("new\n"))).toBe(true);
		});

		test("does not create a missing file, so none gains a BOM", async () => {
			const res = await supertest(app)
				.put(`/api/files/content?repo=${repoRef}&path=created.txt`)
				.send({ content: "new\n", expectedMtimeMs: 1 });

			expect(res.status).toBe(404);
			await expect(
				fs.stat(path.join(repoDir, "created.txt")),
			).rejects.toThrow();
		});

		test("does not double a BOM already in the content", async () => {
			const filePath = path.join(repoDir, "bom-twice.cs");
			await fs.writeFile(filePath, Buffer.concat([bom, Buffer.from("old\n")]));

			const res = await putContent("bom-twice.cs", "\uFEFFnew\n");

			expect(res.status).toBe(200);
			const saved = await fs.readFile(filePath);
			expect(saved.equals(Buffer.concat([bom, Buffer.from("new\n")]))).toBe(
				true,
			);
		});
	});
});

describe("PUT /api/files/content (the file's new context)", () => {
	let gitReposRoot: string;
	let gitDir: string;
	let gitApp: ReturnType<typeof createApp>;
	const gitRepoRef = "root/git-repo";

	beforeAll(async () => {
		gitReposRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rift-save-git-"));
		gitDir = path.join(gitReposRoot, "git-repo");
		await fs.mkdir(gitDir);

		const { execSync } = await import("node:child_process");
		execSync("git init", { cwd: gitDir });
		execSync("git config user.email 'you@example.com'", { cwd: gitDir });
		execSync("git config user.name 'You'", { cwd: gitDir });
		execSync("git config core.autocrlf false", { cwd: gitDir });
		await fs.writeFile(path.join(gitDir, ".gitignore"), "ignored.txt\n");
		await fs.writeFile(path.join(gitDir, "tracked.txt"), "one\ntwo\nthree\n");
		await fs.writeFile(path.join(gitDir, "other.txt"), "other\n");
		execSync("git add .gitignore tracked.txt other.txt", { cwd: gitDir });
		execSync('git commit -m "init"', { cwd: gitDir });
		// A change elsewhere in the repo, which the answer lists too.
		await fs.writeFile(path.join(gitDir, "other.txt"), "OTHER\n");

		gitApp = createApp(
			makeConfig({ roots: [{ label: "root", path: gitReposRoot }] }),
		);
	});

	afterAll(async () => {
		await fs.rm(gitReposRoot, { recursive: true, force: true });
	});

	// Saves a file of the git repo as the editor does, asking for its context
	// unless the request says otherwise.
	async function save(
		name: string,
		content: string,
		request: { context?: unknown } = { context: {} },
	) {
		const stat = await fs.stat(path.join(gitDir, name));
		return supertest(gitApp)
			.put(`/api/files/content?repo=${gitRepoRef}&path=${name}`)
			.send({ content, expectedMtimeMs: stat.mtimeMs, ...request });
	}

	// What the status and diff endpoints answer now, which a save's answer
	// stands for.
	async function endpoints(name: string, untracked: boolean) {
		const status = await supertest(gitApp).get(
			`/api/git/status?repo=${gitRepoRef}`,
		);
		const diff = await supertest(gitApp).get(
			`/api/git/diff?repo=${gitRepoRef}&path=${name}&staged=false${untracked ? "&untracked=true" : ""}`,
		);
		return { files: status.body.files, context: { unstagedDiff: diff.body } };
	}

	// The lines a diff adds and deletes.
	function changed(answer: { diff: string }): string[] {
		const lines = answer.diff.split("\n");
		return lines
			.slice(lines.findIndex((line) => line.startsWith("@@")))
			.filter((line) => /^[-+]/.test(line));
	}

	test("answers a save of a tracked file with the repo's changes and the file's new diff", async () => {
		const res = await save("tracked.txt", "one\nTWO\nthree\n");

		expect(res.status).toBe(200);
		const stat = await fs.stat(path.join(gitDir, "tracked.txt"));
		expect(res.body).toEqual({
			mtimeMs: stat.mtimeMs,
			...(await endpoints("tracked.txt", false)),
		});
		expect(res.body.files).toEqual([
			{ path: "other.txt", status: "modified", staged: false },
			{ path: "tracked.txt", status: "modified", staged: false },
		]);
		expect(changed(res.body.context.unstagedDiff)).toEqual(["-two", "+TWO"]);
		expect("exact" in res.body.context.unstagedDiff).toBe(false);

		// Saved back as committed, it has no diff, and leaves the changes.
		const back = await save("tracked.txt", "one\ntwo\nthree\n");
		expect(back.body.context).toEqual({
			unstagedDiff: { diff: "", truncated: false },
		});
		expect(back.body.files).toEqual([
			{ path: "other.txt", status: "modified", staged: false },
		]);
	});

	test("answers a save of an untracked file with its diff against nothing", async () => {
		// Whether or not the caller says it expects the file to be untracked.
		for (const context of [{}, { untracked: true }]) {
			await fs.writeFile(path.join(gitDir, "new.txt"), "one\n");

			const res = await save("new.txt", "one\ntwo\n", { context });

			expect(res.status).toBe(200);
			expect(res.body).toEqual({
				mtimeMs: res.body.mtimeMs,
				...(await endpoints("new.txt", true)),
			});
			expect(res.body.files).toContainEqual({
				path: "new.txt",
				status: "untracked",
				staged: false,
			});
			expect(changed(res.body.context.unstagedDiff)).toEqual(["+one", "+two"]);
			expect(res.body.context.unstagedDiff.exact).toBe(true);

			await fs.rm(path.join(gitDir, "new.txt"));
		}
	});

	// How many git processes a request started, as its Server-Timing says.
	function gitProcesses(res: { headers: Record<string, string> }): number {
		const desc = /desc="(\d+) process/.exec(res.headers["server-timing"]);
		return Number(desc?.[1] ?? 0);
	}

	test("reads the diff the caller expects alongside the status, and the other after it", async () => {
		await fs.writeFile(path.join(gitDir, "new.txt"), "one\n");

		const expected = await save("new.txt", "one\ntwo\n", {
			context: { untracked: true },
		});
		const unexpected = await save("new.txt", "one\ntwo\nthree\n");

		expect(gitProcesses(expected)).toBe(2);
		expect(gitProcesses(unexpected)).toBe(3);
		expect(unexpected.body.context).toEqual(
			(await endpoints("new.txt", true)).context,
		);
		await fs.rm(path.join(gitDir, "new.txt"));

		// A tracked file the caller takes for untracked.
		const tracked = await save("tracked.txt", "one\nTWO\nthree\n", {
			context: { untracked: true },
		});

		expect(gitProcesses(tracked)).toBe(3);
		expect(tracked.body.context).toEqual(
			(await endpoints("tracked.txt", false)).context,
		);
		await save("tracked.txt", "one\ntwo\nthree\n");
	});

	test("answers a save whose diff git cannot read with the changes and git's refusal", async () => {
		const { execSync } = await import("node:child_process");
		// An external diff command that fails fails `git diff`, but not the
		// status.
		execSync("git config diff.external false", { cwd: gitDir });

		const res = await save("tracked.txt", "one\nTWO\nthree\n");
		execSync("git config --unset diff.external", { cwd: gitDir });

		expect(res.status).toBe(200);
		expect(res.body.files).toEqual([
			{ path: "other.txt", status: "modified", staged: false },
			{ path: "tracked.txt", status: "modified", staged: false },
		]);
		expect(res.body.context.unstagedDiff.status).toBe(500);
		expect(res.body.context.unstagedDiff.error.code).toBe("GIT_ERROR");
		expect(typeof res.body.context.unstagedDiff.error.message).toBe("string");

		await save("tracked.txt", "one\ntwo\nthree\n");
	});

	test("answers with the mtime alone when git cannot read the status in time", async () => {
		const { execSync } = await import("node:child_process");
		const slowPath = path.join(gitDir, "slow.txt");
		await fs.writeFile(slowPath, "one\n");
		execSync("git add slow.txt", { cwd: gitDir });
		execSync('git commit -m "add slow.txt"', { cwd: gitDir });
		// A clean filter that outlasts the save's wait, which the status runs
		// on the file it finds changed.
		const filterSeconds = SAVE_CONTEXT_TIMEOUT_MS / 1000 + 0.5;
		execSync(`git config filter.slow.clean "sleep ${filterSeconds}; cat"`, {
			cwd: gitDir,
		});
		const attributes = path.join(gitDir, ".git", "info", "attributes");
		await fs.mkdir(path.dirname(attributes), { recursive: true });
		await fs.writeFile(attributes, "slow.txt filter=slow\n");

		const start = performance.now();
		const res = await save("slow.txt", "two\n");
		const elapsed = performance.now() - start;

		expect(res.status).toBe(200);
		expect(Object.keys(res.body)).toEqual(["mtimeMs"]);
		expect(elapsed).toBeLessThan(filterSeconds * 1000);
		expect(await fs.readFile(slowPath, "utf-8")).toBe("two\n");

		// The reads it no longer waits for hold the file until they finish, on
		// Windows, so the repo is put back once they have.
		await fs.rm(attributes);
		execSync("git config --unset filter.slow.clean", { cwd: gitDir });
		for (let attempt = 0; ; attempt++) {
			try {
				execSync("git rm -qf slow.txt", { cwd: gitDir, stdio: "pipe" });
				break;
			} catch (err) {
				if (attempt === 40) throw err;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		}
		execSync('git commit -m "remove slow.txt"', { cwd: gitDir });
	});

	test("cuts a diff to 1 MB, as /api/git/diff does", async () => {
		// Every line of a file of about 600 KB replaced, which deletes and adds
		// 600 KB.
		const lines = (text: string) => `${text.repeat(99)}\n`.repeat(6_000);
		const { execSync } = await import("node:child_process");
		await fs.writeFile(path.join(gitDir, "large.txt"), lines("a"));
		execSync("git add large.txt", { cwd: gitDir });
		execSync('git commit -m "add large.txt"', { cwd: gitDir });

		const res = await save("large.txt", lines("b"));

		expect(res.status).toBe(200);
		expect(res.body.context).toEqual(
			(await endpoints("large.txt", false)).context,
		);
		expect(res.body.context.unstagedDiff.truncated).toBe(true);
		expect(res.body.context.unstagedDiff.diff.length).toBe(1024 * 1024);

		execSync("git rm -qf large.txt", { cwd: gitDir });
		execSync('git commit -m "remove large.txt"', { cwd: gitDir });
	});

	test("answers a save of a file git ignores with no change in it", async () => {
		await fs.writeFile(path.join(gitDir, "ignored.txt"), "one\n");

		const res = await save("ignored.txt", "two\n");

		expect(res.status).toBe(200);
		expect(await fs.readFile(path.join(gitDir, "ignored.txt"), "utf-8")).toBe(
			"two\n",
		);
		expect(res.body).toEqual({
			mtimeMs: res.body.mtimeMs,
			...(await endpoints("ignored.txt", false)),
		});
		expect(res.body.files).toEqual([
			{ path: "other.txt", status: "modified", staged: false },
		]);
		expect(res.body.context.unstagedDiff).toEqual({
			diff: "",
			truncated: false,
		});

		await fs.rm(path.join(gitDir, "ignored.txt"));
	});

	test("answers with the mtime alone unless asked for the context", async () => {
		const res = await save("tracked.txt", "one\nTWO\nthree\n", {});

		expect(res.status).toBe(200);
		expect(Object.keys(res.body)).toEqual(["mtimeMs"]);

		await save("tracked.txt", "one\ntwo\nthree\n", {});
	});

	test("answers with the mtime alone for a file outside any repository", async () => {
		const stat = await fs.stat(path.join(repoDir, "editable.txt"));

		const res = await supertest(app)
			.put(`/api/files/content?repo=${repoRef}&path=editable.txt`)
			.send({
				content: "Saved outside a repository\n",
				expectedMtimeMs: stat.mtimeMs,
				context: {},
			});

		expect(res.status).toBe(200);
		expect(Object.keys(res.body)).toEqual(["mtimeMs"]);
		expect(await fs.readFile(path.join(repoDir, "editable.txt"), "utf-8")).toBe(
			"Saved outside a repository\n",
		);
	});

	test("writes nothing, and answers with no context, when the file changed after load", async () => {
		const filePath = path.join(gitDir, "tracked.txt");
		const loaded = await fs.stat(filePath);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await fs.writeFile(filePath, "changed elsewhere\n");

		const res = await supertest(gitApp)
			.put(`/api/files/content?repo=${gitRepoRef}&path=tracked.txt`)
			.send({
				content: "stale\n",
				expectedMtimeMs: loaded.mtimeMs,
				context: {},
			});

		expect(res.status).toBe(409);
		expect(res.body).toEqual({
			error: {
				code: "FILE_MODIFIED",
				message: "File changed on disk since it was loaded",
			},
		});
		expect(await fs.readFile(filePath, "utf-8")).toBe("changed elsewhere\n");

		await fs.writeFile(filePath, "one\ntwo\nthree\n");
	});

	test("returns INVALID_CONTEXT for a malformed context request, writing nothing", async () => {
		for (const context of [true, [], null, "yes", { untracked: "yes" }]) {
			const res = await save("tracked.txt", "not saved\n", { context });

			expect(res.status).toBe(400);
			expect(res.body.error.code).toBe("INVALID_CONTEXT");
		}
		expect(await fs.readFile(path.join(gitDir, "tracked.txt"), "utf-8")).toBe(
			"one\ntwo\nthree\n",
		);
	});
});
