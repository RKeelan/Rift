import { describe, expect, test } from "bun:test";
import path from "node:path";
import { inferReposRoot } from "../app.js";

describe("inferReposRoot", () => {
	test("infers a POSIX src directory", () => {
		const reposRoot = inferReposRoot(
			"/home/user/src/rkeelan/rift",
			"/home/user",
		);
		expect(reposRoot).toBe(path.posix.join("/home/user", "src"));
	});

	test("infers a Windows src directory", () => {
		const reposRoot = inferReposRoot(
			"C:\\Users\\User\\src\\rkeelan\\rift",
			"C:\\Users\\User",
		);
		expect(reposRoot).toBe(path.win32.join("C:\\Users\\User", "src"));
	});

	test("matches source directories case-insensitively", () => {
		const reposRoot = inferReposRoot(
			"/home/user/Source/rkeelan/rift",
			"/home/user",
		);
		expect(reposRoot).toBe(path.posix.join("/home/user", "Source"));
	});

	test("supports repos directories", () => {
		const reposRoot = inferReposRoot(
			"/home/user/work/repos/rkeelan/rift",
			"/home/user",
		);
		expect(reposRoot).toBe(path.posix.join("/home/user", "work", "repos"));
	});

	test("uses the first matching source directory name", () => {
		const reposRoot = inferReposRoot(
			"/home/user/src/archive/repos/rkeelan/rift",
			"/home/user",
		);
		expect(reposRoot).toBe(path.posix.join("/home/user", "src"));
	});

	test("returns null when cwd is outside home", () => {
		const reposRoot = inferReposRoot("/work/rift", "/home/user");
		expect(reposRoot).toBeNull();
	});

	test("returns null when cwd is the home directory", () => {
		const reposRoot = inferReposRoot("/home/user", "/home/user");
		expect(reposRoot).toBeNull();
	});
});
