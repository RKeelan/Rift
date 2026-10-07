import { ArrowLeft, Minus, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiUrl } from "../apiUrl.ts";
import { useErrorBanner } from "../components/ErrorBanner.tsx";
import {
	type FileAction,
	WRITES_DISABLED_LABEL,
	WRITES_UNKNOWN_LABEL,
} from "../components/TextFileEditor.tsx";
import { useSession } from "../contexts/SessionContext.tsx";
import { clearDraft } from "../drafts.ts";
import { readString, writeString } from "../storage.ts";
import { type FileStatus, FileSideView } from "./FileSideView.tsx";
import "./ChangesPage.css";

interface StatusEntry {
	path: string;
	status: FileStatus;
	staged: boolean;
}

interface StatusResponse {
	files: StatusEntry[];
}

interface CommitResponse extends StatusResponse {
	commit: string;
}

// How long the new commit's hash stands in for the refresh time.
const COMMIT_NOTE_MS = 10_000;

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
	writesAllowed?: boolean | null;
}) {
	// Whether the server allows changes is unknown (null) until it answers,
	// and nothing offers a change until then.
	const canWrite = writesAllowed === true;
	const writesRefused = writesAllowed === false;
	const editorReadOnlyLabel = writesRefused
		? WRITES_DISABLED_LABEL
		: WRITES_UNKNOWN_LABEL;
	const { showError } = useErrorBanner();
	const { repoName } = useSession();
	const [searchParams, setSearchParams] = useSearchParams();
	const [files, setFiles] = useState<StatusEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [notGitRepo, setNotGitRepo] = useState(false);
	const [actionPending, setActionPending] = useState(false);
	const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
	// Bumped after a stage so each side refetches its comparison and diff,
	// shrinking the editor's change decorations to whatever remains unstaged.
	const [refreshToken, setRefreshToken] = useState(0);
	// Bumped when the working tree stages lines or reloads, either of which can
	// change the index the staged side shows.
	const [stagedContentToken, setStagedContentToken] = useState(0);
	// Bumped on a reload, which can find a new commit, so the staged side
	// refetches HEAD, which nothing in Rift changes while a file is open.
	const [headToken, setHeadToken] = useState(0);
	// Bumped after a save, which changes the working tree but not the index, so
	// only git's diff needs refetching.
	const [diffRefreshToken, setDiffRefreshToken] = useState(0);
	// Whether the open editor holds unsaved edits, which leaving the file would
	// lose and staging the whole file would leave out.
	const [editorDirty, setEditorDirty] = useState(false);
	const [confirmingDiscard, setConfirmingDiscard] = useState(false);
	// The header slot the open editor puts its menu in.
	const [menuHost, setMenuHost] = useState<HTMLElement | null>(null);
	// The commit message being written, kept per repo so that opening a file or
	// leaving the tab doesn't lose a message typed on a phone.
	const commitDraftKey = `rift:commit-draft:${repoName}`;
	const [commitMessage, setCommitMessage] = useState(() =>
		readString(commitDraftKey),
	);
	const [committing, setCommitting] = useState(false);
	// The short hash of the commit just made, shown for a while after it.
	const [lastCommit, setLastCommit] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);
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
	const fileOpen = selected !== null;
	// The sides of the open file with changes: the working tree's unstaged
	// ones, the index's staged ones, or both.
	const statusOf = (staged: boolean) =>
		files.find(
			(entry) => entry.path === selectedPath && entry.staged === staged,
		)?.status ?? null;

	// Abort any in-flight requests on unmount
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
		// Every selected file opens in the editor, so skip the poll whenever one
		// is open: a refetch would disrupt the buffer being edited, or flip a
		// read-only view out from under the reader.
		const inEditor = fileOpen;

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
	}, [fetchStatus, fileOpen]);

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

	// The box takes the stored draft each time it appears, so a message that
	// was committed while the box was gone, as when the page was left and
	// reopened during a commit, is not offered again. It takes the draft while
	// rendering, not in an effect, so the box never appears holding the message
	// it had before.
	const hasStaged = files.some((entry) => entry.staged);
	const boxDraftKey = hasStaged ? commitDraftKey : null;
	const [takenDraftKey, setTakenDraftKey] = useState<string | null>(null);
	if (boxDraftKey !== takenDraftKey) {
		setTakenDraftKey(boxDraftKey);
		if (boxDraftKey !== null) setCommitMessage(readString(boxDraftKey));
	}

	const handleCommitMessageChange = useCallback(
		(message: string) => {
			setCommitMessage(message);
			writeString(commitDraftKey, message);
		},
		[commitDraftKey],
	);

	const handleCommit = useCallback(async () => {
		if (commitMessage.trim() === "") return;
		setActionPending(true);
		setCommitting(true);
		try {
			const res = await fetch(
				apiUrl(
					`/api/git/commit?repo=${encodeURIComponent(repoName as string)}`,
				),
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ message: commitMessage }),
				},
			);
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				showError(body?.error?.message ?? `Request failed (${res.status})`);
				return;
			}
			const data: CommitResponse = await res.json();
			setFiles(data.files);
			setLastRefreshed(new Date());
			// The box is read-only while the commit is in flight, so the draft
			// cleared here is the message that was committed.
			handleCommitMessageChange("");
			setLastCommit(data.commit.slice(0, 7));
		} catch (err) {
			showError(err instanceof Error ? err.message : "Network error");
		} finally {
			setActionPending(false);
			setCommitting(false);
		}
	}, [commitMessage, handleCommitMessageChange, repoName, showError]);

	useEffect(() => {
		if (lastCommit === null) return;
		const timer = setTimeout(() => setLastCommit(null), COMMIT_NOTE_MS);
		return () => clearTimeout(timer);
	}, [lastCommit]);

	const handleEditorSaved = useCallback(() => {
		setDiffRefreshToken((value) => value + 1);
		fetchStatus(true);
	}, [fetchStatus]);

	// A stage or unstage from the editor answers with the repo's changes, which
	// take the place of any status still on its way, read before them. They are
	// set with the tokens that refetch each side's context, so a side whose
	// status the action changed, as an untracked file's does when some of its
	// lines are staged, goes straight to the requests its new status needs.
	const applyChangedFiles = useCallback((changed: StatusEntry[]) => {
		abortRef.current?.abort();
		setFiles(changed);
		setLastRefreshed(new Date());
		setLoading(false);
		setRefreshing(false);
	}, []);

	const handleEditorStaged = useCallback(
		(changed: StatusEntry[]) => {
			applyChangedFiles(changed);
			setRefreshToken((value) => value + 1);
			setStagedContentToken((value) => value + 1);
		},
		[applyChangedFiles],
	);

	const handleEditorUnstaged = useCallback(
		(changed: StatusEntry[]) => {
			applyChangedFiles(changed);
			setRefreshToken((value) => value + 1);
		},
		[applyChangedFiles],
	);

	// Reloading rereads the file, and git's diff and the comparison have to be
	// reread with it for the editor's line numbers to match git's again. The
	// status is reread too, since the poll is off while a file is open, and
	// changes from outside Rift decide which sides have changes. A reload of
	// the working tree also reloads the staged side, which reloads itself.
	const handleEditorReload = useCallback(
		(staged: boolean) => {
			setRefreshToken((value) => value + 1);
			setHeadToken((value) => value + 1);
			if (!staged) setStagedContentToken((value) => value + 1);
			fetchStatus(true);
		},
		[fetchStatus],
	);

	const leaveDetail = useCallback(() => {
		setConfirmingDiscard(false);
		setEditorDirty(false);
		setSearchParams({}, { replace: true });
	}, [setSearchParams]);

	// Leaving through the back button asks first when there are unsaved edits.
	// Other ways out, such as a back gesture, cannot be held up, so the editor
	// keeps the edits as a draft and offers them back when the file reopens.
	const handleBack = useCallback(() => {
		if (editorDirty) {
			setConfirmingDiscard(true);
			return;
		}
		leaveDetail();
	}, [editorDirty, leaveDetail]);

	const discardAndLeave = useCallback(() => {
		if (repoName && selectedPath !== null) {
			clearDraft(repoName, selectedPath);
		}
		leaveDetail();
	}, [leaveDetail, repoName, selectedPath]);

	useEffect(() => {
		if (!editorDirty) setConfirmingDiscard(false);
	}, [editorDirty]);

	// An untracked file stages whole through the editor, which names the version
	// on screen by its modification time. Like the page's own action on the
	// whole file, staging it returns to the list; staging some of its lines
	// stays in the file, as for any other change.
	const handleUntrackedStaged = useCallback(
		(changed: StatusEntry[]) => {
			applyChangedFiles(changed);
			leaveDetail();
		},
		[applyChangedFiles, leaveDetail],
	);

	const handleWholeFileAction = useCallback(
		async (staged: boolean) => {
			// Staging the whole file acts on it as saved, not as shown, so it
			// waits until the editor's edits are saved.
			if (selectedPath === null || (!staged && editorDirty)) return;
			// Staging can move the file between sections, so the current
			// selection may no longer exist afterwards; return to the list
			// showing the new state. Unstaging while the working tree holds
			// unsaved edits shows the working tree instead, so the edits stay
			// on screen.
			const ok = await applyStageAction(
				selectedPath,
				staged ? "unstage" : "stage",
			);
			if (!ok) return;
			if (staged && editorDirty) {
				setRefreshToken((value) => value + 1);
				setSearchParams(
					{ path: selectedPath, staged: "false" },
					{ replace: true },
				);
			} else {
				leaveDetail();
			}
		},
		[applyStageAction, editorDirty, leaveDetail, selectedPath, setSearchParams],
	);

	// Detail view: every change type opens in the editor.
	if (selected) {
		// Staging or unstaging the whole file, offered in each side's bar.
		const fileActionFor =
			(staged: boolean) =>
			(label: string): FileAction => ({
				label,
				onClick: () => {
					void handleWholeFileAction(staged);
				},
				// The working tree's bar offers Save in its place while the
				// buffer has unsaved edits, so only refused writes need
				// explaining.
				disabled: actionPending || !canWrite || (!staged && editorDirty),
				title: writesRefused ? WRITES_DISABLED_TITLE : undefined,
			});
		// Both sides are always offered, so the bar never comes or goes, and a
		// side with no changes is greyed out. Each side with changes stays built,
		// so switching between them is immediate; switching replaces the history
		// entry, so Back still returns to the list. The working tree counts as
		// having changes while it holds unsaved edits, even ones git hasn't seen.
		const sideIsLive = (staged: boolean) =>
			statusOf(staged) !== null || (!staged && editorDirty);
		const sides = [false, true].filter(
			(staged) => staged === selected.staged || sideIsLive(staged),
		);
		const switchTo = (staged: boolean) => {
			if (staged === selected.staged) return;
			setSearchParams(
				{ path: selected.path, staged: String(staged) },
				{ replace: true },
			);
		};
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
					<div className="changes-header-menu" ref={setMenuHost} />
				</header>
				{confirmingDiscard && (
					<div className="changes-discard-confirm" role="alert">
						<span className="changes-discard-confirm-text">
							Discard unsaved changes?
						</span>
						<button
							type="button"
							className="changes-header-button"
							onClick={() => setConfirmingDiscard(false)}
						>
							Keep editing
						</button>
						<button
							type="button"
							className="changes-header-button changes-header-button--danger"
							onClick={discardAndLeave}
						>
							Discard
						</button>
					</div>
				)}
				<div
					className="changes-view-switch"
					role="tablist"
					aria-label="Changes to show"
				>
					{[false, true].map((staged) => (
						<button
							key={String(staged)}
							type="button"
							role="tab"
							aria-selected={selected.staged === staged}
							className="changes-view-switch-tab"
							onClick={() => switchTo(staged)}
							disabled={selected.staged !== staged && !sideIsLive(staged)}
						>
							{staged ? "Staged" : "Unstaged"}
						</button>
					))}
				</div>
				<div className="changes-diff-content">
					{sides.map((staged) => (
						<FileSideView
							key={String(staged)}
							repoName={repoName as string}
							path={selected.path}
							staged={staged}
							status={statusOf(staged)}
							active={staged === selected.staged}
							refreshToken={refreshToken}
							diffRefreshToken={diffRefreshToken}
							headToken={headToken}
							contentToken={stagedContentToken}
							showError={showError}
							canWrite={canWrite}
							readOnlyLabel={editorReadOnlyLabel}
							menuHost={menuHost}
							fileAction={fileActionFor(staged)}
							onSaved={handleEditorSaved}
							onStaged={handleEditorStaged}
							onUntrackedStaged={handleUntrackedStaged}
							onUnstaged={handleEditorUnstaged}
							onReload={() => handleEditorReload(staged)}
							onDirtyChange={setEditorDirty}
						/>
					))}
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

			{lastCommit !== null ? (
				<div className="changes-timestamp" role="status">
					Committed {lastCommit}
				</div>
			) : (
				lastRefreshed && (
					<div className="changes-timestamp">
						Last refreshed {formatTimestamp(lastRefreshed)}
					</div>
				)
			)}

			{writesRefused && (
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
											disabled={actionPending || !canWrite}
											aria-label={`Unstage ${entry.path}`}
											title={writesRefused ? WRITES_DISABLED_TITLE : "Unstage"}
										>
											<Minus size={18} />
										</button>
									</div>
								))}
								<div className="changes-commit">
									<textarea
										className="changes-commit-message"
										value={commitMessage}
										onChange={(event) =>
											handleCommitMessageChange(event.target.value)
										}
										placeholder="Commit message"
										aria-label="Commit message"
										rows={3}
										disabled={!canWrite}
										readOnly={committing}
									/>
									<button
										type="button"
										className="changes-commit-button"
										onClick={() => {
											void handleCommit();
										}}
										disabled={
											actionPending || !canWrite || commitMessage.trim() === ""
										}
										title={writesRefused ? WRITES_DISABLED_TITLE : undefined}
									>
										{committing ? "Committing..." : "Commit"}
									</button>
								</div>
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
											disabled={actionPending || !canWrite}
											aria-label={`Stage ${entry.path}`}
											title={writesRefused ? WRITES_DISABLED_TITLE : "Stage"}
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
