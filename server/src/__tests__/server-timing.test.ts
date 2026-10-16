import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import supertest from "supertest";
import { type AppConfig, createApp } from "../app.js";

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
	return {
		port: 3000,
		roots: [{ label: "root", path: process.cwd() }],
		allowedLogins: [],
		allowWrites: false,
		...overrides,
	};
}

function duration(header: string | undefined): number {
	const match = /^app;dur=(\d+\.\d)$/.exec(header ?? "");
	if (!match) throw new Error(`not a Server-Timing header: ${header}`);
	return Number(match[1]);
}

describe("Server-Timing", () => {
	test("an API response carries the server's time", async () => {
		const response = await supertest(createApp(makeConfig())).get(
			"/api/health",
		);
		expect(response.status).toBe(200);
		const ms = duration(response.headers["server-timing"]);
		expect(ms).toBeGreaterThanOrEqual(0);
		expect(ms).toBeLessThan(1000);
	});

	test("an error response carries it too", async () => {
		const response = await supertest(createApp(makeConfig())).get(
			"/api/nothing-here",
		);
		expect(response.status).toBe(404);
		duration(response.headers["server-timing"]);
	});

	test("a request refused by the write gate carries it", async () => {
		const response = await supertest(createApp(makeConfig()))
			.post("/api/files/content")
			.send({});
		expect(response.status).toBe(403);
		duration(response.headers["server-timing"]);
	});

	test("a request refused by the identity gate carries it", async () => {
		const response = await supertest(createApp(makeConfig()))
			.get("/api/health")
			.set("tailscale-user-login", "someone@example.com");
		expect(response.status).toBe(403);
		duration(response.headers["server-timing"]);
	});

	test("static assets do not carry it", async () => {
		const response = await supertest(createApp(makeConfig())).get(
			"/assets/missing.js",
		);
		expect(response.headers["server-timing"]).toBeUndefined();
	});
});

describe("Server-Timing for a request that runs git", () => {
	let reposRoot: string;
	let repoDir: string;
	let app: ReturnType<typeof createApp>;

	// The app's time, then git's: the time its processes took and their count.
	function timings(header: string | undefined) {
		const match =
			/^app;dur=(\d+\.\d), git;dur=(\d+\.\d);desc="(\d+) process(es)?"$/.exec(
				header ?? "",
			);
		if (!match) throw new Error(`no git time in Server-Timing: ${header}`);
		return {
			app: Number(match[1]),
			git: Number(match[2]),
			processes: Number(match[3]),
		};
	}

	beforeAll(async () => {
		reposRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rift-timing-"));
		repoDir = path.join(reposRoot, "repo");
		await fs.mkdir(repoDir);
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: repoDir });
		git("init", "-q");
		git("config", "user.email", "you@example.com");
		git("config", "user.name", "You");
		git("config", "core.autocrlf", "false");
		await fs.writeFile(path.join(repoDir, "a.txt"), "one\ntwo\nthree\n");
		git("add", "a.txt");
		git("commit", "-q", "-m", "initial");
		await fs.writeFile(path.join(repoDir, "a.txt"), "one\nTWO\nthree\n");
		app = createApp(
			makeConfig({
				roots: [{ label: "root", path: reposRoot }],
				allowWrites: true,
			}),
		);
	});

	afterAll(async () => {
		await fs.rm(reposRoot, { recursive: true, force: true });
	});

	test("a status adds the time of its one git process", async () => {
		const response = await supertest(app).get("/api/git/status?repo=root/repo");
		expect(response.status).toBe(200);
		const {
			app: appMs,
			git,
			processes,
		} = timings(response.headers["server-timing"]);
		expect(processes).toBe(1);
		expect(git).toBeGreaterThan(0);
		expect(git).toBeLessThanOrEqual(appMs);
	});

	test("a stage by line counts each process, after its body is read", async () => {
		const response = await supertest(app)
			.post("/api/git/stage?repo=root/repo")
			.send({ path: "a.txt", ranges: [[2, 2]] });
		expect(response.status).toBe(200);
		// The diff, the patch applied to the index, and the status after.
		expect(timings(response.headers["server-timing"]).processes).toBe(3);

		const unstage = await supertest(app)
			.post("/api/git/unstage?repo=root/repo")
			.send({ path: "a.txt" });
		expect(unstage.status).toBe(200);
		expect(timings(unstage.headers["server-timing"]).processes).toBe(2);
	});

	test("a stage that asks for the file's context counts the reads it takes", async () => {
		const response = await supertest(app)
			.post("/api/git/stage?repo=root/repo")
			.send({ path: "a.txt", ranges: [[2, 2]], context: {} });
		expect(response.status).toBe(200);
		// The diff and the patch, then the status, the file's two diffs and
		// the index's copy.
		expect(timings(response.headers["server-timing"]).processes).toBe(6);

		const unstage = await supertest(app)
			.post("/api/git/unstage?repo=root/repo")
			.send({ path: "a.txt", ranges: [[2, 2]], context: { head: true } });
		expect(unstage.status).toBe(200);
		// HEAD's copy as well.
		expect(timings(unstage.headers["server-timing"]).processes).toBe(7);
	});

	test("requests at the same time count only their own processes", async () => {
		const [status, diff, health] = await Promise.all([
			supertest(app).get("/api/git/status?repo=root/repo"),
			supertest(app).get("/api/git/diff?repo=root/repo&path=a.txt"),
			supertest(app).get("/api/health"),
		]);
		expect(timings(status.headers["server-timing"]).processes).toBe(1);
		expect(timings(diff.headers["server-timing"]).processes).toBe(1);
		duration(health.headers["server-timing"]);
	});
});
