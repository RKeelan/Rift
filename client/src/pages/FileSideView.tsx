import { useEffect, useState } from "react";
import { apiUrl } from "../apiUrl.ts";
import {
	type ChangedFile,
	type DiffAnswer,
	type FileAction,
	type FileContext,
	type OpenedText,
	type Refusal,
	type SavedContext,
	TextFileEditor,
} from "../components/TextFileEditor.tsx";

export type FileStatus =
	| "added"
	| "modified"
	| "deleted"
	| "renamed"
	| "untracked";

/**
 * The file's context a stage or unstage answered with, and the tokens it
 * holds for: the refresh of the index it came with, and the save and HEAD
 * refreshes current when the action was sent.
 */
export interface AnsweredContext {
	repoName: string;
	path: string;
	refreshToken: number;
	diffRefreshToken: number;
	headToken: number;
	context: FileContext;
}

/**
 * The working tree's diff a save answered with, and the tokens it holds for:
 * the save's own refresh of the diff, and the refresh of the index current
 * when the save was sent.
 */
export interface SavedDiff {
	repoName: string;
	path: string;
	refreshToken: number;
	diffRefreshToken: number;
	diff: SavedContext["unstagedDiff"];
}

/** A part of a file that opening it reads, as the open request names it. */
export type OpenPart =
	| "file"
	| "unstagedDiff"
	| "stagedDiff"
	| "index"
	| "head";

/**
 * What the open request answers with: each part it asked for, as the
 * endpoint that reads it alone answers, or that endpoint's refusal. The
 * working tree's text comes with the modification time the file's own
 * endpoint gives in a header.
 */
export interface OpenAnswer {
	file?: { content: string; mtimeMs: number } | Refusal;
	unstagedDiff?: DiffAnswer | Refusal;
	stagedDiff?: DiffAnswer | Refusal;
	index?: { content: string } | Refusal;
	head?: { content: string } | Refusal;
}

/**
 * A file as it opens: the parts its sides read, asked for in one request,
 * and the tokens current as it opened, which the answer holds for.
 */
export interface OpenedFile {
	repoName: string;
	path: string;
	parts: OpenPart[];
	// Whether the working tree's diff is read against nothing, as an
	// untracked file's is.
	untracked: boolean;
	refreshToken: number;
	diffRefreshToken: number;
	headToken: number;
	contentToken: number;
	request: OpenRequest;
	// The answer once it has landed, undefined until then.
	answer?: OpenAnswer | null;
	// Set once the answer has kept the sides waiting CONTEXT_WAIT_MS, after
	// which each side asks for what it still lacks itself, and takes from the
	// answer only what it still lacks when it lands.
	late?: boolean;
}

/** The request that opens a file. */
export interface OpenRequest {
	// Sends the request the first time it is called, by whichever reader of
	// a part asks first, and resolves with its answer, or with null when it
	// failed, which leaves each part to a request of its own.
	read: () => Promise<OpenAnswer | null>;
	// Stops the request, whose answer then is null.
	abort: () => void;
}

/**
 * The parts one side of a file reads as it opens: the text it shows, the
 * copy it compares that against, and git's diff of the two. A deleted
 * file's side shows the copy being removed, and marks every line of it
 * without a diff. An untracked file's working tree compares against
 * nothing, and the staged side of a file with nothing staged shows no diff.
 */
export function openParts(
	staged: boolean,
	status: FileStatus | null,
): OpenPart[] {
	if (status === "deleted") return [staged ? "head" : "index"];
	if (staged) {
		return status === null
			? ["index", "head"]
			: ["index", "head", "stagedDiff"];
	}
	if (status === "untracked") return ["file", "unstagedDiff"];
	return ["file", "index", "unstagedDiff"];
}

/** The part of a file that a side's editor shows, of those it reads. */
function shownPart(
	staged: boolean,
	status: FileStatus | null,
): "file" | "index" | "head" {
	if (status === "deleted") return staged ? "head" : "index";
	return staged ? "index" : "file";
}

/**
 * A file as it opens, whose request goes out once something reads it. An
 * open the server refuses whole, as one without the endpoint does, or that
 * fails, answers null, and each side then asks for its parts alone, which
 * reports what goes wrong.
 */
