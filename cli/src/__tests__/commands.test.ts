import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiClient, ApiError } from "../api.js";

let api: ApiClient;

beforeEach(() => {
	api = new ApiClient("http://localhost:3000");
});

afterEach(() => {
	mock.restore();
});

function mockFetch(
	body: unknown,
	init?: { status?: number; contentType?: string },
) {
	const status = init?.status ?? 200;
	const contentType = init?.contentType ?? "application/json";
	const isJson = contentType.includes("json");

	globalThis.fetch = mock((_url: string | URL | Request, _opts?: RequestInit) =>
		Promise.resolve(
			new Response(isJson ? JSON.stringify(body) : String(body), {
				status,
				headers: { "Content-Type": contentType },
			}),
		),
	) as typeof fetch;
}

// --- Health ---

describe("health", () => {
	test("GET /api/health", async () => {
		mockFetch({ status: "ok", gitRepo: true });
		const data = await api.get("/api/health");
		expect(data).toEqual({ status: "ok", gitRepo: true });
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://localhost:3000/api/health",
		);
	});
});

// --- Files ---

describe("files ls", () => {
	test("GET /api/files with default path", async () => {
		const entries = {
			entries: [
				{ name: "src", type: "directory", size: 0 },
				{ name: "package.json", type: "file", size: 420 },
			],
			truncated: false,
		};
		mockFetch(entries);
		const data = await api.get("/api/files?path=.");
		expect(data).toEqual(entries);
	});

	test("GET /api/files with custom path", async () => {
		mockFetch({ entries: [], truncated: false });
		await api.get("/api/files?path=src");
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://localhost:3000/api/files?path=src",
		);
	});
});

describe("files cat", () => {
	test("GET /api/files/content returns text", async () => {
		mockFetch("file content here", { contentType: "text/plain" });
		const text = await api.getText("/api/files/content?path=README.md");
		expect(text).toBe("file content here");
	});

	test("getText throws ApiError on 404", async () => {
		mockFetch(
			{ error: { code: "NOT_FOUND", message: "File not found" } },
			{ status: 404 },
		);
		try {
			await api.getText("/api/files/content?path=missing.txt");
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).code).toBe("NOT_FOUND");
			expect((err as ApiError).statusCode).toBe(404);
		}
	});
});

// --- Git ---

describe("git status", () => {
	test("GET /api/git/status", async () => {
		const status = {
			files: [
				{ path: "src/index.ts", status: "modified", staged: false },
				{ path: "package.json", status: "modified", staged: true },
			],
		};
		mockFetch(status);
		const data = await api.get("/api/git/status");
		expect(data).toEqual(status);
	});
});

describe("git diff", () => {
	test("GET /api/git/diff without staged", async () => {
		const diff = { diff: "--- a/file\n+++ b/file\n@@ ...", truncated: false };
		mockFetch(diff);
		const data = await api.get("/api/git/diff?path=src/index.ts");
		expect(data).toEqual(diff);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://localhost:3000/api/git/diff?path=src/index.ts",
		);
	});

	test("GET /api/git/diff with staged", async () => {
		mockFetch({ diff: "", truncated: false });
		await api.get("/api/git/diff?path=src/index.ts&staged=true");
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://localhost:3000/api/git/diff?path=src/index.ts&staged=true",
		);
	});
});

// --- Sessions ---

describe("session create", () => {
	test("POST /api/sessions", async () => {
		const session = {
			id: "abc123",
			state: "running",
			workingDirectory: "/tmp",
		};

		globalThis.fetch = mock(
			(_url: string | URL | Request, _opts?: RequestInit) =>
				Promise.resolve(
					new Response(JSON.stringify(session), {
						status: 201,
						headers: { "Content-Type": "application/json" },
					}),
				),
		) as typeof fetch;

		const data = await api.post("/api/sessions", {});
		expect(data).toEqual(session);
	});
});

describe("session list", () => {
	test("GET /api/sessions", async () => {
		const sessions = [
			{ id: "abc", state: "running" },
			{ id: "def", state: "stopped" },
		];
		mockFetch(sessions);
		const data = await api.get("/api/sessions");
		expect(data).toEqual(sessions);
	});
});

