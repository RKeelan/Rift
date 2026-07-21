import { describe, expect, test } from "bun:test";
import path from "node:path";
import { inferReposRoot, labelRoots, parseReposRoot } from "../app.js";

describe("parseReposRoot", () => {
	test("splits on the platform delimiter", () => {
		const roots = parseReposRoot(["/a/src", "/b/writing"].join(path.delimiter));
		expect(roots).toEqual(["/a/src", "/b/writing"]);
	});

	test("ignores blank and whitespace-only entries", () => {
		const roots = parseReposRoot(
			`  /a/src ${path.delimiter}${path.delimiter}   ${path.delimiter}/b `,
		);
		expect(roots).toEqual(["/a/src", "/b"]);
	});

	test("returns a single root unchanged", () => {
		expect(parseReposRoot("/a/src")).toEqual(["/a/src"]);
	});
});

describe("labelRoots", () => {
	test("names each root after its final segment", () => {
		const roots = labelRoots([
			path.join(path.sep, "home", "r", "Src", "RKeelan"),
			path.join(path.sep, "home", "r", "OneDrive", "Writing"),
		]);
		expect(roots.map((root) => root.label)).toEqual(["RKeelan", "Writing"]);
	});

	test("grows colliding labels leftward until they differ", () => {
		const roots = labelRoots([
			path.join(path.sep, "home", "r", "work", "repos"),
			path.join(path.sep, "home", "r", "play", "repos"),
		]);
		expect(roots.map((root) => root.label)).toEqual([
			"work-repos",
			"play-repos",
		]);
	});

	test("keeps labels distinct when the same path is listed twice", () => {
		const roots = labelRoots([
			path.join(path.sep, "home", "r", "Src"),
			path.join(path.sep, "home", "r", "Src"),
		]);
		expect(new Set(roots.map((root) => root.label)).size).toBe(2);
	});

	test("resolves each root to an absolute path", () => {
		for (const root of labelRoots(["."])) {
			expect(path.isAbsolute(root.path)).toBe(true);
		}
	});
});

describe("inferReposRoot", () => {
	test("infers a POSIX src directory", () => {
		const reposRoot = inferReposRoot(
			"/home/richard/src/rkeelan/rift",
			"/home/richard",
		);
		expect(reposRoot).toBe(path.posix.join("/home/richard", "src"));
	});

	test("infers a Windows src directory", () => {
		const reposRoot = inferReposRoot(
			"C:\\Users\\Richard\\src\\rkeelan\\rift",
			"C:\\Users\\Richard",
		);
		expect(reposRoot).toBe(path.win32.join("C:\\Users\\Richard", "src"));
	});

	test("matches source directories case-insensitively", () => {
		const reposRoot = inferReposRoot(
			"/home/richard/Source/rkeelan/rift",
			"/home/richard",
		);
		expect(reposRoot).toBe(path.posix.join("/home/richard", "Source"));
	});

	test("supports repos directories", () => {
		const reposRoot = inferReposRoot(
			"/home/richard/work/repos/rkeelan/rift",
			"/home/richard",
		);
		expect(reposRoot).toBe(path.posix.join("/home/richard", "work", "repos"));
	});

	test("uses the first matching source directory name", () => {
		const reposRoot = inferReposRoot(
			"/home/richard/src/archive/repos/rkeelan/rift",
			"/home/richard",
		);
		expect(reposRoot).toBe(path.posix.join("/home/richard", "src"));
	});

	test("returns null when cwd is outside home", () => {
		const reposRoot = inferReposRoot("/work/rift", "/home/richard");
		expect(reposRoot).toBeNull();
	});

	test("returns null when cwd is the home directory", () => {
		const reposRoot = inferReposRoot("/home/richard", "/home/richard");
		expect(reposRoot).toBeNull();
	});
});
