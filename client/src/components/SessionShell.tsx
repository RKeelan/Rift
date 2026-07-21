import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useSession } from "../contexts/SessionContext.tsx";
import { useGitRepo } from "../hooks/useGitRepo.ts";
import { TabBar } from "./TabBar.tsx";
import { ChangesPage } from "../pages/ChangesPage.tsx";
import { FilesPage } from "../pages/FilesPage.tsx";
import { HistoryPage } from "../pages/HistoryPage.tsx";

export function SessionShell() {
	const { repoName } = useSession();

	if (!repoName) {
		return <Navigate to="/" replace />;
	}

	return <SessionRoutes repoName={repoName} />;
}

function SessionRoutes({ repoName }: { repoName: string }) {
	const { clearRepo } = useSession();
	const { isGitRepo, repoMissing, recheckGitRepo } = useGitRepo(repoName);

	// A stored repo the server no longer resolves — renamed, deleted, or from an
	// older name format — would otherwise leave every tab failing to load.
	useEffect(() => {
		if (repoMissing) {
			clearRepo();
		}
	}, [repoMissing, clearRepo]);

	const showGitTabs = isGitRepo !== false;

	return (
		<div className="app">
			<Routes>
				<Route path="/files" element={<FilesPage />} />
				{showGitTabs && (
					<>
						<Route path="/changes" element={<ChangesPage />} />
						<Route path="/history" element={<HistoryPage />} />
					</>
				)}
				<Route path="*" element={<Navigate to="/files" replace />} />
			</Routes>
			<TabBar
				isGitRepo={isGitRepo}
				onNavigate={recheckGitRepo}
				repoName={repoName}
			/>
		</div>
	);
}
