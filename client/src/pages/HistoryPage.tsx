import { ArrowLeft, ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "../apiUrl.ts";
import { DiffViewer } from "../components/DiffViewer.tsx";
import { useErrorBanner } from "../components/ErrorBanner.tsx";
import "./HistoryPage.css";

interface Commit {
	hash: string;
	author: string;
	date: string;
	subject: string;
}

interface LogResponse {
	commits: Commit[];
}

interface CommitFile {
	path: string;
	status: string;
	additions: number;
	deletions: number;
}

interface CommitDetailResponse {
	hash: string;
	author: string;
	date: string;
	subject: string;
	files: CommitFile[];
}

interface DiffResponse {
	diff: string;
	truncated: boolean;
}

const PAGE_SIZE = 25;

const STATUS_LABELS: Record<string, string> = {
	A: "A",
	M: "M",
	D: "D",
	R: "R",
	C: "C",
	T: "T",
};

function formatRelativeDate(isoDate: string): string {
	const date = new Date(isoDate);
	const now = new Date();
	const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;
	const years = Math.floor(days / 365);
	return `${years}y ago`;
}

function StatusBadge({ status }: { status: string }) {
	const label = STATUS_LABELS[status] ?? status;
	const className =
		status === "A"
			? "added"
			: status === "D"
				? "deleted"
				: status === "R"
					? "renamed"
					: "modified";
	return (
		<span className={`history-badge history-badge--${className}`}>{label}</span>
	);
}

export function HistoryPage() {
	const { showError } = useErrorBanner();
	const [commits, setCommits] = useState<Commit[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [hasMore, setHasMore] = useState(true);
	const [notGitRepo, setNotGitRepo] = useState(false);
	const [expandedHash, setExpandedHash] = useState<string | null>(null);
	const expandedHashRef = useRef<string | null>(null);
	const [expandedFiles, setExpandedFiles] = useState<CommitFile[]>([]);
	const [expandedLoading, setExpandedLoading] = useState(false);
	const [selectedFile, setSelectedFile] = useState<{
		hash: string;
		path: string;
	} | null>(null);
	const [diff, setDiff] = useState<string | null>(null);
	const [diffTruncated, setDiffTruncated] = useState(false);
	const [diffLoading, setDiffLoading] = useState(false);
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => {
		return () => {
			abortRef.current?.abort();
		};
	}, []);

	const fetchLog = useCallback(
		async (offset: number, append: boolean) => {
			abortRef.current?.abort();
			const controller = new AbortController();
			abortRef.current = controller;

			if (append) {
				setLoadingMore(true);
			} else {
				setLoading(true);
			}

			try {
				const params = new URLSearchParams({
					limit: String(PAGE_SIZE),
					offset: String(offset),
				});
				const res = await fetch(apiUrl(`/api/git/log?${params}`), {
					signal: controller.signal,
				});

				if (res.ok) {
					const data: LogResponse = await res.json();
					setNotGitRepo(false);
					if (append) {
						setCommits((prev) => [...prev, ...data.commits]);
					} else {
						setCommits(data.commits);
					}
					setHasMore(data.commits.length === PAGE_SIZE);
				} else {
					const body = await res.json().catch(() => null);
					if (body?.error?.code === "NOT_GIT_REPO") {
						setNotGitRepo(true);
						setCommits([]);
					} else {
						showError(body?.error?.message ?? `Request failed (${res.status})`);
					}
				}
			} catch (err) {
				if (err instanceof DOMException && err.name === "AbortError") return;
				showError(err instanceof Error ? err.message : "Network error");
			}

			setLoading(false);
			setLoadingMore(false);
		},
		[showError],
	);

	useEffect(() => {
		fetchLog(0, false);
	}, [fetchLog]);

	const handleLoadMore = useCallback(() => {
		fetchLog(commits.length, true);
	}, [fetchLog, commits.length]);

	const handleToggleCommit = useCallback(
		async (hash: string) => {
			if (expandedHashRef.current === hash) {
				setExpandedHash(null);
				expandedHashRef.current = null;
				setExpandedFiles([]);
				return;
			}

			setExpandedHash(hash);
			expandedHashRef.current = hash;
			setExpandedFiles([]);
			setExpandedLoading(true);

			try {
				const res = await fetch(
					apiUrl(`/api/git/commit/${encodeURIComponent(hash)}`),
				);
				if (expandedHashRef.current !== hash) return;
				if (res.ok) {
					const data: CommitDetailResponse = await res.json();
					setExpandedFiles(data.files);
				} else {
					const body = await res.json().catch(() => null);
					showError(body?.error?.message ?? `Request failed (${res.status})`);
				}
			} catch (err) {
				if (expandedHashRef.current !== hash) return;
				showError(err instanceof Error ? err.message : "Network error");
			}

			setExpandedLoading(false);
		},
		[showError],
	);

	const handleSelectFile = useCallback(
		async (hash: string, filePath: string) => {
			setSelectedFile({ hash, path: filePath });
			setDiffLoading(true);
			setDiff(null);
			setDiffTruncated(false);

			try {
				const params = new URLSearchParams({ path: filePath });
				const res = await fetch(
					apiUrl(`/api/git/commit/${encodeURIComponent(hash)}/diff?${params}`),
				);
				if (res.ok) {
					const data: DiffResponse = await res.json();
					setDiff(data.diff);
					setDiffTruncated(data.truncated);
				} else {
					const body = await res.json().catch(() => null);
					showError(body?.error?.message ?? `Request failed (${res.status})`);
				}
			} catch (err) {
				showError(err instanceof Error ? err.message : "Network error");
			}

			setDiffLoading(false);
		},
		[showError],
	);

	const handleBackFromDiff = useCallback(() => {
		setSelectedFile(null);
		setDiff(null);
		setDiffTruncated(false);
	}, []);

	// Diff view
	if (selectedFile) {
		return (
			<div className="history-diff-view">
				<header className="history-diff-header">
					<button
						type="button"
						className="history-back-button"
						onClick={handleBackFromDiff}
						aria-label="Back to commit"
					>
						<ArrowLeft size={18} />
					</button>
					<span className="history-diff-filename">{selectedFile.path}</span>
					<span className="history-diff-hash">
						{selectedFile.hash.slice(0, 7)}
					</span>
				</header>
				<div className="history-diff-content">
					{diffLoading && (
						<div className="history-message">Loading diff...</div>
					)}
					{!diffLoading && diff !== null && diff.length === 0 && (
						<div className="history-message">No diff available</div>
					)}
					{!diffLoading && diff !== null && diff.length > 0 && (
						<DiffViewer diff={diff} />
					)}
					{diffTruncated && (
						<div className="history-diff-truncated">
							Diff truncated (exceeds 1 MB)
						</div>
					)}
				</div>
			</div>
		);
	}

	// Commit list view
	return (
		<div className="history-page">
			<header className="history-header">
				<span className="history-header-title">History</span>
			</header>

			<div className="history-list">
				{loading && <div className="history-message">Loading...</div>}

				{!loading && notGitRepo && (
					<div className="history-error">Not a git repository</div>
				)}

				{!loading && !notGitRepo && commits.length === 0 && (
					<div className="history-message">No commits yet</div>
				)}

				{!loading &&
					!notGitRepo &&
					commits.map((commit) => (
						<div key={commit.hash} className="history-commit">
							<button
								type="button"
								className="history-commit-row"
								onClick={() => handleToggleCommit(commit.hash)}
							>
								<span className="history-commit-chevron">
									{expandedHash === commit.hash ? (
										<ChevronDown size={16} />
									) : (
										<ChevronRight size={16} />
									)}
								</span>
								<span className="history-commit-info">
									<span className="history-commit-subject">
										{commit.subject}
									</span>
									<span className="history-commit-meta">
										<span className="history-commit-hash">
											{commit.hash.slice(0, 7)}
										</span>
										<span className="history-commit-author">
											{commit.author}
										</span>
										<span className="history-commit-date">
											{formatRelativeDate(commit.date)}
										</span>
									</span>
								</span>
							</button>

							{expandedHash === commit.hash && (
								<div className="history-commit-files">
									{expandedLoading && (
										<div className="history-message history-message--inline">
											Loading files...
										</div>
									)}
									{!expandedLoading && expandedFiles.length === 0 && (
										<div className="history-message history-message--inline">
											No changed files
										</div>
									)}
									{!expandedLoading &&
										expandedFiles.map((file) => (
											<button
												type="button"
												key={file.path}
												className="history-file-entry"
												onClick={() => handleSelectFile(commit.hash, file.path)}
											>
												<StatusBadge status={file.status} />
												<span className="history-file-path">{file.path}</span>
												<span className="history-file-stats">
													{file.additions > 0 && (
														<span className="history-stat-add">
															+{file.additions}
														</span>
													)}
													{file.deletions > 0 && (
														<span className="history-stat-del">
															-{file.deletions}
														</span>
													)}
												</span>
											</button>
										))}
								</div>
							)}
						</div>
					))}

				{!loading && !notGitRepo && hasMore && commits.length > 0 && (
					<button
						type="button"
						className="history-load-more"
						onClick={handleLoadMore}
						disabled={loadingMore}
					>
						{loadingMore ? "Loading..." : "Load more"}
					</button>
				)}
			</div>
		</div>
	);
}
