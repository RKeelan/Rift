import { type SimpleGitOptions, simpleGit } from "simple-git";

/**
 * A git client for a repository. `git status` refreshes the index when it
 * can, which holds the index's lock for a moment, and a stage or commit that
 * wants the lock meanwhile fails at once. The Files list polls status every
 * few seconds, so every git command Rift runs passes `--no-optional-locks`,
 * which stops status writing the index. A working-tree `git diff` still
 * refreshes it, but Rift runs one only when a file opens or changes, not on a
 * timer. Commands that change the index take its lock as before.
 *
 * simple-git's binary option carries the flag: its second element goes before
 * every command's own arguments. Setting `GIT_OPTIONAL_LOCKS` instead would
 * mean replacing the child's environment, which simple-git guards.
 *
 * `errors` has the last word on whether a command failed, for a command whose
 * exit code means something other than failure.
 */
export function repoGit(baseDir: string, errors?: SimpleGitOptions["errors"]) {
	return simpleGit({ baseDir, binary: ["git", "--no-optional-locks"], errors });
}
