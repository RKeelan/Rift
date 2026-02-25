import type { Server } from "node:http";
import type {
	ClientMessage,
	HistoryMessage,
	ServerMessage,
	UserMessageRecord,
} from "shared";
import { WebSocket, WebSocketServer } from "ws";
import type { SessionManager } from "./session.js";

const MAX_PAYLOAD = 1 * 1024 * 1024; // 1 MB
function sessionWsPattern(basePath: string): RegExp {
	const escaped = basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped}/api/sessions/([^/]+)/ws$`);
}

export interface WebSocketRelay {
	wss: WebSocketServer;
	close(): void;
}

export function setupWebSocket(
	server: Server,
	sessionManager: SessionManager,
	basePath = "",
): WebSocketRelay {
	const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
	const pattern = sessionWsPattern(basePath);

	// Track connected clients per session
	const sessionClients = new Map<string, Set<WebSocket>>();

	function getClients(sessionId: string): Set<WebSocket> {
		let clients = sessionClients.get(sessionId);
		if (!clients) {
			clients = new Set();
			sessionClients.set(sessionId, clients);
		}
		return clients;
	}

	function removeClient(sessionId: string, ws: WebSocket): void {
		const clients = sessionClients.get(sessionId);
		if (clients) {
			clients.delete(ws);
			if (clients.size === 0) {
				sessionClients.delete(sessionId);
			}
		}
	}

	function safeSend(ws: WebSocket, data: string): void {
		try {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(data);
			}
		} catch {
			// Socket transitioned to CLOSING between check and send
		}
	}

	function broadcast(sessionId: string, message: ServerMessage): void {
		const clients = sessionClients.get(sessionId);
		if (!clients) return;
		const data = JSON.stringify(message);
		for (const client of clients) {
			safeSend(client, data);
		}
	}

	// Handle HTTP upgrade requests
	server.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url ?? "", `http://${request.headers.host}`);
		const match = url.pathname.match(pattern);

		if (!match) {
			socket.destroy();
			return;
		}

		wss.handleUpgrade(request, socket, head, (ws) => {
			wss.emit("connection", ws, match[1]);
		});
	});

	wss.on("connection", (ws: WebSocket, sessionId: string) => {
		// Prevent unhandled error events from crashing the process
		ws.on("error", (err) => {
			console.error(`WebSocket error for session ${sessionId}:`, err.message);
		});

		const session = sessionManager.getSession(sessionId);

		if (!session) {
			ws.close(
				4404,
				JSON.stringify({
					error: { code: "NOT_FOUND", message: "Session not found" },
				}),
			);
			return;
		}

		if (session.state === "stopped") {
			ws.close(
				4410,
				JSON.stringify({
					error: {
						code: "SESSION_STOPPED",
						message: "Session has stopped",
					},
				}),
			);
			return;
		}

		// Register this client
		getClients(sessionId).add(ws);

		// Send buffered history
		const buffer = sessionManager.getBuffer(sessionId);
		const historyMsg: HistoryMessage = {
			type: "history",
			messages: buffer ? [...buffer] : [],
		};
		ws.send(JSON.stringify(historyMsg));

		// Relay incoming messages to the adapter
		ws.on("message", (data) => {
			const raw = Buffer.isBuffer(data)
				? data
				: Array.isArray(data)
					? Buffer.concat(data)
					: data;
			if (raw.byteLength > MAX_PAYLOAD) {
				ws.close(1009, "Message too large");
				return;
			}
			try {
				const parsed = JSON.parse(raw.toString()) as ClientMessage;
				if (
					parsed.type === "user_message" &&
					typeof parsed.content === "string"
				) {
					// Store user message in the buffer for history replay
					const record: UserMessageRecord = {
						type: "user_message_record",
						content: parsed.content,
					};
					sessionManager.addToBuffer(sessionId, record);
					sessionManager.send(sessionId, parsed.content);
				}
			} catch {
				// Invalid JSON — ignore
			}
		});

		// Clean up on disconnect
		ws.on("close", () => {
			removeClient(sessionId, ws);
		});
	});

	// Relay adapter messages to connected WebSocket clients
	function onMessage(sessionId: string, message: ServerMessage) {
		broadcast(sessionId, message);
	}
	sessionManager.on("message", onMessage);

	// Notify clients when a session stops, then close their sockets
	function onStopped(sessionId: string) {
		const clients = sessionClients.get(sessionId);
		if (!clients) return;

		const stoppedMsg: ServerMessage = {
			type: "session_event",
			event: "stopped",
		};
		const data = JSON.stringify(stoppedMsg);

		for (const client of clients) {
			safeSend(client, data);
			try {
				client.close(4410, "Session stopped");
			} catch {
				// Socket may have entered an error state between send and close
			}
		}
		sessionClients.delete(sessionId);
	}
	sessionManager.on("stopped", onStopped);

	function close() {
		// Remove event listeners to prevent the stopped handler from
		// racing with manual close during shutdown
		sessionManager.removeListener("message", onMessage);
		sessionManager.removeListener("stopped", onStopped);

		for (const client of wss.clients) {
			client.close(1001, "Server shutting down");
		}
		sessionClients.clear();
	}

	return { wss, close };
}
