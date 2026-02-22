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
		.action(async (dirPath: string) => {
			const params = new URLSearchParams({ path: dirPath });
			const data = await api.get(`/api/files?${params}`);
			output(data, getFormat());
		});

	files
		.command("cat")
		.description("Read file contents")
		.argument("<path>", "File path")
		.action(async (filePath: string) => {
			const params = new URLSearchParams({ path: filePath });
			const content = await api.getText(`/api/files/content?${params}`);
			const fmt = getFormat();
			if (fmt === "json") {
				output({ content }, fmt);
			} else {
				process.stdout.write(content);
			}
		});
}
