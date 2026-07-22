import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { ErrorBannerProvider } from "../components/ErrorBanner.tsx";
import { SessionProvider } from "../contexts/SessionContext.tsx";
import { DashboardPage } from "../pages/DashboardPage.tsx";

const originalFetch = globalThis.fetch;

afterEach(() => {
	cleanup();
	globalThis.fetch = originalFetch;
	globalThis.localStorage.clear();
});

function mockRepos(repos: { name: string; path: string }[]) {
	globalThis.fetch = mock(() =>
		Promise.resolve(
			new Response(JSON.stringify({ repos }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		),
	) as typeof fetch;
}

function LocationProbe() {
	return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderDashboard() {
	return render(
		<MemoryRouter>
			<ErrorBannerProvider>
				<SessionProvider>
					<DashboardPage />
					<LocationProbe />
				</SessionProvider>
			</ErrorBannerProvider>
		</MemoryRouter>,
	);
}

describe("DashboardPage", () => {
	test("renders loading state initially", () => {
		globalThis.fetch = mock(() => new Promise(() => {})) as typeof fetch;

		renderDashboard();

		expect(screen.getByText("Loading repositories...")).not.toBeNull();
	});

	test("renders empty state when no repositories exist", async () => {
		mockRepos([]);

		renderDashboard();

		await waitFor(() => {
			expect(screen.getByText("No repositories found")).not.toBeNull();
		});

		expect(screen.getByText(/REPOS_ROOT/)).not.toBeNull();
	});

	test("groups repositories under their root", async () => {
		mockRepos([
			{ name: "RKeelan/Rift", path: "/repos/RKeelan/Rift" },
			{ name: "RKeelan/OtherRepo", path: "/repos/RKeelan/OtherRepo" },
			{ name: "Writing/Coder", path: "/writing/Coder" },
		]);

		renderDashboard();

		await waitFor(() => {
			expect(screen.getByText("RKeelan")).not.toBeNull();
		});

		expect(screen.getByText("Writing")).not.toBeNull();
		// Cards drop the root label their group header already carries.
		expect(screen.getByText("Rift")).not.toBeNull();
		expect(screen.getByText("OtherRepo")).not.toBeNull();
		expect(screen.getByText("Coder")).not.toBeNull();
		expect(screen.getByText("2")).not.toBeNull();
	});

	test("shows repository paths", async () => {
		mockRepos([{ name: "RKeelan/Rift", path: "/repos/RKeelan/Rift" }]);

		renderDashboard();

		await waitFor(() => {
			expect(screen.getByText("/repos/RKeelan/Rift")).not.toBeNull();
		});
	});

	test("selects a repository and opens the changes view", async () => {
		mockRepos([{ name: "RKeelan/Rift", path: "/repos/RKeelan/Rift" }]);

		renderDashboard();

		await waitFor(() => {
			expect(screen.getByText("Rift")).not.toBeNull();
		});

		fireEvent.click(screen.getByText("Rift"));

		await waitFor(() => {
			expect(globalThis.localStorage.getItem("rift:selected-repo")).toBe(
				"RKeelan/Rift",
			);
		});
		expect(screen.getByTestId("location").textContent).toBe("/changes");
	});

	test("records the selection as a recent repository", async () => {
		mockRepos([{ name: "RKeelan/Rift", path: "/repos/RKeelan/Rift" }]);

		renderDashboard();

		await waitFor(() => {
			expect(screen.getByText("Rift")).not.toBeNull();
		});

		fireEvent.click(screen.getByText("Rift"));

		await waitFor(() => {
			expect(globalThis.localStorage.getItem("rift:recent-repos")).toBe(
				JSON.stringify(["RKeelan/Rift"]),
			);
		});
		// The recents section names the root the group header would have supplied.
		expect(screen.getByText("Recent")).not.toBeNull();
		expect(screen.getByText("RKeelan/Rift")).not.toBeNull();
	});

	test("shows five recents before offering the rest", async () => {
		const names = ["One", "Two", "Three", "Four", "Five", "Six", "Seven"];
		mockRepos(
			names.map((name) => ({
				name: `RKeelan/${name}`,
				path: `/repos/RKeelan/${name}`,
			})),
		);
		globalThis.localStorage.setItem(
			"rift:recent-repos",
			JSON.stringify(names.map((name) => `RKeelan/${name}`)),
		);

		renderDashboard();

		await waitFor(() => {
			expect(screen.getByText("Recent")).not.toBeNull();
		});

		expect(screen.getByText("RKeelan/Five")).not.toBeNull();
		expect(screen.queryByText("RKeelan/Six")).toBeNull();

		fireEvent.click(screen.getByText("Show 2 more"));

		expect(screen.getByText("RKeelan/Six")).not.toBeNull();
		expect(screen.getByText("RKeelan/Seven")).not.toBeNull();

		fireEvent.click(screen.getByText("Show fewer"));

		expect(screen.queryByText("RKeelan/Six")).toBeNull();
	});

	test("drops recents the server no longer lists", async () => {
		mockRepos([{ name: "RKeelan/Rift", path: "/repos/RKeelan/Rift" }]);
		globalThis.localStorage.setItem(
			"rift:recent-repos",
			JSON.stringify(["RKeelan/Renamed", "RKeelan/Rift"]),
		);

		renderDashboard();

		await waitFor(() => {
			expect(screen.getByText("RKeelan/Rift")).not.toBeNull();
		});

		expect(screen.queryByText("RKeelan/Renamed")).toBeNull();
	});

	test("collapses a root and remembers it", async () => {
		mockRepos([
			{ name: "RKeelan/Rift", path: "/repos/RKeelan/Rift" },
			{ name: "Writing/Coder", path: "/writing/Coder" },
		]);

		renderDashboard();

		await waitFor(() => {
			expect(screen.getByText("Rift")).not.toBeNull();
		});

		fireEvent.click(screen.getByText("RKeelan"));

		expect(screen.queryByText("Rift")).toBeNull();
		expect(screen.getByText("Coder")).not.toBeNull();
		expect(globalThis.localStorage.getItem("rift:collapsed-roots")).toBe(
			JSON.stringify(["RKeelan"]),
		);

		fireEvent.click(screen.getByText("RKeelan"));

		expect(screen.getByText("Rift")).not.toBeNull();
		expect(globalThis.localStorage.getItem("rift:collapsed-roots")).toBe("[]");
	});

	test("restores collapsed roots from a previous visit", async () => {
		mockRepos([
			{ name: "RKeelan/Rift", path: "/repos/RKeelan/Rift" },
			{ name: "Writing/Coder", path: "/writing/Coder" },
		]);
		globalThis.localStorage.setItem(
			"rift:collapsed-roots",
			JSON.stringify(["Writing"]),
		);

		renderDashboard();

		await waitFor(() => {
			expect(screen.getByText("Rift")).not.toBeNull();
		});

		expect(screen.queryByText("Coder")).toBeNull();
		expect(screen.getByText("Writing")).not.toBeNull();
	});

	test("ignores malformed collapsed-root storage", async () => {
		mockRepos([{ name: "RKeelan/Rift", path: "/repos/RKeelan/Rift" }]);
		globalThis.localStorage.setItem("rift:collapsed-roots", "not json");

		renderDashboard();

		await waitFor(() => {
			expect(screen.getByText("Rift")).not.toBeNull();
		});
	});
});
