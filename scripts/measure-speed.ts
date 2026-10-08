// Measures how fast Rift answers, against the running service, for the speed
// requirements in AGENTS.md. Four modes:
//
//   server  times each API endpoint the client waits on, on loopback
//   spawn   times starting git, which dominates the endpoints that run it
//   client  times interactions in headless Chrome at a phone's size, through
//           scripts/emulator-proxy.ts, which must already be running
//   device  times the same interactions in Chrome on an Android device, over
//           adb, on a Rift page already open in the foreground there
//
//   bun scripts/measure-speed.ts --repo <root>/<scratch repo> [--mode all]
//       [--runs 20] [--file <path>] [--cpu-slowdown 1] [--browser <path>]
//       [--server http://127.0.0.1:13000] [--client http://127.0.0.1:13001/rift/]
//
//   bun scripts/measure-speed.ts --mode device --serial <serial>
//       --client <rift url> --repo <root>/<scratch repo> [--adb <path>]
//       [--runs 20] [--file <path>] [--cpu-slowdown 1]
//
// `all`, the default, runs the first three. The server, client and device
// modes stage, unstage and save one file of the repo named, so name a scratch
// repository, never a real one. The file is one with unstaged changes and
// nothing staged; the script puts its bytes and its index entry back as they
// were, and says so if it had to.
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
		client: { type: "string" },
		browser: { type: "string" },
		"cpu-slowdown": { type: "string", default: "1" },
		serial: { type: "string" },
		adb: { type: "string" },
	},
});

const MODES = ["all", "server", "spawn", "client", "device"];
const mode = options.mode ?? "all";
const runs = Number(options.runs);
const cpuSlowdown = Number(options["cpu-slowdown"]);
const server = (options.server ?? "").replace(/\/$/, "");
if (!MODES.includes(mode)) fail(`--mode must be one of ${MODES.join(", ")}`);
if (!Number.isInteger(runs) || runs < 1) fail("--runs must be a whole number");
if (!(cpuSlowdown >= 1)) fail("--cpu-slowdown must be 1 or more");
if (mode !== "spawn" && !options.repo) {
	fail("--repo is required: name a scratch repository, as <root>/<repo>");
}
if (mode === "device" && !options.serial) {
	fail("--serial is required: the device's serial, as `adb devices` lists it");
}
if (mode === "device" && !options.client) {
	fail("--client is required: Rift's address as the device reaches it");
}
const clientUrl = (options.client ?? "http://127.0.0.1:13001/rift/").replace(
	/\/?$/,
	"/",
);
const repo = options.repo ?? "";

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

// Ctrl+C during the client or device modes stops the measurement at the next
// step and lets the `finally` blocks put things back; a second one quits at
// once. `interruption` rejects on the first.
let interrupted = false;
let interrupt = () => {};
const interruption = new Promise<never>((_, reject) => {
	interrupt = () => reject(new Error("interrupted"));
});
interruption.catch(() => {});

function onSigint() {
	if (interrupted) process.exit(130);
	interrupted = true;
	console.log(
		"\nInterrupted; putting things back. Press Ctrl+C again to quit at once.",
	);
	interrupt();
}

function checkInterrupted() {
	if (interrupted) throw new Error("interrupted");
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
	method?: string;
	params?: Record<string, unknown>;
};

class Browser {
	private nextId = 0;
	private waiting = new Map<number, (message: Message) => void>();
	private listeners = new Map<
		string,
		(params: Record<string, unknown>) => void
	>();
	private closed = "";

	private constructor(
		private socket: WebSocket,
		private process: ReturnType<typeof Bun.spawn> | null = null,
		private profile: string | null = null,
		public session = "",
	) {
		socket.onmessage = (event) => {
			const message = JSON.parse(String(event.data)) as Message;
			if (message.id !== undefined) {
				this.waiting.get(message.id)?.(message);
				this.waiting.delete(message.id);
			} else if (message.method) {
				this.listeners.get(message.method)?.(message.params ?? {});
			}
		};
		// A page on a device can go away, and what waits on it fails then.
		socket.onclose = () => {
			this.closed = "the DevTools connection closed";
			for (const settle of this.waiting.values()) {
				settle({ error: { message: this.closed } });
			}
			this.waiting.clear();
		};
	}

	private static async open(endpoint: string): Promise<WebSocket> {
		const socket = new WebSocket(endpoint);
		await new Promise((resolve, reject) => {
			socket.onopen = resolve;
			socket.onerror = reject;
		});
		return socket;
	}

