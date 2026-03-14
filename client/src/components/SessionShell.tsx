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
	const { isGitRepo, recheckGitRepo } = useGitRepo(repoName);

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
