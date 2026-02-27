import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { SessionProvider, useSession } from "../contexts/SessionContext.tsx";

afterEach(() => {
	cleanup();
});

function TestComponent() {
	const { sessionId, repoName, setSession, clearSession } = useSession();

	return (
		<div>
			<div data-testid="sessionId">{sessionId ?? "null"}</div>
			<div data-testid="repoName">{repoName ?? "null"}</div>
			<button type="button" onClick={() => setSession("s1", "repo1")}>
				Set Session
			</button>
			<button type="button" onClick={() => clearSession()}>
				Clear Session
			</button>
		</div>
	);
}

describe("SessionContext", () => {
	test("provides null session and repo by default", () => {
		render(
			<SessionProvider>
				<TestComponent />
			</SessionProvider>,
		);

		expect(screen.getByTestId("sessionId").textContent).toBe("null");
		expect(screen.getByTestId("repoName").textContent).toBe("null");
	});

	test("setSession updates both sessionId and repoName", () => {
		render(
			<SessionProvider>
				<TestComponent />
			</SessionProvider>,
		);

		act(() => {
			screen.getByText("Set Session").click();
		});

		expect(screen.getByTestId("sessionId").textContent).toBe("s1");
		expect(screen.getByTestId("repoName").textContent).toBe("repo1");
	});

	test("clearSession resets both sessionId and repoName to null", () => {
		render(
			<SessionProvider>
				<TestComponent />
			</SessionProvider>,
		);

		// First set a session
		act(() => {
			screen.getByText("Set Session").click();
		});

		expect(screen.getByTestId("sessionId").textContent).toBe("s1");
		expect(screen.getByTestId("repoName").textContent).toBe("repo1");

		// Then clear it
		act(() => {
			screen.getByText("Clear Session").click();
		});

		expect(screen.getByTestId("sessionId").textContent).toBe("null");
		expect(screen.getByTestId("repoName").textContent).toBe("null");
	});

	test("throws error when useSession is used outside SessionProvider", () => {
		// Suppress console.error for this test
		const originalError = console.error;
		console.error = () => {};

		expect(() => {
			render(<TestComponent />);
		}).toThrow("useSession must be used within a SessionProvider");

		console.error = originalError;
	});
});
