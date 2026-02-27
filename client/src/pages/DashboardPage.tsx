import { Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApi } from "../hooks/useApi.ts";
import { useSession } from "../contexts/SessionContext.tsx";
import "./DashboardPage.css";

interface SessionInfo {
	id: string;
	state: "running" | "stopped";
	createdAt: string;
	repo: string;
}

export function DashboardPage() {
	const { request } = useApi();
	const { setSession } = useSession();
	const navigate = useNavigate();
	const [sessions, setSessions] = useState<SessionInfo[]>([]);
	const [loading, setLoading] = useState(true);

	const fetchSessions = useCallback(async () => {
		setLoading(true);
		const data = await request<SessionInfo[]>("/api/sessions");
		if (data) {
			setSessions(data.filter((s) => s.state === "running"));
		}
		setLoading(false);
	}, [request]);

	useEffect(() => {
		fetchSessions();
	}, [fetchSessions]);

	const handleSelectSession = useCallback(
		(session: SessionInfo) => {
			setSession(session.id, session.repo);
			navigate("/chat");
		},
		[setSession, navigate],
	);

	const handleStopSession = useCallback(
		async (sessionId: string, event: React.MouseEvent) => {
			event.stopPropagation();
			if (
				!window.confirm(
					"Stop this session? Any unsaved work or chat history will be lost.",
				)
			) {
				return;
			}
			const result = await request(`/api/sessions/${sessionId}`, {
				method: "DELETE",
			});
			if (result) {
				await fetchSessions();
			}
		},
		[request, fetchSessions],
	);

	const handleNewSession = useCallback(() => {
		navigate("/repo-picker");
	}, [navigate]);

	return (
		<div className="dashboard-page">
			<header className="dashboard-header">
				<h1 className="dashboard-title">Sessions</h1>
				<button
					type="button"
					className="dashboard-new-button"
					onClick={handleNewSession}
				>
					<Plus size={18} />
					New Session
				</button>
			</header>

			<div className="dashboard-content">
				{loading && (
					<div className="dashboard-message">Loading sessions...</div>
				)}
				{!loading && sessions.length === 0 && (
					<div className="dashboard-empty">
						<p>No active sessions</p>
						<button
							type="button"
							className="dashboard-empty-button"
							onClick={handleNewSession}
						>
							<Plus size={18} />
							Create your first session
						</button>
					</div>
				)}
				{!loading && sessions.length > 0 && (
					<div className="session-list">
						{sessions.map((session) => (
							<button
								type="button"
								key={session.id}
								className="session-card"
								onClick={() => handleSelectSession(session)}
								aria-label={`Open session for ${session.repo}`}
							>
								<div className="session-card-header">
									<h3 className="session-card-repo">{session.repo}</h3>
									<button
										type="button"
										className="session-card-stop"
										onClick={(e) => handleStopSession(session.id, e)}
										aria-label="Stop session"
										title="Stop session"
									>
										<Trash2 size={16} />
									</button>
								</div>
								<p className="session-card-date">
									Created {new Date(session.createdAt).toLocaleString()}
								</p>
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
