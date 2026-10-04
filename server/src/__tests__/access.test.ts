import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import supertest from "supertest";
import {
	classifyRequest,
	decideAccess,
	isLoopbackHost,
	parseAllowedLogins,
	parseAllowWrites,
	resolveHost,
} from "../access.js";
import { type AppConfig, createApp } from "../app.js";

const ALLOWED = new Set(["r.keelan@gmail.com"]);

// What tailscaled adds to a request from a tailnet user, per `tailscale serve`.
function tailnetHeaders(login: string): Record<string, string> {
	return {
		"tailscale-user-login": login,
		"tailscale-user-name": "Someone",
		"tailscale-user-profile-pic": "https://example.com/pic.png",
		"tailscale-headers-info": "https://tailscale.com/s/serve-headers",
		"x-forwarded-for": "100.64.0.2",
		"x-forwarded-host": "machine.tailnet.ts.net",
		"x-forwarded-proto": "https",
	};
}

describe("classifyRequest", () => {
	test("treats a request without proxy headers as local", () => {
		expect(
			classifyRequest({ host: "127.0.0.1:13000", "user-agent": "curl" }),
		).toEqual({ kind: "local" });
	});

	test("reads the login from a tailnet request", () => {
		expect(classifyRequest(tailnetHeaders("r.keelan@gmail.com"))).toEqual({
			kind: "proxied",
			login: "r.keelan@gmail.com",
			funnel: false,
		});
	});

	test.each([
		["x-forwarded-for", "100.64.0.2"],
		["forwarded", "for=100.64.0.2"],
		["x-real-ip", "100.64.0.2"],
		["via", "1.1 proxy"],
		["tailscale-headers-info", "https://tailscale.com/s/serve-headers"],
		["tailscale-funnel-request", "?1"],
	])("treats %s alone as a sign of a proxy", (name, value) => {
		const origin = classifyRequest({ [name]: value });
		expect(origin.kind).toBe("proxied");
	});

	test("flags Funnel requests", () => {
		const origin = classifyRequest({
			"tailscale-funnel-request": "?1",
			"x-forwarded-for": "203.0.113.9",
		});
		expect(origin).toEqual({ kind: "proxied", login: null, funnel: true });
	});
});

describe("decideAccess", () => {
	test("allows a local request", () => {
		expect(decideAccess({ kind: "local" }, new Set())).toEqual({
			allowed: true,
		});
	});

	test("allows a proxied request from an allowed login", () => {
		const origin = classifyRequest(tailnetHeaders("r.keelan@gmail.com"));
		expect(decideAccess(origin, ALLOWED)).toEqual({ allowed: true });
	});

	test("refuses a proxied request from another login", () => {
		const origin = classifyRequest(tailnetHeaders("someone@example.com"));
		expect(decideAccess(origin, ALLOWED)).toEqual({
			allowed: false,
			reason: "login-not-allowed",
		});
	});

	test("refuses a proxied request that carries no login", () => {
		const origin = classifyRequest({ "x-forwarded-for": "100.64.0.2" });
		expect(decideAccess(origin, ALLOWED)).toEqual({
			allowed: false,
			reason: "no-login",
		});
	});

	test("refuses Funnel requests even with an allowed login", () => {
		const origin = classifyRequest({
			...tailnetHeaders("r.keelan@gmail.com"),
			"tailscale-funnel-request": "?1",
		});
		expect(decideAccess(origin, ALLOWED)).toEqual({
			allowed: false,
			reason: "funnel",
		});
	});

	test("compares logins case-insensitively", () => {
		const allowed = new Set(parseAllowedLogins("R.Keelan@Gmail.com"));
		const origin = classifyRequest(tailnetHeaders("r.KEELAN@gmail.COM"));
		expect(decideAccess(origin, allowed)).toEqual({ allowed: true });
	});

	test("refuses every proxied request when the list is empty", () => {
		const origin = classifyRequest(tailnetHeaders("r.keelan@gmail.com"));
		expect(decideAccess(origin, new Set(parseAllowedLogins("")))).toEqual({
			allowed: false,
			reason: "login-not-allowed",
		});
		expect(
			decideAccess(origin, new Set(parseAllowedLogins(undefined))).allowed,
		).toBe(false);
	});
});

describe("parseAllowedLogins", () => {
	test("splits on commas, trims, and lower-cases", () => {
		expect(parseAllowedLogins(" A@x.com, b@Y.com ,,")).toEqual([
			"a@x.com",
			"b@y.com",
		]);
	});

	test("returns an empty list when unset or blank", () => {
		expect(parseAllowedLogins(undefined)).toEqual([]);
		expect(parseAllowedLogins("  ,  ")).toEqual([]);
	});
});

