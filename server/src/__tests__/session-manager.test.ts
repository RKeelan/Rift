import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerMessage } from "shared";
import type { AdapterConfig, AgentAdapter } from "../adapters/adapter.js";
import { EchoAdapter } from "../adapters/echo.js";
import { SessionManager } from "../session.js";

function createManager(
	overrides?: Partial<{
		ttlMs: number;
		cleanupIntervalMs: number;
		adapterFactory: () => AgentAdapter;
	}>,
): SessionManager {
	return new SessionManager({
		adapterFactory: () => new EchoAdapter(),
		ttlMs: overrides?.ttlMs ?? 60_000,
		cleanupIntervalMs: overrides?.cleanupIntervalMs ?? 60_000,
		...overrides,
	});
}

describe("SessionManager", () => {
	let manager: SessionManager;

	afterEach(() => {
		manager?.dispose();
	});

	describe("createSession", () => {
		test("returns session info with id, running state, and createdAt", async () => {
			manager = createManager();
			const info = await manager.createSession("/tmp");

			expect(info.id).toBeTruthy();
			expect(info.state).toBe("running");
			expect(info.createdAt).toBeTruthy();
			// Verify createdAt is a valid ISO date string
			expect(new Date(info.createdAt).toISOString()).toBe(info.createdAt);
		});

		test("each session gets a unique id", async () => {
			manager = createManager();
			const info1 = await manager.createSession("/tmp");
			const info2 = await manager.createSession("/tmp");

			expect(info1.id).not.toBe(info2.id);
		});
	});

	describe("listSessions", () => {
		test("returns empty array when no sessions exist", () => {
			manager = createManager();
			expect(manager.listSessions()).toEqual([]);
		});

		test("returns all created sessions", async () => {
			manager = createManager();
			await manager.createSession("/tmp");
			await manager.createSession("/tmp");

			const sessions = manager.listSessions();
			expect(sessions).toHaveLength(2);
		});

		test("session info does not expose adapter or buffer", async () => {
			manager = createManager();
			await manager.createSession("/tmp");

			const sessions = manager.listSessions();
			const keys = Object.keys(sessions[0]).sort();
			expect(keys).toEqual(["createdAt", "id", "state"]);
		});
	});

	describe("getSession", () => {
		test("returns session info for existing session", async () => {
			manager = createManager();
			const created = await manager.createSession("/tmp");

			const fetched = manager.getSession(created.id);
			expect(fetched).toBeDefined();
			expect(fetched?.id).toBe(created.id);
			expect(fetched?.state).toBe("running");
		});

		test("returns undefined for non-existent session", () => {
			manager = createManager();
			expect(manager.getSession("nonexistent")).toBeUndefined();
		});
	});

	describe("stopSession", () => {
		test("stops a running session", async () => {
			manager = createManager();
			const created = await manager.createSession("/tmp");

			const stopped = manager.stopSession(created.id);
			expect(stopped).toBe(true);

			const session = manager.getSession(created.id);
			expect(session?.state).toBe("stopped");
		});

		test("returns false for non-existent session", () => {
			manager = createManager();
			expect(manager.stopSession("nonexistent")).toBe(false);
		});

		test("stopping an already stopped session returns true", async () => {
			manager = createManager();
			const created = await manager.createSession("/tmp");

			manager.stopSession(created.id);
			const result = manager.stopSession(created.id);
			expect(result).toBe(true);

			// Still stopped
			const session = manager.getSession(created.id);
			expect(session?.state).toBe("stopped");
		});
	});

	describe("message buffering", () => {
		test("send buffers messages from the adapter", async () => {
			manager = createManager();
			const created = await manager.createSession("/tmp");

			manager.send(created.id, "hello");

			const buffer = manager.getBuffer(created.id);
			expect(buffer).toBeDefined();
			// EchoAdapter emits 3 messages per send
			expect(buffer ?? []).toHaveLength(3);
			expect(buffer?.[0].type).toBe("assistant_text");
			expect(buffer?.[1].type).toBe("tool_use");
			expect(buffer?.[2].type).toBe("tool_result");
		});

		test("getBuffer returns undefined for non-existent session", () => {
			manager = createManager();
			expect(manager.getBuffer("nonexistent")).toBeUndefined();
		});

		test("send returns false for non-existent session", () => {
			manager = createManager();
			expect(manager.send("nonexistent", "hello")).toBe(false);
		});

		test("send returns false for stopped session", async () => {
			manager = createManager();
			const created = await manager.createSession("/tmp");

			manager.stopSession(created.id);
			expect(manager.send(created.id, "hello")).toBe(false);
		});

		test("buffer accumulates messages across multiple sends", async () => {
			manager = createManager();
			const created = await manager.createSession("/tmp");

			manager.send(created.id, "first");
			manager.send(created.id, "second");

			const buffer = manager.getBuffer(created.id);
			// 3 messages per send * 2 sends = 6
			expect(buffer ?? []).toHaveLength(6);
		});
	});

	describe("buffer eviction at limit", () => {
		test("drops oldest messages when buffer exceeds 10,000", async () => {
			manager = createManager();
			const created = await manager.createSession("/tmp");

			// EchoAdapter emits 3 messages per send
			// To exceed 10,000: send 3,334 times = 10,002 messages
			// After eviction, buffer should be at 10,000
			// We'll send enough to hit the limit and verify oldest are dropped
			const buffer = manager.getBuffer(created.id);
			expect(buffer).toBeDefined();

			// Directly push messages to test eviction logic without sending 3,334 times
			// Instead, send enough to observe eviction behaviour
			// The buffer limit is enforced in the onMessage callback
			// Let's send 3,334 times to produce 10,002 messages
			for (let i = 0; i < 3334; i++) {
				manager.send(created.id, `msg-${i}`);
			}

			// 3334 * 3 = 10,002 messages attempted, but capped at 10,000
			expect(buffer?.length).toBe(10_000);

			// The first 2 messages should have been dropped (FIFO eviction)
			// First message sent was "msg-0", which produced:
			//   assistant_text "Echo: msg-0", tool_use, tool_result
			// The oldest 2 were dropped, so the first message remaining
			// should be the tool_result from "msg-0"
			const firstMsg = buffer?.[0];
			expect(firstMsg?.type).toBe("tool_result");
		});
	});

	describe("TTL cleanup of stopped sessions", () => {
		test("stopped sessions are removed after TTL expires", async () => {
			// Use a very short TTL and cleanup interval
			manager = createManager({
				ttlMs: 50,
				cleanupIntervalMs: 25,
			});

			const created = await manager.createSession("/tmp");
			manager.stopSession(created.id);

			// Session should still exist immediately
			expect(manager.getSession(created.id)).toBeDefined();

			// Wait for TTL + cleanup interval to pass
			await new Promise((resolve) => setTimeout(resolve, 150));

			// Session should be cleaned up
			expect(manager.getSession(created.id)).toBeUndefined();
		});

		test("running sessions are not cleaned up", async () => {
			manager = createManager({
				ttlMs: 50,
				cleanupIntervalMs: 25,
			});

			const created = await manager.createSession("/tmp");

			// Wait for cleanup to run
			await new Promise((resolve) => setTimeout(resolve, 150));

			// Running session should still exist
			expect(manager.getSession(created.id)).toBeDefined();
			expect(manager.getSession(created.id)?.state).toBe("running");
		});
	});

	describe("stopAll", () => {
		test("stops all running sessions", async () => {
			manager = createManager();
			const s1 = await manager.createSession("/tmp");
			const s2 = await manager.createSession("/tmp");

			manager.stopAll();

			expect(manager.getSession(s1.id)?.state).toBe("stopped");
			expect(manager.getSession(s2.id)?.state).toBe("stopped");
		});
	});

	describe("dispose", () => {
		test("stops all sessions and clears cleanup timer", async () => {
			manager = createManager();
			const created = await manager.createSession("/tmp");

			manager.dispose();

			expect(manager.getSession(created.id)?.state).toBe("stopped");
		});
	});

	describe("adapter spawn failure", () => {
		test("createSession rejects when adapter spawn fails", async () => {
			const failingFactory = (): AgentAdapter => ({
				spawn: async () => {
					throw new Error("Spawn failed");
				},
				send: () => {},
				onMessage: () => {},
				onExit: () => {},
				stop: () => {},
			});

			manager = createManager({ adapterFactory: failingFactory });

			await expect(manager.createSession("/tmp")).rejects.toThrow(
				"Spawn failed",
			);
		});
	});

	describe("adapter exit callback", () => {
		test("session transitions to stopped when adapter exits", async () => {
			let exitCallback: ((code: number, error?: string) => void) | undefined;

			const customAdapter: AgentAdapter = {
				spawn: async () => {},
				send: () => {},
				onMessage: () => {},
				onExit: (cb) => {
					exitCallback = cb;
				},
				stop: () => {},
			};

			manager = new SessionManager({
				adapterFactory: () => customAdapter,
				ttlMs: 60_000,
				cleanupIntervalMs: 60_000,
			});

			const created = await manager.createSession("/tmp");
			expect(manager.getSession(created.id)?.state).toBe("running");

			// Simulate adapter exit
			exitCallback?.(1, "Process crashed");

			expect(manager.getSession(created.id)?.state).toBe("stopped");

			// Error message should be buffered
			const buffer = manager.getBuffer(created.id) ?? [];
			const errorMsg = buffer.find(
				(m) => m.type === "session_event" && m.event === "error",
			);
			expect(errorMsg).toBeDefined();
		});
	});
});
