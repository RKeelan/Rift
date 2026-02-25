import { useCallback, useEffect, useRef, useState } from "react";
import type {
	ClientMessage,
	ServerMessage,
	SessionEventMessage,
	UserMessageRecord,
} from "shared";
import { apiUrl } from "../apiUrl.ts";

export type SessionStatus =
	| "connecting"
	| "connected"
	| "disconnected"
	| "error"
	| "stopped";

interface SessionInfo {
	id: string;
	state: "running" | "stopped";
	createdAt: string;
}

const STORAGE_KEY = "rift:sessionId";
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

export function useAgentSession() {
	const [messages, setMessages] = useState<ServerMessage[]>([]);
	const [status, setStatus] = useState<SessionStatus>("connecting");
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | undefined>();

	const wsRef = useRef<WebSocket | null>(null);
	const backoffRef = useRef(INITIAL_BACKOFF_MS);
	const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const mountedRef = useRef(true);
	const initializingRef = useRef(false);

	const clearReconnectTimer = useCallback(() => {
		if (reconnectTimerRef.current !== null) {
			clearTimeout(reconnectTimerRef.current);
			reconnectTimerRef.current = null;
		}
	}, []);

	const closeWebSocket = useCallback(() => {
		if (wsRef.current) {
			wsRef.current.onopen = null;
			wsRef.current.onmessage = null;
			wsRef.current.onclose = null;
			wsRef.current.onerror = null;
			wsRef.current.close();
			wsRef.current = null;
		}
	}, []);

	const connectWebSocket = useCallback(
		(id: string) => {
			if (!mountedRef.current) return;

			closeWebSocket();

			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			const ws = new WebSocket(
				`${protocol}//${window.location.host}${apiUrl(`/api/sessions/${id}/ws`)}`,
			);
			wsRef.current = ws;
			setStatus("connecting");

			ws.onopen = () => {
				if (!mountedRef.current) return;
				backoffRef.current = INITIAL_BACKOFF_MS;
				setStatus("connected");
			};

			ws.onmessage = (event) => {
				if (!mountedRef.current) return;
				try {
					const msg = JSON.parse(event.data) as ServerMessage;
					if (msg.type === "history") {
						setMessages(msg.messages);
					} else if (msg.type === "session_event") {
						const sessionEvent = msg as SessionEventMessage;
						if (sessionEvent.event === "stopped") {
							setStatus("stopped");
						} else if (sessionEvent.event === "error") {
							setStatus("error");
							setErrorMessage(sessionEvent.message);
							setMessages((prev) => [...prev, msg]);
						}
					} else {
						setMessages((prev) => [...prev, msg]);
					}
				} catch {
					// Ignore malformed messages
				}
			};

			ws.onclose = (event) => {
				if (!mountedRef.current) return;
				wsRef.current = null;

				// Code 4410: session stopped by server — don't reconnect
				if (event.code === 4410) {
					setStatus("stopped");
					return;
				}

				setStatus("disconnected");
				const delay = backoffRef.current;
				backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
				reconnectTimerRef.current = setTimeout(() => {
					if (mountedRef.current) {
						connectWebSocket(id);
					}
				}, delay);
			};

			ws.onerror = () => {
				// onclose fires after onerror; let onclose handle reconnect
			};
		},
		[closeWebSocket],
	);

	const initSession = useCallback(async () => {
		if (initializingRef.current) return;
		initializingRef.current = true;

		try {
			const storedId = localStorage.getItem(STORAGE_KEY);

			if (storedId) {
				// Check if the stored session is still running
				const response = await fetch(apiUrl(`/api/sessions/${storedId}`));
				if (response.ok) {
					const session = (await response.json()) as SessionInfo;
					if (session.state === "running") {
						setSessionId(storedId);
						connectWebSocket(storedId);
						return;
					}
				}
				// Session gone or stopped — clear and create new
				localStorage.removeItem(STORAGE_KEY);
			}

			// Create a new session
			const response = await fetch(apiUrl("/api/sessions"), { method: "POST" });
			if (!response.ok) {
				setStatus("error");
				setErrorMessage("Failed to create session");
				return;
			}

			const session = (await response.json()) as SessionInfo;
			localStorage.setItem(STORAGE_KEY, session.id);
			setSessionId(session.id);
			connectWebSocket(session.id);
		} catch {
			if (mountedRef.current) {
				setStatus("error");
				setErrorMessage("Failed to connect to server");
			}
		} finally {
			initializingRef.current = false;
		}
	}, [connectWebSocket]);

	const send = useCallback((content: string) => {
		if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
			return;
		}
		// Add user message to local state immediately for display
		const record: UserMessageRecord = {
			type: "user_message_record",
			content,
		};
		setMessages((prev) => [...prev, record]);
		const msg: ClientMessage = { type: "user_message", content };
		wsRef.current.send(JSON.stringify(msg));
	}, []);

	const newSession = useCallback(async () => {
		clearReconnectTimer();
		closeWebSocket();

		// Stop the current session if we have one
		const currentId = localStorage.getItem(STORAGE_KEY);
		if (currentId) {
			try {
				await fetch(apiUrl(`/api/sessions/${currentId}`), { method: "DELETE" });
			} catch {
				// Best effort
			}
		}

		localStorage.removeItem(STORAGE_KEY);
		setSessionId(null);
		setMessages([]);
		setStatus("connecting");
		setErrorMessage(undefined);

		// Create a fresh session
		try {
			const response = await fetch(apiUrl("/api/sessions"), { method: "POST" });
			if (!response.ok) {
				setStatus("error");
				setErrorMessage("Failed to create session");
				return;
			}

			const session = (await response.json()) as SessionInfo;
			localStorage.setItem(STORAGE_KEY, session.id);
			setSessionId(session.id);
			connectWebSocket(session.id);
		} catch {
			setStatus("error");
			setErrorMessage("Failed to connect to server");
		}
	}, [clearReconnectTimer, closeWebSocket, connectWebSocket]);

	useEffect(() => {
		mountedRef.current = true;
		initSession();

		return () => {
			mountedRef.current = false;
			clearReconnectTimer();
			closeWebSocket();
		};
	}, [initSession, clearReconnectTimer, closeWebSocket]);

	return { messages, send, status, sessionId, newSession, errorMessage };
}
