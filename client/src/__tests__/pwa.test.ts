import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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

	// The app is mounted under a sub-path. An install started from the wrong
	// scope, or icons resolved against the host root, fails on the phone rather
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
			const registerSW = readFileSync(
				resolve(distDir, "registerSW.js"),
				"utf-8",
			);
			expect(registerSW).toInclude(`${BASE}sw.js`);
			expect(registerSW).toInclude(`scope: '${BASE}'`);
		});

		test("navigation fallback points at the mounted index", () => {
			const sw = readFileSync(resolve(distDir, "sw.js"), "utf-8");
			expect(sw).toInclude(`${BASE}index.html`);
		});
	});
});
