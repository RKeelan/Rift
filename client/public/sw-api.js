// Imported by the generated service worker (see `importScripts` in
// vite.config.ts). API answers must always be current, so API requests never
// go through the worker.

// Chrome's static routing API sends matching requests straight to the network
// without starting the worker's fetch handler. Browsers without it ignore this.
self.addEventListener("install", (event) => {
	if (typeof event.addRoutes !== "function") return;
	const pathname = new URL("api/*", self.registration.scope).pathname;
	event.addRoutes({
		condition: { urlPattern: { pathname } },
		source: "network",
	});
});

// Earlier workers cached every API answer without expiry.
self.addEventListener("activate", (event) => {
	event.waitUntil(caches.delete("api-calls"));
});
