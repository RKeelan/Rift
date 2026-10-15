import { describe, expect, test } from "bun:test";
import { KEYBOARD_MIN_HEIGHT, watchKeyboard } from "../onScreenKeyboard.ts";

// A page whose size the test sets, as Chrome on Android resizes the layout
// viewport for the keyboard and for its own toolbars.
function fakeViewport(width: number, height: number) {
	const listeners: (() => void)[] = [];
	const viewport = {
		innerWidth: width,
		innerHeight: height,
		addEventListener(_type: "resize", listener: () => void) {
			listeners.push(listener);
		},
	};
	const resize = (nextWidth: number, nextHeight: number) => {
		viewport.innerWidth = nextWidth;
		viewport.innerHeight = nextHeight;
		for (const listener of listeners) listener();
	};
	return { viewport, resize };
}

describe("watchKeyboard", () => {
	test("reads the keyboard as up while the page is shorter than at its tallest", () => {
		const { viewport, resize } = fakeViewport(448, 888);
		const keyboard = watchKeyboard(viewport);
		expect(keyboard.showing()).toBe(false);

		// Gboard on a 448px-wide phone takes 336px.
		resize(448, 552);
		expect(keyboard.showing()).toBe(true);

		resize(448, 888);
		expect(keyboard.showing()).toBe(false);
	});

	test("reads the size even when no resize has reported it", () => {
		const { viewport } = fakeViewport(448, 888);
		const keyboard = watchKeyboard(viewport);

		viewport.innerHeight = 552;
		expect(keyboard.showing()).toBe(true);
	});

	test("ignores a change smaller than any keyboard, as Chrome's address bar makes", () => {
		const { viewport, resize } = fakeViewport(448, 888);
		const keyboard = watchKeyboard(viewport);

		resize(448, 888 + 56);
		resize(448, 888);
		expect(keyboard.showing()).toBe(false);

		resize(448, 944 - KEYBOARD_MIN_HEIGHT + 1);
		expect(keyboard.showing()).toBe(false);
		resize(448, 944 - KEYBOARD_MIN_HEIGHT);
		expect(keyboard.showing()).toBe(true);
	});

	test("learns each width's height apart, as turning the phone changes both", () => {
		const { viewport, resize } = fakeViewport(448, 888);
		const keyboard = watchKeyboard(viewport);

		// Turned on its side, the page is wider and shorter, with no keyboard,
		// and Gboard takes 261px of it.
		resize(944, 340);
		expect(keyboard.showing()).toBe(false);
		resize(944, 79);
		expect(keyboard.showing()).toBe(true);

		// Turned back, the upright height still stands.
		resize(448, 552);
		expect(keyboard.showing()).toBe(true);
		resize(448, 888);
		expect(keyboard.showing()).toBe(false);
	});
});
