import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { ErrorBannerProvider } from "../components/ErrorBanner.tsx";
import { SessionShell } from "../components/SessionShell.tsx";
import { SessionProvider, useSession } from "../contexts/SessionContext.tsx";

const originalFetch = globalThis.fetch;

beforeEach(() => {
	globalThis.localStorage.clear();
});

afterEach(() => {
	cleanup();
	globalThis.fetch = originalFetch;
	globalThis.localStorage.clear();
});

interface DirEntry {
	name: string;
	type: "file" | "directory";
	size: number;
}

interface StatusFile {
	path: string;
	status: string;
	staged: boolean;
}

interface Repo {
	files: StatusFile[];
	folders: Record<string, DirEntry[]>;
}

const file = (name: string): DirEntry => ({ name, type: "file", size: 1 });
const folder = (name: string): DirEntry => ({
	name,
	type: "directory",
	size: 0,
});

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const ONE = (): Repo => ({
	files: [{ path: "docs/notes.md", status: "modified", staged: false }],
	folders: {
		".": [folder("docs"), folder("src"), file("README.md")],
		docs: [file("notes.md")],
		src: [folder("lib"), file("a.ts"), file("b.ts")],
		"src/lib": [file("c.ts")],
	},
});

const TWO = (): Repo => ({
	files: [{ path: "two.txt", status: "untracked", staged: false }],
	folders: { ".": [file("TWO.md"), file("two.txt")] },
});

const STATUS = "/api/git/status?repo=root%2Fone";
const HEALTH = "/api/health?repo=root%2Fone";
const folderRead = (path: string) =>
	`/api/files?repo=root%2Fone&path=${encodeURIComponent(path)}`;

/**
 * Answers the API for the repos named, reading each answer as it is given,
 * so a test can change a repo between a request and its answer. A repo it
 * does not hold is not found, as one removed outside Rift. While `holding`,
 * health checks and reads of the status and of folders wait until
 * `release`, which answers those to one endpoint, or one request, when
 * given its path.
 */
function fakeServer(repos: Record<string, Repo>) {
	const server = {
		repos,
		requests: [] as string[],
		holding: false,
		held: [] as { pathname: string; request: string; answer: () => void }[],
		release(match?: string) {
			const answering = server.held.filter(
				(read) =>
					match === undefined ||
					read.pathname === match ||
					read.request === match,
			);
			server.held = server.held.filter((read) => !answering.includes(read));
			for (const { answer } of answering) answer();
		},
	};
	globalThis.fetch = ((input: RequestInfo | URL) => {
		const url = new URL(String(input), "http://localhost");
		const request = `${url.pathname}${url.search}`;
		server.requests.push(request);
		const answer = () => {
			const repo = server.repos[url.searchParams.get("repo") ?? ""];
			if (!repo) {
				return json(
					{ error: { code: "NOT_FOUND", message: "Repository not found" } },
					404,
				);
			}
			if (url.pathname === "/api/git/status") {
				return json({ files: repo.files });
			}
			if (url.pathname === "/api/files") {
				const entries = repo.folders[url.searchParams.get("path") ?? "."];
				return entries
					? json({ entries, truncated: false })
					: json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
			}
			if (url.pathname === "/api/git/log") return json({ commits: [] });
			return json({ status: "ok", gitRepo: true, writesAllowed: true });
		};
		if (
			server.holding &&
			["/api/health", "/api/git/status", "/api/files"].includes(url.pathname)
		) {
			return new Promise<Response>((resolve) => {
				server.held.push({
					pathname: url.pathname,
					request,
					answer: () => resolve(answer()),
				});
			});
		}
		return Promise.resolve(answer());
	}) as typeof fetch;
	return server;
}

type Server = ReturnType<typeof fakeServer>;

// Stands in for the dashboard, which opens a repo on its Files tab.
function Dashboard() {
	const { selectRepo } = useSession();
	const navigate = useNavigate();
	return (
		<button
			type="button"
			onClick={() => {
				selectRepo("root/two");
				navigate("/files");
			}}
		>
			Open root/two
		</button>
	);
}

