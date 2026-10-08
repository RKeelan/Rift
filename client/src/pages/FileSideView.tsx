import { useEffect, useState } from "react";
import { apiUrl } from "../apiUrl.ts";
import {
	type ChangedFile,
	type FileAction,
	TextFileEditor,
} from "../components/TextFileEditor.tsx";

export type FileStatus =
	| "added"
	| "modified"
	| "deleted"
	| "renamed"
	| "untracked";

interface DiffResponse {
	diff: string;
	truncated: boolean;
	// Given for an untracked file's diff: whether it describes the file exactly.
	exact?: boolean;
}

interface ChangeContextOptions {
	repoName: string;
	path: string;
	staged: boolean;
	status: FileStatus | null;
	// Bumped after a stage or unstage, which changes the index, so the
	// comparison and git's diff are both refetched.
	refreshToken: number;
	// Bumped after a save, which changes the working tree but not the index, so
	// only the working tree's diff is refetched.
	diffRefreshToken: number;
	// Bumped when HEAD may have changed, which only the staged side compares
	// against.
	headToken: number;
	showError: (message: string) => void;
}

/**
 * What one side of a file's changes is compared against, and git's diff of
 * it: the index and the unstaged diff for the working tree, HEAD and the
 * staged diff for the index.
 */
function useChangeContext({
	repoName,
	path,
	staged,
	status,
	refreshToken,
	diffRefreshToken,
	headToken,
	showError,
}: ChangeContextOptions) {
	// The copy of the file that this side compares against: its text, null
	// when git has no copy of it, or undefined while it loads or when it is
	// too large or binary to show.
	const [base, setBase] = useState<string | null | undefined>(undefined);
	const [diff, setDiff] = useState<string | null>(null);
	const [diffExact, setDiffExact] = useState(true);
	// A deleted file decorates straight from its content, and an untracked one
	// compares against nothing. Every other side compares against the same
	// copy whether or not the status lists a change in it, so the base stays
	// as it is when the status gains or loses one, as when a save makes one.
	const needsBase = status !== "deleted" && status !== "untracked";
	// The working tree compares against the index, which stages and unstages
	// change, and the index against HEAD, which they don't. Only the working
	// tree's diff changes on a save.
	const comparisonKey = staged ? headToken : refreshToken;
	const diffKey = staged
		? `${refreshToken}`
		: `${refreshToken}.${diffRefreshToken}`;

	useEffect(() => {
		if (!needsBase) {
			setBase(undefined);
			return;
		}

		const controller = new AbortController();
		setBase(undefined);

		void (async () => {
			try {
				const params = new URLSearchParams({
					repo: repoName,
					path,
					staged: String(staged),
					_refresh: String(comparisonKey),
				});
				const res = await fetch(apiUrl(`/api/git/base-content?${params}`), {
					signal: controller.signal,
				});
				if (!res.ok) {
					if (res.status === 404) {
						setBase(null);
						return;
					}
					// A copy too large or binary to show belongs to a file the
					// editor refuses too, and says so itself.
					if (res.status === 413 || res.status === 415) return;
					const body = await res.json().catch(() => null);
					showError(body?.error?.message ?? `Request failed (${res.status})`);
					return;
				}

				setBase(await res.text());
			} catch (err) {
				if (err instanceof DOMException && err.name === "AbortError") {
					return;
				}
				showError(err instanceof Error ? err.message : "Network error");
			}
		})();

		return () => {
			controller.abort();
		};
	}, [needsBase, repoName, path, staged, showError, comparisonKey]);

	let comparisonContent: string | undefined;
	if (status === "untracked") {
		comparisonContent = "";
	} else if (!needsBase) {
		comparisonContent = undefined;
	} else if (base === null) {
		// A file with no committed or staged version has no base to compare
		// against; treat it like an untracked file rather than failing the
		// edit. A file the status doesn't list either, such as one inside
		// .git, has no changes to mark.
		comparisonContent = status === null ? undefined : "";
	} else {
		comparisonContent = base;
	}

	// The editor needs git's diff to decorate a change, and to stage or
	// unstage it by line. A deleted file decorates straight from its content,
	// so it needs none. An untracked file has no diff against the index, so
	// its diff is against nothing, which is what staging its lines slices. A
	// working tree with no change in the status, such as an unchanged file's,
	// has its diff read too once its base has loaded, so a save that makes a
	// change rereads git's diff alongside the status. The request is the same
	// either way, so the status gaining or losing a change doesn't repeat it.
	let diffKind: "untracked" | "tracked" | null = null;
	if (status === "untracked") {
		diffKind = "untracked";
	} else if (status !== "deleted" && status !== null) {
		diffKind = "tracked";
	} else if (status === null && !staged && typeof base === "string") {
		diffKind = "tracked";
	}

	useEffect(() => {
		if (diffKind === null) {
			setDiff(null);
			return;
		}

		const controller = new AbortController();
		setDiff(null);

		void (async () => {
			try {
				const params = new URLSearchParams({
					repo: repoName,
					path,
					staged: String(staged),
					_refresh: diffKey,
				});
				if (diffKind === "untracked") params.set("untracked", "true");
				const res = await fetch(apiUrl(`/api/git/diff?${params}`), {
					signal: controller.signal,
				});
				if (!res.ok) {
					const body = await res.json().catch(() => null);
					showError(body?.error?.message ?? `Request failed (${res.status})`);
					return;
				}

				const data: DiffResponse = await res.json();
				setDiff(data.diff);
				setDiffExact(data.exact !== false);
			} catch (err) {
				if (err instanceof DOMException && err.name === "AbortError") {
					return;
				}
				showError(err instanceof Error ? err.message : "Network error");
			}
		})();

		return () => {
			controller.abort();
		};
	}, [repoName, path, staged, diffKind, showError, diffKey]);

	return { comparisonContent, diff, diffExact };
}

