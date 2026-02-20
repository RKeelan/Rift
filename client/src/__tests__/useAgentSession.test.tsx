import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ServerMessage } from "shared";
import { useAgentSession } from "../hooks/useAgentSession.ts";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type WSEventHandler = ((event: Record<string, unknown>) => void) | null;

class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	static instances: MockWebSocket[] = [];

	url: string;
	readyState = MockWebSocket.CONNECTING;
	onopen: WSEventHandler = null;
	onmessage: WSEventHandler = null;
	onclose: WSEventHandler = null;
	onerror: WSEventHandler = null;
	sentMessages: string[] = [];

	constructor(url: string) {
		this.url = url;
		MockWebSocket.instances.push(this);
	}

	send(data: string) {
		this.sentMessages.push(data);
	}

	close() {
		this.readyState = MockWebSocket.CLOSED;
	}

	// --- Test helpers ---

	simulateOpen() {
		this.readyState = MockWebSocket.OPEN;
		this.onopen?.({});
	}

	simulateMessage(data: ServerMessage) {
		this.onmessage?.({ data: JSON.stringify(data) });
	}

	simulateClose(code = 1000) {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.({ code });
	}
}

// ---------------------------------------------------------------------------
// Globals saved / restored
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const originalLocalStorage = globalThis.localStorage;
const originalSetTimeout = globalThis.setTimeout;

// Minimal localStorage mock
function makeStorage(): Storage {
	let store: Record<string, string> = {};
	return {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => {
			store[key] = value;
		},
		removeItem: (key: string) => {
			delete store[key];
		},
		clear: () => {
			store = {};
		},
		get length() {
			return Object.keys(store).length;
		},
		key: (index: number) => Object.keys(store)[index] ?? null,
	};
}

// ---------------------------------------------------------------------------
// Test harness component
// ---------------------------------------------------------------------------

function HarnessInner({
	onHook,
}: { onHook: (hook: ReturnType<typeof useAgentSession>) => void }) {
	const hook = useAgentSession();
	onHook(hook);
	return (
		<div>
			<span data-testid="status">{hook.status}</span>
			<span data-testid="sessionId">{hook.sessionId ?? "null"}</span>
			<span data-testid="messages">{JSON.stringify(hook.messages)}</span>
			<span data-testid="errorMessage">{hook.errorMessage ?? ""}</span>
		</div>
	);
}

/**
 * Renders the hook in a harness and returns helpers to inspect / interact.
 * `hookRef.current` always holds the latest return value from the hook.
 */
function renderHook() {
	const hookRef: { current: ReturnType<typeof useAgentSession> | null } = {
		current: null,
	};

	const onHook = (h: ReturnType<typeof useAgentSession>) => {
		hookRef.current = h;
	};

	render(<HarnessInner onHook={onHook} />);

	return { hookRef };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a mock fetch that resolves with the given responses in sequence. */
function mockFetchResponses(
	...responses: Array<{ status: number; body?: unknown }>
) {
	let callIndex = 0;
	const fn = mock(() => {
		const r = responses[callIndex] ?? responses[responses.length - 1];
		callIndex++;
		return Promise.resolve(
			new Response(r.body !== undefined ? JSON.stringify(r.body) : null, {
				status: r.status,
				headers:
					r.body !== undefined ? { "Content-Type": "application/json" } : {},
			}),
		);
	});
	globalThis.fetch = fn as typeof fetch;
	return fn;
}

function latestWs(): MockWebSocket {
	return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
	MockWebSocket.instances = [];
	(globalThis as Record<string, unknown>).WebSocket = MockWebSocket;
	// Use our mock localStorage — happy-dom may provide one but we want full control
	Object.defineProperty(globalThis, "localStorage", {
		value: makeStorage(),
		writable: true,
		configurable: true,
	});
});

