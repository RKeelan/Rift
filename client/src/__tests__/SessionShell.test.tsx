import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { ErrorBannerProvider } from "../components/ErrorBanner.tsx";
import { SessionShell } from "../components/SessionShell.tsx";
import { SessionProvider } from "../contexts/SessionContext.tsx";

const originalFetch = globalThis.fetch;

beforeEach(() => {
	globalThis.localStorage.clear();
});

afterEach(() => {
	cleanup();
	globalThis.fetch = originalFetch;
	globalThis.localStorage.clear();
});

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function mockServer({ gitRepo }: { gitRepo: boolean }) {
	globalThis.fetch = ((input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("/api/health")) {
			return Promise.resolve(json({ status: "ok", gitRepo }));
		}
		if (url.includes("/api/files/content")) {
			return Promise.resolve(new Response("current\n"));
		}
		if (url.includes("/api/files")) {
			return Promise.resolve(
				json({
					entries: [{ name: "README.md", type: "file", size: 1 }],
					truncated: false,
				}),
			);
		}
		if (url.includes("/api/git/status")) {
			return Promise.resolve(
				gitRepo
					? json({ files: [] })
					: json(
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
		return Promise.resolve(json({}));
	}) as typeof fetch;
}

function LocationProbe() {
	const { pathname, search } = useLocation();
	return <div data-testid="location">{`${pathname}${search}`}</div>;
}

function renderShell(initialEntry: string) {
	globalThis.localStorage.setItem("rift:selected-repo", "RKeelan/Rift");
	return render(
		<MemoryRouter initialEntries={[initialEntry]}>
			<ErrorBannerProvider>
				<SessionProvider>
					<SessionShell />
					<LocationProbe />
				</SessionProvider>
			</ErrorBannerProvider>
		</MemoryRouter>,
	);
}

describe("SessionShell", () => {
	test("offers Files and History for a git repo, and no Changes tab", async () => {
		mockServer({ gitRepo: true });

		renderShell("/files");

		await waitFor(() => {
			expect(screen.getByText("Unchanged")).not.toBeNull();
		});
		expect(
			[...document.querySelectorAll(".tab-bar-label")].map(
				(label) => label.textContent,
			),
		).toEqual(["Files", "History"]);
	});

	// The changes once had a tab of their own, whose URLs an installed app or
	// a history entry may still hold, with a file open in the query.
	test("sends an old changes URL to Files, keeping its query", async () => {
		mockServer({ gitRepo: true });

		renderShell("/changes?path=README.md&staged=false");

		await waitFor(() => {
			expect(screen.getByTestId("location").textContent).toBe(
				"/files?path=README.md&staged=false",
			);
			expect(
				screen.getByText("README.md", {
					selector: ".text-file-editor-name-file",
				}),
			).not.toBeNull();
		});
	});

	test("leaves out the tabs while a file is open, which has its own bar", async () => {
		for (const { gitRepo, file } of [
			{ gitRepo: true, file: "/files?path=README.md&staged=false" },
			{ gitRepo: false, file: "/files?path=README.md" },
		]) {
			mockServer({ gitRepo });
			renderShell(file);
			await waitFor(() => {
				expect(document.querySelector(".text-file-editor-bar")).not.toBeNull();
			});
			expect(
				screen.queryByRole("navigation", { name: "Main navigation" }),
			).toBe(null);
			cleanup();

			renderShell("/files");
			await screen.findByRole("navigation", { name: "Main navigation" });
			cleanup();
		}
	});

	test("sends an old changes URL to Files for a repo without git", async () => {
		mockServer({ gitRepo: false });

		renderShell("/changes");

		await waitFor(() => {
			expect(screen.getByTestId("location").textContent).toBe("/files");
			expect(screen.getByText("README.md")).not.toBeNull();
		});
		expect(screen.queryByText("Unchanged")).toBeNull();
		expect(screen.queryByText("History")).toBeNull();
	});
});
