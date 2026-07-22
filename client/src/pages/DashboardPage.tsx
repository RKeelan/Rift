import { ChevronDown, ChevronRight, FolderGit2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApi } from "../hooks/useApi.ts";
import { useSession } from "../contexts/SessionContext.tsx";
import { readStringArray, writeStringArray } from "../storage.ts";
import "./DashboardPage.css";

interface RepoEntry {
	name: string;
	path: string;
}

interface RepoGroup {
	label: string;
	repos: RepoEntry[];
}

const COLLAPSED_ROOTS_KEY = "rift:collapsed-roots";
const RECENTS_SHOWN = 5;

// Every name the server returns is qualified by its root label, so the label is
// everything up to the first slash. An unqualified name should not occur, but
// grouping it under itself keeps a stray entry visible instead of dropping it.
function splitRootLabel(name: string): { label: string; repo: string } {
	const separator = name.indexOf("/");
	if (separator === -1) return { label: name, repo: name };
	return { label: name.slice(0, separator), repo: name.slice(separator + 1) };
}

function groupByRoot(repos: RepoEntry[]): RepoGroup[] {
	const groups = new Map<string, RepoEntry[]>();
	for (const repo of repos) {
		const { label } = splitRootLabel(repo.name);
		const existing = groups.get(label);
		if (existing) {
			existing.push(repo);
		} else {
			groups.set(label, [repo]);
		}
	}
	// The server sorts by qualified name, so both the groups and their contents
	// come out in order without sorting again.
	return [...groups].map(([label, entries]) => ({ label, repos: entries }));
}

function RepoCard({
	repo,
	title,
	onSelect,
}: {
	repo: RepoEntry;
	title: string;
	onSelect: (repoName: string) => void;
}) {
	return (
		<button
			type="button"
			className="session-card"
			onClick={() => onSelect(repo.name)}
			aria-label={`Open repository ${repo.name}`}
		>
			<div className="session-card-header">
				<FolderGit2 size={18} className="session-card-icon" />
				<h3 className="session-card-repo">{title}</h3>
			</div>
			<p className="session-card-path">{repo.path}</p>
		</button>
	);
}

export function DashboardPage() {
	const { request } = useApi();
	const { selectRepo, recentRepos } = useSession();
	const navigate = useNavigate();
	const [repos, setRepos] = useState<RepoEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [collapsedRoots, setCollapsedRoots] = useState<string[]>(() =>
		readStringArray(COLLAPSED_ROOTS_KEY),
	);
	const [showAllRecents, setShowAllRecents] = useState(false);

	const fetchRepos = useCallback(async () => {
		setLoading(true);
		const data = await request<{ repos: RepoEntry[] }>("/api/repos");
		if (data) {
			setRepos(data.repos);
		}
		setLoading(false);
	}, [request]);

	useEffect(() => {
		fetchRepos();
	}, [fetchRepos]);

	// A remembered repo that no longer resolves — renamed, deleted, or from an
	// older name format — must not become a card that only fails when tapped.
	const recents = useMemo(() => {
		const byName = new Map(repos.map((repo) => [repo.name, repo]));
		return recentRepos
			.map((name) => byName.get(name))
			.filter((repo): repo is RepoEntry => repo !== undefined);
	}, [repos, recentRepos]);

	const groups = useMemo(() => groupByRoot(repos), [repos]);

	const handleSelectRepo = useCallback(
		(repoName: string) => {
			selectRepo(repoName);
			// Changes is the view worth landing on, and it is safe to ask for even
			// when the repo has no git: SessionShell mounts that route only for git
			// repos and redirects the rest to files.
			navigate("/changes");
		},
		[selectRepo, navigate],
	);

	const toggleRoot = useCallback(
		(label: string) => {
			const next = collapsedRoots.includes(label)
				? collapsedRoots.filter((name) => name !== label)
				: [...collapsedRoots, label];
			setCollapsedRoots(next);
			writeStringArray(COLLAPSED_ROOTS_KEY, next);
		},
		[collapsedRoots],
	);

	const visibleRecents = showAllRecents
		? recents
		: recents.slice(0, RECENTS_SHOWN);

	return (
		<div className="dashboard-page">
			<header className="dashboard-header">
				<h1 className="dashboard-title">Repositories</h1>
			</header>

			<div className="dashboard-content">
				{loading && (
					<div className="dashboard-message">Loading repositories...</div>
				)}
				{!loading && repos.length === 0 && (
					<div className="dashboard-empty">
						<p>No repositories found</p>
						<p className="dashboard-empty-hint">
							Check your `REPOS_ROOT` configuration
						</p>
					</div>
				)}
				{!loading && recents.length > 0 && (
					<section className="dashboard-section">
						<h2 className="dashboard-section-title">Recent</h2>
						<div className="session-list">
							{visibleRecents.map((repo) => (
								<RepoCard
									key={repo.name}
									repo={repo}
									title={repo.name}
									onSelect={handleSelectRepo}
								/>
							))}
						</div>
						{recents.length > RECENTS_SHOWN && (
							<button
								type="button"
								className="dashboard-more"
								onClick={() => setShowAllRecents((shown) => !shown)}
							>
								{showAllRecents
									? "Show fewer"
									: `Show ${recents.length - RECENTS_SHOWN} more`}
							</button>
						)}
					</section>
				)}
				{!loading &&
					groups.map((group) => {
						const collapsed = collapsedRoots.includes(group.label);
						return (
							<section className="dashboard-section" key={group.label}>
								<button
									type="button"
									className="dashboard-group-header"
									onClick={() => toggleRoot(group.label)}
									aria-expanded={!collapsed}
								>
									{collapsed ? (
										<ChevronRight size={18} />
									) : (
										<ChevronDown size={18} />
									)}
									<span className="dashboard-group-label">{group.label}</span>
									<span className="dashboard-group-count">
										{group.repos.length}
									</span>
								</button>
								{!collapsed && (
									<div className="session-list">
										{group.repos.map((repo) => (
											<RepoCard
												key={repo.name}
												repo={repo}
												title={splitRootLabel(repo.name).repo}
												onSelect={handleSelectRepo}
											/>
										))}
									</div>
								)}
							</section>
						);
					})}
			</div>
		</div>
	);
}
