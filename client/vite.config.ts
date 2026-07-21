import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite";

// Rift is served under a sub-path so the tailnet host's root stays free for
// other services. `tailscale serve --set-path` strips the prefix before
// forwarding, so the server still sees "/" — only the browser-facing URLs and
// the dev proxy need to know about it.
const BASE_PATH = "/rift";
const BASE = `${BASE_PATH}/`;

export default defineConfig({
	base: BASE,
	plugins: [
		react(),
		VitePWA({
			registerType: "autoUpdate",
			workbox: {
				clientsClaim: true,
				skipWaiting: true,
				runtimeCaching: [
					{
						urlPattern: /\/assets\/.*/,
						handler: "CacheFirst",
						options: {
							cacheName: "static-assets",
							expiration: { maxEntries: 100, maxAgeSeconds: 30 * 24 * 60 * 60 },
						},
					},
					{
						urlPattern: /\/api\/.*/,
						handler: "NetworkFirst",
						options: {
							cacheName: "api-calls",
							networkTimeoutSeconds: 10,
						},
					},
				],
				navigateFallback: `${BASE}index.html`,
			},
			manifest: {
				name: "Rift",
				short_name: "Rift",
				description: "Mobile-first coding agent frontend",
				theme_color: "#121212",
				background_color: "#121212",
				display: "standalone",
				start_url: BASE,
				scope: BASE,
				icons: [
					{
						src: `${BASE}icon-192.png`,
						sizes: "192x192",
						type: "image/png",
						purpose: "any",
					},
					{
						src: `${BASE}icon-512.png`,
						sizes: "512x512",
						type: "image/png",
						purpose: "any",
					},
					{
						src: `${BASE}icon-192-maskable.png`,
						sizes: "192x192",
						type: "image/png",
						purpose: "maskable",
					},
					{
						src: `${BASE}icon-512-maskable.png`,
						sizes: "512x512",
						type: "image/png",
						purpose: "maskable",
					},
				],
			},
		}),
	],
	server: {
		host: "0.0.0.0",
		proxy: {
			// Mirrors what `tailscale serve --set-path` does in production, so a
			// base-path mistake shows up in dev rather than only on the phone.
			[`${BASE_PATH}/api`]: {
				target: "http://localhost:13000",
				changeOrigin: true,
				ws: true,
				rewrite: (path: string) =>
					path.replace(new RegExp(`^${BASE_PATH}`), ""),
			},
		},
	},
});
