import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { useEffect } from "react";
import {
	MemoryRouter,
	Route,
	Routes,
	useLocation,
	useNavigate,
} from "react-router-dom";
import { ErrorBannerProvider } from "../components/ErrorBanner.tsx";
import { SessionProvider, useSession } from "../contexts/SessionContext.tsx";
import { FilesPage } from "../pages/FilesPage.tsx";

const originalFetch = globalThis.fetch;

afterEach(() => {
	cleanup();
	globalThis.fetch = originalFetch;
	// Unsaved edits are kept as drafts in local storage.
	globalThis.localStorage.clear();
});

// Test wrapper that selects a repository
function TestWrapper({ children }: { children: React.ReactNode }) {
	const { selectRepo } = useSession();
	useEffect(() => {
		selectRepo("test-repo");
	}, [selectRepo]);
	return <>{children}</>;
}

function RouterHarness({ children }: { children: React.ReactNode }) {
	const location = useLocation();
	const navigate = useNavigate();

	return (
		<>
			<div data-testid="location-search">{location.search}</div>
			<button type="button" onClick={() => navigate(-1)}>
				History back
			</button>
			{children}
		</>
	);
}

interface DirEntry {
	name: string;
	type: "file" | "directory";
	size: number;
}

type Listing = DirEntry[] | { entries: DirEntry[]; truncated: boolean };

// The folders the tree reads, by path, with "." for the top one. A promise
// holds a listing back until it settles.
type Folders = Record<string, Listing | Promise<Listing>>;

const file = (name: string): DirEntry => ({ name, type: "file", size: 1 });
const folder = (name: string): DirEntry => ({
	name,
	type: "directory",
	size: 0,
});

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * Renders the page, which reads the tree's top folder whenever it renders.
 * Folder listings are answered from `folders`, and every other request goes
 * to the fetch the test has set up. `listed` gathers the folders read.
 */
function renderFilesPage(
	initialEntries = ["/files"],
	props: { writesAllowed?: boolean | null } = {},
	folders: Folders = { ".": [] },
) {
	const answer = globalThis.fetch;
	const listed: string[] = [];
	globalThis.fetch = mock(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (!url.includes("/api/files?")) return answer(input, init);
			const path =
				new URL(url, "http://localhost").searchParams.get("path") ?? ".";
			listed.push(path);
			const listing = await folders[path];
			if (!listing) {
				return json(
					{ error: { code: "NOT_FOUND", message: "Directory not found" } },
					404,
				);
			}
			return json(
				Array.isArray(listing)
					? { entries: listing, truncated: false }
					: listing,
			);
		},
	) as typeof fetch;
	// Selected before the page first renders, as the app selects it before
	// opening the page, so each request is made once, for the right repo.
	globalThis.localStorage.setItem("rift:selected-repo", "test-repo");
	const result = render(
		<MemoryRouter initialEntries={initialEntries}>
			<ErrorBannerProvider>
				<SessionProvider>
					<Routes>
						<Route
							path="/files"
							element={
								<RouterHarness>
									<TestWrapper>
										<FilesPage {...props} />
									</TestWrapper>
								</RouterHarness>
							}
						/>
					</Routes>
				</SessionProvider>
			</ErrorBannerProvider>
		</MemoryRouter>,
	);
	return { ...result, listed };
}

// Whether the list is on screen, with no file open over it. The list stays
// mounted behind an open file, hidden.
function listShown(container: HTMLElement) {
	return (
		container.querySelector(".changes-page:not(.changes-page--hidden)") !==
			null &&
		container.querySelector(".changes-diff-view, .file-viewer") === null
	);
}

// The names in the tree, in the order shown.
function treeNames(container: HTMLElement) {
	return [...container.querySelectorAll(".tree-entry-name")].map(
		(name) => name.textContent,
	);
}

function sectionHeaders(container: HTMLElement) {
	return [...container.querySelectorAll(".changes-section-header")].map(
		(header) => header.textContent,
	);
}

interface StatusFile {
	path: string;
	status: string;
	staged: boolean;
}

/**
 * Creates a mock fetch that returns a status response for /api/git/status
 * and optionally handles diff requests for /api/git/diff.
 */
