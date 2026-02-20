import { useCallback, useEffect, useState } from "react";
import { useApi } from "./useApi.ts";

interface HealthResponse {
	status: string;
	gitRepo: boolean;
}

export function useGitRepo() {
	const { request } = useApi();
	const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null);
	const [loading, setLoading] = useState(true);

	const check = useCallback(async () => {
		const data = await request<HealthResponse>("/api/health", {
			silent: true,
		});
		if (data) {
			setIsGitRepo(data.gitRepo);
		} else {
			// Health check failed — default to showing all tabs (optimistic)
			setIsGitRepo(true);
		}
		setLoading(false);
	}, [request]);

	useEffect(() => {
		check();
	}, [check]);

	return { isGitRepo, loading, recheckGitRepo: check };
}
