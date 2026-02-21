// --- Client → Server ---

export interface ClientMessage {
	type: "user_message";
	content: string;
}

// --- Server → Client ---

export interface AssistantTextMessage {
	type: "assistant_text";
	content: string;
}

export interface ToolUseMessage {
	type: "tool_use";
	id: string;
	tool: string;
	input: Record<string, unknown>;
}

export interface ToolResultMessage {
	type: "tool_result";
	id: string;
	output: string;
	is_error: boolean;
}

export interface UserMessageRecord {
	type: "user_message_record";
	content: string;
}

export interface SessionEventMessage {
	type: "session_event";
	event: "started" | "stopped" | "error";
	message?: string;
}

export interface HistoryMessage {
	type: "history";
	messages: ServerMessage[];
}

export type ServerMessage =
	| AssistantTextMessage
	| ToolUseMessage
	| ToolResultMessage
	| UserMessageRecord
	| SessionEventMessage
	| HistoryMessage;