function mockFetchForChanges(
	files: StatusFile[],
	options?: {
		notGitRepo?: boolean;
		diff?: { path: string; diff: string; truncated: boolean; exact?: boolean };
		baseContent?: { path: string; content: string; staged?: boolean };
		fileContent?: { path: string; content: string; mtimeMs?: number };
	},
) {
	globalThis.fetch = mock((input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();

		// Status endpoint
		if (url.includes("/api/git/status")) {
			if (options?.notGitRepo) {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							error: {
								code: "NOT_GIT_REPO",
								message: "The working directory is not a git repository",
							},
						}),
						{
							status: 400,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			}

			return Promise.resolve(
				new Response(JSON.stringify({ files }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}

		// Diff endpoint
		if (url.includes("/api/git/diff")) {
			if (options?.diff) {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							diff: options.diff.diff,
							truncated: options.diff.truncated,
							exact: options.diff.exact,
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			}

			return Promise.resolve(
				new Response(JSON.stringify({ diff: "", truncated: false }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}

		if (url.includes("/api/git/base-content")) {
			if (options?.baseContent) {
				return Promise.resolve(
					new Response(options.baseContent.content, {
						status: 200,
						headers: { "Content-Type": "text/plain" },
					}),
				);
			}

			return Promise.resolve(new Response("Not found", { status: 404 }));
		}

		if (url.includes("/api/files/content") && options?.fileContent) {
			return Promise.resolve(
				new Response(options.fileContent.content, {
					status: 200,
					headers: {
						"Content-Type": "text/plain",
						"x-file-mtime-ms": String(options.fileContent.mtimeMs ?? 1),
					},
				}),
			);
		}

		return Promise.resolve(new Response("Not found", { status: 404 }));
	}) as typeof fetch;
}

// The action bar of the editor on screen.
function editorBar(container: HTMLElement) {
	const bar = container.querySelector<HTMLElement>(
		".changes-editor-view:not(.changes-editor-view--hidden) .text-file-editor-bar",
	);
	if (!bar) throw new Error("no editor bar");
	return bar;
}

// Waits for an editable buffer, with the page's whole-file action offered in
// the editor's bar.
async function findEditableEditor(container: HTMLElement) {
	await waitFor(() => {
		expect(
			container.querySelector(".cm-content")?.getAttribute("contenteditable"),
		).toBe("true");
		expect(
			within(editorBar(container)).getByRole("button", { name: "Stage file" }),
		).not.toBeNull();
	});
}

describe("FilesPage", () => {
	test("renders loading state initially", () => {
		globalThis.fetch = mock(() => new Promise(() => {})) as typeof fetch;

		const { container } = renderFilesPage();
		const loading = container.querySelector(".changes-message");
		expect(loading).not.toBeNull();
		expect(loading?.textContent).toBe("Loading...");
	});

	test("renders empty state when working tree is clean", async () => {
		mockFetchForChanges([]);

		const { container } = renderFilesPage();

		await waitFor(() => {
			const msg = container.querySelector(".changes-message");
			expect(msg).not.toBeNull();
			expect(msg?.textContent).toBe("Working tree clean");
		});
	});

	test("shows only the tree for a directory without git", async () => {
		mockFetchForChanges([], { notGitRepo: true });

		const { container } = renderFilesPage(
			["/files"],
			{},
			{
				".": [folder("src"), file("notes.txt")],
			},
		);

		await waitFor(() => {
			expect(treeNames(container)).toEqual(["src", "notes.txt"]);
		});
		expect(sectionHeaders(container)).toEqual([]);
		expect(container.querySelector(".changes-message") === null).toBe(true);
	});

	test("renders staged files under Staged section header", async () => {
		mockFetchForChanges([
			{ path: "src/app.ts", status: "modified", staged: true },
			{ path: "README.md", status: "added", staged: true },
		]);

		const { container } = renderFilesPage();

		await waitFor(() => {
			const headers = container.querySelectorAll(".changes-section-header");
			expect(headers.length).toBeGreaterThanOrEqual(1);
			expect(headers[0]?.textContent).toContain("Staged");
		});

		const fileEntries = container.querySelectorAll(".changes-file-entry");
		expect(fileEntries.length).toBe(2);

		const filePaths = container.querySelectorAll(".changes-file-path");
		const pathTexts = Array.from(filePaths).map((el) => el.textContent);
		expect(pathTexts).toContain("src/app.ts");
		expect(pathTexts).toContain("README.md");
	});

	test("renders unstaged files under Unstaged section header", async () => {
		mockFetchForChanges([
			{ path: "index.ts", status: "modified", staged: false },
		]);

		const { container } = renderFilesPage();

		await waitFor(() => {
			expect(sectionHeaders(container)).toEqual(["Unstaged1", "Unchanged"]);
		});

		const filePaths = container.querySelectorAll(".changes-file-path");
		expect(filePaths[0]?.textContent).toBe("index.ts");
	});

	test("renders both staged and unstaged sections", async () => {
		mockFetchForChanges([
			{ path: "staged.ts", status: "added", staged: true },
			{ path: "unstaged.ts", status: "modified", staged: false },
		]);

		const { container } = renderFilesPage();

		await waitFor(() => {
			expect(sectionHeaders(container)).toEqual([
				"Staged1",
				"Unstaged1",
				"Unchanged",
			]);
		});
	});

	test("renders correct status badges", async () => {
		mockFetchForChanges([
			{ path: "added.ts", status: "added", staged: true },
			{ path: "modified.ts", status: "modified", staged: false },
			{ path: "deleted.ts", status: "deleted", staged: false },
			{ path: "renamed.ts", status: "renamed", staged: true },
			{ path: "untracked.ts", status: "untracked", staged: false },
		]);

		const { container } = renderFilesPage();

		await waitFor(() => {
			const badges = container.querySelectorAll(".changes-badge");
			expect(badges.length).toBe(5);
		});

		const badges = container.querySelectorAll(".changes-badge");
		const badgeTexts = Array.from(badges).map((el) => el.textContent);
		expect(badgeTexts).toContain("A");
		expect(badgeTexts).toContain("M");
		expect(badgeTexts).toContain("D");
		expect(badgeTexts).toContain("R");
		expect(badgeTexts).toContain("U");

		// Check CSS class for colour coding
		const addedBadge = container.querySelector(".changes-badge--added");
		expect(addedBadge).not.toBeNull();
		const modifiedBadge = container.querySelector(".changes-badge--modified");
		expect(modifiedBadge).not.toBeNull();
		const deletedBadge = container.querySelector(".changes-badge--deleted");
		expect(deletedBadge).not.toBeNull();
	});

	test("opens a deleted file read-only in the editor", async () => {
		mockFetchForChanges(
			[{ path: "file.ts", status: "deleted", staged: false }],
			{
				baseContent: {
					path: "file.ts",
					content: "const gone = true;\n",
				},
			},
		);

		const { container } = renderFilesPage();

		await waitFor(() => {
			expect(container.querySelectorAll(".changes-file-entry").length).toBe(1);
		});

		await act(async () => {
			fireEvent.click(
				container.querySelector(".changes-file-entry") as Element,
			);
		});

		await waitFor(() => {
			expect(container.querySelector(".changes-diff-view")).not.toBeNull();
		});

		// The deleted file's former content opens struck through, with no raw diff
		// viewer and no Save control.
		await waitFor(() => {
			expect(
				container.querySelector(".cm-changedLine--deleted"),
			).not.toBeNull();
		});
		expect(container.querySelector(".cm-content")?.textContent).toContain(
			"const gone = true;",
		);
		expect(container.querySelector(".diff-viewer")).toBeNull();
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
	});

	test("opens an untracked file in the editor with every line added", async () => {
		mockFetchForChanges(
			[{ path: "scratch.txt", status: "untracked", staged: false }],
			{
				diff: {
					path: "scratch.txt",
					diff: "@@ -0,0 +1,2 @@\n+draft line 1\n+draft line 2\n",
					truncated: false,
				},
				fileContent: {
					path: "scratch.txt",
					content: "draft line 1\ndraft line 2\n",
				},
			},
		);

		const { container } = renderFilesPage();

		await waitFor(() => {
			expect(container.querySelectorAll(".changes-file-entry").length).toBe(1);
		});

		await act(async () => {
			fireEvent.click(
				container.querySelector(".changes-file-entry") as Element,
			);
		});

		await findEditableEditor(container);
		expect(screen.queryByRole("button", { name: "Show diff" })).toBeNull();

		// Its lines come from its diff against nothing, so each can be picked.
		await waitFor(() => {
			expect(
				[...container.querySelectorAll<HTMLElement>(".cm-pickTarget")].map(
					(target) => target.dataset.pickLine,
				),
			).toEqual(["1", "2"]);
		});
		expect(container.querySelectorAll(".cm-changedLine--added").length).toBe(2);
		const { calls } = (
			globalThis.fetch as unknown as { mock: { calls: [string][] } }
		).mock;
		expect(
			calls.some(
				([url]) =>
					url.includes("/api/git/diff") && url.includes("untracked=true"),
			),
		).toBe(true);
		expect(container.querySelector(".diff-viewer")).toBeNull();
	});

	test("shows the file's name, and which side of it is open", async () => {
		mockFetchForChanges(
			[{ path: "src/utils.ts", status: "modified", staged: true }],
			{
				diff: {
					path: "src/utils.ts",
					diff: "some diff",
					truncated: false,
				},
			},
		);

		const { container } = renderFilesPage();

		await waitFor(() => {
			expect(container.querySelectorAll(".changes-file-entry").length).toBe(1);
		});

		fireEvent.click(container.querySelector(".changes-file-entry") as Element);

		await waitFor(() => {
			const filename = container.querySelector(".changes-diff-filename");
			expect(filename).not.toBeNull();
			expect(filename?.textContent).toBe("src/utils.ts");
		});

		expect(
			screen.getByRole("tab", { name: "Staged" }).getAttribute("aria-selected"),
		).toBe("true");
	});

	test("opens editable files directly in the editor", async () => {
		mockFetchForChanges(
			[{ path: "src/utils.ts", status: "modified", staged: false }],
			{
				baseContent: {
					path: "src/utils.ts",
					content: "export const value = 0;\n",
				},
				diff: {
					path: "src/utils.ts",
					diff: "@@ -1 +1 @@\n-export const value = 0;\n+export const value = 1;\n",
					truncated: false,
				},
				fileContent: {
					path: "src/utils.ts",
					content: "export const value = 1;\n",
				},
			},
		);

		const { container } = renderFilesPage();

		await waitFor(() => {
			expect(screen.getByText("src/utils.ts")).not.toBeNull();
		});

		await act(async () => {
			fireEvent.click(screen.getByText("src/utils.ts"));
		});

		await findEditableEditor(container);
		expect(screen.queryByRole("button", { name: "Show diff" }) === null).toBe(
			true,
		);
		expect(screen.queryByRole("button", { name: "Show file" }) === null).toBe(
			true,
		);

		await waitFor(() => {
			expect(container.querySelector(".cm-changedLine--added")).not.toBeNull();
		});

		await waitFor(() => {
			const deletedLines = Array.from(
				container.querySelectorAll(".cm-deletedChunkLine"),
			).map((element) => element.textContent ?? "");
			expect(
				deletedLines.some((line) => line.includes("export const value = 0;")),
			).toBe(true);
		});
	});

	test("opens the editor with an empty base when no base version exists", async () => {
		mockFetchForChanges(
			[{ path: "src/added.ts", status: "modified", staged: false }],
			{
				diff: {
					path: "src/added.ts",
					diff: "@@ -0,0 +1 @@\n+export const value = 1;\n",
					truncated: false,
				},
				fileContent: {
					path: "src/added.ts",
					content: "export const value = 1;\n",
				},
			},
		);

		const { container } = renderFilesPage();

		await waitFor(() => {
			expect(screen.getByText("src/added.ts")).not.toBeNull();
		});

		await act(async () => {
			fireEvent.click(screen.getByText("src/added.ts"));
		});

		await findEditableEditor(container);

		expect(screen.queryByRole("alert")).toBeNull();
		expect(container.querySelector(".cm-deletedChunkLine")).toBeNull();
	});

	test("shows deleted unstaged lines in the editor view", async () => {
		const deletedLine =
			"bun run tailscale && REPOS_ROOT=/path/to/repos bun run prod";
		mockFetchForChanges(
			[{ path: "README.md", status: "modified", staged: false }],
			{
				baseContent: {
					path: "README.md",
					content: `Set \`REPOS_ROOT\` explicitly for production in the same way:\n\n${deletedLine}\n\`\`\`\n`,
				},
				diff: {
					path: "README.md",
					diff: `@@ -1,3 +1,2 @@\n Set \`REPOS_ROOT\` explicitly for production in the same way:\n-\n-${deletedLine}\n \`\`\`\n`,
					truncated: false,
				},
				fileContent: {
					path: "README.md",
					content:
						"Set `REPOS_ROOT` explicitly for production in the same way:\n```\n",
				},
			},
		);

		const { container } = renderFilesPage();

		await waitFor(() => {
			expect(screen.getByText("README.md")).not.toBeNull();
		});

		await act(async () => {
			fireEvent.click(screen.getByText("README.md"));
		});

		await findEditableEditor(container);

		await waitFor(() => {
			const deletedLines = Array.from(
				container.querySelectorAll(".cm-deletedChunkLine"),
			).map((element) => element.textContent ?? "");
			expect(deletedLines.some((line) => line.includes(deletedLine))).toBe(
				true,
			);
		});
	});

	test("opens staged files in the unstage editor", async () => {
		mockFetchForChanges(
			[{ path: "src/utils.ts", status: "modified", staged: true }],
			{
				baseContent: {
					path: "src/utils.ts",
					content: "export const value = 0;\n",
				},
				diff: {
					path: "src/utils.ts",
					diff: "@@ -1 +1 @@\n-export const value = 0;\n+export const value = 1;\n",
					truncated: false,
				},
			},
		);

		const { container } = renderFilesPage();

		await waitFor(() => {
			expect(screen.getByText("src/utils.ts")).not.toBeNull();
		});

		await act(async () => {
			fireEvent.click(screen.getByText("src/utils.ts"));
		});

		// A staged file opens read-only against the index: the editor loads, but
		// there is no Save button.
		await waitFor(() => {
			expect(container.querySelector(".cm-content")).not.toBeNull();
		});
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Show file" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Show diff" })).toBeNull();
	});

	test("back button returns to the list from a file", async () => {
		mockFetchForChanges(
			[{ path: "app.ts", status: "modified", staged: false }],
			{
				baseContent: {
					path: "app.ts",
					content: "previous\n",
				},
				diff: {
					path: "app.ts",
					diff: "diff content",
					truncated: false,
				},
			},
		);

		const { container } = renderFilesPage();

		await waitFor(() => {
			expect(container.querySelectorAll(".changes-file-entry").length).toBe(1);
		});

		// Click file to go to diff view
		fireEvent.click(container.querySelector(".changes-file-entry") as Element);

		await waitFor(() => {
			expect(container.querySelector(".changes-diff-view")).not.toBeNull();
		});

		// Click back button
		const backButton = screen.getByLabelText("Back to file list");
		fireEvent.click(backButton);

		// Should be back to the list
		await waitFor(() => {
			expect(listShown(container)).toBe(true);
		});
	});

	test("browser back returns to the list from a file", async () => {
		mockFetchForChanges(
			[{ path: "app.ts", status: "modified", staged: false }],
			{
				baseContent: {
					path: "app.ts",
					content: "previous\n",
				},
				diff: {
					path: "app.ts",
					diff: "diff content",
					truncated: false,
				},
			},
		);

		const { container } = renderFilesPage();

		await waitFor(() => {
			expect(container.querySelectorAll(".changes-file-entry").length).toBe(1);
		});

		fireEvent.click(container.querySelector(".changes-file-entry") as Element);

		await waitFor(() => {
			expect(container.querySelector(".changes-diff-view")).not.toBeNull();
			expect(screen.getByTestId("location-search").textContent).toContain(
				"path=app.ts",
			);
		});

		fireEvent.click(screen.getByText("History back"));

		await waitFor(() => {
			expect(listShown(container)).toBe(true);
			expect(screen.getByTestId("location-search").textContent).toBe("");
		});
	});

	test("does not refetch the diff on a status refresh while the editor is open", async () => {
		let diffRequests = 0;

		globalThis.fetch = mock((input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();

			if (url.includes("/api/git/status")) {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							files: [{ path: "app.ts", status: "modified", staged: false }],
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			}

			if (url.includes("/api/git/diff")) {
				diffRequests += 1;
				return Promise.resolve(
					new Response(
						JSON.stringify({ diff: "diff content", truncated: false }),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			}

			if (url.includes("/api/git/base-content")) {
				return Promise.resolve(
					new Response("previous\n", {
						status: 200,
						headers: { "Content-Type": "text/plain" },
					}),
				);
			}

			if (url.includes("/api/files/content")) {
				return Promise.resolve(
					new Response("current\n", {
						status: 200,
						headers: {
							"Content-Type": "text/plain",
							"x-file-mtime-ms": "1",
						},
					}),
				);
			}

			return Promise.resolve(new Response("Not found", { status: 404 }));
		}) as typeof fetch;

		const { container } = renderFilesPage();

		await waitFor(() => {
			expect(container.querySelectorAll(".changes-file-entry").length).toBe(1);
		});

		fireEvent.click(container.querySelector(".changes-file-entry") as Element);

		// The editor fetches the diff once to decorate its changes.
		await findEditableEditor(container);
		await waitFor(() => {
			expect(diffRequests).toBe(1);
		});

		// A visibility change would normally refresh status, but the poll is
		// skipped while an editor is open, so the diff is not refetched.
		fireEvent(document, new Event("visibilitychange"));

		await waitFor(() => {
			expect(diffRequests).toBe(1);
		});
	});

	describe("with unsaved edits", () => {
		async function openAndEdit() {
			mockFetchForChanges(
				[{ path: "app.ts", status: "modified", staged: false }],
				{
					baseContent: { path: "app.ts", content: "previous\n" },
					diff: {
						path: "app.ts",
						diff: "@@ -1 +1 @@\n-previous\n+current\n",
						truncated: false,
					},
					fileContent: { path: "app.ts", content: "current\n" },
				},
			);
			const result = renderFilesPage();
			await waitFor(() => {
				expect(
					result.container.querySelectorAll(".changes-file-entry").length,
				).toBe(1);
			});
			fireEvent.click(
				result.container.querySelector(".changes-file-entry") as Element,
			);
			await waitFor(() => {
				expect(result.container.querySelector(".cm-content")).not.toBeNull();
			});

			const { EditorView } = await import("@codemirror/view");
			const view = EditorView.findFromDOM(
				result.container.querySelector(".cm-editor") as HTMLElement,
			);
			act(() => {
				view?.dispatch({ changes: { from: 0, insert: "edited " } });
			});
			await screen.findByText("Unsaved changes");
			return result;
		}

		test("asks before leaving the file", async () => {
			const { container } = await openAndEdit();
			const back = screen.getByRole("button", {
				name: "Back to file list",
			});

			fireEvent.click(back);

			expect(await screen.findByText("Discard unsaved changes?")).toBeDefined();
			expect(container.querySelector(".cm-content") === null).toBe(false);

			// Keeping the edits leaves the editor as it was.
			fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
			expect(screen.queryByText("Discard unsaved changes?") === null).toBe(
				true,
			);
			expect(container.querySelector(".cm-content") === null).toBe(false);

			fireEvent.click(back);
			fireEvent.click(await screen.findByRole("button", { name: "Discard" }));

			await waitFor(() => {
				expect(screen.getByTestId("location-search").textContent).toBe("");
			});
			expect(container.querySelector(".cm-content") === null).toBe(true);
		});

		test("offers Save rather than staging the file as saved", async () => {
			const { container } = await openAndEdit();

			// Staging the whole file acts on the file as saved, not as shown, so
			// the edits are saved first.
			const bar = within(editorBar(container));
			expect(
				bar.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
			).toBe(false);
			expect(bar.queryByRole("button", { name: /^Stage/ }) === null).toBe(true);
		});

		async function reopen(container: HTMLElement) {
			await waitFor(() => {
				expect(container.querySelector(".cm-content") === null).toBe(true);
			});
			fireEvent.click(
				container.querySelector(".changes-file-entry") as Element,
			);
			await waitFor(() => {
				expect(container.querySelector(".cm-content") === null).toBe(false);
			});
		}

		test("offers the edits back after leaving by history", async () => {
			const { container } = await openAndEdit();

			// A back gesture pops the history entry without asking.
			fireEvent.click(screen.getByRole("button", { name: "History back" }));
			await reopen(container);

			fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

			await waitFor(() => {
				expect(container.querySelector(".cm-line")?.textContent).toBe(
					"edited current",
				);
			});
		});

		test("drops the edits when leaving with Discard", async () => {
			const { container } = await openAndEdit();

			fireEvent.click(
				screen.getByRole("button", { name: "Back to file list" }),
			);
			fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
			await reopen(container);

			expect(screen.queryByRole("button", { name: "Restore" }) === null).toBe(
				true,
			);
		});
	});

	test("refetches the diff after the editor saves", async () => {
		let diffRequests = 0;

		globalThis.fetch = mock(
			(input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				const json = (body: unknown) =>
					Promise.resolve(
						new Response(JSON.stringify(body), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						}),
					);

				if (url.includes("/api/git/status")) {
					return json({
						files: [{ path: "app.ts", status: "modified", staged: false }],
					});
				}

				if (url.includes("/api/git/diff")) {
					diffRequests += 1;
					return json({ diff: "diff content", truncated: false });
				}

				if (url.includes("/api/git/base-content")) {
					return Promise.resolve(new Response("previous\n", { status: 200 }));
				}

				if (url.includes("/api/files/content")) {
					if (init?.method === "PUT") return json({ mtimeMs: 2 });
					return Promise.resolve(
						new Response("current\n", {
							status: 200,
							headers: { "x-file-mtime-ms": "1" },
						}),
					);
				}

				return Promise.resolve(new Response("Not found", { status: 404 }));
			},
		) as typeof fetch;

		const { container } = renderFilesPage();

		await waitFor(() => {
			expect(container.querySelectorAll(".changes-file-entry").length).toBe(1);
		});
		fireEvent.click(container.querySelector(".changes-file-entry") as Element);
		await waitFor(() => {
			expect(container.querySelector(".cm-content")).not.toBeNull();
			expect(diffRequests).toBe(1);
		});

		const { EditorView } = await import("@codemirror/view");
		const view = EditorView.findFromDOM(
			container.querySelector(".cm-editor") as HTMLElement,
		);
		act(() => {
			view?.dispatch({ changes: { from: 0, insert: "edited " } });
		});
		const save = screen.getByRole("button", { name: "Save" });
		await waitFor(() => {
			expect(save.hasAttribute("disabled")).toBe(false);
		});
		fireEvent.click(save);

		// The save changed the working tree, so git's diff is fetched afresh.
		await waitFor(() => {
			expect(diffRequests).toBe(2);
		});
	});

	test("refetches the diff when the editor reloads the file", async () => {
		let diffRequests = 0;

		globalThis.fetch = mock((input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			const json = (body: unknown) =>
				Promise.resolve(
					new Response(JSON.stringify(body), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);

			if (url.includes("/api/git/status")) {
				return json({
					files: [{ path: "app.ts", status: "modified", staged: false }],
				});
			}
			if (url.includes("/api/git/diff")) {
				diffRequests += 1;
				return json({ diff: "diff content", truncated: false });
			}
			if (url.includes("/api/git/base-content")) {
				return Promise.resolve(new Response("previous\n", { status: 200 }));
			}
			if (url.includes("/api/files/content")) {
				return Promise.resolve(
					new Response("current\n", {
						status: 200,
						headers: { "x-file-mtime-ms": "1" },
					}),
				);
			}
			return Promise.resolve(new Response("Not found", { status: 404 }));
		}) as typeof fetch;

		const { container } = renderFilesPage();
		await waitFor(() => {
			expect(container.querySelectorAll(".changes-file-entry").length).toBe(1);
		});
		fireEvent.click(container.querySelector(".changes-file-entry") as Element);
		await waitFor(() => {
			expect(container.querySelector(".cm-content")).not.toBeNull();
			expect(diffRequests).toBe(1);
		});

		fireEvent.click(screen.getByRole("button", { name: "More actions" }));
		fireEvent.click(screen.getByRole("menuitem", { name: "Reload" }));

		// The file was reread, so git's diff of it is reread too.
		await waitFor(() => {
			expect(diffRequests).toBe(2);
		});
	});

	test("puts the editor's menu in its header", async () => {
		mockFetchForChanges(
			[{ path: "app.ts", status: "modified", staged: false }],
			{
				baseContent: { path: "app.ts", content: "previous\n" },
				diff: {
					path: "app.ts",
					diff: "@@ -1 +1 @@\n-previous\n+current\n",
					truncated: false,
				},
				fileContent: { path: "app.ts", content: "current\n" },
			},
		);

		const { container } = renderFilesPage();
		await waitFor(() => {
			expect(container.querySelector(".changes-file-entry")).not.toBeNull();
		});
		fireEvent.click(container.querySelector(".changes-file-entry") as Element);
		await findEditableEditor(container);

		const slot = container.querySelector(
			".changes-diff-header .changes-header-menu",
		) as HTMLElement;
		await waitFor(() => {
			const more = screen.getByRole("button", { name: "More actions" });
			expect(slot.contains(more)).toBe(true);
			expect(editorBar(container).contains(more)).toBe(false);
		});

		fireEvent.click(screen.getByRole("button", { name: "More actions" }));
		expect(slot.contains(screen.getByRole("menu"))).toBe(true);
	});

	test("offers the action on the whole file in the editor's bar", async () => {
		for (const { status, staged, label } of [
			{ status: "modified", staged: false, label: "Stage file" },
			{ status: "modified", staged: true, label: "Unstage file" },
			{ status: "deleted", staged: false, label: "Stage deletion" },
			{ status: "deleted", staged: true, label: "Unstage deletion" },
		]) {
			mockFetchForChanges([{ path: "app.ts", status, staged }], {
				baseContent: { path: "app.ts", content: "previous\n" },
				diff: {
					path: "app.ts",
					diff: "@@ -1 +1 @@\n-previous\n+current\n",
					truncated: false,
				},
				fileContent: { path: "app.ts", content: "current\n" },
			});

			const { container } = renderFilesPage();
			await waitFor(() => {
				expect(container.querySelector(".changes-file-entry")).not.toBeNull();
			});
			fireEvent.click(
				container.querySelector(".changes-file-entry") as Element,
			);
			await waitFor(() => {
				expect(container.querySelector(".cm-content")).not.toBeNull();
			});

			const action = within(editorBar(container)).getByRole("button", {
				name: label,
			}) as HTMLButtonElement;
			expect(action.disabled).toBe(false);
			// The header holds no action of its own.
			const header = container.querySelector(
				".changes-diff-header",
			) as HTMLElement;
			expect(
				within(header).queryByRole("button", { name: /Stage|Unstage/ }) ===
					null,
			).toBe(true);
			if (status === "deleted") {
				expect(
					container.querySelector(".text-file-editor-status")?.textContent,
				).toBe("Deleted file");
			}
			cleanup();
		}
	});

	test("stages the whole file from the editor's bar and returns to the list", async () => {
		const stageBodies: string[] = [];
		let files: StatusFile[] = [
			{ path: "app.ts", status: "modified", staged: false },
		];
		let finishStage = () => {};

		globalThis.fetch = mock(
			(input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				const json = () =>
					new Response(JSON.stringify({ files }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});

				if (url.includes("/api/git/stage")) {
					stageBodies.push(String(init?.body ?? ""));
					return new Promise<Response>((resolve) => {
						finishStage = () => {
							files = [{ path: "app.ts", status: "modified", staged: true }];
							resolve(json());
						};
					});
				}
				if (url.includes("/api/git/status")) {
					return Promise.resolve(json());
				}
				if (url.includes("/api/files/content")) {
					return Promise.resolve(
						new Response("current\n", {
							status: 200,
							headers: { "x-file-mtime-ms": "1" },
						}),
					);
				}
				return Promise.resolve(new Response("Not found", { status: 404 }));
			},
		) as typeof fetch;

		const { container } = renderFilesPage();
		await waitFor(() => {
			expect(container.querySelector(".changes-file-entry")).not.toBeNull();
		});
		fireEvent.click(container.querySelector(".changes-file-entry") as Element);
		await findEditableEditor(container);

		const stageFile = within(editorBar(container)).getByRole("button", {
			name: "Stage file",
		}) as HTMLButtonElement;
		fireEvent.click(stageFile);

		// The action waits for the server, rather than being sent twice.
		await waitFor(() => {
			expect(stageBodies.length).toBe(1);
			expect(stageFile.disabled).toBe(true);
		});
		expect(JSON.parse(stageBodies[0])).toEqual({ path: "app.ts" });

		await act(async () => {
			finishStage();
		});
		await waitFor(() => {
			expect(listShown(container)).toBe(true);
		});
		expect(screen.getByLabelText("Unstage app.ts")).not.toBeNull();
	});

	test("stages an untracked file as shown, then returns to the list", async () => {
		const stageBodies: string[] = [];
		let files: StatusFile[] = [
			{ path: "new.ts", status: "untracked", staged: false },
		];

		globalThis.fetch = mock(
			(input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				const json = () =>
					new Response(JSON.stringify({ files }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});

				if (url.includes("/api/git/stage")) {
					stageBodies.push(String(init?.body ?? ""));
					files = [{ path: "new.ts", status: "added", staged: true }];
					return Promise.resolve(json());
				}
				if (url.includes("/api/git/status")) {
					return Promise.resolve(json());
				}
				if (url.includes("/api/git/diff")) {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								diff: "@@ -0,0 +1 @@\n+current\n",
								truncated: false,
							}),
							{ headers: { "Content-Type": "application/json" } },
						),
					);
				}
				if (url.includes("/api/files/content")) {
					return Promise.resolve(
						new Response("current\n", {
							status: 200,
							headers: { "x-file-mtime-ms": "1" },
						}),
					);
				}
				return Promise.resolve(new Response("Not found", { status: 404 }));
			},
		) as typeof fetch;

		const { container } = renderFilesPage();
		await waitFor(() => {
			expect(container.querySelector(".changes-file-entry")).not.toBeNull();
		});
		fireEvent.click(container.querySelector(".changes-file-entry") as Element);
		await waitFor(() => {
			expect(container.querySelector(".cm-content")).not.toBeNull();
		});

		const stageFile = await waitFor(() => {
			const button = within(editorBar(container)).getByRole("button", {
				name: "Stage file",
			}) as HTMLButtonElement;
			expect(button.disabled).toBe(false);
			return button;
		});
		fireEvent.click(stageFile);

		// The editor names the version on screen, so a file changed on disk
		// since it loaded is refused rather than staged unseen.
		await waitFor(() => {
			expect(stageBodies.length).toBe(1);
		});
		expect(JSON.parse(stageBodies[0])).toEqual({
			path: "new.ts",
			expectedMtimeMs: 1,
		});

		await waitFor(() => {
			expect(listShown(container)).toBe(true);
		});
		expect(screen.getByLabelText("Unstage new.ts")).not.toBeNull();
	});

	test("refresh button is present", async () => {
		mockFetchForChanges([]);

		renderFilesPage();

		await waitFor(() => {
			const button = screen.getByLabelText("Refresh status");
			expect(button).not.toBeNull();
		});
	});

	test("shows last refreshed timestamp after load", async () => {
		mockFetchForChanges([]);

		const { container } = renderFilesPage();

		await waitFor(() => {
			const timestamp = container.querySelector(".changes-timestamp");
			expect(timestamp).not.toBeNull();
			expect(timestamp?.textContent).toContain("Last refreshed");
		});
	});

	test("stages an unstaged file from the list", async () => {
		const stageBodies: string[] = [];
		let files: StatusFile[] = [
			{ path: "app.ts", status: "modified", staged: false },
		];

		globalThis.fetch = mock(
			(input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();

				if (url.includes("/api/git/stage")) {
					stageBodies.push(String(init?.body ?? ""));
					files = [{ path: "app.ts", status: "modified", staged: true }];
					return Promise.resolve(
						new Response(JSON.stringify({ files }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						}),
					);
				}

				if (url.includes("/api/git/status")) {
					return Promise.resolve(
						new Response(JSON.stringify({ files }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						}),
					);
				}

				return Promise.resolve(new Response("Not found", { status: 404 }));
			},
		) as typeof fetch;

		const { container } = renderFilesPage();

		await waitFor(() => {
			expect(screen.getByLabelText("Stage app.ts")).not.toBeNull();
		});

		fireEvent.click(screen.getByLabelText("Stage app.ts"));

		await waitFor(() => {
			expect(stageBodies.length).toBe(1);
			expect(JSON.parse(stageBodies[0]).path).toBe("app.ts");
		});

		await waitFor(() => {
			const headers = container.querySelectorAll(".changes-section-header");
			expect(headers[0]?.textContent).toContain("Staged");
			expect(screen.getByLabelText("Unstage app.ts")).not.toBeNull();
		});
	});

	test("unstages a whole staged file from the editor's bar and returns to the list", async () => {
		const unstageBodies: string[] = [];
		let files: StatusFile[] = [
			{ path: "app.ts", status: "modified", staged: true },
		];

		globalThis.fetch = mock(
			(input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();

				if (url.includes("/api/git/unstage")) {
					unstageBodies.push(String(init?.body ?? ""));
					files = [{ path: "app.ts", status: "modified", staged: false }];
					return Promise.resolve(
						new Response(JSON.stringify({ files }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						}),
					);
				}

				if (url.includes("/api/git/status")) {
					return Promise.resolve(
						new Response(JSON.stringify({ files }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						}),
					);
				}

				if (url.includes("/api/git/diff")) {
					return Promise.resolve(
						new Response(
							JSON.stringify({ diff: "some diff", truncated: false }),
							{
								status: 200,
								headers: { "Content-Type": "application/json" },
							},
						),
					);
				}

				return Promise.resolve(new Response("Not found", { status: 404 }));
			},
		) as typeof fetch;

		const { container } = renderFilesPage();

		await waitFor(() => {
			expect(container.querySelector(".changes-file-entry")).not.toBeNull();
		});

		fireEvent.click(container.querySelector(".changes-file-entry") as Element);

		await waitFor(() => {
			expect(container.querySelector(".changes-diff-view")).not.toBeNull();
		});

		fireEvent.click(
			within(editorBar(container)).getByRole("button", {
				name: "Unstage file",
			}),
		);

		await waitFor(() => {
			expect(unstageBodies.length).toBe(1);
			expect(listShown(container)).toBe(true);
		});
		// The whole file unstages, so no lines are named.
		expect(JSON.parse(unstageBodies[0])).toEqual({ path: "app.ts" });
	});

	test("disables staging and editing when the server refuses writes", async () => {
		mockFetchForChanges(
			[
				{ path: "app.ts", status: "modified", staged: false },
				{ path: "done.ts", status: "modified", staged: true },
			],
			{
				baseContent: { path: "app.ts", content: "const a = 0;\n" },
				diff: {
					path: "app.ts",
					diff: "@@ -1 +1 @@\n-const a = 0;\n+const a = 1;\n",
					truncated: false,
				},
				fileContent: { path: "app.ts", content: "const a = 1;\n" },
			},
		);

		const { container } = renderFilesPage(["/files"], {
			writesAllowed: false,
		});

		await waitFor(() => {
			expect(screen.getByLabelText("Stage app.ts")).not.toBeNull();
		});
		expect(
			(screen.getByLabelText("Stage app.ts") as HTMLButtonElement).disabled,
		).toBe(true);
		expect(
			(screen.getByLabelText("Unstage done.ts") as HTMLButtonElement).disabled,
		).toBe(true);
		expect(screen.getByRole("note").textContent).toContain("Read-only");

		await act(async () => {
			fireEvent.click(screen.getByText("app.ts"));
		});

		await waitFor(() => {
			expect(container.querySelector(".cm-content")).not.toBeNull();
		});
		expect(screen.getByText("Read-only: writes are disabled")).not.toBeNull();
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
		const stageButtons = Array.from(
			container.querySelectorAll("button:not([role=tab])"),
		).filter((button) => button.textContent?.startsWith("Stage"));
		// Only the bar's whole-file action remains, and it is disabled.
		expect(stageButtons.length).toBe(1);
		const [stageFile] = stageButtons;
		expect(stageFile.textContent).toBe("Stage file");
		expect(editorBar(container).contains(stageFile)).toBe(true);
		expect(stageFile.disabled).toBe(true);
		expect(stageFile.title).toBe("The server does not allow changes");
	});

	test("offers no changes until the server says whether it allows them", async () => {
		mockFetchForChanges(
			[{ path: "app.ts", status: "modified", staged: false }],
			{
				baseContent: { path: "app.ts", content: "const a = 0;\n" },
				diff: {
					path: "app.ts",
					diff: "@@ -1 +1 @@\n-const a = 0;\n+const a = 1;\n",
					truncated: false,
				},
				fileContent: { path: "app.ts", content: "const a = 1;\n" },
			},
		);

		const { container } = renderFilesPage(["/files"], {
			writesAllowed: null,
		});

		await waitFor(() => {
			expect(screen.getByLabelText("Stage app.ts")).not.toBeNull();
		});
		const listStage = screen.getByLabelText(
			"Stage app.ts",
		) as HTMLButtonElement;
		expect(listStage.disabled).toBe(true);
		expect(listStage.title).toBe("Stage");
		expect(screen.queryByRole("note")).toBeNull();

		await act(async () => {
			fireEvent.click(screen.getByText("app.ts"));
		});

		// Once the change is drawn, a page that allowed writes would offer its
		// lines for picking.
		await waitFor(() => {
			expect(container.querySelector(".cm-changedLine")).not.toBeNull();
		});
		expect(screen.getByText("Checking write access...")).not.toBeNull();
		expect(screen.queryByText("Read-only: writes are disabled")).toBeNull();
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
		expect(container.querySelectorAll(".cm-pickTarget").length).toBe(0);
		const stageFile = within(editorBar(container)).getByRole("button", {
			name: "Stage file",
		}) as HTMLButtonElement;
		expect(stageFile.disabled).toBe(true);
		expect(stageFile.hasAttribute("title")).toBe(false);
	});

	test("shows the server's message when it refuses a write", async () => {
		const files: StatusFile[] = [
			{ path: "app.ts", status: "modified", staged: false },
		];
		const message =
			"Rift is read-only: the server does not allow changes. Set RIFT_ALLOW_WRITES=1 on the server to allow them.";

		globalThis.fetch = mock((input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/git/stage")) {
				return Promise.resolve(
					new Response(
						JSON.stringify({ error: { code: "WRITES_DISABLED", message } }),
						{ status: 403, headers: { "Content-Type": "application/json" } },
					),
				);
			}
			if (url.includes("/api/git/status")) {
				return Promise.resolve(
					new Response(JSON.stringify({ files }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			return Promise.resolve(new Response("Not found", { status: 404 }));
		}) as typeof fetch;

		renderFilesPage();

		await waitFor(() => {
			expect(screen.getByLabelText("Stage app.ts")).not.toBeNull();
		});
		fireEvent.click(screen.getByLabelText("Stage app.ts"));

		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toContain(message);
		});
	});
});

describe("committing", () => {
	const STAGED: StatusFile[] = [
		{ path: "app.ts", status: "modified", staged: true },
	];
	const COMMIT = "0123456789abcdef0123456789abcdef01234567";

	// Serves the status as `files`, and answers a commit with `commit`, which
	// leaves nothing staged.
	function mockFetchForCommit(
		files: StatusFile[],
		commit: { status: number; body: unknown } = {
			status: 200,
			body: { commit: COMMIT, files: [] },
		},
	) {
		const commitBodies: unknown[] = [];
		globalThis.fetch = mock(
			(input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url.includes("/api/git/commit")) {
					commitBodies.push(JSON.parse(String(init?.body)));
					return Promise.resolve(
						new Response(JSON.stringify(commit.body), {
							status: commit.status,
							headers: { "Content-Type": "application/json" },
						}),
					);
				}
				if (url.includes("/api/git/status")) {
					return Promise.resolve(
						new Response(JSON.stringify({ files }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						}),
					);
				}
				return Promise.resolve(new Response("Not found", { status: 404 }));
			},
		) as typeof fetch;
		return commitBodies;
	}

	function messageBox() {
		return screen.findByRole("textbox", { name: "Commit message" });
	}

	function commitButton() {
		return screen.getByRole("button", { name: "Commit" });
	}

	test("offers a commit box only while changes are staged", async () => {
		mockFetchForCommit([{ path: "app.ts", status: "modified", staged: false }]);
		renderFilesPage();
		await screen.findByLabelText("Stage app.ts");
		expect(
			screen.queryByRole("textbox", { name: "Commit message" }),
		).toBeNull();

		cleanup();
		mockFetchForCommit(STAGED);
		renderFilesPage();
		expect(await messageBox()).toBeDefined();
	});

	test("offers Commit only once the message has some text", async () => {
		mockFetchForCommit(STAGED);
		renderFilesPage();
		const box = await messageBox();
		expect(commitButton().hasAttribute("disabled")).toBe(true);

		fireEvent.change(box, { target: { value: " \n " } });
		expect(commitButton().hasAttribute("disabled")).toBe(true);

		fireEvent.change(box, { target: { value: "Change the app" } });
		expect(commitButton().hasAttribute("disabled")).toBe(false);
	});

	test("commits the message, then clears it and shows the new commit", async () => {
		const commitBodies = mockFetchForCommit(STAGED);
		renderFilesPage();
		const message = "Change the app\n\n- Explain why.";
		fireEvent.change(await messageBox(), { target: { value: message } });

		fireEvent.click(commitButton());

		await screen.findByText("Committed 0123456");
		expect(commitBodies).toEqual([{ message }]);
		expect(screen.getByText("Working tree clean")).toBeDefined();
		expect(
			globalThis.localStorage.getItem("rift:commit-draft:test-repo"),
		).toBeNull();
	});

	test("keeps an unsent message for when the list comes back", async () => {
		mockFetchForCommit(STAGED);
		renderFilesPage();
		fireEvent.change(await messageBox(), {
			target: { value: "Change the app" },
		});

		cleanup();
		renderFilesPage();

		expect(((await messageBox()) as HTMLTextAreaElement).value).toBe(
			"Change the app",
		);
	});

	test("shows git's message when the commit fails, and keeps the message", async () => {
		const failure = "pre-commit hook refused the commit";
		mockFetchForCommit(STAGED, {
			status: 500,
			body: { error: { code: "GIT_ERROR", message: failure } },
		});
		renderFilesPage();
		const box = await messageBox();
		fireEvent.change(box, { target: { value: "Change the app" } });

		fireEvent.click(commitButton());

		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toContain(failure);
		});
		expect((box as HTMLTextAreaElement).value).toBe("Change the app");
		expect(commitButton().hasAttribute("disabled")).toBe(false);
	});

	test("keeps the message when the request fails", async () => {
		mockFetchForCommit(STAGED);
		const answer = globalThis.fetch;
		globalThis.fetch = mock((input: string | URL | Request) =>
			String(input).includes("/api/git/commit")
				? Promise.reject(new TypeError("Failed to fetch"))
				: answer(input),
		) as typeof fetch;
		renderFilesPage();
		const box = await messageBox();
		fireEvent.change(box, { target: { value: "Change the app" } });

		fireEvent.click(commitButton());

		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toContain(
				"Failed to fetch",
			);
		});
		expect((box as HTMLTextAreaElement).value).toBe("Change the app");
		expect(globalThis.localStorage.getItem("rift:commit-draft:test-repo")).toBe(
			"Change the app",
		);
	});

	test("takes the stored draft each time the box appears", async () => {
		let files = STAGED;
		globalThis.fetch = mock((input: string | URL | Request) =>
			Promise.resolve(
				String(input).includes("/api/git/status")
					? new Response(JSON.stringify({ files }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						})
					: new Response("Not found", { status: 404 }),
			),
		) as typeof fetch;
		renderFilesPage();
		fireEvent.change(await messageBox(), {
			target: { value: "Change the app" },
		});

		// The message is committed from elsewhere, as by this page before it
		// was left and reopened, which clears the stored draft.
		globalThis.localStorage.removeItem("rift:commit-draft:test-repo");
		files = [];
		fireEvent.click(screen.getByLabelText("Refresh status"));
		await screen.findByText("Working tree clean");

		// The box must appear holding the stored draft, not show the earlier
		// message until a later render replaces it, so note what it first holds.
		let firstShown: string | undefined;
		const observer = new MutationObserver(() => {
			const box = screen.queryByRole("textbox", { name: "Commit message" });
			firstShown ??= (box as HTMLTextAreaElement | null)?.value;
		});
		observer.observe(document.body, { childList: true, subtree: true });
		files = STAGED;
		fireEvent.click(screen.getByLabelText("Refresh status"));
		await messageBox();
		observer.disconnect();

		expect(firstShown).toBe("");
	});

	test("offers no commit when the server refuses writes", async () => {
		mockFetchForCommit(STAGED);
		renderFilesPage(["/files"], { writesAllowed: false });
		const box = await messageBox();
		fireEvent.change(box, { target: { value: "Change the app" } });

		expect(box.hasAttribute("disabled")).toBe(true);
		expect(commitButton().hasAttribute("disabled")).toBe(true);
	});
});