export function openFile(
	file: Omit<OpenedFile, "request" | "answer" | "late">,
): OpenedFile {
	const controller = new AbortController();
	let answer: Promise<OpenAnswer | null> | undefined;
	return {
		...file,
		request: {
			read: () => {
				answer ??= (async () => {
					const params = new URLSearchParams({
						repo: file.repoName,
						path: file.path,
						parts: file.parts.join(","),
					});
					if (file.untracked) params.set("untracked", "true");
					try {
						const res = await fetch(apiUrl(`/api/git/open?${params}`), {
							signal: controller.signal,
						});
						return res.ok ? ((await res.json()) as OpenAnswer) : null;
					} catch {
						return null;
					}
				})();
				return answer;
			},
			abort: () => controller.abort(),
		},
	};
}

/**
 * A part of the file's open answer for a read it holds for, by the tokens
 * `holds` checks: "pending" while the answer is out and not yet late, and
 * null when the open did not read it, failed, or is late, so the side reads
 * it itself.
 */
function openedPart<P extends OpenPart>(
	opened: OpenedFile | null | undefined,
	repoName: string,
	path: string,
	part: P,
	holds: (opened: OpenedFile) => boolean,
): NonNullable<OpenAnswer[P]> | "pending" | null {
	if (
		!opened ||
		opened.repoName !== repoName ||
		opened.path !== path ||
		!opened.parts.includes(part) ||
		!holds(opened)
	) {
		return null;
	}
	if (opened.answer === undefined) return opened.late ? null : "pending";
	return opened.answer?.[part] ?? null;
}

interface ChangeContextOptions {
	repoName: string;
	path: string;
	staged: boolean;
	status: FileStatus | null;
	// Bumped after a stage or unstage, which changes the index, so the
	// comparison and git's diff are both read afresh.
	refreshToken: number;
	// Bumped after a save, which changes the working tree but not the index, so
	// only the working tree's diff is taken afresh.
	diffRefreshToken: number;
	// Bumped when HEAD may have changed, which only the staged side compares
	// against.
	headToken: number;
	// The context the last stage or unstage answered with, which gives the
	// side its comparison and diff in place of fetching them, for the file
	// and the tokens it holds for.
	answeredContext?: AnsweredContext | null;
	// The working tree's diff the last save answered with, which the working
	// tree takes in place of fetching it, for the file and the tokens it
	// holds for.
	savedDiff?: SavedDiff | null;
	// The file as it opened, whose one request gives the side the parts it
	// reads as it opens, in place of asking for each, while the tokens it
	// holds for are current.
	opened?: OpenedFile | null;
	showError: (message: string) => void;
}

/**
 * The context a stage or unstage answered with, if it is for this file and
 * this refresh of the index, which the action made.
 */
function answerFor(
	answered: AnsweredContext | null | undefined,
	repoName: string,
	path: string,
	refreshToken: number,
): AnsweredContext | null {
	return answered?.repoName === repoName &&
		answered.path === path &&
		answered.refreshToken === refreshToken
		? answered
		: null;
}

