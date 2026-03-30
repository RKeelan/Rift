import { describe, expect, test } from "bun:test";
import path from "node:path";
import { inferReposRoot } from "../app.js";

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

	test("falls back to the home directory when cwd is outside home", () => {
		const reposRoot = inferReposRoot("/work/rift", "/home/richard");
		expect(reposRoot).toBe("/home/richard");
	});

	test("falls back to the home directory when cwd is the home directory", () => {
		const reposRoot = inferReposRoot("/home/richard", "/home/richard");
		expect(reposRoot).toBe("/home/richard");
	});
});