describe("switching between a file's unstaged and staged changes", () => {
	const BOTH: StatusFile[] = [
		{ path: "app.ts", status: "modified", staged: false },
		{ path: "app.ts", status: "modified", staged: true },
	];

	function mockFile(files: StatusFile[]) {
		mockFetchForChanges(files, {
			baseContent: { path: "app.ts", content: "previous\n" },
			diff: {
				path: "app.ts",
				diff: "@@ -1 +1 @@\n-previous\n+current\n",
				truncated: false,
			},
			fileContent: { path: "app.ts", content: "current\n" },
		});
	}

	function tabs() {
		return screen.getAllByRole("tab").map((tab) => {
			const marks = [
				tab.getAttribute("aria-selected") === "true" ? "selected" : "",
				tab.hasAttribute("disabled") ? "disabled" : "",
			].filter(Boolean);
			return `${tab.textContent}${marks.length ? ` (${marks.join(", ")})` : ""}`;
		});
	}

	// Each side's editor, and whether it is the one on screen.
	function editors(container: HTMLElement) {
		return [...container.querySelectorAll(".changes-editor-view")].map(
			(view) =>
				view.classList.contains("changes-editor-view--hidden")
					? "hidden"
					: "shown",
		);
	}

	test("offers both sides, greying out a side with no changes", async () => {
		mockFile([{ path: "app.ts", status: "modified", staged: false }]);
		const { container } = renderFilesPage(["/files?path=app.ts&staged=false"]);

		await screen.findByRole("tablist", { name: "Changes to show" });
		expect(tabs()).toEqual(["Unstaged (selected)", "Staged (disabled)"]);
		expect(editors(container)).toEqual(["shown"]);
	});

	test("shows the other side at once, without loading it again", async () => {
		mockFile(BOTH);
		const { container } = renderFilesPage([
			"/files",
			"/files?path=app.ts&staged=false",
		]);
		await waitFor(() => {
			expect(container.querySelectorAll(".cm-content").length).toBe(2);
		});
		expect(tabs()).toEqual(["Unstaged (selected)", "Staged"]);
		expect(editors(container)).toEqual(["shown", "hidden"]);
		const { calls } = (
			globalThis.fetch as unknown as { mock: { calls: unknown[] } }
		).mock;
		const before = calls.length;

		fireEvent.click(screen.getByRole("tab", { name: "Staged" }));

		expect(tabs()).toEqual(["Unstaged", "Staged (selected)"]);
		expect(editors(container)).toEqual(["hidden", "shown"]);
		expect(screen.getByTestId("location-search").textContent).toBe(
			"?path=app.ts&staged=true",
		);
		expect(calls.length).toBe(before);

		// The switch replaced the file's history entry, so Back leaves the file.
		fireEvent.click(screen.getByRole("button", { name: "History back" }));
		await waitFor(() => {
			expect(screen.getByTestId("location-search").textContent).toBe("");
		});
	});

	// Answers every request the open file makes, the status with `files`, and a
	// stage or unstage with `answer`.
	function mockFileRequests(
		files: StatusFile[],
		urls: string[] = [],
		answer: StatusFile[] = files,
	) {
		globalThis.fetch = mock(
			(input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				urls.push(url);
				const json = (body: unknown) =>
					Promise.resolve(
						new Response(JSON.stringify(body), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						}),
					);
				if (init?.method === "POST") return json({ files: answer });
				if (url.includes("/api/git/status")) return json({ files });
				if (url.includes("/api/git/diff")) {
					return json({
						diff: "@@ -1 +1 @@\n-previous\n+current\n",
						truncated: false,
					});
				}
				if (url.includes("/api/git/base-content")) {
					return Promise.resolve(new Response("previous\n"));
				}
				return Promise.resolve(
					new Response("current\n", { headers: { "x-file-mtime-ms": "1" } }),
				);
			},
		) as typeof fetch;
		return urls;
	}

	async function enabledStrip(name: string) {
		const strip = await screen.findByRole("button", { name });
		await waitFor(() => {
			expect(strip.getAttribute("aria-disabled")).toBe("false");
		});
		return strip;
	}

	test("reloads the staged side when the working tree stages lines", async () => {
		const urls = mockFileRequests(BOTH);
		renderFilesPage(["/files?path=app.ts&staged=false"]);
		const strip = await enabledStrip("Stage the change at line 1");
		// The staged side's content is the index blob, read through
		// base-content with staged=false, and keyed by its reload count.
		const stagedContentReloads = () =>
			urls.filter(
				(url) =>
					url.includes("/api/git/base-content") &&
					url.includes("staged=false") &&
					url.includes("_reload=0.1"),
			).length;
		expect(stagedContentReloads()).toBe(0);

		fireEvent.click(strip);

		await waitFor(() => {
			expect(stagedContentReloads()).toBe(1);
		});
	});

	test("keeps an edited working tree on offer when git sees no change in it", async () => {
		// Everything is staged, so git reports no unstaged change, but the
		// working tree is open and edited.
		mockFileRequests([{ path: "app.ts", status: "modified", staged: true }]);
		const { container } = renderFilesPage(["/files?path=app.ts&staged=false"]);
		await waitFor(() => {
			expect(container.querySelector(".cm-content")).not.toBeNull();
		});
		const { EditorView } = await import("@codemirror/view");
		const view = EditorView.findFromDOM(
			container.querySelector(".cm-editor") as HTMLElement,
		);
		act(() => {
			view?.dispatch({ changes: { from: 0, insert: "edited " } });
		});
		await screen.findByText("Unsaved changes");

		fireEvent.click(screen.getByRole("tab", { name: "Staged" }));

		expect(tabs()).toEqual(["Unstaged", "Staged (selected)"]);
		expect(editors(container)).toEqual(["hidden", "shown"]);
		fireEvent.click(screen.getByRole("tab", { name: "Unstaged" }));
		expect(view?.state.doc.toString()).toBe("edited current\n");
	});

	test("shows the edited working tree after unstaging the whole file", async () => {
		const urls = mockFileRequests(BOTH);
		const { container } = renderFilesPage(["/files?path=app.ts&staged=false"]);
		await waitFor(() => {
			expect(container.querySelectorAll(".cm-content").length).toBe(2);
		});
		const { EditorView } = await import("@codemirror/view");
		const view = EditorView.findFromDOM(
			container.querySelector(".cm-editor") as HTMLElement,
		);
		act(() => {
			view?.dispatch({ changes: { from: 0, insert: "edited " } });
		});
		await screen.findByText("Unsaved changes");
		fireEvent.click(screen.getByRole("tab", { name: "Staged" }));

		fireEvent.click(
			within(editorBar(container)).getByRole("button", {
				name: "Unstage file",
			}),
		);

		await waitFor(() => {
			expect(urls.some((url) => url.includes("/api/git/unstage"))).toBe(true);
			expect(tabs()).toEqual(["Unstaged (selected)", "Staged"]);
		});
		expect(screen.getByTestId("location-search").textContent).toBe(
			"?path=app.ts&staged=false",
		);
		expect(view?.state.doc.toString()).toBe("edited current\n");
	});

	test("stages lines of an untracked file and stays in it, with the rest unstaged", async () => {
		const blobs = `${"0".repeat(40)}..${"3".repeat(40)}`;
		const newFile = (...lines: string[]) =>
			[
				"diff --git a/new.txt b/new.txt",
				"new file mode 100644",
				`index ${blobs}`,
				"--- /dev/null",
				"+++ b/new.txt",
				`@@ -0,0 +1,${lines.length} @@`,
				...lines.map((line) => `+${line}`),
				"",
			].join("\n");
		let files: StatusFile[] = [
			{ path: "new.txt", status: "untracked", staged: false },
		];
		// What the index holds of the file, once some of it is staged.
		let index: string | null = null;
		const stageBodies: unknown[] = [];
		const urls: string[] = [];
		globalThis.fetch = mock(
			(input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				urls.push(url);
				const json = (body: unknown) =>
					Promise.resolve(
						new Response(JSON.stringify(body), {
							headers: { "Content-Type": "application/json" },
						}),
					);
				if (url.includes("/api/git/stage")) {
					stageBodies.push(JSON.parse(String(init?.body)));
					index = "two\n";
					files = [
						{ path: "new.txt", status: "added", staged: true },
						{ path: "new.txt", status: "modified", staged: false },
					];
					return json({ files });
				}
				if (url.includes("/api/git/status")) return json({ files });
				if (url.includes("/api/git/diff")) {
					const diff = url.includes("untracked=true")
						? newFile("one", "two", "three")
						: url.includes("staged=true")
							? newFile("two")
							: "@@ -1 +1,3 @@\n+one\n two\n+three\n";
					return json({ diff, truncated: false });
				}
				if (url.includes("/api/git/base-content")) {
					return Promise.resolve(
						index !== null && url.includes("staged=false")
							? new Response(index)
							: new Response("Not found", { status: 404 }),
					);
				}
				return Promise.resolve(
					new Response("one\ntwo\nthree\n", {
						headers: { "x-file-mtime-ms": "1" },
					}),
				);
			},
		) as typeof fetch;
		const { container } = renderFilesPage(["/files?path=new.txt&staged=false"]);
		// The lines the editor on screen offers to pick, once git's diff has
		// placed them.
		const shownTargets = () => {
			const targets = [
				...container.querySelectorAll<HTMLElement>(
					".changes-editor-view:not(.changes-editor-view--hidden) .cm-pickTarget",
				),
			];
			return targets.some((target) =>
				target.classList.contains("cm-pickTarget--waiting"),
			)
				? "waiting"
				: targets.map((target) => target.dataset.pickLine);
		};

		await waitFor(() => {
			expect(shownTargets()).toEqual(["1", "2", "3"]);
		});
		expect(tabs()).toEqual(["Unstaged (selected)", "Staged (disabled)"]);
		act(() => {
			fireEvent.click(
				container.querySelector(
					'.cm-pickTarget[data-pick-line="2"]',
				) as Element,
			);
		});
		const stage = await screen.findByRole("button", { name: "Stage 1 line" });
		await waitFor(() => {
			expect(stage.hasAttribute("disabled")).toBe(false);
		});
		fireEvent.click(stage);

		// The file is now a staged new file with the rest of its lines unstaged,
		// and the editor stays open on the lines still to stage.
		await waitFor(() => {
			expect(tabs()).toEqual(["Unstaged (selected)", "Staged"]);
			expect(shownTargets()).toEqual(["1", "3"]);
		});
		expect(stageBodies).toEqual([
			{
				path: "new.txt",
				ranges: [[2, 2]],
				expectedBlobs: blobs,
				untracked: true,
			},
		]);
		expect(screen.getByTestId("location-search").textContent).toBe(
			"?path=new.txt&staged=false",
		);
		// The stage's answer gives the file's new status, so the side asks
		// straight away for what a tracked change needs, and nothing else: not
		// the status again, nor the untracked diff it had.
		const afterStage = urls.slice(
			urls.findIndex((url) => url.includes("/api/git/stage")) + 1,
		);
		expect(afterStage.some((url) => url.includes("/api/git/status"))).toBe(
			false,
		);
		expect(afterStage.some((url) => url.includes("untracked=true"))).toBe(
			false,
		);

		fireEvent.click(screen.getByRole("tab", { name: "Staged" }));
		await waitFor(() => {
			expect(shownTargets()).toEqual(["1"]);
		});

		// The list shows the file in both sections.
		fireEvent.click(screen.getByRole("button", { name: "Back to file list" }));
		await waitFor(() => {
			expect(sectionHeaders(container)).toEqual([
				"Staged1",
				"Unstaged1",
				"Unchanged",
			]);
		});
		expect(screen.getByLabelText("Unstage new.txt")).not.toBeNull();
		expect(screen.getByLabelText("Stage new.txt")).not.toBeNull();
	});

	test("offers only Stage file for an untracked file its diff does not describe exactly", async () => {
		mockFetchForChanges(
			[{ path: "latin.txt", status: "untracked", staged: false }],
			{
				diff: {
					path: "latin.txt",
					diff: "@@ -0,0 +1 @@\n+caf\uFFFD\n",
					truncated: false,
					exact: false,
				},
				fileContent: { path: "latin.txt", content: "caf\uFFFD\n" },
			},
		);
		const { container } = renderFilesPage([
			"/files?path=latin.txt&staged=false",
		]);

		await findEditableEditor(container);
		await waitFor(() => {
			expect(container.querySelector(".cm-changedLine--added")).not.toBeNull();
			expect(container.querySelector(".cm-pickTarget") === null).toBe(true);
		});
		expect(container.querySelector(".cm-changeStrip") === null).toBe(true);
		expect(container.querySelector(".text-file-editor-notice") === null).toBe(
			true,
		);
	});

	test("updates the list from an unstage's answer, without asking for the status", async () => {
		const urls = mockFileRequests(
			BOTH,
			[],
			[{ path: "app.ts", status: "modified", staged: false }],
		);
		// The index holds the staged change.
		const answer = globalThis.fetch;
		globalThis.fetch = mock(
			(input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				if (
					url.includes("/api/git/base-content") &&
					url.includes("staged=false")
				) {
					urls.push(url);
					return Promise.resolve(new Response("current\n"));
				}
				return answer(input, init);
			},
		) as typeof fetch;
		const { container } = renderFilesPage(["/files?path=app.ts&staged=true"]);
		const strip = await enabledStrip("Unstage the change at line 1");
		const before = urls.length;

		fireEvent.click(strip);
		await waitFor(() => {
			expect(
				urls.slice(before).some((url) => url.includes("/api/git/unstage")),
			).toBe(true);
		});
		fireEvent.click(screen.getByRole("button", { name: "Back to file list" }));

		// Nothing is staged now.
		await waitFor(() => {
			expect(sectionHeaders(container)).toEqual(["Unstaged1", "Unchanged"]);
		});
		expect(
			urls.slice(before).some((url) => url.includes("/api/git/status")),
		).toBe(false);
	});

	test("rereads the status on a reload", async () => {
		const urls = mockFileRequests(BOTH);
		const { container } = renderFilesPage(["/files?path=app.ts&staged=false"]);
		await waitFor(() => {
			expect(container.querySelectorAll(".cm-content").length).toBe(2);
		});
		const statusReads = () =>
			urls.filter((url) => url.includes("/api/git/status")).length;
		const before = statusReads();

		// The menu of the side on screen sits in the header.
		const header = container.querySelector(
			".changes-diff-header",
		) as HTMLElement;
		fireEvent.click(
			within(header).getByRole("button", { name: "More actions" }),
		);
		fireEvent.click(within(header).getByRole("menuitem", { name: "Reload" }));

		await waitFor(() => {
			expect(statusReads()).toBe(before + 1);
		});
	});

	test("keeps unsaved edits across a switch", async () => {
		mockFile(BOTH);
		const { container } = renderFilesPage(["/files?path=app.ts&staged=false"]);
		await waitFor(() => {
			expect(container.querySelectorAll(".cm-content").length).toBe(2);
		});
		const { EditorView } = await import("@codemirror/view");
		const view = EditorView.findFromDOM(
			container.querySelector(".cm-editor") as HTMLElement,
		);
		act(() => {
			view?.dispatch({ changes: { from: 0, insert: "edited " } });
		});
		await screen.findByText("Unsaved changes");

		fireEvent.click(screen.getByRole("tab", { name: "Staged" }));
		fireEvent.click(screen.getByRole("tab", { name: "Unstaged" }));

		expect(view?.state.doc.toString()).toBe("edited current\n");
		expect(screen.getByText("Unsaved changes")).toBeDefined();
	});
});

