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

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

export function useAgentSession(sessionId: string) {
	const [messages, setMessages] = useState<ServerMessage[]>([]);
	const [status, setStatus] = useState<SessionStatus>("connecting");
	const [errorMessage, setErrorMessage] = useState<string | undefined>();

	const wsRef = useRef<WebSocket | null>(null);
	const backoffRef = useRef(INITIAL_BACKOFF_MS);
	const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const mountedRef = useRef(true);

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

	useEffect(() => {
		mountedRef.current = true;
		connectWebSocket(sessionId);

		return () => {
			mountedRef.current = false;
			clearReconnectTimer();
			closeWebSocket();
		};
	}, [sessionId, connectWebSocket, clearReconnectTimer, closeWebSocket]);

	return { messages, send, status, errorMessage };
}
