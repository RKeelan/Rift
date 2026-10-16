import fs from "node:fs/promises";
import path from "node:path";
import { GitError, gitText } from "./runGit.js";

/**
 * A repository's top level, where Rift runs its git commands.
 */
export interface LocatedRepo {
	toplevel: string;
}

/**
 * Finds the repository a directory belongs to, or null when it is in none.
 *
 * Starting a git process costs about 15 ms on Windows, so a directory with a
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
	if (dotGit) return { toplevel: dir };

	if (!(await inWorkTree(dir))) return null;
	const toplevel = (
		await gitText(dir, ["rev-parse", "--show-toplevel"])
	).trim();
	return { toplevel };
}

// git's message for a directory outside any repository, or in one it
// refuses. git translates its messages; this knows the English and German.
const NOT_A_REPOSITORY = /not a git repository|kein git-repository/i;

/**
 * Whether git takes a directory to be in a repository's working tree. git
 * says "true", or "false" inside a `.git` directory, and fails, saying the
 * directory is not a git repository, outside any repository. A failure with
 * another cause, such as a repository owned by someone else, is thrown.
 */
export async function inWorkTree(dir: string): Promise<boolean> {
	try {
		const answer = await gitText(dir, ["rev-parse", "--is-inside-work-tree"]);
		return answer.trim() === "true";
	} catch (err) {
		if (
			err instanceof GitError &&
			err.exitCode === 128 &&
			NOT_A_REPOSITORY.test(err.message)
		) {
			return false;
		}
		throw err;
	}
}

/**
 * Whether git refuses to treat a directory as a repository, which a command
 * run there in the repository `locateRepo` found by its `.git` says by
 * failing. A failure that has another cause, such as a missing commit, leaves
 * this false, so the caller keeps its own answer for it.
 */
export async function isRefusedRepo(dir: string): Promise<boolean> {
	try {
		return !(await inWorkTree(dir));
	} catch {
		return false;
	}
}
