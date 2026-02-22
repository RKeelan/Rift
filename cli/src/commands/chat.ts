import type { Command } from "commander";
import type { ClientMessage, ServerMessage } from "shared";
import type { ApiClient } from "../api.js";
import { outputLine } from "../format.js";

export function registerChat(
	parent: Command,
	api: ApiClient,
	_getFormat: () => "json" | "text",
): void {
	parent
		.command("chat")
		.description("Send a message and stream responses")
		.argument("<session-id>", "Session ID")
		.argument("<message>", "Message to send")
		.option("--timeout <seconds>", "Idle timeout in seconds", "30")
		.option("--no-wait", "Send and exit immediately")
		.action(
			async (
				sessionId: string,
				message: string,
				opts: { timeout: string; wait: boolean },
			) => {
				const timeoutSeconds = Number.parseInt(opts.timeout, 10);
				if (Number.isNaN(timeoutSeconds) || timeoutSeconds <= 0) {
					throw new Error(
						`Invalid timeout: "${opts.timeout}" (must be a positive integer)`,
					);
				}
				const timeoutMs = timeoutSeconds * 1000;
				const wsUrl = api.wsUrl(
					`/api/sessions/${encodeURIComponent(sessionId)}/ws`,
				);

				await new Promise<void>((resolve, reject) => {
					const ws = new WebSocket(wsUrl);
					let idleTimer: ReturnType<typeof setTimeout> | null = null;
					let historySeen = false;
					let settled = false;

					function cleanup() {
						if (idleTimer) clearTimeout(idleTimer);
						ws.close();
					}

					function settleResolve() {
						if (settled) return;
						settled = true;
						cleanup();
						resolve();
					}

					function settleReject(error: Error) {
						if (settled) return;
						settled = true;
						cleanup();
						reject(error);
					}

					function resetIdleTimer() {
						if (idleTimer) clearTimeout(idleTimer);
						if (!opts.wait) return;
						idleTimer = setTimeout(() => settleResolve(), timeoutMs);
					}

					ws.addEventListener("message", (event) => {
						let msg: ServerMessage;
						try {
							msg = JSON.parse(
								typeof event.data === "string"
									? event.data
									: event.data.toString(),
							) as ServerMessage;
						} catch {
							return; // Ignore malformed JSON
						}

						if (msg.type === "history") {
							historySeen = true;
							const clientMsg: ClientMessage = {
								type: "user_message",
								content: message,
							};
							ws.send(JSON.stringify(clientMsg));

							if (!opts.wait) {
								settleResolve();
								return;
							}
							resetIdleTimer();
							return;
						}

						outputLine(JSON.stringify(msg));
						resetIdleTimer();

						if (msg.type === "session_event") {
							if (msg.event === "stopped" || msg.event === "error") {
								settleResolve();
							}
						}
					});

					ws.addEventListener("error", (event) => {
						settleReject(
							new Error(
								`WebSocket error: ${(event as ErrorEvent).message ?? "connection failed"}`,
							),
						);
					});

					ws.addEventListener("close", (event) => {
						if (!historySeen) {
							settleReject(
								new Error(event.reason || `WebSocket closed: ${event.code}`),
							);
						} else {
							settleResolve();
						}
					});
				});
			},
		);
}
