import { resolveHost } from "./access.js";
import { createApp, getConfig } from "./app.js";

const config = getConfig();
const host = resolveHost(process.env.HOST);

const app = createApp(config);

const server = app.listen(config.port, host, () => {
	console.log(`Rift server listening on ${host}:${config.port}`);
	for (const root of config.roots) {
		console.log(`Repos root: ${root.label} -> ${root.path}`);
	}
	console.log(
		config.allowedLogins.length > 0
			? `Allowed Tailscale logins: ${config.allowedLogins.join(", ")}`
			: "Allowed Tailscale logins: none; every proxied request is refused",
	);
	console.log(
		config.allowWrites
			? "Writes: allowed"
			: "Writes: refused; set RIFT_ALLOW_WRITES=1 to allow them",
	);
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
