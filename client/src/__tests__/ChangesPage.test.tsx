import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
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

function renderChangesPage(initialEntries = ["/changes"]) {
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
										<ChangesPage />
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
		fileContent?: { path: string; content: string };
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

		if (url.includes("/api/files/content")) {
			if (options?.fileContent) {
				return Promise.resolve(
					new Response(options.fileContent.content, {
						status: 200,
						headers: { "Content-Type": "text/plain" },
					}),
				);
			}

			return Promise.resolve(new Response("", { status: 200 }));
		}

		return Promise.resolve(new Response("Not found", { status: 404 }));
	}) as typeof fetch;
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

	test("displays diff when file is clicked", async () => {
		const diffContent = "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new";

		mockFetchForChanges(
			[{ path: "file.ts", status: "modified", staged: false }],
			{
				diff: {
					path: "file.ts",
					diff: diffContent,
					truncated: false,
				},
			},
		);

		const { container } = renderChangesPage();

		await waitFor(() => {
			expect(container.querySelectorAll(".changes-file-entry").length).toBe(1);
		});

		const fileEntry = container.querySelector(".changes-file-entry") as Element;
		fireEvent.click(fileEntry);

		// Should switch to the diff view
		await waitFor(() => {
			const diffView = container.querySelector(".changes-diff-view");
			expect(diffView).not.toBeNull();
		});

		// DiffViewer should render the diff with coloured lines
		const diffViewer = container.querySelector(".diff-viewer");
		expect(diffViewer).not.toBeNull();

		// Check for add/remove line classes
		const addLine = container.querySelector(".diff-add");
		expect(addLine).not.toBeNull();
		expect(addLine?.textContent).toContain("+new");

		const removeLine = container.querySelector(".diff-remove");
		expect(removeLine).not.toBeNull();
		expect(removeLine?.textContent).toContain("-old");

		// Check hunk header styling
		const hunkLine = container.querySelector(".diff-hunk");
		expect(hunkLine).not.toBeNull();
	});

	test("shows untracked file content instead of no diff", async () => {
		mockFetchForChanges(
			[{ path: "scratch.txt", status: "untracked", staged: false }],
			{
				fileContent: {
					path: "scratch.txt",
					content: "- draft line 1\n- draft line 2\n",
				},
			},
		);

		const { container } = renderChangesPage();

		await waitFor(() => {
			expect(container.querySelectorAll(".changes-file-entry").length).toBe(1);
		});

		fireEvent.click(container.querySelector(".changes-file-entry") as Element);

		await waitFor(() => {
			const diffViewer = container.querySelector(".diff-viewer");
			expect(diffViewer).not.toBeNull();
			expect(diffViewer?.textContent).toContain("- draft line 1");
			expect(container.querySelector(".diff-remove")).toBeNull();
			expect(container.querySelector(".changes-message")?.textContent).not.toBe(
				"No diff available",
			);
		});
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

	test("back button returns to changes list from diff view", async () => {
		mockFetchForChanges(
			[{ path: "app.ts", status: "modified", staged: false }],
			{
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

	test("status refresh does not reload the open diff", async () => {
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

			return Promise.resolve(new Response("Not found", { status: 404 }));
		}) as typeof fetch;

		const { container } = renderChangesPage();

		await waitFor(() => {
			expect(container.querySelectorAll(".changes-file-entry").length).toBe(1);
		});

		fireEvent.click(container.querySelector(".changes-file-entry") as Element);

		await waitFor(() => {
			expect(container.querySelector(".changes-diff-view")).not.toBeNull();
			expect(diffRequests).toBe(1);
		});

		fireEvent(document, new Event("visibilitychange"));

		await waitFor(() => {
			expect(diffRequests).toBe(1);
		});
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
});