// Selects another repo without leaving the session's tabs.
function SwitchRepo() {
	const { selectRepo } = useSession();
	return (
		<button type="button" onClick={() => selectRepo("root/two")}>
			Switch to root/two
		</button>
	);
}

function renderSession(entry = "/files") {
	globalThis.localStorage.setItem("rift:selected-repo", "root/one");
	return render(
		<MemoryRouter initialEntries={[entry]}>
			<ErrorBannerProvider>
				<SessionProvider>
					<Routes>
						<Route path="/" element={<Dashboard />} />
						<Route path="/*" element={<SessionShell />} />
					</Routes>
					<SwitchRepo />
				</SessionProvider>
			</ErrorBannerProvider>
		</MemoryRouter>,
	);
}

function tab(name: string) {
	return screen.getByRole("link", { name });
}

// Whether the Files list is on screen. It stays in the page, hidden, behind
// the other tabs.
function listShown(container: HTMLElement) {
	return (
		container.querySelector(".changes-page:not(.changes-page--hidden)") !== null
	);
}

function rows(container: HTMLElement) {
	return [...container.querySelectorAll(".changes-file-name")].map(
		(name) => name.textContent,
	);
}

function treeNames(container: HTMLElement) {
	return [...container.querySelectorAll(".tree-entry-name")].map(
		(name) => name.textContent,
	);
}

// Opens or closes a folder, and waits for what it holds.
async function toggleFolder(container: HTMLElement, name: string) {
	const entry = [...container.querySelectorAll(".tree-entry")].find(
		(button) => button.querySelector(".tree-entry-name")?.textContent === name,
	);
	if (!entry) throw new Error(`no tree entry ${name}`);
	fireEvent.click(entry);
	// Compared as a boolean, since a failed match prints the element, which
	// is slow.
	await waitFor(() => {
		expect(container.querySelector(".tree-loading") === null).toBe(true);
	});
}

// Shows the Files tab of root/one with src open, and docs and src/lib read
// and closed again, then goes to the History tab.
async function openThenLeave(container: HTMLElement) {
	await waitFor(() => {
		expect(rows(container)).toEqual(["notes.md"]);
		expect(treeNames(container)).toEqual(["docs", "src", "README.md"]);
	});
	await toggleFolder(container, "docs");
	await toggleFolder(container, "docs");
	await toggleFolder(container, "src");
	await toggleFolder(container, "lib");
	await toggleFolder(container, "lib");
	expect(treeNames(container)).toEqual([
		"docs",
		"src",
		"lib",
		"a.ts",
		"b.ts",
		"README.md",
	]);
	fireEvent.click(tab("History"));
	await screen.findByText("No commits yet");
	expect(listShown(container)).toBe(false);
}

