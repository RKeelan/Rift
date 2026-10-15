/**
 * The new-file line a deleted line is picked and staged with.
 *
 * Git's diff lists a change as a run of deleted lines followed directly by the
 * lines added in their place. Staging by line pairs the two in order: the
 * k-th deleted line goes with the k-th added line, and when the run deletes
 * more lines than it adds, the extra deletions go with its last added line.
 * Extra added lines go with no deletion. A run that adds nothing is a pure
 * deletion, which goes with the new-file line it sits in front of.
 *
 * `index` is the deleted line's place in its run, counting from 0, `added` the
 * number of lines the run adds, and `firstLine` the new-file line the run's
 * deletions sit in front of, which is its first added line when it adds any.
 */
export function deletionStagingLine(
	index: number,
	added: number,
	firstLine: number,
): number {
	return firstLine + Math.min(index, Math.max(added - 1, 0));
}
