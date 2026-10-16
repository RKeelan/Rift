import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ErrorBannerProvider } from "../components/ErrorBanner.tsx";
import { type TreeNode, useFileTree } from "../pages/FileTree.tsx";

const originalFetch = globalThis.fetch;

afterEach(() => {
	cleanup();
	globalThis.fetch = originalFetch;
});

function wrapper({ children }: { children: ReactNode }) {
	return <ErrorBannerProvider>{children}</ErrorBannerProvider>;
}

interface DirEntry {
	name: string;
	type: "file" | "directory";
	size: number;
}

const file = (name: string): DirEntry => ({ name, type: "file", size: 1 });
const folder = (name: string): DirEntry => ({
	name,
	type: "directory",
	size: 0,
});

// Answers each folder's listing from `folders`, as it stands when asked.
function serveFolders(folders: Record<string, DirEntry[]>) {
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const path =
			new URL(String(input), "http://localhost").searchParams.get("path") ??
			".";
		return new Response(
			JSON.stringify({ entries: folders[path] ?? [], truncated: false }),
			{ headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;
}

function find(nodes: TreeNode[], path: string): TreeNode {
	for (const node of nodes) {
		if (node.path === path) return node;
		if (node.children && path.startsWith(`${node.path}/`)) {
			return find(node.children, path);
		}
	}
	throw new Error(`no node ${path}`);
}

// A tree with src and src/lib open, docs read and closed.
async function renderTree(folders: Record<string, DirEntry[]>) {
	let renders = 0;
	serveFolders(folders);
	const hook = renderHook(
		() => {
			renders += 1;
			return useFileTree("root/one");
		},
		{ wrapper },
	);
	await waitFor(() => expect(hook.result.current.rootLoading).toBe(false));
	for (const path of ["docs", "src", "src/lib"]) {
		await act(() => hook.result.current.toggleDirectory(path));
	}
	await act(() => hook.result.current.toggleDirectory("docs"));
	return { ...hook, renders: () => renders };
}

const FOLDERS = () => ({
	".": [folder("docs"), folder("src"), file("README.md")],
	docs: [file("guide.md")],
	src: [folder("lib"), file("a.ts")],
	"src/lib": [file("b.ts")],
});

describe("useFileTree", () => {
	test("leaves the tree as it was when the folders read again are the same", async () => {
		const { result } = await renderTree(FOLDERS());
		const nodes = result.current.nodes;

		await act(() =>
			result.current.refreshDirectories([".", "docs", "src", "src/lib"]),
		);

		expect(result.current.nodes).toBe(nodes);
	});

	test("takes the folders read again in one update, keeping the nodes of those that read the same", async () => {
		const folders = FOLDERS();
		const { result, renders } = await renderTree(folders);
		const nodes = result.current.nodes;
		const before = renders();

		folders["src/lib"] = [file("b.ts"), file("c.ts")];
		folders["."] = [...folders["."], file("NEWS.md")];
		await act(() =>
			result.current.refreshDirectories([".", "docs", "src", "src/lib"]),
		);

		expect(renders()).toBe(before + 1);
		const after = result.current.nodes;
		expect(after.map((node) => node.name)).toEqual([
			"docs",
			"src",
			"README.md",
			"NEWS.md",
		]);
		expect(find(after, "src/lib").children?.map((node) => node.name)).toEqual([
			"b.ts",
			"c.ts",
		]);
		// Only the folders holding a change are new; the rest are as they were.
		expect(find(after, "docs")).toBe(find(nodes, "docs"));
		expect(find(after, "README.md")).toBe(find(nodes, "README.md"));
		expect(find(after, "src/a.ts")).toBe(find(nodes, "src/a.ts"));
		expect(find(after, "src/lib/b.ts")).toBe(find(nodes, "src/lib/b.ts"));
		expect(find(after, "src")).not.toBe(find(nodes, "src"));
	});
});
