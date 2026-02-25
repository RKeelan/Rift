import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { HistoryMessage, ServerMessage } from "shared";
import WebSocket from "ws";
import type { AgentAdapter } from "../adapters/adapter.js";
import { EchoAdapter } from "../adapters/echo.js";
import { type AppConfig, createApp } from "../app.js";
import { SessionManager } from "../session.js";
import { setupWebSocket } from "../ws.js";
import type { WebSocketRelay } from "../ws.js";

// --- Helpers ---

function makeConfig(): AppConfig {
	return {
		port: 0,
		agentCommand: "echo",
		workingDir: process.cwd(),
		basePath: "",
	};
}

function makeManager(adapterFactory?: () => AgentAdapter): SessionManager {
	return new SessionManager({
		adapterFactory: adapterFactory ?? (() => new EchoAdapter()),
		ttlMs: 60_000,
		cleanupIntervalMs: 60_000,
	});
}

interface TestContext {
	server: Server;
	relay: WebSocketRelay;
	manager: SessionManager;
	baseUrl: string;
	wsBaseUrl: string;
}

function startServer(
	adapterFactory?: () => AgentAdapter,
): Promise<TestContext> {
	return new Promise((resolve) => {
		const manager = makeManager(adapterFactory);
		const app = createApp(makeConfig(), manager);
		const server = app.listen(0, "127.0.0.1", () => {
			const relay = setupWebSocket(server, manager);
			const addr = server.address() as AddressInfo;
			const baseUrl = `http://127.0.0.1:${addr.port}`;
			const wsBaseUrl = `ws://127.0.0.1:${addr.port}`;
			resolve({ server, relay, manager, baseUrl, wsBaseUrl });
		});
	});
}

function teardownServer(ctx: TestContext): void {
	for (const client of ctx.relay.wss.clients) {
		client.terminate();
	}
	ctx.manager.dispose();
	ctx.server.closeAllConnections();
	ctx.server.close();
}