	// Attaches to a page that is already open, through the page's own socket.
	static async attach(endpoint: string): Promise<Browser> {
		return new Browser(await Browser.open(endpoint));
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
		const browser = new Browser(await Browser.open(endpoint), child, profile);
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
		if (this.closed)
			return Promise.reject(new Error(`${method}: ${this.closed}`));
		const id = ++this.nextId;
		const sessionId =
			method.startsWith("Target.") || this.session === ""
				? undefined
				: this.session;
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

	// Calls `listener` with each event of one kind that the browser sends.
	on(method: string, listener: (params: Record<string, unknown>) => void) {
		this.listeners.set(method, listener);
	}

	// Closes the connection, and the browser too if this script started it.
	async close() {
		if (this.process) await this.send("Browser.close").catch(() => {});
		this.socket.close();
		if (this.process) {
			await Promise.race([this.process.exited, Bun.sleep(5000)]);
			this.process.kill();
		}
		if (this.profile) {
			await fs
				.rm(this.profile, { recursive: true, force: true, maxRetries: 10 })
				.catch(() => {});
		}
	}
}

// A finger and a keyboard. Points are CSS pixels in the page's layout
// viewport, as getBoundingClientRect gives them.
interface Input {
	tap(x: number, y: number): Promise<void>;
	type(character: string): Promise<void>;
	backspace(): Promise<void>;
}

// Input sent through DevTools, for headless Chrome.
class CdpInput implements Input {
	constructor(private browser: Browser) {}

	// A finger on the screen for 50 ms, about as long as a person's tap.
	async tap(x: number, y: number) {
		const point = { x, y, radiusX: 4, radiusY: 4, force: 1, id: 0 };
		await this.browser.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [point],
		});
		await Bun.sleep(50);
		await this.browser.send("Input.dispatchTouchEvent", {
			type: "touchEnd",
			touchPoints: [],
		});
	}

	type(character: string) {
		const upper = character.toUpperCase();
		return this.key(character, `Key${upper}`, upper.charCodeAt(0), character);
	}

	backspace() {
		return this.key("Backspace", "Backspace", 8);
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
}

// ---------------------------------------------------------------------------
// Client mode

// Runs in the page before Rift does. It notes when each finger lifts, and
// watches for the conditions that show an interaction's result, timing each
// to the end of the frame that first draws it.
//
// An input event's timeStamp is when the platform took the input: the touch
// or key event's own time, on Android the time Android gave the event when it
// was injected. Chrome puts it on the same monotonic clock as performance.now(),
// so the two subtract. The measurement checks that each timeStamp falls after
// the watch was armed and before the first handler ran, which holds only if
// they share a clock, and `lag` is how long the input took to reach the page.
const PAGE_HELPER = (selectedRepo: string) => `
localStorage.setItem("rift:selected-repo", ${JSON.stringify(selectedRepo)});
(() => {
	const m = { tap: null, lag: null, up: null, armed: null, pending: null };
	window.__measure = m;
	performance.setResourceTimingBufferSize(100000);
	const note = (event) => { m.tap = event.timeStamp; m.lag = performance.now() - event.timeStamp; };
	addEventListener("pointerup", (event) => { note(event); m.up = { x: event.clientX, y: event.clientY }; }, true);
	addEventListener("keydown", note, true);
	const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	// Waits until the viewport has kept its size for three samples, as it does
	// once the on-screen keyboard has finished coming or going.
	m.still = async () => {
		let last = "";
		let same = 0;
		for (let i = 0; i < 100 && same < 3; i++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			const now = [innerWidth, innerHeight, visualViewport.offsetTop, visualViewport.height].join();
			same = now === last ? same + 1 : 0;
			last = now;
		}
	};
	// Where to tap an element, its centre or the end of its last row, scrolled
	// into view first unless a finger can already reach it there. A point is
	// reachable when it is inside the visual viewport and the element is the
	// one hit there, not a header over it.
	m.point = async (element, at, settle) => {
		if (!element) return { missing: true };
		if (settle) await m.still();
		const spot = () => {
			const rect = element.getBoundingClientRect();
			return at === "end"
				? { x: rect.right - 4, y: rect.bottom - 8 }
				: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
		};
		const hit = ({ x, y }) => {
			const view = visualViewport;
			if (x < view.offsetLeft || y < view.offsetTop || x > view.offsetLeft + view.width || y > view.offsetTop + view.height) return null;
			return document.elementFromPoint(x, y);
		};
		const reaches = (point) => {
			const found = hit(point);
			return found !== null && (found === element || element.contains(found));
		};
		let point = spot();
		if (!reaches(point)) {
			element.scrollIntoView({ block: "center" });
			await nextFrame();
			point = spot();
		}
		if (reaches(point)) return point;
		const found = hit(point);
		return { blocked: found ? found.outerHTML.slice(0, 100) : "nothing on screen" };
	};
	// Covers the page with a layer that takes every touch and does nothing with
	// it, so calibration taps change nothing, and notes where each one lands.
	m.cover = () => {
		const layer = document.createElement("div");
		layer.style.cssText = "position:fixed;inset:0;z-index:2147483647;touch-action:none;background:transparent";
		const taps = [];
		const swallow = (event) => { event.preventDefault(); event.stopPropagation(); };
		for (const type of ["touchstart", "touchend", "pointerdown", "mousedown", "mouseup", "click", "contextmenu"]) {
			layer.addEventListener(type, swallow, { passive: false });
		}
		layer.addEventListener("pointerup", (event) => { taps.push({ x: event.clientX, y: event.clientY }); swallow(event); });
		document.body.append(layer);
		m.uncover = () => { layer.remove(); return taps; };
		return true;
	};
	m.watch = (conditions, timeoutMs) => {
		const names = Object.keys(conditions);
		const holds = (name) => { try { return Boolean(conditions[name]()); } catch { return false; } };
		const early = names.filter(holds);
		if (early.length > 0) throw new Error("already true before the input: " + early.join(", "));
		m.tap = null;
		m.lag = null;
		m.up = null;
		m.armed = performance.now();
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
			finish({ armed: m.armed, tap: m.tap, lag: m.lag, up: m.up, times, timedOut });
		}
		return true;
	};
})();
`;