// Reading a copy of the file as text, as a request for it does, drops a
// leading byte order mark, which the copy an answer gives in JSON keeps.
function asText(content: string): string {
	return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

/**
 * What a side takes when the server refuses its copy of the file to compare
 * against: null when git has no copy of it, and otherwise undefined. A copy
 * too large or binary to show belongs to a file the editor refuses too, and
 * says so itself, so only another refusal is reported.
 */
function refusedCopy(status: number): {
	base: null | undefined;
	report: boolean;
} {
	if (status === 404) return { base: null, report: false };
	return { base: undefined, report: status !== 413 && status !== 415 };
}

function copyOf(
	answer: { content: string } | Refusal,
): string | null | undefined {
	return "content" in answer
		? asText(answer.content)
		: refusedCopy(answer.status).base;
}

/**
 * The index's text a stage or unstage answered with, empty when the index
 * holds nothing of the file, or undefined when its copy is too large or
 * binary to show or could not be read, which reading it again reports.
 */
export function indexText(context: FileContext): string | undefined {
	const text = copyOf(context.index);
	return text === null ? "" : text;
}

/**
 * Reads the text a side's editor shows from the file's open request, while
 * everything the side shows is as it was when the file opened, or undefined
 * when the request is not the side's to read it from. The reader answers
 * null when the request did not read the part, or failed, and the editor
 * then reads the text itself.
 */
function openedTextReader(
	opened: OpenedFile | null | undefined,
	side: {
		repoName: string;
		path: string;
		refreshToken: number;
		diffRefreshToken: number;
		headToken: number;
		contentToken: number;
	},
	part: "file" | "index" | "head",
): (() => Promise<OpenedText | null>) | undefined {
	if (
		!opened ||
		opened.repoName !== side.repoName ||
		opened.path !== side.path ||
		!opened.parts.includes(part) ||
		opened.refreshToken !== side.refreshToken ||
		opened.diffRefreshToken !== side.diffRefreshToken ||
		opened.headToken !== side.headToken ||
		opened.contentToken !== side.contentToken
	) {
		return undefined;
	}
	return async () => {
		const answer = (await opened.request.read())?.[part];
		if (answer === undefined) return null;
		if ("error" in answer) return answer;
		return {
			text: asText(answer.content),
			...("mtimeMs" in answer ? { mtimeMs: answer.mtimeMs } : {}),
		};
	};
}

/**
 * What one side of a file's changes is compared against, and git's diff of
 * it: the index and the unstaged diff for the working tree, HEAD and the
 * staged diff for the index. The two are fetched together, and the diff
 * counts as loading until both have landed. As the file opens, both
 * come from the request that opens it, and after a stage or unstage
 * from the action's answer, and land at once. After a save the working
 * tree's diff comes from the save's answer.
 */
export function useChangeContext({
	repoName,
	path,
	staged,
	status,
	refreshToken,
	diffRefreshToken,
	headToken,
	answeredContext,
	savedDiff,
	opened,
	showError,
}: ChangeContextOptions) {
	// The last answer to a request for the copy of the file that this side
	// compares against, kept with the request it answers, as git's diff is:
	// its text, null when git has no copy of it, or undefined when it is too
	// large or binary to show, or the request failed.
	const [baseAnswer, setBaseAnswer] = useState<{
		request: string;
		base: string | null | undefined;
	} | null>(null);
	// The last answer to a request for git's diff, kept with the request it
	// answers, so that an earlier request's diff is never taken for the
	// current one's. A failed request's answer has no diff.
	const [diffAnswer, setDiffAnswer] = useState<{
		request: string;
		diff: string | null;
		exact: boolean;
	} | null>(null);
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

	const baseRequest = needsBase
		? JSON.stringify([repoName, path, staged, comparisonKey])
		: null;

	// The answer to the stage or unstage that made this refresh of the index.
	// It gives the parts of the context the side would ask for under the
	// tokens it was answered for, which the side takes in their place. The
	// staged side's comparison, HEAD, holds while nothing reloads the file,
	// and an answer gives it only to a staged side it builds.
	const given = answerFor(answeredContext, repoName, path, refreshToken);
	const answeredCopy =
		given === null || baseRequest === null
			? null
			: !staged
				? given.context.index
				: given.headToken === headToken
					? (given.context.head ?? null)
					: null;
	// The open request gives the copy read under the tokens current as the
	// file opened, and the side waits for it rather than asking itself,
	// unless it is late. A late answer gives the copy only if the side's own
	// request has not.
	const openedCopy =
		baseRequest === null
			? null
			: openedPart(opened, repoName, path, staged ? "head" : "index", (file) =>
					staged
						? file.headToken === headToken
						: file.refreshToken === refreshToken,
				);
	const fetchedCopy =
		baseAnswer !== null && baseAnswer.request === baseRequest
			? baseAnswer
			: null;
	const givenCopy =
		answeredCopy ??
		(openedCopy === "pending" || fetchedCopy !== null ? null : openedCopy);
	const awaitingCopy = givenCopy === null && openedCopy === "pending";
	const baseAnswered = givenCopy !== null || fetchedCopy !== null;

	// A copy an answer gives is kept as its request's answer, so the side
	// still has it when a later answer leaves it out, as one does HEAD's.
	useEffect(() => {
		if (baseRequest !== null && givenCopy !== null) {
			setBaseAnswer({ request: baseRequest, base: copyOf(givenCopy) });
		}
	}, [baseRequest, givenCopy]);

	useEffect(() => {
		if (baseRequest === null || baseAnswered || awaitingCopy) return;

		const controller = new AbortController();
		const answer = (base: string | null | undefined) =>
			setBaseAnswer({ request: baseRequest, base });

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
					const refused = refusedCopy(res.status);
					if (refused.report) {
						const body = await res.json().catch(() => null);
						showError(body?.error?.message ?? `Request failed (${res.status})`);
					}
					answer(refused.base);
					return;
				}

				answer(await res.text());
			} catch (err) {
				if (err instanceof DOMException && err.name === "AbortError") {
					return;
				}
				showError(err instanceof Error ? err.message : "Network error");
				answer(undefined);
			}
		})();

		return () => {
			controller.abort();
		};
	}, [
		baseRequest,
		baseAnswered,
		awaitingCopy,
		repoName,
		path,
		staged,
		showError,
		comparisonKey,
	]);

	// A refusal the answer gives is reported as the request's would be.
	const copyFailure =
		givenCopy !== null &&
		"error" in givenCopy &&
		refusedCopy(givenCopy.status).report
			? givenCopy.error
			: null;
	useEffect(() => {
		if (copyFailure !== null) showError(copyFailure.message);
	}, [copyFailure, showError]);

	const base = givenCopy !== null ? copyOf(givenCopy) : fetchedCopy?.base;

	let comparisonContent: string | undefined;
	if (status === "untracked") {
		comparisonContent = "";
	} else if (!needsBase) {
		comparisonContent = undefined;
	} else if (base === null) {
		// A file with no committed or staged version has no base to compare
		// against; treat it like an untracked file rather than failing the
		// edit. A file the status doesn't list either, such as one inside
		// .git, has no changes to mark, except on the staged side: with nothing
		// of it staged, the index holds no more of it than HEAD does.
		comparisonContent = status === null && !staged ? undefined : "";
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

	// Each request is named by everything it asks for, so a new one makes the
	// diff load again from the render that asks for it.
	const diffRequest =
		diffKind === null
			? null
			: JSON.stringify([repoName, path, staged, diffKind, diffKey]);
	// The working tree's diff the answer gives is against nothing just when
	// the answer lists the file as untracked, as the status it gave the side
	// does. A save since the action was sent outdates it.
	const answeredDiff =
		given === null || diffRequest === null
			? null
			: staged
				? given.context.stagedDiff
				: given.diffRefreshToken === diffRefreshToken
					? given.context.unstagedDiff
					: null;
	// A save's answer gives the working tree's diff, in the same terms, for
	// the refresh of the diff the save made. A stage or unstage made while
	// the save was out outdates it.
	const savedGiven =
		!staged &&
		diffRequest !== null &&
		savedDiff?.repoName === repoName &&
		savedDiff.path === path &&
		savedDiff.refreshToken === refreshToken &&
		savedDiff.diffRefreshToken === diffRefreshToken
			? savedDiff.diff
			: null;
	// The open request's diff is the side's while the file is as it opened,
	// and the working tree's is against nothing just when the request read it
	// so. A late answer gives it only if the side's own request has not.
	const fromRequest =
		diffAnswer !== null && diffAnswer.request === diffRequest
			? diffAnswer
			: null;
	const openedDiff =
		diffRequest === null
			? null
			: staged
				? openedPart(
						opened,
						repoName,
						path,
						"stagedDiff",
						(file) => file.refreshToken === refreshToken,
					)
				: openedPart(
						opened,
						repoName,
						path,
						"unstagedDiff",
						(file) =>
							file.refreshToken === refreshToken &&
							file.diffRefreshToken === diffRefreshToken &&
							file.untracked === (diffKind === "untracked"),
					);
	const givenDiff =
		answeredDiff ??
		savedGiven ??
		(openedDiff === "pending" || fromRequest !== null ? null : openedDiff);
	const awaitingDiff = givenDiff === null && openedDiff === "pending";
	const diffGiven = givenDiff !== null;

	useEffect(() => {
		if (diffRequest === null || diffGiven || awaitingDiff) return;

		const controller = new AbortController();

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
					setDiffAnswer({ request: diffRequest, diff: null, exact: true });
					return;
				}

				const data: DiffAnswer = await res.json();
				setDiffAnswer({
					request: diffRequest,
					diff: data.diff,
					exact: data.exact !== false,
				});
			} catch (err) {
				if (err instanceof DOMException && err.name === "AbortError") {
					return;
				}
				showError(err instanceof Error ? err.message : "Network error");
				setDiffAnswer({ request: diffRequest, diff: null, exact: true });
			}
		})();

		return () => {
			controller.abort();
		};
	}, [
		repoName,
		path,
		staged,
		diffKind,
		showError,
		diffKey,
		diffRequest,
		diffGiven,
		awaitingDiff,
	]);

	const diffFailure =
		givenDiff !== null && "error" in givenDiff ? givenDiff.error : null;
	useEffect(() => {
		if (diffFailure !== null) showError(diffFailure.message);
	}, [diffFailure, showError]);

	// The diff loads until its request is answered. A side with no diff to
	// read, and a request that failed, hand over no diff without loading.
	// Nothing changes the index but what the status reports, so a staged side
	// it lists no change for has an empty diff, without asking git.
	const diffResult =
		givenDiff !== null
			? "error" in givenDiff
				? { diff: null, exact: true }
				: { diff: givenDiff.diff, exact: givenDiff.exact !== false }
			: fromRequest;
	const nothingStaged = staged && status === null;
	const diff = nothingStaged ? "" : (diffResult?.diff ?? null);
	const diffExact = diffResult?.exact ?? true;
	const loading =
		(baseRequest !== null && !baseAnswered) ||
		(diffRequest !== null && diffResult === null);

	// The comparison and git's diff land one after the other, and the editor
	// redraws the changes from whatever it is handed: with no comparison it
	// draws no deleted lines at all, with the comparison alone it draws them
	// without the strips that only git's diff places, and with the new
	// comparison alone a staged change's deleted lines go before its strip.
	// So the side hands over a context only once both parts have landed, for
	// the editor to draw in one step. While a refetch is out, as after a
	// reload, it goes on handing over the context it last had in full, and as
	// the side first loads it hands over none.
	const side = JSON.stringify([repoName, path, staged]);
	const [held, setHeld] = useState<{
		side: string;
		comparisonContent: string | undefined;
		diff: string | null;
		diffExact: boolean;
	} | null>(null);
	if (
		!loading &&
		(held === null ||
			held.side !== side ||
			held.comparisonContent !== comparisonContent ||
			held.diff !== diff ||
			held.diffExact !== diffExact)
	) {
		setHeld({ side, comparisonContent, diff, diffExact });
	}
	if (loading) {
		return held !== null && held.side === side
			? {
					comparisonContent: held.comparisonContent,
					diff: held.diff,
					diffExact: held.diffExact,
					diffLoading: true,
				}
			: {
					comparisonContent: undefined,
					diff: null,
					diffExact: true,
					diffLoading: true,
				};
	}

	return { comparisonContent, diff, diffExact, diffLoading: false };
}

