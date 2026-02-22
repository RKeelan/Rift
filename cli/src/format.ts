import { ApiError } from "./api.js";

type Format = "json" | "text";

interface DirEntry {
	name: string;
	type: "file" | "directory";
	size: number;
}

interface StatusEntry {
	path: string;
	status: string;
	staged: boolean;
}

function formatFileList(data: {
	entries: DirEntry[];
	truncated: boolean;
}): string {
	const lines = data.entries.map((e) => {
		const prefix = e.type === "directory" ? "d" : "-";
		const size = e.type === "file" ? `  ${e.size}` : "";
		return `${prefix} ${e.name}${size}`;
	});
	if (data.truncated) {
		lines.push("(truncated)");
	}
	return lines.join("\n");
}

function formatGitStatus(data: { files: StatusEntry[] }): string {
	const staged = data.files.filter((f) => f.staged);
	const unstaged = data.files.filter((f) => !f.staged);
	const lines: string[] = [];

	if (staged.length > 0) {
		lines.push("Staged:");
		for (const f of staged) {
			lines.push(`  ${f.status}  ${f.path}`);
		}
	}
	if (unstaged.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("Unstaged:");
		for (const f of unstaged) {
			lines.push(`  ${f.status}  ${f.path}`);
		}
	}
	if (lines.length === 0) {
		return "No changes";
	}
	return lines.join("\n");
}

function formatSession(data: Record<string, unknown>): string {
	const parts: string[] = [];
	if (data.id) parts.push(`id: ${data.id}`);
	if (data.state) parts.push(`state: ${data.state}`);
	if (data.workingDirectory) parts.push(`dir: ${data.workingDirectory}`);
	return parts.join("  ");
}

function formatSessionList(data: unknown[]): string {
	if (data.length === 0) return "No sessions";
	return data
		.map((s) => formatSession(s as Record<string, unknown>))
		.join("\n");
}

export function output(data: unknown, format: Format): void {
	if (format === "json") {
		process.stdout.write(`${JSON.stringify(data)}\n`);
		return;
	}

	// Session list (array at top level)
	if (Array.isArray(data)) {
		process.stdout.write(`${formatSessionList(data)}\n`);
		return;
	}

	// Text mode: format based on shape of data
	if (data && typeof data === "object") {
		const obj = data as Record<string, unknown>;

		// File listing
		if (Array.isArray(obj.entries)) {
			process.stdout.write(
				`${formatFileList(obj as { entries: DirEntry[]; truncated: boolean })}\n`,
			);
			return;
		}

		// Git status
		if (Array.isArray(obj.files)) {
			process.stdout.write(
				`${formatGitStatus(obj as { files: StatusEntry[] })}\n`,
			);
			return;
		}

		// Diff
		if (typeof obj.diff === "string") {
			process.stdout.write(`${obj.diff}\n`);
			return;
		}

		// File content
		if (typeof obj.content === "string") {
			process.stdout.write(`${obj.content}\n`);
			return;
		}

		// Health response
		if (obj.status && !obj.id) {
			const parts = [`status: ${obj.status}`];
			if (obj.gitRepo !== undefined) parts.push(`gitRepo: ${obj.gitRepo}`);
			process.stdout.write(`${parts.join("  ")}\n`);
			return;
		}

		// Single session
		if (obj.id || obj.state) {
			process.stdout.write(`${formatSession(obj)}\n`);
			return;
		}
	}

	// Fallback
	process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function outputLine(line: string): void {
	process.stdout.write(`${line}\n`);
}

export function outputError(err: unknown): void {
	if (err instanceof ApiError) {
		process.stderr.write(
			`${JSON.stringify({ error: { code: err.code, message: err.message } })}\n`,
		);
	} else if (err instanceof Error) {
		process.stderr.write(
			`${JSON.stringify({ error: { code: "ERROR", message: err.message } })}\n`,
		);
	} else {
		process.stderr.write(
			`${JSON.stringify({ error: { code: "ERROR", message: String(err) } })}\n`,
		);
	}
}
