import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TabBar } from "../components/TabBar.tsx";

afterEach(cleanup);

function renderTabBar(isGitRepo: boolean | null, initialRoute = "/chat") {
	return render(
		<MemoryRouter initialEntries={[initialRoute]}>
			<TabBar isGitRepo={isGitRepo} />
		</MemoryRouter>,
	);
}

describe("TabBar", () => {
	test("renders all four tabs when isGitRepo is true", () => {
		renderTabBar(true);
		expect(screen.getByText("Chat")).toBeDefined();
		expect(screen.getByText("Files")).toBeDefined();
		expect(screen.getByText("Changes")).toBeDefined();
		expect(screen.getByText("History")).toBeDefined();
	});

	test("renders all four tabs when isGitRepo is null (loading/unknown)", () => {
		renderTabBar(null);
		expect(screen.getByText("Chat")).toBeDefined();
		expect(screen.getByText("Files")).toBeDefined();
		expect(screen.getByText("Changes")).toBeDefined();
		expect(screen.getByText("History")).toBeDefined();
	});

	test("hides Changes and History tabs when isGitRepo is false", () => {
		renderTabBar(false);
		expect(screen.getByText("Chat")).toBeDefined();
		expect(screen.getByText("Files")).toBeDefined();
		expect(screen.queryByText("Changes")).toBeNull();
		expect(screen.queryByText("History")).toBeNull();
	});

	test("each tab links to the correct route", () => {
		renderTabBar(true);
		const chatLink = screen.getByText("Chat").closest("a");
		const filesLink = screen.getByText("Files").closest("a");
		const changesLink = screen.getByText("Changes").closest("a");
		const historyLink = screen.getByText("History").closest("a");

		expect(chatLink?.getAttribute("href")).toBe("/chat");
		expect(filesLink?.getAttribute("href")).toBe("/files");
		expect(changesLink?.getAttribute("href")).toBe("/changes");
		expect(historyLink?.getAttribute("href")).toBe("/history");
	});

	test("active tab receives the active CSS class", () => {
		renderTabBar(true, "/files");
		const filesLink = screen.getByText("Files").closest("a");
		expect(filesLink?.className).toContain("tab-bar-item--active");

		const chatLink = screen.getByText("Chat").closest("a");
		expect(chatLink?.className).not.toContain("tab-bar-item--active");
	});

	test("has accessible navigation landmark", () => {
		renderTabBar(true);
		const nav = screen.getByRole("navigation", { name: "Main navigation" });
		expect(nav).toBeDefined();
	});
});