async function createSession(baseUrl: string): Promise<string> {
	const res = await fetch(`${baseUrl}/api/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ workingDirectory: "/tmp" }),
	});
	const body = (await res.json()) as { id: string };
	return body.id;
}

function connectWs(wsBaseUrl: string, sessionId: string): WebSocket {
	return new WebSocket(`${wsBaseUrl}/api/sessions/${sessionId}/ws`);
}

/**
 * Collect `count` messages from a WebSocket.
 * Resolves once `count` messages have arrived.
 */
function collectMessages(
	ws: WebSocket,
	count: number,
	timeoutMs = 5000,
): Promise<ServerMessage[]> {
	return new Promise((resolve, reject) => {
		const messages: ServerMessage[] = [];
		const timer = setTimeout(() => {
			cleanup();
			reject(
				new Error(
					`Timed out waiting for ${count} messages, got ${messages.length}`,
				),
			);
		}, timeoutMs);

		function onMessage(data: WebSocket.Data) {
			messages.push(JSON.parse(data.toString()));
			if (messages.length >= count) {
				cleanup();
				resolve(messages);
			}
		}

		function onError(err: Error) {
			cleanup();
			reject(err);
		}

		function cleanup() {
			clearTimeout(timer);
			ws.removeListener("message", onMessage);
			ws.removeListener("error", onError);
		}

		ws.on("message", onMessage);
		ws.on("error", onError);
	});
}

function waitForOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
	return new Promise((resolve, reject) => {
		if (ws.readyState === WebSocket.OPEN) {
			resolve();
			return;
		}
		const timer = setTimeout(
			() => reject(new Error("Timed out waiting for open")),
			timeoutMs,
		);
		ws.once("open", () => {
			clearTimeout(timer);
			resolve();
		});
		ws.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/**
 * Wait for a WebSocket to close.
 * Handles the case where the server destroys the raw socket (which
 * fires an error event before close on the client side).
 */
function waitForClose(
	ws: WebSocket,
	timeoutMs = 5000,
): Promise<{ code: number; reason: string }> {
	return new Promise((resolve, reject) => {
		if (ws.readyState === WebSocket.CLOSED) {
			resolve({ code: 0, reason: "" });
			return;
		}
		const timer = setTimeout(
			() => reject(new Error("Timed out waiting for close")),
			timeoutMs,
		);

		// Swallow error events -- we only care about the close code
		ws.on("error", () => {});

		ws.once("close", (code, reason) => {
			clearTimeout(timer);
			resolve({ code, reason: reason.toString() });
		});
	});
}

function sendUserMessage(ws: WebSocket, content: string): void {
	ws.send(JSON.stringify({ type: "user_message", content }));
}

// --- Tests ---

describe("WebSocket relay", () => {
	let ctx: TestContext;
	const openSockets: WebSocket[] = [];

	beforeEach(async () => {
		ctx = await startServer();
	});

	afterEach(() => {
		for (const ws of openSockets) {
			if (
				ws.readyState === WebSocket.OPEN ||
				ws.readyState === WebSocket.CONNECTING
			) {
				ws.terminate();
			}
		}
		openSockets.length = 0;
		teardownServer(ctx);
	});

	function track(ws: WebSocket): WebSocket {
		openSockets.push(ws);
		return ws;
	}

	// -----------------------------------------------------------
	// History message on connect
	// -----------------------------------------------------------

	describe("history on connect", () => {
		test("sends empty history for a fresh session", async () => {
			const sessionId = await createSession(ctx.baseUrl);
			const ws = track(connectWs(ctx.wsBaseUrl, sessionId));
			await waitForOpen(ws);

			const msgs = await collectMessages(ws, 1);
			expect(msgs[0].type).toBe("history");
			const history = msgs[0] as HistoryMessage;
			expect(history.messages).toEqual([]);
		});

		test("sends buffered messages as history on reconnect", async () => {
			const sessionId = await createSession(ctx.baseUrl);

			// Connect, receive empty history, send a message, receive echo
			const ws1 = track(connectWs(ctx.wsBaseUrl, sessionId));
			await waitForOpen(ws1);

			// 1 history message
			const historyMsgs = await collectMessages(ws1, 1);
			expect(historyMsgs[0].type).toBe("history");

			// Send and receive 3 echo responses
			sendUserMessage(ws1, "hello");
			const echoMsgs = await collectMessages(ws1, 3);
			expect(echoMsgs[0].type).toBe("assistant_text");

			// Disconnect
			ws1.close();
			await waitForClose(ws1);

			// Reconnect -- history should replay the user message + 3 echo responses
			const ws2 = track(connectWs(ctx.wsBaseUrl, sessionId));
			await waitForOpen(ws2);
			const reconnectMsgs = await collectMessages(ws2, 1);
			const history = reconnectMsgs[0] as HistoryMessage;
			expect(history.type).toBe("history");
			expect(history.messages).toHaveLength(4);
			expect(history.messages[0].type).toBe("user_message_record");
			expect(history.messages[1].type).toBe("assistant_text");
			expect(history.messages[2].type).toBe("tool_use");
			expect(history.messages[3].type).toBe("tool_result");
		});
	});

	// -----------------------------------------------------------
	// Message relay
	// -----------------------------------------------------------

	describe("message relay", () => {
		test("send user_message and receive assistant_text, tool_use, tool_result in order", async () => {
			const sessionId = await createSession(ctx.baseUrl);
			const ws = track(connectWs(ctx.wsBaseUrl, sessionId));
			await waitForOpen(ws);
			await collectMessages(ws, 1); // history

			sendUserMessage(ws, "hello");
			const msgs = await collectMessages(ws, 3);

			expect(msgs[0].type).toBe("assistant_text");
			expect(msgs[1].type).toBe("tool_use");
			expect(msgs[2].type).toBe("tool_result");

			if (msgs[0].type === "assistant_text") {
				expect(msgs[0].content).toBe("Echo: hello");
			}
		});

		test("invalid JSON is silently ignored", async () => {
			const sessionId = await createSession(ctx.baseUrl);
			const ws = track(connectWs(ctx.wsBaseUrl, sessionId));
			await waitForOpen(ws);
			await collectMessages(ws, 1); // history

			ws.send("not json");

			// Connection should still work
			sendUserMessage(ws, "after-garbage");
			const msgs = await collectMessages(ws, 3);
			expect(msgs[0].type).toBe("assistant_text");
		});

		test("message with wrong type field is ignored", async () => {
			const sessionId = await createSession(ctx.baseUrl);
			const ws = track(connectWs(ctx.wsBaseUrl, sessionId));
			await waitForOpen(ws);
			await collectMessages(ws, 1); // history

			ws.send(JSON.stringify({ type: "wrong_type", content: "test" }));

			sendUserMessage(ws, "after-wrong-type");
			const msgs = await collectMessages(ws, 3);
			expect(msgs[0].type).toBe("assistant_text");
		});
	});

	// -----------------------------------------------------------
	// Multiple clients
	// -----------------------------------------------------------

	describe("multiple clients", () => {
		test("all connected clients receive adapter messages", async () => {
			const sessionId = await createSession(ctx.baseUrl);

			// Connect first client and consume history
			const ws1 = track(connectWs(ctx.wsBaseUrl, sessionId));
			await waitForOpen(ws1);
			await collectMessages(ws1, 1); // history

			// Connect second client and consume history
			const ws2 = track(connectWs(ctx.wsBaseUrl, sessionId));
			await waitForOpen(ws2);
			await collectMessages(ws2, 1); // history

			// Set up collectors before sending
			const collector1 = collectMessages(ws1, 3);
			const collector2 = collectMessages(ws2, 3);

			sendUserMessage(ws1, "broadcast-test");

			const [msgs1, msgs2] = await Promise.all([collector1, collector2]);
			expect(msgs1).toHaveLength(3);
			expect(msgs2).toHaveLength(3);
			expect(msgs1[0].type).toBe("assistant_text");
			expect(msgs2[0].type).toBe("assistant_text");
		});
	});

	// -----------------------------------------------------------
	// Invalid session
	// -----------------------------------------------------------

	describe("invalid session", () => {
		test("connecting to non-existent session closes with 4404", async () => {
			const ws = track(connectWs(ctx.wsBaseUrl, "nonexistent-id"));
			const { code, reason } = await waitForClose(ws);
			expect(code).toBe(4404);
			const parsed = JSON.parse(reason);
			expect(parsed.error.code).toBe("NOT_FOUND");
		});
	});

	// -----------------------------------------------------------
	// Stopped session
	// -----------------------------------------------------------

	describe("stopped session", () => {
		test("connecting to a stopped session closes with 4410", async () => {
			const sessionId = await createSession(ctx.baseUrl);

			// Stop the session via REST
			await fetch(`${ctx.baseUrl}/api/sessions/${sessionId}`, {
				method: "DELETE",
			});

			const ws = track(connectWs(ctx.wsBaseUrl, sessionId));
			const { code, reason } = await waitForClose(ws);
			expect(code).toBe(4410);
			const parsed = JSON.parse(reason);
			expect(parsed.error.code).toBe("SESSION_STOPPED");
		});

		test("session stop while connected sends stopped event then closes with 4410", async () => {
			const sessionId = await createSession(ctx.baseUrl);
			const ws = track(connectWs(ctx.wsBaseUrl, sessionId));
			await waitForOpen(ws);
			await collectMessages(ws, 1); // history

			// Collect the stopped session_event and track the close
			const stoppedPromise = new Promise<ServerMessage>((resolve) => {
				ws.on("message", (data) => {
					const msg = JSON.parse(data.toString()) as ServerMessage;
					if (msg.type === "session_event") {
						resolve(msg);
					}
				});
			});
			const closePromise = waitForClose(ws);

			// Stop session via REST
			await fetch(`${ctx.baseUrl}/api/sessions/${sessionId}`, {
				method: "DELETE",
			});

			const stoppedMsg = await stoppedPromise;
			expect(stoppedMsg.type).toBe("session_event");
			if (stoppedMsg.type === "session_event") {
				expect(stoppedMsg.event).toBe("stopped");
			}

			const { code } = await closePromise;
			expect(code).toBe(4410);
		});
	});

	// -----------------------------------------------------------
	// Adapter error
	// -----------------------------------------------------------

	describe("adapter error", () => {
		test("adapter crash sends session_event error to connected clients", async () => {
			let exitCallback: ((code: number, error?: string) => void) | undefined;

			const crashableAdapter: AgentAdapter = {
				spawn: async () => {},
				send: () => {},
				onMessage: () => {},
				onExit: (cb) => {
					exitCallback = cb;
				},
				stop: () => {},
			};

			// Restart with a custom adapter
			teardownServer(ctx);
			ctx = await startServer(() => crashableAdapter);

			const sessionId = await createSession(ctx.baseUrl);
			const ws = track(connectWs(ctx.wsBaseUrl, sessionId));
			await waitForOpen(ws);
			await collectMessages(ws, 1); // history

			// Collect error + stopped messages (2 total)
			const msgPromise = collectMessages(ws, 2);

			// Simulate adapter crash
			exitCallback?.(1, "Adapter crashed unexpectedly");

			const msgs = await msgPromise;
			expect(msgs[0].type).toBe("session_event");
			if (msgs[0].type === "session_event") {
				expect(msgs[0].event).toBe("error");
				expect(msgs[0].message).toBe("Adapter crashed unexpectedly");
			}
			expect(msgs[1].type).toBe("session_event");
			if (msgs[1].type === "session_event") {
				expect(msgs[1].event).toBe("stopped");
			}

			const { code } = await waitForClose(ws);
			expect(code).toBe(4410);
		});
	});

	// -----------------------------------------------------------
	// Oversized messages
	// -----------------------------------------------------------

	describe("oversized messages", () => {
		test("message exceeding 1MB closes the connection with 1009", async () => {
			const sessionId = await createSession(ctx.baseUrl);
			const ws = track(connectWs(ctx.wsBaseUrl, sessionId));
			await waitForOpen(ws);
			await collectMessages(ws, 1); // history

			const closePromise = waitForClose(ws);

			// Send a message just over 1 MB
			const oversized = "x".repeat(1024 * 1024 + 1);
			ws.send(oversized);

			const { code } = await closePromise;
			expect(code).toBe(1009);
		});
	});

	// -----------------------------------------------------------
	// Client disconnect
	// -----------------------------------------------------------

	describe("client disconnect", () => {
		test("closing the WebSocket does not stop the session", async () => {
			const sessionId = await createSession(ctx.baseUrl);
			const ws = track(connectWs(ctx.wsBaseUrl, sessionId));
			await waitForOpen(ws);
			await collectMessages(ws, 1); // history

			ws.close();
			await waitForClose(ws);

			// Session should still be running
			const res = await fetch(`${ctx.baseUrl}/api/sessions/${sessionId}`);
			const body = (await res.json()) as { state: string };
			expect(body.state).toBe("running");
		});
	});

	// -----------------------------------------------------------
	// Path matching
	// -----------------------------------------------------------

	describe("path matching", () => {
		test("WebSocket to non-session path is rejected", async () => {
			const ws = track(
				new WebSocket(`${ctx.wsBaseUrl}/api/not-a-session-path`),
			);
			const { code } = await waitForClose(ws);
			// Socket is destroyed -- client sees 1006 (abnormal closure)
			expect(code).toBe(1006);
		});
	});
});