describe("parseAllowWrites", () => {
	test.each(["1", "true", "TRUE", "yes", "on", " 1 "])(
		"treats %p as allowing writes",
		(value) => {
			expect(parseAllowWrites(value)).toBe(true);
		},
	);

	test.each([undefined, "", "0", "false", "no", "off", "enabled"])(
		"treats %p as refusing writes",
		(value) => {
			expect(parseAllowWrites(value)).toBe(false);
		},
	);
});

describe("loopback check", () => {
	test.each([
		"127.0.0.1",
		"127.12.34.56",
		"::1",
		"0:0:0:0:0:0:0:1",
		"localhost",
		"LOCALHOST",
	])("accepts %s", (host) => {
		expect(isLoopbackHost(host)).toBe(true);
	});

	test.each([
		"0.0.0.0",
		"::",
		"192.168.1.10",
		"100.101.102.103",
		"128.0.0.1",
		"::ffff:192.168.1.10",
		"example.com",
		"localhost.example.com",
		"",
	])("rejects %p", (host) => {
		expect(isLoopbackHost(host)).toBe(false);
	});

	test("defaults to 127.0.0.1 when HOST is unset or blank", () => {
		expect(resolveHost(undefined)).toBe("127.0.0.1");
		expect(resolveHost("  ")).toBe("127.0.0.1");
	});

	test("returns a loopback HOST unchanged", () => {
		expect(resolveHost("::1")).toBe("::1");
	});

	test("refuses a non-loopback HOST with an explanation", () => {
		expect(() => resolveHost("0.0.0.0")).toThrow(
			/HOST=0\.0\.0\.0 is not a loopback address.*tailscale serve/,
		);
	});
});

const repoName = "test-repo";
const repoRef = `root/${repoName}`;