// The entry in the tree with this name.
function treeEntry(container: HTMLElement, name: string) {
	const found = [...container.querySelectorAll(".tree-entry")].find(
		(entry) => entry.querySelector(".tree-entry-name")?.textContent === name,
	);
	if (!found) throw new Error(`no ${name} in the tree`);
	return found;
}

describe("the tree of unchanged files", () => {
	// A change in each section, so the tree has some of each to leave out.
	// Git lists a nested repository as its folder.
	const CHANGES: StatusFile[] = [
		{ path: "src/app.ts", status: "modified", staged: true },
		{ path: "notes.txt", status: "modified", staged: false },
		{ path: "data/only.txt", status: "modified", staged: false },
		{ path: "docs/draft.md", status: "untracked", staged: false },
		{ path: "vendor/", status: "untracked", staged: false },
	];
	const FOLDERS: Folders = {
		".": [
			folder("data"),
			folder("docs"),
			folder("src"),
			folder("vendor"),
			file("notes.txt"),
			file("README.md"),
		],
		data: [file("only.txt")],
		docs: [file("draft.md"), file("guide.md")],
		src: [folder("lib"), file("app.ts"), file("util.ts")],
		"src/lib": [file("deep.ts")],
		vendor: [file("lib.js")],
	};

	async function renderTree() {
		mockFetchForChanges(CHANGES, {
			fileContent: { path: "notes.txt", content: "current\n" },
		});
		const result = renderFilesPage(["/files"], {}, FOLDERS);
		await waitFor(() => {
			expect(result.container.querySelector(".tree-entry")).not.toBeNull();
		});
		return result;
	}

	// Opens a folder and waits for what it holds.
	async function openFolder(container: HTMLElement, name: string) {
		fireEvent.click(treeEntry(container, name));
		await waitFor(() => {
			expect(container.querySelector(".tree-loading") === null).toBe(true);
		});
	}

	test("comes after the staged, unstaged and untracked files", async () => {
		const { container } = await renderTree();

		expect(sectionHeaders(container)).toEqual([
			"Staged1",
			"Unstaged2",
			"Untracked2",
			"Unchanged",
		]);
		// The commit box sits under the staged files, and the tree under its
		// own header.
		const list = container.querySelector(".changes-list") as HTMLElement;
		expect(
			[
				...list.querySelectorAll(
					".changes-section-header, .changes-commit, .changes-file-path, .tree-entry-name",
				),
			].map((element) =>
				element.classList.contains("changes-commit")
					? "commit box"
					: element.textContent,
			),
		).toEqual([
			"Staged1",
			"src/app.ts",
			"commit box",
			"Unstaged2",
			"notes.txt",
			"data/only.txt",
			"Untracked2",
			"docs/draft.md",
			"vendor/",
			"Unchanged",
			"data",
			"docs",
			"src",
			"vendor",
			"README.md",
		]);
	});

	test("leaves out the changed files, but keeps every folder", async () => {
		const { container } = await renderTree();
		expect(treeNames(container)).toEqual([
			"data",
			"docs",
			"src",
			"vendor",
			"README.md",
		]);

		// Everything in data has changed, and everything in a nested
		// repository is untracked, but both folders stay.
		await openFolder(container, "data");
		await openFolder(container, "docs");
		await openFolder(container, "vendor");
		expect(treeNames(container)).toEqual([
			"data",
			"docs",
			"guide.md",
			"src",
			"vendor",
			"README.md",
		]);
	});

	test("opens a folder in place, reading it only as it opens", async () => {
		const { container, listed } = await renderTree();
		expect(listed).toEqual(["."]);

		await openFolder(container, "src");
		expect(treeNames(container)).toEqual([
			"data",
			"docs",
			"src",
			"lib",
			"util.ts",
			"vendor",
			"README.md",
		]);
		await openFolder(container, "lib");
		expect(treeNames(container)).toEqual([
			"data",
			"docs",
			"src",
			"lib",
			"deep.ts",
			"util.ts",
			"vendor",
			"README.md",
		]);

		// Closing a folder and opening it again shows what was read of it.
		fireEvent.click(treeEntry(container, "src"));
		expect(treeNames(container)).toEqual([
			"data",
			"docs",
			"src",
			"vendor",
			"README.md",
		]);
		fireEvent.click(treeEntry(container, "src"));
		expect(treeNames(container)).toEqual([
			"data",
			"docs",
			"src",
			"lib",
			"deep.ts",
			"util.ts",
			"vendor",
			"README.md",
		]);
		expect(listed).toEqual([".", "src", "src/lib"]);
	});

	test("opens a changed file into its side, and keeps the tree as it was", async () => {
		const { container } = await renderTree();
		await openFolder(container, "src");

		fireEvent.click(screen.getByText("notes.txt"));
		await findEditableEditor(container);
		expect(screen.getByTestId("location-search").textContent).toBe(
			"?path=notes.txt&staged=false",
		);

		fireEvent.click(screen.getByRole("button", { name: "Back to file list" }));
		await waitFor(() => {
			expect(treeNames(container)).toEqual([
				"data",
				"docs",
				"src",
				"lib",
				"util.ts",
				"vendor",
				"README.md",
			]);
		});
	});

	test("opens an unchanged file in the editor, to stage once an edit is saved", async () => {
		let files: StatusFile[] = [];
		let saved = false;
		// The status read after the save waits until the test lets it go.
		let answerStatus: (() => void) | null = null;
		const reads = { base: 0, diff: 0 };
		globalThis.fetch = mock(
			(input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url.includes("/api/git/status")) {
					if (!saved) return Promise.resolve(json({ files }));
					return new Promise<Response>((resolve) => {
						answerStatus = () => resolve(json({ files }));
					});
				}
				if (url.includes("/api/git/diff")) {
					reads.diff += 1;
					return Promise.resolve(
						json({
							diff: saved ? "@@ -1 +1 @@\n-hello\n+edited hello\n" : "",
							truncated: false,
						}),
					);
				}
				if (url.includes("/api/git/base-content")) {
					reads.base += 1;
					return Promise.resolve(new Response("hello\n"));
				}
				if (url.includes("/api/files/content")) {
					if (init?.method === "PUT") {
						saved = true;
						files = [{ path: "README.md", status: "modified", staged: false }];
						return Promise.resolve(json({ mtimeMs: 2 }));
					}
					return Promise.resolve(
						new Response("hello\n", { headers: { "x-file-mtime-ms": "1" } }),
					);
				}
				return Promise.resolve(new Response("Not found", { status: 404 }));
			},
		) as typeof fetch;
		const { container, listed } = renderFilesPage(
			["/files"],
			{},
			{
				".": [file("README.md")],
			},
		);
		await waitFor(() => {
			expect(treeNames(container)).toEqual(["README.md"]);
		});

		fireEvent.click(treeEntry(container, "README.md"));

		await waitFor(() => {
			expect(
				container.querySelector(".cm-content")?.getAttribute("contenteditable"),
			).toBe("true");
			// Its diff is read once its base has arrived, so a save that makes
			// a change has a diff to replace.
			expect(reads).toEqual({ base: 1, diff: 1 });
		});
		expect(screen.getByTestId("location-search").textContent).toBe(
			"?path=README.md&staged=false",
		);
		expect(
			screen
				.getAllByRole("tab")
				.map((tab) => `${tab.textContent} ${tab.hasAttribute("disabled")}`),
		).toEqual(["Unstaged false", "Staged true"]);
		const stageFile = () =>
			within(editorBar(container)).getByRole("button", {
				name: "Stage file",
			}) as HTMLButtonElement;
		expect(stageFile().disabled).toBe(true);
		expect(container.querySelector(".cm-changedLine") === null).toBe(true);

		const { EditorView } = await import("@codemirror/view");
		const view = EditorView.findFromDOM(
			container.querySelector(".cm-editor") as HTMLElement,
		);
		act(() => {
			view?.dispatch({ changes: { from: 0, insert: "edited " } });
		});
		await waitFor(() => {
			expect(container.querySelector(".cm-changedLine")).not.toBeNull();
		});
		const save = await screen.findByRole("button", { name: "Save" });
		await waitFor(() => {
			expect(save.hasAttribute("disabled")).toBe(false);
		});

		// The edit stays marked from the save until the status arrives.
		let leastMarked = Number.POSITIVE_INFINITY;
		const observer = new MutationObserver(() => {
			leastMarked = Math.min(
				leastMarked,
				container.querySelectorAll(".cm-changedLine").length,
			);
		});
		observer.observe(container, {
			childList: true,
			subtree: true,
			attributes: true,
		});
		fireEvent.click(save);

		// git's diff is read alongside the status, so the change can be staged
		// by its strip before the status has answered.
		await waitFor(() => {
			expect(
				container.querySelector('.cm-changeStripButton[aria-disabled="false"]'),
			).not.toBeNull();
		});
		expect(answerStatus).not.toBeNull();

		// Once the status lists the change, the whole file stages too, from
		// the same base, which is not read again.
		await act(async () => {
			answerStatus?.();
		});
		await waitFor(() => {
			expect(stageFile().disabled).toBe(false);
		});
		observer.disconnect();
		expect(leastMarked).toBeGreaterThan(0);
		expect(reads).toEqual({ base: 1, diff: 2 });
		// A file that became modified was already in its folder's listing.
		expect(listed).toEqual(["."]);
	});

	test("opens an unchanged binary file with only the editor saying why", async () => {
		const refusal = {
			error: { code: "BINARY_FILE", message: "Binary files are not supported" },
		};
		const reads: string[] = [];
		globalThis.fetch = mock((input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("/api/git/status")) {
				return Promise.resolve(json({ files: [] }));
			}
			for (const route of [
				"/api/files/content",
				"/api/git/base-content",
				"/api/git/diff",
			]) {
				if (url.includes(route)) {
					reads.push(route);
					return Promise.resolve(json(refusal, 415));
				}
			}
			return Promise.resolve(new Response("Not found", { status: 404 }));
		}) as typeof fetch;
		const { container } = renderFilesPage(
			["/files"],
			{},
			{
				".": [file("image.png")],
			},
		);
		await waitFor(() => {
			expect(treeNames(container)).toEqual(["image.png"]);
		});

		fireEvent.click(treeEntry(container, "image.png"));

		await waitFor(() => {
			expect(
				container.querySelector(".text-file-editor-error")?.textContent,
			).toContain("Binary files are not supported");
			expect(reads.sort()).toEqual([
				"/api/files/content",
				"/api/git/base-content",
			]);
		});
		// The base's refusal repeats the content's, so it raises no banner, and
		// without a base there is no diff to read.
		expect(screen.queryByRole("alert") === null).toBe(true);
	});

	test("shows the list once the status and the top folder have both arrived", async () => {
		let answerStatus = () => {};
		const statusRequests: string[] = [];
		globalThis.fetch = mock((input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("/api/git/status")) {
				statusRequests.push(url);
				return new Promise<Response>((resolve) => {
					answerStatus = () => resolve(json({ files: CHANGES }));
				});
			}
			return Promise.resolve(new Response("Not found", { status: 404 }));
		}) as typeof fetch;
		let answerRoot = (_entries: DirEntry[]) => {};
		const root = new Promise<DirEntry[]>((resolve) => {
			answerRoot = resolve;
		});
		const { container, listed } = renderFilesPage(
			["/files"],
			{},
			{
				".": root,
			},
		);

		// Both are asked for at once, so the list waits on one round trip.
		await waitFor(() => {
			expect(statusRequests.length).toBe(1);
			expect(listed).toEqual(["."]);
		});
		await act(async () => {
			answerStatus();
		});
		expect(container.querySelector(".changes-message")?.textContent).toBe(
			"Loading...",
		);
		expect(sectionHeaders(container)).toEqual([]);

		await act(async () => {
			answerRoot([file("README.md")]);
		});
		await waitFor(() => {
			expect(sectionHeaders(container)).toEqual([
				"Staged1",
				"Unstaged2",
				"Untracked2",
				"Unchanged",
			]);
			expect(treeNames(container)).toEqual(["README.md"]);
		});
	});

	test("reads a folder again when a file joins or leaves the changes from outside", async () => {
		let files: StatusFile[] = [];
		globalThis.fetch = mock((input: string | URL | Request) =>
			Promise.resolve(
				String(input).includes("/api/git/status")
					? json({ files })
					: new Response("Not found", { status: 404 }),
			),
		) as typeof fetch;
		const folders: Folders = {
			".": [folder("src"), file("gone.txt"), file("README.md")],
			src: [file("a.ts")],
		};
		const { container, listed } = renderFilesPage(["/files"], {}, folders);
		await waitFor(() => {
			expect(treeNames(container)).toEqual(["src", "gone.txt", "README.md"]);
		});
		await openFolder(container, "src");

		// Outside Rift, gone.txt is deleted and fresh.txt is created...
		files = [
			{ path: "gone.txt", status: "deleted", staged: false },
			{ path: "fresh.txt", status: "untracked", staged: false },
		];
		folders["."] = [folder("src"), file("fresh.txt"), file("README.md")];
		// The poll reads the status again when the page comes back into view.
		fireEvent(document, new Event("visibilitychange"));
		await waitFor(() => {
			expect(listed).toEqual([".", "src", "."]);
			expect(treeNames(container)).toEqual(["src", "a.ts", "README.md"]);
		});

		// ...and both are committed, so neither is a change any more.
		files = [];
		fireEvent(document, new Event("visibilitychange"));
		await waitFor(() => {
			expect(listed).toEqual([".", "src", ".", "."]);
			expect(treeNames(container)).toEqual([
				"src",
				"a.ts",
				"fresh.txt",
				"README.md",
			]);
		});
	});

	test("rereads every folder read so far on Refresh, as after a pull", async () => {
		globalThis.fetch = mock((input: string | URL | Request) =>
			Promise.resolve(
				String(input).includes("/api/git/status")
					? json({ files: [] })
					: new Response("Not found", { status: 404 }),
			),
		) as typeof fetch;
		const folders: Folders = {
			".": [folder("docs"), folder("src"), file("README.md")],
			src: [folder("lib"), file("a.ts")],
			"src/lib": [file("b.ts")],
		};
		const { container, listed } = renderFilesPage(["/files"], {}, folders);
		await waitFor(() => {
			expect(treeNames(container)).toEqual(["docs", "src", "README.md"]);
		});
		await openFolder(container, "src");
		await openFolder(container, "lib");
		// A closed folder whose entries were read is read again too.
		fireEvent.click(treeEntry(container, "lib"));

		// A pull outside Rift adds files, and leaves the status clean.
		folders["."] = [folder("docs"), folder("src"), file("NEWS.md")];
		folders.src = [folder("lib"), file("a.ts"), file("c.ts")];
		folders["src/lib"] = [file("b.ts"), file("d.ts")];
		fireEvent.click(screen.getByLabelText("Refresh status"));

		await waitFor(() => {
			expect(treeNames(container)).toEqual([
				"docs",
				"src",
				"lib",
				"a.ts",
				"c.ts",
				"NEWS.md",
			]);
		});
		expect(listed.slice(3).sort()).toEqual([".", "src", "src/lib"]);
		fireEvent.click(treeEntry(container, "lib"));
		expect(treeNames(container)).toEqual([
			"docs",
			"src",
			"lib",
			"b.ts",
			"d.ts",
			"a.ts",
			"c.ts",
			"NEWS.md",
		]);
	});

	test("keeps the list behind an open file, and shows it again as it was", async () => {
		const { container, listed } = await renderTree();
		await openFolder(container, "src");
		const util = treeEntry(container, "util.ts");
		const statusReads = () =>
			(
				globalThis.fetch as unknown as { mock: { calls: [string][] } }
			).mock.calls.filter(([url]) => String(url).includes("/api/git/status"))
				.length;

		fireEvent.click(screen.getByText("notes.txt"));
		await findEditableEditor(container);

		// The list is still there, hidden, and its poll waits.
		const list = container.querySelector(".changes-page") as HTMLElement;
		expect(list.classList.contains("changes-page--hidden")).toBe(true);
		expect(listShown(container)).toBe(false);
		const reads = statusReads();
		fireEvent(document, new Event("visibilitychange"));
		expect(statusReads()).toBe(reads);

		fireEvent.click(screen.getByRole("button", { name: "Back to file list" }));

		// Going back shows the same list, without building or reading it again.
		expect(listShown(container)).toBe(true);
		expect(list.classList.contains("changes-page--hidden")).toBe(false);
		expect(treeEntry(container, "util.ts")).toBe(util);
		expect(listed).toEqual([".", "src"]);
	});
});

