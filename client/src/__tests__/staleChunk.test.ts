import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	installStaleChunkReload,
	isChunkLoadError,
	RELOAD_GUARD_MS,
	reloadForStaleChunk,
} from "../staleChunk.ts";

const location = window.location;
let reloads = 0;
const originalReload = location.reload;

beforeEach(() => {
	reloads = 0;
	window.sessionStorage.clear();
	location.reload = () => {
		reloads++;
	};
});

afterEach(() => {
	location.reload = originalReload;
});

describe("reloadForStaleChunk", () => {
	test("reloads the first time", () => {
		expect(reloadForStaleChunk(1_000_000)).toBe(true);
		expect(reloads).toBe(1);
	});

	test("does not reload again within the guard window", () => {
		reloadForStaleChunk(1_000_000);
		expect(reloadForStaleChunk(1_000_000 + RELOAD_GUARD_MS - 1)).toBe(false);
		expect(reloads).toBe(1);
	});

	test("reloads again once the guard window has passed", () => {
		reloadForStaleChunk(1_000_000);
		expect(reloadForStaleChunk(1_000_000 + RELOAD_GUARD_MS)).toBe(true);
		expect(reloads).toBe(2);
	});

	test("does not reload when storage is unavailable", () => {
		const original = Object.getOwnPropertyDescriptor(window, "sessionStorage");
		Object.defineProperty(window, "sessionStorage", {
			configurable: true,
			get() {
				throw new Error("blocked");
			},
		});
		try {
			expect(reloadForStaleChunk()).toBe(false);
			expect(reloads).toBe(0);
		} finally {
			if (original) Object.defineProperty(window, "sessionStorage", original);
		}
	});
});

describe("isChunkLoadError", () => {
	test("recognises each engine's wording", () => {
		for (const message of [
			"Failed to fetch dynamically imported module: https://x/assets/a.js",
			"error loading dynamically imported module: https://x/assets/a.js",
			"Importing a module script failed.",
		]) {
			expect(isChunkLoadError(new TypeError(message))).toBe(true);
		}
	});

	test("rejects unrelated errors and non-errors", () => {
		expect(isChunkLoadError(new Error("network down"))).toBe(false);
		expect(
			isChunkLoadError("Failed to fetch dynamically imported module"),
		).toBe(false);
	});
});

describe("installStaleChunkReload", () => {
	test("reloads on vite:preloadError and suppresses the error once", () => {
		installStaleChunkReload();
		const first = new window.Event("vite:preloadError", { cancelable: true });
		window.dispatchEvent(first);
		expect(reloads).toBe(1);
		expect(first.defaultPrevented).toBe(true);

		const second = new window.Event("vite:preloadError", { cancelable: true });
		window.dispatchEvent(second);
		expect(reloads).toBe(1);
		expect(second.defaultPrevented).toBe(false);
	});
});
