import { ArrowLeft, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiUrl } from "../apiUrl.ts";
import { DiffViewer } from "../components/DiffViewer.tsx";
import { useErrorBanner } from "../components/ErrorBanner.tsx";
import { TextFileEditor } from "../components/TextFileEditor.tsx";
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

function canEditEntry(entry: Pick<StatusEntry, "staged" | "status">): boolean {
	return !entry.staged && entry.status !== "deleted";
}

export function ChangesPage() {
	const { showError } = useErrorBanner();
	const { repoName } = useSession();
	const [searchParams, setSearchParams] = useSearchParams();
	const [files, setFiles] = useState<StatusEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [notGitRepo, setNotGitRepo] = useState(false);
	const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
	const [diff, setDiff] = useState<string | null>(null);
	const [diffTruncated, setDiffTruncated] = useState(false);
	const [diffLoading, setDiffLoading] = useState(false);
	const [comparisonContent, setComparisonContent] = useState<
		string | undefined
	>(undefined);
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
	const selectedEditable =
		selected !== null && !selected.staged && selectedStatus !== "deleted";
	const selectedView =
		selected === null
			? null
			: searchParams.get("view") === "diff" && selectedEditable
				? "diff"
				: selectedEditable
					? "edit"
					: "diff";

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
		function handleVisibilityChange() {
			if (document.visibilityState === "visible" && selectedView !== "edit") {
				fetchStatus(true);
			}
		}

		document.addEventListener("visibilitychange", handleVisibilityChange);
		const interval = setInterval(() => {
			if (document.visibilityState === "visible" && selectedView !== "edit") {
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

	const handleShowFile = useCallback(() => {
		if (!selected || !selectedEditable) return;

		setSearchParams({
			path: selected.path,
			staged: String(selected.staged),
		});
	}, [selected, selectedEditable, setSearchParams]);

	const handleShowDiff = useCallback(() => {
		if (!selected || !selectedEditable) return;

		setSearchParams(
			{
				path: selected.path,
				staged: String(selected.staged),
				view: "diff",
			},
			{ replace: true },
		);
	}, [selected, selectedEditable, setSearchParams]);

	const handleEditorSaved = useCallback(() => {
		fetchStatus(true);
	}, [fetchStatus]);

	const handleBack = useCallback(() => {
		diffAbortRef.current?.abort();
		comparisonAbortRef.current?.abort();
		setDiff(null);
		setDiffTruncated(false);
		setDiffLoading(false);
		setComparisonContent(undefined);
		setSearchParams({}, { replace: true });
	}, [setSearchParams]);

	useEffect(() => {
		comparisonAbortRef.current?.abort();

		if (
			!hasSelectedFile ||
			!repoName ||
			selectedPath === null ||
			!selectedEditable
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
				});
				const res = await fetch(apiUrl(`/api/git/base-content?${params}`), {
					signal: controller.signal,
				});
				if (!res.ok) {
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
		selectedEditable,
		selectedPath,
		selectedStaged,
		selectedStatus,
		showError,
	]);

	useEffect(() => {
		diffAbortRef.current?.abort();

		if (
			!hasSelectedFile ||
			!repoName ||
			selectedPath === null ||
			(selectedView === "edit" && selectedStatus === "untracked")
		) {
			setDiff(null);
			setDiffTruncated(false);
			setDiffLoading(false);
			return;
		}

		const controller = new AbortController();
		diffAbortRef.current = controller;
		setDiffLoading(true);
		setDiff(null);
		setDiffTruncated(false);

		void (async () => {
			try {
				if (selectedStatus === "untracked") {
					const params = new URLSearchParams({
						repo: repoName,
						path: selectedPath,
					});
					const res = await fetch(apiUrl(`/api/files/content?${params}`), {
						signal: controller.signal,
					});
					if (!res.ok) {
						const body = await res.json().catch(() => null);
						showError(body?.error?.message ?? `Request failed (${res.status})`);
						return;
					}

					setDiff(await res.text());
					setDiffTruncated(false);
				} else {
					const params = new URLSearchParams({
						repo: repoName,
						path: selectedPath,
						staged: selectedStaged,
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
					setDiffTruncated(data.truncated);
				}
			} catch (err) {
				if (err instanceof DOMException && err.name === "AbortError") {
					return;
				}
				showError(err instanceof Error ? err.message : "Network error");
			} finally {
				if (!controller.signal.aborted) {
					setDiffLoading(false);
				}
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
		selectedView,
		showError,
	]);

	// Diff view
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
					{selectedEditable && selectedView === "diff" && (
						<button
							type="button"
							className="changes-header-button"
							onClick={handleShowFile}
						>
							Show file
						</button>
					)}
					{selectedEditable && selectedView === "edit" && (
						<button
							type="button"
							className="changes-header-button"
							onClick={() => {
								void handleShowDiff();
							}}
						>
							Show diff
						</button>
					)}
				</header>
				<div className="changes-diff-content">
					{selectedView === "diff" && (
						<>
							{diffLoading && (
								<div className="changes-message">Loading diff...</div>
							)}
							{!diffLoading && diff !== null && diff.length === 0 && (
								<div className="changes-message">No diff available</div>
							)}
							{!diffLoading && diff !== null && diff.length > 0 && (
								<DiffViewer diff={diff} />
							)}
							{diffTruncated && (
								<div className="changes-diff-truncated">
									Diff truncated (exceeds 1 MB)
								</div>
							)}
						</>
					)}
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
								onSaved={handleEditorSaved}
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
									<button
										type="button"
										key={`staged-${entry.path}`}
										className="changes-file-entry"
										onClick={() => handleSelectFile(entry)}
									>
										<StatusBadge status={entry.status} />
										<span className="changes-file-path">{entry.path}</span>
									</button>
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
									<button
										type="button"
										key={`unstaged-${entry.path}`}
										className="changes-file-entry"
										onClick={() => handleSelectFile(entry)}
									>
										<StatusBadge status={entry.status} />
										<span className="changes-file-path">{entry.path}</span>
									</button>
								))}
							</>
						)}
					</>
				)}
			</div>
		</div>
	);
}