// The editor the page shows; the switch keeps the other one mounted, hidden.
const ACTIVE = ".changes-editor-view:not(.changes-editor-view--hidden)";
// The Files list on screen; it stays mounted, hidden, while a file is open.
const LIST = ".changes-page:not(.changes-page--hidden) .changes-list";
const ENABLED_STRIP = '.cm-changeStripButton[aria-disabled="false"]';
const DISABLED_STRIP = '.cm-changeStripButton[aria-disabled="true"]';

const js = JSON.stringify;

type Point = { x: number; y: number };

const where = ({ x, y }: Point) => `(${x.toFixed(1)}, ${y.toFixed(1)})`;

// A tap lands where it was meant to if the page saw the finger lift within a
// few CSS pixels of the point aimed at.
function checkLanded(name: string, aimed: Point, up: Point | null) {
	if (up === null) {
		throw new Error(`${name}: a tap at ${where(aimed)} never reached the page`);
	}
	if (Math.hypot(up.x - aimed.x, up.y - aimed.y) > 4) {
		throw new Error(
			`${name}: a tap meant for ${where(aimed)} landed at ${where(up)}, so the page has moved on screen`,
		);
	}
}

class Client {
	readonly samples = new Map<string, number[]>();
	readonly requests = new Map<string, number[]>();
	// How long each timed input took to reach the page's first handler.
	readonly delivery: number[] = [];

	// `settle` waits for the viewport to keep still before finding where to
	// tap, which a device needs while its keyboard comes and goes.
	constructor(
		private browser: Browser,
		private input: Input,
		private file: string,
		private settle = false,
	) {}

