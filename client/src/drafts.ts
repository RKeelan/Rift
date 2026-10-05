/**
 * Unsaved edits, kept per file in this browser's `localStorage` until they are
 * saved or discarded, or for a week at most. Leaving the editor by any route,
 * from a back gesture to the operating system ending the installed app, leaves
 * them to be offered back when the file reopens in the same browser. A draft
 * remembers a hash of the text it was edited from, so reopening the file can
 * tell whether the file changed underneath it.
 *
 * Writes wait for a pause in typing, and go through at once when the page is
 * hidden or the editor closes. Storage can be full, blocked, or missing, so
 * every access may fail. A failed write is reported to its caller and drops
 * the file's older draft, which would otherwise be offered back as the latest;
 * a failed read or removal leaves things as they were.
 */
export interface Draft {
	text: string;
	baseHash: string;
}

const KEY_PREFIX = "rift:draft:";
const WRITE_DELAY_MS = 500;
export const DRAFT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredDraft extends Draft {
	savedAt: number;
}

// Two tabs open on one file share its key, so the later write wins; Rift runs
// as a single-window installed app, where that does not arise.
function draftKey(repo: string, path: string): string {
	return `${KEY_PREFIX}${JSON.stringify([repo, path])}`;
}

function parseStoredDraft(stored: string | null): StoredDraft | null {
	if (!stored) return null;
	try {
		const parsed: unknown = JSON.parse(stored);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"text" in parsed &&
			typeof parsed.text === "string" &&
			"baseHash" in parsed &&
			typeof parsed.baseHash === "string" &&
			"savedAt" in parsed &&
			typeof parsed.savedAt === "number"
		) {
			return {
				text: parsed.text,
				baseHash: parsed.baseHash,
				savedAt: parsed.savedAt,
			};
		}
	} catch {
		// Malformed, so no draft.
	}
	return null;
}

function isExpired(draft: StoredDraft, now: number): boolean {
	return now - draft.savedAt > DRAFT_LIFETIME_MS;
}

export function readDraft(
	repo: string,
	path: string,
	now = Date.now(),
): Draft | null {
	try {
		const draft = parseStoredDraft(
			window.localStorage.getItem(draftKey(repo, path)),
		);
		if (!draft || isExpired(draft, now)) return null;
		return { text: draft.text, baseHash: draft.baseHash };
	} catch {
		return null;
	}
}

/**
 * Writes a draft now, reporting whether storage took it. When it does not, the
 * file's older draft no longer holds the latest edits and is dropped.
 */
export function writeDraft(
	repo: string,
	path: string,
	draft: Draft,
	now = Date.now(),
): boolean {
	const key = draftKey(repo, path);
	try {
		const stored: StoredDraft = { ...draft, savedAt: now };
		window.localStorage.setItem(key, JSON.stringify(stored));
		return true;
	} catch {
		try {
			window.localStorage.removeItem(key);
		} catch {
			// Storage that refuses writes may refuse removals too.
		}
		return false;
	}
}

interface PendingWrite {
	repo: string;
	path: string;
	draft: Draft;
	onWritten: (written: boolean) => void;
	timer: ReturnType<typeof setTimeout>;
}

const pendingWrites = new Map<string, PendingWrite>();

function flushPending(pending: PendingWrite): void {
	clearTimeout(pending.timer);
	pendingWrites.delete(draftKey(pending.repo, pending.path));
	pending.onWritten(writeDraft(pending.repo, pending.path, pending.draft));
}

function flushAllDrafts(): void {
	for (const pending of [...pendingWrites.values()]) {
		flushPending(pending);
	}
}

let flushOnHideInstalled = false;

// A hidden page may never come back, and on a phone it is often killed while
// hidden, so writes waiting for a pause go through as soon as it hides.
function installFlushOnHide(): void {
	if (flushOnHideInstalled) return;
	flushOnHideInstalled = true;
	window.addEventListener("pagehide", flushAllDrafts);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") flushAllDrafts();
	});
}

/**
 * Keeps a draft once typing pauses, replacing any write still waiting for the
 * same file. `onWritten` hears whether storage took it.
 */
export function scheduleDraft(
	repo: string,
	path: string,
	draft: Draft,
	onWritten: (written: boolean) => void,
): void {
	installFlushOnHide();
	const key = draftKey(repo, path);
	const waiting = pendingWrites.get(key);
	if (waiting) clearTimeout(waiting.timer);
	const pending: PendingWrite = {
		repo,
		path,
		draft,
		onWritten,
		timer: setTimeout(() => flushPending(pending), WRITE_DELAY_MS),
	};
	pendingWrites.set(key, pending);
}

/** Writes a file's waiting draft now, if it has one. */
export function flushDraft(repo: string, path: string): void {
	const pending = pendingWrites.get(draftKey(repo, path));
	if (pending) flushPending(pending);
}

/** Drops a file's draft, including any write still waiting for a pause. */
export function clearDraft(repo: string, path: string): void {
	const key = draftKey(repo, path);
	const pending = pendingWrites.get(key);
	if (pending) {
		clearTimeout(pending.timer);
		pendingWrites.delete(key);
	}
	try {
		window.localStorage.removeItem(key);
	} catch {
		// Nothing was kept, or nothing can be removed.
	}
}

/**
 * Drops a file's draft only if its latest text, whether waiting for a pause or
 * stored, is `text`, as when a save has just put that text on disk. A draft
 * holding anything else is of edits made since, and is left alone.
 */
export function clearDraftIfText(
	repo: string,
	path: string,
	text: string,
): void {
	const pending = pendingWrites.get(draftKey(repo, path));
	const latest = pending ? pending.draft.text : readDraft(repo, path)?.text;
	if (latest === text) clearDraft(repo, path);
}

/** Removes drafts older than their lifetime, and any that cannot be read. */
export function pruneDrafts(now = Date.now()): void {
	try {
		const storage = window.localStorage;
		const keys: string[] = [];
		for (let index = 0; index < storage.length; index += 1) {
			const key = storage.key(index);
			if (key?.startsWith(KEY_PREFIX)) keys.push(key);
		}
		for (const key of keys) {
			const draft = parseStoredDraft(storage.getItem(key));
			if (!draft || isExpired(draft, now)) storage.removeItem(key);
		}
	} catch {
		// Pruning is housekeeping; a store that cannot be read is left alone.
	}
}

/**
 * A 53-bit hash of text (cyrb53), short to store and ample for telling
 * whether a file has changed since a draft was taken from it.
 */
export function hashText(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
