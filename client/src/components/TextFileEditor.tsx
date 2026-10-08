import {
	ArrowLeft,
	ChevronDown,
	ChevronUp,
	EllipsisVertical,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { apiUrl } from "../apiUrl.ts";
import {
	applyDiff,
	type CharRange,
	getDiffOps,
	getWordChanges,
} from "../diff.ts";
import {
	clearDraft,
	clearDraftIfText,
	flushDraft,
	hashText,
	readDraft,
	scheduleDraft,
} from "../drafts.ts";
import { isChunkLoadError, reloadForStaleChunk } from "../staleChunk.ts";
import "./TextFileEditor.css";

const FILE_MTIME_HEADER = "x-file-mtime-ms";
const LINE_WRAP_STORAGE_KEY = "rift:editor-line-wrap";

function readLineWrapPreference(): boolean {
	if (typeof window === "undefined") {
		return true;
	}
	return window.localStorage.getItem(LINE_WRAP_STORAGE_KEY) !== "false";
}

// Every open editor follows the one preference, as both sides of a file are
// open at once, so a change to it reaches them all.
const lineWrapListeners = new Set<() => void>();

function subscribeToLineWrap(listener: () => void): () => void {
	lineWrapListeners.add(listener);
	return () => lineWrapListeners.delete(listener);
}

function writeLineWrapPreference(wrap: boolean): void {
	window.localStorage.setItem(LINE_WRAP_STORAGE_KEY, String(wrap));
	for (const listener of lineWrapListeners) listener();
}

/**
 * CodeMirror splits a document on `\r\n`, `\r`, or `\n` and joins it back with
 * `\n`, so its text never matches a CRLF file on disk or a CRLF git blob. Put
 * every side of a comparison in the editor's own terms before diffing them.
 */
function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/**
 * Puts git's diff in the editor's terms. Reading a file as text drops a
 * leading UTF-8 byte order mark, but git's diff arrives inside JSON and keeps
 * it, after the prefix of whichever lines stand for line 1 of either side. A
 * mark anywhere else is content, which the editor keeps too.
 */
function normalizeDiff(diff: string): string {
	let oldLineOne = false;
	let newLineOne = false;
	return normalizeLineEndings(diff)
		.split("\n")
		.map((line) => {
			const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			if (hunk) {
				oldLineOne = hunk[1] === "1";
				newLineOne = hunk[2] === "1";
				return line;
			}
			const onOld = line[0] === " " || line[0] === "-";
			const onNew = line[0] === " " || line[0] === "+";
			const isLineOne = (onOld && oldLineOne) || (onNew && newLineOne);
			if (onOld) oldLineOne = false;
			if (onNew) newLineOne = false;
			return isLineOne && line[1] === "\uFEFF"
				? `${line[0]}${line.slice(2)}`
				: line;
		})
		.join("\n");
}

/**
 * Reports the line ending a file already uses, so saving it back does not
 * rewrite every line. The first break in the file decides.
 */
function detectLineSeparator(text: string): "\r\n" | "\n" {
	return /\r\n|\n/.exec(text)?.[0] === "\r\n" ? "\r\n" : "\n";
}

type ChangeType = "added" | "modified" | "deleted" | "renamed" | "untracked";
type ChangeLineKind = "added" | "deleted";

interface ChangeLineHighlight {
	kind: ChangeLineKind;
	lineNumber: number;
}

interface DeletedLineChunk {
	anchorIndex: number;
	lines: string[];
}

interface ChangeDecorationsData {
	lineHighlights: ChangeLineHighlight[];
	deletedChunks: DeletedLineChunk[];
}

interface EditorChangeDecorations extends ChangeDecorationsData {
	/**
	 * Whether the decorations come from git's diff, which then describes
	 * exactly the change from the comparison to the buffer, so their line
	 * numbers are the ones staging acts on.
	 */
	matchesGitDiff: boolean;
}

interface EditorChangeDecorationsOptions {
	currentContent: string;
	loadedContent: string;
	comparisonContent?: string;
	changeType?: ChangeType | null;
	changeDiff?: string | null;
}

/**
 * A new file adds every one of its lines. The empty line the editor shows
 * after a final newline is not one of them, as git's diff of the file agrees.
 */
function getUntrackedChangeDecorations(content: string): ChangeDecorationsData {
	const lineCount =
		content === ""
			? 0
			: content.split("\n").length - (content.endsWith("\n") ? 1 : 0);

	return {
		lineHighlights: Array.from({ length: lineCount }, (_line, index) => ({
			kind: "added",
			lineNumber: index + 1,
		})),
		deletedChunks: [],
	};
}

/**
 * A deleted file has no working-tree content left, so the editor shows the
 * version being removed and marks every line as deleted—the mirror of how an
 * untracked file marks every line as added.
 */
function getDeletedFileDecorations(content: string): ChangeDecorationsData {
	if (!content) {
		return { lineHighlights: [], deletedChunks: [] };
	}

	return {
		lineHighlights: content.split("\n").map((_line, index) => ({
			kind: "deleted",
			lineNumber: index + 1,
		})),
		deletedChunks: [],
	};
}

function getDiffDecorations(diff: string): ChangeDecorationsData {
	const highlights = new Map<number, ChangeLineKind>();
	const deletedChunks: DeletedLineChunk[] = [];
	let nextNewLine = 0;
	let inHunk = false;
	let pendingDeletedLines: string[] = [];
	let pendingInsertedLines: string[] = [];

	function flushPendingLines() {
		if (pendingDeletedLines.length === 0 && pendingInsertedLines.length === 0) {
			return;
		}

		for (let index = 0; index < pendingInsertedLines.length; index += 1) {
			highlights.set(nextNewLine + index, "added");
		}

		if (pendingDeletedLines.length > 0) {
			deletedChunks.push({
				anchorIndex: nextNewLine - 1,
				lines: pendingDeletedLines,
			});
		}

		nextNewLine += pendingInsertedLines.length;
		pendingDeletedLines = [];
		pendingInsertedLines = [];
	}

	for (const line of diff.split("\n")) {
		if (line.startsWith("@@")) {
			flushPendingLines();
			const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
			if (!match) {
				inHunk = false;
				continue;
			}

			// A hunk with no new lines, as when a file is emptied, names the line
			// before it, so its deletions sit in front of the line after that.
			nextNewLine = Number(match[1]) + (match[2] === "0" ? 1 : 0);
			inHunk = true;
			continue;
		}

		if (!inHunk || line.startsWith("\\ No newline")) {
			continue;
		}

		// The file headers come before the first hunk, so inside one a line
		// starting "---" or "+++" is a changed line beginning with "--" or "++".
		if (line.startsWith("-")) {
			pendingDeletedLines.push(line.slice(1));
			continue;
		}

		if (line.startsWith("+")) {
			pendingInsertedLines.push(line.slice(1));
			continue;
		}

		flushPendingLines();
		nextNewLine += 1;
	}

	flushPendingLines();

	return {
		lineHighlights: [...highlights.entries()].map(([lineNumber, kind]) => ({
			lineNumber,
			kind,
		})),
		deletedChunks,
	};
}

function getChangeLineHighlights(
	content: string,
	changeType?: ChangeType | null,
	changeDiff?: string | null,
): ChangeDecorationsData {
	if (changeType === "untracked") {
		return getUntrackedChangeDecorations(content);
	}

	if (changeType === "deleted") {
		return getDeletedFileDecorations(content);
	}

	if (!changeDiff) {
		return { lineHighlights: [], deletedChunks: [] };
	}

	return getDiffDecorations(changeDiff);
}

function mergeChangeDecorations(
	...decorations: ChangeDecorationsData[]
): ChangeDecorationsData {
	const mergedLineHighlights = new Map<number, ChangeLineKind>();
	const deletedChunks: DeletedLineChunk[] = [];

	for (const decoration of decorations) {
		for (const highlight of decoration.lineHighlights) {
			mergedLineHighlights.set(highlight.lineNumber, highlight.kind);
		}
		deletedChunks.push(...decoration.deletedChunks);
	}

	return {
		lineHighlights: [...mergedLineHighlights.entries()].map(
			([lineNumber, kind]) => ({
				lineNumber,
				kind,
			}),
		),
		deletedChunks,
	};
}

function getCommonPrefixLength(a: string[], b: string[]): number {
	let index = 0;
	while (index < a.length && index < b.length && a[index] === b[index]) {
		index += 1;
	}
	return index;
}

function getCommonSuffixLength(
	a: string[],
	b: string[],
	prefixLength: number,
): number {
	let suffixLength = 0;
	while (
		suffixLength < a.length - prefixLength &&
		suffixLength < b.length - prefixLength &&
		a[a.length - 1 - suffixLength] === b[b.length - 1 - suffixLength]
	) {
		suffixLength += 1;
	}
	return suffixLength;
}

function getLiveChangeDecorations(
	originalContent: string,
	currentContent: string,
): {
	lineHighlights: ChangeLineHighlight[];
	deletedChunks: DeletedLineChunk[];
} {
	// Empty text has no lines, but split into lines it would be one empty line,
	// which could match an empty line of the buffer or show as a deleted one.
	if (originalContent === "") {
		return getUntrackedChangeDecorations(currentContent);
	}

	const originalLines = originalContent.split("\n");
	const currentLines = currentContent.split("\n");
	const prefixLength = getCommonPrefixLength(originalLines, currentLines);
	const suffixLength = getCommonSuffixLength(
		originalLines,
		currentLines,
		prefixLength,
	);

	const originalMiddle = originalLines.slice(
		prefixLength,
		originalLines.length - suffixLength,
	);
	const currentMiddle = currentLines.slice(
		prefixLength,
		currentLines.length - suffixLength,
	);

	if (originalMiddle.length === 0 && currentMiddle.length === 0) {
		return { lineHighlights: [], deletedChunks: [] };
	}

	const lineHighlights: ChangeLineHighlight[] = [];
	const deletedChunks: DeletedLineChunk[] = [];
	let currentIndex = prefixLength;

	const ops = getDiffOps(originalMiddle, currentMiddle);
	if (!ops) {
		// Too many edits to line up individually, so say only that the region
		// was replaced rather than stalling the editor on every keystroke.
		for (let index = 0; index < currentMiddle.length; index += 1) {
			lineHighlights.push({
				kind: "added",
				lineNumber: currentIndex + 1,
			});
			currentIndex += 1;
		}

		if (originalMiddle.length > 0) {
			deletedChunks.push({
				anchorIndex: prefixLength,
				lines: originalMiddle,
			});
		}

		return { lineHighlights, deletedChunks };
	}

	for (let index = 0; index < ops.length; ) {
		const op = ops[index];
		if (op.type === "equal") {
			currentIndex += 1;
			index += 1;
			continue;
		}

		// The diff can interleave a run's insertions and deletions, but git lists
		// a run's deletions first, anchored to the run's first new line, and
		// stages them with that line. Anchor them there too, so a deletion is
		// shown, picked, and staged at the same line.
		const deletedLines: string[] = [];
		const insertedLines: string[] = [];
		while (index < ops.length && ops[index].type !== "equal") {
			const { type, line } = ops[index];
			(type === "delete" ? deletedLines : insertedLines).push(line);
			index += 1;
		}

		if (deletedLines.length > 0) {
			deletedChunks.push({
				anchorIndex: currentIndex,
				lines: deletedLines,
			});
		}

		for (
			let insertIndex = 0;
			insertIndex < insertedLines.length;
			insertIndex += 1
		) {
			lineHighlights.push({
				kind: "added",
				lineNumber: currentIndex + 1,
			});
			currentIndex += 1;
		}
	}

	return { lineHighlights, deletedChunks };
}

export function getEditorChangeDecorations({
	currentContent,
	loadedContent,
	comparisonContent,
	changeType = null,
	changeDiff = null,
}: EditorChangeDecorationsOptions): EditorChangeDecorations {
	const current = normalizeLineEndings(currentContent);

	if (comparisonContent !== undefined) {
		const comparison = normalizeLineEndings(comparisonContent);
		// Staging slices git's diff, so draw git's diff whenever it describes
		// exactly the change from the comparison to the buffer. A change that
		// could sit in more than one place, such as a block deleted from between
		// two similar ones, may be placed differently by the editor's own diff,
		// and only git's placement names lines that staging acts on. The editor's
		// diff draws the rest, such as unsaved edits, but staging by line then
		// waits for git's diff to match again.
		if (changeDiff !== null) {
			const diff = normalizeDiff(changeDiff);
			if (applyDiff(comparison, diff) === current) {
				return { ...getDiffDecorations(diff), matchesGitDiff: true };
			}
		}
		return {
			...getLiveChangeDecorations(comparison, current),
			matchesGitDiff: false,
		};
	}

	if (!changeType && !changeDiff) {
		return { lineHighlights: [], deletedChunks: [], matchesGitDiff: false };
	}

	const loaded = normalizeLineEndings(loadedContent);
	return {
		...mergeChangeDecorations(
			getChangeLineHighlights(
				loaded,
				changeType,
				changeDiff === null ? null : normalizeDiff(changeDiff),
			),
			getLiveChangeDecorations(loaded, current),
		),
		matchesGitDiff: false,
	};
}

/** The changed words of each modified line, on both of its sides. */
export interface WordMarks {
	/** Each added line's changed words. */
	added: Map<number, CharRange[]>;
	/**
	 * Each deleted chunk's changed words, line by line, with null for a line
	 * that has none worth marking.
	 */
	deleted: Map<DeletedLineChunk, (CharRange[] | null)[]>;
}

/**
 * Pairs each line a change removes with the line that takes its place, and
 * marks the words that differ between the two. Only a change that adds as many
 * lines as it removes is paired, since otherwise which line replaced which is
 * a guess.
 */
export function getWordMarks(
	decorations: ChangeDecorationsData,
	lineText: (lineNumber: number) => string,
): WordMarks {
	const addedLines = new Set(
		decorations.lineHighlights
			.filter(({ kind }) => kind === "added")
			.map(({ lineNumber }) => lineNumber),
	);
	const marks: WordMarks = { added: new Map(), deleted: new Map() };
	for (const chunk of decorations.deletedChunks) {
		// A chunk's deletions sit in front of the first line its change adds.
		const first = chunk.anchorIndex + 1;
		let count = 0;
		while (addedLines.has(first + count)) count += 1;
		if (count === 0 || count !== chunk.lines.length) continue;
		marks.deleted.set(
			chunk,
			chunk.lines.map((line, index) => {
				const changes = getWordChanges(line, lineText(first + index));
				if (!changes) return null;
				marks.added.set(first + index, changes.after);
				return changes.before;
			}),
		);
	}
	return marks;
}

/** A run of changed lines, inclusive and 1-based. */
export interface ChangeRegion {
	start: number;
	end: number;
}

/**
 * Collapses the per-line change decorations into change regions, so
 * Previous/Next can jump between changes the way VS Code's diff editor does,
 * and each change can be staged whole. Adjacent changed lines (and a deletion
 * sitting against them, through the line it is anchored to) count as a single
 * region; a gap of an unchanged line starts a new one. Every line of a region
 * is a changed line or a deletion's anchor, so staging the region's lines
 * stages exactly its changes.
 */
export function getChangeRegions(
	decorations: ChangeDecorationsData,
	docLines: number,
): ChangeRegion[] {
	const markers = new Set<number>();
	for (const highlight of decorations.lineHighlights) {
		if (highlight.lineNumber >= 1 && highlight.lineNumber <= docLines) {
			markers.add(highlight.lineNumber);
		}
	}
	for (const chunk of decorations.deletedChunks) {
		markers.add(Math.min(Math.max(chunk.anchorIndex + 1, 1), docLines));
	}

	const regions: ChangeRegion[] = [];
	for (const line of [...markers].sort((left, right) => left - right)) {
		const last = regions[regions.length - 1];
		if (last && line - last.end <= 1) {
			last.end = line;
		} else {
			regions.push({ start: line, end: line });
		}
	}
	return regions;
}

/**
 * The edits that turn `previous` into `next`, one per run of changed lines and
 * addressed by offsets into `previous`. Replacing only the lines that differ,
 * rather than the whole document, lets the editor map its selection and scroll
 * position through the edit.
 */
export function getLineChanges(
	previous: string,
	next: string,
): { from: number; to: number; insert: string }[] {
	// Each line keeps its terminator, so offsets are running sums of lengths and
	// a change to the final newline is a change to the last line.
	const previousLines = previous.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const nextLines = next.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const prefixLength = getCommonPrefixLength(previousLines, nextLines);
	const suffixLength = getCommonSuffixLength(
		previousLines,
		nextLines,
		prefixLength,
	);
	const previousMiddle = previousLines.slice(
		prefixLength,
		previousLines.length - suffixLength,
	);
	const nextMiddle = nextLines.slice(
		prefixLength,
		nextLines.length - suffixLength,
	);
	// Past the diff's edit budget, replace the differing region as one block.
	const ops = getDiffOps(previousMiddle, nextMiddle) ?? [
		...previousMiddle.map((line) => ({ type: "delete" as const, line })),
		...nextMiddle.map((line) => ({ type: "insert" as const, line })),
	];

	const changes: { from: number; to: number; insert: string }[] = [];
	let offset = previousLines
		.slice(0, prefixLength)
		.reduce((total, line) => total + line.length, 0);
	for (let index = 0; index < ops.length; ) {
		if (ops[index].type === "equal") {
			offset += ops[index].line.length;
			index += 1;
			continue;
		}
		const from = offset;
		let insert = "";
		while (index < ops.length && ops[index].type !== "equal") {
			const op = ops[index];
			if (op.type === "delete") {
				offset += op.line.length;
			} else {
				insert += op.line;
			}
			index += 1;
		}
		changes.push({ from, to: offset, insert });
	}
	return changes;
}

/**
 * Turns the editor's selection into inclusive, 1-based line ranges for staging
 * when no lines are picked in the gutter. A cursor selects nothing, so moving
 * it, as Previous and Next do, never chooses lines to stage. A selection that
 * ends at the very start of a line (a full-line drag) does not claim that
 * trailing line, matching how editors show such a selection.
 */
function selectionToRanges(
	state: import("@codemirror/state").EditorState,
): [number, number][] {
	const ranges: [number, number][] = [];
	for (const range of state.selection.ranges) {
		if (range.empty) continue;
		const startLine = state.doc.lineAt(range.from).number;
		let endLine = state.doc.lineAt(range.to).number;
		if (range.to > range.from && state.doc.lineAt(range.to).from === range.to) {
			endLine = Math.max(startLine, endLine - 1);
		}
		ranges.push([startLine, endLine]);
	}
	return ranges;
}

/**
 * The editor's binding for Enter. Chrome on Android types into the editor
 * through an EditContext, which inserts nothing for Enter: CodeMirror's view
 * hands the key to the editor's bindings instead, so without one Enter does
 * nothing there. Elsewhere the browser's own line break reaches the view as a
 * change, which this matches. Markdown's binding, which continues a list or a
 * quote, runs ahead of it.
 */
const insertNewline: import("@codemirror/state").StateCommand = ({
	state,
	dispatch,
}) => {
	if (state.readOnly) return false;
	dispatch(
		state.update(state.replaceSelection(state.lineBreak), {
			scrollIntoView: true,
			userEvent: "input",
		}),
	);
	return true;
};

// A line's list and quote markup, such as `*`, `1.`, `>` or `> - [ ]`, without
// the spaces that end it.
const LINE_MARKUP = /^(?:[ \t]*(?:>|[-+*]|\d+[.)]))+(?:[ \t]+\[[ xX]\])?$/;

