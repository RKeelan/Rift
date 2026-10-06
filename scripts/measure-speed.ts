// Measures how fast Rift answers, against the running service, for the speed
// requirements in AGENTS.md. Three modes:
//
//   server  times each API endpoint the client waits on, on loopback
//   spawn   times starting git, which dominates the endpoints that run it
//   client  times interactions in headless Chrome at a phone's size, through
//           scripts/emulator-proxy.ts, which must already be running
//
//   bun scripts/measure-speed.ts --repo <root>/<scratch repo> [--mode all]
//       [--runs 20] [--file <path>] [--cpu-slowdown 1] [--browser <path>]
//       [--server http://127.0.0.1:13000] [--client http://127.0.0.1:13001/rift/]
//
// The server and client modes stage, unstage and save one file of the repo
// named, so name a scratch repository, never a real one. The file is one with
// unstaged changes and nothing staged; the script puts its bytes and its index
// entry back as they were, and says so if it had to.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: options } = parseArgs({
	options: {
		mode: { type: "string", default: "all" },
		repo: { type: "string" },
		file: { type: "string" },
		runs: { type: "string", default: "20" },
		server: { type: "string", default: "http://127.0.0.1:13000" },
		client: { type: "string", default: "http://127.0.0.1:13001/rift/" },
		browser: { type: "string" },
		"cpu-slowdown": { type: "string", default: "1" },
	},
});

const MODES = ["all", "server", "spawn", "client"];
const mode = options.mode ?? "all";
const runs = Number(options.runs);
const cpuSlowdown = Number(options["cpu-slowdown"]);
const server = (options.server ?? "").replace(/\/$/, "");
const clientUrl = (options.client ?? "").replace(/\/?$/, "/");
if (!MODES.includes(mode)) fail(`--mode must be one of ${MODES.join(", ")}`);
if (!Number.isInteger(runs) || runs < 1) fail("--runs must be a whole number");
if (!(cpuSlowdown >= 1)) fail("--cpu-slowdown must be 1 or more");
if (mode !== "spawn" && !options.repo) {
	fail("--repo is required: name a scratch repository, as <root>/<repo>");
}
const repo = options.repo ?? "";

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Statistics

