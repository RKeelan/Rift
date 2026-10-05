import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ErrorBannerProvider } from "../components/ErrorBanner.tsx";
import { useGitRepo } from "../hooks/useGitRepo.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	cleanup();
	globalThis.fetch = originalFetch;
});

function wrapper({ children }: { children: ReactNode }) {
	return <ErrorBannerProvider>{children}</ErrorBannerProvider>;
}

function mockResponse(status: number, body: unknown) {
	globalThis.fetch = mock(async () =>
		Promise.resolve({
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
		}),
	) as unknown as typeof fetch;
}

describe("useGitRepo", () => {
	test("reports a git repo as such", async () => {
		mockResponse(200, { status: "ok", gitRepo: true });
		const { result } = renderHook(() => useGitRepo("RKeelan/Rift"), {
			wrapper,
		});

		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.isGitRepo).toBe(true);
		expect(result.current.repoMissing).toBe(false);
		expect(result.current.writesAllowed).toBe(true);
	});

	test("leaves writes unknown until the server answers", async () => {
		let answer = () => {};
		globalThis.fetch = mock(
			() =>
				new Promise((resolve) => {
					answer = () =>
						resolve({
							ok: true,
							status: 200,
							json: async () => ({ status: "ok", gitRepo: true }),
						});
				}),
		) as unknown as typeof fetch;
		const { result } = renderHook(() => useGitRepo("RKeelan/Rift"), {
			wrapper,
		});

		await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
		expect(result.current.writesAllowed).toBeNull();

		await act(async () => answer());
		await waitFor(() => expect(result.current.writesAllowed).toBe(true));
	});

	test("gives up on a health check that hangs, and assumes writes allowed", async () => {
		const timeout = new AbortController();
		const requested: number[] = [];
		const originalTimeout = AbortSignal.timeout;
		AbortSignal.timeout = (ms: number) => {
			requested.push(ms);
			return timeout.signal;
		};
		try {
			globalThis.fetch = mock(
				(_input: string, init?: RequestInit) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () =>
							reject(init.signal?.reason),
						);
					}),
			) as unknown as typeof fetch;
			const { result } = renderHook(() => useGitRepo("RKeelan/Rift"), {
				wrapper,
			});

			await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
			expect(requested).toEqual([5000]);
			expect(result.current.writesAllowed).toBeNull();

			act(() => {
				timeout.abort(new DOMException("Timed out", "TimeoutError"));
			});
			await waitFor(() => expect(result.current.writesAllowed).toBe(true));
		} finally {
			AbortSignal.timeout = originalTimeout;
		}
	});

	test("reports when the server refuses writes", async () => {
		mockResponse(200, { status: "ok", gitRepo: true, writesAllowed: false });
		const { result } = renderHook(() => useGitRepo("RKeelan/Rift"), {
			wrapper,
		});

		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.writesAllowed).toBe(false);
	});

	test("flags a repo the server cannot resolve", async () => {
		mockResponse(404, {
			error: { code: "NOT_FOUND", message: "Repository not found" },
		});
		const { result } = renderHook(() => useGitRepo("stale/repo"), { wrapper });

		await waitFor(() => expect(result.current.repoMissing).toBe(true));
	});

	test("flags a forbidden repo name", async () => {
		mockResponse(403, {
			error: { code: "REPO_FORBIDDEN", message: "Invalid repo name" },
		});
		const { result } = renderHook(() => useGitRepo("../etc"), { wrapper });

		await waitFor(() => expect(result.current.repoMissing).toBe(true));
	});

	test("stays optimistic when the server is unreachable", async () => {
		globalThis.fetch = mock(async () =>
			Promise.reject(new Error("Network error")),
		) as unknown as typeof fetch;
		const { result } = renderHook(() => useGitRepo("RKeelan/Rift"), {
			wrapper,
		});

		// A dropped connection must not discard a valid selection.
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.isGitRepo).toBe(true);
		expect(result.current.repoMissing).toBe(false);
		// The server refuses writes itself, so an unreachable one is not taken
		// to refuse them.
		expect(result.current.writesAllowed).toBe(true);
	});
});
