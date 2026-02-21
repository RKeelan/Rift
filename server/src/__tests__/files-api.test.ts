import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import supertest from "supertest";
import { type AppConfig, createApp } from "../app.js";

let tmpDir: string;
let app: ReturnType<typeof createApp>;

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
	return {
		port: 3000,
		agentCommand: "echo",
		workingDir: tmpDir,
		...overrides,
	};
}

beforeAll(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rift-files-test-"));

	// Create directory structure:
	// tmpDir/
	//   alpha.txt        (text file)
	//   beta.ts          (text file)
	//   gamma/           (directory)
	//     nested.txt     (text file)
	//   delta/           (directory)
	//   binary.bin       (binary file with null bytes)

	await fs.writeFile(path.join(tmpDir, "alpha.txt"), "Hello, alpha!");
	await fs.writeFile(path.join(tmpDir, "beta.ts"), "const x = 42;");
	await fs.mkdir(path.join(tmpDir, "gamma"));
	await fs.writeFile(path.join(tmpDir, "gamma", "nested.txt"), "Nested file");
	await fs.mkdir(path.join(tmpDir, "delta"));

	// Binary file: valid text then a null byte
	const binaryContent = Buffer.from("text\x00binary");
	await fs.writeFile(path.join(tmpDir, "binary.bin"), binaryContent);

	app = createApp(makeConfig());
});

