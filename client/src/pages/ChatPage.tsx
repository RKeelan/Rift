import { RotateCcw } from "lucide-react";
import { useCallback, useState } from "react";
import { ChatInput } from "../components/ChatInput.tsx";
import { MessageList } from "../components/MessageList.tsx";
import { useAgentSession } from "../hooks/useAgentSession.ts";
import type { SessionStatus } from "../hooks/useAgentSession.ts";
import "./ChatPage.css";

const STATUS_COLORS: Record<SessionStatus, string> = {
	connected: "#4ade80",
	connecting: "#facc15",
	disconnected: "#f87171",
	error: "#f87171",
	stopped: "#888",
};

function StatusDot({ status }: { status: SessionStatus }) {
	return (
		<span
			className="status-dot"
			style={{ backgroundColor: STATUS_COLORS[status] }}
			title={status}
		/>
	);
}

export function ChatPage() {
	const { messages, send, status, newSession, errorMessage } =
		useAgentSession();
	const [errorDismissed, setErrorDismissed] = useState(false);

	const handleSend = useCallback(
		(content: string) => {
			send(content);
		},
		[send],
	);

	const handleNewSession = useCallback(async () => {
		if (
			!window.confirm("Start a new session? Current conversation will end.")
		) {
			return;
		}
		setErrorDismissed(false);
		await newSession();
	}, [newSession]);

	const showError = !errorDismissed && status === "error" && errorMessage;

	return (
		<div className="chat-page">
			<header className="chat-header">
				<div className="chat-header-left">
					<StatusDot status={status} />
					<span className="chat-header-title">Chat</span>
				</div>
				<button
					type="button"
					className="chat-header-action"
					onClick={handleNewSession}
					aria-label="New session"
					title="New session"
				>
					<RotateCcw size={18} />
				</button>
			</header>

			{showError && (
				<div className="chat-error-banner">
					<span>{errorMessage}</span>
					<button
						type="button"
						className="chat-error-dismiss"
						onClick={() => setErrorDismissed(true)}
					>
						Dismiss
					</button>
				</div>
			)}

			{status === "stopped" && (
				<div className="chat-stopped-banner">
					Session ended.{" "}
					<button
						type="button"
						className="chat-stopped-link"
						onClick={handleNewSession}
					>
						Start a new session
					</button>
				</div>
			)}

			<MessageList messages={messages} />

			<ChatInput onSend={handleSend} status={status} />
		</div>
	);
}
