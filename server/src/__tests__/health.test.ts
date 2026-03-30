import { describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import supertest from "supertest";
import { type AppConfig, createApp } from "../app.js";

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
	return {
		port: 3000,
		reposRoot: process.cwd(),
		...overrides,
	};
}

describe("GET /api/health", () => {
	test("returns 200 with status ok when no repo specified", async () => {
		const app = createApp(makeConfig());
		const response = await supertest(app).get("/api/health");
		expect(response.status).toBe(200);
		expect(response.body).toEqual({ status: "ok" });
	});

	test("returns JSON content type", async () => {
		const app = createApp(makeConfig());
		const response = await supertest(app).get("/api/health");
		expect(response.headers["content-type"]).toMatch(/application\/json/);
	});

	test("reports gitRepo true when repo is a git repository", async () => {
		// The project root (three levels up from server/src/__tests__/) should be a git repo
		const thisFile = fileURLToPath(import.meta.url);
		const projectRoot = path.resolve(thisFile, "../../../..");
		const repoName = path.basename(projectRoot);
		const reposRoot = path.dirname(projectRoot);
		const app = createApp(makeConfig({ reposRoot }));
		const response = await supertest(app).get(`/api/health?repo=${repoName}`);
		expect(response.status).toBe(200);
		expect(response.body.gitRepo).toBe(true);
	});

	test("returns 404 when repo does not exist", async () => {
		const app = createApp(makeConfig({ reposRoot: "/tmp" }));
		const response = await supertest(app).get(
			"/api/health?repo=nonexistent-repo",
		);
		expect(response.status).toBe(404);
		expect(response.body.error.code).toBe("NOT_FOUND");
	});
});
