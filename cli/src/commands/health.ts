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
		.option("--repo <name>", "Repository name")
		.action(async (opts: { repo?: string }) => {
			const params = new URLSearchParams();
			if (opts.repo) params.set("repo", opts.repo);
			const qs = params.toString();
			const data = await api.get(`/api/health${qs ? `?${qs}` : ""}`);
			output(data, getFormat());
		});
}
