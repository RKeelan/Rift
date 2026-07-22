import {
	type ReactNode,
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { readStringArray, writeStringArray } from "../storage.ts";

interface SessionContextValue {
	repoName: string | null;
	recentRepos: string[];
	selectRepo: (repoName: string) => void;
	clearRepo: () => void;
}

const SessionContext = createContext<SessionContextValue | undefined>(
	undefined,
);

const STORAGE_KEY = "rift:selected-repo";
const RECENTS_KEY = "rift:recent-repos";

// The dashboard shows five recents before offering the rest, so keeping ten
// leaves something behind the toggle without letting the list grow unbounded.
const MAX_RECENTS = 10;

export function SessionProvider({ children }: { children: ReactNode }) {
	const [repoName, setRepoName] = useState<string | null>(() => {
		if (typeof window === "undefined") {
			return null;
		}
		return window.localStorage.getItem(STORAGE_KEY);
	});
	const [recentRepos, setRecentRepos] = useState<string[]>(() =>
		readStringArray(RECENTS_KEY),
	);

	useEffect(() => {
		writeStringArray(RECENTS_KEY, recentRepos);
	}, [recentRepos]);

	// Both callbacks keep a stable identity, so an effect may depend on one
	// without the state it updates feeding back into it.
	const selectRepo = useCallback((repo: string) => {
		setRepoName(repo);
		window.localStorage.setItem(STORAGE_KEY, repo);
		setRecentRepos((previous) => {
			if (previous[0] === repo) return previous;
			return [repo, ...previous.filter((name) => name !== repo)].slice(
				0,
				MAX_RECENTS,
			);
		});
	}, []);

	// Recents outlive the selection: leaving a repo is not forgetting it.
	const clearRepo = useCallback(() => {
		setRepoName(null);
		window.localStorage.removeItem(STORAGE_KEY);
	}, []);

	const value = useMemo<SessionContextValue>(
		() => ({ repoName, recentRepos, selectRepo, clearRepo }),
		[repoName, recentRepos, selectRepo, clearRepo],
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