// Answers the requests held, or those matching, and lets every answer land
// and the page draw what it holds.
async function release(server: Server, match?: string) {
	await act(async () => {
		server.release(match);
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}

// Answers every request held, and those they lead to, until none is left.
async function releaseAll(server: Server) {
	do {
		await release(server);
	} while (server.held.length > 0);
}

describe("the Files tab", () => {
	test("draws the list it had at once on coming back, and reads it again behind it", async () => {
		const server = fakeServer({ "root/one": ONE() });
		const { container } = renderSession();
		await openThenLeave(container);

		// Behind History the list waits, without polling.
		server.requests = [];
		fireEvent(document, new Event("visibilitychange"));
		expect(server.requests).toEqual([]);

		server.holding = true;
		fireEvent.click(tab("Files"));

		// The list is drawn whole, as it was left, while the repo's health and
		// its status are still out, and nothing shows that they are.
		expect(listShown(container)).toBe(true);
		expect(container.querySelector(".changes-message") === null).toBe(true);
		expect(rows(container)).toEqual(["notes.md"]);
		expect(treeNames(container)).toEqual([
			"docs",
			"src",
			"lib",
			"a.ts",
			"b.ts",
			"README.md",
		]);
		expect(
			container.querySelector(".changes-refresh-button--spinning") === null,
		).toBe(true);
		expect(server.requests.sort()).toEqual([STATUS, HEALTH]);

		// Once the status is in, the root is read again, and no other folder,
		// open or closed, since the status names none.
		server.requests = [];
		await release(server, "/api/git/status");
		expect(server.requests).toEqual([folderRead(".")]);
		await releaseAll(server);

		// Back in view, the list polls again.
		server.holding = false;
		server.requests = [];
		fireEvent(document, new Event("visibilitychange"));
		expect(server.requests).toEqual([STATUS]);
		await release(server);
	});

	test("changes nothing on screen when the list read again is the same", async () => {
		const server = fakeServer({ "root/one": ONE() });
		const { container } = renderSession();
		await openThenLeave(container);
		const list = container.querySelector(".changes-list") as HTMLElement;
		const drawn = list.innerHTML;
		const entries = [...container.querySelectorAll(".tree-entry")];

		server.holding = true;
		fireEvent.click(tab("Files"));
		const changes: MutationRecord[] = [];
		const observer = new MutationObserver((records) => {
			changes.push(...records);
		});
		observer.observe(list, {
			attributes: true,
			characterData: true,
			childList: true,
			subtree: true,
		});
		await releaseAll(server);
		observer.disconnect();

		expect(changes).toEqual([]);
		expect(container.querySelector(".changes-list")).toBe(list);
		expect(list.innerHTML).toBe(drawn);
		expect([...container.querySelectorAll(".tree-entry")]).toEqual(entries);
	});

	test("reads the root and the folders the status names, each once, and shows what they hold together", async () => {
		const server = fakeServer({ "root/one": ONE() });
		const { container } = renderSession();
		await openThenLeave(container);

		// Outside Rift, d.ts is created in the closed src/lib, and NEWS.md and
		// e.ts are committed, the last in the open src.
		const one = server.repos["root/one"];
		one.files = [
			...one.files,
			{ path: "src/lib/d.ts", status: "untracked", staged: false },
		];
		one.folders["src/lib"] = [file("c.ts"), file("d.ts")];
		one.folders.src = [...one.folders.src, file("e.ts")];
		one.folders["."] = [...one.folders["."], file("NEWS.md")];
		server.holding = true;
		fireEvent.click(tab("Files"));

		// The status names src/lib, which is read with the root, each once.
		server.requests = [];
		await release(server, "/api/git/status");
		expect(rows(container)).toEqual(["notes.md", "d.ts"]);
		expect(server.requests.sort()).toEqual([
			folderRead("."),
			folderRead("src/lib"),
		]);

		// Nothing in the tree changes until both have answered.
		const shownBefore = treeNames(container);
		await release(server, folderRead("."));
		expect(treeNames(container)).toEqual(shownBefore);
		await release(server, folderRead("src/lib"));
		expect(treeNames(container)).toEqual([
			"docs",
			"src",
			"lib",
			"a.ts",
			"b.ts",
			"README.md",
			"NEWS.md",
		]);
		await releaseAll(server);
		expect(
			server.requests.filter((request) => request.startsWith("/api/files")),
		).toHaveLength(2);

		// The open src, which the status does not name, shows e.ts once
		// Refresh reads every folder.
		server.holding = false;
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => {
			expect(treeNames(container)).toEqual([
				"docs",
				"src",
				"lib",
				"a.ts",
				"b.ts",
				"e.ts",
				"README.md",
				"NEWS.md",
			]);
		});
		await releaseAll(server);
	});

	test("keeps the list's scroll position across a trip to History", async () => {
		const server = fakeServer({ "root/one": ONE() });
		const { container } = renderSession();
		await waitFor(() => {
			expect(rows(container)).toEqual(["notes.md"]);
		});
		const list = container.querySelector(".changes-list") as HTMLElement;
		list.scrollTop = 240;

		fireEvent.click(tab("History"));
		await screen.findByText("No commits yet");
		fireEvent.click(tab("Files"));

		expect(container.querySelector(".changes-list")).toBe(list);
		expect(list.scrollTop).toBe(240);
		await releaseAll(server);
		expect(list.scrollTop).toBe(240);
	});

	test("builds the list on the tab's first visit, not before", async () => {
		const server = fakeServer({ "root/one": ONE() });
		const { container } = renderSession("/history");
		await screen.findByText("No commits yet");
		expect(container.querySelector(".changes-page") === null).toBe(true);
		expect(
			server.requests.filter(
				(request) =>
					request.startsWith("/api/git/status") ||
					request.startsWith("/api/files"),
			),
		).toEqual([]);

		server.requests = [];
		fireEvent.click(tab("Files"));
		await waitFor(() => {
			expect(rows(container)).toEqual(["notes.md"]);
		});
		await releaseAll(server);
		expect(server.requests.sort()).toEqual(
			[folderRead("."), STATUS, HEALTH].sort(),
		);
	});

	test("shows the list at its path with a trailing slash or in another case", async () => {
		for (const entry of ["/files/", "/Files"]) {
			fakeServer({ "root/one": ONE() });
			const { container } = renderSession(entry);
			await waitFor(() => {
				expect(listShown(container)).toBe(true);
				expect(rows(container)).toEqual(["notes.md"]);
			});
			expect(
				screen.getByRole("navigation", { name: "Main navigation" }),
			).not.toBeNull();
			cleanup();
		}
	});

	test("never shows one repo's list for another", async () => {
		const server = fakeServer({ "root/one": ONE(), "root/two": TWO() });
		const { container } = renderSession();
		await openThenLeave(container);
		fireEvent.click(tab("Files"));
		await releaseAll(server);

		// Another repo selected while the tabs stay up starts its list afresh,
		// and its status, answered first, waits for its own folders.
		server.holding = true;
		fireEvent.click(screen.getByRole("button", { name: "Switch to root/two" }));
		expect(container.querySelector(".changes-message")?.textContent).toBe(
			"Loading...",
		);
		expect(rows(container)).toEqual([]);
		expect(treeNames(container)).toEqual([]);
		await release(server, "/api/git/status");
		expect(container.querySelector(".changes-message")?.textContent).toBe(
			"Loading...",
		);
		expect(treeNames(container)).toEqual([]);
		await releaseAll(server);
		await waitFor(() => {
			expect(rows(container)).toEqual(["two.txt"]);
			expect(treeNames(container)).toEqual(["TWO.md"]);
		});

		// So does one opened from the dashboard, after leaving a repo's
		// History tab.
		cleanup();
		server.holding = false;
		const again = renderSession();
		await openThenLeave(again.container);
		fireEvent.click(screen.getByTitle("Back to dashboard"));
		server.holding = true;
		fireEvent.click(screen.getByRole("button", { name: "Open root/two" }));
		expect(again.container.querySelector(".changes-message")?.textContent).toBe(
			"Loading...",
		);
		expect(rows(again.container)).toEqual([]);
		expect(treeNames(again.container)).toEqual([]);
		await releaseAll(server);
		await waitFor(() => {
			expect(rows(again.container)).toEqual(["two.txt"]);
		});
	});

	test("goes back to the dashboard on a tap of a tab once the repo has gone", async () => {
		const server = fakeServer({ "root/one": ONE() });
		const { container } = renderSession();
		await waitFor(() => {
			expect(rows(container)).toEqual(["notes.md"]);
		});

		// The repo is removed or renamed outside Rift.
		delete server.repos["root/one"];
		fireEvent.click(tab("History"));

		await screen.findByRole("button", { name: "Open root/two" });
		expect(globalThis.localStorage.getItem("rift:selected-repo")).toBeNull();
	});
});
