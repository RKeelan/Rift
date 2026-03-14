import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TabBar } from "../components/TabBar.tsx";
import { SessionProvider } from "../contexts/SessionContext.tsx";

afterEach(cleanup);

function renderTabBar(isGitRepo: boolean | null, initialRoute = "/files") {
	return render(
		<SessionProvider>
			<MemoryRouter initialEntries={[initialRoute]}>
				<TabBar isGitRepo={isGitRepo} repoName="test-repo" />
			</MemoryRouter>
		</SessionProvider>,
	);
}

describe("TabBar", () => {
	test("renders all three tabs when isGitRepo is true", () => {
		renderTabBar(true);
		expect(screen.getByText("Files")).toBeDefined();
		expect(screen.getByText("Changes")).toBeDefined();
		expect(screen.getByText("History")).toBeDefined();
	});

	test("renders all three tabs when isGitRepo is null", () => {
		renderTabBar(null);
		expect(screen.getByText("Files")).toBeDefined();
		expect(screen.getByText("Changes")).toBeDefined();
		expect(screen.getByText("History")).toBeDefined();
	});

	test("hides git-only tabs when isGitRepo is false", () => {
		renderTabBar(false);
		expect(screen.getByText("Files")).toBeDefined();
		expect(screen.queryByText("Changes")).toBeNull();
		expect(screen.queryByText("History")).toBeNull();
	});

	test("each tab links to the correct route", () => {
		renderTabBar(true);
		const filesLink = screen.getByText("Files").closest("a");
		const changesLink = screen.getByText("Changes").closest("a");
		const historyLink = screen.getByText("History").closest("a");

		expect(filesLink?.getAttribute("href")).toBe("/files");
		expect(changesLink?.getAttribute("href")).toBe("/changes");
		expect(historyLink?.getAttribute("href")).toBe("/history");
	});

	test("active tab receives the active CSS class", () => {
		renderTabBar(true, "/files");
		const filesLink = screen.getByText("Files").closest("a");
		expect(filesLink?.className).toContain("tab-bar-item--active");
	});

	test("has accessible navigation landmark", () => {
		renderTabBar(true);
		const nav = screen.getByRole("navigation", { name: "Main navigation" });
		expect(nav).toBeDefined();
	});
});