describe("a directory without git", () => {
	// Refuses the status as git does outside a repository, and answers a
	// file's content with `content`.
	function mockNotGit(content: Response = new Response("Hello, world!\n")) {
		globalThis.fetch = mock((input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("/api/git/status")) {
				return Promise.resolve(
					json(
						{
							error: {
								code: "NOT_GIT_REPO",
								message: "The working directory is not a git repository",
							},
						},
						400,
					),
				);
			}
			if (url.includes("/api/files/content")) {
				return Promise.resolve(content.clone());
			}
			return Promise.resolve(new Response("Not found", { status: 404 }));
		}) as typeof fetch;
	}

	async function openFile(container: HTMLElement, name: string) {
		await waitFor(() => {
			expect(treeNames(container)).toContain(name);
		});
		fireEvent.click(treeEntry(container, name));
	}

	test("says so when the directory is empty", async () => {
		mockNotGit();
		const { container } = renderFilesPage();

		await waitFor(() => {
			expect(container.querySelector(".changes-message")?.textContent).toBe(
				"No files found",
			);
		});
	});

	test("says so when the directory holds more than it lists", async () => {
		mockNotGit();
		const { container } = renderFilesPage(
			["/files"],
			{},
			{
				".": { entries: [file("file.txt")], truncated: true },
			},
		);

		await waitFor(() => {
			expect(
				container.querySelector(".files-truncated")?.textContent,
			).toContain("more than 1,000");
		});
	});

	test("opens a file in the editor alone, under its path", async () => {
		mockNotGit();
		const { container } = renderFilesPage(
			["/files"],
			{},
			{
				".": [file("hello.txt")],
			},
		);

		await openFile(container, "hello.txt");

		await waitFor(() => {
			expect(container.querySelector(".file-viewer")).not.toBeNull();
		});
		expect(screen.getByTestId("location-search").textContent).toBe(
			"?path=hello.txt",
		);
		expect(container.querySelector(".breadcrumbs")?.textContent).toContain(
			"hello.txt",
		);
		expect(screen.getByRole("button", { name: "Save" })).not.toBeNull();
		expect(screen.queryByRole("tablist") === null).toBe(true);
		await waitFor(() => {
			const more = screen.getByRole("button", { name: "More actions" });
			expect(
				container
					.querySelector(".files-header .files-header-menu")
					?.contains(more),
			).toBe(true);
		});
	});

	test("says why a file cannot be opened", async () => {
		for (const { name, status, error } of [
			{
				name: "image.bin",
				status: 415,
				error: {
					code: "BINARY_FILE",
					message: "Binary files are not supported",
				},
			},
			{
				name: "huge.log",
				status: 413,
				error: {
					code: "FILE_TOO_LARGE",
					message: "File exceeds maximum size of 1 MB",
				},
			},
		]) {
			mockNotGit(json({ error }, status));
			const { container } = renderFilesPage(
				["/files"],
				{},
				{
					".": [file(name)],
				},
			);

			await openFile(container, name);

			await waitFor(() => {
				expect(
					container.querySelector(".text-file-editor-error")?.textContent,
				).toContain(error.message);
			});
			cleanup();
		}
	});

	test("goes back to the tree with the file's folder open", async () => {
		mockNotGit();
		const { container, listed } = renderFilesPage(
			["/files", "/files?path=src/a.ts"],
			{},
			{ ".": [folder("src"), file("README.md")], src: [file("a.ts")] },
		);
		await waitFor(() => {
			expect(container.querySelector(".file-viewer")).not.toBeNull();
			expect(listed).toEqual(["."]);
		});

		fireEvent.click(screen.getByRole("button", { name: "Back to file tree" }));

		await waitFor(() => {
			expect(treeNames(container)).toEqual(["src", "a.ts", "README.md"]);
		});
		expect(screen.getByTestId("location-search").textContent).toBe("");
	});
});
