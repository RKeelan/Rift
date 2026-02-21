import { useCallback, useEffect, useRef } from "react";
import Markdown from "react-markdown";
import type { ServerMessage, ToolResultMessage, ToolUseMessage } from "shared";
import { StandaloneToolResult, ToolCallCard } from "./ToolCallCard.tsx";
import "./MessageList.css";

interface UserMessageBubbleProps {
	content: string;
}

function UserMessageBubble({ content }: UserMessageBubbleProps) {
	return (
		<div className="message-row user">
			<div className="message-bubble user-bubble">{content}</div>
		</div>
	);
}

interface AssistantTextBubbleProps {
	content: string;
}

function AssistantTextBubble({ content }: AssistantTextBubbleProps) {
	return (
		<div className="message-row assistant">
			<div className="message-bubble assistant-bubble markdown-body">
				<Markdown>{content}</Markdown>
			</div>
		</div>
	);
}

/** Build a map from tool_use id to its matching tool_result. */
function buildToolResultMap(
	messages: ServerMessage[],
): Map<string, ToolResultMessage> {
	const map = new Map<string, ToolResultMessage>();
	for (const msg of messages) {
		if (msg.type === "tool_result") {
			map.set(msg.id, msg);
		}
	}
	return map;
}

/** Find tool_use ids so we can skip rendering their tool_results inline. */
function buildToolUseIds(messages: ServerMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const msg of messages) {
		if (msg.type === "tool_use") {
			ids.add(msg.id);
		}
	}
	return ids;
}

interface MessageListProps {
	messages: ServerMessage[];
}

export function MessageList({ messages }: MessageListProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const autoScrollRef = useRef(true);

	const handleScroll = useCallback(() => {
		const el = containerRef.current;
		if (!el) return;
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		autoScrollRef.current = distanceFromBottom <= 100;
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll when messages change
	useEffect(() => {
		const el = containerRef.current;
		if (el && autoScrollRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages]);

	const resultMap = buildToolResultMap(messages);
	const toolUseIds = buildToolUseIds(messages);

	const rendered: React.ReactNode[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		switch (msg.type) {
			case "user_message_record":
				rendered.push(
					<UserMessageBubble key={`msg-${i}`} content={msg.content} />,
				);
				break;

			case "assistant_text":
				rendered.push(
					<AssistantTextBubble key={`msg-${i}`} content={msg.content} />,
				);
				break;

			case "tool_use":
				rendered.push(
					<ToolCallCard
						key={`msg-${i}`}
						toolUse={msg as ToolUseMessage}
						toolResult={resultMap.get(msg.id)}
					/>,
				);
				break;

			case "tool_result":
				// Render standalone only if no matching tool_use exists
				if (!toolUseIds.has(msg.id)) {
					rendered.push(
						<StandaloneToolResult
							key={`msg-${i}`}
							toolResult={msg as ToolResultMessage}
						/>,
					);
				}
				break;

			case "session_event":
				// Error events are rendered as banners in the parent
				break;

			case "history":
				// Never rendered directly
				break;
		}
	}

	return (
		<div className="message-list" ref={containerRef} onScroll={handleScroll}>
			{rendered.length === 0 ? (
				<div className="message-list-empty">
					Send a message to start a conversation.
				</div>
			) : (
				rendered
			)}
		</div>
	);
}
