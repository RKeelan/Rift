import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import supertest from "supertest";
import { createApp } from "../app.js";

const repoName = "test-repo";
const repoRef = `root/${repoName}`;

// A read that rewrites the index holds its lock while it does, and a stage
// or commit that wants the lock then fails. The Files list polls status, so
// the status must leave the index alone.
describe("reading the status", () => {
	let reposRoot: string;
	let repoDir: string;
	let indexFile: string;
	let app: ReturnType<typeof createApp>;

	beforeAll(async () => {
		reposRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "rift-optional-locks-"),
		);
		repoDir = path.join(reposRoot, repoName);
		indexFile = path.join(repoDir, ".git", "index");
		await fs.mkdir(repoDir);
		execSync("git init", { cwd: repoDir });
		execSync("git config user.email 'test@test.com'", { cwd: repoDir });
		execSync("git config user.name 'Test'", { cwd: repoDir });
		await fs.writeFile(path.join(repoDir, "a.txt"), "one\n");
		execSync("git add a.txt", { cwd: repoDir });
		execSync('git commit -m "initial"', { cwd: repoDir });
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

	// Touching the file without changing it leaves the index's record of it
	// out of date, which a read would refresh by rewriting the index.
	async function makeIndexStale() {
		const later = new Date(Date.now() + 60_000);
		await fs.utimes(path.join(repoDir, "a.txt"), later, later);
	}

	test("polling the status leaves the index alone", async () => {
		await makeIndexStale();
		const before = await fs.readFile(indexFile);

		const res = await supertest(app).get(`/api/git/status?repo=${repoRef}`);

		expect(res.status).toBe(200);
		expect((await fs.readFile(indexFile)).equals(before)).toBe(true);
		// git's own status would have rewritten it.
		execSync("git status", { cwd: repoDir });
		expect((await fs.readFile(indexFile)).equals(before)).toBe(false);
	});
});
