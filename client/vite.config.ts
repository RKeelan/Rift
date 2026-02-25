import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite";

// BASE_NAME avoids slashes so MSYS doesn't mangle it as a path.
// e.g. BASE_NAME=rift → base="/rift/"
const baseName = process.env.BASE_NAME;
const base = baseName ? `/${baseName}/` : "/";

export default defineConfig({
	base,
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
				navigateFallback: `${base}index.html`,
			},
			manifest: {
				name: "Rift",
				short_name: "Rift",
				description: "Mobile-first coding agent frontend",
				theme_color: "#121212",
				background_color: "#121212",
				display: "standalone",
				start_url: base,
				icons: [
					{
						src: `${base}icon-192.png`,
						sizes: "192x192",
						type: "image/png",
					},
					{
						src: `${base}icon-512.png`,
						sizes: "512x512",
						type: "image/png",
					},
				],
			},
		}),
	],
	server: {
		host: "0.0.0.0",
		proxy: {
			"/api": {
				target: "http://localhost:3000",
				changeOrigin: true,
				ws: true,
			},
		},
	},
});
