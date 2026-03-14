import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { SessionProvider, useSession } from "../contexts/SessionContext.tsx";

afterEach(() => {
	cleanup();
	globalThis.localStorage.clear();
});

function TestComponent() {
	const { repoName, selectRepo, clearRepo } = useSession();

	return (
		<div>
			<div data-testid="repoName">{repoName ?? "null"}</div>
			<button type="button" onClick={() => selectRepo("repo1")}>
				Select Repo
			</button>
			<button type="button" onClick={() => clearRepo()}>
				Clear Repo
			</button>
		</div>
	);
}

describe("SessionContext", () => {
	test("provides a null repo by default", () => {
		render(
			<SessionProvider>
				<TestComponent />
			</SessionProvider>,
		);

		expect(screen.getByTestId("repoName").textContent).toBe("null");
	});

	test("selectRepo updates the selected repo", () => {
		render(
			<SessionProvider>
				<TestComponent />
			</SessionProvider>,
		);

		act(() => {
			screen.getByText("Select Repo").click();
		});

		expect(screen.getByTestId("repoName").textContent).toBe("repo1");
		expect(globalThis.localStorage.getItem("rift:selected-repo")).toBe("repo1");
	});

	test("clearRepo resets the selected repo to null", () => {
		render(
			<SessionProvider>
				<TestComponent />
			</SessionProvider>,
		);

		act(() => {
			screen.getByText("Select Repo").click();
		});

		expect(screen.getByTestId("repoName").textContent).toBe("repo1");

		act(() => {
			screen.getByText("Clear Repo").click();
		});

		expect(screen.getByTestId("repoName").textContent).toBe("null");
		expect(globalThis.localStorage.getItem("rift:selected-repo")).toBeNull();
	});

	test("throws error when useSession is used outside SessionProvider", () => {
		const originalError = console.error;
		console.error = () => {};

		expect(() => {
			render(<TestComponent />);
		}).toThrow("useSession must be used within a SessionProvider");

		console.error = originalError;
	});
});
