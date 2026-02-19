import type { ServerMessage } from "shared";

export interface AdapterConfig {
	workingDirectory: string;
}

export interface AgentAdapter {
	spawn(config: AdapterConfig): Promise<void>;
	send(message: string): void;
	onMessage(cb: (msg: ServerMessage) => void): void;
	onExit(cb: (code: number, error?: string) => void): void;
	stop(): void;
}