export interface FileSideViewProps extends ChangeContextOptions {
	// Whether this side is the one on screen. The other side of a file with
	// changes of both kinds stays built behind it, so switching to it is
	// immediate.
	active: boolean;
	canWrite: boolean;
	readOnlyLabel: string;
	// Bumped when the index changes from the other side, as when the working
	// tree stages lines, so the staged side reloads its content.
	contentToken: number;
	// Leaves the file, from the bar's Back.
	onBack: () => void;
	// The file's other side, which a tap on the file's name switches to.
	otherSide: { available: boolean; show: () => void };
	// The page's action on the whole file, for this side.
	fileAction: (label: string) => FileAction;
	onSaved: () => void;
	// Each is called with the repo's changes as the action leaves them.
	onStaged: (files: ChangedFile[]) => void;
	// Called when the editor stages an untracked file whole.
	onUntrackedStaged: (files: ChangedFile[]) => void;
	onUnstaged: (files: ChangedFile[]) => void;
	onReload: () => void;
	onDirtyChange: (dirty: boolean) => void;
}

/**
 * One side of an open file: the working tree with its unstaged changes, or
 * the index with its staged ones, in the editor.
 */
export function FileSideView({
	active,
	canWrite,
	readOnlyLabel,
	contentToken,
	onBack,
	otherSide,
	fileAction,
	onSaved,
	onStaged,
	onUntrackedStaged,
	onUnstaged,
	onReload,
	onDirtyChange,
	...context
}: FileSideViewProps) {
	const { repoName, path, staged, status } = context;
	const { comparisonContent, diff, diffExact } = useChangeContext(context);

	return (
		<div
			className={`changes-editor-view${active ? "" : " changes-editor-view--hidden"}`}
			inert={!active}
		>
			{status === "deleted" ? (
				<TextFileEditor
					changeType="deleted"
					filePath={path}
					repo={repoName}
					staged={staged}
					deleted
					fileAction={fileAction(
						staged ? "Unstage deletion" : "Stage deletion",
					)}
					onBack={onBack}
					backLabel="Back to file list"
					otherSide={otherSide}
				/>
			) : staged ? (
				<TextFileEditor
					comparisonContent={comparisonContent}
					changeDiff={diff}
					changeType={status}
					filePath={path}
					repo={repoName}
					readOnly={!canWrite}
					readOnlyLabel={readOnlyLabel}
					staged
					reloadKey={contentToken}
					onUnstaged={onUnstaged}
					onReload={onReload}
					fileAction={fileAction("Unstage file")}
					onBack={onBack}
					backLabel="Back to file list"
					otherSide={otherSide}
				/>
			) : (
				<TextFileEditor
					comparisonContent={comparisonContent}
					changeDiff={diff}
					changeDiffExact={diffExact}
					changeType={status}
					filePath={path}
					repo={repoName}
					readOnly={!canWrite}
					readOnlyLabel={readOnlyLabel}
					onSaved={onSaved}
					onStaged={onStaged}
					onFileStaged={onUntrackedStaged}
					onReload={onReload}
					onDirtyChange={onDirtyChange}
					fileAction={
						status === "untracked" ? undefined : fileAction("Stage file")
					}
					onBack={onBack}
					backLabel="Back to file list"
					otherSide={otherSide}
				/>
			)}
		</div>
	);
}
