import { createApp, getConfig } from "./app.js";

const config = getConfig();

const app = createApp(config);

const server = app.listen(config.port, "0.0.0.0", () => {
	console.log(`Rift server listening on 0.0.0.0:${config.port}`);
	console.log(`Repos root: ${config.reposRoot}`);
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
