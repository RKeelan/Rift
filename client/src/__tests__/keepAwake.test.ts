import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
	installKeepAwake,
	MAX_BURST_MS,
	PING_INTERVAL_MS,
	TOUCH_DEDUPE_MS,
} from "../keepAwake.ts";

const originalFetch = globalThis.fetch;
let calls: string[];
let pending: Array<{
	resolve: () => void;
	ping: boolean;
	signal?: AbortSignal | null;
}>;
let uninstall: (() => void) | undefined;
let visibility: DocumentVisibilityState;

function stubFetch(mode: "pending" | "reject") {
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		calls.push(String(input));
		if (mode === "reject") return Promise.reject(new Error("offline"));
		return new Promise<Response>((resolve) => {
			pending.push({
				resolve: () => resolve(new Response("{}")),
				ping: String(input).includes("keepawake"),
				signal: init?.signal,
			});
		});
	}) as typeof fetch;
}

function pings() {
	return calls.filter((c) => c.includes("keepawake")).length;
}

// Advances time in ping-sized steps, answering each ping as it is sent.
function run(ms: number) {
	for (let t = 0; t < ms; t += PING_INTERVAL_MS) {
		jest.advanceTimersByTime(PING_INTERVAL_MS);
		for (const p of pending) if (p.ping) p.resolve();
	}
}

async function flush() {
	await Promise.resolve();
	await Promise.resolve();
}

beforeEach(() => {
	jest.useFakeTimers();
	calls = [];
	pending = [];
	visibility = "visible";
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		get: () => visibility,
	});
});

afterEach(() => {
	uninstall?.();
	uninstall = undefined;
	globalThis.fetch = originalFetch;
	jest.useRealTimers();
});

function install(mode: "pending" | "reject" = "pending") {
	stubFetch(mode);
	uninstall = installKeepAwake();
}

describe("installKeepAwake", () => {
	test("a touch sends one ping to the health endpoint", () => {
		install();
		document.dispatchEvent(new Event("touchstart"));
		expect(pings()).toBe(1);
		expect(calls[0]).toBe("/api/health?keepawake=1");
		jest.advanceTimersByTime(100);
		expect(pings()).toBe(1);
	});

	test("one touch raising both events sends one ping", () => {
		install();
		document.dispatchEvent(new Event("touchstart"));
		document.dispatchEvent(new Event("pointerdown"));
		expect(pings()).toBe(1);
		jest.advanceTimersByTime(TOUCH_DEDUPE_MS);
		document.dispatchEvent(new Event("pointerdown"));
		expect(pings()).toBe(2);
	});

	test("a long request stops pinging after one burst, until a touch", async () => {
		install();
		const request = fetch("/api/git/commit");
		run(MAX_BURST_MS * 3);
		expect(pings()).toBeLessThanOrEqual(MAX_BURST_MS / PING_INTERVAL_MS);
		const capped = pings();
		fetch("/api/files");
		run(MAX_BURST_MS);
		expect(pings()).toBe(capped);
		document.dispatchEvent(new Event("touchstart"));
		run(PING_INTERVAL_MS);
		expect(pings()).toBe(capped + 2);
		for (const p of pending) if (!p.ping) p.resolve();
		await request;
		await flush();
		fetch("/api/files");
		run(PING_INTERVAL_MS);
		expect(pings()).toBe(capped + 3);
	});

	test("pointerdown also sends a ping", () => {
		install();
		document.dispatchEvent(new Event("pointerdown"));
		expect(pings()).toBe(1);
	});

	test("an outstanding API request starts pings that stop when it settles", async () => {
		install();
		const request = fetch("/api/git/diff");
		expect(pings()).toBe(0);
		jest.advanceTimersByTime(PING_INTERVAL_MS);
		expect(pings()).toBe(1);
		pending[1].resolve();
		jest.advanceTimersByTime(PING_INTERVAL_MS);
		expect(pings()).toBe(2);
		pending[0].resolve();
		await request;
		await flush();
		const before = pings();
		jest.advanceTimersByTime(PING_INTERVAL_MS * 10);
		expect(pings()).toBe(before);
	});

	test("pings continue until the last of several requests settles", async () => {
		install();
		const a = fetch("/api/files");
		const b = fetch("/api/git/log");
		pending[0].resolve();
		await a;
		await flush();
		jest.advanceTimersByTime(PING_INTERVAL_MS);
		expect(pings()).toBe(1);
		pending[1].resolve();
		await b;
		await flush();
		jest.advanceTimersByTime(PING_INTERVAL_MS * 5);
		expect(pings()).toBe(1);
	});

	test("pings themselves and non-API requests are not tracked", () => {
		install();
		document.dispatchEvent(new Event("touchstart"));
		jest.advanceTimersByTime(PING_INTERVAL_MS * 5);
		expect(pings()).toBe(1);
		fetch("/assets/index.js");
		jest.advanceTimersByTime(PING_INTERVAL_MS * 5);
		expect(pings()).toBe(1);
	});

	test("an in-flight ping is aborted when the request settles", async () => {
		install();
		const request = fetch("/api/files");
		jest.advanceTimersByTime(PING_INTERVAL_MS);
		const ping = pending[1];
		pending[0].resolve();
		await request;
		await flush();
		expect(ping.signal?.aborted).toBe(true);
	});

	test("a hidden page sends none", () => {
		install();
		visibility = "hidden";
		document.dispatchEvent(new Event("touchstart"));
		fetch("/api/files");
		jest.advanceTimersByTime(PING_INTERVAL_MS * 5);
		expect(pings()).toBe(0);
	});

	test("hiding the page stops pings that were running", () => {
		install();
		fetch("/api/files");
		jest.advanceTimersByTime(PING_INTERVAL_MS);
		expect(pings()).toBe(1);
		visibility = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		jest.advanceTimersByTime(PING_INTERVAL_MS * 5);
		expect(pings()).toBe(1);
	});

	test("failed pings are swallowed", async () => {
		install("reject");
		document.dispatchEvent(new Event("touchstart"));
		await flush();
		expect(pings()).toBe(1);
	});

	test("uninstalling restores fetch", () => {
		stubFetch("pending");
		const stub = globalThis.fetch;
		uninstall = installKeepAwake();
		expect(globalThis.fetch).not.toBe(stub);
		uninstall();
		expect(globalThis.fetch).toBe(stub);
	});
});
