import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import supertest from "supertest";
import { createApp } from "../app.js";

const ALL_PARTS = "file,unstagedDiff,stagedDiff,index,head";

describe("GET /api/git/open", () => {
	let reposRoot: string;
	let repoDir: string;
	let app: ReturnType<typeof createApp>;

	function git(command: string) {
		execSync(`git ${command}`, { cwd: repoDir });
	}

	async function write(name: string, content: string | Buffer) {
		await fs.writeFile(path.join(repoDir, name), content);
	}

	beforeAll(async () => {
		reposRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rift-git-open-"));
		repoDir = path.join(reposRoot, "repo");
		await fs.mkdir(repoDir);
		git("init");
		git("config user.email 'you@example.com'");
		git("config user.name 'You'");
		git("config core.autocrlf false");

		const lines = (word: string) =>
			Array.from({ length: 20 }, (_, n) => `${word} ${n + 1}\n`).join("");
		await write("modified.txt", lines("modified"));
		await write("both.txt", lines("both"));
		await write("deleted.txt", lines("deleted"));
		await write("unchanged.txt", lines("unchanged"));
		await write("bom.txt", `\uFEFF${lines("bom")}`);
		await write("large.txt", "x".repeat(1024 * 1024 + 1));
		await write("image.bin", Buffer.from("text\x00binary"));
		git("add -A");
		git('commit -m "initial"');

		await write(
			"modified.txt",
			lines("modified").replace("5\n", "5, changed\n"),
		);
		await write("both.txt", lines("both").replace("3\n", "3, staged\n"));
		git("add both.txt");
		await write(
			"both.txt",
			lines("both")
				.replace("3\n", "3, staged\n")
				.replace("17\n", "17, unstaged\n"),
		);
		await fs.rm(path.join(repoDir, "deleted.txt"));
		await write("added.txt", lines("added"));
		git("add added.txt");
		await write("untracked.txt", lines("untracked"));
		await write(
			"bom.txt",
			`\uFEFF${lines("bom").replace("2\n", "2, changed\n")}`,
		);
		await write("large.txt", "y".repeat(1024 * 1024 + 1));
		await write("image.bin", Buffer.from("text\x00changed"));

		await fs.mkdir(path.join(reposRoot, "plain"));
		await fs.writeFile(path.join(reposRoot, "plain", "notes.txt"), "plain\n");

		app = createApp({
			port: 3000,
			roots: [{ label: "root", path: reposRoot }],
			allowedLogins: [],
			allowWrites: true,
		});
	});

	afterAll(async () => {
		await fs.rm(reposRoot, { recursive: true, force: true });
	});

	function refusal(res: supertest.Response) {
		return { status: res.status, error: res.body.error };
	}

	// Each part as the endpoint that reads it alone answers, in the shape the
	// open answers with it.
	async function separately(repo: string, name: string, untracked = false) {
		const query = `repo=root/${repo}&path=${encodeURIComponent(name)}`;
		const [file, unstagedDiff, stagedDiff, index, head] = await Promise.all([
			supertest(app).get(`/api/files/content?${query}`),
			supertest(app).get(
				`/api/git/diff?${query}&staged=false${untracked ? "&untracked=true" : ""}`,
			),
			supertest(app).get(`/api/git/diff?${query}&staged=true`),
			supertest(app).get(`/api/git/base-content?${query}&staged=false`),
			supertest(app).get(`/api/git/base-content?${query}&staged=true`),
		]);
		const copy = (res: supertest.Response) =>
			res.status === 200 ? { content: res.text } : refusal(res);
		const diff = (res: supertest.Response) =>
			res.status === 200 ? res.body : refusal(res);
		return {
			file:
				file.status === 200
					? {
							content: file.text,
							mtimeMs: Number(file.headers["x-file-mtime-ms"]),
						}
					: refusal(file),
			unstagedDiff: diff(unstagedDiff),
			stagedDiff: diff(stagedDiff),
			index: copy(index),
			head: copy(head),
		};
	}

	async function open(repo: string, name: string, query = "") {
		return supertest(app).get(
			`/api/git/open?repo=root/${repo}&path=${encodeURIComponent(name)}${query}`,
		);
	}

	test("answers a modified file's parts as their endpoints do", async () => {
		const res = await open("repo", "modified.txt", `&parts=${ALL_PARTS}`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual(await separately("repo", "modified.txt"));
		expect(res.body.unstagedDiff.diff).toContain("+modified 5, changed");
		expect(res.body.stagedDiff.diff).toBe("");
	});

	test("answers a file with staged and unstaged changes as the endpoints do", async () => {
		const res = await open("repo", "both.txt", `&parts=${ALL_PARTS}`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual(await separately("repo", "both.txt"));
		expect(res.body.unstagedDiff.diff).toContain("+both 17, unstaged");
		expect(res.body.stagedDiff.diff).toContain("+both 3, staged");
		expect(res.body.index.content).toContain("both 3, staged");
		expect(res.body.head.content).toContain("both 3\n");
	});

	test("answers an untracked file's diff against nothing, saying whether it is exact", async () => {
		const res = await open(
			"repo",
			"untracked.txt",
			`&parts=${ALL_PARTS}&untracked=true`,
		);
		expect(res.status).toBe(200);
		expect(res.body).toEqual(await separately("repo", "untracked.txt", true));
		expect(res.body.unstagedDiff.exact).toBe(true);
		expect(res.body.index.error.code).toBe("NOT_FOUND");
	});

	test("refuses a deleted file's text, and gives the copy it is read from", async () => {
		const res = await open("repo", "deleted.txt", `&parts=${ALL_PARTS}`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual(await separately("repo", "deleted.txt"));
		expect(res.body.file).toEqual({
			status: 404,
			error: { code: "NOT_FOUND", message: "File not found" },
		});
		expect(res.body.index.content).toContain("deleted 1\n");
	});

	test("refuses HEAD's copy of a file added since", async () => {
		const res = await open("repo", "added.txt", `&parts=${ALL_PARTS}`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual(await separately("repo", "added.txt"));
		expect(res.body.head.error.code).toBe("NOT_FOUND");
		expect(res.body.stagedDiff.diff).toContain("new file mode");
	});

	test("answers an unchanged file with empty diffs", async () => {
		const res = await open("repo", "unchanged.txt", `&parts=${ALL_PARTS}`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual(await separately("repo", "unchanged.txt"));
		expect(res.body.unstagedDiff).toEqual({ diff: "", truncated: false });
		expect(res.body.index.content).toBe(res.body.file.content);
	});

	test("keeps a leading byte order mark, as the endpoints send it", async () => {
		const res = await open("repo", "bom.txt", `&parts=${ALL_PARTS}`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual(await separately("repo", "bom.txt"));
		expect(res.body.file.content.startsWith("\uFEFF")).toBe(true);
		expect(res.body.index.content.startsWith("\uFEFF")).toBe(true);
	});

	test("refuses a file over 1 MB, and its copies, as the endpoints do", async () => {
		const res = await open("repo", "large.txt", `&parts=${ALL_PARTS}`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual(await separately("repo", "large.txt"));
		const tooLarge = {
			status: 413,
			error: {
				code: "FILE_TOO_LARGE",
				message: "File exceeds maximum size of 1 MB",
			},
		};
		expect(res.body.file).toEqual(tooLarge);
		expect(res.body.index).toEqual(tooLarge);
		expect(res.body.head).toEqual(tooLarge);
	});

	test("refuses a binary file, and its copies, as the endpoints do", async () => {
		const res = await open("repo", "image.bin", `&parts=${ALL_PARTS}`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual(await separately("repo", "image.bin"));
		expect(res.body.file.error.code).toBe("BINARY_FILE");
		expect(res.body.index.error.code).toBe("BINARY_FILE");
	});

	test("reads a file outside any repository, and answers each git part NOT_GIT_REPO", async () => {
		const res = await open("plain", "notes.txt", `&parts=${ALL_PARTS}`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual(await separately("plain", "notes.txt"));
		expect(res.body.file.content).toBe("plain\n");
		for (const part of ["unstagedDiff", "stagedDiff", "index", "head"]) {
			expect(res.body[part]).toEqual({
				status: 400,
				error: {
					code: "NOT_GIT_REPO",
					message: "The working directory is not a git repository",
				},
			});
		}
	});

	test("answers only the parts asked for", async () => {
		const res = await open(
			"repo",
			"both.txt",
			"&parts=file,index,unstagedDiff",
		);
		expect(res.status).toBe(200);
		expect(Object.keys(res.body).sort()).toEqual([
			"file",
			"index",
			"unstagedDiff",
		]);
		const { file, index, unstagedDiff } = await separately("repo", "both.txt");
		expect(res.body).toEqual({ file, index, unstagedDiff });
	});

	test("answers every part when none are named", async () => {
		const res = await open("repo", "modified.txt");
		expect(res.status).toBe(200);
		expect(res.body).toEqual(await separately("repo", "modified.txt"));
	});

	test("refuses parts it does not know", async () => {
		for (const parts of ["file,status", "", "file,,index"]) {
			const res = await open("repo", "modified.txt", `&parts=${parts}`);
			expect(res.status).toBe(400);
			expect(res.body.error.code).toBe("INVALID_PARTS");
		}
	});

	test("refuses a missing or forbidden path, and a missing repo, as the endpoints do", async () => {
		const missingPath = await supertest(app).get(
			"/api/git/open?repo=root/repo",
		);
		expect(missingPath.status).toBe(400);
		expect(missingPath.body.error.code).toBe("MISSING_PATH");

		const traversal = await open("repo", "../plain/notes.txt");
		expect(traversal.status).toBe(403);
		expect(traversal.body.error.code).toBe("PATH_FORBIDDEN");

		const noRepo = await open("no-such-repo", "notes.txt");
		expect(noRepo.status).toBe(404);
		expect(noRepo.body.error.code).toBe("NOT_FOUND");
	});
});
