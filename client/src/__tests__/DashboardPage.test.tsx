import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ErrorBannerProvider } from "../components/ErrorBanner.tsx";
import { SessionProvider } from "../contexts/SessionContext.tsx";
import { DashboardPage } from "../pages/DashboardPage.tsx";

const originalFetch = globalThis.fetch;

afterEach(() => {
	cleanup();
	globalThis.fetch = originalFetch;
	globalThis.localStorage.clear();
});

function renderDashboard() {
	return render(
		<MemoryRouter>
			<ErrorBannerProvider>
				<SessionProvider>
					<DashboardPage />
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
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ repos: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		) as typeof fetch;

		renderDashboard();

		await waitFor(() => {
			expect(screen.getByText("No repositories found")).not.toBeNull();
		});

		expect(screen.getByText(/REPOS_ROOT/)).not.toBeNull();
	});

	test("renders list of repositories", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						repos: [
							{ name: "RKeelan/Rift", path: "/repos/RKeelan/Rift" },
							{
								name: "RKeelan/OtherRepo",
								path: "/repos/RKeelan/OtherRepo",
							},
						],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			),
		) as typeof fetch;

		renderDashboard();

		await waitFor(() => {
			expect(screen.getByText("RKeelan/Rift")).not.toBeNull();
		});

		expect(screen.getByText("RKeelan/OtherRepo")).not.toBeNull();
	});

	test("shows repository paths", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						repos: [{ name: "RKeelan/Rift", path: "/repos/RKeelan/Rift" }],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			),
		) as typeof fetch;

		renderDashboard();

		await waitFor(() => {
			expect(screen.getByText("/repos/RKeelan/Rift")).not.toBeNull();
		});
	});

	test("selects a repository when clicked", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						repos: [{ name: "RKeelan/Rift", path: "/repos/RKeelan/Rift" }],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			),
		) as typeof fetch;

		renderDashboard();

		await waitFor(() => {
			expect(screen.getByText("RKeelan/Rift")).not.toBeNull();
		});

		fireEvent.click(screen.getByText("RKeelan/Rift"));

		await waitFor(() => {
			expect(globalThis.localStorage.getItem("rift:selected-repo")).toBe(
				"RKeelan/Rift",
			);
		});
	});
});
