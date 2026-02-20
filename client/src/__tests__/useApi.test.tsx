import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { ErrorBannerProvider } from "../components/ErrorBanner.tsx";
import { useApi } from "../hooks/useApi.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	cleanup();
	globalThis.fetch = originalFetch;
});

/**
 * Test harness component that uses useApi and displays results.
 */
function ApiConsumer({ url, silent }: { url: string; silent?: boolean }) {
	const { request } = useApi();
	const [result, setResult] = useState<string>("idle");

	const doRequest = async () => {
		setResult("loading");
		const data = await request<{ value: string }>(
			url,
			silent ? { silent: true } : undefined,
		);
		setResult(data ? data.value : "null");
	};

	return (
		<div>
			<button type="button" onClick={doRequest}>
				Fetch
			</button>
			<span data-testid="result">{result}</span>
		</div>
	);
}

function renderApiConsumer(url = "/api/test", silent = false) {
	return render(
		<ErrorBannerProvider>
			<ApiConsumer url={url} silent={silent} />
		</ErrorBannerProvider>,
	);
}

describe("useApi", () => {
	test("returns parsed JSON on successful response", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ value: "success" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		) as typeof fetch;

		renderApiConsumer();
		await act(async () => {
			fireEvent.click(screen.getByText("Fetch"));
		});

		await waitFor(() => {
			expect(screen.getByTestId("result").textContent).toBe("success");
		});
	});

	test("returns null and shows error banner on non-2xx with error envelope", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						error: { code: "NOT_FOUND", message: "Resource not found" },
					}),
					{
						status: 404,
						headers: { "Content-Type": "application/json" },
					},
				),
			),
		) as typeof fetch;

		renderApiConsumer();
		await act(async () => {
			fireEvent.click(screen.getByText("Fetch"));
		});

		await waitFor(() => {
			expect(screen.getByTestId("result").textContent).toBe("null");
		});
		expect(screen.getByRole("alert")).toBeDefined();
		expect(screen.getByText("Resource not found")).toBeDefined();
	});

	test("returns null and shows generic error on non-2xx without error envelope", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response("Internal Server Error", {
					status: 500,
				}),
			),
		) as typeof fetch;

		renderApiConsumer();
		await act(async () => {
			fireEvent.click(screen.getByText("Fetch"));
		});

		await waitFor(() => {
			expect(screen.getByTestId("result").textContent).toBe("null");
		});
		expect(screen.getByRole("alert")).toBeDefined();
		expect(screen.getByText("Request failed (500)")).toBeDefined();
	});

	test("returns null and shows network error on fetch failure", async () => {
		globalThis.fetch = mock(() =>
			Promise.reject(new Error("Failed to fetch")),
		) as typeof fetch;

		renderApiConsumer();
		await act(async () => {
			fireEvent.click(screen.getByText("Fetch"));
		});

		await waitFor(() => {
			expect(screen.getByTestId("result").textContent).toBe("null");
		});
		expect(screen.getByRole("alert")).toBeDefined();
		expect(screen.getByText("Failed to fetch")).toBeDefined();
	});

	test("does not show error banner when silent option is true", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						error: { code: "FAIL", message: "Silent error" },
					}),
					{ status: 500, headers: { "Content-Type": "application/json" } },
				),
			),
		) as typeof fetch;

		renderApiConsumer("/api/test", true);
		await act(async () => {
			fireEvent.click(screen.getByText("Fetch"));
		});

		await waitFor(() => {
			expect(screen.getByTestId("result").textContent).toBe("null");
		});
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
