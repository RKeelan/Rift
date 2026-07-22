import { ChevronDown, ChevronUp, WrapText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "../apiUrl.ts";
import { getDiffOps } from "../diff.ts";
import "./TextFileEditor.css";

const FILE_MTIME_HEADER = "x-file-mtime-ms";
const LINE_WRAP_STORAGE_KEY = "rift:editor-line-wrap";

function readLineWrapPreference(): boolean {
	if (typeof window === "undefined") {
		return true;
	}
	return window.localStorage.getItem(LINE_WRAP_STORAGE_KEY) !== "false";
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
 * Reports the line ending a file already uses, so saving it back does not
 * rewrite every line. The first break in the file decides.
 */
function detectLineSeparator(text: string): "\r\n" | "\n" {
	return /\r\n|\n/.exec(text)?.[0] === "\r\n" ? "\r\n" : "\n";
}

type ChangeType = "added" | "modified" | "deleted" | "renamed" | "untracked";
type ChangeLineKind = "added";

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

interface EditorChangeDecorationsOptions {
	currentContent: string;
	loadedContent: string;
	comparisonContent?: string;
	changeType?: ChangeType | null;
	changeDiff?: string | null;
}

function getUntrackedChangeDecorations(content: string): ChangeDecorationsData {
	if (!content) {
		return { lineHighlights: [], deletedChunks: [] };
	}

	return {
		lineHighlights: content.split("\n").map((_line, index) => ({
			kind: "added",
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
			const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			if (!match) {
				inHunk = false;
				continue;
			}

			nextNewLine = Number(match[1]);
			inHunk = true;
			continue;
		}

		if (!inHunk || line.startsWith("\\ No newline")) {
			continue;
		}

		if (line.startsWith("-") && !line.startsWith("---")) {
			pendingDeletedLines.push(line.slice(1));
			continue;
		}

		if (line.startsWith("+") && !line.startsWith("+++")) {
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

		const deletedLines: string[] = [];
		while (index < ops.length && ops[index].type === "delete") {
			deletedLines.push(ops[index].line);
			index += 1;
		}

		const insertedLines: string[] = [];
		while (index < ops.length && ops[index].type === "insert") {
			insertedLines.push(ops[index].line);
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
}: EditorChangeDecorationsOptions): ChangeDecorationsData {
	const current = normalizeLineEndings(currentContent);

	if (comparisonContent !== undefined) {
		return getLiveChangeDecorations(
			normalizeLineEndings(comparisonContent),
			current,
		);
	}

	if (!changeType && !changeDiff) {
		return { lineHighlights: [], deletedChunks: [] };
	}

	const loaded = normalizeLineEndings(loadedContent);
	return mergeChangeDecorations(
		getChangeLineHighlights(
			loaded,
			changeType,
			changeDiff === null ? null : normalizeLineEndings(changeDiff),
		),
		getLiveChangeDecorations(loaded, current),
	);
}

/**
 * Collapses the per-line change decorations into one anchor line per change
 * region, so Previous/Next can jump between changes the way VS Code's diff
 * editor does. Adjacent changed lines (and a deletion sitting against them)
 * count as a single region; a gap of an unchanged line starts a new one.
 */
export function getChangeRegionLines(
	decorations: ChangeDecorationsData,
	docLines: number,
): number[] {
	const markers = new Set<number>();
	for (const highlight of decorations.lineHighlights) {
		if (highlight.lineNumber >= 1 && highlight.lineNumber <= docLines) {
			markers.add(highlight.lineNumber);
		}
	}
	for (const chunk of decorations.deletedChunks) {
		markers.add(Math.min(Math.max(chunk.anchorIndex + 1, 1), docLines));
	}

	const regions: number[] = [];
	let previous = Number.NEGATIVE_INFINITY;
	for (const line of [...markers].sort((left, right) => left - right)) {
		if (line - previous > 1) {
			regions.push(line);
		}
		previous = line;
	}
	return regions;
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
				const { markdown } = await import("@codemirror/lang-markdown");
				return markdown();
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

export interface TextFileEditorProps {
	filePath: string;
	repo: string;
	readOnly?: boolean;
	readOnlyLabel?: string;
	comparisonContent?: string;
	changeDiff?: string | null;
	changeType?: ChangeType | null;
	onSaved?: () => void;
}

export function TextFileEditor({
	filePath,
	repo,
	readOnly = false,
	readOnlyLabel = "Read-only",
	comparisonContent,
	changeDiff = null,
	changeType = null,
	onSaved,
}: TextFileEditorProps) {
	const editorRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<import("@codemirror/view").EditorView | null>(null);
	const refreshDecorationsRef = useRef<(() => void) | null>(null);
	const applyLineWrapRef = useRef<((wrap: boolean) => void) | null>(null);
	const scrollToLineRef = useRef<((lineNumber: number) => void) | null>(null);
	const originalContentRef = useRef("");
	const lineSeparatorRef = useRef<"\r\n" | "\n">("\n");
	// Anchor lines of the current change regions and the last one we jumped to,
	// so Previous/Next can cycle through them and wrap around.
	const changeRegionsRef = useRef<number[]>([]);
	const changeCountRef = useRef(0);
	const lastNavLineRef = useRef(0);
	const [changeCount, setChangeCount] = useState(0);
	const [content, setContent] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [mtimeMs, setMtimeMs] = useState<number | null>(null);
	const [reloadToken, setReloadToken] = useState(0);
	const [lineWrap, setLineWrap] = useState(readLineWrapPreference);
	const lineWrapRef = useRef(lineWrap);

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

		(async () => {
			try {
				const response = await fetch(
					apiUrl(
						`/api/files/content?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(filePath)}&_reload=${reloadToken}`,
					),
					{ signal: controller.signal },
				);

				if (!response.ok) {
					const body = await response.json().catch(() => null);
					throw new Error(getErrorMessage(body, response.status));
				}

				const text = await response.text();
				const nextMtimeMs = Number(response.headers.get(FILE_MTIME_HEADER));
				if (!active) return;
				const normalized = normalizeLineEndings(text);
				lineSeparatorRef.current = detectLineSeparator(text);
				setContent(normalized);
				setMtimeMs(Number.isFinite(nextMtimeMs) ? nextMtimeMs : null);
				originalContentRef.current = normalized;
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
	}, [filePath, repo, reloadToken]);

	useEffect(() => {
		if (content === null || !editorRef.current) return;

		let destroyed = false;

		(async () => {
			const { Compartment, EditorState, StateEffect, StateField } =
				await import("@codemirror/state");
			const {
				Decoration,
				EditorView,
				WidgetType,
				lineNumbers,
				drawSelection,
				highlightActiveLine,
			} = await import("@codemirror/view");
			const { HighlightStyle, syntaxHighlighting } = await import(
				"@codemirror/language"
			);
			const { tags: t } = await import("@lezer/highlight");

			if (destroyed || !editorRef.current) return;

			const refreshChangeDecorations = StateEffect.define<void>();
			class DeletedLinesWidget extends WidgetType {
				constructor(private readonly lines: string[]) {
					super();
				}

				override toDOM() {
					const wrapper = document.createElement("div");
					wrapper.className = "cm-deletedChunk";
					for (const line of this.lines) {
						const lineElement = document.createElement("div");
						lineElement.className = "cm-deletedChunkLine";
						lineElement.textContent = line;
						wrapper.append(lineElement);
					}
					return wrapper;
				}
			}

			function buildChangeDecorations(doc: import("@codemirror/state").Text) {
				const changeDecorations = getEditorChangeDecorations({
					currentContent: doc.toString(),
					loadedContent: content,
					comparisonContent,
					changeType,
					changeDiff,
				});

				changeRegionsRef.current = getChangeRegionLines(
					changeDecorations,
					doc.lines,
				);
				if (changeRegionsRef.current.length !== changeCountRef.current) {
					changeCountRef.current = changeRegionsRef.current.length;
					setChangeCount(changeRegionsRef.current.length);
				}

				const ranges = [];
				for (const highlight of changeDecorations.lineHighlights.sort(
					(left, right) => left.lineNumber - right.lineNumber,
				)) {
					const { kind, lineNumber } = highlight;
					if (lineNumber < 1 || lineNumber > doc.lines) {
						continue;
					}
					const line = doc.line(lineNumber);
					ranges.push(
						Decoration.line({
							attributes: {
								class: `cm-changedLine cm-changedLine--${kind}`,
							},
						}).range(line.from),
					);
				}

				for (const chunk of changeDecorations.deletedChunks) {
					const anchor =
						chunk.anchorIndex >= doc.lines
							? doc.length
							: doc.line(chunk.anchorIndex + 1).from;
					ranges.push(
						Decoration.widget({
							block: true,
							side: -1,
							widget: new DeletedLinesWidget(chunk.lines),
						}).range(anchor),
					);
				}

				return Decoration.set(
					ranges.sort((left, right) => left.from - right.from),
					true,
				);
			}

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
			const baseExtensions = [
				lineNumbers(),
				drawSelection(),
				highlightActiveLine(),
				lineWrapCompartment.of(
					lineWrapRef.current ? EditorView.lineWrapping : [],
				),
				syntaxHighlighting(riftHighlightStyle),
				StateField.define({
					create(state) {
						return buildChangeDecorations(state.doc);
					},
					update(value, transaction) {
						if (
							transaction.docChanged ||
							transaction.effects.some((effect) =>
								effect.is(refreshChangeDecorations),
							)
						) {
							return buildChangeDecorations(transaction.state.doc);
						}
						return value;
					},
					provide: (field) => EditorView.decorations.from(field),
				}),
				EditorView.updateListener.of((update) => {
					if (!update.docChanged) return;
					setDirty(update.state.doc.toString() !== originalContentRef.current);
					setError(null);
				}),
				EditorView.theme({
					"&": {
						fontSize: "13px",
						height: "100%",
						color: "var(--color-text)",
						backgroundColor: "var(--color-bg)",
					},
					".cm-scroller": {
						overflow: "auto",
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

			if (readOnly) {
				baseExtensions.unshift(
					EditorView.editable.of(false),
					EditorState.readOnly.of(true),
				);
			}

			const state = EditorState.create({
				doc: content,
				extensions: baseExtensions,
			});
			const view = new EditorView({
				state,
				parent: editorRef.current,
			});
			viewRef.current = view;
			refreshDecorationsRef.current = () => {
				view.dispatch({ effects: refreshChangeDecorations.of() });
			};
			applyLineWrapRef.current = (wrap: boolean) => {
				view.dispatch({
					effects: lineWrapCompartment.reconfigure(
						wrap ? EditorView.lineWrapping : [],
					),
				});
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

			const loader = getLanguageLoader(filePath);
			if (loader) {
				try {
					const langSupport = await loader();
					if (destroyed || viewRef.current !== view) return;
					view.setState(
						EditorState.create({
							doc: view.state.doc.toString(),
							extensions: [...baseExtensions, langSupport],
						}),
					);
					// The fresh state reverts to the wrap setting captured when the
					// extensions were built, so re-apply whatever is current now.
					applyLineWrapRef.current(lineWrapRef.current);
				} catch {
					// Plain text is fine if language support fails.
				}
			}
		})().catch((cause: unknown) => {
			// CodeMirror arrives through dynamic imports, so a chunk that fails
			// to load leaves an empty pane with nothing to explain it. Say so
			// rather than rendering nothing.
			if (destroyed) return;
			const detail = cause instanceof Error ? `: ${cause.message}` : "";
			setError(`Failed to load the editor${detail}`);
		});

		return () => {
			destroyed = true;
			refreshDecorationsRef.current = null;
			applyLineWrapRef.current = null;
			scrollToLineRef.current = null;
			if (viewRef.current) {
				viewRef.current.destroy();
				viewRef.current = null;
			}
		};
	}, [changeDiff, changeType, comparisonContent, content, filePath, readOnly]);

	useEffect(() => {
		lineWrapRef.current = lineWrap;
		applyLineWrapRef.current?.(lineWrap);
	}, [lineWrap]);

	const toggleLineWrap = useCallback(() => {
		setLineWrap((value) => {
			const next = !value;
			window.localStorage.setItem(LINE_WRAP_STORAGE_KEY, String(next));
			return next;
		});
	}, []);

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

	const handleReload = useCallback(() => {
		if (dirty && !window.confirm("Discard unsaved changes?")) {
			return;
		}
		setReloadToken((value) => value + 1);
	}, [dirty]);

	const handleSave = useCallback(async () => {
		if (readOnly || !viewRef.current || mtimeMs === null) return;

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
			originalContentRef.current = nextContent;
			setDirty(false);
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
	}, [filePath, mtimeMs, onSaved, readOnly, repo]);

	return (
		<div className="text-file-editor">
			<div className="text-file-editor-toolbar">
				<div className="text-file-editor-status">
					{readOnly
						? readOnlyLabel
						: dirty
							? "Unsaved changes"
							: "No unsaved changes"}
				</div>
				<div className="text-file-editor-actions">
					{changeCount > 0 && (
						<>
							<button
								type="button"
								className="text-file-editor-button text-file-editor-button--icon"
								onClick={() => goToChange(-1)}
								aria-label="Previous change"
								title="Previous change"
							>
								<ChevronUp size={16} aria-hidden="true" />
							</button>
							<button
								type="button"
								className="text-file-editor-button text-file-editor-button--icon"
								onClick={() => goToChange(1)}
								aria-label="Next change"
								title="Next change"
							>
								<ChevronDown size={16} aria-hidden="true" />
							</button>
						</>
					)}
					<button
						type="button"
						className={`text-file-editor-button text-file-editor-button--icon${
							lineWrap ? " text-file-editor-button--active" : ""
						}`}
						onClick={toggleLineWrap}
						aria-pressed={lineWrap}
						aria-label={lineWrap ? "Disable line wrapping" : "Wrap lines"}
						title={lineWrap ? "Disable line wrapping" : "Wrap lines"}
					>
						<WrapText size={16} aria-hidden="true" />
					</button>
					<button
						type="button"
						className="text-file-editor-button"
						onClick={handleReload}
						disabled={loading || saving}
					>
						Reload
					</button>
					{!readOnly && (
						<button
							type="button"
							className="text-file-editor-button text-file-editor-button--primary"
							onClick={handleSave}
							disabled={loading || saving || !dirty || mtimeMs === null}
						>
							{saving ? "Saving..." : "Save"}
						</button>
					)}
				</div>
			</div>
			{loading && <div className="text-file-editor-message">Loading...</div>}
			{error && <div className="text-file-editor-error">{error}</div>}
			{content !== null && (
				<div
					ref={editorRef}
					className={`text-file-editor-surface${
						lineWrap ? " text-file-editor-surface--wrap" : ""
					}`}
				/>
			)}
		</div>
	);
}