function percentile(samples: number[], p: number): number {
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function report(label: string, samples: number[], note = "") {
	if (samples.length === 0) {
		console.log(`${label.padEnd(44)} no samples ${note}`);
		return;
	}
	const median = percentile(samples, 0.5).toFixed(1).padStart(7);
	const p90 = percentile(samples, 0.9).toFixed(1).padStart(7);
	console.log(
		`${label.padEnd(44)} median ${median} ms  p90 ${p90} ms  n=${samples.length} ${note}`,
	);
}

// ---------------------------------------------------------------------------
// The API

interface StatusEntry {
	path: string;
	status: string;
	staged: boolean;
}

function api(route: string, query: Record<string, string> = {}): string {
	return `${server}${route}?${new URLSearchParams({ repo, ...query })}`;
}

async function request(url: string, init?: RequestInit): Promise<Response> {
	const response = await fetch(url, init);
	if (!response.ok) {
		throw new Error(`${init?.method ?? "GET"} ${url}: ${response.status}`);
	}
	return response;
}

async function timed(url: string, init?: RequestInit): Promise<number> {
	const start = performance.now();
	const response = await request(url, init);
	await response.arrayBuffer();
	return performance.now() - start;
}

function post(body: unknown): RequestInit {
	return {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	};
}

async function status(): Promise<StatusEntry[]> {
	const response = await request(api("/api/git/status"));
	return ((await response.json()) as { files: StatusEntry[] }).files;
}

async function diff(file: string, staged: boolean): Promise<string> {
	const response = await request(
		api("/api/git/diff", { path: file, staged: String(staged) }),
	);
	return ((await response.json()) as { diff: string }).diff;
}

// The new-side lines of a diff's first hunk that adds lines, which staging or
// unstaging by line takes as its range, and the blob ids that name the diff.
function firstHunk(text: string): {
	ranges: [number, number][];
	expectedBlobs: string;
} {
	const blobs = /^index ([0-9a-f]+\.\.[0-9a-f]+)/m.exec(text)?.[1];
	for (const match of text.matchAll(
		/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm,
	)) {
		const start = Number(match[1]);
		const count = match[2] === undefined ? 1 : Number(match[2]);
		if (count > 0 && blobs) {
			return { ranges: [[start, start + count - 1]], expectedBlobs: blobs };
		}
	}
	throw new Error("the diff has no hunk that adds lines");
}

function hunkCount(text: string): number {
	return text.match(/^@@ /gm)?.length ?? 0;
}

// The repo's directory on this machine, so the file's bytes can be checked
// and put back without going through the editor.
async function repoDirectory(): Promise<string> {
	const response = await request(`${server}/api/repos`);
	const { repos } = (await response.json()) as {
		repos: { name: string; path: string }[];
	};
	const found = repos.find((entry) => entry.name === repo);
	if (!found) throw new Error(`the server lists no repo named ${repo}`);
	return found.path;
}

// Picks a file with unstaged changes in at least two places and nothing
// staged, so that a stage leaves a change behind to look at, and unstaging the
// whole file afterwards puts its index entry back exactly.
async function chooseFile(): Promise<string> {
	const files = await status();
	const stagedPaths = new Set(
		files.filter((entry) => entry.staged).map((entry) => entry.path),
	);
	const candidates = files.filter(
		(entry) =>
			!entry.staged &&
			entry.status === "modified" &&
			!stagedPaths.has(entry.path) &&
			(options.file === undefined || entry.path === options.file),
	);
	let best: { path: string; hunks: number } | null = null;
	for (const entry of candidates) {
		const hunks = hunkCount(await diff(entry.path, false));
		if (hunks >= 2 && (best === null || hunks > best.hunks)) {
			best = { path: entry.path, hunks };
		}
	}
	if (best === null) {
		throw new Error(
			options.file === undefined
				? "the repo has no modified file with two or more unstaged changes and nothing staged"
				: `${options.file} needs two or more unstaged changes and nothing staged`,
		);
	}
	return best.path;
}

// Records the file's bytes and returns a function that puts them, and its
// index entry, back. Run it however the measurement ends.
async function guardFile(file: string): Promise<() => Promise<void>> {
	const filePath = path.join(await repoDirectory(), file);
	const bytes = await fs.readFile(filePath);
	return async () => {
		const now = await fs.readFile(filePath).catch(() => null);
		if (now === null || !now.equals(bytes)) {
			await fs.writeFile(filePath, bytes);
			console.log(`Put ${file} back as it was.`);
		}
		const staged = (await status()).some(
			(entry) => entry.path === file && entry.staged,
		);
		if (staged) {
			await request(api("/api/git/unstage"), post({ path: file }));
			console.log(`Unstaged ${file} again.`);
		}
	};
}

// ---------------------------------------------------------------------------
// Server mode

async function measureServer(file: string) {
	console.log(`\nServer endpoints at ${server}, ${repo}, ${file}`);
	console.log("Each figure is one request, timed from this machine.\n");

	const sample = async (
		label: string,
		run: () => Promise<number>,
		git: number,
	) => {
		await run();
		await run();
		const times: number[] = [];
		for (let i = 0; i < runs; i++) times.push(await run());
		report(label, times, `(${git} git ${git === 1 ? "process" : "processes"})`);
		return times;
	};

	const health = await sample(
		"GET /api/health",
		() => timed(`${server}/api/health`),
		0,
	);
	const oneGit = await sample(
		"GET /api/health?repo",
		() => timed(api("/api/health")),
		1,
	);
	await sample("GET /api/repos", () => timed(`${server}/api/repos`), 0);
	await sample(
		"GET /api/files/content",
		() => timed(api("/api/files/content", { path: file })),
		0,
	);
	await sample(
		"GET /api/files (directory)",
		() => timed(api("/api/files", { path: "." })),
		2,
	);
	await sample("GET /api/git/status", () => timed(api("/api/git/status")), 2);
	await sample(
		"GET /api/git/diff",
		() => timed(api("/api/git/diff", { path: file, staged: "false" })),
		3,
	);
	await sample(
		"GET /api/git/base-content",
		() => timed(api("/api/git/base-content", { path: file, staged: "false" })),
		3,
	);
	await sample(
		"GET /api/git/log",
		() => timed(api("/api/git/log", { limit: "25" })),
		2,
	);
	// What the client asks for when a file opens, all at once.
	await sample(
		"open a file (content, base, diff at once)",
		async () => {
			const start = performance.now();
			await Promise.all([
				timed(api("/api/files/content", { path: file })),
				timed(api("/api/git/base-content", { path: file, staged: "false" })),
				timed(api("/api/git/diff", { path: file, staged: "false" })),
			]);
			return performance.now() - start;
		},
		6,
	);

	// A stage and unstage of the file's first change, each by line, as the
	// editor's strips send them. The diffs that name each are read untimed.
	const stageTimes: number[] = [];
	const unstageTimes: number[] = [];
	for (let i = 0; i < runs + 2; i++) {
		const stage = firstHunk(await diff(file, false));
		const stageMs = await timed(
			api("/api/git/stage"),
			post({ path: file, ...stage }),
		);
		const unstage = firstHunk(await diff(file, true));
		const unstageMs = await timed(
			api("/api/git/unstage"),
			post({ path: file, ...unstage }),
		);
		if ((await diff(file, true)) !== "") {
			throw new Error(`unstaging by line left ${file} staged`);
		}
		if (i >= 2) {
			stageTimes.push(stageMs);
			unstageTimes.push(unstageMs);
		}
	}
	report("POST /api/git/stage (by line)", stageTimes, "(5 git processes)");
	report("POST /api/git/unstage (by line)", unstageTimes, "(5 git processes)");

	const perProcess = percentile(oneGit, 0.5) - percentile(health, 0.5);
	console.log(
		`\nOne git process costs the service about ${perProcess.toFixed(1)} ms (health with a repo, less health without).`,
	);
}

// ---------------------------------------------------------------------------
// Spawn mode

function spawnWithNode(binary: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const start = performance.now();
		const child = spawn(binary, ["--version"], { windowsHide: true });
		child.stdout.resume();
		child.stderr.resume();
		child.on("error", reject);
		child.on("close", () => resolve(performance.now() - start));
	});
}

