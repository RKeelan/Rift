import { afterEach, describe, expect, test } from "bun:test";
import supertest from "supertest";
import type { AgentAdapter } from "../adapters/adapter.js";
import { EchoAdapter } from "../adapters/echo.js";
import { type AppConfig, createApp } from "../app.js";
import { SessionManager } from "../session.js";

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
	return {
		port: 3000,
		agentCommand: "echo",
		reposRoot: process.cwd(),
		basePath: "",
		...overrides,
	};
}

function makeManager(adapterFactory?: () => AgentAdapter): SessionManager {
	return new SessionManager({
		adapterFactory: adapterFactory ?? (() => new EchoAdapter()),
		ttlMs: 60_000,
		cleanupIntervalMs: 60_000,
	});
}

describe("Session REST endpoints", () => {
	let manager: SessionManager;

	afterEach(() => {
		manager?.dispose();
	});

	describe("POST /api/sessions", () => {
		test("creates a session and returns 201 with session info", async () => {
			manager = makeManager();
			const app = createApp(makeConfig(), manager);

			const response = await supertest(app)
				.post("/api/sessions")
				.send({ repo: "src" })
				.expect(201);

			expect(response.body.id).toBeTruthy();
			expect(response.body.state).toBe("running");
			expect(response.body.createdAt).toBeTruthy();
			expect(response.body.repo).toBe("src");
		});

		test("created session appears in list", async () => {
			manager = makeManager();
			const app = createApp(makeConfig(), manager);

			const createRes = await supertest(app)
				.post("/api/sessions")
				.send({ repo: "src" })
				.expect(201);

			const listRes = await supertest(app).get("/api/sessions").expect(200);

			expect(listRes.body).toHaveLength(1);
			expect(listRes.body[0].id).toBe(createRes.body.id);
			expect(listRes.body[0].state).toBe("running");
			expect(listRes.body[0].repo).toBe("src");
		});

		test("returns 400 when repo is missing", async () => {
			manager = makeManager();
			const app = createApp(makeConfig(), manager);

			const response = await supertest(app)
				.post("/api/sessions")
				.send({})
				.expect(400);

			expect(response.body.error.code).toBe("BAD_REQUEST");
		});

		test("returns 400 when repo contains path traversal", async () => {
			manager = makeManager();
			const app = createApp(makeConfig(), manager);

			const response = await supertest(app)
				.post("/api/sessions")
				.send({ repo: "../../etc" })
				.expect(400);

			expect(response.body.error.code).toBe("BAD_REQUEST");
		});

		test("returns 400 when repo is an absolute path", async () => {
			manager = makeManager();
			const app = createApp(makeConfig(), manager);

			const response = await supertest(app)
				.post("/api/sessions")
				.send({ repo: "/etc/passwd" })
				.expect(400);

			expect(response.body.error.code).toBe("BAD_REQUEST");
		});

		test("returns 400 when repo is not a string", async () => {
			manager = makeManager();
			const app = createApp(makeConfig(), manager);

			const response = await supertest(app)
				.post("/api/sessions")
				.send({ repo: 42 })
				.expect(400);

			expect(response.body.error.code).toBe("BAD_REQUEST");
		});

		test("returns 404 when repo does not exist", async () => {
			manager = makeManager();
			const app = createApp(makeConfig(), manager);

			const response = await supertest(app)
				.post("/api/sessions")
				.send({ repo: "nonexistent-repo" })
				.expect(404);

			expect(response.body.error.code).toBe("NOT_FOUND");
		});

		test("returns 500 when adapter spawn fails", async () => {
			const failingFactory = (): AgentAdapter => ({
				spawn: async () => {
					throw new Error("Adapter crashed");
				},
				send: () => {},
				onMessage: () => {},
				onExit: () => {},
				stop: () => {},
			});

			manager = makeManager(failingFactory);
			const app = createApp(makeConfig(), manager);

			const response = await supertest(app)
				.post("/api/sessions")
				.send({ repo: "src" })
				.expect(500);

			expect(response.body.error).toBeDefined();
			expect(response.body.error.code).toBe("ADAPTER_SPAWN_FAILED");
			expect(response.body.error.message).toBe("Adapter crashed");
		});
	});

	describe("GET /api/sessions", () => {
		test("returns empty array when no sessions exist", async () => {
			manager = makeManager();
			const app = createApp(makeConfig(), manager);

			const response = await supertest(app).get("/api/sessions").expect(200);

			expect(response.body).toEqual([]);
		});

		test("returns all sessions", async () => {
			manager = makeManager();
			const app = createApp(makeConfig(), manager);

			await supertest(app).post("/api/sessions").send({ repo: "src" });
			await supertest(app).post("/api/sessions").send({ repo: "src" });

			const response = await supertest(app).get("/api/sessions").expect(200);

			expect(response.body).toHaveLength(2);
		});
	});

	describe("GET /api/sessions/:id", () => {
		test("response contains only SessionInfo fields", async () => {
			manager = makeManager();
			const app = createApp(makeConfig(), manager);

			const createRes = await supertest(app)
				.post("/api/sessions")
				.send({ repo: "src" })
				.expect(201);

			const response = await supertest(app)
				.get(`/api/sessions/${createRes.body.id}`)
				.expect(200);

			const keys = Object.keys(response.body).sort();
			expect(keys).toEqual(["createdAt", "id", "repo", "state"]);
		});

		test("returns session details including repo", async () => {
			manager = makeManager();
			const app = createApp(makeConfig(), manager);

			const createRes = await supertest(app)
				.post("/api/sessions")
				.send({ repo: "src" })
				.expect(201);

			const response = await supertest(app)
				.get(`/api/sessions/${createRes.body.id}`)
				.expect(200);

			expect(response.body.id).toBe(createRes.body.id);
			expect(response.body.state).toBe("running");
			expect(response.body.createdAt).toBeTruthy();
			expect(response.body.repo).toBe("src");
		});

		test("returns 404 for non-existent session", async () => {
			manager = makeManager();
			const app = createApp(makeConfig(), manager);

			const response = await supertest(app)
				.get("/api/sessions/nonexistent-id")
				.expect(404);

			expect(response.body.error).toBeDefined();
			expect(response.body.error.code).toBe("NOT_FOUND");
		});
	});

	describe("DELETE /api/sessions/:id", () => {
		test("stops a running session and preserves repo in response", async () => {
			manager = makeManager();
			const app = createApp(makeConfig(), manager);

			const createRes = await supertest(app)
				.post("/api/sessions")
				.send({ repo: "src" })
				.expect(201);

			const deleteRes = await supertest(app)
				.delete(`/api/sessions/${createRes.body.id}`)
				.expect(200);

			expect(deleteRes.body.state).toBe("stopped");
			expect(deleteRes.body.repo).toBe("src");
		});

		test("session state changes to stopped after delete", async () => {
			manager = makeManager();
			const app = createApp(makeConfig(), manager);

			const createRes = await supertest(app)
				.post("/api/sessions")
				.send({ repo: "src" })
				.expect(201);

			await supertest(app)
				.delete(`/api/sessions/${createRes.body.id}`)
				.expect(200);

			const getRes = await supertest(app)
				.get(`/api/sessions/${createRes.body.id}`)
				.expect(200);

			expect(getRes.body.state).toBe("stopped");
		});

		test("returns 404 for non-existent session", async () => {
			manager = makeManager();
			const app = createApp(makeConfig(), manager);

			const response = await supertest(app)
				.delete("/api/sessions/nonexistent-id")
				.expect(404);

			expect(response.body.error).toBeDefined();
			expect(response.body.error.code).toBe("NOT_FOUND");
		});

		test("idempotent delete on already-stopped session returns 200", async () => {
			manager = makeManager();
			const app = createApp(makeConfig(), manager);

			const createRes = await supertest(app)
				.post("/api/sessions")
				.send({ repo: "src" })
				.expect(201);

			await supertest(app)
				.delete(`/api/sessions/${createRes.body.id}`)
				.expect(200);

			const secondDelete = await supertest(app)
				.delete(`/api/sessions/${createRes.body.id}`)
				.expect(200);

			expect(secondDelete.body.state).toBe("stopped");
		});
	});

	describe("full lifecycle", () => {
		test("create, list, fetch, stop, verify state changes", async () => {
			manager = makeManager();
			const app = createApp(makeConfig(), manager);

			// Create
			const createRes = await supertest(app)
				.post("/api/sessions")
				.send({ repo: "src" })
				.expect(201);
			const sessionId = createRes.body.id;
			expect(createRes.body.repo).toBe("src");

			// List: session is running
			const listRes1 = await supertest(app).get("/api/sessions").expect(200);
			expect(listRes1.body).toHaveLength(1);
			expect(listRes1.body[0].state).toBe("running");

			// Fetch by id
			const getRes1 = await supertest(app)
				.get(`/api/sessions/${sessionId}`)
				.expect(200);
			expect(getRes1.body.id).toBe(sessionId);
			expect(getRes1.body.state).toBe("running");
			expect(getRes1.body.repo).toBe("src");

			// Stop
			const deleteRes = await supertest(app)
				.delete(`/api/sessions/${sessionId}`)
				.expect(200);
			expect(deleteRes.body.state).toBe("stopped");

			// Verify stopped in list
			const listRes2 = await supertest(app).get("/api/sessions").expect(200);
			expect(listRes2.body[0].state).toBe("stopped");

			// Verify stopped in fetch
			const getRes2 = await supertest(app)
				.get(`/api/sessions/${sessionId}`)
				.expect(200);
			expect(getRes2.body.state).toBe("stopped");
		});
	});
});