	// Times an input, from the finger lifting (or the key going down) to the
	// frame that draws each condition, and records each as `name (condition)`,
	// or under the name alone for the condition called `done`. A tap names the
	// point it aims at, which is checked against where it landed.
	async measure(
		name: string,
		conditions: Record<string, string>,
		input: (() => Promise<void>) | Point,
		record = true,
	) {
		checkInterrupted();
		const source = Object.entries(conditions)
			.map(([key, condition]) => `${js(key)}: () => (${condition})`)
			.join(", ");
		await this.browser.evaluate(
			`performance.clearResourceTimings(); __measure.watch({ ${source} }, 15000)`,
		);
		const aimed = typeof input === "function" ? null : input;
		if (typeof input === "function") await input();
		else await this.input.tap(input.x, input.y);
		const result = await Promise.race([
			this.browser.evaluate<{
				armed: number;
				tap: number | null;
				lag: number | null;
				up: Point | null;
				times: Record<string, number>;
				timedOut: boolean;
			}>("__measure.pending"),
			interruption,
		]);
		if (result.timedOut || result.tap === null) {
			const missing = Object.keys(conditions).filter(
				(key) => !(key in result.times),
			);
			if (aimed) checkLanded(name, aimed, result.up);
			throw new Error(
				`${name}: ${result.tap === null ? "the input never arrived" : `no ${missing.join(", ")} within 15 s`}, on ${await this.describe()}`,
			);
		}
		if (aimed) checkLanded(name, aimed, result.up);
		// The input's timeStamp has to fall after the watch was armed and
		// before the first handler ran, which holds only on the page's clock.
		const lag = result.lag ?? -1;
		if (!(result.armed <= result.tap && lag >= 0)) {
			throw new Error(
				`${name}: the input's timeStamp ${result.tap.toFixed(1)} is not on the page's clock: the watch was armed at ${result.armed.toFixed(1)}, and the handler ran ${lag.toFixed(1)} ms after it`,
			);
		}
		if (record) {
			for (const [key, time] of Object.entries(result.times)) {
				const label = `${name}${key === "done" ? "" : ` (${key})`}`;
				const list = this.samples.get(label) ?? [];
				list.push(time - result.tap);
				this.samples.set(label, list);
			}
			this.delivery.push(lag);
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

	// Where a finger would tap the element an expression finds: its centre, or
	// the end of its last row, scrolled into view first if it is off screen
	// or covered. Only a point where the element itself is hit will do, since
	// a point off screen lands on whatever is on screen there instead.
	async point(
		element: string,
		at: "centre" | "end" = "centre",
	): Promise<Point> {
		const found = await this.browser.evaluate<
			Point | { missing: true } | { blocked: string }
		>(`__measure.point(${element}, ${js(at)}, ${this.settle})`);
		if ("missing" in found) throw new Error(`nothing matches ${element}`);
		if ("blocked" in found) {
			throw new Error(
				`a finger cannot reach ${element}: ${found.blocked} is there`,
			);
		}
		return found;
	}

	// Taps without timing the result, and checks that the tap landed.
	async tapAt(point: Point) {
		await this.browser.evaluate("__measure.up = null");
		await this.input.tap(point.x, point.y);
		let up: Point | null = null;
		for (let i = 0; i < 100 && up === null; i++) {
			up = await this.browser.evaluate<Point | null>("__measure.up");
			if (up === null) await Bun.sleep(20);
		}
		checkLanded("a tap", point, up);
	}

	async tapOn(element: string) {
		await this.tapAt(await this.point(element));
	}

	async waitFor(condition: string, what: string, timeoutMs = 15000) {
		const deadline = Date.now() + timeoutMs;
		while (!(await this.browser.evaluate<boolean>(`Boolean(${condition})`))) {
			checkInterrupted();
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
		return `${LIST} [aria-label=${js(`${staged ? "Unstage" : "Stage"} ${this.file}`)}]`;
	}

	// The list shows the file with unstaged changes and nothing staged.
	listShowsFile() {
		return `document.querySelector(${js(this.entry(false))}) && !document.querySelector(${js(this.entry(true))})`;
	}

	async load() {
		await this.browser.send("Page.navigate", { url: `${clientUrl}files` });
		await this.waitFor(this.listShowsFile(), "the Files list to show the file");
	}

	async open(record = true) {
		const row = `document.querySelector(${js(`${LIST} .changes-file-row:has([aria-label=${js(`Stage ${this.file}`)}]) .changes-file-entry`)})`;
		await this.measure(
			"open a file",
			{
				shown: `document.querySelector(${js(`${ACTIVE} .cm-line`)})`,
				marked: `document.querySelector(${js(`${ACTIVE} .cm-changedLine`)})`,
				done: `document.querySelector(${js(`${ACTIVE} ${ENABLED_STRIP}`)})`,
			},
			await this.point(row),
			record,
		);
	}

	private tabLink(label: string) {
		return `[...document.querySelectorAll(".tab-bar-item")].find((tab) => tab.textContent.trim() === ${js(label)})`;
	}

	// Leaves for the History tab, then times coming back to the Files tab
	// until its list shows the changes and the tree again, which reads the
	// status and the top folder afresh.
	async openFilesTab() {
		await this.tapOn(this.tabLink("History"));
		await this.waitFor(
			`location.pathname.endsWith("/history") && !document.querySelector(".changes-page")`,
			"the History tab",
		);
		await Bun.sleep(600);
		await this.measure(
			"open the Files tab",
			{
				done: `document.querySelector(${js(`${LIST} .changes-file-row`)}) && document.querySelector(${js(`${LIST} .tree-entry`)})`,
			},
			await this.point(this.tabLink("Files")),
		);
		await this.waitFor(this.listShowsFile(), "the list to show the file");
	}

	async back(record = true) {
		await this.measure(
			"back to the list",
			{ done: `document.querySelector(${js(`${LIST} .changes-file-row`)})` },
			await this.point(
				`document.querySelector(${js(`${ACTIVE} [aria-label="Back to file list"]`)})`,
			),
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
		const element = `document.querySelector(${js(target)})`;
		await this.measure(
			"pick a line",
			{ done: picked },
			await this.point(element),
		);
		await this.measure(
			"pick a line",
			{ done: `!${picked}` },
			await this.point(element),
		);
	}

	// Stages the first change from its strip, timed until the strip has gone
	// and the editor's other strips are ready again. With sides to switch
	// between, the file's name no longer being greyed out shows that the
	// status has caught up.
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
			conditions.status = `${this.sideSwitch()}.getAttribute("aria-disabled") === "false"`;
		}
		await this.measure("stage a change from its strip", conditions, point);
	}

	// The file's name in the bar on screen, which switches to its other side.
	private sideSwitch() {
		return `document.querySelector(${js(`${ACTIVE} button.text-file-editor-name`)})`;
	}

	hasSwitch() {
		return this.browser.evaluate<boolean>(`Boolean(${this.sideSwitch()})`);
	}

	// Moves between the file's unstaged and staged changes from its name,
	// timed until the other view shows, named for its side, and none of its
	// strips is waiting.
	async flip(label: "Staged" | "Unstaged") {
		const side = `document.querySelector(${js(`${ACTIVE} .text-file-editor-name-side`)})?.firstChild?.textContent`;
		await this.measure(
			`switch to ${label}`,
			{
				done: `${side} === ${js(label)} && document.querySelector(${js(`${ACTIVE} .cm-line`)}) && !document.querySelector(${js(`${ACTIVE} ${DISABLED_STRIP}`)})`,
			},
			await this.point(this.sideSwitch()),
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
	// A device's keyboard comes up then, so wait for the viewport to settle.
	private async tapLineEnd(start: string) {
		await this.tapAt(await this.point(this.lineUnder(start), "end"));
		await Bun.sleep(300);
		if (this.settle) await this.browser.evaluate("__measure.still()");
	}

	private saveButton() {
		return `[...document.querySelectorAll(${js(`${ACTIVE} .text-file-editor-action`)})].find((button) => /^Sav/.test(button.textContent))`;
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
			() => this.input.type("x"),
		);
		await this.save(start);
		await this.tapLineEnd(start);
		await this.measure(
			"type a character",
			{ done: `${text} === ${js(before)}` },
			() => this.input.backspace(),
		);
		await this.save(start);
	}

	// Times a save until the Save button gives way, and until the diff has
	// been read again and the change's strip is ready.
	private async save(start: string) {
		await this.measure(
			"save",
			{
				saved: `!${this.saveButton()}`,
				done: `!${this.saveButton()} && document.querySelector(${js(`${ACTIVE} .cm-changeStrip[data-start="${start}"] [aria-disabled="false"]`)})`,
			},
			await this.point(this.saveButton()),
		);
	}

	// Reloads until the page runs the bundle the service serves now, which a
	// service worker can hold back for a load after a deploy.
	async checkBundle() {
		const index = await (await request(`${server}/`)).text();
		const served = /assets\/index-[\w-]+\.js/.exec(index)?.[0];
		if (!served) throw new Error(`${server}/ names no assets/index-*.js`);
		for (let attempt = 0; ; attempt++) {
			const scripts = await this.browser.evaluate<string[]>(
				"[...document.scripts].map((script) => script.src)",
			);
			if (scripts.some((source) => source.endsWith(served))) return;
			if (attempt === 2) {
				throw new Error(
					`the page still runs ${scripts.join(", ")} after two reloads, not ${served}`,
				);
			}
			await this.browser.send("Page.reload");
			await this.waitFor(this.listShowsFile(), "the list after a reload");
		}
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
	process.on("SIGINT", onSigint);
	try {
		// A large Android phone's width in CSS pixels, and Chrome on Android's
		// user agent, which CodeMirror reads to choose how to take input.
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
		const client = new Client(browser, new CdpInput(browser), file);
		await runInteractions(browser, client, file);
	} finally {
		process.off("SIGINT", onSigint);
		await browser.close();
		await restore();
	}
}

// Times each interaction `runs` times and reports them, once the page has its
// helper. The client and device modes share it.
async function runInteractions(browser: Browser, client: Client, file: string) {
	await client.load();
	// The first visit installs the service worker, and the first file
	// opened loads the editor's code, so neither is timed.
	await browser.send("Page.reload");
	await client.waitFor(client.listShowsFile(), "the list after a reload");
	await client.checkBundle();
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
		// the Files tab reads the status again when it opens.
		await request(api("/api/git/unstage"), post({ path: file }));
		await client.openFilesTab();
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
	report("input reaching the page, within each figure", client.delivery);
	console.log("\nAPI requests as the page saw them, service worker included\n");
	for (const [label, samples] of [...client.requests].sort()) {
		report(label, samples);
	}
}

// ---------------------------------------------------------------------------
// Device mode

function findAdb(): string {
	if (options.adb) return options.adb;
	const onPath = Bun.which("adb");
	if (onPath) return onPath;
	const binary = process.platform === "win32" ? "adb.exe" : "adb";
	for (const home of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
		const candidate = home ? path.join(home, "platform-tools", binary) : "";
		if (candidate && existsSync(candidate)) return candidate;
	}
	fail("No adb found; pass --adb <path to adb>");
}

// adb, aimed at one device: every command names its serial, so a run never
// reaches another device attached to the same machine.
class Adb {
	constructor(
		private binary: string,
		readonly serial: string,
	) {}

	async run(...args: string[]): Promise<string> {
		const child = Bun.spawn([this.binary, "-s", this.serial, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if ((await child.exited) !== 0) {
			throw new Error(`adb ${args.join(" ")}: ${(err || out).trim()}`);
		}
		return out;
	}

	async keyboardShown(): Promise<boolean> {
		return /mInputShown=true/.test(
			await this.run("shell", "dumpsys", "input_method"),
		);
	}
}

// Where the visual viewport's top left corner sits on the screen, in screen
// pixels, how many screen pixels a CSS pixel spans each way, and the pinch
// zoom these were measured at.
type ScreenMap = {
	left: number;
	top: number;
	scaleX: number;
	scaleY: number;
	zoom: number;
};

// Input through Android's own pipeline, with `adb shell input`, so the page
// gets the events a finger or a keyboard would give it. The first tap
// calibrates the mapping from the page's CSS pixels to the screen's.
class AdbInput implements Input {
	// How long adb took to send each input, which the figures leave out.
	readonly sendTimes: number[] = [];
	private map: ScreenMap | null = null;

	constructor(
		private adb: Adb,
		private browser: Browser,
	) {}

	private viewport() {
		return this.browser.evaluate<{ left: number; top: number; scale: number }>(
			"({ left: visualViewport.offsetLeft, top: visualViewport.offsetTop, scale: visualViewport.scale })",
		);
	}

	// Taps two points of the screen and fits where the page saw them land. A
	// layer over the page takes both taps, so they change nothing. The page
	// lies somewhere in the screen's height, and wherever that is, it covers
	// the band from the screen's height less the page's down to the page's
	// height, and likewise across, so the points are chosen inside that band.
	private async calibrate(): Promise<ScreenMap> {
		const page = await this.browser.evaluate<{
			screenWidth: number;
			screenHeight: number;
			width: number;
			height: number;
			ratio: number;
		}>(
			"({ screenWidth: screen.width, screenHeight: screen.height, width: innerWidth, height: innerHeight, ratio: devicePixelRatio })",
		);
		const [left, right] = [page.screenWidth - page.width, page.width];
		const [top, bottom] = [page.screenHeight - page.height, page.height];
		if (right - left < 100 || bottom - top < 100) {
			throw new Error(
				"the page covers too little of the screen to calibrate taps against; close the keyboard, or leave split screen",
			);
		}
		const aims = [0.25, 0.75].map((f) => ({
			x: Math.round((left + f * (right - left)) * page.ratio),
			y: Math.round((top + f * (bottom - top)) * page.ratio),
		}));
		const view = await this.viewport();
		await this.browser.evaluate("__measure.cover()");
		let taps: Point[];
		try {
			for (const aim of aims) {
				await this.adb.run("shell", "input", "tap", `${aim.x}`, `${aim.y}`);
				await Bun.sleep(400);
			}
		} finally {
			taps = await this.browser.evaluate<Point[]>("__measure.uncover()");
		}
		if (taps.length !== 2) {
			throw new Error(`calibration: the page saw ${taps.length} of 2 taps`);
		}
		const scaleX = (aims[1].x - aims[0].x) / (taps[1].x - taps[0].x);
		const scaleY = (aims[1].y - aims[0].y) / (taps[1].y - taps[0].y);
		const expected = page.ratio * view.scale;
		if (
			Math.abs(scaleX / expected - 1) > 0.02 ||
			Math.abs(scaleY / expected - 1) > 0.02
		) {
			throw new Error(
				`calibration: a CSS pixel spans ${scaleX.toFixed(3)} by ${scaleY.toFixed(3)} screen pixels, not ${expected}`,
			);
		}
		const map = {
			left: aims[0].x - (taps[0].x - view.left) * scaleX,
			top: aims[0].y - (taps[0].y - view.top) * scaleY,
			scaleX,
			scaleY,
			zoom: view.scale,
		};
		console.log(
			`Calibrated taps: the page's top left corner is at (${map.left.toFixed(0)}, ${map.top.toFixed(0)}) on the screen, and a CSS pixel spans ${scaleX.toFixed(2)} screen pixels.\n`,
		);
		return map;
	}

	async tap(x: number, y: number) {
		this.map ??= await this.calibrate();
		const map = this.map;
		const view = await this.viewport();
		if (Math.abs(view.scale - map.zoom) > 0.001) {
			throw new Error(
				"the page has been zoomed since the taps were calibrated",
			);
		}
		const screenX = Math.round(map.left + (x - view.left) * map.scaleX);
		const screenY = Math.round(map.top + (y - view.top) * map.scaleY);
		await this.send("tap", `${screenX}`, `${screenY}`);
	}

	type(character: string) {
		return this.send("text", character);
	}

	backspace() {
		return this.send("keyevent", "KEYCODE_DEL");
	}

	private async send(...args: string[]) {
		const start = performance.now();
		await this.adb.run("shell", "input", ...args);
		this.sendTimes.push(performance.now() - start);
	}
}

interface Target {
	type: string;
	url: string;
	webSocketDebuggerUrl: string;
}

// Attaches to the Rift page in the device's foreground, in a Chrome tab or in
// the installed app, which shares Chrome's DevTools socket. Pages in the
// background are frozen and never answer, so each gets a few seconds.
async function attachToRift(port: number): Promise<Browser> {
	const targets = (await fetch(`http://127.0.0.1:${port}/json/list`)
		.then((response) => response.json())
		.catch(() => null)) as Target[] | null;
	if (targets === null) {
		throw new Error(
			"Chrome's DevTools socket does not answer; bring Chrome, or the installed app, to the foreground",
		);
	}
	const candidates = targets.filter(
		(target) =>
			target.type === "page" &&
			(target.url.startsWith(clientUrl) || `${target.url}/` === clientUrl),
	);
	const visible = await Promise.all(
		candidates.map(async (target) => {
			const browser = await Browser.attach(target.webSocketDebuggerUrl).catch(
				() => null,
			);
			if (browser === null) return null;
			const shown = await within(
				browser
					.evaluate<boolean>(`document.visibilityState === "visible"`)
					.catch(() => false),
				3000,
				() => false,
			);
			if (shown) return browser;
			await browser.close();
			return null;
		}),
	);
	const [found, ...others] = visible.filter((browser) => browser !== null);
	for (const other of others) await other.close();
	if (!found) {
		throw new Error(
			`No page at ${clientUrl} is open in the foreground. Open Rift there, in Chrome or the installed app, and run this again; the script will not open a page itself, because a page it opens on a phone stays in the background and the taps would land elsewhere.`,
		);
	}
	return found;
}

async function measureDevice(file: string, restore: () => Promise<void>) {
	const adb = new Adb(findAdb(), options.serial ?? "");
	const state = await adb.run("get-state").catch(() => "");
	if (state.trim() !== "device") {
		fail(`${adb.serial} is not ready; \`adb devices\` lists what is attached`);
	}
	const port = (
		await adb.run("forward", "tcp:0", "localabstract:chrome_devtools_remote")
	).trim();
	process.on("SIGINT", onSigint);
	try {
		const browser = await attachToRift(Number(port));
		// Rift asks before it leaves a page with unsaved edits. A person's
		// edits stop the run before it starts; the edits a run makes are its
		// own, so when Rift asks during the run, the answer is to leave.
		const unsaved = await browser.evaluate<boolean>(
			`(() => { const event = new Event("beforeunload", { cancelable: true }); dispatchEvent(event); return event.defaultPrevented; })()`,
		);
		if (unsaved) {
			await browser.close();
			throw new Error(
				"Rift on the device has unsaved edits; save or discard them, then run this again",
			);
		}
		const saved = await browser.evaluate<{
			url: string;
			storage: Record<string, string>;
			standalone: boolean;
		}>(
			`({ url: location.href, storage: Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])), standalone: matchMedia("(display-mode: standalone)").matches })`,
		);
		const model = (
			await adb.run("shell", "getprop", "ro.product.model")
		).trim();
		const version = (await (
			await fetch(`http://127.0.0.1:${port}/json/version`)
		).json()) as { Browser: string };
		console.log(
			`\nInteractions on ${model} (${adb.serial}), ${version.Browser}, in ${saved.standalone ? "the installed app" : "a Chrome tab"}, at ${clientUrl}, ${repo}, ${file}, CPU slowed ${cpuSlowdown}x`,
		);
		console.log(
			"Each figure runs from the input's own timestamp, which Android sets as it takes the touch or key, to the end of the frame that draws the result. The time adb takes to deliver the input is left out.\n",
		);
		const input = new AdbInput(adb, browser);
		let helper = "";
		try {
			browser.on("Page.javascriptDialogOpening", (params) => {
				if (params.type === "beforeunload") {
					browser
						.send("Page.handleJavaScriptDialog", { accept: true })
						.catch(() => {});
				}
			});
			await browser.send("Page.enable");
			await browser.send("Emulation.setCPUThrottlingRate", {
				rate: cpuSlowdown,
			});
			helper = String(
				(
					await browser.send("Page.addScriptToEvaluateOnNewDocument", {
						source: PAGE_HELPER(repo),
					})
				).identifier,
			);
			const client = new Client(browser, input, file, true);
			await runInteractions(browser, client, file);
			report("adb delivering each input, left out", input.sendTimes);
		} finally {
			await restore();
			await putPageBack(browser, adb, helper, saved);
			await browser.close();
		}
	} finally {
		await adb.run("forward", "--remove", `tcp:${port}`).catch(() => {});
		process.off("SIGINT", onSigint);
	}
}

// Settles as `promise` does, or after `ms` with what `otherwise` gives, or
// with what it throws. A page held up by a dialog answers nothing, so waits
// on a page that may be in that state are bounded with it.
function within<T>(
	promise: Promise<T>,
	ms: number,
	otherwise: () => T,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<T>((resolve, reject) => {
		timer = setTimeout(() => {
			try {
				resolve(otherwise());
			} catch (error) {
				reject(error);
			}
		}, ms);
	});
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// Leaves the page as it was found: without the helper, with the storage it
// had, which holds the selected repo and any drafts, at the URL it showed,
// and with the keyboard down. The storage is put back by a script that runs
// before Rift does on the page's next load, after anything the page being
// left writes as it goes.
async function putPageBack(
	browser: Browser,
	adb: Adb,
	helper: string,
	saved: { url: string; storage: Record<string, string> },
) {
	const attempt = async (what: string, step: () => Promise<unknown>) => {
		try {
			await within(step(), 20000, () => {
				throw new Error("it took over 20 s");
			});
		} catch (error) {
			console.error(`Could not ${what}: ${(error as Error).message}`);
		}
	};
	await attempt("remove the helper", async () => {
		if (helper) {
			await browser.send("Page.removeScriptToEvaluateOnNewDocument", {
				identifier: helper,
			});
		}
	});
	await attempt("reset the CPU", () =>
		browser.send("Emulation.setCPUThrottlingRate", { rate: 1 }),
	);
	let restorer = "";
	await attempt(`put the page back at ${saved.url}`, async () => {
		restorer = String(
			(
				await browser.send("Page.addScriptToEvaluateOnNewDocument", {
					source: `(() => {
						const saved = ${JSON.stringify(saved.storage)};
						for (const key of Object.keys(localStorage)) if (!(key in saved)) localStorage.removeItem(key);
						for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
					})();`,
				})
			).identifier,
		);
		const deadline = Date.now() + 15000;
		await within(
			browser.send("Page.navigate", { url: saved.url }),
			15000,
			() => ({}),
		);
		for (;;) {
			const loaded = await within(
				browser
					.evaluate<boolean>(
						`document.readyState === "complete" && location.href === ${js(saved.url)}`,
					)
					.catch(() => false),
				1000,
				() => false,
			);
			if (loaded) break;
			if (Date.now() > deadline) throw new Error("it did not finish loading");
			await Bun.sleep(100);
		}
	});
	await attempt("remove the storage restorer", async () => {
		if (restorer) {
			await browser.send("Page.removeScriptToEvaluateOnNewDocument", {
				identifier: restorer,
			});
		}
	});
	// Back closes the keyboard when it is up, and would leave the page if it
	// were not, so it is sent only while the keyboard shows.
	await attempt("close the keyboard", async () => {
		await within(
			browser.evaluate("document.activeElement?.blur()").catch(() => {}),
			1000,
			() => undefined,
		);
		await Bun.sleep(500);
		if (await adb.keyboardShown()) {
			await adb.run("shell", "input", "keyevent", "KEYCODE_BACK");
		}
	});
}

// ---------------------------------------------------------------------------

if (mode === "spawn" || mode === "all") await measureSpawn();
if (mode !== "spawn") {
	const file = await chooseFile();
	const restore = await guardFile(file);
	try {
		if (mode === "server" || mode === "all") await measureServer(file);
		if (mode === "client" || mode === "all") await measureClient(file, restore);
		if (mode === "device") await measureDevice(file, restore);
	} finally {
		await restore();
	}
}
