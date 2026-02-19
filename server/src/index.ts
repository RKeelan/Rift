import { EchoAdapter } from "./adapters/index.js";
import { createApp, getConfig } from "./app.js";
import { SessionManager } from "./session.js";

const config = getConfig();

const sessionManager = new SessionManager({
	adapterFactory: () => new EchoAdapter(),
});

const app = createApp(config, sessionManager);

const server = app.listen(config.port, "0.0.0.0", () => {
	console.log(`Rift server listening on 0.0.0.0:${config.port}`);
	console.log(`Working directory: ${config.workingDir}`);
});

let shuttingDown = false;
function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log("Shutting down...");
	sessionManager.dispose();
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
