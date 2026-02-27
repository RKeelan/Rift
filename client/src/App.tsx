import { Navigate, Route, Routes } from "react-router-dom";
import { ErrorBannerProvider } from "./components/ErrorBanner.tsx";
import { SessionProvider } from "./contexts/SessionContext.tsx";
import { DashboardPage } from "./pages/DashboardPage.tsx";
import { RepoPickerPage } from "./pages/RepoPickerPage.tsx";
import { SessionShell } from "./components/SessionShell.tsx";
import "./App.css";
import "./components/ErrorBanner.css";

export function App() {
	return (
		<ErrorBannerProvider>
			<SessionProvider>
				<Routes>
					<Route path="/" element={<DashboardPage />} />
					<Route path="/repo-picker" element={<RepoPickerPage />} />
					<Route path="/*" element={<SessionShell />} />
				</Routes>
			</SessionProvider>
		</ErrorBannerProvider>
	);
}
