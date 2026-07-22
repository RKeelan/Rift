# AGENTS.md

Read `README.md` first for the product overview, environment behaviour, and the standard development commands.

## Repository Guidance

- The CLI in `cli/` must stay in feature parity with the web client; if you add or change a web-facing endpoint, update the CLI as well.
- When validating against the live system, use the CLI entry point (`bun run --cwd cli src/index.ts`) rather than ad-hoc `curl` commands or throwaway scripts.
- Run `bun run lint`, `bun run format:check`, and `bun test` before handing work off.

## Deployment

Rift runs continuously from a prebuilt bundle, so editing source does not change what the running server serves. Rebuild and redeploy as soon as a task is complete, before asking for approval to commit — Richard tests every change on his phone, and a change that is not deployed cannot be tested:

- Run `bun run build`, then restart the `Rift` scheduled task
- Confirm the restart in `%LOCALAPPDATA%\Rift\rift.out.log`, which is overwritten on each start
- The task runs a wrapper script kept outside the repo, holding the roots, host, and port for the machine it serves. Change deployment settings there, not here

Deploying uncommitted work is expected, so the running bundle often reproduces no commit. Rebuild after every later change, including anything that comes out of review, so the deployment never lags the working tree.

## Dependency Management

Always pin dependencies to exact versions — no `^`, `~`, or bare package names. `.bunfmt` sets `save-exact=true` so `bun add` pins automatically. `bun.lock` must be committed.
