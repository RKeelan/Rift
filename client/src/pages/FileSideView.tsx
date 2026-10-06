import { useEffect, useState } from "react";
import { apiUrl } from "../apiUrl.ts";
import {
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
	const [comparisonContent, setComparisonContent] = useState<
		string | undefined
	>(undefined);
	const [diff, setDiff] = useState<string | null>(null);
	const inEditor = status !== "deleted";
	// The working tree compares against the index, which stages and unstages
	// change, and the index against HEAD, which they don't. Only the working
	// tree's diff changes on a save.
	const comparisonKey = staged ? headToken : refreshToken;
	const diffKey = staged
		? `${refreshToken}`
		: `${refreshToken}.${diffRefreshToken}`;

	useEffect(() => {
		if (!inEditor) {
			setComparisonContent(undefined);
			return;
		}
		if (status === "untracked") {
			setComparisonContent("");
			return;
		}

		const controller = new AbortController();
		setComparisonContent(undefined);

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
					// A file with no committed or staged version has no base to
					// compare against; treat it like an untracked file rather
					// than failing the edit.
					if (res.status === 404) {
						setComparisonContent("");
						return;
					}
					const body = await res.json().catch(() => null);
					showError(body?.error?.message ?? `Request failed (${res.status})`);
					return;
				}

				setComparisonContent(await res.text());
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
	}, [inEditor, repoName, path, staged, status, showError, comparisonKey]);

	useEffect(() => {
		// The editor only needs a diff to decorate a tracked modification it is
		// editing or unstaging. Untracked and deleted files decorate straight from
		// their content, so they need no diff.
		if (status === "untracked" || status === "deleted" || status === null) {
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
	}, [repoName, path, staged, status, showError, diffKey]);

	return { comparisonContent, diff };
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
	menuHost: HTMLElement | null;
	// The page's action on the whole file, for this side.
	fileAction: (label: string) => FileAction;
	onSaved: () => void;
	onStaged: () => void;
	onUntrackedStaged: () => void;
	onUnstaged: () => void;
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
	menuHost,
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
	const { comparisonContent, diff } = useChangeContext(context);

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
					menuHost={active ? menuHost : null}
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
					menuHost={active ? menuHost : null}
				/>
			) : (
				<TextFileEditor
					comparisonContent={comparisonContent}
					changeDiff={status === "untracked" ? null : diff}
					changeType={status}
					filePath={path}
					repo={repoName}
					readOnly={!canWrite}
					readOnlyLabel={readOnlyLabel}
					onSaved={onSaved}
					onStaged={status === "untracked" ? onUntrackedStaged : onStaged}
					onReload={onReload}
					onDirtyChange={onDirtyChange}
					fileAction={
						status === "untracked" ? undefined : fileAction("Stage file")
					}
					menuHost={active ? menuHost : null}
				/>
			)}
		</div>
	);
}
