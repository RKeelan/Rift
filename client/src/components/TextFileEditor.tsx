import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "../apiUrl.ts";
import "./TextFileEditor.css";

const FILE_MTIME_HEADER = "x-file-mtime-ms";

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

		const modifiedCount = Math.min(
			pendingDeletedLines.length,
			pendingInsertedLines.length,
		);
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

type DiffOp =
	| { type: "equal"; line: string }
	| { type: "delete"; line: string }
	| { type: "insert"; line: string };

function getDiffOps(originalLines: string[], currentLines: string[]): DiffOp[] {
	const rowCount = originalLines.length;
	const columnCount = currentLines.length;
	const table = Array.from({ length: rowCount + 1 }, () =>
		Array<number>(columnCount + 1).fill(0),
	);

	for (let row = rowCount - 1; row >= 0; row -= 1) {
		for (let column = columnCount - 1; column >= 0; column -= 1) {
			table[row][column] =
				originalLines[row] === currentLines[column]
					? table[row + 1][column + 1] + 1
					: Math.max(table[row + 1][column], table[row][column + 1]);
		}
	}

	const ops: DiffOp[] = [];
	let row = 0;
	let column = 0;
	while (row < rowCount && column < columnCount) {
		if (originalLines[row] === currentLines[column]) {
			ops.push({ type: "equal", line: originalLines[row] });
			row += 1;
			column += 1;
			continue;
		}

		if (table[row + 1][column] >= table[row][column + 1]) {
			ops.push({ type: "delete", line: originalLines[row] });
			row += 1;
			continue;
		}

		ops.push({ type: "insert", line: currentLines[column] });
		column += 1;
	}

	while (row < rowCount) {
		ops.push({ type: "delete", line: originalLines[row] });
		row += 1;
	}

	while (column < columnCount) {
		ops.push({ type: "insert", line: currentLines[column] });
		column += 1;
	}

	return ops;
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

	const complexity = originalMiddle.length * currentMiddle.length;
	const lineHighlights: ChangeLineHighlight[] = [];
	const deletedChunks: DeletedLineChunk[] = [];
	let currentIndex = prefixLength;

	if (complexity > 40_000) {
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

	const ops = getDiffOps(originalMiddle, currentMiddle);
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
	if (comparisonContent !== undefined) {
		return getLiveChangeDecorations(comparisonContent, currentContent);
	}

	if (!changeType && !changeDiff) {
		return { lineHighlights: [], deletedChunks: [] };
	}

	return mergeChangeDecorations(
		getChangeLineHighlights(loadedContent, changeType, changeDiff),
		getLiveChangeDecorations(loadedContent, currentContent),
	);
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
	const originalContentRef = useRef("");
	const [content, setContent] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [mtimeMs, setMtimeMs] = useState<number | null>(null);
	const [reloadToken, setReloadToken] = useState(0);

	useEffect(() => {
		let active = true;
		const controller = new AbortController();

		setLoading(true);
		setError(null);
		setContent(null);
		setDirty(false);
		setMtimeMs(null);
		originalContentRef.current = "";

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
				setContent(text);
				setMtimeMs(Number.isFinite(nextMtimeMs) ? nextMtimeMs : null);
				originalContentRef.current = text;
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
			const { EditorState, StateEffect, StateField } = await import(
				"@codemirror/state"
			);
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

			const baseExtensions = [
				lineNumbers(),
				drawSelection(),
				highlightActiveLine(),
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
				} catch {
					// Plain text is fine if language support fails.
				}
			}
		})();

		return () => {
			destroyed = true;
			refreshDecorationsRef.current = null;
			if (viewRef.current) {
				viewRef.current.destroy();
				viewRef.current = null;
			}
		};
	}, [changeDiff, changeType, comparisonContent, content, filePath, readOnly]);

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
						content: nextContent,
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
				<div ref={editorRef} className="text-file-editor-surface" />
			)}
		</div>
	);
}
