import { useCallback, useEffect, useState } from "react";
import { useApi } from "./useApi.ts";

interface HealthResponse {
	status: string;
	gitRepo: boolean;
}

export function useGitRepo(repo: string | null) {
	const { request } = useApi();
	const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null);
	const [repoMissing, setRepoMissing] = useState(false);
	const [loading, setLoading] = useState(true);

	const check = useCallback(async () => {
		if (!repo) {
			setIsGitRepo(null);
			setLoading(false);
			return;
		}
		// The server rejects a repo it cannot resolve, which is distinct from
		// being unreachable: one means the selection is stale, the other means
		// the network is down.
		let unresolvable = false;
		const data = await request<HealthResponse>(
			`/api/health?repo=${encodeURIComponent(repo)}`,
			{
				silent: true,
				onError: ({ status }) => {
					unresolvable = status === 404 || status === 403;
				},
			},
		);
		if (data) {
			setIsGitRepo(data.gitRepo);
			setRepoMissing(false);
		} else if (unresolvable) {
			setRepoMissing(true);
		} else {
			// Health check failed — default to showing all tabs (optimistic)
			setIsGitRepo(true);
		}
		setLoading(false);
	}, [repo, request]);

	useEffect(() => {
		check();
	}, [check]);

	return { isGitRepo, loading, repoMissing, recheckGitRepo: check };
}
