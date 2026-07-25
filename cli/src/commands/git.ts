import type { Command } from "commander";
import type { ApiClient } from "../api.js";
import { output } from "../format.js";

function collectLine(value: string, previous: string[]): string[] {
	previous.push(value);
	return previous;
}

// Parses a `--line` value of "a-b" or a single "a" into an inclusive,
// 1-based [start, end] pair.
function parseLineRange(value: string): [number, number] {
	const match = /^(\d+)(?:-(\d+))?$/.exec(value.trim());
	if (!match) {
		throw new Error(`Invalid --line value "${value}"; expected N or N-M`);
	}
	const start = Number(match[1]);
	const end = match[2] ? Number(match[2]) : start;
	if (start < 1 || end < start) {
		throw new Error(`Invalid --line range "${value}"`);
	}
	return [start, end];
}

export function registerGit(
	parent: Command,
	api: ApiClient,
	getFormat: () => "json" | "text",
): void {
	const git = parent.command("git").description("Git operations");

	git
		.command("status")
		.description("Show staged/unstaged changes")
		.option("--repo <name>", "Repository name")
		.action(async (opts: { repo?: string }) => {
			const params = new URLSearchParams();
			if (opts.repo) params.set("repo", opts.repo);
			const qs = params.toString();
			const data = await api.get(`/api/git/status${qs ? `?${qs}` : ""}`);
			output(data, getFormat());
		});

	git
		.command("diff")
		.description("Show unified diff for a file")
		.argument("<path>", "File path")
		.option("--staged", "Show staged diff", false)
		.option("--repo <name>", "Repository name")
		.action(
			async (filePath: string, opts: { staged: boolean; repo?: string }) => {
				const params = new URLSearchParams({ path: filePath });
				if (opts.staged) params.set("staged", "true");
				if (opts.repo) params.set("repo", opts.repo);
				const data = await api.get(`/api/git/diff?${params}`);
				output(data, getFormat());
			},
		);

	git
		.command("stage")
		.description("Stage a file's changes")
		.argument("<path>", "File path")
		.option(
			"--line <range>",
			"Stage only these lines, e.g. 12-14 or 40 (repeatable)",
			collectLine,
			[],
		)
		.option("--repo <name>", "Repository name")
		.action(
			async (filePath: string, opts: { line: string[]; repo?: string }) => {
				const params = new URLSearchParams();
				if (opts.repo) params.set("repo", opts.repo);
				const qs = params.toString();
				const body: { path: string; ranges?: [number, number][] } = {
					path: filePath,
				};
				if (opts.line.length > 0) {
					body.ranges = opts.line.map(parseLineRange);
				}
				const data = await api.post(
					`/api/git/stage${qs ? `?${qs}` : ""}`,
					body,
				);
				output(data, getFormat());
			},
		);

	git
		.command("unstage")
		.description("Unstage a file's changes")
		.argument("<path>", "File path")
		.option("--repo <name>", "Repository name")
		.action(async (filePath: string, opts: { repo?: string }) => {
			const params = new URLSearchParams();
			if (opts.repo) params.set("repo", opts.repo);
			const qs = params.toString();
			const data = await api.post(`/api/git/unstage${qs ? `?${qs}` : ""}`, {
				path: filePath,
			});
			output(data, getFormat());
		});

	git
		.command("log")
		.description("Show recent commits")
		.option("--limit <n>", "Number of commits", "25")
		.option("--offset <n>", "Skip commits", "0")
		.option("--repo <name>", "Repository name")
		.action(async (opts: { limit: string; offset: string; repo?: string }) => {
			const params = new URLSearchParams({
				limit: opts.limit,
				offset: opts.offset,
			});
			if (opts.repo) params.set("repo", opts.repo);
			const data = await api.get(`/api/git/log?${params}`);
			output(data, getFormat());
		});

	git
		.command("show")
		.description("Show commit details and changed files")
		.argument("<hash>", "Commit hash")
		.option("--repo <name>", "Repository name")
		.action(async (hash: string, opts: { repo?: string }) => {
			const params = new URLSearchParams();
			if (opts.repo) params.set("repo", opts.repo);
			const qs = params.toString();
			const data = await api.get(
				`/api/git/commit/${encodeURIComponent(hash)}${qs ? `?${qs}` : ""}`,
			);
			output(data, getFormat());
		});

	git
		.command("show-diff")
		.description("Show diff for a file within a commit")
		.argument("<hash>", "Commit hash")
		.argument("<path>", "File path")
		.option("--repo <name>", "Repository name")
		.action(async (hash: string, filePath: string, opts: { repo?: string }) => {
			const params = new URLSearchParams({ path: filePath });
			if (opts.repo) params.set("repo", opts.repo);
			const data = await api.get(
				`/api/git/commit/${encodeURIComponent(hash)}/diff?${params}`,
			);
			output(data, getFormat());
		});
}
