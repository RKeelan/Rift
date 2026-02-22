import type { Command } from "commander";
import type { ApiClient } from "../api.js";
import { output } from "../format.js";

export function registerGit(
	parent: Command,
	api: ApiClient,
	getFormat: () => "json" | "text",
): void {
	const git = parent.command("git").description("Git operations");

	git
		.command("status")
		.description("Show staged/unstaged changes")
		.action(async () => {
			const data = await api.get("/api/git/status");
			output(data, getFormat());
		});

	git
		.command("diff")
		.description("Show unified diff for a file")
		.argument("<path>", "File path")
		.option("--staged", "Show staged diff", false)
		.action(async (filePath: string, opts: { staged: boolean }) => {
			const params = new URLSearchParams({ path: filePath });
			if (opts.staged) params.set("staged", "true");
			const data = await api.get(`/api/git/diff?${params}`);
			output(data, getFormat());
		});
}
