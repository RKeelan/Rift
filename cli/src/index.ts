#!/usr/bin/env bun
import { Command } from "commander";
import { ApiClient } from "./api.js";
import { registerFiles } from "./commands/files.js";
import { registerGit } from "./commands/git.js";
import { registerHealth } from "./commands/health.js";
import { registerRepos } from "./commands/repos.js";
import { outputError } from "./format.js";

const program = new Command();

program
	.name("rift")
	.description("CLI client for the Rift development server")
	.option(
		"--url <url>",
		"Server URL (env: RIFT_URL)",
		process.env.RIFT_URL || "http://localhost:3000",
	)
	.option("--format <format>", "Output format: json or text", "json");

function getFormat(): "json" | "text" {
	const opts = program.opts();
	return opts.format === "text" ? "text" : "json";
}

let cachedApi: ApiClient | null = null;

function getApi(): ApiClient {
	if (!cachedApi) {
		cachedApi = new ApiClient(program.opts().url);
	}
	return cachedApi;
}

// Lazily create the API client so global options are parsed first
const api = new Proxy({} as ApiClient, {
	get(_target, prop) {
		return (getApi() as unknown as Record<string | symbol, unknown>)[prop];
	},
});

registerHealth(program, api, getFormat);
registerRepos(program, api, getFormat);
registerFiles(program, api, getFormat);
registerGit(program, api, getFormat);

program.parseAsync().catch((err) => {
	outputError(err);
	process.exit(1);
});
