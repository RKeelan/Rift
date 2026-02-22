import { ArrowLeft, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DiffViewer } from "../components/DiffViewer.tsx";
import { useErrorBanner } from "../components/ErrorBanner.tsx";
import { useApi } from "../hooks/useApi.ts";
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

interface SelectedFile {
	path: string;
	staged: boolean;
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

export function ChangesPage() {
	const { request } = useApi();
	const { showError } = useErrorBanner();
	const [files, setFiles] = useState<StatusEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [notGitRepo, setNotGitRepo] = useState(false);
	const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
	const [selected, setSelected] = useState<SelectedFile | null>(null);
	const [diff, setDiff] = useState<string | null>(null);
	const [diffTruncated, setDiffTruncated] = useState(false);
	const [diffLoading, setDiffLoading] = useState(false);
	const abortRef = useRef<AbortController | null>(null);

	// Abort any in-flight status fetch on unmount
	useEffect(() => {
		return () => {
			abortRef.current?.abort();
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
				const res = await fetch("/api/git/status", {
					signal: controller.signal,
				});
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
		[showError],
	);

	// Initial fetch
	useEffect(() => {
		fetchStatus();
	}, [fetchStatus]);

	// Poll every 3 seconds while the tab is visible
	useEffect(() => {
		function handleVisibilityChange() {
			if (document.visibilityState === "visible") {
				fetchStatus(true);
			}
		}

		document.addEventListener("visibilitychange", handleVisibilityChange);
		const interval = setInterval(() => {
			if (document.visibilityState === "visible") {
				fetchStatus(true);
			}
		}, 3000);

		return () => {
			document.removeEventListener("visibilitychange", handleVisibilityChange);
			clearInterval(interval);
		};
	}, [fetchStatus]);

	const handleRefresh = useCallback(() => {
		fetchStatus(true);
	}, [fetchStatus]);

	const handleSelectFile = useCallback(
		async (entry: StatusEntry) => {
			setSelected({ path: entry.path, staged: entry.staged });
			setDiffLoading(true);
			setDiff(null);
			setDiffTruncated(false);

			const params = new URLSearchParams({
				path: entry.path,
				staged: String(entry.staged),
			});
			const data = await request<DiffResponse>(`/api/git/diff?${params}`);

			if (data) {
				setDiff(data.diff);
				setDiffTruncated(data.truncated);
			}
			setDiffLoading(false);
		},
		[request],
	);

	const handleBack = useCallback(() => {
		setSelected(null);
		setDiff(null);
		setDiffTruncated(false);
	}, []);

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
				</header>
				<div className="changes-diff-content">
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
