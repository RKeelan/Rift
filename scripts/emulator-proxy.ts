// Serves the deployed Rift under /rift/ for the Android emulator, which cannot
// resolve tailnet names. It does what `tailscale serve --set-path=/rift` does:
// strip the prefix and forward to the service on loopback. It adds no proxy
// headers, so the service treats each request as local, as it does the Vite dev
// server's.
//
//   bun scripts/emulator-proxy.ts
//   adb reverse tcp:8080 tcp:13001
//
// then open http://localhost:8080/rift/ in the emulator's Chrome.
const TARGET = `http://127.0.0.1:${process.env.RIFT_PORT ?? "13000"}`;
const PORT = Number(process.env.PROXY_PORT ?? "13001");

Bun.serve({
	hostname: "127.0.0.1",
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		let path = url.pathname;
		if (path === "/rift") path = "/";
		else if (path.startsWith("/rift/")) path = path.slice("/rift".length);
		const headers = new Headers(req.headers);
		headers.delete("host");
		headers.delete("accept-encoding");
		const body =
			req.method === "GET" || req.method === "HEAD"
				? undefined
				: await req.arrayBuffer();
		const res = await fetch(`${TARGET}${path}${url.search}`, {
			method: req.method,
			headers,
			body,
			redirect: "manual",
		});
		const out = new Headers(res.headers);
		out.delete("content-encoding");
		out.delete("content-length");
		return new Response(res.body, { status: res.status, headers: out });
	},
});
console.log(
	`Rift emulator proxy on http://127.0.0.1:${PORT}/rift/ -> ${TARGET}`,
);
