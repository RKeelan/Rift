import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useSession } from "../contexts/SessionContext.tsx";
import { useGitRepo } from "../hooks/useGitRepo.ts";
import { TabBar } from "./TabBar.tsx";
import { FilesPage } from "../pages/FilesPage.tsx";
import { HistoryPage } from "../pages/HistoryPage.tsx";

export function SessionShell() {
	const { repoName } = useSession();

	if (!repoName) {
		return <Navigate to="/" replace />;
	}

	return <SessionRoutes repoName={repoName} />;
}

// The changes once had a tab of their own at /changes. An installed app or a
// history entry may still open one of its URLs, which can name an open file in
// its query, so each goes to the same place under Files.
function ChangesRedirect() {
	const { search } = useLocation();
	return <Navigate to={{ pathname: "/files", search }} replace />;
}

function SessionRoutes({ repoName }: { repoName: string }) {
	const { clearRepo } = useSession();
	const { isGitRepo, repoMissing, writesAllowed, recheckGitRepo } =
		useGitRepo(repoName);

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
				<Route
					path="/files"
					element={<FilesPage writesAllowed={writesAllowed} />}
				/>
				<Route path="/changes" element={<ChangesRedirect />} />
				{showGitTabs && <Route path="/history" element={<HistoryPage />} />}
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
