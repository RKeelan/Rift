import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import {
	type BlockInfo,
	type EditorView,
	GutterMarker,
	gutter,
	lineNumbers,
	type WidgetType,
} from "@codemirror/view";

/**
 * Line picking: tapping the gutter beside a changed line adds it to, or removes
 * it from, the set of lines that Stage and Unstage act on. It stands in for
 * text selection, which on a phone means a long-press, drag handles, and a
 * keyboard that pops up over the buffer.
 *
 * A pick is a 1-based line number in the editor's document, which is the file
 * git diffed, so picks go to the server unchanged as `ranges`. A deletion has
 * no line of its own: it is picked through its anchor, the line just below it,
 * which is also the line the server's partial patch stages it with.
 */

interface ChangeShape {
	lineHighlights: readonly { kind: "added" | "deleted"; lineNumber: number }[];
	deletedChunks: readonly { anchorIndex: number; lines: readonly string[] }[];
}

/** The lines a pick can name, derived from the editor's change decorations. */
export interface PickTargets {
	/** Added or modified lines, each picked through its own gutter cell. */
	lines: ReadonlySet<number>;
	/** Each deletion's anchor line, mapped to the number of lines it removes. */
	deletions: ReadonlyMap<number, number>;
}

/**
 * The line a deletion is picked and staged with: the line below it. A deletion
 * at the end of a file without a trailing newline has no line below, and git
 * reports the last line as modified there, so it anchors to that last line.
 */
export function deletionAnchorLine(
	chunk: { anchorIndex: number },
	docLines: number,
): number {
	return Math.min(chunk.anchorIndex + 1, docLines);
}

export function getPickTargets(
	changes: ChangeShape,
	docLines: number,
): PickTargets {
	const lines = new Set<number>();
	for (const { kind, lineNumber } of changes.lineHighlights) {
		if (kind === "added" && lineNumber >= 1 && lineNumber <= docLines) {
			lines.add(lineNumber);
		}
	}

	const deletions = new Map<number, number>();
	for (const chunk of changes.deletedChunks) {
		const anchor = deletionAnchorLine(chunk, docLines);
		deletions.set(anchor, (deletions.get(anchor) ?? 0) + chunk.lines.length);
	}

	return { lines, deletions };
}

/**
 * The picks that still name a target. Targets can move after a pick, as when
 * git's diff arrives and places a deletion differently, and a pick that no
 * longer names one is neither shown, counted, nor sent.
 */
export function livePickedLines(
	picked: ReadonlySet<number>,
	targets: PickTargets,
): number[] {
	return [...picked].filter(
		(line) => targets.lines.has(line) || targets.deletions.has(line),
	);
}

/**
 * Collapses picked lines into the sorted, inclusive `[start, end]` spans the
 * stage and unstage endpoints take, merging runs of consecutive lines.
 */
export function pickedLinesToRanges(
	picked: Iterable<number>,
): [number, number][] {
	const ranges: [number, number][] = [];
	for (const line of [...picked].sort((left, right) => left - right)) {
		const last = ranges[ranges.length - 1];
		if (last && line <= last[1] + 1) {
			last[1] = Math.max(last[1], line);
		} else {
			ranges.push([line, line]);
		}
	}
	return ranges;
}

/**
 * Whether any of the inclusive line ranges names a pick target. Staging lines
 * that hold no change is a no-op on the server, so a selection that covers none
 * gives Stage and Unstage nothing to act on.
 */
export function rangesCoverTarget(
	ranges: readonly [number, number][],
	targets: PickTargets,
): boolean {
	return [...targets.lines, ...targets.deletions.keys()].some((line) =>
		ranges.some(([start, end]) => line >= start && line <= end),
	);
}

/**
 * Counts the changed lines the picks cover, for the Stage and Unstage labels.
 * A picked added line counts once, taking any deletion anchored to it along as
 * one modified line. A picked deletion with no added line of its own counts
 * the lines it removes.
 */
export function countPickedLines(
	picked: ReadonlySet<number>,
	targets: PickTargets,
): number {
	let count = 0;
	for (const line of picked) {
		count += targets.lines.has(line) ? 1 : (targets.deletions.get(line) ?? 0);
	}
	return count;
}

export const togglePickedLine = StateEffect.define<number>();
export const clearPickedLines = StateEffect.define<null>();

const NO_PICKS: ReadonlySet<number> = new Set();

