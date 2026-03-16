import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite";

export default defineConfig({
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
				navigateFallback: "/index.html",
			},
			manifest: {
				name: "Rift",
				short_name: "Rift",
				description: "Mobile-first coding agent frontend",
				theme_color: "#121212",
				background_color: "#121212",
				display: "standalone",
				start_url: "/",
				icons: [
					{
						src: "/icon-192.png",
						sizes: "192x192",
						type: "image/png",
						purpose: "any",
					},
					{
						src: "/icon-512.png",
						sizes: "512x512",
						type: "image/png",
						purpose: "any",
					},
					{
						src: "/icon-192-maskable.png",
						sizes: "192x192",
						type: "image/png",
						purpose: "maskable",
					},
					{
						src: "/icon-512-maskable.png",
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
			"/api": {
				target: "http://localhost:13000",
				changeOrigin: true,
				ws: true,
			},
		},
	},
});
