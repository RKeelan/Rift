import { registerSW } from "virtual:pwa-register";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { installStaleChunkReload } from "./staleChunk.ts";

// With `registerType: "autoUpdate"` the registration reloads the page once a
// new service worker activates, so the open bundle never outlives its chunks.
registerSW({ immediate: true });
installStaleChunkReload();

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(
	<StrictMode>
		<BrowserRouter
			basename={import.meta.env.BASE_URL.replace(/\/$/, "") || "/"}
		>
			<App />
		</BrowserRouter>
	</StrictMode>,
);
