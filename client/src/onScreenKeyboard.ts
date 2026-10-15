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

/** The parts of an editor view that a press on one of its controls needs. */
interface Editor {
	readonly hasFocus: boolean;
	readonly contentDOM: HTMLElement;
}

/**
 * Whether a press on a control in or beside the editor keeps focus in the
 * editor, which leaves the on-screen keyboard as it was. Chrome on Android
 * lowers the keyboard when the editor loses focus, and raises it on any tap
 * while the editor has focus. So while the keyboard is up, the press keeps
 * focus in the editor, with the cursor where it was for typing to carry on,
 * and while it is down, the press takes focus from the editor.
 */
export function pressKeepsEditorFocus(
	editor: Pick<Editor, "hasFocus">,
): boolean {
	return editor.hasFocus && onScreenKeyboardShowing();
}

/**
 * Handles a press on a tap target inside the editor, such as a change's strip
 * or a line's pick target. Swallowing the press keeps the cursor where it was
 * and starts no text selection, and the editor keeps or loses focus as
 * `pressKeepsEditorFocus` decides.
 */
export function swallowPressInEditor(editor: Editor, event: Event): void {
	event.preventDefault();
	if (!pressKeepsEditorFocus(editor)) editor.contentDOM.blur();
}