async function spawnWithBun(binary: string): Promise<number> {
	const start = performance.now();
	const child = Bun.spawn([binary, "--version"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	await new Response(child.stdout).arrayBuffer();
	await child.exited;
	return performance.now() - start;
}

// The git on the PATH and, for Git for Windows, both the launcher in `cmd`
// that the installer puts on the PATH and the git it starts in turn.
async function gitBinaries(): Promise<string[]> {
	const found = new Set<string>();
	const onPath = Bun.which("git");
	if (onPath) found.add(onPath);
	if (process.platform === "win32" && onPath) {
		const child = Bun.spawn([onPath, "--exec-path"], { stdout: "pipe" });
		const execPath = (await new Response(child.stdout).text()).trim();
		// <Git>/mingw64/libexec/git-core, beside <Git>/mingw64/bin and <Git>/cmd
		const mingw = path.resolve(execPath, "..", "..");
		for (const candidate of [
			path.join(mingw, "..", "cmd", "git.exe"),
			path.join(mingw, "bin", "git.exe"),
		]) {
			if (await Bun.file(candidate).exists())
				found.add(path.resolve(candidate));
		}
	}
	return [...found];
}

async function measureSpawn() {
	console.log("\nStarting `git --version`, from this process\n");
	for (const binary of await gitBinaries()) {
		for (const [how, run] of [
			["node:child_process", spawnWithNode],
			["Bun.spawn", spawnWithBun],
		] as const) {
			await run(binary);
			const times: number[] = [];
			for (let i = 0; i < runs; i++) times.push(await run(binary));
			report(`${how}`, times, binary);
		}
	}
}

// ---------------------------------------------------------------------------
// A browser driven over the Chrome DevTools Protocol

function findBrowser(): string {
	if (options.browser) return options.browser;
	const candidates =
		process.platform === "win32"
			? [
					"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
					"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
					"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
				]
			: process.platform === "darwin"
				? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
				: ["google-chrome", "chromium", "chromium-browser"];
	for (const candidate of candidates) {
		const found = path.isAbsolute(candidate) ? candidate : Bun.which(candidate);
		if (found && existsSync(found)) return found;
	}
	fail("No Chrome found; pass --browser <path to a Chromium-based browser>");
}

type Message = {
	id?: number;
	result?: Record<string, unknown>;
	error?: { message: string };
};

class Browser {
	private nextId = 0;
	private waiting = new Map<number, (message: Message) => void>();

	private constructor(
		private socket: WebSocket,
		private process: ReturnType<typeof Bun.spawn>,
		private profile: string,
		public session = "",
	) {
		socket.onmessage = (event) => {
			const message = JSON.parse(String(event.data)) as Message;
			if (message.id !== undefined) {
				this.waiting.get(message.id)?.(message);
				this.waiting.delete(message.id);
			}
		};
	}

	// Starts headless Chrome with a profile of its own, which is thrown away
	// afterwards, and opens a page.
	static async launch(binary: string): Promise<Browser> {
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "rift-measure-"));
		const child = Bun.spawn(
			[
				binary,
				"--headless",
				"--remote-debugging-port=0",
				`--user-data-dir=${profile}`,
				"--no-first-run",
				"--no-default-browser-check",
				"about:blank",
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		let endpoint = "";
		for (let i = 0; i < 200 && endpoint === ""; i++) {
			const active = await fs
				.readFile(path.join(profile, "DevToolsActivePort"), "utf8")
				.catch(() => "");
			const [port, socketPath] = active.split("\n");
			if (port && socketPath) endpoint = `ws://127.0.0.1:${port}${socketPath}`;
			else await Bun.sleep(50);
		}
		if (endpoint === "") throw new Error(`${binary} did not start`);
		const socket = new WebSocket(endpoint);
		await new Promise((resolve, reject) => {
			socket.onopen = resolve;
			socket.onerror = reject;
		});
		const browser = new Browser(socket, child, profile);
		const target = await browser.send("Target.createTarget", {
			url: "about:blank",
		});
		const attached = await browser.send("Target.attachToTarget", {
			targetId: target.targetId,
			flatten: true,
		});
		browser.session = String(attached.sessionId);
		return browser;
	}

	send(
		method: string,
		params: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> {
		const id = ++this.nextId;
		const sessionId = method.startsWith("Target.") ? undefined : this.session;
		this.socket.send(JSON.stringify({ id, method, params, sessionId }));
		return new Promise((resolve, reject) => {
			this.waiting.set(id, (message) => {
				if (message.error)
					reject(new Error(`${method}: ${message.error.message}`));
				else resolve(message.result ?? {});
			});
		});
	}

	// Evaluates an expression in the page, awaiting it if it is a promise.
	async evaluate<T>(expression: string): Promise<T> {
		const result = (await this.send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		})) as {
			result: { value?: T };
			exceptionDetails?: { exception?: { description?: string }; text: string };
		};
		if (result.exceptionDetails) {
			const { exception, text } = result.exceptionDetails;
			throw new Error(exception?.description ?? text);
		}
		return result.result.value as T;
	}

	// A finger on the screen for 50 ms, about as long as a person's tap.
	async tap(x: number, y: number) {
		const point = { x, y, radiusX: 4, radiusY: 4, force: 1, id: 0 };
		await this.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [point],
		});
		await Bun.sleep(50);
		await this.send("Input.dispatchTouchEvent", {
			type: "touchEnd",
			touchPoints: [],
		});
	}

	async close() {
		await this.send("Browser.close").catch(() => {});
		this.socket.close();
		await Promise.race([this.process.exited, Bun.sleep(5000)]);
		this.process.kill();
		await fs
			.rm(this.profile, { recursive: true, force: true, maxRetries: 10 })
			.catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// Client mode

// Runs in the page before Rift does. It notes when each finger lifts, and
// watches for the conditions that show an interaction's result, timing each
// to the end of the frame that first draws it.
const PAGE_HELPER = (selectedRepo: string) => `
localStorage.setItem("rift:selected-repo", ${JSON.stringify(selectedRepo)});
(() => {
	const m = { tap: null, pending: null };
	window.__measure = m;
	performance.setResourceTimingBufferSize(100000);
	addEventListener("pointerup", (event) => { m.tap = event.timeStamp; }, true);
	addEventListener("keydown", (event) => { m.tap = event.timeStamp; }, true);
	m.watch = (conditions, timeoutMs) => {
		const names = Object.keys(conditions);
		const holds = (name) => { try { return Boolean(conditions[name]()); } catch { return false; } };
		const early = names.filter(holds);
		if (early.length > 0) throw new Error("already true before the input: " + early.join(", "));
		m.tap = null;
		const times = {};
		const seen = new Set();
		let finish;
		m.pending = new Promise((resolve) => { finish = resolve; });
		const check = () => {
			for (const name of names) {
				if (seen.has(name) || !holds(name)) continue;
				seen.add(name);
				// The change is drawn in the next frame, and a task queued from
				// that frame's animation callback runs once it has been drawn.
				requestAnimationFrame(() => setTimeout(() => {
					times[name] = performance.now();
					if (Object.keys(times).length === names.length) done(false);
				}));
			}
		};
		const observer = new MutationObserver(check);
		observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
		const interval = setInterval(check, 10);
		const timer = setTimeout(() => done(true), timeoutMs);
		function done(timedOut) {
			observer.disconnect();
			clearInterval(interval);
			clearTimeout(timer);
			finish({ tap: m.tap, times, timedOut });
		}
		return true;
	};
})();
`;

// The editor the page shows; the switch keeps the other one mounted, hidden.
const ACTIVE = ".changes-editor-view:not(.changes-editor-view--hidden)";
const ENABLED_STRIP = '.cm-changeStripButton[aria-disabled="false"]';
const DISABLED_STRIP = '.cm-changeStripButton[aria-disabled="true"]';

const js = JSON.stringify;

class Client {
	readonly samples = new Map<string, number[]>();
	readonly requests = new Map<string, number[]>();

	constructor(
		private browser: Browser,
		private file: string,
	) {}

	// Times an input, from the finger lifting (or the key going down) to the
	// frame that draws each condition, and records each as `name (condition)`,
	// or under the name alone for the condition called `done`.
	async measure(
		name: string,
		conditions: Record<string, string>,
		input: () => Promise<void>,
		record = true,
	) {
		const source = Object.entries(conditions)
			.map(([key, condition]) => `${js(key)}: () => (${condition})`)
			.join(", ");
		await this.browser.evaluate(
			`performance.clearResourceTimings(); __measure.watch({ ${source} }, 15000)`,
		);
		await input();
		const result = await this.browser.evaluate<{
			tap: number | null;
			times: Record<string, number>;
			timedOut: boolean;
		}>("__measure.pending");
		if (result.timedOut || result.tap === null) {
			const missing = Object.keys(conditions).filter(
				(key) => !(key in result.times),
			);
			throw new Error(
				`${name}: ${result.tap === null ? "the input never arrived" : `no ${missing.join(", ")} within 15 s`}, on ${await this.describe()}`,
			);
		}
		if (record) {
			for (const [key, time] of Object.entries(result.times)) {
				const label = `${name}${key === "done" ? "" : ` (${key})`}`;
				const list = this.samples.get(label) ?? [];
				list.push(time - result.tap);
				this.samples.set(label, list);
			}
			await this.recordRequests();
		}
		// Let anything the interaction started settle before the next one.
		await Bun.sleep(600);
	}

	// The API requests the page made during the interaction, as the page saw
	// them, which includes Rift's service worker.
	private async recordRequests() {
		const entries = await this.browser.evaluate<{ name: string; ms: number }[]>(
			`performance.getEntriesByType("resource")
				.filter((entry) => entry.name.includes("/api/"))
				.map((entry) => ({ name: new URL(entry.name).pathname.replace(/^.*\\/api\\//, "/api/"), ms: entry.responseEnd - entry.startTime }))`,
		);
		for (const { name, ms } of entries) {
			const list = this.requests.get(name) ?? [];
			list.push(ms);
			this.requests.set(name, list);
		}
	}

	// The centre of the element an expression finds, scrolled into view first
	// if it is off screen, as a finger would find it.
	async point(element: string): Promise<{ x: number; y: number }> {
		const found = await this.browser.evaluate<{ x: number; y: number } | null>(
			`(async () => {
				const element = ${element};
				if (!element) return null;
				let rect = element.getBoundingClientRect();
				if (rect.top < 60 || rect.bottom > innerHeight - 60) {
					element.scrollIntoView({ block: "center" });
					await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
					rect = element.getBoundingClientRect();
				}
				return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
			})()`,
		);
		if (!found) throw new Error(`nothing matches ${element}`);
		return found;
	}

	async tapOn(element: string) {
		const { x, y } = await this.point(element);
		await this.browser.tap(x, y);
	}

	async waitFor(condition: string, what: string, timeoutMs = 15000) {
		const deadline = Date.now() + timeoutMs;
		while (!(await this.browser.evaluate<boolean>(`Boolean(${condition})`))) {
			if (Date.now() > deadline) {
				throw new Error(
					`timed out waiting for ${what}, on ${await this.describe()}`,
				);
			}
			await Bun.sleep(50);
		}
	}

	// What the page shows, for an error that says why a step went wrong.
	describe() {
		return this.browser.evaluate<string>(
			`(() => {
				const view = document.querySelector("${ACTIVE}");
				const strips = [...(view?.querySelectorAll(".cm-changeStripButton") ?? [])];
				const enabled = strips.filter((strip) => strip.getAttribute("aria-disabled") === "false").length;
				const editor = view ? \` editor with \${strips.length} strips, \${enabled} enabled: \${view.innerText.slice(0, 200)}\` : "";
				return \`\${location.href}\${editor || \`: \${document.body.innerText.slice(0, 300)}\`}\`;
			})()`,
		);
	}

	private entry(staged: boolean) {
		return `[aria-label=${js(`${staged ? "Unstage" : "Stage"} ${this.file}`)}]`;
	}

	// The list shows the file with unstaged changes and nothing staged.
	listShowsFile() {
		return `document.querySelector(${js(this.entry(false))}) && !document.querySelector(${js(this.entry(true))})`;
	}

	async load() {
		await this.browser.send("Page.navigate", { url: `${clientUrl}changes` });
		await this.waitFor(
			this.listShowsFile(),
			"the Changes list to show the file",
		);
	}

	async open(record = true) {
		const row = `document.querySelector(${js(`.changes-file-row:has(${this.entry(false)}) .changes-file-entry`)})`;
		const point = await this.point(row);
		await this.measure(
			"open a file",
			{
				shown: `document.querySelector(${js(`${ACTIVE} .cm-line`)})`,
				marked: `document.querySelector(${js(`${ACTIVE} .cm-changedLine`)})`,
				done: `document.querySelector(${js(`${ACTIVE} ${ENABLED_STRIP}`)})`,
			},
			() => this.browser.tap(point.x, point.y),
			record,
		);
	}

	private tabLink(label: string) {
		return `[...document.querySelectorAll(".tab-bar-item")].find((tab) => tab.textContent.trim() === ${js(label)})`;
	}

	// Leaves for the Files tab, then times coming back to the Changes tab
	// until its list shows the file again, which reads the status afresh.
	async openChangesTab() {
		await this.tapOn(this.tabLink("Files"));
		await this.waitFor(
			`location.pathname.endsWith("/files") && !document.querySelector(".changes-page")`,
			"the Files tab",
		);
		await Bun.sleep(600);
		const point = await this.point(this.tabLink("Changes"));
		await this.measure(
			"open the Changes tab",
			{ done: `document.querySelector(".changes-list .changes-file-row")` },
			() => this.browser.tap(point.x, point.y),
		);
		await this.waitFor(this.listShowsFile(), "the list to show the file");
	}

	async back(record = true) {
		const point = await this.point(
			`document.querySelector('[aria-label="Back to changes list"]')`,
		);
		await this.measure(
			"back to the list",
			{ done: `document.querySelector(".changes-list .changes-file-row")` },
			() => this.browser.tap(point.x, point.y),
			record,
		);
	}

	// Picks the first changed line through the gutter, then unpicks it.
	async pickAndUnpick() {
		const line = await this.browser.evaluate<string | null>(
			`document.querySelector(${js(`${ACTIVE} .cm-pickTarget--line:not(.cm-pickTarget--waiting)`)})?.dataset.pickLine ?? null`,
		);
		if (line === null) throw new Error("no line to pick");
		const target = `${ACTIVE} .cm-pickTarget[data-pick-line="${line}"]`;
		const picked = `document.querySelector(${js(`${target}.cm-pickTarget--picked`)})`;
		const point = await this.point(`document.querySelector(${js(target)})`);
		await this.measure("pick a line", { done: picked }, () =>
			this.browser.tap(point.x, point.y),
		);
		await this.measure("pick a line", { done: `!${picked}` }, () =>
			this.browser.tap(point.x, point.y),
		);
	}

	// Stages the first change from its strip, timed until the strip has gone
	// and the editor's other strips are ready again. With the switch, the
	// Staged tab becoming available shows that the status has caught up.
	async stageFromStrip() {
		const button = `document.querySelector(${js(`${ACTIVE} ${ENABLED_STRIP}`)})`;
		const point = await this.point(button);
		const start = await this.browser.evaluate<string>(
			`${button}.closest(".cm-changeStrip").dataset.start`,
		);
		const conditions: Record<string, string> = {
			done: `!document.querySelector(${js(`${ACTIVE} .cm-changeStrip[data-start="${start}"]`)}) && !document.querySelector(${js(`${ACTIVE} ${DISABLED_STRIP}`)})`,
		};
		if (await this.hasSwitch()) {
			conditions.status = `!${this.tab("Staged")}.disabled`;
		}
		await this.measure("stage a change from its strip", conditions, () =>
			this.browser.tap(point.x, point.y),
		);
	}

	private tab(label: string) {
		return `[...document.querySelectorAll(".changes-view-switch [role=tab]")].find((tab) => tab.textContent.trim() === ${js(label)})`;
	}

	hasSwitch() {
		return this.browser.evaluate<boolean>(
			`Boolean(document.querySelector(".changes-view-switch"))`,
		);
	}

	// Moves between the file's unstaged and staged changes, timed until the
	// other view shows and none of its strips is waiting.
	async flip(label: "Staged" | "Unstaged") {
		const point = await this.point(this.tab(label));
		await this.measure(
			`switch to ${label}`,
			{
				done: `${this.tab(label)}.getAttribute("aria-selected") === "true" && document.querySelector(${js(`${ACTIVE} .cm-line`)}) && !document.querySelector(${js(`${ACTIVE} ${DISABLED_STRIP}`)})`,
			},
			() => this.browser.tap(point.x, point.y),
		);
	}

	// The line a change's strip stands over.
	private lineUnder(start: string) {
		return `(() => {
			let element = document.querySelector(${js(`${ACTIVE} .cm-changeStrip[data-start="${start}"]`)});
			while (element && !element.classList.contains("cm-line")) element = element.nextElementSibling;
			return element;
		})()`;
	}

	// Taps at the end of a line, which puts the cursor there. A wrapped line
	// ends on its last row.
	private async tapLineEnd(start: string) {
		await this.point(this.lineUnder(start));
		const { x, y } = await this.browser.evaluate<{ x: number; y: number }>(
			`(() => { const rect = ${this.lineUnder(start)}.getBoundingClientRect(); return { x: rect.right - 4, y: rect.bottom - 8 }; })()`,
		);
		await this.browser.tap(x, y);
		await Bun.sleep(300);
	}

	private async key(key: string, code: string, keyCode: number, text?: string) {
		await this.browser.send("Input.dispatchKeyEvent", {
			type: "keyDown",
			key,
			code,
			windowsVirtualKeyCode: keyCode,
			...(text ? { text } : {}),
		});
		await this.browser.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key,
			code,
			windowsVirtualKeyCode: keyCode,
		});
	}

	private saveButton() {
		return `[...document.querySelectorAll(${js(`${ACTIVE} .text-file-editor-button`)})].find((button) => /^Sav/.test(button.textContent))`;
	}

	// Types a character at the end of the line under the first strip and saves
	// it, then deletes it and saves again, which leaves the file as it was.
	async typeAndSave() {
		const start = await this.browser.evaluate<string>(
			`document.querySelector(${js(`${ACTIVE} ${ENABLED_STRIP}`)}).closest(".cm-changeStrip").dataset.start`,
		);
		const text = `${this.lineUnder(start)}?.textContent`;
		const before = await this.browser.evaluate<string>(text);
		await this.tapLineEnd(start);
		await this.measure(
			"type a character",
			{ done: `${text} === ${js(`${before}x`)}` },
			() => this.key("x", "KeyX", 88, "x"),
		);
		await this.save(start);
		await this.tapLineEnd(start);
		await this.measure(
			"type a character",
			{ done: `${text} === ${js(before)}` },
			() => this.key("Backspace", "Backspace", 8),
		);
		await this.save(start);
	}

	// Times a save until the Save button gives way, and until the diff has
	// been read again and the change's strip is ready.
	private async save(start: string) {
		const point = await this.point(this.saveButton());
		await this.measure(
			"save",
			{
				saved: `!${this.saveButton()}`,
				done: `!${this.saveButton()} && document.querySelector(${js(`${ACTIVE} .cm-changeStrip[data-start="${start}"] [aria-disabled="false"]`)})`,
			},
			() => this.browser.tap(point.x, point.y),
		);
	}
}