describe("gates in the app", () => {
	let reposRoot: string;
	let repoDir: string;

	function appWith(overrides: Partial<AppConfig> = {}) {
		return createApp({
			port: 3000,
			roots: [{ label: "root", path: reposRoot }],
			allowedLogins: ["r.keelan@gmail.com"],
			allowWrites: false,
			...overrides,
		});
	}

	function git(command: string): string {
		return execSync(`git ${command}`, { cwd: repoDir, encoding: "utf-8" });
	}

	beforeAll(async () => {
		reposRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rift-access-"));
		repoDir = path.join(reposRoot, repoName);
		await fs.mkdir(repoDir);
		git("init");
		git("config user.email test@test.com");
		git("config user.name Test");
		await fs.writeFile(path.join(repoDir, "notes.txt"), "one\ntwo\n");
		await fs.writeFile(path.join(repoDir, "staged.txt"), "staged\n");
		git("add notes.txt staged.txt");
		git('commit -m "initial"');
		// One unstaged and one staged change for the stage and unstage requests.
		await fs.writeFile(path.join(repoDir, "notes.txt"), "one\nTWO\n");
		await fs.writeFile(path.join(repoDir, "staged.txt"), "staged again\n");
		git("add staged.txt");
	});

	afterAll(async () => {
		await fs.rm(reposRoot, { recursive: true, force: true });
	});

	describe("identity gate", () => {
		test("allows a request without proxy headers", async () => {
			const res = await supertest(appWith()).get("/api/health");
			expect(res.status).toBe(200);
		});

		test("refuses a spoofed x-forwarded-for without a login", async () => {
			const res = await supertest(appWith())
				.get("/api/repos")
				.set("x-forwarded-for", "100.64.0.2");
			expect(res.status).toBe(403);
			expect(res.body.error.code).toBe("ACCESS_DENIED");
		});

		test("allows a request from an allowed login", async () => {
			const res = await supertest(appWith())
				.get("/api/repos")
				.set(tailnetHeaders("R.Keelan@gmail.com"));
			expect(res.status).toBe(200);
			expect(res.body.repos.map((r: { name: string }) => r.name)).toContain(
				repoRef,
			);
		});

		test("refuses a request from another login", async () => {
			const res = await supertest(appWith())
				.get("/api/repos")
				.set(tailnetHeaders("someone@example.com"));
			expect(res.status).toBe(403);
			expect(res.body.error.code).toBe("ACCESS_DENIED");
		});

		test("refuses Funnel requests", async () => {
			const res = await supertest(appWith())
				.get("/api/health")
				.set("tailscale-funnel-request", "?1")
				.set("x-forwarded-for", "203.0.113.9");
			expect(res.status).toBe(403);
		});

		test("refuses every proxied request when no logins are allowed", async () => {
			const res = await supertest(appWith({ allowedLogins: [] }))
				.get("/api/health")
				.set(tailnetHeaders("r.keelan@gmail.com"));
			expect(res.status).toBe(403);
		});

		test("covers the client as well as the API", async () => {
			for (const url of ["/", "/index.html", "/files"]) {
				const res = await supertest(appWith())
					.get(url)
					.set("x-forwarded-for", "100.64.0.2");
				expect(res.status).toBe(403);
			}
		});

		test("refuses a disallowed write before the write switch sees it", async () => {
			const res = await supertest(appWith({ allowWrites: true }))
				.post(`/api/git/stage?repo=${repoRef}`)
				.set("x-forwarded-for", "100.64.0.2")
				.send({ path: "notes.txt" });
			expect(res.status).toBe(403);
			expect(res.body.error.code).toBe("ACCESS_DENIED");
			expect(git("diff --cached --name-only").trim()).toBe("staged.txt");
		});
	});

	describe("write switch", () => {
		async function readNotes(): Promise<{ content: string; mtimeMs: number }> {
			const file = path.join(repoDir, "notes.txt");
			const [content, stat] = await Promise.all([
				fs.readFile(file, "utf-8"),
				fs.stat(file),
			]);
			return { content, mtimeMs: stat.mtimeMs };
		}

		test("refuses PUT /api/files/content and leaves the file alone", async () => {
			const before = await readNotes();
			const res = await supertest(appWith())
				.put(`/api/files/content?repo=${repoRef}&path=notes.txt`)
				.send({ content: "overwritten\n", expectedMtimeMs: before.mtimeMs });
			expect(res.status).toBe(403);
			expect(res.body.error.code).toBe("WRITES_DISABLED");
			expect((await readNotes()).content).toBe(before.content);
		});

		test("refuses POST /api/git/stage and leaves the index alone", async () => {
			for (const body of [
				{ path: "notes.txt" },
				{ path: "notes.txt", ranges: [[2, 2]] },
			]) {
				const res = await supertest(appWith())
					.post(`/api/git/stage?repo=${repoRef}`)
					.send(body);
				expect(res.status).toBe(403);
				expect(res.body.error.code).toBe("WRITES_DISABLED");
			}
			expect(git("diff --cached --name-only").trim()).toBe("staged.txt");
		});

		test("refuses POST /api/git/unstage and leaves the index alone", async () => {
			for (const body of [
				{ path: "staged.txt" },
				{ path: "staged.txt", ranges: [[1, 1]] },
			]) {
				const res = await supertest(appWith())
					.post(`/api/git/unstage?repo=${repoRef}`)
					.send(body);
				expect(res.status).toBe(403);
				expect(res.body.error.code).toBe("WRITES_DISABLED");
			}
			expect(git("diff --cached --name-only").trim()).toBe("staged.txt");
		});

		test("refuses writes from an allowed login too", async () => {
			const res = await supertest(appWith())
				.post(`/api/git/stage?repo=${repoRef}`)
				.set(tailnetHeaders("r.keelan@gmail.com"))
				.send({ path: "notes.txt" });
			expect(res.status).toBe(403);
			expect(res.body.error.code).toBe("WRITES_DISABLED");
		});

		test("refuses a write method on any path", async () => {
			const res = await supertest(appWith()).delete("/api/anything");
			expect(res.status).toBe(403);
			expect(res.body.error.code).toBe("WRITES_DISABLED");
		});

		test("still serves reads", async () => {
			const res = await supertest(appWith()).get(
				`/api/files/content?repo=${repoRef}&path=notes.txt`,
			);
			expect(res.status).toBe(200);
			expect(res.text).toBe("one\nTWO\n");
		});

		test("lets every gated endpoint through when writes are allowed", async () => {
			const app = appWith({ allowWrites: true });
			const { mtimeMs } = await readNotes();

			const put = await supertest(app)
				.put(`/api/files/content?repo=${repoRef}&path=notes.txt`)
				.send({ content: "one\nTWO\nthree\n", expectedMtimeMs: mtimeMs });
			expect(put.status).toBe(200);

			const stage = await supertest(app)
				.post(`/api/git/stage?repo=${repoRef}`)
				.set(tailnetHeaders("r.keelan@gmail.com"))
				.send({ path: "notes.txt" });
			expect(stage.status).toBe(200);

			const unstage = await supertest(app)
				.post(`/api/git/unstage?repo=${repoRef}`)
				.send({ path: "staged.txt" });
			expect(unstage.status).toBe(200);
			expect(git("diff --cached --name-only").trim()).toBe("notes.txt");
		});
	});
});
