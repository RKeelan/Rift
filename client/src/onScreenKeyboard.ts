/**
 * Chrome on Android tells a page nothing directly about its on-screen
 * keyboard, but under `interactive-widget=resizes-content` the keyboard takes
 * its height out of the layout viewport. While it shows, the page is shorter
 * than it is at the same width without it, by more than any toolbar Chrome
 * shows or hides.
 */

// Less than any docked keyboard, which is at least a row of suggestions and
// four rows of keys, and more than Chrome's address bar.
export const KEYBOARD_MIN_HEIGHT = 120;

interface Viewport {
	readonly innerWidth: number;
	readonly innerHeight: number;
	addEventListener(type: "resize", listener: () => void): void;
}

export interface KeyboardWatch {
	/** Whether the on-screen keyboard is up, judged from the page's height. */
	showing(): boolean;
}

export function watchKeyboard(viewport: Viewport): KeyboardWatch {
	// The tallest the page has been at each width, which is its height without
	// the keyboard: the page is laid out before the keyboard can rise. Turning
	// the phone brings a new width, whose height is learnt afresh, so a phone
	// turned with the keyboard up reads it as down until it first goes down.
	const tallest = new Map<number, number>();
	const shortfall = () => {
		const { innerWidth: width, innerHeight: height } = viewport;
		const most = Math.max(tallest.get(width) ?? 0, height);
		tallest.set(width, most);
		return most - height;
	};
	shortfall();
	viewport.addEventListener("resize", shortfall);
	return { showing: () => shortfall() >= KEYBOARD_MIN_HEIGHT };
}

// Watched from the start, so the page's height without the keyboard is known
// before anything can raise it.
const pageKeyboard =
	typeof window === "undefined" ? null : watchKeyboard(window);

/** Whether the on-screen keyboard is up. */
export function onScreenKeyboardShowing(): boolean {
	return pageKeyboard?.showing() ?? false;
}
