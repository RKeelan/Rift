import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const distDir = resolve(import.meta.dir, "../../dist");

// Must match `base` in vite.config.ts.
const BASE = "/rift/";

describe("PWA build output", () => {
	test("manifest.webmanifest exists in build output", () => {
		expect(existsSync(resolve(distDir, "manifest.webmanifest"))).toBe(true);
	});

	test("manifest contains required fields", () => {
		const manifestPath = resolve(distDir, "manifest.webmanifest");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

		expect(manifest.name).toBe("Rift");
		expect(manifest.short_name).toBe("Rift");
		expect(manifest.display).toBe("standalone");
		expect(manifest.theme_color).toBeDefined();
		expect(manifest.start_url).toBeDefined();
		expect(Array.isArray(manifest.icons)).toBe(true);
		expect(manifest.icons.length).toBeGreaterThan(0);
	});

	test("service worker file is generated in build output", () => {
		expect(existsSync(resolve(distDir, "sw.js"))).toBe(true);
	});

	// Chrome on Android otherwise shrinks only the visual viewport for the
	// on-screen keyboard. The full-height layout then runs on under the
	// keyboard, and Chrome pans the whole page, header and toolbar included,
	// to follow the cursor.
	test("the on-screen keyboard resizes the layout", () => {
		const html = readFileSync(resolve(distDir, "index.html"), "utf-8");
		const viewport = html.match(/<meta name="viewport" content="([^"]*)"/);
		expect(viewport?.[1]).toInclude("interactive-widget=resizes-content");
	});

	// The app is mounted under a sub-path. An install started from the wrong
	// scope, or icons resolved against the host root, fails on a phone rather
	// than at build time — so pin the base path here.
	describe("sub-path deployment", () => {
		const manifest = JSON.parse(
			readFileSync(resolve(distDir, "manifest.webmanifest"), "utf-8"),
		);

		test("manifest is scoped to the base path", () => {
			expect(manifest.start_url).toBe(BASE);
			expect(manifest.scope).toBe(BASE);
		});

		test("every icon resolves under the base path", () => {
			for (const icon of manifest.icons) {
				expect(icon.src.startsWith(BASE)).toBe(true);
			}
		});

		test("index.html references assets under the base path", () => {
			const html = readFileSync(resolve(distDir, "index.html"), "utf-8");
			const assetRefs = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map(
				(match) => match[1],
			);

			expect(assetRefs.length).toBeGreaterThan(0);
			for (const ref of assetRefs) {
				expect(ref.startsWith(BASE)).toBe(true);
			}
		});

		test("service worker registers within the base scope", () => {
			// Registration happens in the main bundle via `virtual:pwa-register`,
			// which reloads the page when an updated worker activates.
			const assetsDir = resolve(distDir, "assets");
			const main = readdirSync(assetsDir).find(
				(name) => name.startsWith("index-") && name.endsWith(".js"),
			);
			expect(main).toBeDefined();
			const bundle = readFileSync(resolve(assetsDir, main ?? ""), "utf-8");
			expect(bundle).toInclude(`${BASE}sw.js`);
			expect(bundle).toInclude(`scope:\`${BASE}\``);
			expect(bundle).toInclude("window.location.reload()");
		});

		test("main bundle listens for vite:preloadError", () => {
			const assetsDir = resolve(distDir, "assets");
			const main = readdirSync(assetsDir).find(
				(name) => name.startsWith("index-") && name.endsWith(".js"),
			);
			const bundle = readFileSync(resolve(assetsDir, main ?? ""), "utf-8");
			expect(bundle).toInclude("vite:preloadError");
		});

		test("navigation fallback points at the mounted index", () => {
			const sw = readFileSync(resolve(distDir, "sw.js"), "utf-8");
			expect(sw).toInclude(`${BASE}index.html`);
		});
	});
});