/**
 * Markdown's binding for Enter, which continues a list or a quote on the new
 * line. It trims the spaces before the cursor, so a line split mid-text is
 * left with no trailing space, but just after a line's markup those spaces
 * belong to the markup: Enter just after `* ` in `* text` leaves an empty `* `
 * item above `* text`, not `*`.
 */
function continueMarkup(
	insertNewlineContinueMarkup: import("@codemirror/state").StateCommand,
): import("@codemirror/state").StateCommand {
	return ({ state, dispatch }) => {
		if (state.readOnly) return false;
		const { head } = state.selection.main;
		const line = state.doc.lineAt(head);
		const before = line.text.slice(0, head - line.from);
		const spaces = /[ \t]*$/.exec(before)?.[0] ?? "";
		const from = head - spaces.length;
		if (spaces === "" || !LINE_MARKUP.test(before.slice(0, from - line.from))) {
			return insertNewlineContinueMarkup({ state, dispatch });
		}
		return insertNewlineContinueMarkup({
			state,
			dispatch: (transaction) => {
				let trimmed = false;
				transaction.changes.iterChanges((fromA, toA) => {
					if (fromA === from && toA === head) trimmed = true;
				});
				// The spaces go back after the markup, ahead of the line break.
				dispatch(
					trimmed
						? state.update(
								{
									changes: transaction.changes,
									selection: transaction.selection,
									scrollIntoView: true,
									userEvent: "input",
								},
								{ changes: { from, insert: spaces }, sequential: true },
							)
						: transaction,
				);
			},
		});
	};
}