afterAll(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("GET /api/files (directory listing)", () => {
	test("returns entries sorted: directories first, then alphabetically", async () => {
		const res = await supertest(app).get("/api/files");

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

	test("returns entries with name, type, and size fields", async () => {
		const res = await supertest(app).get("/api/files");

		expect(res.status).toBe(200);
		for (const entry of res.body.entries) {
			expect(typeof entry.name).toBe("string");
			expect(["file", "directory"]).toContain(entry.type);
			expect(typeof entry.size).toBe("number");
		}
	});

	test("returns subdirectory contents when path is specified", async () => {
		const res = await supertest(app).get("/api/files?path=gamma");

		expect(res.status).toBe(200);
		expect(res.body.entries).toHaveLength(1);
		expect(res.body.entries[0].name).toBe("nested.txt");
		expect(res.body.entries[0].type).toBe("file");
	});

	test("returns 404 for nonexistent directory", async () => {
		const res = await supertest(app).get("/api/files?path=nonexistent");

		expect(res.status).toBe(404);
		expect(res.body.error.code).toBe("NOT_FOUND");
	});

	test("returns 400 when path points to a file", async () => {
		const res = await supertest(app).get("/api/files?path=alpha.txt");

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("NOT_A_DIRECTORY");
	});

	test("returns 403 for path traversal with ../", async () => {
		const res = await supertest(app).get("/api/files?path=../");

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});

	test("returns 403 for path traversal with absolute path", async () => {
		const res = await supertest(app).get("/api/files?path=/etc");

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});

	test("returns 403 for encoded path traversal", async () => {
		const res = await supertest(app).get("/api/files?path=gamma/../../");

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});
});

describe("GET /api/files (truncation)", () => {
	let bigDir: string;
	let bigApp: ReturnType<typeof createApp>;

	beforeAll(async () => {
		bigDir = await fs.mkdtemp(path.join(os.tmpdir(), "rift-files-trunc-"));
		// Create 1,005 files to exceed the 1,000 limit
		const promises = [];
		for (let i = 0; i < 1005; i++) {
			const name = `file-${String(i).padStart(5, "0")}.txt`;
			promises.push(fs.writeFile(path.join(bigDir, name), `content ${i}`));
		}
		await Promise.all(promises);
		bigApp = createApp(makeConfig({ workingDir: bigDir }));
	});

	afterAll(async () => {
		await fs.rm(bigDir, { recursive: true, force: true });
	});

	test("truncates to 1,000 entries and sets truncated flag", async () => {
		const res = await supertest(bigApp).get("/api/files");

		expect(res.status).toBe(200);
		expect(res.body.entries).toHaveLength(1000);
		expect(res.body.truncated).toBe(true);
	});
});

describe("GET /api/files (gitignore filtering)", () => {
	let gitDir: string;
	let gitApp: ReturnType<typeof createApp>;

	beforeAll(async () => {
		gitDir = await fs.mkdtemp(path.join(os.tmpdir(), "rift-files-git-"));

		// Initialize a git repo
		const { execSync } = await import("node:child_process");
		execSync("git init", { cwd: gitDir });
		execSync("git config user.email 'test@test.com'", { cwd: gitDir });
		execSync("git config user.name 'Test'", { cwd: gitDir });

		// Create .gitignore
		await fs.writeFile(
			path.join(gitDir, ".gitignore"),
			"ignored.txt\nignored_dir/\n",
		);

		// Create files
		await fs.writeFile(path.join(gitDir, "visible.txt"), "visible");
		await fs.writeFile(path.join(gitDir, "ignored.txt"), "ignored");
		await fs.mkdir(path.join(gitDir, "ignored_dir"));
		await fs.writeFile(path.join(gitDir, "ignored_dir", "inner.txt"), "inner");
		await fs.mkdir(path.join(gitDir, "visible_dir"));
		await fs.writeFile(path.join(gitDir, "visible_dir", "file.txt"), "file");

		// Commit .gitignore so git recognizes the repo properly
		execSync("git add .gitignore", { cwd: gitDir });
		execSync('git commit -m "init"', { cwd: gitDir });

		gitApp = createApp(makeConfig({ workingDir: gitDir }));
	});

	afterAll(async () => {
		await fs.rm(gitDir, { recursive: true, force: true });
	});

	test("excludes gitignored files from directory listing", async () => {
		const res = await supertest(gitApp).get("/api/files");

		expect(res.status).toBe(200);

		const names = res.body.entries.map((e: { name: string }) => e.name);

		expect(names).toContain("visible.txt");
		expect(names).toContain(".gitignore");
		expect(names).toContain("visible_dir");
		expect(names).not.toContain("ignored.txt");
		expect(names).not.toContain("ignored_dir");
	});
});

describe("GET /api/files/content", () => {
	test("returns file content as plain text", async () => {
		const res = await supertest(app).get("/api/files/content?path=alpha.txt");

		expect(res.status).toBe(200);
		expect(res.headers["content-type"]).toMatch(/text\/plain/);
		expect(res.text).toBe("Hello, alpha!");
	});

	test("returns 400 when path parameter is missing", async () => {
		const res = await supertest(app).get("/api/files/content");

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("MISSING_PATH");
	});

	test("returns 404 for nonexistent file", async () => {
		const res = await supertest(app).get(
			"/api/files/content?path=nonexistent.txt",
		);

		expect(res.status).toBe(404);
		expect(res.body.error.code).toBe("NOT_FOUND");
	});

	test("returns 400 when path is a directory", async () => {
		const res = await supertest(app).get("/api/files/content?path=gamma");

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("IS_DIRECTORY");
	});

	test("returns 403 for path traversal with ../", async () => {
		const res = await supertest(app).get(
			"/api/files/content?path=../secret.txt",
		);

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});

	test("returns 403 for absolute path", async () => {
		const res = await supertest(app).get("/api/files/content?path=/etc/passwd");

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("PATH_FORBIDDEN");
	});

	test("returns 415 for binary file", async () => {
		const res = await supertest(app).get("/api/files/content?path=binary.bin");

		expect(res.status).toBe(415);
		expect(res.body.error.code).toBe("BINARY_FILE");
	});
});

describe("GET /api/files/content (oversized file)", () => {
	let bigFileDir: string;
	let bigFileApp: ReturnType<typeof createApp>;

	beforeAll(async () => {
		bigFileDir = await fs.mkdtemp(path.join(os.tmpdir(), "rift-files-big-"));

		// Create a file larger than 1 MB
		const onePointFiveMB = Buffer.alloc(1.5 * 1024 * 1024, "x");
		await fs.writeFile(path.join(bigFileDir, "large.txt"), onePointFiveMB);

		bigFileApp = createApp(makeConfig({ workingDir: bigFileDir }));
	});

	afterAll(async () => {
		await fs.rm(bigFileDir, { recursive: true, force: true });
	});

	test("returns 413 for file exceeding 1 MB", async () => {
		const res = await supertest(bigFileApp).get(
			"/api/files/content?path=large.txt",
		);

		expect(res.status).toBe(413);
		expect(res.body.error.code).toBe("FILE_TOO_LARGE");
	});
});
