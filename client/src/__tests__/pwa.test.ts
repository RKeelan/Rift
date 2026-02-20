import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const distDir = resolve(import.meta.dir, "../../dist");

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
});
