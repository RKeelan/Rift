import "./DiffViewer.css";

/**
 * Detects whether a string contains a unified diff by looking for
 * `--- a/<path>` / `+++ b/<path>` pairs followed by `@@ ... @@` hunk headers.
 *
 * False positives are possible but unlikely given the path requirement.
 */
export function containsUnifiedDiff(text: string): boolean {
	return /^--- a\/.+\n\+\+\+ b\/.+\n@@\s/m.test(text);
}

interface DiffViewerProps {
	diff: string;
}

export function DiffViewer({ diff }: DiffViewerProps) {
	if (!diff) {
		return null;
	}

	const isUnifiedDiff = containsUnifiedDiff(diff);
	const lines = diff.split("\n");

	return (
		<pre className="diff-viewer">
			{lines.map((line, i) => {
				let className = "diff-line";
				if (isUnifiedDiff && line.startsWith("+") && !line.startsWith("+++")) {
					className += " diff-add";
				} else if (
					isUnifiedDiff &&
					line.startsWith("-") &&
					!line.startsWith("---")
				) {
					className += " diff-remove";
				} else if (isUnifiedDiff && line.startsWith("@@")) {
					className += " diff-hunk";
				}
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: diff lines are static and never reordered
					<span key={`${i}`} className={className}>
						{line}
						{"\n"}
					</span>
				);
			})}
		</pre>
	);
}
