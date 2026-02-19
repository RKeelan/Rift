import { randomUUID } from "node:crypto";
import type { ServerMessage } from "shared";
import type { AdapterConfig, AgentAdapter } from "./adapter.js";

const TOOL_RESULT_OUTPUT = `--- a/example.ts
+++ b/example.ts
@@ -1,3 +1,3 @@
 const x = 1;
-const y = 2;
+const y = 3;
 const z = x + y;`;

export class EchoAdapter implements AgentAdapter {
	private messageCallbacks: Array<(msg: ServerMessage) => void> = [];
	private exitCallbacks: Array<(code: number, error?: string) => void> = [];
	private spawned = false;
	private stopped = false;

	async spawn(_config: AdapterConfig): Promise<void> {
		this.spawned = true;
	}

	send(message: string): void {
		if (!this.spawned) {
			throw new Error("Cannot send before spawn");
		}
		if (this.stopped) {
			return;
		}

		const toolId = randomUUID();

		this.emit({ type: "assistant_text", content: `Echo: ${message}` });
		this.emit({
			type: "tool_use",
			id: toolId,
			tool: "Read",
			input: { file_path: "example.ts" },
		});
		this.emit({
			type: "tool_result",
			id: toolId,
			is_error: false,
			output: TOOL_RESULT_OUTPUT,
		});
	}

	onMessage(cb: (msg: ServerMessage) => void): void {
		this.messageCallbacks.push(cb);
	}

	onExit(cb: (code: number, error?: string) => void): void {
		this.exitCallbacks.push(cb);
	}

	stop(): void {
		if (this.stopped) {
			return;
		}
		this.stopped = true;
		for (const cb of this.exitCallbacks) {
			cb(0);
		}
	}

	private emit(msg: ServerMessage): void {
		for (const cb of this.messageCallbacks) {
			cb(msg);
		}
	}
}