type LanguageLoader = () => Promise<
	import("@codemirror/language").LanguageSupport
>;

function getLanguageLoader(filename: string): LanguageLoader | null {
	const ext = filename.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "js":
		case "jsx":
		case "mjs":
		case "cjs":
			return async () => {
				const { javascript } = await import("@codemirror/lang-javascript");
				return javascript({ jsx: true });
			};
		case "ts":
		case "tsx":
		case "mts":
		case "cts":
			return async () => {
				const { javascript } = await import("@codemirror/lang-javascript");
				return javascript({ jsx: true, typescript: true });
			};
		case "py":
			return async () => {
				const { python } = await import("@codemirror/lang-python");
				return python();
			};
		case "json":
			return async () => {
				const { json } = await import("@codemirror/lang-json");
				return json();
			};
		case "md":
		case "markdown":
			return async () => {
				const { insertNewlineContinueMarkupCommand, markdown } = await import(
					"@codemirror/lang-markdown"
				);
				const { LanguageSupport } = await import("@codemirror/language");
				const { Prec } = await import("@codemirror/state");
				const { keymap } = await import("@codemirror/view");
				// Markdown's own keymap also binds Backspace, to delete list and
				// quote markup a level at a time, so it is left out and Backspace
				// deletes one character, as it does everywhere else. Its Enter
				// runs ahead of the editor's own. Enter in an empty item ends the
				// list, the second item of a two-item list included, where by
				// default it would put a blank line above that item instead.
				const { language, support } = markdown({ addKeymap: false });
				return new LanguageSupport(language, [
					support,
					Prec.high(
						keymap.of([
							{
								key: "Enter",
								run: continueMarkup(
									insertNewlineContinueMarkupCommand({ nonTightLists: false }),
								),
							},
						]),
					),
				]);
			};
		case "css":
		case "scss":
			return async () => {
				const { css } = await import("@codemirror/lang-css");
				return css();
			};
		case "html":
		case "htm":
			return async () => {
				const { html } = await import("@codemirror/lang-html");
				return html();
			};
		case "rs":
			return async () => {
				const { rust } = await import("@codemirror/lang-rust");
				return rust();
			};
		case "go":
			return async () => {
				const { go } = await import("@codemirror/lang-go");
				return go();
			};
		case "sh":
		case "bash":
		case "zsh":
			return async () => {
				const { StreamLanguage } = await import("@codemirror/language");
				const { shell } = await import("@codemirror/legacy-modes/mode/shell");
				return new (await import("@codemirror/language")).LanguageSupport(
					StreamLanguage.define(shell),
				);
			};
		default:
			return null;
	}
}

function getErrorMessage(body: unknown, status: number): string {
	if (
		typeof body === "object" &&
		body !== null &&
		"error" in body &&
		typeof body.error === "object" &&
		body.error !== null &&
		"message" in body.error &&
		typeof body.error.message === "string"
	) {
		return body.error.message;
	}
	return `Request failed (${status})`;
}

/**
 * The `<from>..<to>` blob ids on a diff's `index` line, or null when it has
 * none. They name the diff, so the server can refuse to act on line numbers
 * read from a diff that has since changed.
 */
function diffBlobsOf(diff: string): string | null {
	return /^index ([0-9a-f]+\.\.[0-9a-f]+)/m.exec(diff)?.[1] ?? null;
}

function describeLineCount(count: number): string {
	return count === 1 ? "1 line" : `${count} lines`;
}

/** An action on the whole file that the page offers in the editor's bar. */
export interface FileAction {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	title?: string;
}

// Shown in place of the edit status when the server refuses changes.
export const WRITES_DISABLED_LABEL = "Read-only: writes are disabled";
// Shown in place of the edit status until the server says whether it allows
// changes, while the editor stays read-only.
export const WRITES_UNKNOWN_LABEL = "Checking write access...";

// The file a draft is kept for.
type DraftTarget = { repo: string; path: string };

/**
 * One side of a file's changes, as the status endpoint lists it. A stage or
 * unstage answers with the repo's changes as it leaves them.
 */
export interface ChangedFile {
	path: string;
	status: ChangeType;
	staged: boolean;
}

export interface TextFileEditorProps {
	filePath: string;
	repo: string;
	readOnly?: boolean;
	readOnlyLabel?: string;
	comparisonContent?: string;
	changeDiff?: string | null;
	// False when git's diff of an untracked file does not describe the file
	// exactly, as for a file that is not UTF-8, so its lines cannot be staged
	// from it.
	changeDiffExact?: boolean;
	changeType?: ChangeType | null;
	// When set, the editor loads the file's staged (index) content instead of the
	// working tree and presents it read-only, so a staged change can be viewed and
	// unstaged line by line. Lines are picked through the gutter, as they are when
	// staging, so the DOM is non-editable and viewing never raises the keyboard.
	staged?: boolean;
	// When set, the file has been deleted, so there is no working-tree content to
	// edit. The editor loads the version being removed—the index blob for an
	// unstaged deletion, the HEAD blob for a staged one—and shows it read-only with
	// every line struck through. Staging or unstaging the deletion is whole-file and
	// handled by the page's file action, so this mode exposes no edit controls.
	deleted?: boolean;
	// Changing it reloads the file, as when the index changes under a staged
	// view from elsewhere.
	reloadKey?: number;
	onSaved?: () => void;
	// Called with the repo's changes once a stage or unstage has made them.
	onStaged?: (files: ChangedFile[]) => void;
	// Called in place of onStaged when the editor stages an untracked file
	// whole, so the page can treat it as it does its own action on the file.
	onFileStaged?: (files: ChangedFile[]) => void;
	onUnstaged?: (files: ChangedFile[]) => void;
	// Called when the user reloads the file, so the page can refetch the change
	// context that git's line numbers come from along with it.
	onReload?: () => void;
	// Reports whether the buffer holds unsaved edits, so the page can ask before
	// leaving the file or acting on it from outside the editor.
	onDirtyChange?: (dirty: boolean) => void;
	// The page's action on the whole file, such as staging it, offered in the
	// bar when no lines are picked or selected.
	fileAction?: FileAction;
	// Leaves the file, from the button at the start of the bar, which
	// backLabel names.
	onBack?: () => void;
	backLabel?: string;
	// The file's other side, which a tap on the file's name in the bar
	// switches to: its staged changes from its unstaged ones, or back. The
	// name is greyed out while that side has nothing to show. A file of a
	// directory without git has no sides, so its bar names none and has no
	// buttons to move between changes.
	otherSide?: { available: boolean; show: () => void };
}

