import { FolderGit2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApi } from "../hooks/useApi.ts";
import { useSession } from "../contexts/SessionContext.tsx";
import "./DashboardPage.css";

interface RepoEntry {
	name: string;
	path: string;
}

export function DashboardPage() {
	const { request } = useApi();
	const { selectRepo } = useSession();
	const navigate = useNavigate();
	const [repos, setRepos] = useState<RepoEntry[]>([]);
	const [loading, setLoading] = useState(true);

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

	const handleSelectRepo = useCallback(
		(repoName: string) => {
			selectRepo(repoName);
			navigate("/files");
		},
		[selectRepo, navigate],
	);

	return (
		<div className="dashboard-page">
			<header className="dashboard-header">
				<h1 className="dashboard-title">Repositories</h1>
			</header>

			<div className="dashboard-content">
				<p className="dashboard-intro">
					Browse local repos from your phone. Open files, inspect changes, and
					read history without starting an agent session.
				</p>
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
				{!loading && repos.length > 0 && (
					<div className="session-list">
						{repos.map((repo) => (
							<button
								type="button"
								key={repo.name}
								className="session-card"
								onClick={() => handleSelectRepo(repo.name)}
								aria-label={`Open repository ${repo.name}`}
							>
								<div className="session-card-header">
									<FolderGit2 size={18} className="session-card-icon" />
									<h3 className="session-card-repo">{repo.name}</h3>
								</div>
								<p className="session-card-date">{repo.path}</p>
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
