import { Navigate, Route, Routes } from "react-router-dom";
import { ErrorBannerProvider } from "./components/ErrorBanner.tsx";
import { TabBar } from "./components/TabBar.tsx";
import { useGitRepo } from "./hooks/useGitRepo.ts";
import { ChatPage } from "./pages/ChatPage.tsx";
import { FilesPage } from "./pages/FilesPage.tsx";
import { ChangesPage } from "./pages/ChangesPage.tsx";
import { HistoryPage } from "./pages/HistoryPage.tsx";
import "./App.css";
import "./components/ErrorBanner.css";

export function App() {
	return (
		<ErrorBannerProvider>
			<AppShell />
		</ErrorBannerProvider>
	);
}

function AppShell() {
	const { isGitRepo, recheckGitRepo } = useGitRepo();

	const showGitTabs = isGitRepo !== false;

	return (
		<div className="app">
			<Routes>
				<Route path="/chat" element={<ChatPage />} />
				<Route path="/files" element={<FilesPage />} />
				{showGitTabs && (
					<>
						<Route path="/changes" element={<ChangesPage />} />
						<Route path="/history" element={<HistoryPage />} />
					</>
				)}
				<Route path="*" element={<Navigate to="/chat" replace />} />
			</Routes>
			<TabBar isGitRepo={isGitRepo} onNavigate={recheckGitRepo} />
		</div>
	);
}
