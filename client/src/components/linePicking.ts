import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import {
	type BlockInfo,
	type EditorView,
	GutterMarker,
	gutter,
	lineNumbers,
	type WidgetType,
} from "@codemirror/view";
import { deletionStagingLine } from "shared";
import { swallowPressInEditor } from "../onScreenKeyboard.ts";

/**
 * Line picking: tapping the gutter beside a changed line adds it to, or removes
 * it from, the set of lines that Stage and Unstage act on. It stands in for
 * text selection, which on a phone means a long-press, drag handles, and a
 * keyboard that pops up over the buffer.
 *
 * A pick is a 1-based line number in the editor's document, which is the file
 * git diffed, so picks go to the server unchanged as `ranges`. A deleted line
 * has no line of its own: it is picked through the line the server's partial
 * patch stages it with, by the rule in `deletionStagingLine`. In a modified
 * run that is the added line in its place, and for a pure deletion the line
 * just below it.
 */

/** A chunk of deleted lines, drawn in front of line `anchorIndex + 1`. */
interface DeletedChunkShape {
	anchorIndex: number;
	/** How many lines its change adds, from the line it sits in front of. */
	added: number;
	lines: readonly string[];
}

interface ChangeShape {
	lineHighlights: readonly { kind: "added" | "deleted"; lineNumber: number }[];
	deletedChunks: readonly DeletedChunkShape[];
}

/** The lines a pick can name, derived from the editor's change decorations. */
export interface PickTargets {
	/** Added or modified lines, each picked through its own gutter cell. */
	lines: ReadonlySet<number>;
	/**
	 * Each line that deleted lines are picked through, mapped to the number of
	 * deleted lines that go with it.
	 */
	deletions: ReadonlyMap<number, number>;
}

/**
 * The line each of a chunk's deleted lines is picked and staged with. A
 * deletion at the end of a file without a trailing newline has no line below,
 * and git reports the last line as modified there, so it goes with that last
 * line.
 */
export function deletionPickLines(
	chunk: DeletedChunkShape,
	docLines: number,
): number[] {
	return chunk.lines.map((_line, index) =>
		Math.min(
			deletionStagingLine(index, chunk.added, chunk.anchorIndex + 1),
			docLines,
		),
	);
}

/**
 * Splits a chunk's deleted lines into runs that are picked through the same
 * line, as `[from, to)` offsets into its lines. Each run is drawn with a pick
 * target of its own.
 */
export function deletionPickGroups(
	chunk: DeletedChunkShape,
	docLines: number,
): { pickLine: number; from: number; to: number }[] {
	const groups: { pickLine: number; from: number; to: number }[] = [];
	deletionPickLines(chunk, docLines).forEach((pickLine, index) => {
		const last = groups[groups.length - 1];
		if (last && last.pickLine === pickLine) {
			last.to = index + 1;
		} else {
			groups.push({ pickLine, from: index, to: index + 1 });
		}
	});
	return groups;
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
		for (const line of deletionPickLines(chunk, docLines)) {
			deletions.set(line, (deletions.get(line) ?? 0) + 1);
		}
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
 * A picked added line counts once, taking any deleted lines that go with it
 * along as one modified line. A picked deletion with no added line of its own
 * counts the lines it removes.
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
	/**
	 * The line a deleted-lines widget's lines are picked through, or null for
	 * any other widget.
	 */
	widgetPickLine: (widget: WidgetType) => number | null;
}

/**
 * A gutter beside the line numbers with a tap target for every changed line
 * and every block of deleted lines. Unchanged lines get no target and so
 * cannot be picked. A changed line's number picks it too, so the column can
 * stay narrow while the target spans both.
 */
export function linePickerGutter({
	targets,
	canPick,
	widgetPickLine,
}: LinePickerOptions) {
	// A press on a target leaves the cursor and the on-screen keyboard as they
	// were.
	function pickOnTap(
		pickLine: (view: EditorView, event: Event) => number | null,
	) {
		return {
			mousedown(view: EditorView, _block: BlockInfo, event: Event) {
				if (pickLine(view, event) === null) return false;
				swallowPressInEditor(view, event);
				return true;
			},
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
			const line = widgetPickLine(widget);
			if (line === null) return null;
			return new PickMarker(
				line,
				"deletion",
				view.state.field(pickedLines).has(line),
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
