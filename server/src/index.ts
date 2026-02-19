import { createApp, getConfig } from "./app.js";

const config = getConfig();
const app = createApp(config);

app.listen(config.port, "0.0.0.0", () => {
	console.log(`Rift server listening on 0.0.0.0:${config.port}`);
	console.log(`Working directory: ${config.workingDir}`);
});
