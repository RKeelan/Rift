import { apiUrl } from "./apiUrl.ts";

// A phone's Wi-Fi radio sleeps between requests, and a response that arrives
// while it sleeps waits at the access point until the radio wakes, which adds
// 100 ms or more to a request. A tiny request sent every few milliseconds
// keeps the radio awake, so the app sends them for exactly as long as an
// interaction lasts: one when a touch starts, so the radio is awake before the
// finger lifts and the real request goes out, then a steady stream while any
// API request is outstanding.

/** Marks a request as a keep-awake ping; the service worker leaves these alone. */
export const KEEP_AWAKE_PARAM = "keepawake";
export const PING_INTERVAL_MS = 10;
// A request this long is no longer a quick interaction, and a radio that has
// been kept awake this long gains nothing from further pings.
export const MAX_BURST_MS = 1000;
export const TOUCH_DEDUPE_MS = 100;
// A radio that is asleep delays every ping, so pings could otherwise pile up.
const MAX_PINGS_IN_FLIGHT = 4;

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function isApiRequest(input: RequestInfo | URL): boolean {
	try {
		const { pathname } = new URL(requestUrl(input), "http://localhost");
		return pathname.startsWith(apiUrl("/api/"));
	} catch {
		return false;
	}
}

/**
 * Wraps `fetch` to count outstanding API requests and sends keep-awake pings
 * around them. Returns a function that restores `fetch` and stops everything.
 */
export function installKeepAwake(): () => void {
	// Pings go through the original fetch, so they are never counted.
	const originalFetch = globalThis.fetch;
	const inFlight = new Set<AbortController>();
	let outstanding = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let capTimer: ReturnType<typeof setTimeout> | undefined;
	// Set once a burst hit its cap, until the requests drain or a touch comes.
	let capped = false;
	let lastTouchPing = Number.NEGATIVE_INFINITY;

	function ping() {
		if (document.visibilityState === "hidden") return;
		if (inFlight.size >= MAX_PINGS_IN_FLIGHT) return;
		const controller = new AbortController();
		inFlight.add(controller);
		try {
			originalFetch(apiUrl(`/api/health?${KEEP_AWAKE_PARAM}=1`), {
				cache: "no-store",
				signal: controller.signal,
			})
				.catch(() => {})
				.finally(() => inFlight.delete(controller));
		} catch {
			inFlight.delete(controller);
		}
	}

	function stopTimers() {
		if (timer !== undefined) clearInterval(timer);
		if (capTimer !== undefined) clearTimeout(capTimer);
		timer = undefined;
		capTimer = undefined;
	}

	function stopPinging() {
		stopTimers();
		for (const controller of inFlight) controller.abort();
		inFlight.clear();
	}

	// Starts a burst of pings, which ends by itself after MAX_BURST_MS.
	function startBurst() {
		if (timer !== undefined) return;
		capped = false;
		timer = setInterval(ping, PING_INTERVAL_MS);
		capTimer = setTimeout(() => {
			stopTimers();
			capped = true;
		}, MAX_BURST_MS);
	}

	function settle() {
		outstanding--;
		if (outstanding <= 0) {
			outstanding = 0;
			capped = false;
			stopPinging();
		}
	}

	const trackedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const result = originalFetch(input, init);
		if (!isApiRequest(input)) return result;
		outstanding++;
		if (!capped) startBurst();
		result.then(settle, settle);
		return result;
	}) as typeof fetch;

	// One touch raises both `touchstart` and `pointerdown`; it earns one ping.
	function onTouch() {
		const now = Date.now();
		if (now - lastTouchPing < TOUCH_DEDUPE_MS) return;
		lastTouchPing = now;
		ping();
		// A touch during a long request wakes the radio again for another burst.
		if (outstanding > 0 && capped) startBurst();
	}
	function onVisibilityChange() {
		if (document.visibilityState === "hidden") stopPinging();
		else if (outstanding > 0 && !capped) startBurst();
	}

	globalThis.fetch = trackedFetch;
	const options = { capture: true, passive: true } as const;
	document.addEventListener("touchstart", onTouch, options);
	document.addEventListener("pointerdown", onTouch, options);
	document.addEventListener("visibilitychange", onVisibilityChange);

	return () => {
		if (globalThis.fetch === trackedFetch) globalThis.fetch = originalFetch;
		document.removeEventListener("touchstart", onTouch, options);
		document.removeEventListener("pointerdown", onTouch, options);
		document.removeEventListener("visibilitychange", onVisibilityChange);
		outstanding = 0;
		stopPinging();
	};
}