export interface FileSideViewProps extends ChangeContextOptions {
	// Whether this side is the one on screen. The other side of a file with
	// changes of both kinds stays built behind it, so switching to it is
	// immediate.
	active: boolean;
	canWrite: boolean;
	readOnlyLabel: string;
	// Bumped when the staged side has to read the index's text again, as when
	// the working tree reloads, or a stage or unstage answers without it.
	contentToken: number;
	// Whether a stage or unstage from this side asks for HEAD's copy of the
	// file, which the staged side needs from the answer only when the answer
	// builds it.
	askForHead: boolean;
	// Leaves the file, from the bar's Back.
	onBack: () => void;
	// The file's other side, which a tap on the file's name switches to.
	otherSide: { available: boolean; show: () => void };
	// The page's action on the whole file, for this side.
	fileAction: (label: string) => FileAction;
	// Called with the repo's changes as a save leaves them, and the working
	// tree's new diff, when the save's answer gives them.
	onSaved: (files?: ChangedFile[], context?: SavedContext) => void;
	// Each is called with the repo's changes as the action leaves them, and
	// the file's context, when the answer gives it.
	onStaged: (files: ChangedFile[], context?: FileContext) => void;
	// Called when the editor stages an untracked file whole.
	onUntrackedStaged: (files: ChangedFile[]) => void;
	onUnstaged: (files: ChangedFile[], context?: FileContext) => void;
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
	askForHead,
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
	const { comparisonContent, diff, diffExact, diffLoading } =
		useChangeContext(context);
	// The staged side shows the index's text, which a stage or unstage
	// answers with, so the side takes it in place of reading it again.
	const answered = answerFor(
		context.answeredContext,
		repoName,
		path,
		context.refreshToken,
	);
	const text =
		staged && answered !== null ? indexText(answered.context) : undefined;
	const openedText = openedTextReader(
		context.opened,
		{ ...context, contentToken },
		shownPart(staged, status),
	);

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
					openedText={openedText}
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
					changeDiffLoading={diffLoading}
					changeType={status}
					filePath={path}
					repo={repoName}
					readOnly={!canWrite}
					readOnlyLabel={readOnlyLabel}
					staged
					reloadKey={contentToken}
					text={text}
					openedText={openedText}
					hidden={!active}
					askForHead={askForHead}
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
					changeDiffLoading={diffLoading}
					changeDiffExact={diffExact}
					changeType={status}
					filePath={path}
					repo={repoName}
					readOnly={!canWrite}
					readOnlyLabel={readOnlyLabel}
					openedText={openedText}
					askForHead={askForHead}
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
