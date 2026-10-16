import { describe, expect, test } from "bun:test";
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
