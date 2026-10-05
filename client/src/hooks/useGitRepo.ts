import { useCallback, useEffect, useState } from "react";
import { useApi } from "./useApi.ts";

interface HealthResponse {
	status: string;
	gitRepo: boolean;
	writesAllowed?: boolean;
}

// Writes stay unknown, and every editor read-only, until the health check
// answers, so one that hangs on a poor connection is given up on and treated
// as unreachable.
const HEALTH_TIMEOUT_MS = 5000;

export function useGitRepo(repo: string | null) {
	const { request } = useApi();
	const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null);
	const [repoMissing, setRepoMissing] = useState(false);
	// Unknown (null) until the first check answers, and nothing offers a change
	// until then, so that answer never turns an editor with edits read-only. If
	// it fails or times out, writes are assumed allowed: the server refuses them
	// itself, so a wrong guess only means a refused request. A later check, as
	// on moving between tabs, can still turn an editor with unsaved edits
	// read-only, but those edits stay kept as a draft.
	const [writesAllowed, setWritesAllowed] = useState<boolean | null>(null);
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
				signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
				onError: ({ status }) => {
					unresolvable = status === 404 || status === 403;
				},
			},
		);
		if (data) {
			setIsGitRepo(data.gitRepo);
			setWritesAllowed(data.writesAllowed !== false);
			setRepoMissing(false);
		} else if (unresolvable) {
			setRepoMissing(true);
		} else {
			// Health check failed or timed out—default to showing all tabs
			// (optimistic)
			setIsGitRepo(true);
			setWritesAllowed((known) => known ?? true);
		}
		setLoading(false);
	}, [repo, request]);

	useEffect(() => {
		check();
	}, [check]);

	return {
		isGitRepo,
		loading,
		repoMissing,
		writesAllowed,
		recheckGitRepo: check,
	};
}
