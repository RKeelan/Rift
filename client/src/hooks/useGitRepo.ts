import { useCallback, useEffect, useState } from "react";
import { useApi } from "./useApi.ts";

interface HealthResponse {
	status: string;
	gitRepo: boolean;
}

export function useGitRepo(repo: string | null) {
	const { request } = useApi();
	const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null);
	const [loading, setLoading] = useState(true);

	const check = useCallback(async () => {
		if (!repo) {
			setIsGitRepo(null);
			setLoading(false);
			return;
		}
		const data = await request<HealthResponse>(
			`/api/health?repo=${encodeURIComponent(repo)}`,
			{
				silent: true,
			},
		);
		if (data) {
			setIsGitRepo(data.gitRepo);
		} else {
			// Health check failed — default to showing all tabs (optimistic)
			setIsGitRepo(true);
		}
		setLoading(false);
	}, [repo, request]);

	useEffect(() => {
		check();
	}, [check]);

	return { isGitRepo, loading, recheckGitRepo: check };
}