export const pickedLines = StateField.define<ReadonlySet<number>>({
	create: () => NO_PICKS,
	update(value, transaction) {
		// Picks name lines of the file git diffed, so any edit invalidates them.
		// Staging needs a clean buffer anyway, so nothing worth keeping is lost.
		let next = transaction.docChanged ? NO_PICKS : value;
		for (const effect of transaction.effects) {
			if (effect.is(clearPickedLines)) {
				next = NO_PICKS;
			} else if (effect.is(togglePickedLine)) {
				const toggled = new Set(next);
				if (!toggled.delete(effect.value)) {
					toggled.add(effect.value);
				}
				next = toggled;
			}
		}
		return next;
	},
});

type PickKind = "line" | "deletion";

class PickMarker extends GutterMarker {
	constructor(
		readonly line: number,
		readonly kind: PickKind,
		readonly picked: boolean,
		readonly waiting: boolean,
	) {
		super();
	}

	override eq(other: GutterMarker): boolean {
		return (
			other instanceof PickMarker &&
			other.line === this.line &&
			other.kind === this.kind &&
			other.picked === this.picked &&
			other.waiting === this.waiting
		);
	}

	override toDOM(): Node {
		// The marker fills its gutter cell, so a tap anywhere in the cell lands
		// on it and the click handler can read the line it picks.
		const cell = document.createElement("div");
		cell.className = `cm-pickTarget cm-pickTarget--${this.kind}${
			this.picked ? " cm-pickTarget--picked" : ""
		}${this.waiting ? " cm-pickTarget--waiting" : ""}`;
		cell.dataset.pickLine = String(this.line);
		cell.textContent = this.picked ? "✓" : this.kind === "line" ? "+" : "−";
		return cell;
	}
}

function pickTargetLine(event: Event): number | null {
	const target = event.target;
	if (!(target instanceof Element)) return null;
	const cell = target.closest<HTMLElement>("[data-pick-line]");
	return cell ? Number(cell.dataset.pickLine) : null;
}

/** The changed line whose number was tapped, or null for any other line. */
function numberedPickLine(event: Event, targets: PickTargets): number | null {
	const target = event.target;
	if (!(target instanceof Element)) return null;
	const line = Number(target.closest(".cm-gutterElement")?.textContent);
	return targets.lines.has(line) ? line : null;
}

export interface LinePickerOptions {
	/** Reads the current pick targets from the editor state. */
	targets: (state: EditorState) => PickTargets;
	/**
	 * Whether the targets can be picked yet. Until they can, they are drawn
	 * dimmed and taps on them are ignored.
	 */
	canPick: (state: EditorState) => boolean;
	/** The anchor line of a deleted-lines widget, or null for any other widget. */
	widgetAnchor: (widget: WidgetType) => number | null;
}

/**
 * A gutter beside the line numbers with a tap target for every changed line
 * and every deletion. Unchanged lines get no target and so cannot be picked.
 * A changed line's number picks it too, so the column can stay narrow while
 * the target spans both.
 */
export function linePickerGutter({
	targets,
	canPick,
	widgetAnchor,
}: LinePickerOptions) {
	// Swallowing the press keeps focus where it was, so picking never raises
	// the keyboard or starts a text selection.
	function pickOnTap(
		pickLine: (view: EditorView, event: Event) => number | null,
	) {
		return {
			mousedown: (view: EditorView, _block: BlockInfo, event: Event) =>
				pickLine(view, event) !== null,
			click(view: EditorView, _block: BlockInfo, event: Event) {
				const line = pickLine(view, event);
				if (line === null) return false;
				if (canPick(view.state)) {
					view.dispatch({ effects: togglePickedLine.of(line) });
				}
				return true;
			},
		};
	}

	const pickGutter = gutter({
		class: "cm-pickGutter",
		lineMarker(view, block) {
			const line = view.state.doc.lineAt(block.from).number;
			if (!targets(view.state).lines.has(line)) return null;
			return new PickMarker(
				line,
				"line",
				view.state.field(pickedLines).has(line),
				!canPick(view.state),
			);
		},
		widgetMarker(view, widget) {
			const anchor = widgetAnchor(widget);
			if (anchor === null) return null;
			return new PickMarker(
				anchor,
				"deletion",
				view.state.field(pickedLines).has(anchor),
				!canPick(view.state),
			);
		},
		lineMarkerChange: (update) =>
			update.startState.field(pickedLines) !==
				update.state.field(pickedLines) ||
			targets(update.startState) !== targets(update.state) ||
			canPick(update.startState) !== canPick(update.state),
		domEventHandlers: pickOnTap((_view, event) => pickTargetLine(event)),
	});

	// Joins the editor's own line numbers rather than adding a second column.
	const numberTargets = lineNumbers({
		domEventHandlers: pickOnTap((view, event) =>
			numberedPickLine(event, targets(view.state)),
		),
	});

	return [pickGutter, numberTargets];
}
