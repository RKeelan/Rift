import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type {
	ServerMessage,
	ToolResultMessage,
	ToolUseMessage,
	UserMessageRecord,
} from "shared";
import { MessageList } from "../components/MessageList.tsx";

afterEach(cleanup);

describe("MessageList", () => {
	test("renders user message bubbles with user-bubble class", () => {
		const userMsg: UserMessageRecord = {
			type: "user_message_record",
			content: "Hello there",
		};
		const messages: ServerMessage[] = [userMsg];

		const { container } = render(<MessageList messages={messages} />);

		const bubble = container.querySelector(".user-bubble");
		expect(bubble).not.toBeNull();
		expect(bubble?.textContent).toBe("Hello there");
	});

	test("user bubbles are in a right-aligned row", () => {
		const messages: ServerMessage[] = [
			{ type: "user_message_record", content: "Hi" },
		];

		const { container } = render(<MessageList messages={messages} />);

		const row = container.querySelector(".message-row.user");
		expect(row).not.toBeNull();
	});

	test("renders Markdown content for assistant_text messages", () => {
		const messages: ServerMessage[] = [
			{ type: "assistant_text", content: "Hello **bold** text" },
		];

		const { container } = render(<MessageList messages={messages} />);

		const assistantBubble = container.querySelector(".assistant-bubble");
		expect(assistantBubble).not.toBeNull();
		// react-markdown renders **bold** as <strong>
		const strong = assistantBubble?.querySelector("strong");
		expect(strong).not.toBeNull();
		expect(strong?.textContent).toBe("bold");
	});

	test("renders assistant messages in a left-aligned row", () => {
		const messages: ServerMessage[] = [
			{ type: "assistant_text", content: "Hello" },
		];

		const { container } = render(<MessageList messages={messages} />);

		const row = container.querySelector(".message-row.assistant");
		expect(row).not.toBeNull();
	});

	test("renders tool_use messages as tool cards", () => {
		const toolUse: ToolUseMessage = {
			type: "tool_use",
			id: "tool-1",
			tool: "Read",
			input: { path: "src/index.ts" },
		};
		const messages: ServerMessage[] = [toolUse];

		const { container } = render(<MessageList messages={messages} />);

		const toolCard = container.querySelector(".tool-card");
		expect(toolCard).not.toBeNull();
		expect(toolCard?.textContent).toContain("Read");
		expect(toolCard?.textContent).toContain("src/index.ts");
	});

	test("does not render tool_result inline when matching tool_use exists", () => {
		const toolUse: ToolUseMessage = {
			type: "tool_use",
			id: "tool-1",
			tool: "Read",
			input: { path: "src/index.ts" },
		};
		const toolResult: ToolResultMessage = {
			type: "tool_result",
			id: "tool-1",
			output: "file contents here",
			is_error: false,
		};
		const messages: ServerMessage[] = [toolUse, toolResult];

		const { container } = render(<MessageList messages={messages} />);

		const toolCards = container.querySelectorAll(".tool-card");
		expect(toolCards.length).toBe(1);
	});

	test("renders standalone tool_result when no matching tool_use exists", () => {
		const toolResult: ToolResultMessage = {
			type: "tool_result",
			id: "orphan-id",
			output: "orphan result",
			is_error: false,
		};
		const messages: ServerMessage[] = [toolResult];

		const { container } = render(<MessageList messages={messages} />);

		const standalone = container.querySelector(".tool-card.standalone");
		expect(standalone).not.toBeNull();
		expect(standalone?.textContent).toContain("Tool Result");
	});

	test("renders empty state when no messages", () => {
		const { container } = render(<MessageList messages={[]} />);

		const empty = container.querySelector(".message-list-empty");
		expect(empty).not.toBeNull();
		expect(empty?.textContent).toContain("Send a message");
	});
});
