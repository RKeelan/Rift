import { GlobalWindow } from "happy-dom";

const window = new GlobalWindow();

const globals = [
	"document",
	"window",
	"navigator",
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
