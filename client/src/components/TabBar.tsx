import {
	FolderOpen,
	GitPullRequestArrow,
	History,
	Home,
	MessageSquare,
} from "lucide-react";
import { NavLink, useNavigate } from "react-router-dom";
import { useSession } from "../contexts/SessionContext.tsx";
import "./TabBar.css";

interface Tab {
	to: string;
	label: string;
	icon: React.ReactNode;
	requiresGit?: boolean;
}

const tabs: Tab[] = [
	{ to: "/chat", label: "Chat", icon: <MessageSquare size={22} /> },
	{ to: "/files", label: "Files", icon: <FolderOpen size={22} /> },
	{
		to: "/changes",
		label: "Changes",
		icon: <GitPullRequestArrow size={22} />,
		requiresGit: true,
	},
	{
		to: "/history",
		label: "History",
		icon: <History size={22} />,
		requiresGit: true,
	},
];

interface TabBarProps {
	isGitRepo: boolean | null;
	onNavigate?: () => void;
	repoName: string;
}

export function TabBar({ isGitRepo, onNavigate, repoName }: TabBarProps) {
	const navigate = useNavigate();
	const { clearSession } = useSession();

	const visibleTabs = tabs.filter(
		(tab) => !tab.requiresGit || isGitRepo !== false,
	);

	const handleBackToDashboard = () => {
		clearSession();
		navigate("/");
	};

	return (
		<nav className="tab-bar" aria-label="Main navigation">
			<button
				type="button"
				className="tab-bar-repo"
				onClick={handleBackToDashboard}
				title="Back to dashboard"
			>
				<Home size={16} />
				<span className="tab-bar-repo-name">{repoName}</span>
			</button>
			{visibleTabs.map((tab) => (
				<NavLink
					key={tab.to}
					to={tab.to}
					className={({ isActive }) =>
						`tab-bar-item ${isActive ? "tab-bar-item--active" : ""}`
					}
					onClick={onNavigate}
				>
					<span className="tab-bar-icon">{tab.icon}</span>
					<span className="tab-bar-label">{tab.label}</span>
				</NavLink>
			))}
		</nav>
	);
}
