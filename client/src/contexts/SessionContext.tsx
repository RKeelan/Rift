import {
	type ReactNode,
	createContext,
	useContext,
	useMemo,
	useState,
} from "react";

interface SessionContextValue {
	sessionId: string | null;
	repoName: string | null;
	setSession: (sessionId: string, repoName: string) => void;
	clearSession: () => void;
}

const SessionContext = createContext<SessionContextValue | undefined>(
	undefined,
);

export function SessionProvider({ children }: { children: ReactNode }) {
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [repoName, setRepoName] = useState<string | null>(null);

	const value = useMemo<SessionContextValue>(
		() => ({
			sessionId,
			repoName,
			setSession: (id: string, repo: string) => {
				setSessionId(id);
				setRepoName(repo);
			},
			clearSession: () => {
				setSessionId(null);
				setRepoName(null);
			},
		}),
		[sessionId, repoName],
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
