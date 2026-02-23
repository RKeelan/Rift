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

	git
		.command("log")
		.description("Show recent commits")
		.option("--limit <n>", "Number of commits", "25")
		.option("--offset <n>", "Skip commits", "0")
		.action(async (opts: { limit: string; offset: string }) => {
			const params = new URLSearchParams({
				limit: opts.limit,
				offset: opts.offset,
			});
			const data = await api.get(`/api/git/log?${params}`);
			output(data, getFormat());
		});

	git
		.command("show")
		.description("Show commit details and changed files")
		.argument("<hash>", "Commit hash")
		.action(async (hash: string) => {
			const data = await api.get(`/api/git/commit/${encodeURIComponent(hash)}`);
			output(data, getFormat());
		});

	git
		.command("show-diff")
		.description("Show diff for a file within a commit")
		.argument("<hash>", "Commit hash")
		.argument("<path>", "File path")
		.action(async (hash: string, filePath: string) => {
			const params = new URLSearchParams({ path: filePath });
			const data = await api.get(
				`/api/git/commit/${encodeURIComponent(hash)}/diff?${params}`,
			);
			output(data, getFormat());
		});
}