afterEach(() => {
	cleanup();
	globalThis.fetch = originalFetch;
	(globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
	globalThis.setTimeout = originalSetTimeout;
	Object.defineProperty(globalThis, "localStorage", {
		value: originalLocalStorage,
		writable: true,
		configurable: true,
	});
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useAgentSession", () => {
	// 1. Session creation flow (no localStorage -> POST -> connect)
	test("creates a new session when localStorage is empty", async () => {
		const fetchMock = mockFetchResponses({
			status: 201,
			body: { id: "session-1", state: "running", createdAt: "2025-01-01" },
		});

		await act(async () => {
			renderHook();
		});

		// Should have called POST /api/sessions
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, opts] = (fetchMock as ReturnType<typeof mock>).mock
			.calls[0] as [string, RequestInit | undefined];
		expect(url).toBe("/api/sessions");
		expect(opts?.method).toBe("POST");

		// Should have stored the id
		expect(localStorage.getItem("rift:sessionId")).toBe("session-1");

		// Should have created a WebSocket
		expect(MockWebSocket.instances).toHaveLength(1);
		expect(latestWs().url).toContain("/api/sessions/session-1/ws");

		// Simulate WS open
		await act(async () => {
			latestWs().simulateOpen();
		});

		expect(screen.getByTestId("status").textContent).toBe("connected");
		expect(screen.getByTestId("sessionId").textContent).toBe("session-1");
	});

	// 2. Reconnection flow (localStorage has id -> GET -> connect)
	test("reconnects to existing session from localStorage", async () => {
		localStorage.setItem("rift:sessionId", "existing-42");

		const fetchMock = mockFetchResponses({
			status: 200,
			body: { id: "existing-42", state: "running", createdAt: "2025-01-01" },
		});

		await act(async () => {
			renderHook();
		});

		// Should have called GET /api/sessions/existing-42
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url] = (fetchMock as ReturnType<typeof mock>).mock.calls[0] as [
			string,
		];
		expect(url).toBe("/api/sessions/existing-42");

		// WebSocket created for the existing session
		expect(MockWebSocket.instances).toHaveLength(1);
		expect(latestWs().url).toContain("/api/sessions/existing-42/ws");

		await act(async () => {
			latestWs().simulateOpen();
		});

		expect(screen.getByTestId("status").textContent).toBe("connected");
		expect(screen.getByTestId("sessionId").textContent).toBe("existing-42");
	});

	// 2b. Stored session is 404 -> create new
	test("creates new session when stored session returns 404", async () => {
		localStorage.setItem("rift:sessionId", "gone-session");

		const fetchMock = mockFetchResponses(
			// GET /api/sessions/gone-session -> 404
			{ status: 404 },
			// POST /api/sessions -> new session
			{
				status: 201,
				body: {
					id: "new-session",
					state: "running",
					createdAt: "2025-01-01",
				},
			},
		);

		await act(async () => {
			renderHook();
		});

		// First call: GET, second call: POST
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [url1] = (fetchMock as ReturnType<typeof mock>).mock.calls[0] as [
			string,
		];
		expect(url1).toBe("/api/sessions/gone-session");
		const [url2, opts2] = (fetchMock as ReturnType<typeof mock>).mock
			.calls[1] as [string, RequestInit | undefined];
		expect(url2).toBe("/api/sessions");
		expect(opts2?.method).toBe("POST");

		// localStorage updated
		expect(localStorage.getItem("rift:sessionId")).toBe("new-session");

		// WebSocket created for the new session
		expect(latestWs().url).toContain("/api/sessions/new-session/ws");
	});

	// 3. Reconnect with backoff on disconnect (mock timers)
	test("reconnects with exponential backoff on close", async () => {
		mockFetchResponses({
			status: 201,
			body: { id: "s1", state: "running", createdAt: "2025-01-01" },
		});

		// Capture scheduled timers so we can fire them synchronously
		const pendingTimers: Array<{ cb: () => void; delay: number }> = [];
		globalThis.setTimeout = ((cb: () => void, delay: number) => {
			pendingTimers.push({ cb, delay });
			return pendingTimers.length as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;

		await act(async () => {
			renderHook();
		});

		const ws1 = latestWs();
		await act(async () => {
			ws1.simulateOpen();
		});

		expect(screen.getByTestId("status").textContent).toBe("connected");

		// Close with a normal code (not 4410)
		await act(async () => {
			ws1.simulateClose(1006);
		});

		expect(screen.getByTestId("status").textContent).toBe("disconnected");

		// First backoff should be 1000ms
		expect(pendingTimers).toHaveLength(1);
		expect(pendingTimers[0].delay).toBe(1000);

		// Fire the reconnect timer
		await act(async () => {
			pendingTimers[0].cb();
		});

		// A second WebSocket instance should have been created
		expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
		const ws2 = latestWs();
		expect(ws2.url).toContain("/api/sessions/s1/ws");

		// Close again without opening (consecutive failure) -> backoff doubles to 2000ms
		await act(async () => {
			ws2.simulateClose(1006);
		});

		expect(pendingTimers).toHaveLength(2);
		expect(pendingTimers[1].delay).toBe(2000);

		// Fire second reconnect timer
		await act(async () => {
			pendingTimers[1].cb();
		});

		expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(3);
	});

	// 3b. No reconnect on code 4410 (session stopped)
	test("does not reconnect on close code 4410", async () => {
		mockFetchResponses({
			status: 201,
			body: { id: "s1", state: "running", createdAt: "2025-01-01" },
		});

		const pendingTimers: Array<{ cb: () => void; delay: number }> = [];
		globalThis.setTimeout = ((cb: () => void, delay: number) => {
			pendingTimers.push({ cb, delay });
			return pendingTimers.length as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;

		await act(async () => {
			renderHook();
		});

		const ws1 = latestWs();
		await act(async () => {
			ws1.simulateOpen();
		});

		await act(async () => {
			ws1.simulateClose(4410);
		});

		expect(screen.getByTestId("status").textContent).toBe("stopped");

		// No reconnect timer should have been scheduled
		expect(pendingTimers).toHaveLength(0);

		// Should still only have 1 WebSocket (no reconnect)
		expect(MockWebSocket.instances).toHaveLength(1);
	});

	// 4. history message replaces message state
	test("history message replaces messages", async () => {
		mockFetchResponses({
			status: 201,
			body: { id: "s1", state: "running", createdAt: "2025-01-01" },
		});

		await act(async () => {
			renderHook();
		});

		const ws = latestWs();
		await act(async () => {
			ws.simulateOpen();
		});

		// Send some regular messages first
		await act(async () => {
			ws.simulateMessage({
				type: "assistant_text",
				content: "hello",
			});
		});

		await act(async () => {
			ws.simulateMessage({
				type: "assistant_text",
				content: "world",
			});
		});

		// Messages should have accumulated
		let msgs = JSON.parse(
			screen.getByTestId("messages").textContent ?? "[]",
		) as ServerMessage[];
		expect(msgs).toHaveLength(2);

		// Now send a history message
		const historyMessages: ServerMessage[] = [
			{ type: "assistant_text", content: "replayed-1" },
			{ type: "assistant_text", content: "replayed-2" },
			{ type: "assistant_text", content: "replayed-3" },
		];

		await act(async () => {
			ws.simulateMessage({
				type: "history",
				messages: historyMessages,
			});
		});

		// Messages should be replaced, not appended
		msgs = JSON.parse(
			screen.getByTestId("messages").textContent ?? "[]",
		) as ServerMessage[];
		expect(msgs).toHaveLength(3);
		expect(msgs[0]).toEqual({ type: "assistant_text", content: "replayed-1" });
		expect(msgs[1]).toEqual({ type: "assistant_text", content: "replayed-2" });
		expect(msgs[2]).toEqual({ type: "assistant_text", content: "replayed-3" });
	});

	// 5. send() serialises a ClientMessage and sends over WebSocket
	test("send() serialises a ClientMessage and sends over WebSocket", async () => {
		mockFetchResponses({
			status: 201,
			body: { id: "s1", state: "running", createdAt: "2025-01-01" },
		});

		const { hookRef } = await act(async () => {
			return renderHook();
		});

		const ws = latestWs();
		await act(async () => {
			ws.simulateOpen();
		});

		// Send a message
		act(() => {
			hookRef.current?.send("Hello agent");
		});

		expect(ws.sentMessages).toHaveLength(1);
		const parsed = JSON.parse(ws.sentMessages[0]);
		expect(parsed).toEqual({ type: "user_message", content: "Hello agent" });
	});

	// 5b. send() does nothing when WebSocket is not open
	test("send() does nothing when WebSocket is not open", async () => {
		mockFetchResponses({
			status: 201,
			body: { id: "s1", state: "running", createdAt: "2025-01-01" },
		});

		const { hookRef } = await act(async () => {
			return renderHook();
		});

		const ws = latestWs();
		// Don't open the WebSocket

		act(() => {
			hookRef.current?.send("ignored message");
		});

		expect(ws.sentMessages).toHaveLength(0);
	});

	// 6. newSession() stops old session, clears storage, creates new one
	test("newSession() stops old session, clears storage, creates new one", async () => {
		// Initial session creation
		const fetchMock = mockFetchResponses(
			// POST for initial session
			{
				status: 201,
				body: {
					id: "old-session",
					state: "running",
					createdAt: "2025-01-01",
				},
			},
			// DELETE for old session
			{ status: 200 },
			// POST for new session
			{
				status: 201,
				body: {
					id: "fresh-session",
					state: "running",
					createdAt: "2025-01-02",
				},
			},
		);

		const { hookRef } = await act(async () => {
			return renderHook();
		});

		const ws1 = latestWs();
		await act(async () => {
			ws1.simulateOpen();
		});

		expect(screen.getByTestId("sessionId").textContent).toBe("old-session");

		// Call newSession
		await act(async () => {
			await hookRef.current?.newSession();
		});

		// Should have called DELETE on old session and POST for new session
		expect(fetchMock).toHaveBeenCalledTimes(3);

		const [url2, opts2] = (fetchMock as ReturnType<typeof mock>).mock
			.calls[1] as [string, RequestInit | undefined];
		expect(url2).toBe("/api/sessions/old-session");
		expect(opts2?.method).toBe("DELETE");

		const [url3, opts3] = (fetchMock as ReturnType<typeof mock>).mock
			.calls[2] as [string, RequestInit | undefined];
		expect(url3).toBe("/api/sessions");
		expect(opts3?.method).toBe("POST");

		// localStorage should have the new session id
		expect(localStorage.getItem("rift:sessionId")).toBe("fresh-session");

		// Old WebSocket should have been closed
		expect(ws1.readyState).toBe(MockWebSocket.CLOSED);

		// New WebSocket should be created
		const ws2 = latestWs();
		expect(ws2.url).toContain("/api/sessions/fresh-session/ws");

		// Simulate new WS open
		await act(async () => {
			ws2.simulateOpen();
		});

		expect(screen.getByTestId("sessionId").textContent).toBe("fresh-session");
		expect(screen.getByTestId("status").textContent).toBe("connected");
	});

	// session_event with stopped sets status
	test("session_event with stopped sets status to stopped", async () => {
		mockFetchResponses({
			status: 201,
			body: { id: "s1", state: "running", createdAt: "2025-01-01" },
		});

		await act(async () => {
			renderHook();
		});

		const ws = latestWs();
		await act(async () => {
			ws.simulateOpen();
		});

		await act(async () => {
			ws.simulateMessage({
				type: "session_event",
				event: "stopped",
			});
		});

		expect(screen.getByTestId("status").textContent).toBe("stopped");
	});

	// session_event with error sets status and error message
	test("session_event with error sets status and error message", async () => {
		mockFetchResponses({
			status: 201,
			body: { id: "s1", state: "running", createdAt: "2025-01-01" },
		});

		await act(async () => {
			renderHook();
		});

		const ws = latestWs();
		await act(async () => {
			ws.simulateOpen();
		});

		await act(async () => {
			ws.simulateMessage({
				type: "session_event",
				event: "error",
				message: "Agent crashed",
			});
		});

		expect(screen.getByTestId("status").textContent).toBe("error");
		expect(screen.getByTestId("errorMessage").textContent).toBe(
			"Agent crashed",
		);
	});

	// Stored session is stopped -> create new
	test("creates new session when stored session is stopped", async () => {
		localStorage.setItem("rift:sessionId", "stopped-session");

		const fetchMock = mockFetchResponses(
			// GET returns stopped
			{
				status: 200,
				body: {
					id: "stopped-session",
					state: "stopped",
					createdAt: "2025-01-01",
				},
			},
			// POST creates new
			{
				status: 201,
				body: {
					id: "new-session",
					state: "running",
					createdAt: "2025-01-02",
				},
			},
		);

		await act(async () => {
			renderHook();
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(localStorage.getItem("rift:sessionId")).toBe("new-session");
		expect(latestWs().url).toContain("/api/sessions/new-session/ws");
	});
});
