import { Minus, Plus, RefreshCw } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	createSearchParams,
	useNavigate,
	useSearchParams,
} from "react-router-dom";
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
import { FileViewer, TreeEntry, useFileTree } from "./FileTree.tsx";
import "./FilesPage.css";

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

// The unchanged files are read a folder at a time, so their section has no
// count.
function SectionHeader({ title, count }: { title: string; count?: number }) {
	return (
		<h2 className="changes-section-header">
			{title}
			{count !== undefined && (
				<span className="changes-section-count">{count}</span>
			)}
		</h2>
	);
}

// A changed file's row shows its name, with its folder under it as the
// dashboard shows a repository's path under its name. A nested repository is
// listed as its folder, trailing slash and all.
function splitPath(path: string): { name: string; dir: string } {
	const slash = path.replace(/\/$/, "").lastIndexOf("/");
	return {
		name: path.slice(slash + 1),
		dir: path.slice(0, Math.max(slash, 0)),
	};
}

const WRITES_DISABLED_TITLE = "The server does not allow changes";

/**
 * The repo's files: its changes in sections, staged, unstaged and untracked,
 * then the unchanged files as a folder tree. A directory without git has no
 * changes to show, so it gets the tree alone.
 */
export function FilesPage({
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
	const navigate = useNavigate();
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
	const tree = useFileTree(repoName as string);
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
	// A file opened from the tree of a directory without git names no side.
	const plainPath = selectedStaged === null ? selectedPath : null;
	const fileOpen = selected !== null || plainPath !== null;
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
		// read-only view out from under the reader. A directory without git has
		// no changes to poll for, though Refresh still asks again.
		const paused = fileOpen || notGitRepo;

		function handleVisibilityChange() {
			if (document.visibilityState === "visible" && !paused) {
				fetchStatus(true);
			}
		}

		document.addEventListener("visibilitychange", handleVisibilityChange);
		const interval = setInterval(() => {
			if (document.visibilityState === "visible" && !paused) {
				fetchStatus(true);
			}
		}, 3000);

		return () => {
			document.removeEventListener("visibilitychange", handleVisibilityChange);
			clearInterval(interval);
		};
	}, [fetchStatus, fileOpen, notGitRepo]);

	const { ensureExpanded, loadedFolderOf, refreshDirectories, refreshLoaded } =
		tree;

	// Refresh rereads the folders shown as well as the status. A pull or a
	// checkout outside Rift can change them while leaving the status clean
	// before and after, so nothing in the status would show it.
	const handleRefresh = useCallback(() => {
		fetchStatus(true);
		void refreshLoaded();
	}, [fetchStatus, refreshLoaded]);

	const handleSelectFile = useCallback(
		(entry: StatusEntry) => {
			setSearchParams({
				path: entry.path,
				staged: String(entry.staged),
			});
		},
		[setSearchParams],
	);

	// An unchanged file opens as the working tree's side of a file, as an
	// unstaged change does, so an edit to it can be staged once it is saved.
	// A file of a directory without git has no sides, and opens in the editor
	// alone. It navigates rather than setting the search parameters, whose
	// setter changes with them, so the tree's entries keep the same handler
	// and need not render again as a file opens or closes.
	const handleSelectTreeFile = useCallback(
		(path: string) => {
			const params = notGitRepo ? { path } : { path, staged: "false" };
			navigate({ search: `?${createSearchParams(params)}` });
		},
		[navigate, notGitRepo],
	);

	// Leaving a file of a directory without git for one of its folders opens
	// that folder in the tree.
	const handlePlainNavigate = useCallback(
		(dir: string) => {
			setSearchParams({}, { replace: true });
			if (dir !== ".") ensureExpanded(dir);
		},
		[ensureExpanded, setSearchParams],
	);

	// The files listed with the changes, left out of the tree of unchanged
	// ones. Git lists a nested repository as its folder, with a trailing
	// slash, and everything in it is untracked. The test is rebuilt only when
	// the paths change, not on every status, so the tree's entries render
	// again only then.
	const changedPaths = [...new Set(files.map((entry) => entry.path))]
		.sort()
		.join("\n");
	const isChanged = useMemo(() => {
		const paths = new Set(changedPaths.split("\n"));
		const folders = [...paths].filter((path) => path.endsWith("/"));
		return (path: string) =>
			paths.has(path) || folders.some((folder) => path.startsWith(folder));
	}, [changedPaths]);

	// The tree reads each folder once, as it opens, so it misses a file that
	// appears or disappears outside Rift afterwards. The status shows such a
	// file as a path joining or leaving the changes, as when a new file or a
	// deletion is committed, so the folder holding it is read again. A path
	// that joins only as modified, as on a save, was already listed.
	const changedPathsRef = useRef<Set<string> | null>(null);
	const treeLoading = tree.rootLoading;
	useEffect(() => {
		if (loading || treeLoading) return;
		const changed = new Set(files.map((entry) => entry.path));
		const previous = changedPathsRef.current;
		changedPathsRef.current = changed;
		if (previous === null) return;
		const onlyModified = (path: string) =>
			files.every(
				(entry) => entry.path !== path || entry.status === "modified",
			);
		const moved = [
			...[...changed].filter(
				(path) => !previous.has(path) && !onlyModified(path),
			),
			...[...previous].filter((path) => !changed.has(path)),
		];
		if (moved.length === 0) return;
		void refreshDirectories([...new Set(moved.map(loadedFolderOf))]);
	}, [files, loading, treeLoading, loadedFolderOf, refreshDirectories]);

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

	// Detail view: every change type, and an unchanged file, opens in the
	// editor.
	let fileView: ReactNode = null;
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
				// explaining. A side with no changes, such as an unchanged
				// file's working tree, has nothing to act on.
				disabled:
					actionPending ||
					!canWrite ||
					(!staged && editorDirty) ||
					statusOf(staged) === null,
				title: writesRefused ? WRITES_DISABLED_TITLE : undefined,
			});
		// Tapping the file's name in its bar switches to the other side, and the
		// name is greyed out while that side has no changes. Each side with
		// changes stays built, so switching between them is immediate; switching
		// replaces the history entry, so Back still returns to the list. The
		// working tree counts as having changes while it holds unsaved edits,
		// even ones git hasn't seen.
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
		// The file takes the whole screen, with each side's bar at its foot.
		// Asking before unsaved edits are discarded floats over the editor,
		// above the bar, so nothing moves.
		fileView = (
			<div className="changes-diff-view">
				{confirmingDiscard && (
					<div className="changes-discard-confirm" role="alert">
						<span className="changes-discard-confirm-text">
							Discard unsaved changes?
						</span>
						<button
							type="button"
							className="changes-discard-button"
							onClick={() => setConfirmingDiscard(false)}
						>
							Keep editing
						</button>
						<button
							type="button"
							className="changes-discard-button changes-discard-button--danger"
							onClick={discardAndLeave}
						>
							Discard
						</button>
					</div>
				)}
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
							onBack={handleBack}
							otherSide={{
								available: sideIsLive(!staged),
								show: () => switchTo(!staged),
							}}
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
	} else if (plainPath !== null) {
		// A file opened from the tree of a directory without git.
		fileView = (
			<FileViewer
				filePath={plainPath}
				onNavigate={handlePlainNavigate}
				repo={repoName as string}
				writesAllowed={writesAllowed}
			/>
		);
	}

	const staged = files.filter((f) => f.staged);
	const unstaged = files.filter((f) => !f.staged && f.status !== "untracked");
	const untracked = files.filter((f) => f.status === "untracked");
	// The list waits for the status and the tree's top folder together, which
	// are fetched at once, so it appears whole.
	const listLoading = loading || tree.rootLoading;

	const changeRow = (entry: StatusEntry) => {
		const action = entry.staged ? "Unstage" : "Stage";
		const { name, dir } = splitPath(entry.path);
		return (
			<div
				className="changes-file-row"
				key={`${entry.staged ? "staged" : "unstaged"}-${entry.path}`}
			>
				<button
					type="button"
					className="changes-file-entry"
					onClick={() => handleSelectFile(entry)}
				>
					<StatusBadge status={entry.status} />
					<span className="changes-file-text">
						<span className="changes-file-name">{name}</span>
						{dir !== "" && <span className="changes-file-dir">{dir}</span>}
					</span>
				</button>
				<button
					type="button"
					className="changes-file-action"
					onClick={() => handleToggleStage(entry)}
					disabled={actionPending || !canWrite}
					aria-label={`${action} ${entry.path}`}
					title={writesRefused ? WRITES_DISABLED_TITLE : action}
				>
					{entry.staged ? <Minus size={20} /> : <Plus size={20} />}
				</button>
			</div>
		);
	};

	// The folder tree, under the changes or, for a directory without git, alone.
	// Its card is left empty when every file at the top is listed with the
	// changes, and is not drawn then.
	const treeList = (
		<>
			{tree.nodes.length === 0 ? (
				<div className="changes-message">No files found</div>
			) : (
				<div className="changes-card">
					{tree.nodes.map((node) => (
						<TreeEntry
							key={node.path}
							node={node}
							onToggle={tree.toggleDirectory}
							onFileSelect={handleSelectTreeFile}
							isHidden={notGitRepo ? undefined : isChanged}
							depth={0}
						/>
					))}
				</div>
			)}
			{tree.truncated && (
				<div className="files-truncated">
					Not all entries are displayed. The directory contains more than 1,000
					items.
				</div>
			)}
		</>
	);

	// The list stays built and laid out behind an open file, hidden, so going
	// back only shows it again, scrolled where it was. Its poll pauses
	// meanwhile.
	return (
		<div className="files-view">
			<div className={`changes-page${fileOpen ? " changes-page--hidden" : ""}`}>
				<header className="changes-header">
					<h1 className="changes-header-title">Files</h1>
					{lastCommit !== null ? (
						<span className="changes-timestamp" role="status">
							Committed {lastCommit}
						</span>
					) : (
						lastRefreshed && (
							<span className="changes-timestamp">
								Last refreshed {formatTimestamp(lastRefreshed)}
							</span>
						)
					)}
					<button
						type="button"
						className={`changes-refresh-button${refreshing ? " changes-refresh-button--spinning" : ""}`}
						onClick={handleRefresh}
						aria-label="Refresh"
						title="Refresh"
					>
						<RefreshCw size={20} />
					</button>
				</header>

				{writesRefused && (
					<div className="changes-readonly-note" role="note">
						Read-only: the server does not allow changes, so staging and editing
						are disabled.
					</div>
				)}

				<div className="changes-list">
					{listLoading && <div className="changes-message">Loading...</div>}

					{!listLoading && notGitRepo && treeList}

					{!listLoading && !notGitRepo && (
						<>
							{files.length === 0 && (
								<div className="changes-message">Working tree clean</div>
							)}

							{staged.length > 0 && (
								<section className="changes-section">
									<SectionHeader title="Staged" count={staged.length} />
									<div className="changes-card">
										{staged.map(changeRow)}
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
													actionPending ||
													!canWrite ||
													commitMessage.trim() === ""
												}
												title={
													writesRefused ? WRITES_DISABLED_TITLE : undefined
												}
											>
												{committing ? "Committing..." : "Commit"}
											</button>
										</div>
									</div>
								</section>
							)}

							{unstaged.length > 0 && (
								<section className="changes-section">
									<SectionHeader title="Unstaged" count={unstaged.length} />
									<div className="changes-card">{unstaged.map(changeRow)}</div>
								</section>
							)}

							{untracked.length > 0 && (
								<section className="changes-section">
									<SectionHeader title="Untracked" count={untracked.length} />
									<div className="changes-card">{untracked.map(changeRow)}</div>
								</section>
							)}

							<section className="changes-section">
								<SectionHeader title="Unchanged" />
								{treeList}
							</section>
						</>
					)}
				</div>
			</div>
			{fileView}
		</div>
	);
}