async function measureClient(file: string, restore: () => Promise<void>) {
	const proxy = await fetch(clientUrl).catch(() => null);
	if (!proxy?.ok) {
		fail(
			`Nothing answers at ${clientUrl}; start it with \`bun scripts/emulator-proxy.ts\``,
		);
	}
	console.log(
		`\nClient interactions at ${clientUrl}, ${repo}, ${file}, CPU slowed ${cpuSlowdown}x`,
	);
	console.log(
		"Each figure runs from the finger lifting to the end of the frame that draws the result.\n",
	);
	const browser = await Browser.launch(findBrowser());
	try {
		// The phone's width in CSS pixels, and Chrome on Android's user agent,
		// which CodeMirror reads to choose how to take input.
		await browser.send("Emulation.setDeviceMetricsOverride", {
			width: 443,
			height: 960,
			deviceScaleFactor: 2.4375,
			mobile: true,
		});
		await browser.send("Emulation.setTouchEmulationEnabled", {
			enabled: true,
			maxTouchPoints: 5,
		});
		await browser.send("Emulation.setUserAgentOverride", {
			userAgent:
				"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36",
			platform: "Linux armv8l",
		});
		await browser.send("Emulation.setCPUThrottlingRate", { rate: cpuSlowdown });
		// Scripts added for new documents run only while the Page domain is on.
		await browser.send("Page.enable");
		await browser.send("Page.addScriptToEvaluateOnNewDocument", {
			source: PAGE_HELPER(repo),
		});

		const client = new Client(browser, file);
		await client.load();
		// The first visit installs the service worker, and the first file
		// opened loads the editor's code, so neither is timed.
		await browser.send("Page.reload");
		await client.waitFor(client.listShowsFile(), "the list after a reload");
		await client.open(false);
		await client.back(false);

		for (let round = 0; round < runs; round++) {
			await client.open();
			await client.pickAndUnpick();
			await client.stageFromStrip();
			if (await client.hasSwitch()) {
				await client.flip("Staged");
				await client.flip("Unstaged");
			}
			await client.back();
			// Unstaging the whole file puts its index entry back as it was, and
			// the Changes tab reads the status again when it opens.
			await request(api("/api/git/unstage"), post({ path: file }));
			await client.openChangesTab();
			process.stdout.write(".");
		}
		for (let round = 0; round < runs; round++) {
			await client.open(false);
			await client.typeAndSave();
			await client.back(false);
			process.stdout.write(".");
		}
		console.log("\n");
		for (const [label, samples] of client.samples) report(label, samples);
		console.log(
			"\nAPI requests as the page saw them, service worker included\n",
		);
		for (const [label, samples] of [...client.requests].sort()) {
			report(label, samples);
		}
	} finally {
		await browser.close();
		await restore();
	}
}

// ---------------------------------------------------------------------------

if (mode === "spawn" || mode === "all") await measureSpawn();
if (mode === "server" || mode === "client" || mode === "all") {
	const file = await chooseFile();
	const restore = await guardFile(file);
	try {
		if (mode === "server" || mode === "all") await measureServer(file);
		if (mode === "client" || mode === "all") await measureClient(file, restore);
	} finally {
		await restore();
	}
}