export function TextFileEditor({
	filePath,
	repo,
	readOnly = false,
	readOnlyLabel = "Read-only",
	comparisonContent,
	changeDiff = null,
	changeDiffExact = true,
	changeType = null,
	staged = false,
	deleted = false,
	reloadKey = 0,
	onSaved,
	onStaged,
	onFileStaged,
	onUnstaged,
	onReload,
	onDirtyChange,
	fileAction,
	onBack,
	backLabel = "Back",
	otherSide,
}: TextFileEditorProps) {
	const editorRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<import("@codemirror/view").EditorView | null>(null);
	const refreshDecorationsRef = useRef<(() => void) | null>(null);
	const applyLineWrapRef = useRef<((wrap: boolean) => void) | null>(null);
	const scrollToLineRef = useRef<((lineNumber: number) => void) | null>(null);
	const replaceDocRef = useRef<((text: string) => void) | null>(null);
	// Undo and Redo in the menu reach the editor's history through this, and
	// are greyed out while it holds nothing to undo or redo.
	const historyCommandsRef = useRef<{
		undo: () => void;
		redo: () => void;
	} | null>(null);
	const [canUndo, setCanUndo] = useState(false);
	const [canRedo, setCanRedo] = useState(false);
	const originalContentRef = useRef("");
	const lineSeparatorRef = useRef<"\r\n" | "\n">("\n");
	// Anchor lines of the current change regions and the last one we jumped to,
	// so Previous/Next can cycle through them and wrap around.
	const changeRegionsRef = useRef<number[]>([]);
	const changeCountRef = useRef(0);
	const lastNavLineRef = useRef(0);
	const [changeCount, setChangeCount] = useState(0);
	// Whether the editor view is built.
	const [editorReady, setEditorReady] = useState(false);
	// Whether this view has been moved to the file's first change yet.
	const openedAtChangeRef = useRef(false);
	const [content, setContent] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [staging, setStaging] = useState(false);
	const [unstaging, setUnstaging] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [mtimeMs, setMtimeMs] = useState<number | null>(null);
	const [reloadToken, setReloadToken] = useState(0);
	const lineWrap = useSyncExternalStore(
		subscribeToLineWrap,
		readLineWrapPreference,
	);
	const lineWrapRef = useRef(lineWrap);
	// The buffer's latest text, so an editor rebuilt for any reason starts from
	// it rather than from text that a save or an edit has since replaced.
	const docTextRef = useRef("");
	// Unsaved edits to the working tree are kept as a draft, so that leaving the
	// editor by any route does not lose them. The draft is written once typing
	// pauses and cleared on save or discard, and reopening the file offers it
	// back. Until that offer is answered the buffer is read-only and the draft
	// is left alone, so a stray keystroke cannot replace it.
	const draftsEnabled = !readOnly && !staged && !deleted;
	const draftsEnabledRef = useRef(draftsEnabled);
	// The file whose text the buffer holds, set once it has loaded, so that
	// edits are only ever kept under the name of the file they were made to.
	const loadedFileRef = useRef<DraftTarget | null>(null);
	// Counts the loads that replace the buffer, and the editor closing, so a
	// save answered after either can tell that the buffer it saved is gone.
	const loadCountRef = useRef(0);
	// Where the buffer's edits are kept: the loaded file, while drafts are on.
	const draftTargetRef = useRef<DraftTarget | null>(null);
	// A hash of the text the buffer's edits start from: the file as loaded or
	// last saved.
	const baseHashRef = useRef("");
	type DraftOffer = { text: string; fileChanged: boolean };
	const [draftOffer, setDraftOffer] = useState<DraftOffer | null>(null);
	const draftOfferRef = useRef<DraftOffer | null>(null);
	const applyDraftLockRef = useRef<((locked: boolean) => void) | null>(null);
	const [draftNotKept, setDraftNotKept] = useState(false);

	const offerDraft = useCallback((offer: DraftOffer | null) => {
		draftOfferRef.current = offer;
		setDraftOffer(offer);
		applyDraftLockRef.current?.(offer !== null);
	}, []);

	// Offers back a draft left from an earlier visit, saying so if the file has
	// changed since it was taken. A buffer with edits of its own already holds
	// its draft, and a draft of exactly the file holds no edits.
	const offerStoredDraft = useCallback(() => {
		const target = draftTargetRef.current;
		if (
			!target ||
			draftOfferRef.current !== null ||
			docTextRef.current !== originalContentRef.current
		) {
			return;
		}
		const draft = readDraft(target.repo, target.path);
		if (!draft) return;
		if (draft.text === docTextRef.current) {
			clearDraft(target.repo, target.path);
			return;
		}
		offerDraft({
			text: draft.text,
			fileChanged: draft.baseHash !== baseHashRef.current,
		});
	}, [offerDraft]);

	// Keeps the buffer's text as the file's draft once typing pauses.
	const keepDraft = useCallback((target: DraftTarget, text: string) => {
		scheduleDraft(
			target.repo,
			target.path,
			{ text, baseHash: baseHashRef.current },
			(kept) => {
				const current = draftTargetRef.current;
				if (current?.repo === target.repo && current.path === target.path) {
					setDraftNotKept(!kept);
				}
			},
		);
	}, []);

	useEffect(() => {
		if (!draftsEnabled) return;
		// Leaving the file writes a draft still waiting for a pause.
		return () => flushDraft(repo, filePath);
	}, [draftsEnabled, repo, filePath]);

	// A save answered after the editor closes finds its buffer gone, as after a
	// load. The file may be open in another editor by then, with a draft of its
	// own.
	useEffect(
		() => () => {
			loadCountRef.current += 1;
		},
		[],
	);

	// The change context is refetched independently of the buffer, as after a
	// stage or a save. The editor reads it through this ref and redraws its
	// decorations in place, keeping the buffer, its selection, and its scroll
	// position. An untracked file's inexact diff names no lines that staging
	// could act on, so its lines are marked from its content instead.
	const decoratedDiff =
		changeType === "untracked" && !changeDiffExact ? null : changeDiff;
	const changeContextRef = useRef({
		comparisonContent,
		changeDiff: decoratedDiff,
		changeType,
	});

	// Set when the editor itself has just changed what git's diff should say, by
	// saving or by unstaging in place, and cleared when the page hands it the
	// refetched context. Until then the old diff is known to be out of date, not
	// evidence of a change on disk.
	const [contextStale, setContextStale] = useState(false);

	useEffect(() => {
		changeContextRef.current = {
			comparisonContent,
			changeDiff: decoratedDiff,
			changeType,
		};
		refreshDecorationsRef.current?.();
		setContextStale(false);
	}, [comparisonContent, decoratedDiff, changeType]);

	// An inexact diff is handed over too, though it draws nothing.
	useEffect(() => {
		if (changeDiff !== null) setContextStale(false);
	}, [changeDiff]);

	// An untracked file stages by line only when git's diff of it describes the
	// file exactly as loaded. Otherwise, as when the file is not UTF-8, a clean
	// filter changes it, its lines end in bare carriage returns, or its diff was
	// cut short, it stages whole, as untracked files did before they could stage
	// by line. The answer holds while the buffer is edited, so typing neither
	// adds the gutter nor takes it away.
	const [untrackedWhole, setUntrackedWhole] = useState(false);
	useEffect(() => {
		if (
			changeType !== "untracked" ||
			content === null ||
			changeDiff === null ||
			contextStale
		) {
			return;
		}
		setUntrackedWhole(
			!changeDiffExact ||
				applyDiff("", normalizeDiff(changeDiff)) !== originalContentRef.current,
		);
	}, [changeType, content, changeDiff, changeDiffExact, contextStale]);

	// Picked lines live in the CodeMirror state; this reaches them from the
	// action bar, and the count labels the Stage and Unstage buttons.
	const pickerRef = useRef<{
		ranges: () => [number, number][] | null;
		// The blob ids of the git diff that picks and selections currently name
		// lines of, or null while git's diff does not describe the buffer.
		diffBlobs: () => string | null;
		clear: () => void;
		// Drops the picks within a change that has just been staged whole.
		unpick: (region: ChangeRegion) => void;
	} | null>(null);
	const [pickedCount, setPickedCount] = useState(0);
	// Without picks, Stage and Unstage act on a selection, offered only when it
	// covers a change: the server ignores lines that hold none.
	const [selectionCoversChange, setSelectionCoversChange] = useState(false);

	// A deleted file has no lines left to pick, so it stages and unstages whole.
	// Every other change stages and unstages by line, a new file through its
	// diff against nothing, unless that diff cannot be staged from.
	const byLine =
		changeType !== "deleted" && !(changeType === "untracked" && untrackedWhole);
	// Picks and selections name lines of the change git reports, so acting on
	// them waits until both the comparison and git's diff have arrived, and
	// then until git's diff describes the buffer as shown. A clean buffer that
	// git's diff does not describe was overtaken by a change on disk, and
	// staging its lines would act on whichever lines now sit there.
	const changeContextLoading =
		comparisonContent === undefined || changeDiff === null || contextStale;
	const matchesGitDiffRef = useRef(false);
	const [matchesGitDiff, setMatchesGitDiff] = useState(false);
	const byLineReady = !changeContextLoading && matchesGitDiff;
	// While a draft from earlier waits for an answer the buffer is locked, and
	// nothing acts on its lines: restoring the draft would replace them.
	const draftOfferPending = draftOffer !== null;
	// Picking lines only makes sense where a Stage or Unstage acts on them.
	const linePickingEnabled =
		!readOnly &&
		!deleted &&
		!draftOfferPending &&
		byLine &&
		(staged ? onUnstaged !== undefined : onStaged !== undefined);
	// A file changed on disk since it loaded is the usual cause, but not the
	// only one: a truncated diff or a clean filter can keep the two apart for
	// good, so the notice offers the whole file as well as a reload. An
	// untracked file in that state stages whole instead, with no notice.
	const gitDiffMismatch =
		linePickingEnabled &&
		changeType !== "untracked" &&
		!dirty &&
		!changeContextLoading &&
		!matchesGitDiff;
	const linePickingEnabledRef = useRef(linePickingEnabled);
	const applyLinePickingRef = useRef<((enabled: boolean) => void) | null>(null);

	useEffect(() => {
		linePickingEnabledRef.current = linePickingEnabled;
		applyLinePickingRef.current?.(linePickingEnabled);
	}, [linePickingEnabled]);

	// Each change gets a strip above it whose button stages or unstages that
	// change alone. The strips are drawn by the editor, and reach the page's
	// state through these refs.
	const runRegionActionRef = useRef<((region: ChangeRegion) => void) | null>(
		null,
	);
	const stripsEnabledRef = useRef(false);
	const applyStripsEnabledRef = useRef<((enabled: boolean) => void) | null>(
		null,
	);

	useEffect(() => {
		let active = true;
		const controller = new AbortController();

		setLoading(true);
		setError(null);
		setContent(null);
		setDirty(false);
		setMtimeMs(null);
		originalContentRef.current = "";
		changeRegionsRef.current = [];
		changeCountRef.current = 0;
		lastNavLineRef.current = 0;
		setChangeCount(0);
		matchesGitDiffRef.current = false;
		setMatchesGitDiff(false);
		setUntrackedWhole(false);
		offerDraft(null);
		setDraftNotKept(false);
		loadCountRef.current += 1;
		loadedFileRef.current = null;
		draftTargetRef.current = null;

		(async () => {
			try {
				// A deleted file has no working tree to read, so it opens against the
				// version being removed: base-content returns the index blob when the
				// deletion is unstaged (staged=false) and the HEAD blob when it is
				// staged (staged=true). A staged change opens against its index blob
				// (`git show :path`), exposed by base-content with staged=false, so the
				// lines the user selects match what `git diff --cached` reports for
				// unstaging.
				const reload = `${reloadToken}.${reloadKey}`;
				const contentUrl = deleted
					? apiUrl(
							`/api/git/base-content?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(filePath)}&staged=${staged}&_reload=${reload}`,
						)
					: staged
						? apiUrl(
								`/api/git/base-content?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(filePath)}&staged=false&_reload=${reload}`,
							)
						: apiUrl(
								`/api/files/content?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(filePath)}&_reload=${reload}`,
							);
				const response = await fetch(contentUrl, {
					signal: controller.signal,
				});

				if (!response.ok) {
					const body = await response.json().catch(() => null);
					throw new Error(getErrorMessage(body, response.status));
				}

				const text = await response.text();
				const nextMtimeMs = Number(response.headers.get(FILE_MTIME_HEADER));
				if (!active) return;
				const normalized = normalizeLineEndings(text);
				lineSeparatorRef.current = detectLineSeparator(text);
				originalContentRef.current = normalized;
				docTextRef.current = normalized;
				baseHashRef.current = hashText(normalized);
				loadedFileRef.current = { repo, path: filePath };
				draftTargetRef.current = draftsEnabledRef.current
					? loadedFileRef.current
					: null;
				setContent(normalized);
				setMtimeMs(Number.isFinite(nextMtimeMs) ? nextMtimeMs : null);
				offerStoredDraft();
			} catch (err) {
				if (err instanceof DOMException && err.name === "AbortError") return;
				if (active) {
					setError(err instanceof Error ? err.message : "Failed to load file");
				}
			} finally {
				if (active) {
					setLoading(false);
				}
			}
		})();

		return () => {
			active = false;
			controller.abort();
		};
	}, [
		filePath,
		repo,
		reloadToken,
		reloadKey,
		staged,
		deleted,
		offerDraft,
		offerStoredDraft,
	]);

	// Runs after the load above, so a change that also reloads the file, such
	// as moving between the staged and working views, finds no loaded file to
	// offer a draft for.
	useEffect(() => {
		draftsEnabledRef.current = draftsEnabled;
		draftTargetRef.current = draftsEnabled ? loadedFileRef.current : null;
		if (draftsEnabled) {
			// Writes allowed only after the file loaded, as when the server's
			// answer arrives late, still bring the offer.
			offerStoredDraft();
		} else {
			// A view that cannot be edited has no draft to offer. Any draft stays
			// stored for when the file can be edited again.
			offerDraft(null);
			setDraftNotKept(false);
		}
	}, [draftsEnabled, offerDraft, offerStoredDraft]);

	useEffect(() => {
		if (content === null || !editorRef.current) return;

		let destroyed = false;
		let stopFollowingResize = () => {};
		setEditorReady(false);
		openedAtChangeRef.current = false;

		(async () => {
			const { Compartment, EditorState, StateEffect, StateField, Transaction } =
				await import("@codemirror/state");
			const {
				Decoration,
				EditorView,
				WidgetType,
				keymap,
				lineNumbers,
				drawSelection,
				highlightActiveLine,
			} = await import("@codemirror/view");
			const { HighlightStyle, syntaxHighlighting } = await import(
				"@codemirror/language"
			);
			const { history, historyKeymap, redo, redoDepth, undo, undoDepth } =
				await import("@codemirror/commands");
			const { tags: t } = await import("@lezer/highlight");
			const {
				clearPickedLines,
				countPickedLines,
				deletionAnchorLine,
				getPickTargets,
				linePickerGutter,
				livePickedLines,
				pickedLines,
				pickedLinesToRanges,
				rangesCoverTarget,
				togglePickedLine,
			} = await import("./linePicking.ts");

			if (destroyed || !editorRef.current) return;

			const refreshChangeDecorations = StateEffect.define<void>();
			const setStripsEnabled = StateEffect.define<boolean>();
			const stripsEnabled = StateField.define<boolean>({
				create: () => stripsEnabledRef.current,
				update(value, transaction) {
					for (const effect of transaction.effects) {
						if (effect.is(setStripsEnabled)) value = effect.value;
					}
					return value;
				},
			});

			class ChangeStripWidget extends WidgetType {
				constructor(
					readonly region: ChangeRegion,
					readonly enabled: boolean,
				) {
					super();
				}

				override eq(other: ChangeStripWidget) {
					return (
						other.region.start === this.region.start &&
						other.region.end === this.region.end &&
						other.enabled === this.enabled
					);
				}

				override get estimatedHeight() {
					return 48;
				}

				override toDOM(view: import("@codemirror/view").EditorView) {
					const strip = document.createElement("div");
					strip.className = "cm-changeStrip";
					// Swallowing the press keeps the cursor where it was. Chrome on
					// Android raises the keyboard on any tap while the editor has
					// focus, so the press also takes focus from the editor: staging a
					// change is not typing.
					strip.addEventListener("mousedown", (event) => {
						event.preventDefault();
						view.contentDOM.blur();
					});
					const label = document.createElement("span");
					label.className = "cm-changeStripLabel";
					const button = document.createElement("button");
					button.type = "button";
					button.className = "cm-changeStripButton";
					button.textContent = staged ? "Unstage" : "Stage";
					// The strip is redrawn in place as its change moves or its button
					// is enabled, so the button reads its change from the strip. It
					// is marked disabled rather than made so, because a disabled
					// control drops the press before the strip can swallow it.
					button.addEventListener("click", () => {
						if (button.getAttribute("aria-disabled") === "true") return;
						// Only a strip placed by git's diff names lines staging acts on.
						if (!view.state.field(changeField).changes.matchesGitDiff) return;
						runRegionActionRef.current?.({
							start: Number(strip.dataset.start),
							end: Number(strip.dataset.end),
						});
					});
					strip.append(label, button);
					this.updateDOM(strip);
					return strip;
				}

				override updateDOM(strip: HTMLElement) {
					const label = strip.querySelector(".cm-changeStripLabel");
					const button = strip.querySelector("button");
					if (!label || !button) return false;
					const { start, end } = this.region;
					strip.dataset.start = String(start);
					strip.dataset.end = String(end);
					label.textContent = `Line ${start}`;
					button.setAttribute(
						"aria-label",
						`${staged ? "Unstage" : "Stage"} the change at line ${start}`,
					);
					button.setAttribute("aria-disabled", String(!this.enabled));
					return true;
				}
			}

			class DeletedLinesWidget extends WidgetType {
				constructor(
					readonly lines: string[],
					readonly anchorLine: number,
					readonly picked: boolean,
					readonly marks: (CharRange[] | null)[] | undefined,
				) {
					super();
				}

				override eq(other: DeletedLinesWidget) {
					return (
						other.lines === this.lines &&
						other.anchorLine === this.anchorLine &&
						other.picked === this.picked &&
						other.marks === this.marks
					);
				}

				override toDOM() {
					const wrapper = document.createElement("div");
					wrapper.className = `cm-deletedChunk${
						this.picked ? " cm-deletedChunk--picked" : ""
					}`;
					this.lines.forEach((line, index) => {
						const lineElement = document.createElement("div");
						lineElement.className = "cm-deletedChunkLine";
						let offset = 0;
						for (const [from, to] of this.marks?.[index] ?? []) {
							const word = document.createElement("span");
							word.className = "cm-changedWord";
							word.textContent = line.slice(from, to);
							lineElement.append(line.slice(offset, from), word);
							offset = to;
						}
						lineElement.append(line.slice(offset));
						wrapper.append(lineElement);
					});
					return wrapper;
				}
			}

			// Diffing the document is the expensive part, so it runs only when the
			// document or the change context changes; picking a line re-renders the
			// decorations alone.
			function computeChanges(doc: import("@codemirror/state").Text) {
				const { comparisonContent, changeDiff, changeType } =
					changeContextRef.current;
				const changes = getEditorChangeDecorations({
					currentContent: doc.toString(),
					// The file as last loaded or saved, which is what git's diff describes.
					loadedContent: originalContentRef.current,
					comparisonContent,
					changeType,
					changeDiff,
				});
				changes.lineHighlights.sort(
					(left, right) => left.lineNumber - right.lineNumber,
				);

				const regions = getChangeRegions(changes, doc.lines);
				changeRegionsRef.current = regions.map(({ start }) => start);
				if (changeRegionsRef.current.length !== changeCountRef.current) {
					changeCountRef.current = changeRegionsRef.current.length;
					setChangeCount(changeRegionsRef.current.length);
				}
				if (changes.matchesGitDiff !== matchesGitDiffRef.current) {
					matchesGitDiffRef.current = changes.matchesGitDiff;
					setMatchesGitDiff(changes.matchesGitDiff);
				}

				return {
					changes,
					wordMarks: getWordMarks(changes, (lineNumber) =>
						lineNumber >= 1 && lineNumber <= doc.lines
							? doc.line(lineNumber).text
							: "",
					),
					// The changes that get a strip, which only git's diff can place.
					strips: changes.matchesGitDiff ? regions : [],
					targets: getPickTargets(changes, doc.lines),
					// The blob ids of the git diff these targets were read from, kept
					// beside them so a stage or unstage names the diff whose line
					// numbers it sends, not one that has arrived since.
					diffBlobs:
						changes.matchesGitDiff && changeDiff !== null
							? diffBlobsOf(changeDiff)
							: null,
				};
			}

			function buildChangeDecorations(
				doc: import("@codemirror/state").Text,
				changes: ReturnType<typeof getEditorChangeDecorations>,
				wordMarks: WordMarks,
				picked: ReadonlySet<number>,
			) {
				const ranges = [];
				const changedWord = Decoration.mark({ class: "cm-changedWord" });
				for (const { kind, lineNumber } of changes.lineHighlights) {
					if (lineNumber < 1 || lineNumber > doc.lines) {
						continue;
					}
					const line = doc.line(lineNumber);
					const pickedClass =
						kind === "added" && picked.has(lineNumber) ? " cm-pickedLine" : "";
					ranges.push(
						Decoration.line({
							attributes: {
								class: `cm-changedLine cm-changedLine--${kind}${pickedClass}`,
							},
						}).range(line.from),
					);
					for (const [from, to] of wordMarks.added.get(lineNumber) ?? []) {
						if (to <= line.length) {
							ranges.push(changedWord.range(line.from + from, line.from + to));
						}
					}
				}

				for (const chunk of changes.deletedChunks) {
					const anchor =
						chunk.anchorIndex >= doc.lines
							? doc.length
							: doc.line(chunk.anchorIndex + 1).from;
					const anchorLine = deletionAnchorLine(chunk, doc.lines);
					ranges.push(
						Decoration.widget({
							block: true,
							side: -1,
							widget: new DeletedLinesWidget(
								chunk.lines,
								anchorLine,
								picked.has(anchorLine),
								wordMarks.deleted.get(chunk),
							),
						}).range(anchor),
					);
				}

				return Decoration.set(
					ranges.sort((left, right) => left.from - right.from),
					true,
				);
			}

			function buildChangeStrips(
				state: import("@codemirror/state").EditorState,
			) {
				const { strips } = state.field(changeField);
				const enabled = state.field(stripsEnabled);
				return Decoration.set(
					strips.map((region) =>
						Decoration.widget({
							block: true,
							// Above the deleted lines that share the region's first line.
							side: -2,
							widget: new ChangeStripWidget(region, enabled),
						}).range(state.doc.line(region.start).from),
					),
					true,
				);
			}

			// Moves the strips through an edit, so each stays above the text it
			// stood over.
			function mapStrips(
				strips: ChangeRegion[],
				transaction: import("@codemirror/state").Transaction,
			): ChangeRegion[] {
				if (!transaction.docChanged) return strips;
				const lineAfter = (line: number) =>
					transaction.state.doc.lineAt(
						transaction.changes.mapPos(
							transaction.startState.doc.line(line).from,
						),
					).number;
				return strips.map(({ start, end }) => {
					const mappedStart = lineAfter(start);
					return {
						start: mappedStart,
						end: Math.max(mappedStart, lineAfter(end)),
					};
				});
			}

			const changeField = StateField.define({
				create(state) {
					return computeChanges(state.doc);
				},
				update(value, transaction) {
					if (
						!transaction.docChanged &&
						!transaction.effects.some((effect) =>
							effect.is(refreshChangeDecorations),
						)
					) {
						return value;
					}
					const next = computeChanges(transaction.state.doc);
					if (next.changes.matchesGitDiff) return next;
					// While git's diff does not describe the buffer, as during unsaved
					// edits or while the context is refetched after a stage, the
					// strips stay where they were, disabled. Adding or removing them
					// would move the text below them, including the line being typed.
					return { ...next, strips: mapStrips(value.strips, transaction) };
				},
			});

			const pickerGutter = linePickerGutter({
				targets: (state) => state.field(changeField).targets,
				// The targets only name lines that staging acts on once git's diff
				// describes the buffer, which also means the change context has loaded.
				canPick: (state) => state.field(changeField).changes.matchesGitDiff,
				widgetAnchor: (widget) =>
					widget instanceof DeletedLinesWidget ? widget.anchorLine : null,
			});
			// Picking lines and staging a change whole are offered together, since
			// both need a Stage or Unstage that acts by line.
			const lineActions = [
				pickerGutter,
				EditorView.decorations.compute([changeField, stripsEnabled], (state) =>
					buildChangeStrips(state),
				),
			];

			const riftHighlightStyle = HighlightStyle.define([
				{
					tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword],
					color: "var(--editor-syntax-keyword)",
					fontWeight: "600",
				},
				{
					tag: [t.typeName, t.className, t.namespace],
					color: "var(--editor-syntax-type)",
				},
				{
					tag: [t.function(t.variableName), t.function(t.propertyName)],
					color: "var(--editor-syntax-function)",
				},
				{
					tag: [t.variableName, t.propertyName, t.attributeName],
					color: "var(--editor-syntax-variable)",
				},
				{
					tag: [t.string, t.special(t.string), t.regexp],
					color: "var(--editor-syntax-string)",
				},
				{
					tag: [t.number, t.integer, t.float, t.bool, t.null],
					color: "var(--editor-syntax-number)",
				},
				{
					tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
					color: "var(--editor-syntax-comment)",
					fontStyle: "italic",
				},
				{
					tag: [t.operator, t.punctuation, t.separator, t.bracket],
					color: "var(--editor-syntax-operator)",
				},
				{
					tag: [t.meta, t.annotation, t.processingInstruction],
					color: "var(--editor-syntax-meta)",
				},
				{
					tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4],
					color: "var(--editor-syntax-heading)",
					fontWeight: "700",
				},
				{
					tag: [t.link, t.url],
					color: "var(--editor-syntax-link)",
					textDecoration: "underline",
				},
			]);

			const lineWrapCompartment = new Compartment();
			const linePickingCompartment = new Compartment();
			const draftLockCompartment = new Compartment();
			const languageCompartment = new Compartment();
			const draftLock = [
				EditorView.editable.of(false),
				EditorState.readOnly.of(true),
			];
			const baseExtensions = [
				draftLockCompartment.of(draftOfferRef.current ? draftLock : []),
				keymap.of([{ key: "Enter", run: insertNewline }]),
				lineNumbers(),
				linePickingCompartment.of(
					linePickingEnabledRef.current ? lineActions : [],
				),
				drawSelection(),
				highlightActiveLine(),
				lineWrapCompartment.of(
					lineWrapRef.current ? EditorView.lineWrapping : [],
				),
				syntaxHighlighting(riftHighlightStyle),
				changeField,
				pickedLines,
				stripsEnabled,
				EditorView.decorations.compute([changeField, pickedLines], (state) =>
					buildChangeDecorations(
						state.doc,
						state.field(changeField).changes,
						state.field(changeField).wordMarks,
						state.field(pickedLines),
					),
				),
				EditorView.updateListener.of((update) => {
					if (!update.docChanged) return;
					docTextRef.current = update.state.doc.toString();
					const nowDirty = docTextRef.current !== originalContentRef.current;
					setDirty(nowDirty);
					setError(null);
					const target = draftTargetRef.current;
					// An older draft waiting for an answer is left untouched.
					if (target && draftOfferRef.current === null) {
						if (nowDirty) {
							keepDraft(target, docTextRef.current);
						} else {
							clearDraft(target.repo, target.path);
							setDraftNotKept(false);
						}
					}
				}),
				EditorView.updateListener.of((update) => {
					const picks = update.state.field(pickedLines);
					const { targets } = update.state.field(changeField);
					const targetsChanged =
						targets !== update.startState.field(changeField).targets;
					if (
						picks !== update.startState.field(pickedLines) ||
						targetsChanged
					) {
						setPickedCount(countPickedLines(picks, targets));
					}
					if (update.selectionSet || targetsChanged) {
						setSelectionCoversChange(
							rangesCoverTarget(selectionToRanges(update.state), targets),
						);
					}
				}),
				// An answer that hasn't changed re-renders nothing, so typing
				// re-renders only when Undo or Redo turns on or off.
				EditorView.updateListener.of((update) => {
					if (update.transactions.length === 0) return;
					setCanUndo(undoDepth(update.state) > 0);
					setCanRedo(redoDepth(update.state) > 0);
				}),
				languageCompartment.of([]),
				EditorView.theme({
					"&": {
						// Material's body text size for Android.
						fontSize: "16px",
						height: "100%",
						color: "var(--color-text)",
						backgroundColor: "var(--color-bg)",
					},
					".cm-scroller": {
						overflow: "auto",
						// 24px lines, so each tap target in the line-picking gutter
						// is 24px tall.
						lineHeight: "1.5",
						fontFamily:
							"'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace",
					},
					".cm-content": {
						caretColor: "var(--color-primary)",
					},
					".cm-cursor, .cm-dropCursor": {
						borderLeftColor: "var(--color-primary)",
					},
					".cm-selectionBackground, .cm-content ::selection": {
						backgroundColor: "rgba(110, 168, 254, 0.28)",
					},
					".cm-activeLine": {
						backgroundColor: "rgba(255, 255, 255, 0.04)",
					},
					".cm-gutters": {
						color: "var(--color-text-muted)",
						backgroundColor: "var(--color-surface)",
						borderRight: "1px solid var(--color-border)",
					},
					".cm-activeLineGutter": {
						backgroundColor: "var(--color-surface-raised)",
						color: "var(--color-text)",
					},
					".cm-lineNumbers .cm-gutterElement": {
						padding: "0 0.625rem 0 0.5rem",
					},
				}),
			];

			if (readOnly || deleted || staged) {
				// Nothing here is edited in place: a deleted file has no working tree,
				// and staged content is the index blob, whose lines are picked through
				// the gutter. Keep the DOM non-editable to spare mobile the pop-up
				// keyboard.
				baseExtensions.unshift(
					EditorView.editable.of(false),
					EditorState.readOnly.of(true),
				);
			} else {
				// Every load builds a new editor, so text that comes from disk is
				// never a step that can be undone, and neither is anything typed
				// before it.
				baseExtensions.push(
					history(),
					keymap.of([
						// historyKeymap binds Mod-Shift-z on macOS and Ctrl-Shift-z on
						// Linux, Android included, but neither on Windows. This one,
						// ahead of it, redoes on every platform.
						{ key: "Mod-Shift-z", run: redo, preventDefault: true },
						...historyKeymap,
					]),
				);
			}

			const state = EditorState.create({
				doc: docTextRef.current,
				extensions: baseExtensions,
			});
			const view = new EditorView({
				state,
				parent: editorRef.current,
			});
			viewRef.current = view;
			// Chrome on Android shrinks the layout for the on-screen keyboard,
			// which can leave the cursor's line under the bar. An editor with
			// focus that shrinks brings the cursor back into view, as typing
			// there would.
			let scrollerHeight = view.scrollDOM.clientHeight;
			const followResize = () => {
				const height = view.scrollDOM.clientHeight;
				if (height < scrollerHeight && view.hasFocus) {
					view.dispatch({
						effects: EditorView.scrollIntoView(view.state.selection.main.head),
					});
				}
				scrollerHeight = height;
			};
			window.addEventListener("resize", followResize);
			stopFollowingResize = () =>
				window.removeEventListener("resize", followResize);
			refreshDecorationsRef.current = () => {
				view.dispatch({ effects: refreshChangeDecorations.of() });
			};
			pickerRef.current = {
				ranges: () => {
					const live = livePickedLines(
						view.state.field(pickedLines),
						view.state.field(changeField).targets,
					);
					return live.length > 0 ? pickedLinesToRanges(live) : null;
				},
				diffBlobs: () => view.state.field(changeField).diffBlobs,
				clear: () => {
					view.dispatch({ effects: clearPickedLines.of(null) });
				},
				unpick: ({ start, end }) => {
					const within = [...view.state.field(pickedLines)].filter(
						(line) => line >= start && line <= end,
					);
					if (within.length > 0) {
						view.dispatch({
							effects: within.map((line) => togglePickedLine.of(line)),
						});
					}
				},
			};
			applyDraftLockRef.current = (locked: boolean) => {
				view.dispatch({
					effects: draftLockCompartment.reconfigure(locked ? draftLock : []),
				});
			};
			applyLineWrapRef.current = (wrap: boolean) => {
				view.dispatch({
					effects: lineWrapCompartment.reconfigure(
						wrap ? EditorView.lineWrapping : [],
					),
				});
			};
			applyLinePickingRef.current = (enabled: boolean) => {
				view.dispatch({
					effects: linePickingCompartment.reconfigure(
						enabled ? lineActions : [],
					),
				});
			};
			applyStripsEnabledRef.current = (enabled: boolean) => {
				view.dispatch({ effects: setStripsEnabled.of(enabled) });
			};
			scrollToLineRef.current = (lineNumber: number) => {
				const clamped = Math.min(Math.max(lineNumber, 1), view.state.doc.lines);
				const pos = view.state.doc.line(clamped).from;
				// Move the selection (without stealing focus, which would pop up the
				// mobile keyboard) so the active-line highlight marks the change, then
				// centre it in the viewport.
				view.dispatch({
					selection: { anchor: pos },
					effects: EditorView.scrollIntoView(pos, { y: "center" }),
				});
			};
			// Text put in place of the buffer's, a restored draft or the index
			// after an unstage, is where the history starts, as a loaded file is,
			// so Undo cannot go back past it. Nothing comes before it: a draft is
			// offered only for a buffer without edits, which stays locked until
			// the offer is answered, and a staged view keeps no history.
			replaceDocRef.current = (text: string) => {
				view.dispatch({
					changes: getLineChanges(view.state.doc.toString(), text),
					annotations: Transaction.addToHistory.of(false),
				});
			};
			historyCommandsRef.current = {
				undo: () => undo(view),
				redo: () => redo(view),
			};
			setEditorReady(true);

			const loader = getLanguageLoader(filePath);
			if (loader) {
				try {
					const langSupport = await loader();
					if (destroyed || viewRef.current !== view) return;
					// Added in place, so whatever was typed, picked or set while it
					// loaded is kept, the history included.
					view.dispatch({
						effects: languageCompartment.reconfigure(langSupport),
					});
				} catch {
					// Plain text is fine if language support fails.
				}
			}
		})().catch((cause: unknown) => {
			// CodeMirror arrives through dynamic imports, so a chunk that fails
			// to load leaves an empty pane with nothing to explain it. Say so
			// rather than rendering nothing.
			if (destroyed) return;
			// Chunks without dependencies bypass Vite's preload helper, so a
			// stale build surfaces here rather than as `vite:preloadError`.
			if (isChunkLoadError(cause) && reloadForStaleChunk()) return;
			const detail = cause instanceof Error ? `: ${cause.message}` : "";
			setError(`Failed to load the editor${detail}`);
		});

		return () => {
			destroyed = true;
			stopFollowingResize();
			setEditorReady(false);
			refreshDecorationsRef.current = null;
			applyLineWrapRef.current = null;
			applyLinePickingRef.current = null;
			applyStripsEnabledRef.current = null;
			applyDraftLockRef.current = null;
			scrollToLineRef.current = null;
			replaceDocRef.current = null;
			historyCommandsRef.current = null;
			pickerRef.current = null;
			setPickedCount(0);
			setSelectionCoversChange(false);
			setCanUndo(false);
			setCanRedo(false);
			if (viewRef.current) {
				viewRef.current.destroy();
				viewRef.current = null;
			}
		};
		// The change context is deliberately absent: it reaches the editor through
		// changeContextRef, and a change to it redraws the decorations in place.
	}, [content, filePath, readOnly, staged, deleted, keepDraft]);

	useEffect(() => {
		lineWrapRef.current = lineWrap;
		applyLineWrapRef.current?.(lineWrap);
	}, [lineWrap]);

	const toggleLineWrap = useCallback(() => {
		writeLineWrapPreference(!readLineWrapPreference());
	}, []);

	// The menu of less frequent actions closes on any tap outside it.
	const menuRef = useRef<HTMLDivElement>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	useEffect(() => {
		if (!menuOpen) return;
		function closeOutside(event: PointerEvent) {
			if (!menuRef.current?.contains(event.target as Node)) {
				setMenuOpen(false);
			}
		}
		document.addEventListener("pointerdown", closeOutside);
		return () => document.removeEventListener("pointerdown", closeOutside);
	}, [menuOpen]);

	// A file opens at its first change rather than at its top, once the view is
	// built and the change context has placed the changes. A reader who has
	// already moved the cursor or scrolled is left where they are.
	useEffect(() => {
		const view = viewRef.current;
		if (!editorReady || changeCount === 0 || !view) return;
		if (openedAtChangeRef.current) return;
		openedAtChangeRef.current = true;
		if (view.state.selection.main.head !== 0 || view.scrollDOM.scrollTop > 0) {
			return;
		}
		const first = changeRegionsRef.current[0];
		if (first === undefined) return;
		lastNavLineRef.current = first;
		scrollToLineRef.current?.(first);
	}, [editorReady, changeCount]);

	const goToChange = useCallback((direction: 1 | -1) => {
		const regions = changeRegionsRef.current;
		if (regions.length === 0) return;

		const reference = lastNavLineRef.current;
		let target: number;
		if (direction === 1) {
			target = regions.find((line) => line > reference) ?? regions[0];
		} else {
			target = regions[regions.length - 1];
			for (const line of regions) {
				if (line >= reference) break;
				target = line;
			}
		}

		lastNavLineRef.current = target;
		scrollToLineRef.current?.(target);
	}, []);

	useEffect(() => {
		if (!dirty) return;

		function handleBeforeUnload(event: BeforeUnloadEvent) {
			event.preventDefault();
			event.returnValue = "";
		}

		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => {
			window.removeEventListener("beforeunload", handleBeforeUnload);
		};
	}, [dirty]);

	const onDirtyChangeRef = useRef(onDirtyChange);
	useEffect(() => {
		onDirtyChangeRef.current = onDirtyChange;
	}, [onDirtyChange]);
	useEffect(() => {
		onDirtyChangeRef.current?.(dirty);
	}, [dirty]);
	// An editor that is gone holds no edits.
	useEffect(() => () => onDirtyChangeRef.current?.(false), []);

	const handleReload = useCallback(() => {
		if (dirty && !window.confirm("Discard unsaved changes?")) {
			return;
		}
		if (dirty && draftTargetRef.current) {
			clearDraft(draftTargetRef.current.repo, draftTargetRef.current.path);
		}
		setReloadToken((value) => value + 1);
		onReload?.();
	}, [dirty, onReload]);

	const restoreDraft = useCallback(() => {
		const replaceDoc = replaceDocRef.current;
		const offer = draftOfferRef.current;
		if (!replaceDoc || !offer) return;
		// Answering the offer unlocks the buffer first, so the restored text is
		// kept as this file's draft like any other edit. Only the lines that
		// differ are replaced, so the selection and scroll position carry through.
		offerDraft(null);
		replaceDoc(offer.text);
	}, [offerDraft]);

	const discardDraft = useCallback(() => {
		if (draftTargetRef.current) {
			clearDraft(draftTargetRef.current.repo, draftTargetRef.current.path);
		}
		offerDraft(null);
	}, [offerDraft]);

	const handleSave = useCallback(async () => {
		if (readOnly || staged || !viewRef.current || mtimeMs === null) return;
		// The file being saved and the load its buffer came from, since another
		// load, of another file or of this one again, can start before the
		// server answers.
		const target = draftTargetRef.current;
		const load = loadCountRef.current;

		setSaving(true);
		setError(null);

		try {
			const nextContent = viewRef.current.state.doc.toString();
			const separator = lineSeparatorRef.current;
			const response = await fetch(
				apiUrl(
					`/api/files/content?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(filePath)}`,
				),
				{
					method: "PUT",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						content:
							separator === "\n"
								? nextContent
								: nextContent.replaceAll("\n", separator),
						expectedMtimeMs: mtimeMs,
					}),
				},
			);

			if (!response.ok) {
				const body = await response.json().catch(() => null);
				throw new Error(getErrorMessage(body, response.status));
			}

			const body = (await response.json()) as { mtimeMs?: number };
			if (loadCountRef.current !== load) {
				// The buffer was loaded afresh, or the editor closed, while the save
				// was in flight, so nothing below describes what is open now, and
				// the save keeps no draft. The saved file's draft is dropped only if
				// its latest text is just what was saved; any other draft holds
				// edits made since, in this editor or another.
				if (target) {
					clearDraftIfText(target.repo, target.path, nextContent);
				}
				onSaved?.();
				return;
			}
			originalContentRef.current = nextContent;
			setContextStale(true);
			baseHashRef.current = hashText(nextContent);
			// Edits made while the save was in flight are not on disk, so they
			// stay unsaved, kept as a draft of the text just saved.
			const stillDirty = docTextRef.current !== nextContent;
			if (target && stillDirty) {
				keepDraft(target, docTextRef.current);
			} else if (target) {
				clearDraft(target.repo, target.path);
			}
			if (!stillDirty) setDraftNotKept(false);
			setDirty(stillDirty);
			refreshDecorationsRef.current?.();
			if (typeof body.mtimeMs === "number" && Number.isFinite(body.mtimeMs)) {
				setMtimeMs(body.mtimeMs);
			}
			onSaved?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save file");
		} finally {
			setSaving(false);
		}
	}, [filePath, keepDraft, mtimeMs, onSaved, readOnly, repo, staged]);

	// Stages the given change whole, or else the picked or selected lines, or
	// given "file", an untracked file whole.
	const handleStage = useCallback(
		async (target?: ChangeRegion | "file") => {
			const wholeFile = target === "file";
			const region = wholeFile ? undefined : target;
			if (
				readOnly ||
				!viewRef.current ||
				dirty ||
				draftOfferRef.current !== null ||
				(wholeFile ? changeType !== "untracked" : !byLine)
			) {
				return;
			}

			setStaging(true);
			setError(null);

			try {
				const body: {
					path: string;
					ranges?: [number, number][];
					expectedBlobs?: string;
					expectedMtimeMs?: number;
					untracked?: boolean;
				} = {
					path: filePath,
				};
				// A change stages exactly the change's lines, or the picked ones, or
				// the selected ones when nothing is picked. Each way it names the git
				// diff those line numbers come from, so the server refuses rather
				// than staging whatever lines now sit at them; an untracked file's
				// come from its diff against nothing, which the server reads in its
				// place. An untracked file staged whole names the version on screen
				// by its modification time instead, so it stages whether or not its
				// diff has arrived, or describes the buffer.
				if (wholeFile) {
					if (mtimeMs !== null) {
						body.expectedMtimeMs = mtimeMs;
					}
				} else {
					body.ranges = region
						? [[region.start, region.end]]
						: (pickerRef.current?.ranges() ??
							selectionToRanges(viewRef.current.state));
					if (body.ranges.length === 0) return;
					const blobs = pickerRef.current?.diffBlobs() ?? null;
					if (blobs !== null) {
						body.expectedBlobs = blobs;
					}
					if (changeType === "untracked") {
						body.untracked = true;
					}
				}

				const response = await fetch(
					apiUrl(`/api/git/stage?repo=${encodeURIComponent(repo)}`),
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					},
				);

				if (response.status === 409) {
					throw new Error(
						"The file changed since it was loaded. Reload before staging.",
					);
				}
				if (!response.ok) {
					const errorBody = await response.json().catch(() => null);
					throw new Error(getErrorMessage(errorBody, response.status));
				}
				const { files } = (await response.json()) as { files: ChangedFile[] };

				// Staging leaves the buffer as it was, so picks in other changes
				// still name their lines, and a change staged whole drops only its
				// own.
				if (region) {
					pickerRef.current?.unpick(region);
				} else {
					pickerRef.current?.clear();
				}
				if (wholeFile && onFileStaged) {
					onFileStaged(files);
				} else {
					onStaged?.(files);
				}
			} catch (err) {
				setError(
					err instanceof Error ? err.message : "Failed to stage changes",
				);
			} finally {
				setStaging(false);
			}
		},
		[
			byLine,
			changeType,
			dirty,
			filePath,
			mtimeMs,
			onFileStaged,
			onStaged,
			readOnly,
			repo,
		],
	);

	// Unstages the given change whole, or else the picked or selected lines.
	const handleUnstage = useCallback(
		async (region?: ChangeRegion) => {
			// A file that unstages whole has no changes to unstage on their own.
			if (!staged || !viewRef.current || !byLine) return;

			setUnstaging(true);
			setError(null);

			try {
				// A staged change unstages exactly the change's lines, or the picked
				// ones, or the selected ones when nothing is picked, and names the
				// staged diff those line numbers come from, as staging does.
				const body: {
					path: string;
					ranges: [number, number][];
					expectedBlobs?: string;
				} = {
					path: filePath,
					ranges: region
						? [[region.start, region.end]]
						: (pickerRef.current?.ranges() ??
							selectionToRanges(viewRef.current.state)),
				};
				if (body.ranges.length === 0) return;
				const blobs = pickerRef.current?.diffBlobs() ?? null;
				if (blobs !== null) {
					body.expectedBlobs = blobs;
				}

				const response = await fetch(
					apiUrl(`/api/git/unstage?repo=${encodeURIComponent(repo)}`),
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					},
				);

				if (response.status === 409) {
					throw new Error(
						"The staged change is different now. Reload before unstaging.",
					);
				}
				if (!response.ok) {
					const errorBody = await response.json().catch(() => null);
					throw new Error(getErrorMessage(errorBody, response.status));
				}
				const { files } = (await response.json()) as { files: ChangedFile[] };

				pickerRef.current?.clear();
				// The index just changed, so bring the buffer up to the new staged
				// content; the decorations then shrink to whatever remains staged.
				// Editing the buffer in place keeps the editor's selection and scroll
				// position, which reloading would reset to the top of the file.
				const refreshed = await fetch(
					apiUrl(
						`/api/git/base-content?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(filePath)}&staged=false&_reload=${Date.now()}`,
					),
				).catch(() => null);
				// A new file unstaged in full has left the index, which then holds
				// nothing of it.
				const text = refreshed?.ok
					? await refreshed.text()
					: refreshed?.status === 404
						? ""
						: null;
				if (text !== null && replaceDocRef.current) {
					const normalized = normalizeLineEndings(text);
					lineSeparatorRef.current = detectLineSeparator(text);
					originalContentRef.current = normalized;
					setContextStale(true);
					replaceDocRef.current(normalized);
				} else {
					setReloadToken((value) => value + 1);
				}
				onUnstaged?.(files);
			} catch (err) {
				setError(
					err instanceof Error ? err.message : "Failed to unstage changes",
				);
			} finally {
				setUnstaging(false);
			}
		},
		[byLine, filePath, onUnstaged, repo, staged],
	);

	// The editor stages or unstages picked or selected lines, and each change
	// whole, itself. The page's file action covers the whole file; without one,
	// the editor stages an untracked file whole itself.
	const lineActionAvailable =
		!readOnly &&
		byLine &&
		(staged ? onUnstaged !== undefined : !deleted && onStaged !== undefined);
	const lineActionBusy = staged ? unstaging : staging;
	const lineActionDisabled =
		loading ||
		saving ||
		lineActionBusy ||
		dirty ||
		draftOfferPending ||
		!byLineReady;
	const runLineAction = () => {
		void (staged ? handleUnstage() : handleStage());
	};
	useEffect(() => {
		runRegionActionRef.current = (region) => {
			void (staged ? handleUnstage(region) : handleStage(region));
		};
	}, [handleStage, handleUnstage, staged]);
	// A change's strip acts when the action bar's line action would.
	useEffect(() => {
		stripsEnabledRef.current = !lineActionDisabled;
		applyStripsEnabledRef.current?.(!lineActionDisabled);
	}, [lineActionDisabled]);
	const lineActionLabel = (lines: string) =>
		lineActionBusy
			? staged
				? "Unstaging..."
				: "Staging..."
			: `${staged ? "Unstage" : "Stage"} ${lines}`;
	// An untracked file stages whole through the editor itself when the page
	// offers no action on the whole file.
	const wholeFileAction: FileAction | undefined =
		fileAction ??
		(!staged && !deleted && onStaged && changeType === "untracked"
			? {
					label: staging ? "Staging..." : "Stage file",
					onClick: () => {
						void handleStage("file");
					},
					// An empty file marks no lines, but still stages.
					disabled:
						readOnly ||
						loading ||
						saving ||
						staging ||
						dirty ||
						draftOfferPending,
				}
			: undefined);
	// The page's action on the whole file waits on the editor too, as the
	// editor's own actions do.
	const fileActionBlocked =
		loading || saving || staging || unstaging || draftOfferPending;
	const editable = !readOnly && !staged && !deleted;
	const showPicks = lineActionAvailable && !dirty && pickedCount > 0;
	const showSelection =
		lineActionAvailable && !dirty && pickedCount === 0 && selectionCoversChange;
	const barStatus = readOnly
		? readOnlyLabel
		: deleted
			? "Deleted file"
			: dirty
				? "Unsaved changes"
				: null;
	const mismatchTitle = gitDiffMismatch
		? "Git's diff doesn't match this file"
		: undefined;
	// The bar's main action: Save while there are unsaved edits, Stage or
	// Unstage for the picked lines or else a selection that covers a change,
	// and otherwise the action on the whole file. The working tree offers Save
	// greyed out when there is nothing else, and a side without even that keeps
	// the action's place empty.
	const mainAction: FileAction | null =
		dirty && editable
			? {
					label: saving ? "Saving..." : "Save",
					onClick: () => {
						void handleSave();
					},
					disabled: loading || saving || mtimeMs === null,
				}
			: showPicks || showSelection
				? {
						label: lineActionLabel(
							showPicks ? describeLineCount(pickedCount) : "selection",
						),
						onClick: runLineAction,
						disabled: lineActionDisabled,
						title: mismatchTitle,
					}
				: wholeFileAction
					? {
							...wholeFileAction,
							disabled: wholeFileAction.disabled || fileActionBlocked,
						}
					: !staged && !deleted
						? { label: "Save", onClick: () => {}, disabled: true }
						: null;
	// Nothing in the bar moves sideways: the name takes whatever room is left,
	// and the main action keeps one width whatever it says. A control that
	// does not apply is greyed out, and marked rather than made disabled, so a
	// tap on it still takes focus from the editor instead of raising the
	// keyboard.
	const fileName = filePath.slice(filePath.lastIndexOf("/") + 1);

	return (
		<div className="text-file-editor">
			{loading && <div className="text-file-editor-message">Loading...</div>}
			{error && <div className="text-file-editor-error">{error}</div>}
			{draftNotKept && (
				<div className="text-file-editor-notice">
					This browser couldn't keep a copy of your unsaved edits, so save
					before leaving the file.
				</div>
			)}
			{draftOffer && (
				<div className="text-file-editor-notice text-file-editor-notice--draft">
					<span className="text-file-editor-notice-text">
						{draftOffer.fileChanged
							? "Unsaved edits from earlier are kept for this file, but the file has changed since. Restoring puts your edited version in place of the current one."
							: "Unsaved edits from earlier are kept for this file. Restore or discard them to keep editing."}
					</span>
					<button
						type="button"
						className="text-file-editor-button text-file-editor-button--primary"
						onClick={restoreDraft}
					>
						Restore
					</button>
					<button
						type="button"
						className="text-file-editor-button"
						onClick={discardDraft}
					>
						Discard
					</button>
				</div>
			)}
			{gitDiffMismatch && (
				<div className="text-file-editor-notice">
					{staged
						? "Git's diff doesn't match this file. Reload, or unstage the whole file."
						: "Git's diff doesn't match this file. Reload, or stage the whole file."}
				</div>
			)}
			{content !== null && (
				<div
					ref={editorRef}
					className={`text-file-editor-surface${
						lineWrap ? " text-file-editor-surface--wrap" : ""
					}`}
				/>
			)}
			<div className="text-file-editor-bar">
				{onBack && (
					<button
						type="button"
						className="text-file-editor-bar-button text-file-editor-back"
						onClick={onBack}
						aria-label={backLabel}
						title={backLabel}
					>
						<ArrowLeft size={22} aria-hidden="true" />
					</button>
				)}
				{otherSide ? (
					<button
						type="button"
						className="text-file-editor-name"
						onClick={() => {
							if (otherSide.available) otherSide.show();
						}}
						aria-disabled={!otherSide.available}
					>
						<span className="text-file-editor-name-file">{fileName}</span>
						<span className="text-file-editor-name-side">
							{staged ? "Staged" : "Unstaged"}
							<span className="text-file-editor-status">{barStatus}</span>
						</span>
					</button>
				) : (
					<span className="text-file-editor-name">
						<span className="text-file-editor-name-file">{fileName}</span>
					</span>
				)}
				{otherSide && (
					<>
						<button
							type="button"
							className="text-file-editor-bar-button"
							onClick={() => {
								if (changeCount > 0) goToChange(-1);
							}}
							aria-disabled={changeCount === 0}
							aria-label="Previous change"
							title="Previous change"
						>
							<ChevronUp size={22} aria-hidden="true" />
						</button>
						<button
							type="button"
							className="text-file-editor-bar-button"
							onClick={() => {
								if (changeCount > 0) goToChange(1);
							}}
							aria-disabled={changeCount === 0}
							aria-label="Next change"
							title="Next change"
						>
							<ChevronDown size={22} aria-hidden="true" />
						</button>
					</>
				)}
				{mainAction ? (
					<button
						type="button"
						className="text-file-editor-action"
						onClick={() => {
							if (!mainAction.disabled) mainAction.onClick();
						}}
						aria-disabled={Boolean(mainAction.disabled)}
						title={mainAction.title}
					>
						{mainAction.label}
					</button>
				) : (
					<span className="text-file-editor-action text-file-editor-action--empty" />
				)}
				<div className="text-file-editor-menu" ref={menuRef}>
					<button
						type="button"
						className="text-file-editor-bar-button"
						onClick={() => setMenuOpen((open) => !open)}
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						aria-label="More actions"
						title="More actions"
					>
						<EllipsisVertical size={22} aria-hidden="true" />
					</button>
					{menuOpen && (
						<div className="text-file-editor-menu-list" role="menu">
							<button
								type="button"
								role="menuitem"
								className="text-file-editor-menu-item"
								disabled={!canUndo}
								onClick={() => {
									setMenuOpen(false);
									historyCommandsRef.current?.undo();
								}}
							>
								Undo
							</button>
							<button
								type="button"
								role="menuitem"
								className="text-file-editor-menu-item"
								disabled={!canRedo}
								onClick={() => {
									setMenuOpen(false);
									historyCommandsRef.current?.redo();
								}}
							>
								Redo
							</button>
							<button
								type="button"
								role="menuitemcheckbox"
								aria-checked={lineWrap}
								className="text-file-editor-menu-item"
								onClick={() => {
									setMenuOpen(false);
									toggleLineWrap();
								}}
							>
								Wrap lines
							</button>
							<button
								type="button"
								role="menuitem"
								className="text-file-editor-menu-item"
								disabled={loading || saving}
								onClick={() => {
									setMenuOpen(false);
									handleReload();
								}}
							>
								Reload
							</button>
							{lineActionAvailable && (
								<button
									type="button"
									role="menuitem"
									className="text-file-editor-menu-item"
									disabled={pickedCount === 0}
									onClick={() => {
										setMenuOpen(false);
										pickerRef.current?.clear();
									}}
								>
									Clear picks
								</button>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
