import { Navigate, Route, Routes } from "react-router-dom";
import { ErrorBannerProvider } from "./components/ErrorBanner.tsx";
import { SessionProvider } from "./contexts/SessionContext.tsx";
import { DashboardPage } from "./pages/DashboardPage.tsx";
import { SessionShell } from "./components/SessionShell.tsx";
import "./App.css";
import "./components/ErrorBanner.css";

export function App() {
	return (
		<ErrorBannerProvider>
			<SessionProvider>
				<Routes>
					<Route path="/" element={<DashboardPage />} />
					<Route path="/*" element={<SessionShell />} />
					<Route path="*" element={<Navigate to="/" replace />} />
				</Routes>
			</SessionProvider>
		</ErrorBannerProvider>
	);
}
