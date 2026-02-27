import type { Command } from "commander";
import type { ApiClient } from "../api.js";
import { output } from "../format.js";

export function registerSession(
	parent: Command,
	api: ApiClient,
	getFormat: () => "json" | "text",
): void {
	const session = parent.command("session").description("Session management");

	session
		.command("create")
		.description("Create a new session")
		.option("--repo <name>", "Repository name")
		.action(async (opts: { repo?: string }) => {
			const body: Record<string, string> = {};
			if (opts.repo) body.repo = opts.repo;
			const data = await api.post("/api/sessions", body);
			output(data, getFormat());
		});

	session
		.command("list")
		.description("List all sessions")
		.action(async () => {
			const data = await api.get("/api/sessions");
			output(data, getFormat());
		});

	session
		.command("get")
		.description("Get session details")
		.argument("<id>", "Session ID")
		.action(async (id: string) => {
			const data = await api.get(`/api/sessions/${encodeURIComponent(id)}`);
			output(data, getFormat());
		});

	session
		.command("stop")
		.description("Stop a session")
		.argument("<id>", "Session ID")
		.action(async (id: string) => {
			const data = await api.delete(`/api/sessions/${encodeURIComponent(id)}`);
			output(data, getFormat());
		});
}
