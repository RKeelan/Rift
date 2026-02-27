import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	act,
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
		// Mock fetch that never resolves
		globalThis.fetch = mock(() => new Promise(() => {})) as typeof fetch;

		renderDashboard();

		expect(screen.getByText("Loading sessions...")).not.toBeNull();
	});

	test("renders empty state when no sessions exist", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify([]), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		) as typeof fetch;

		renderDashboard();

		await waitFor(() => {
			expect(screen.getByText("No active sessions")).not.toBeNull();
		});

		expect(screen.getByText("Create your first session")).not.toBeNull();
	});

	test("renders list of active sessions", async () => {
		const sessions = [
			{
				id: "session-1",
				state: "running",
				createdAt: "2026-02-27T10:00:00Z",
				repo: "RKeelan/Rift",
			},
			{
				id: "session-2",
				state: "running",
				createdAt: "2026-02-27T11:00:00Z",
				repo: "RKeelan/OtherRepo",
			},
		];

		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify(sessions), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		) as typeof fetch;

		renderDashboard();

		await waitFor(() => {
			expect(screen.getByText("RKeelan/Rift")).not.toBeNull();
		});

		expect(screen.getByText("RKeelan/OtherRepo")).not.toBeNull();
	});

	test("filters out stopped sessions", async () => {
		const sessions = [
			{
				id: "session-1",
				state: "running",
				createdAt: "2026-02-27T10:00:00Z",
				repo: "RKeelan/Rift",
			},
			{
				id: "session-2",
				state: "stopped",
				createdAt: "2026-02-27T11:00:00Z",
				repo: "RKeelan/StoppedRepo",
			},
		];

		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify(sessions), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		) as typeof fetch;

		renderDashboard();

		await waitFor(() => {
			expect(screen.getByText("RKeelan/Rift")).not.toBeNull();
		});

		// Stopped session should not appear
		const stoppedText = screen.queryByText("RKeelan/StoppedRepo");
		expect(stoppedText).toBeNull();
	});

	test("renders New Session button", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify([]), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		) as typeof fetch;

		renderDashboard();

		await waitFor(() => {
			expect(screen.getByText("No active sessions")).not.toBeNull();
		});

		const newSessionButton = screen.getByText("New Session");
		expect(newSessionButton).not.toBeNull();

		// Also check that clicking doesn't crash
		fireEvent.click(newSessionButton);
	});

	test("stops session when delete button is clicked", async () => {
		const sessions = [
			{
				id: "session-1",
				state: "running",
				createdAt: "2026-02-27T10:00:00Z",
				repo: "RKeelan/Rift",
			},
		];

		// Mock confirm to return true
		const originalConfirm = window.confirm;
		window.confirm = () => true;

		let deleteCalled = false;
		let fetchCount = 0;
		globalThis.fetch = mock(
			(input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				const method = init?.method || "GET";

				fetchCount++;

				// DELETE request
				if (method === "DELETE" && url.includes("/api/sessions/session-1")) {
					deleteCalled = true;
					return Promise.resolve(
						new Response(
							JSON.stringify({
								id: "session-1",
								state: "stopped",
								createdAt: "2026-02-27T10:00:00Z",
								repo: "RKeelan/Rift",
							}),
							{
								status: 200,
								headers: { "Content-Type": "application/json" },
							},
						),
					);
				}

				// GET sessions - return empty array after delete
				return Promise.resolve(
					new Response(JSON.stringify(deleteCalled ? [] : sessions), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			},
		) as typeof fetch;

		const { container } = renderDashboard();

		// Wait for session to appear
		await waitFor(() => {
			expect(screen.getByText("RKeelan/Rift")).not.toBeNull();
		});

		// Click the stop button
		const stopButton = container.querySelector(
			".session-card-stop",
		) as HTMLElement;
		expect(stopButton).not.toBeNull();

		await act(async () => {
			fireEvent.click(stopButton);
		});

		// Session should disappear and show empty state
		await waitFor(() => {
			expect(screen.getByText("No active sessions")).not.toBeNull();
		});

		// Verify DELETE was called
		expect(deleteCalled).toBe(true);

		// Restore original confirm
		window.confirm = originalConfirm;
	});

	test("displays session creation time", async () => {
		const sessions = [
			{
				id: "session-1",
				state: "running",
				createdAt: "2026-02-27T10:00:00Z",
				repo: "RKeelan/Rift",
			},
		];

		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify(sessions), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		) as typeof fetch;

		renderDashboard();

		await waitFor(() => {
			const createdText = screen.getByText(/Created/);
			expect(createdText).not.toBeNull();
			expect(createdText.textContent).toContain("Created");
		});
	});

	test("header shows New Session button", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify([]), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		) as typeof fetch;

		renderDashboard();

		await waitFor(() => {
			const newButton = screen.getByText("New Session");
			expect(newButton).not.toBeNull();
		});
	});
});
