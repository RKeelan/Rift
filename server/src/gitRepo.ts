import fs from "node:fs/promises";
import path from "node:path";
import { repoGit } from "./repoGit.js";

/**
 * A repository's top level and a git client that runs there.
 */
export interface LocatedRepo {
	toplevel: string;
	git: ReturnType<typeof repoGit>;
}

/**
 * Finds the repository a directory belongs to, or null when it is in none.
 *
 * Starting a git process costs about 30 ms on Windows, so a directory with a
 * `.git` of its own, a directory in a normal repository and a file in a linked
 * worktree or a submodule, is taken as the top level without asking git.
 * Rift lists only the immediate children of a root, so that is nearly every
 * repository it is asked about. Anything else, such as a subdirectory of a
 * repository, is put to git, which says whether it is in a repository and
 * where the top is.
 *
 * A `.git` that git would refuse, as when it points at a directory that is
 * gone, is found here all the same. A command run in it fails, and
 * `isRefusedRepo` then says whether git's refusal is why.
 */
export async function locateRepo(dir: string): Promise<LocatedRepo | null> {
	const dotGit = await fs.stat(path.join(dir, ".git")).catch(() => null);
	if (dotGit) return { toplevel: dir, git: repoGit(dir) };

	const git = repoGit(dir);
	if (!(await git.checkIsRepo())) return null;
	const toplevel = (await git.revparse(["--show-toplevel"])).trim();
	return { toplevel, git: repoGit(toplevel) };
}

/**
 * Whether git refuses to treat a directory as a repository, which a command
 * run there in the repository `locateRepo` found by its `.git` says by
 * failing. A failure that has another cause, such as a missing commit, leaves
 * this false, so the caller keeps its own answer for it.
 */
export async function isRefusedRepo(dir: string): Promise<boolean> {
	try {
		return !(await repoGit(dir).checkIsRepo());
	} catch {
		return false;
	}
}
