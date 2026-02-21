import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ToolResultMessage, ToolUseMessage } from "shared";
import {
	StandaloneToolResult,
	ToolCallCard,
} from "../components/ToolCallCard.tsx";

afterEach(cleanup);

const sampleToolUse: ToolUseMessage = {
	type: "tool_use",
	id: "tool-abc",
	tool: "Read",
	input: { path: "src/index.ts" },
};

const sampleToolResult: ToolResultMessage = {
	type: "tool_result",
	id: "tool-abc",
	output: "console.log('hello');",
	is_error: false,
};

describe("ToolCallCard", () => {
	test("renders summary with tool name and first input value", () => {
		const { container } = render(<ToolCallCard toolUse={sampleToolUse} />);

		const summary = container.querySelector(".tool-card-summary");
		expect(summary).not.toBeNull();
		expect(summary?.textContent).toContain("Read");
		expect(summary?.textContent).toContain("src/index.ts");
	});

	test("renders collapsed by default (no body visible)", () => {
		const { container } = render(<ToolCallCard toolUse={sampleToolUse} />);

		const body = container.querySelector(".tool-card-body");
		expect(body).toBeNull();
	});

	test("expands on click to show JSON input", () => {
		const { container } = render(<ToolCallCard toolUse={sampleToolUse} />);

		const header = container.querySelector(".tool-card-header");
		expect(header).not.toBeNull();
		fireEvent.click(header as Element);

		const body = container.querySelector(".tool-card-body");
		expect(body).not.toBeNull();

		const json = container.querySelector(".tool-card-json");
		expect(json).not.toBeNull();
		expect(json?.textContent).toContain('"path"');
		expect(json?.textContent).toContain('"src/index.ts"');
	});

	test("collapses on second click", () => {
		const { container } = render(<ToolCallCard toolUse={sampleToolUse} />);

		const header = container.querySelector(".tool-card-header") as Element;
		fireEvent.click(header);
		expect(container.querySelector(".tool-card-body")).not.toBeNull();

		fireEvent.click(header);
		expect(container.querySelector(".tool-card-body")).toBeNull();
	});

	test("shows tool result when expanded and toolResult is provided", () => {
		const { container } = render(
			<ToolCallCard toolUse={sampleToolUse} toolResult={sampleToolResult} />,
		);

		const header = container.querySelector(".tool-card-header") as Element;
		fireEvent.click(header);

		const output = container.querySelector(".tool-card-output");
		expect(output).not.toBeNull();
		expect(output?.textContent).toContain("console.log('hello');");
	});

	test("shows Output label for successful tool result", () => {
		const { container } = render(
			<ToolCallCard toolUse={sampleToolUse} toolResult={sampleToolResult} />,
		);

		const header = container.querySelector(".tool-card-header") as Element;
		fireEvent.click(header);

		const labels = container.querySelectorAll(".tool-card-label");
		const labelTexts = Array.from(labels).map((l) => l.textContent);
		expect(labelTexts).toContain("Output");
	});

	test("shows Error label for error tool result", () => {
		const errorResult: ToolResultMessage = {
			...sampleToolResult,
			is_error: true,
			output: "File not found",
		};
		const { container } = render(
			<ToolCallCard toolUse={sampleToolUse} toolResult={errorResult} />,
		);

		const header = container.querySelector(".tool-card-header") as Element;
		fireEvent.click(header);

		const labels = container.querySelectorAll(".tool-card-label");
		const labelTexts = Array.from(labels).map((l) => l.textContent);
		expect(labelTexts).toContain("Error");
	});

	test("renders tool result with diff viewer when output contains unified diff", () => {
		const diffResult: ToolResultMessage = {
			type: "tool_result",
			id: "tool-abc",
			output:
				"--- a/file.ts\n+++ b/file.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line",
			is_error: false,
		};
		const { container } = render(
			<ToolCallCard toolUse={sampleToolUse} toolResult={diffResult} />,
		);

		const header = container.querySelector(".tool-card-header") as Element;
		fireEvent.click(header);

		const diffViewer = container.querySelector(".diff-viewer");
		expect(diffViewer).not.toBeNull();
	});

	test("summarises tool with truncated long input values", () => {
		const longTool: ToolUseMessage = {
			type: "tool_use",
			id: "tool-long",
			tool: "Bash",
			input: {
				command: "a".repeat(100),
			},
		};
		const { container } = render(<ToolCallCard toolUse={longTool} />);

		const summary = container.querySelector(".tool-card-summary");
		expect(summary).not.toBeNull();
		// Should be truncated to 60 chars + "..."
		expect(summary?.textContent).toContain("...");
	});

	test("summarises tool with only tool name when input is empty", () => {
		const emptyInputTool: ToolUseMessage = {
			type: "tool_use",
			id: "tool-empty",
			tool: "Noop",
			input: {},
		};
		const { container } = render(<ToolCallCard toolUse={emptyInputTool} />);

		const summary = container.querySelector(".tool-card-summary");
		expect(summary?.textContent).toBe("Noop");
	});
});

describe("StandaloneToolResult", () => {
	test("renders with standalone class", () => {
		const { container } = render(
			<StandaloneToolResult toolResult={sampleToolResult} />,
		);

		const card = container.querySelector(".tool-card.standalone");
		expect(card).not.toBeNull();
	});

	test("renders Tool Result label", () => {
		const { container } = render(
			<StandaloneToolResult toolResult={sampleToolResult} />,
		);

		const label = container.querySelector(".tool-card-label");
		expect(label).not.toBeNull();
		expect(label?.textContent).toContain("Tool Result");
	});

	test("renders output as preformatted text", () => {
		const { container } = render(
			<StandaloneToolResult toolResult={sampleToolResult} />,
		);

		const output = container.querySelector(".tool-card-output");
		expect(output).not.toBeNull();
		expect(output?.textContent).toContain("console.log('hello');");
	});

	test("renders error indicator for error results", () => {
		const errorResult: ToolResultMessage = {
			...sampleToolResult,
			is_error: true,
			output: "Something failed",
		};
		const { container } = render(
			<StandaloneToolResult toolResult={errorResult} />,
		);

		const label = container.querySelector(".tool-card-label");
		expect(label?.textContent).toContain("Error");

		const output = container.querySelector(".tool-card-error");
		expect(output).not.toBeNull();
	});

	test("renders diff viewer when output contains unified diff", () => {
		const diffResult: ToolResultMessage = {
			type: "tool_result",
			id: "standalone-diff",
			output: "--- a/file.ts\n+++ b/file.ts\n@@ -1,2 +1,2 @@\n-old\n+new",
			is_error: false,
		};
		const { container } = render(
			<StandaloneToolResult toolResult={diffResult} />,
		);

		const diffViewer = container.querySelector(".diff-viewer");
		expect(diffViewer).not.toBeNull();
	});
});
