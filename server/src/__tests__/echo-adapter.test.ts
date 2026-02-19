import { describe, expect, test } from "bun:test";
import type { ServerMessage } from "shared";
import { EchoAdapter } from "../adapters/echo.js";

describe("EchoAdapter", () => {
	test("spawn resolves without error", async () => {
		const adapter = new EchoAdapter();
		await adapter.spawn({ workingDirectory: "/tmp" });
	});

	test("send before spawn throws", () => {
		const adapter = new EchoAdapter();
		expect(() => adapter.send("hello")).toThrow("Cannot send before spawn");
	});

	test("send emits three messages in the expected sequence", async () => {
		const adapter = new EchoAdapter();
		await adapter.spawn({ workingDirectory: "/tmp" });

		const messages: ServerMessage[] = [];
		adapter.onMessage((msg) => messages.push(msg));

		adapter.send("hello world");

		expect(messages).toHaveLength(3);

		// First message: assistant_text echoing the input
		expect(messages[0].type).toBe("assistant_text");
		expect(messages[0]).toHaveProperty("content", "Echo: hello world");

		// Second message: tool_use with Read tool
		expect(messages[1].type).toBe("tool_use");
		const toolUse = messages[1] as Extract<ServerMessage, { type: "tool_use" }>;
		expect(toolUse.tool).toBe("Read");
		expect(toolUse.input).toEqual({ file_path: "example.ts" });
		expect(toolUse.id).toBeTruthy();

		// Third message: tool_result with matching id
		expect(messages[2].type).toBe("tool_result");
		const toolResult = messages[2] as Extract<
			ServerMessage,
			{ type: "tool_result" }
		>;
		expect(toolResult.id).toBe(toolUse.id);
		expect(toolResult.is_error).toBe(false);
		expect(toolResult.output).toContain("--- a/example.ts");
		expect(toolResult.output).toContain("+++ b/example.ts");
		expect(toolResult.output).toContain("-const y = 2;");
		expect(toolResult.output).toContain("+const y = 3;");
	});

	test("tool_use and tool_result share the same id", async () => {
		const adapter = new EchoAdapter();
		await adapter.spawn({ workingDirectory: "/tmp" });

		const messages: ServerMessage[] = [];
		adapter.onMessage((msg) => messages.push(msg));
		adapter.send("test");

		const toolUse = messages[1] as Extract<ServerMessage, { type: "tool_use" }>;
		const toolResult = messages[2] as Extract<
			ServerMessage,
			{ type: "tool_result" }
		>;
		expect(toolUse.id).toBe(toolResult.id);
	});

	test("send after stop is silently ignored", async () => {
		const adapter = new EchoAdapter();
		await adapter.spawn({ workingDirectory: "/tmp" });

		const messages: ServerMessage[] = [];
		adapter.onMessage((msg) => messages.push(msg));

		adapter.stop();
		adapter.send("should be ignored");

		expect(messages).toHaveLength(0);
	});

	test("stop is idempotent", async () => {
		const adapter = new EchoAdapter();
		await adapter.spawn({ workingDirectory: "/tmp" });

		let exitCount = 0;
		adapter.onExit(() => {
			exitCount++;
		});

		adapter.stop();
		adapter.stop();
		adapter.stop();

		expect(exitCount).toBe(1);
	});

	test("stop fires onExit callbacks with code 0", async () => {
		const adapter = new EchoAdapter();
		await adapter.spawn({ workingDirectory: "/tmp" });

		let exitCode: number | undefined;
		adapter.onExit((code) => {
			exitCode = code;
		});

		adapter.stop();
		expect(exitCode).toBe(0);
	});

	test("multiple onMessage callbacks all receive messages", async () => {
		const adapter = new EchoAdapter();
		await adapter.spawn({ workingDirectory: "/tmp" });

		const messages1: ServerMessage[] = [];
		const messages2: ServerMessage[] = [];
		adapter.onMessage((msg) => messages1.push(msg));
		adapter.onMessage((msg) => messages2.push(msg));

		adapter.send("test");

		expect(messages1).toHaveLength(3);
		expect(messages2).toHaveLength(3);
	});

	test("each send generates unique tool ids", async () => {
		const adapter = new EchoAdapter();
		await adapter.spawn({ workingDirectory: "/tmp" });

		const messages: ServerMessage[] = [];
		adapter.onMessage((msg) => messages.push(msg));

		adapter.send("first");
		adapter.send("second");

		const toolUse1 = messages[1] as Extract<
			ServerMessage,
			{ type: "tool_use" }
		>;
		const toolUse2 = messages[4] as Extract<
			ServerMessage,
			{ type: "tool_use" }
		>;
		expect(toolUse1.id).not.toBe(toolUse2.id);
	});
});
