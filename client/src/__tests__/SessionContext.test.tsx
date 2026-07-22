import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { SessionProvider, useSession } from "../contexts/SessionContext.tsx";

beforeEach(() => {
	globalThis.localStorage.clear();
});

afterEach(() => {
	cleanup();
	globalThis.localStorage.clear();
});

function TestComponent() {
	const { repoName, recentRepos, selectRepo, clearRepo } = useSession();

	return (
		<div>
			<div data-testid="repoName">{repoName ?? "null"}</div>
			<div data-testid="recentRepos">{recentRepos.join(",")}</div>
			<button type="button" onClick={() => selectRepo("repo1")}>
				Select Repo
			</button>
			<button type="button" onClick={() => selectRepo("repo2")}>
				Select Other Repo
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

	test("selectRepo records the repo as the most recent", () => {
		render(
			<SessionProvider>
				<TestComponent />
			</SessionProvider>,
		);

		act(() => {
			screen.getByText("Select Repo").click();
		});
		act(() => {
			screen.getByText("Select Other Repo").click();
		});

		expect(screen.getByTestId("recentRepos").textContent).toBe("repo2,repo1");
		expect(globalThis.localStorage.getItem("rift:recent-repos")).toBe(
			JSON.stringify(["repo2", "repo1"]),
		);
	});

	test("reselecting a repo moves it to the front without duplicating it", () => {
		render(
			<SessionProvider>
				<TestComponent />
			</SessionProvider>,
		);

		act(() => {
			screen.getByText("Select Repo").click();
		});
		act(() => {
			screen.getByText("Select Other Repo").click();
		});
		act(() => {
			screen.getByText("Select Repo").click();
		});

		expect(screen.getByTestId("recentRepos").textContent).toBe("repo1,repo2");
	});

	test("restores recent repos from storage", () => {
		globalThis.localStorage.setItem(
			"rift:recent-repos",
			JSON.stringify(["repo3", "repo4"]),
		);

		render(
			<SessionProvider>
				<TestComponent />
			</SessionProvider>,
		);

		expect(screen.getByTestId("recentRepos").textContent).toBe("repo3,repo4");
	});

	test("clearRepo keeps the recent list", () => {
		render(
			<SessionProvider>
				<TestComponent />
			</SessionProvider>,
		);

		act(() => {
			screen.getByText("Select Repo").click();
		});
		act(() => {
			screen.getByText("Clear Repo").click();
		});

		expect(screen.getByTestId("recentRepos").textContent).toBe("repo1");
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
