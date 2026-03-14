import {
	type ReactNode,
	createContext,
	useContext,
	useMemo,
	useState,
} from "react";

interface SessionContextValue {
	repoName: string | null;
	selectRepo: (repoName: string) => void;
	clearRepo: () => void;
}

const SessionContext = createContext<SessionContextValue | undefined>(
	undefined,
);

const STORAGE_KEY = "rift:selected-repo";

export function SessionProvider({ children }: { children: ReactNode }) {
	const [repoName, setRepoName] = useState<string | null>(() => {
		if (typeof window === "undefined") {
			return null;
		}
		return window.localStorage.getItem(STORAGE_KEY);
	});

	const value = useMemo<SessionContextValue>(
		() => ({
			repoName,
			selectRepo: (repo: string) => {
				setRepoName(repo);
				window.localStorage.setItem(STORAGE_KEY, repo);
			},
			clearRepo: () => {
				setRepoName(null);
				window.localStorage.removeItem(STORAGE_KEY);
			},
		}),
		[repoName],
	);

	return (
		<SessionContext.Provider value={value}>{children}</SessionContext.Provider>
	);
}

export function useSession() {
	const context = useContext(SessionContext);
	if (!context) {
		throw new Error("useSession must be used within a SessionProvider");
	}
	return context;
}
