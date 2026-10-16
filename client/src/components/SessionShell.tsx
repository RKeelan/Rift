import { useEffect, useState } from "react";
import {
	Navigate,
	Route,
	Routes,
	useLocation,
	useMatch,
} from "react-router-dom";
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
	// A file open from the Files tab takes the whole screen, with its own bar
	// in place of the tabs. The tab's path matches as its route does, with a
	// trailing slash or in any case.
	const { search } = useLocation();
	const filesShown = useMatch("/files") !== null;
	const fileOpen = filesShown && new URLSearchParams(search).has("path");

	// The Files tab is built on its first visit, and stays built behind the
	// other tabs from then on, as an open file keeps the list built behind
	// it, so coming back to it shows its list at once, as it was left, and
	// reads it again behind it. It is built afresh for each repo, so one
	// repo's list never shows for another.
	const [filesBuiltFor, setFilesBuiltFor] = useState(
		filesShown ? repoName : null,
	);
	if (filesShown && filesBuiltFor !== repoName) setFilesBuiltFor(repoName);

	// A stored repo the server no longer resolves — renamed, deleted, or from an
	// older name format — would otherwise leave every tab failing to load.
	useEffect(() => {
		if (repoMissing) {
			clearRepo();
		}
	}, [repoMissing, clearRepo]);

	const showGitTabs = isGitRepo !== false;

	// Each tap of a tab checks the repo again, in the background, so a repo
	// removed or renamed since it opened takes the session back to the
	// dashboard.
	return (
		<div className="app">
			<div className="session-view">
				{filesBuiltFor === repoName && (
					<FilesPage
						key={repoName}
						hidden={!filesShown}
						writesAllowed={writesAllowed}
					/>
				)}
				<Routes>
					<Route path="/files" element={null} />
					<Route path="/changes" element={<ChangesRedirect />} />
					{showGitTabs && <Route path="/history" element={<HistoryPage />} />}
					<Route path="*" element={<Navigate to="/files" replace />} />
				</Routes>
			</div>
			{!fileOpen && (
				<TabBar
					isGitRepo={isGitRepo}
					onNavigate={recheckGitRepo}
					repoName={repoName}
				/>
			)}
		</div>
	);
}
