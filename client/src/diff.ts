export type DiffOp =
	| { type: "equal"; line: string }
	| { type: "delete"; line: string }
	| { type: "insert"; line: string };

/**
 * Largest edit script the line diff will build. Myers costs O((N + M) * D), so
 * capping D caps the work no matter how long the file is. Ordinary editing
 * produces a D in the tens; the cap only trips on a wholesale rewrite, where a
 * line-by-line diff has nothing useful left to say.
 */
const MAX_EDIT_DISTANCE = 1000;

interface DiffSearch {
	forward: Int32Array;
	reverse: Int32Array;
	offset: number;
	budget: number;
}

interface MiddleSnake {
	xStart: number;
	yStart: number;
	xEnd: number;
	yEnd: number;
}

/**
 * Locates the middle snake of an optimal edit path through `a[aStart, aStop)`
 * and `b[bStart, bStop)`, per section 4b of Myers 1986: run a forward and a
 * reverse breadth-first search in lockstep until their furthest-reaching paths
 * overlap. The overlap sits on a diagonal run — the snake — that every optimal
 * path crosses, so the two sides of it can be solved independently.
 *
 * Both searches keep only their furthest-reaching endpoint per diagonal, which
 * is what holds memory to O(N + M) rather than the O(N * M) table a full
 * dynamic-programming solution needs. Returns null when the search runs past
 * the caller's budget.
 */
function findMiddleSnake(
	a: string[],
	aStart: number,
	aStop: number,
	b: string[],
	bStart: number,
	bStop: number,
	search: DiffSearch,
): MiddleSnake | null {
	const { forward, reverse, offset, budget } = search;
	const rowCount = aStop - aStart;
	const columnCount = bStop - bStart;
	const delta = rowCount - columnCount;
	const deltaIsOdd = (delta & 1) !== 0;
	const maxDistance = Math.min(Math.ceil((rowCount + columnCount) / 2), budget);

	forward[offset + 1] = 0;
	reverse[offset + 1] = 0;

	for (let distance = 0; distance <= maxDistance; distance += 1) {
		for (let k = -distance; k <= distance; k += 2) {
			// Extend whichever neighbouring diagonal reaches further: down from
			// k + 1 (an insertion) or right from k - 1 (a deletion).
			let x =
				k === -distance ||
				(k !== distance && forward[offset + k - 1] < forward[offset + k + 1])
					? forward[offset + k + 1]
					: forward[offset + k - 1] + 1;
			let y = x - k;
			const snakeX = x;
			const snakeY = y;
			while (
				x < rowCount &&
				y < columnCount &&
				a[aStart + x] === b[bStart + y]
			) {
				x += 1;
				y += 1;
			}
			forward[offset + k] = x;

			// The reverse search has only covered diagonals within distance - 1
			// of delta, so anything outside that window has no value to compare.
			if (
				deltaIsOdd &&
				k - delta >= 1 - distance &&
				k - delta <= distance - 1 &&
				x + reverse[offset + delta - k] >= rowCount
			) {
				return { xStart: snakeX, yStart: snakeY, xEnd: x, yEnd: y };
			}
		}

		for (let k = -distance; k <= distance; k += 2) {
			let x =
				k === -distance ||
				(k !== distance && reverse[offset + k - 1] < reverse[offset + k + 1])
					? reverse[offset + k + 1]
					: reverse[offset + k - 1] + 1;
			let y = x - k;
			const snakeX = x;
			const snakeY = y;
			while (
				x < rowCount &&
				y < columnCount &&
				a[aStop - x - 1] === b[bStop - y - 1]
			) {
				x += 1;
				y += 1;
			}
			reverse[offset + k] = x;

			if (
				!deltaIsOdd &&
				k - delta >= -distance &&
				k - delta <= distance &&
				x + forward[offset + delta - k] >= rowCount
			) {
				// The reverse search counts from the far end, so flip its
				// coordinates back before handing the snake to the caller.
				return {
					xStart: rowCount - x,
					yStart: columnCount - y,
					xEnd: rowCount - snakeX,
					yEnd: columnCount - snakeY,
				};
			}
		}
	}

	return null;
}

/**
 * Appends the edit script for `a[aStart, aStop)` against `b[bStart, bStop)` to
 * `ops`, splitting the range at its middle snake and recursing on each side.
 * Returns false when the search exceeds its budget.
 */
function diffRange(
	a: string[],
	aStart: number,
	aStop: number,
	b: string[],
	bStart: number,
	bStop: number,
	search: DiffSearch,
	ops: DiffOp[],
): boolean {
	// Peeling the shared head and tail costs a linear scan and shrinks the
	// region the O(ND) search has to cover, often to nothing.
	let aHead = aStart;
	let bHead = bStart;
	while (aHead < aStop && bHead < bStop && a[aHead] === b[bHead]) {
		ops.push({ type: "equal", line: a[aHead] });
		aHead += 1;
		bHead += 1;
	}

	let tailLength = 0;
	while (
		aStop - tailLength > aHead &&
		bStop - tailLength > bHead &&
		a[aStop - tailLength - 1] === b[bStop - tailLength - 1]
	) {
		tailLength += 1;
	}
	const aMiddleStop = aStop - tailLength;
	const bMiddleStop = bStop - tailLength;

	if (aHead === aMiddleStop) {
		for (let index = bHead; index < bMiddleStop; index += 1) {
			ops.push({ type: "insert", line: b[index] });
		}
	} else if (bHead === bMiddleStop) {
		for (let index = aHead; index < aMiddleStop; index += 1) {
			ops.push({ type: "delete", line: a[index] });
		}
	} else {
		const snake = findMiddleSnake(
			a,
			aHead,
			aMiddleStop,
			b,
			bHead,
			bMiddleStop,
			search,
		);
		if (!snake) return false;

		if (
			!diffRange(
				a,
				aHead,
				aHead + snake.xStart,
				b,
				bHead,
				bHead + snake.yStart,
				search,
				ops,
			)
		) {
			return false;
		}

		for (let index = snake.xStart; index < snake.xEnd; index += 1) {
			ops.push({ type: "equal", line: a[aHead + index] });
		}

		if (
			!diffRange(
				a,
				aHead + snake.xEnd,
				aMiddleStop,
				b,
				bHead + snake.yEnd,
				bMiddleStop,
				search,
				ops,
			)
		) {
			return false;
		}
	}

	for (let index = aMiddleStop; index < aStop; index += 1) {
		ops.push({ type: "equal", line: a[index] });
	}

	return true;
}

/**
 * Diffs two arrays of lines, returning a minimal edit script. Returns null when
 * the two differ by more than `MAX_EDIT_DISTANCE` edits, leaving the caller to
 * fall back on a coarser rendering.
 */
export function getDiffOps(
	originalLines: string[],
	currentLines: string[],
): DiffOp[] | null {
	const budget = Math.min(
		MAX_EDIT_DISTANCE,
		Math.ceil((originalLines.length + currentLines.length) / 2),
	);
	const search: DiffSearch = {
		// Diagonals run from -budget to +budget, plus one slot of headroom at
		// each end for the neighbour lookups.
		forward: new Int32Array(2 * budget + 3),
		reverse: new Int32Array(2 * budget + 3),
		offset: budget + 1,
		budget,
	};

	const ops: DiffOp[] = [];
	if (
		!diffRange(
			originalLines,
			0,
			originalLines.length,
			currentLines,
			0,
			currentLines.length,
			search,
			ops,
		)
	) {
		return null;
	}
	return ops;
}
