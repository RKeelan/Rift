import type { Command } from "commander";
import type { ApiClient } from "../api.js";
import { output } from "../format.js";

export function registerFiles(
	parent: Command,
	api: ApiClient,
	getFormat: () => "json" | "text",
): void {
	const files = parent.command("files").description("File operations");

	files
		.command("ls")
		.description("List directory contents")
		.argument("[path]", "Directory path", ".")
		.option("--repo <name>", "Repository name")
		.action(async (dirPath: string, opts: { repo?: string }) => {
			const params = new URLSearchParams({ path: dirPath });
			if (opts.repo) params.set("repo", opts.repo);
			const data = await api.get(`/api/files?${params}`);
			output(data, getFormat());
		});

	files
		.command("cat")
		.description("Read file contents")
		.argument("<path>", "File path")
		.option("--repo <name>", "Repository name")
		.action(async (filePath: string, opts: { repo?: string }) => {
			const params = new URLSearchParams({ path: filePath });
			if (opts.repo) params.set("repo", opts.repo);
			const content = await api.getText(`/api/files/content?${params}`);
			const fmt = getFormat();
			if (fmt === "json") {
				output({ content }, fmt);
			} else {
				process.stdout.write(content);
			}
		});
}
