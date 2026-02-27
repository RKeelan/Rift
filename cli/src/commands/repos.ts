import type { Command } from "commander";
import type { ApiClient } from "../api.js";
import { output } from "../format.js";

export function registerRepos(
	parent: Command,
	api: ApiClient,
	getFormat: () => "json" | "text",
): void {
	const repos = parent.command("repos").description("Repository operations");

	repos
		.command("list")
		.description("List available repositories")
		.action(async () => {
			const data = await api.get("/api/repos");
			output(data, getFormat());
		});
}
