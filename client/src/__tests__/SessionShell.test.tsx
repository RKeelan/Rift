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

function json(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function mockServer({ gitRepo }: { gitRepo: boolean }) {
	globalThis.fetch = ((input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("/api/health")) {
			return Promise.resolve(json({ status: "ok", gitRepo }));
		}
		if (url.includes("/api/files")) {
			return Promise.resolve(json({ entries: [], truncated: false }));
		}
		if (url.includes("/api/git/status")) {
			return Promise.resolve(json({ files: [] }));
		}
		return Promise.resolve(json({}));
	}) as typeof fetch;
}

function LocationProbe() {
	return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderShell() {
	globalThis.localStorage.setItem("rift:selected-repo", "RKeelan/Rift");
	return render(
		<MemoryRouter initialEntries={["/changes"]}>
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
	test("stays on the changes view for a git repo", async () => {
		mockServer({ gitRepo: true });

		renderShell();

		await waitFor(() => {
			// The changes tab and the page it mounts share a label; the tab alone
			// would not prove the route rendered.
			expect(
				screen.getByText("Changes", { selector: ".changes-header-title" }),
			).not.toBeNull();
		});
		expect(screen.getByTestId("location").textContent).toBe("/changes");
	});

	// The dashboard opens every repo on /changes, so a repo without git has to
	// land somewhere: the changes route is never mounted for it.
	test("falls back to files for a repo without git", async () => {
		mockServer({ gitRepo: false });

		renderShell();

		await waitFor(() => {
			expect(screen.getByTestId("location").textContent).toBe("/files");
		});
		expect(screen.queryByText("Changes")).toBeNull();
	});
});
