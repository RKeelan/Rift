import { createApp, getConfig } from "./app.js";

const config = getConfig();
const host = process.env.HOST || "127.0.0.1";

const app = createApp(config);

const server = app.listen(config.port, host, () => {
	console.log(`Rift server listening on ${host}:${config.port}`);
	for (const root of config.roots) {
		console.log(`Repos root: ${root.label} -> ${root.path}`);
	}
});

let shuttingDown = false;
function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log("Shutting down...");
	server.close(() => {
		process.exit(0);
	});
	setTimeout(() => {
		console.error("Forced shutdown after timeout");
		process.exit(1);
	}, 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
