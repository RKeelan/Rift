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
import { ChangesPage } from "../pages/ChangesPage.tsx";

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

function renderChangesPage(
	initialEntries = ["/changes"],
	props: { writesAllowed?: boolean | null } = {},
) {
	return render(
		<MemoryRouter initialEntries={initialEntries}>
			<ErrorBannerProvider>
				<SessionProvider>
					<Routes>
						<Route
							path="/changes"
							element={
								<RouterHarness>
									<TestWrapper>
										<ChangesPage {...props} />
									</TestWrapper>
								</RouterHarness>
							}
						/>
					</Routes>
				</SessionProvider>
			</ErrorBannerProvider>
		</MemoryRouter>,
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
		diff?: { path: string; diff: string; truncated: boolean };
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

function editorBar(container: HTMLElement) {
	const bar = container.querySelector<HTMLElement>(".text-file-editor-bar");
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

describe("ChangesPage", () => {
	test("renders loading state initially", () => {
		globalThis.fetch = mock(() => new Promise(() => {})) as typeof fetch;

		const { container } = renderChangesPage();
		const loading = container.querySelector(".changes-message");
		expect(loading).not.toBeNull();
		expect(loading?.textContent).toBe("Loading...");
	});

	test("renders empty state when working tree is clean", async () => {
		mockFetchForChanges([]);

		const { container } = renderChangesPage();

		await waitFor(() => {
			const msg = container.querySelector(".changes-message");
			expect(msg).not.toBeNull();
			expect(msg?.textContent).toBe("Working tree clean");
		});
	});

	test("renders NOT_GIT_REPO error message", async () => {
		mockFetchForChanges([], { notGitRepo: true });

		const { container } = renderChangesPage();

		await waitFor(() => {
			const errorEl = container.querySelector(".changes-error");
			expect(errorEl).not.toBeNull();
			expect(errorEl?.textContent).toBe("Not a git repository");
		});
	});

	test("renders staged files under Staged section header", async () => {
		mockFetchForChanges([
			{ path: "src/app.ts", status: "modified", staged: true },
			{ path: "README.md", status: "added", staged: true },
		]);

		const { container } = renderChangesPage();

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

		const { container } = renderChangesPage();

		await waitFor(() => {
			const headers = container.querySelectorAll(".changes-section-header");
			expect(headers.length).toBe(1);
			expect(headers[0]?.textContent).toContain("Unstaged");
		});

		const filePaths = container.querySelectorAll(".changes-file-path");
		expect(filePaths[0]?.textContent).toBe("index.ts");
	});

	test("renders both staged and unstaged sections", async () => {
		mockFetchForChanges([
			{ path: "staged.ts", status: "added", staged: true },
			{ path: "unstaged.ts", status: "modified", staged: false },
		]);

		const { container } = renderChangesPage();

		await waitFor(() => {
			const headers = container.querySelectorAll(".changes-section-header");
			expect(headers.length).toBe(2);

			const headerTexts = Array.from(headers).map((el) => el.textContent);
			expect(headerTexts[0]).toContain("Staged");
			expect(headerTexts[1]).toContain("Unstaged");
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

		const { container } = renderChangesPage();

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

		const { container } = renderChangesPage();

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
				fileContent: {
					path: "scratch.txt",
					content: "draft line 1\ndraft line 2\n",
				},
			},
		);

		const { container } = renderChangesPage();

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

		await waitFor(() => {
			expect(container.querySelector(".cm-changedLine--added")).not.toBeNull();
		});
		expect(container.querySelector(".diff-viewer")).toBeNull();
	});

	test("shows filename and staged/unstaged label in diff header", async () => {
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

		const { container } = renderChangesPage();

		await waitFor(() => {
			expect(container.querySelectorAll(".changes-file-entry").length).toBe(1);
		});

		fireEvent.click(container.querySelector(".changes-file-entry") as Element);

		await waitFor(() => {
			const filename = container.querySelector(".changes-diff-filename");
			expect(filename).not.toBeNull();
			expect(filename?.textContent).toBe("src/utils.ts");
		});

		const label = container.querySelector(".changes-diff-staged-label");
		expect(label).not.toBeNull();
		expect(label?.textContent).toBe("staged");
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

		const { container } = renderChangesPage();

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

		const { container } = renderChangesPage();

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

		const { container } = renderChangesPage();

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

		const { container } = renderChangesPage();

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

	test("back button returns to changes list from diff view", async () => {
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

		const { container } = renderChangesPage();

		await waitFor(() => {
			expect(container.querySelectorAll(".changes-file-entry").length).toBe(1);
		});

		// Click file to go to diff view
		fireEvent.click(container.querySelector(".changes-file-entry") as Element);

		await waitFor(() => {
			expect(container.querySelector(".changes-diff-view")).not.toBeNull();
		});

		// Click back button
		const backButton = screen.getByLabelText("Back to changes list");
		fireEvent.click(backButton);

		// Should be back to the list
		await waitFor(() => {
			expect(container.querySelector(".changes-page")).not.toBeNull();
			expect(container.querySelector(".changes-diff-view")).toBeNull();
		});
	});

	test("browser back returns to changes list from diff view", async () => {
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

		const { container } = renderChangesPage();

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
			expect(container.querySelector(".changes-page")).not.toBeNull();
			expect(container.querySelector(".changes-diff-view")).toBeNull();
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

		const { container } = renderChangesPage();

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
			const result = renderChangesPage();
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
				name: "Back to changes list",
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
				screen.getByRole("button", { name: "Back to changes list" }),
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

		const { container } = renderChangesPage();

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

		const { container } = renderChangesPage();
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

		const { container } = renderChangesPage();
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

			const { container } = renderChangesPage();
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
					container.querySelector(".changes-editor-note")?.textContent,
				).toBe("Viewing the deleted file.");
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

		const { container } = renderChangesPage();
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
			expect(container.querySelector(".changes-page")).not.toBeNull();
			expect(container.querySelector(".changes-diff-view") === null).toBe(true);
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

		const { container } = renderChangesPage();
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
			expect(container.querySelector(".changes-page")).not.toBeNull();
			expect(container.querySelector(".changes-diff-view") === null).toBe(true);
		});
		expect(screen.getByLabelText("Unstage new.ts")).not.toBeNull();
	});

	test("refresh button is present", async () => {
		mockFetchForChanges([]);

		renderChangesPage();

		await waitFor(() => {
			const button = screen.getByLabelText("Refresh status");
			expect(button).not.toBeNull();
		});
	});

	test("shows last refreshed timestamp after load", async () => {
		mockFetchForChanges([]);

		const { container } = renderChangesPage();

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

		const { container } = renderChangesPage();

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

		const { container } = renderChangesPage();

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
			expect(container.querySelector(".changes-page")).not.toBeNull();
			expect(container.querySelector(".changes-diff-view")).toBeNull();
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

		const { container } = renderChangesPage(["/changes"], {
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
			container.querySelectorAll("button"),
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

		const { container } = renderChangesPage(["/changes"], {
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

		renderChangesPage();

		await waitFor(() => {
			expect(screen.getByLabelText("Stage app.ts")).not.toBeNull();
		});
		fireEvent.click(screen.getByLabelText("Stage app.ts"));

		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toContain(message);
		});
	});
});
