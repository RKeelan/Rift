import { NavLink } from "react-router-dom";
import {
	MessageSquare,
	FolderOpen,
	GitPullRequestArrow,
	History,
} from "lucide-react";
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
}

export function TabBar({ isGitRepo, onNavigate }: TabBarProps) {
	const visibleTabs = tabs.filter(
		(tab) => !tab.requiresGit || isGitRepo !== false,
	);

	return (
		<nav className="tab-bar" aria-label="Main navigation">
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
