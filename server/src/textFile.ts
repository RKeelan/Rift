import type { Stats } from "node:fs";
import fs from "node:fs/promises";

/** The largest file the editor opens or saves. */
export const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
// How much of a file is read for a NUL that marks it binary.
const BINARY_CHECK_SIZE = 8192; // 8 KB

/** A file's text and the stat taken as it was read. */
export interface TextFileInfo {
	content: string;
	stat: Stats;
}

/** A request an endpoint refuses: the status it answers with, and why. */
export interface Refusal {
	status: number;
	error: { code: string; message: string };
}

async function isBinaryFile(filePath: string): Promise<boolean> {
	const handle = await fs.open(filePath, "r");
	try {
		const buffer = Buffer.alloc(BINARY_CHECK_SIZE);
		const { bytesRead } = await handle.read(buffer, 0, BINARY_CHECK_SIZE, 0);
		for (let i = 0; i < bytesRead; i++) {
			if (buffer[i] === 0) return true;
		}
		return false;
	} finally {
		await handle.close();
	}
}

function isNotFoundError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err && err.code === "ENOENT";
}

/**
 * A file's text as GET /api/files/content answers with it, read as UTF-8, a
 * leading byte order mark and all, with the stat whose modification time
 * goes with it, or the endpoint's refusal: a directory, a file too large or
 * binary to edit, or none at all.
 */
export async function readTextFile(
	resolved: string,
): Promise<TextFileInfo | Refusal> {
	try {
		const stat = await fs.stat(resolved);

		if (stat.isDirectory()) {
			return {
				status: 400,
				error: {
					code: "IS_DIRECTORY",
					message: "The specified path is a directory, not a file",
				},
			};
		}

		if (stat.size > MAX_FILE_SIZE) {
			return {
				status: 413,
				error: {
					code: "FILE_TOO_LARGE",
					message: `File exceeds maximum size of ${MAX_FILE_SIZE / (1024 * 1024)} MB`,
				},
			};
		}

		if (await isBinaryFile(resolved)) {
			return {
				status: 415,
				error: {
					code: "BINARY_FILE",
					message: "Binary files are not supported",
				},
			};
		}

		const content = await fs.readFile(resolved, "utf-8");
		return { content, stat };
	} catch (err) {
		if (isNotFoundError(err)) {
			return {
				status: 404,
				error: { code: "NOT_FOUND", message: "File not found" },
			};
		}
		throw err;
	}
}
