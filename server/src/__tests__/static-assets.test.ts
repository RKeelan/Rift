import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import supertest from "supertest";
import { createApp } from "../app.js";

const clientDist = path.resolve(import.meta.dirname, "../../../client/dist");
const app = createApp({
	port: 3000,
	roots: [{ label: "root", path: process.cwd() }],
	allowedLogins: [],
	allowWrites: false,
});

describe("static assets and SPA fallback", () => {
	test("returns 404, not index.html, for a missing asset", async () => {
		const response = await supertest(app).get("/assets/dist-missing123.js");
		expect(response.status).toBe(404);
		expect(response.headers["content-type"]).not.toMatch(/text\/html/);
	});

	test("returns 404 for a missing asset in a subdirectory", async () => {
		const response = await supertest(app).get("/assets/nested/missing.css");
		expect(response.status).toBe(404);
	});

	test("serves index.html for a client route", async () => {
		const response = await supertest(app).get("/files/some/route");
		expect(response.status).toBe(200);
		expect(response.headers["content-type"]).toMatch(/text\/html/);
	});

	test.skipIf(!existsSync(path.join(clientDist, "assets")))(
		"serves a built asset",
		async () => {
			const file = readdirSync(path.join(clientDist, "assets")).find((name) =>
				name.endsWith(".js"),
			);
			expect(file).toBeDefined();
			const response = await supertest(app).get(`/assets/${file}`);
			expect(response.status).toBe(200);
			expect(response.headers["content-type"]).toMatch(/javascript/);
		},
	);
});
