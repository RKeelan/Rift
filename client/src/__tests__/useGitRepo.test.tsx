import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
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
	});
});
