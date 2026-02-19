import { describe, expect, test } from "bun:test";
import supertest from "supertest";
import { type AppConfig, createApp } from "../app.js";

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
	return {
		port: 3000,
		agentCommand: "echo",
		workingDir: process.cwd(),
		...overrides,
	};
}

describe("GET /api/health", () => {
	test("returns 200 status code", async () => {
		const app = createApp(makeConfig());
		const response = await supertest(app).get("/api/health");
		expect(response.status).toBe(200);
	});

	test("returns JSON content type", async () => {
		const app = createApp(makeConfig());
		const response = await supertest(app).get("/api/health");
		expect(response.headers["content-type"]).toMatch(/application\/json/);
	});

	test("response body has status field set to 'ok'", async () => {
		const app = createApp(makeConfig());
		const response = await supertest(app).get("/api/health");
		expect(response.body.status).toBe("ok");
	});

	test("response body has gitRepo field of type boolean", async () => {
		const app = createApp(makeConfig());
		const response = await supertest(app).get("/api/health");
		expect(typeof response.body.gitRepo).toBe("boolean");
	});

	test("response body has exactly two fields: status and gitRepo", async () => {
		const app = createApp(makeConfig());
		const response = await supertest(app).get("/api/health");
		const keys = Object.keys(response.body).sort();
		expect(keys).toEqual(["gitRepo", "status"]);
	});

	test("reports gitRepo true when workingDir is a git repository", async () => {
		// The Imp project root should be a git repo
		const projectRoot = new URL("../../..", import.meta.url).pathname.replace(
			/\/$/,
			"",
		);
		const app = createApp(makeConfig({ workingDir: projectRoot }));
		const response = await supertest(app).get("/api/health");
		expect(response.body.gitRepo).toBe(true);
	});

	test("reports gitRepo false when workingDir is not a git repository", async () => {
		// /tmp is almost certainly not a git repo
		const app = createApp(makeConfig({ workingDir: "/tmp" }));
		const response = await supertest(app).get("/api/health");
		expect(response.body.gitRepo).toBe(false);
	});
});
