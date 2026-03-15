import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useEffect } from "react";
import { ErrorBannerProvider } from "../components/ErrorBanner.tsx";
import { SessionProvider, useSession } from "../contexts/SessionContext.tsx";
import { FilesPage } from "../pages/FilesPage.tsx";

const originalFetch = globalThis.fetch;

afterEach(() => {
	cleanup();
	globalThis.fetch = originalFetch;
});

// Test wrapper that selects a repository
function TestWrapper({ children }: { children: React.ReactNode }) {
	const { selectRepo } = useSession();
	useEffect(() => {
		selectRepo("test-repo");
	}, [selectRepo]);
	return <>{children}</>;
}

function renderFilesPage() {
	return render(
		<ErrorBannerProvider>
			<SessionProvider>
				<TestWrapper>
					<FilesPage />
				</TestWrapper>
			</SessionProvider>
		</ErrorBannerProvider>,
	);
}

/**
 * Creates a mock fetch that returns a directory listing for the root path
 * and optionally handles other URLs via a custom handler.
 */
function mockFetchForTree(
	rootEntries: Array<{ name: string; type: string; size: number }>,
	options?: {
		truncated?: boolean;
		subdir?: {
			path: string;
			entries: Array<{ name: string; type: string; size: number }>;
		};
		fileContent?: { path: string; content: string };
		fileError?: {
			path: string;
			status: number;
			error: { code: string; message: string };
		};
	},
) {
	globalThis.fetch = mock((input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();

		// Directory listing
		if (url.includes("/api/files?") || url === "/api/files") {
			const urlObj = new URL(url, "http://localhost");
			const dirPath = urlObj.searchParams.get("path") || ".";

			if (options?.subdir && dirPath === options.subdir.path) {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							entries: options.subdir.entries,
							truncated: false,
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			}

			// Root listing
			return Promise.resolve(
				new Response(
					JSON.stringify({
						entries: rootEntries,
						truncated: options?.truncated ?? false,
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			);
		}

		// File content
		if (url.includes("/api/files/content")) {
			if (options?.fileError) {
				const urlObj = new URL(url, "http://localhost");
				const filePath = urlObj.searchParams.get("path") || "";
				if (filePath === options.fileError.path) {
					return Promise.resolve(
						new Response(JSON.stringify({ error: options.fileError.error }), {
							status: options.fileError.status,
							headers: { "Content-Type": "application/json" },
						}),
					);
				}
			}
			if (options?.fileContent) {
				return Promise.resolve(
					new Response(options.fileContent.content, {
						status: 200,
						headers: { "Content-Type": "text/plain" },
					}),
				);
			}
		}

		return Promise.resolve(new Response("Not found", { status: 404 }));
	}) as typeof fetch;
}

describe("FilesPage", () => {
	test("renders loading state initially", () => {
		// Fetch that never resolves to keep loading state
		globalThis.fetch = mock(() => new Promise(() => {})) as typeof fetch;

		const { container } = renderFilesPage();
		const loading = container.querySelector(".files-message");
		expect(loading).not.toBeNull();
		expect(loading?.textContent).toBe("Loading...");
	});

	test("renders file tree entries after loading", async () => {
		mockFetchForTree([
			{ name: "src", type: "directory", size: 0 },
			{ name: "README.md", type: "file", size: 100 },
		]);

		const { container } = renderFilesPage();

		await waitFor(() => {
			const entries = container.querySelectorAll(".tree-entry");
			expect(entries.length).toBe(2);
		});

		const entryNames = container.querySelectorAll(".tree-entry-name");
		expect(entryNames[0]?.textContent).toBe("src");
		expect(entryNames[1]?.textContent).toBe("README.md");
	});

	test("renders empty state when directory is empty", async () => {
		mockFetchForTree([]);

		const { container } = renderFilesPage();

		await waitFor(() => {
			const msg = container.querySelector(".files-message");
			expect(msg).not.toBeNull();
			expect(msg?.textContent).toBe("No files found");
		});
	});

	test("shows truncation notice when directory exceeds limit", async () => {
		mockFetchForTree([{ name: "file.txt", type: "file", size: 10 }], {
			truncated: true,
		});

		const { container } = renderFilesPage();

		await waitFor(() => {
			const truncMsg = container.querySelector(".files-truncated");
			expect(truncMsg).not.toBeNull();
			expect(truncMsg?.textContent).toContain("more than 1,000");
		});
	});

	test("expands directory on click and shows children", async () => {
		mockFetchForTree(
			[
				{ name: "src", type: "directory", size: 0 },
				{ name: "README.md", type: "file", size: 100 },
			],
			{
				subdir: {
					path: "src",
					entries: [
						{ name: "index.ts", type: "file", size: 50 },
						{ name: "app.ts", type: "file", size: 75 },
					],
				},
			},
		);

		const { container } = renderFilesPage();

		// Wait for tree to load
		await waitFor(() => {
			expect(container.querySelectorAll(".tree-entry").length).toBe(2);
		});

		// Click on the "src" directory
		const srcEntry = container.querySelectorAll(".tree-entry")[0] as Element;
		await act(async () => {
			fireEvent.click(srcEntry);
		});

		// Wait for children to load
		await waitFor(() => {
			const entries = container.querySelectorAll(".tree-entry");
			// src + README.md + index.ts + app.ts = 4
			expect(entries.length).toBe(4);
		});

		// Verify child entries are present
		const allNames = Array.from(
			container.querySelectorAll(".tree-entry-name"),
		).map((el) => el.textContent);
		expect(allNames).toContain("index.ts");
		expect(allNames).toContain("app.ts");
	});

	test("opens file viewer when file is clicked", async () => {
		mockFetchForTree([{ name: "hello.txt", type: "file", size: 20 }], {
			fileContent: { path: "hello.txt", content: "Hello, world!" },
		});

		const { container } = renderFilesPage();

		// Wait for tree to load
		await waitFor(() => {
			expect(container.querySelectorAll(".tree-entry").length).toBe(1);
		});

		// Click on the file
		const fileEntry = container.querySelector(".tree-entry") as Element;
		await act(async () => {
			fireEvent.click(fileEntry);
		});

		// Should switch to file viewer with breadcrumbs and back button
		await waitFor(() => {
			const viewer = container.querySelector(".file-viewer");
			expect(viewer).not.toBeNull();
		});

		// Back button should be present
		const backButton = screen.getByLabelText("Back to file tree");
		expect(backButton).not.toBeNull();

		// Breadcrumbs should show the filename
		const breadcrumbs = container.querySelector(".breadcrumbs");
		expect(breadcrumbs?.textContent).toContain("hello.txt");

		const saveButton = screen.getByRole("button", { name: "Save" });
		expect(saveButton).not.toBeNull();
	});

	test("renders error message for binary file", async () => {
		mockFetchForTree([{ name: "image.bin", type: "file", size: 500 }], {
			fileError: {
				path: "image.bin",
				status: 415,
				error: {
					code: "BINARY_FILE",
					message: "Binary files are not supported",
				},
			},
		});

		const { container } = renderFilesPage();

		// Wait for tree to load, then click the file
		await waitFor(() => {
			expect(container.querySelectorAll(".tree-entry").length).toBe(1);
		});

		await act(async () => {
			fireEvent.click(container.querySelector(".tree-entry") as Element);
		});

		// Should show error message
		await waitFor(() => {
			const error = container.querySelector(".text-file-editor-error");
			expect(error).not.toBeNull();
			expect(error?.textContent).toContain("Binary files are not supported");
		});
	});

	test("renders error message for oversized file", async () => {
		mockFetchForTree([{ name: "huge.log", type: "file", size: 2000000 }], {
			fileError: {
				path: "huge.log",
				status: 413,
				error: {
					code: "FILE_TOO_LARGE",
					message: "File exceeds maximum size of 1 MB",
				},
			},
		});

		const { container } = renderFilesPage();

		await waitFor(() => {
			expect(container.querySelectorAll(".tree-entry").length).toBe(1);
		});

		await act(async () => {
			fireEvent.click(container.querySelector(".tree-entry") as Element);
		});

		await waitFor(() => {
			const error = container.querySelector(".text-file-editor-error");
			expect(error).not.toBeNull();
			expect(error?.textContent).toContain("File exceeds maximum size");
		});
	});

	test("back button returns to file tree from viewer", async () => {
		mockFetchForTree([{ name: "readme.md", type: "file", size: 30 }], {
			fileContent: { path: "readme.md", content: "# Hello" },
		});

		const { container } = renderFilesPage();

		// Wait for tree to load, then click file
		await waitFor(() => {
			expect(container.querySelectorAll(".tree-entry").length).toBe(1);
		});

		await act(async () => {
			fireEvent.click(container.querySelector(".tree-entry") as Element);
		});

		// Wait for viewer to appear
		await waitFor(() => {
			expect(container.querySelector(".file-viewer")).not.toBeNull();
		});

		// Click back button
		const backButton = screen.getByLabelText("Back to file tree");
		await act(async () => {
			fireEvent.click(backButton);
		});

		// Should be back at the tree
		await waitFor(() => {
			expect(container.querySelector(".files-page")).not.toBeNull();
			expect(container.querySelector(".file-viewer")).toBeNull();
		});
	});
});
