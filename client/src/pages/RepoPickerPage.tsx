import { ArrowLeft, FolderGit2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApi } from "../hooks/useApi.ts";
import { useSession } from "../contexts/SessionContext.tsx";
import "./RepoPickerPage.css";

interface RepoEntry {
	name: string;
	path: string;
}

interface ReposResponse {
	repos: RepoEntry[];
}

interface SessionInfo {
	id: string;
	state: "running" | "stopped";
	createdAt: string;
	repo: string;
}

export function RepoPickerPage() {
	const { request } = useApi();
	const { setSession } = useSession();
	const navigate = useNavigate();
	const [repos, setRepos] = useState<RepoEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [creating, setCreating] = useState(false);

	useEffect(() => {
		(async () => {
			setLoading(true);
			const data = await request<ReposResponse>("/api/repos");
			if (data) {
				setRepos(data.repos);
			}
			setLoading(false);
		})();
	}, [request]);

	const handleSelectRepo = useCallback(
		async (repoName: string) => {
			setCreating(true);
			const session = await request<SessionInfo>("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ repo: repoName }),
			});
			if (session) {
				setSession(session.id, session.repo);
				navigate("/chat");
			} else {
				setCreating(false);
			}
		},
		[request, setSession, navigate],
	);

	const handleBack = useCallback(() => {
		navigate("/");
	}, [navigate]);

	return (
		<div className="repo-picker-page">
			<header className="repo-picker-header">
				<button
					type="button"
					className="repo-picker-back"
					onClick={handleBack}
					aria-label="Back to dashboard"
				>
					<ArrowLeft size={18} />
				</button>
				<h1 className="repo-picker-title">Select Repository</h1>
			</header>

			<div className="repo-picker-content">
				{loading && (
					<div className="repo-picker-message">Loading repositories...</div>
				)}
				{!loading && repos.length === 0 && (
					<div className="repo-picker-empty">
						<p>No repositories found</p>
						<p className="repo-picker-empty-hint">
							Check your REPOS_ROOT configuration
						</p>
					</div>
				)}
				{!loading && repos.length > 0 && (
					<div className="repo-list">
						{repos.map((repo) => (
							<button
								type="button"
								key={repo.name}
								className="repo-card"
								onClick={() => handleSelectRepo(repo.name)}
								disabled={creating}
								aria-label={`Create session for ${repo.name}`}
							>
								<FolderGit2 size={20} className="repo-card-icon" />
								<span className="repo-card-name">{repo.name}</span>
							</button>
						))}
					</div>
				)}
				{creating && (
					<div className="repo-picker-creating">Creating session...</div>
				)}
			</div>
		</div>
	);
}
