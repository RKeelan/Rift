import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ChatInput } from "../components/ChatInput.tsx";
import type { SessionStatus } from "../hooks/useAgentSession.ts";

afterEach(cleanup);

const noop = () => {};

describe("ChatInput", () => {
	test("renders a textarea and a send button", () => {
		const { container } = render(
			<ChatInput onSend={noop} status="connected" />,
		);

		const textarea = container.querySelector("textarea");
		expect(textarea).not.toBeNull();

		const button = container.querySelector('button[type="submit"]');
		expect(button).not.toBeNull();
	});

	test("textarea is enabled when status is connected", () => {
		const { container } = render(
			<ChatInput onSend={noop} status="connected" />,
		);

		const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
		expect(textarea.disabled).toBe(false);
	});

	test("disables textarea and send button when status is disconnected", () => {
		const { container } = render(
			<ChatInput onSend={noop} status="disconnected" />,
		);

		const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
		const button = container.querySelector(
			'button[type="submit"]',
		) as HTMLButtonElement;

		expect(textarea.disabled).toBe(true);
		expect(button.disabled).toBe(true);
	});

	test("disables textarea and send button when status is connecting", () => {
		const { container } = render(
			<ChatInput onSend={noop} status="connecting" />,
		);

		const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
		const button = container.querySelector(
			'button[type="submit"]',
		) as HTMLButtonElement;

		expect(textarea.disabled).toBe(true);
		expect(button.disabled).toBe(true);
	});

	test("disables textarea and send button when status is error", () => {
		const { container } = render(<ChatInput onSend={noop} status="error" />);

		const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
		const button = container.querySelector(
			'button[type="submit"]',
		) as HTMLButtonElement;

		expect(textarea.disabled).toBe(true);
		expect(button.disabled).toBe(true);
	});

	test("disables textarea and send button when status is stopped", () => {
		const { container } = render(<ChatInput onSend={noop} status="stopped" />);

		const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
		const button = container.querySelector(
			'button[type="submit"]',
		) as HTMLButtonElement;

		expect(textarea.disabled).toBe(true);
		expect(button.disabled).toBe(true);
	});

	test("shows Disconnected placeholder when not connected", () => {
		const { container } = render(
			<ChatInput onSend={noop} status="disconnected" />,
		);

		const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
		expect(textarea.placeholder).toBe("Disconnected...");
	});

	test("shows Send a message placeholder when connected", () => {
		const { container } = render(
			<ChatInput onSend={noop} status="connected" />,
		);

		const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
		expect(textarea.placeholder).toBe("Send a message...");
	});

	test("send button is disabled when connected but input is empty", () => {
		const { container } = render(
			<ChatInput onSend={noop} status="connected" />,
		);

		const button = container.querySelector(
			'button[type="submit"]',
		) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
	});

	test("send button has accessible label", () => {
		const { container } = render(
			<ChatInput onSend={noop} status="connected" />,
		);

		const button = container.querySelector('button[aria-label="Send message"]');
		expect(button).not.toBeNull();
	});
});
