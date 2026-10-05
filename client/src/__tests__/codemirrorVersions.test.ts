import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readManifest(path: string) {
	return JSON.parse(readFileSync(resolve(import.meta.dir, path), "utf-8"));
}

// The root manifest overrides CodeMirror's core packages so that the language
// packages share the client's copy: without it, a bump to the client's pins
// leaves them on the old version, and two copies of @codemirror/state break the
// editor. The override decides what is installed, so a pin it disagrees with
// never takes effect. Dependabot bumps the pins but not the overrides.
test("the CodeMirror overrides match the client's pins", () => {
	const overrides: Record<string, string> = readManifest(
		"../../../package.json",
	).overrides;
	const pins: Record<string, string> =
		readManifest("../../package.json").dependencies;

	for (const [name, version] of Object.entries(overrides)) {
		expect(`${name}@${version}`).toBe(`${name}@${pins[name]}`);
	}
});
