import { beforeEach, describe, expect, test } from "bun:test";
import {
	clearDraft,
	clearDraftIfText,
	DRAFT_LIFETIME_MS,
	pruneDrafts,
	readDraft,
	scheduleDraft,
	writeDraft,
} from "../drafts.ts";

const draft = { text: "edited\n", baseHash: "abc" };

function pause(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
	globalThis.localStorage.clear();
});

describe("drafts", () => {
	test("are kept in local storage, which outlives the session", () => {
		expect(writeDraft("repo", "a.txt", draft)).toBe(true);

		expect(readDraft("repo", "a.txt")).toEqual(draft);
		expect(
			Object.keys(globalThis.localStorage).some((key) =>
				key.startsWith("rift:draft:"),
			),
		).toBe(true);
	});

	test("are kept apart by repo and path", () => {
		writeDraft("repo", "a.txt", draft);

		expect(readDraft("repo", "b.txt")).toBeNull();
		expect(readDraft("other", "a.txt")).toBeNull();
	});

	test("expire after a week", () => {
		const savedAt = 1_000_000;
		writeDraft("repo", "a.txt", draft, savedAt);

		expect(readDraft("repo", "a.txt", savedAt + DRAFT_LIFETIME_MS)).toEqual(
			draft,
		);
		expect(
			readDraft("repo", "a.txt", savedAt + DRAFT_LIFETIME_MS + 1),
		).toBeNull();
	});

	test("are pruned once expired or unreadable, leaving the rest alone", () => {
		const now = 10 * DRAFT_LIFETIME_MS;
		writeDraft("repo", "fresh.txt", draft, now - 1000);
		writeDraft("repo", "stale.txt", draft, now - DRAFT_LIFETIME_MS - 1);
		globalThis.localStorage.setItem("rift:draft:garbled", "{not json");
		globalThis.localStorage.setItem("rift:editor-line-wrap", "false");

		pruneDrafts(now);

		expect(readDraft("repo", "fresh.txt", now)).toEqual(draft);
		expect(globalThis.localStorage.getItem("rift:draft:garbled")).toBeNull();
		expect(
			Object.keys(globalThis.localStorage).filter((key) =>
				key.startsWith("rift:draft:"),
			).length,
		).toBe(1);
		expect(globalThis.localStorage.getItem("rift:editor-line-wrap")).toBe(
			"false",
		);
	});

	test("are written once typing pauses, keeping only the latest", async () => {
		const outcomes: boolean[] = [];
		scheduleDraft("repo", "a.txt", { ...draft, text: "one" }, (kept) =>
			outcomes.push(kept),
		);
		scheduleDraft("repo", "a.txt", { ...draft, text: "two" }, (kept) =>
			outcomes.push(kept),
		);

		expect(readDraft("repo", "a.txt")).toBeNull();
		await pause(650);

		expect(readDraft("repo", "a.txt")?.text).toBe("two");
		expect(outcomes).toEqual([true]);
	});

	test("are not written once cleared, even if a write was waiting", async () => {
		scheduleDraft("repo", "a.txt", draft, () => {});

		clearDraft("repo", "a.txt");
		await pause(650);

		expect(readDraft("repo", "a.txt")).toBeNull();
	});

	test("are cleared by text only when the latest, waiting or stored, matches", async () => {
		writeDraft("repo", "a.txt", { ...draft, text: "one" });
		scheduleDraft("repo", "a.txt", { ...draft, text: "two" }, () => {});

		// The stored draft matches, but the waiting one is later.
		clearDraftIfText("repo", "a.txt", "one");
		await pause(650);
		expect(readDraft("repo", "a.txt")?.text).toBe("two");

		clearDraftIfText("repo", "a.txt", "three");
		expect(readDraft("repo", "a.txt")?.text).toBe("two");

		scheduleDraft("repo", "a.txt", { ...draft, text: "three" }, () => {});
		clearDraftIfText("repo", "a.txt", "three");
		await pause(650);
		expect(readDraft("repo", "a.txt")).toBeNull();
	});

	test("are dropped when a later one cannot be written, rather than offered as the latest", () => {
		const items = new Map<string, string>();
		let full = false;
		const store = {
			get length() {
				return items.size;
			},
			key: (index: number) => [...items.keys()][index] ?? null,
			getItem: (key: string) => items.get(key) ?? null,
			removeItem: (key: string) => {
				items.delete(key);
			},
			setItem: (key: string, value: string) => {
				if (full) {
					throw new DOMException("Storage is full", "QuotaExceededError");
				}
				items.set(key, value);
			},
		};
		const original = Object.getOwnPropertyDescriptor(window, "localStorage");
		Object.defineProperty(window, "localStorage", {
			configurable: true,
			value: store,
		});
		try {
			writeDraft("repo", "a.txt", draft);
			full = true;

			expect(writeDraft("repo", "a.txt", { ...draft, text: "later" })).toBe(
				false,
			);
			expect(readDraft("repo", "a.txt")).toBeNull();
		} finally {
			if (original) {
				Object.defineProperty(window, "localStorage", original);
			} else {
				delete (window as { localStorage?: Storage }).localStorage;
			}
		}
	});
});
