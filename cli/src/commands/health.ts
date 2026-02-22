import type { Command } from "commander";
import type { ApiClient } from "../api.js";
import { output } from "../format.js";

export function registerHealth(
	parent: Command,
	api: ApiClient,
	getFormat: () => "json" | "text",
): void {
	parent
		.command("health")
		.description("Server health check")
		.action(async () => {
			const data = await api.get("/api/health");
			output(data, getFormat());
		});
}
