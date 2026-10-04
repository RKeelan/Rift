import { ArrowLeft, Minus, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiUrl } from "../apiUrl.ts";
import { useErrorBanner } from "../components/ErrorBanner.tsx";
import {
	TextFileEditor,
	WRITES_DISABLED_LABEL,
} from "../components/TextFileEditor.tsx";
import { useSession } from "../contexts/SessionContext.tsx";
import "./ChangesPage.css";

type FileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

interface StatusEntry {
	path: string;
	status: FileStatus;
	staged: boolean;
}

interface StatusResponse {
	files: StatusEntry[];
}

interface DiffResponse {
	diff: string;
	truncated: boolean;
}

const BADGE_LABELS: Record<FileStatus, string> = {
	added: "A",
	modified: "M",
	deleted: "D",
	renamed: "R",
	untracked: "U",
};

function formatTimestamp(date: Date): string {
	return date.toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
	});
}

function StatusBadge({ status }: { status: FileStatus }) {
	return (
		<span className={`changes-badge changes-badge--${status}`}>
			{BADGE_LABELS[status]}
		</span>
	);
}

const WRITES_DISABLED_TITLE = "The server does not allow changes";

export function ChangesPage({
	writesAllowed = true,
}: {
	writesAllowed?: boolean;
}) {
	const { showError } = useErrorBanner();
	const { repoName } = useSession();
	const [searchParams, setSearchParams] = useSearchParams();
	const [files, setFiles] = useState<StatusEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [notGitRepo, setNotGitRepo] = useState(false);
	const [actionPending, setActionPending] = useState(false);
	const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
	const [diff, setDiff] = useState<string | null>(null);
	const [comparisonContent, setComparisonContent] = useState<
		string | undefined
	>(undefined);
	// Bumped after a stage so the base-content and diff effects refetch, shrinking
	// the editor's change decorations to whatever remains unstaged.
	const [refreshToken, setRefreshToken] = useState(0);
	// Bumped after a save, which changes the working tree but not the index, so
	// only git's diff needs refetching.
	const [diffRefreshToken, setDiffRefreshToken] = useState(0);
	const abortRef = useRef<AbortController | null>(null);
	const diffAbortRef = useRef<AbortController | null>(null);
	const comparisonAbortRef = useRef<AbortController | null>(null);
	const selectedPath = searchParams.get("path");
	const selectedStaged = searchParams.get("staged");
	const hasSelectedFile =
		selectedPath !== null &&
		(selectedStaged === "true" || selectedStaged === "false");
	const selected = hasSelectedFile
		? {
				path: selectedPath,
				staged: selectedStaged === "true",
			}
		: null;
	const selectedStatus = selected
		? (files.find(
				(file) =>
					file.path === selected.path && file.staged === selected.staged,
			)?.status ?? null)
		: null;
	const isDeleted = selectedStatus === "deleted";
	// An unstaged, non-deleted change opens in the working-tree editor; a staged,
	// non-deleted change opens read-only against the index for line-level
	// unstaging; a deleted file opens read-only against the version being removed.
	// Every change type now opens in the editor, so there is no separate diff view.
	const selectedEditable = selected !== null && !selected.staged && !isDeleted;
	const selectedUnstageable = selected?.staged === true && !isDeleted;
	const selectedDeleted = selected !== null && isDeleted;
	const selectedInEditor = selectedEditable || selectedUnstageable;
	const selectedView =
		selected === null
			? null
			: selectedEditable
				? "edit"
				: selectedUnstageable
					? "unstage"
					: "deleted";

	// Abort any in-flight requests on unmount
	useEffect(() => {
		return () => {
			abortRef.current?.abort();
			diffAbortRef.current?.abort();
			comparisonAbortRef.current?.abort();
		};
	}, []);

	const fetchStatus = useCallback(
		async (isRefresh = false) => {
			// Abort any in-flight request before starting a new one
			abortRef.current?.abort();

			if (isRefresh) {
				setRefreshing(true);
			} else {
				setLoading(true);
			}

			const controller = new AbortController();
			abortRef.current = controller;

			try {
				const res = await fetch(
					apiUrl(
						`/api/git/status?repo=${encodeURIComponent(repoName as string)}`,
					),
					{
						signal: controller.signal,
					},
				);
				if (res.ok) {
					const data: StatusResponse = await res.json();
					setFiles(data.files);
					setNotGitRepo(false);
					setLastRefreshed(new Date());
				} else {
					const body = await res.json().catch(() => null);
					if (body?.error?.code === "NOT_GIT_REPO") {
						setNotGitRepo(true);
						setFiles([]);
					} else {
						showError(body?.error?.message ?? `Request failed (${res.status})`);
					}
				}
			} catch (err) {
				if (err instanceof DOMException && err.name === "AbortError") {
					return; // Request superseded or component unmounted
				}
				showError(err instanceof Error ? err.message : "Network error");
			}

			setLoading(false);
			setRefreshing(false);
		},
		[showError, repoName],
	);

	// Initial fetch
	useEffect(() => {
		fetchStatus();
	}, [fetchStatus]);

	// Poll every 3 seconds while the tab is visible
	useEffect(() => {
		// Every selected file now opens in the editor, so skip the poll whenever one
		// is open: a refetch would disrupt the buffer being edited, or flip a
		// read-only view out from under the reader.
		const inEditor = selectedView !== null;

		function handleVisibilityChange() {
			if (document.visibilityState === "visible" && !inEditor) {
				fetchStatus(true);
			}
		}

		document.addEventListener("visibilitychange", handleVisibilityChange);
		const interval = setInterval(() => {
			if (document.visibilityState === "visible" && !inEditor) {
				fetchStatus(true);
			}
		}, 3000);

		return () => {
			document.removeEventListener("visibilitychange", handleVisibilityChange);
			clearInterval(interval);
		};
	}, [fetchStatus, selectedView]);

	const handleRefresh = useCallback(() => {
		fetchStatus(true);
	}, [fetchStatus]);

	const handleSelectFile = useCallback(
		(entry: StatusEntry) => {
			setSearchParams({
				path: entry.path,
				staged: String(entry.staged),
			});
		},
		[setSearchParams],
	);

	const applyStageAction = useCallback(
		async (filePath: string, action: "stage" | "unstage"): Promise<boolean> => {
			setActionPending(true);
			try {
				const res = await fetch(
					apiUrl(
						`/api/git/${action}?repo=${encodeURIComponent(repoName as string)}`,
					),
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ path: filePath }),
					},
				);
				if (!res.ok) {
					const body = await res.json().catch(() => null);
					showError(body?.error?.message ?? `Request failed (${res.status})`);
					return false;
				}
				const data: StatusResponse = await res.json();
				setFiles(data.files);
				setLastRefreshed(new Date());
				return true;
			} catch (err) {
				showError(err instanceof Error ? err.message : "Network error");
				return false;
			} finally {
				setActionPending(false);
			}
		},
		[repoName, showError],
	);

	const handleToggleStage = useCallback(
		(entry: StatusEntry) => {
			void applyStageAction(entry.path, entry.staged ? "unstage" : "stage");
		},
		[applyStageAction],
	);

	const handleEditorSaved = useCallback(() => {
		setDiffRefreshToken((value) => value + 1);
		fetchStatus(true);
	}, [fetchStatus]);

	const handleEditorStaged = useCallback(() => {
		setRefreshToken((value) => value + 1);
		fetchStatus(true);
	}, [fetchStatus]);

	const handleEditorUnstaged = useCallback(() => {
		setRefreshToken((value) => value + 1);
		fetchStatus(true);
	}, [fetchStatus]);

	const handleBack = useCallback(() => {
		diffAbortRef.current?.abort();
		comparisonAbortRef.current?.abort();
		setDiff(null);
		setComparisonContent(undefined);
		setSearchParams({}, { replace: true });
	}, [setSearchParams]);

	const handleDetailStageToggle = useCallback(async () => {
		if (!selected) return;
		// Staging can move the file between sections, so the current selection may
		// no longer exist afterwards; return to the list showing the new state.
		const ok = await applyStageAction(
			selected.path,
			selected.staged ? "unstage" : "stage",
		);
		if (ok) handleBack();
	}, [applyStageAction, handleBack, selected]);

	useEffect(() => {
		comparisonAbortRef.current?.abort();

		if (
			!hasSelectedFile ||
			!repoName ||
			selectedPath === null ||
			!selectedInEditor
		) {
			setComparisonContent(undefined);
			return;
		}

		if (selectedStatus === "untracked") {
			setComparisonContent("");
			return;
		}

		const controller = new AbortController();
		comparisonAbortRef.current = controller;
		setComparisonContent(undefined);

		void (async () => {
			try {
				const params = new URLSearchParams({
					repo: repoName,
					path: selectedPath,
					staged: selectedStaged ?? "false",
					// Changes after a stage so the index base is refetched fresh.
					_refresh: String(refreshToken),
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
	}, [
		hasSelectedFile,
		repoName,
		selectedInEditor,
		selectedPath,
		selectedStaged,
		selectedStatus,
		showError,
		refreshToken,
	]);

	useEffect(() => {
		diffAbortRef.current?.abort();

		// The editor only needs a diff to decorate a tracked modification it is
		// editing or unstaging. Untracked and deleted files decorate straight from
		// their content, so they need no diff.
		if (
			!hasSelectedFile ||
			!repoName ||
			selectedPath === null ||
			selectedStatus === "untracked" ||
			selectedStatus === "deleted" ||
			selectedStatus === null
		) {
			setDiff(null);
			return;
		}

		const controller = new AbortController();
		diffAbortRef.current = controller;
		setDiff(null);

		void (async () => {
			try {
				const params = new URLSearchParams({
					repo: repoName,
					path: selectedPath,
					staged: selectedStaged ?? "false",
					_refresh: `${refreshToken}.${diffRefreshToken}`,
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
	}, [
		hasSelectedFile,
		repoName,
		selectedPath,
		selectedStaged,
		selectedStatus,
		showError,
		refreshToken,
		diffRefreshToken,
	]);

	// Detail view: every change type opens in the editor.
	if (selected) {
		return (
			<div className="changes-diff-view">
				<header className="changes-diff-header">
					<button
						type="button"
						className="changes-back-button"
						onClick={handleBack}
						aria-label="Back to changes list"
					>
						<ArrowLeft size={18} />
					</button>
					<span className="changes-diff-filename">{selected.path}</span>
					<span className="changes-diff-staged-label">
						{selected.staged ? "staged" : "unstaged"}
					</span>
					<button
						type="button"
						className="changes-header-button"
						onClick={() => {
							void handleDetailStageToggle();
						}}
						disabled={actionPending || !writesAllowed}
						title={writesAllowed ? undefined : WRITES_DISABLED_TITLE}
					>
						{selected.staged ? "Unstage" : "Stage"}
					</button>
				</header>
				<div className="changes-diff-content">
					{selectedView === "edit" && selectedEditable && (
						<div className="changes-editor-view">
							<div className="changes-editor-note">
								Editing the working tree file.
							</div>
							<TextFileEditor
								comparisonContent={comparisonContent}
								changeDiff={selectedStatus === "untracked" ? null : diff}
								changeType={selectedStatus}
								filePath={selected.path}
								repo={repoName as string}
								readOnly={!writesAllowed}
								readOnlyLabel={WRITES_DISABLED_LABEL}
								onSaved={handleEditorSaved}
								onStaged={handleEditorStaged}
							/>
						</div>
					)}
					{selectedView === "unstage" && selectedUnstageable && (
						<div className="changes-editor-view">
							<div className="changes-editor-note">Viewing staged content.</div>
							<TextFileEditor
								comparisonContent={comparisonContent}
								changeDiff={diff}
								changeType={selectedStatus}
								filePath={selected.path}
								repo={repoName as string}
								readOnly={!writesAllowed}
								readOnlyLabel={WRITES_DISABLED_LABEL}
								staged
								onUnstaged={handleEditorUnstaged}
							/>
						</div>
					)}
					{selectedView === "deleted" && selectedDeleted && (
						<div className="changes-editor-view">
							<div className="changes-editor-note">
								Viewing the deleted file. Use{" "}
								{selected.staged ? "Unstage" : "Stage"} above to{" "}
								{selected.staged ? "restore it" : "stage the deletion"}.
							</div>
							<TextFileEditor
								changeType="deleted"
								filePath={selected.path}
								repo={repoName as string}
								staged={selected.staged}
								deleted
							/>
						</div>
					)}
				</div>
			</div>
		);
	}

	const staged = files.filter((f) => f.staged);
	const unstaged = files.filter((f) => !f.staged);

	// File list view
	return (
		<div className="changes-page">
			<header className="changes-header">
				<div className="changes-header-left">
					<span className="changes-header-title">Changes</span>
				</div>
				<button
					type="button"
					className={`changes-refresh-button${refreshing ? " changes-refresh-button--spinning" : ""}`}
					onClick={handleRefresh}
					aria-label="Refresh status"
					title="Refresh"
				>
					<RefreshCw size={18} />
				</button>
			</header>

			{lastRefreshed && (
				<div className="changes-timestamp">
					Last refreshed {formatTimestamp(lastRefreshed)}
				</div>
			)}

			{!writesAllowed && (
				<div className="changes-readonly-note" role="note">
					Read-only: the server does not allow changes, so staging and editing
					are disabled.
				</div>
			)}

			<div className="changes-list">
				{loading && <div className="changes-message">Loading...</div>}

				{!loading && notGitRepo && (
					<div className="changes-error">Not a git repository</div>
				)}

				{!loading && !notGitRepo && files.length === 0 && (
					<div className="changes-message">Working tree clean</div>
				)}

				{!loading && !notGitRepo && files.length > 0 && (
					<>
						{staged.length > 0 && (
							<>
								<div className="changes-section-header">
									Staged
									<span className="changes-section-count">{staged.length}</span>
								</div>
								{staged.map((entry) => (
									<div
										className="changes-file-row"
										key={`staged-${entry.path}`}
									>
										<button
											type="button"
											className="changes-file-entry"
											onClick={() => handleSelectFile(entry)}
										>
											<StatusBadge status={entry.status} />
											<span className="changes-file-path">{entry.path}</span>
										</button>
										<button
											type="button"
											className="changes-file-action"
											onClick={() => handleToggleStage(entry)}
											disabled={actionPending || !writesAllowed}
											aria-label={`Unstage ${entry.path}`}
											title={writesAllowed ? "Unstage" : WRITES_DISABLED_TITLE}
										>
											<Minus size={18} />
										</button>
									</div>
								))}
							</>
						)}

						{unstaged.length > 0 && (
							<>
								<div className="changes-section-header">
									Unstaged
									<span className="changes-section-count">
										{unstaged.length}
									</span>
								</div>
								{unstaged.map((entry) => (
									<div
										className="changes-file-row"
										key={`unstaged-${entry.path}`}
									>
										<button
											type="button"
											className="changes-file-entry"
											onClick={() => handleSelectFile(entry)}
										>
											<StatusBadge status={entry.status} />
											<span className="changes-file-path">{entry.path}</span>
										</button>
										<button
											type="button"
											className="changes-file-action"
											onClick={() => handleToggleStage(entry)}
											disabled={actionPending || !writesAllowed}
											aria-label={`Stage ${entry.path}`}
											title={writesAllowed ? "Stage" : WRITES_DISABLED_TITLE}
										>
											<Plus size={18} />
										</button>
									</div>
								))}
							</>
						)}
					</>
				)}
			</div>
		</div>
	);
}
