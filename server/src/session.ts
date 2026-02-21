import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ServerMessage } from "shared";
import type { AdapterConfig, AgentAdapter } from "./adapters/index.js";

const MAX_BUFFER_SIZE = 10_000;
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface Session {
	id: string;
	state: "running" | "stopped";
	createdAt: string;
	stoppedAt?: number;
	workingDirectory: string;
	adapter: AgentAdapter;
	buffer: ServerMessage[];
}

export interface SessionInfo {
	id: string;
	state: "running" | "stopped";
	createdAt: string;
}

export interface SessionManagerOptions {
	ttlMs?: number;
	cleanupIntervalMs?: number;
	adapterFactory: () => AgentAdapter;
}

export class SessionManager extends EventEmitter {
	private sessions = new Map<string, Session>();
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;
	private readonly ttlMs: number;
	private readonly adapterFactory: () => AgentAdapter;

	constructor(options: SessionManagerOptions) {
		super();
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.adapterFactory = options.adapterFactory;

		const cleanupIntervalMs =
			options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
		this.cleanupTimer = setInterval(
			() => this.cleanupStopped(),
			cleanupIntervalMs,
		);
		// Don't keep the process alive just for cleanup
		this.cleanupTimer.unref();
	}

	async createSession(workingDirectory: string): Promise<SessionInfo> {
		const id = randomUUID();
		const adapter = this.adapterFactory();
		const session: Session = {
			id,
			state: "running",
			createdAt: new Date().toISOString(),
			workingDirectory,
			adapter,
			buffer: [],
		};

		adapter.onMessage((msg) => {
			if (session.buffer.length >= MAX_BUFFER_SIZE) {
				session.buffer.shift();
				console.warn(
					`Session ${id}: buffer limit reached (${MAX_BUFFER_SIZE}), dropping oldest message`,
				);
			}
			session.buffer.push(msg);
			this.emit("message", id, msg);
		});

		adapter.onExit((_code, error) => {
			if (session.state === "stopped") {
				return;
			}
			session.state = "stopped";
			session.stoppedAt = Date.now();
			if (error) {
				const errorMsg: ServerMessage = {
					type: "session_event",
					event: "error",
					message: error,
				};
				session.buffer.push(errorMsg);
				this.emit("message", id, errorMsg);
			}
			this.emit("stopped", id);
		});

		const config: AdapterConfig = { workingDirectory };
		try {
			await adapter.spawn(config);
		} catch (err) {
			adapter.stop();
			throw err;
		}

		this.sessions.set(id, session);
		return { id, state: session.state, createdAt: session.createdAt };
	}

	listSessions(): SessionInfo[] {
		return Array.from(this.sessions.values()).map(toInfo);
	}

	getSession(id: string): SessionInfo | undefined {
		const session = this.sessions.get(id);
		return session ? toInfo(session) : undefined;
	}

	getBuffer(id: string): ServerMessage[] | undefined {
		return this.sessions.get(id)?.buffer;
	}

	addToBuffer(id: string, message: ServerMessage): void {
		const session = this.sessions.get(id);
		if (!session) return;
		if (session.buffer.length >= MAX_BUFFER_SIZE) {
			session.buffer.shift();
		}
		session.buffer.push(message);
	}

	send(id: string, message: string): boolean {
		const session = this.sessions.get(id);
		if (!session || session.state !== "running") {
			return false;
		}
		session.adapter.send(message);
		return true;
	}

	stopSession(id: string): boolean {
		const session = this.sessions.get(id);
		if (!session) {
			return false;
		}
		if (session.state === "running") {
			session.state = "stopped";
			session.stoppedAt = Date.now();
			session.adapter.stop();
			this.emit("stopped", id);
		}
		return true;
	}

	stopAll(): void {
		for (const session of this.sessions.values()) {
			if (session.state === "running") {
				session.state = "stopped";
				session.stoppedAt = Date.now();
				session.adapter.stop();
				this.emit("stopped", session.id);
			}
		}
	}

	dispose(): void {
		this.stopAll();
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
	}

	private cleanupStopped(): void {
		const now = Date.now();
		for (const [id, session] of this.sessions) {
			if (
				session.state === "stopped" &&
				session.stoppedAt &&
				now - session.stoppedAt >= this.ttlMs
			) {
				this.sessions.delete(id);
			}
		}
	}
}

function toInfo(session: Session): SessionInfo {
	return {
		id: session.id,
		state: session.state,
		createdAt: session.createdAt,
	};
}