describe("session get", () => {
	test("GET /api/sessions/:id", async () => {
		const session = { id: "abc123", state: "running" };
		mockFetch(session);
		const data = await api.get("/api/sessions/abc123");
		expect(data).toEqual(session);
	});

	test("404 throws ApiError", async () => {
		mockFetch(
			{ error: { code: "NOT_FOUND", message: "Session not found" } },
			{ status: 404 },
		);
		try {
			await api.get("/api/sessions/nonexistent");
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).code).toBe("NOT_FOUND");
			expect((err as ApiError).statusCode).toBe(404);
		}
	});
});

describe("session stop", () => {
	test("DELETE /api/sessions/:id", async () => {
		const session = { id: "abc123", state: "stopped" };
		mockFetch(session);
		const data = await api.delete("/api/sessions/abc123");
		expect(data).toEqual(session);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://localhost:3000/api/sessions/abc123",
			{ method: "DELETE" },
		);
	});
});

// --- ApiClient ---

describe("ApiClient", () => {
	test("wsUrl converts http to ws", () => {
		expect(api.wsUrl("/api/sessions/abc/ws")).toBe(
			"ws://localhost:3000/api/sessions/abc/ws",
		);
	});

	test("wsUrl converts https to wss", () => {
		const secureApi = new ApiClient("https://example.com");
		expect(secureApi.wsUrl("/api/sessions/abc/ws")).toBe(
			"wss://example.com/api/sessions/abc/ws",
		);
	});
});

// --- Format ---

describe("format", () => {
	function captureStdout(fn: () => void): string {
		const chunks: string[] = [];
		const origWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			fn();
		} finally {
			process.stdout.write = origWrite;
		}
		return chunks.join("");
	}

	function captureStderr(fn: () => void): string {
		const chunks: string[] = [];
		const origWrite = process.stderr.write;
		process.stderr.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stderr.write;
		try {
			fn();
		} finally {
			process.stderr.write = origWrite;
		}
		return chunks.join("");
	}

	test("output writes JSON to stdout", async () => {
		const { output } = await import("../format.js");
		const text = captureStdout(() => output({ status: "ok" }, "json"));
		expect(text).toBe('{"status":"ok"}\n');
	});

	test("output writes text for git status", async () => {
		const { output } = await import("../format.js");
		const text = captureStdout(() =>
			output(
				{
					files: [
						{ path: "a.ts", status: "modified", staged: true },
						{ path: "b.ts", status: "untracked", staged: false },
					],
				},
				"text",
			),
		);
		expect(text).toContain("Staged:");
		expect(text).toContain("Unstaged:");
		expect(text).toContain("a.ts");
		expect(text).toContain("b.ts");
	});

	test("output formats session list array in text mode", async () => {
		const { output } = await import("../format.js");
		const text = captureStdout(() =>
			output(
				[
					{ id: "abc", state: "running" },
					{ id: "def", state: "stopped" },
				],
				"text",
			),
		);
		expect(text).toContain("id: abc");
		expect(text).toContain("id: def");
	});

	test("outputError formats ApiError with code", async () => {
		const { outputError } = await import("../format.js");
		const text = captureStderr(() =>
			outputError(new ApiError("NOT_FOUND", "Session not found", 404)),
		);
		const parsed = JSON.parse(text);
		expect(parsed.error.code).toBe("NOT_FOUND");
		expect(parsed.error.message).toBe("Session not found");
	});

	test("outputError formats plain Error with generic code", async () => {
		const { outputError } = await import("../format.js");
		const text = captureStderr(() => outputError(new Error("test error")));
		const parsed = JSON.parse(text);
		expect(parsed.error.code).toBe("ERROR");
		expect(parsed.error.message).toBe("test error");
	});

	test("outputError formats system errors (e.g. ECONNREFUSED) as plain Error", async () => {
		const { outputError } = await import("../format.js");
		const sysErr = new Error("connect ECONNREFUSED 127.0.0.1:3000");
		(sysErr as NodeJS.ErrnoException).code = "ECONNREFUSED";
		const text = captureStderr(() => outputError(sysErr));
		const parsed = JSON.parse(text);
		// Should use the generic "ERROR" code, not the system error code
		expect(parsed.error.code).toBe("ERROR");
		expect(parsed.error.message).toContain("ECONNREFUSED");
	});
});
