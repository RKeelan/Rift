// Set Vite's BASE_URL for tests (normally injected by Vite at build time)
if (!import.meta.env.BASE_URL) {
	(import.meta.env as Record<string, string>).BASE_URL = "/";
}

import { GlobalWindow } from "happy-dom";

const window = new GlobalWindow();

const globals = [
	"document",
	"window",
	"navigator",
	"localStorage",
	"sessionStorage",
	"HTMLElement",
	"Element",
	"Node",
	"Event",
	"DocumentFragment",
	"MutationObserver",
	"SVGElement",
	"Text",
	"Comment",
	"CustomEvent",
	"HTMLInputElement",
	"HTMLButtonElement",
	"HTMLAnchorElement",
	"HTMLDivElement",
	"HTMLSpanElement",
	"HTMLFormElement",
	"HTMLTemplateElement",
	"HTMLUnknownElement",
	"getComputedStyle",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"setTimeout",
	"clearTimeout",
	"setInterval",
	"clearInterval",
	"URL",
	"URLSearchParams",
	"DOMParser",
	"MouseEvent",
	"KeyboardEvent",
	"InputEvent",
	"FocusEvent",
] as const;

for (const key of globals) {
	if (key in window) {
		(globalThis as Record<string, unknown>)[key] = (
			window as Record<string, unknown>
		)[key];
	}
}

// Add window.confirm polyfill for tests
if (!globalThis.window.confirm) {
	globalThis.window.confirm = () => true;
}
