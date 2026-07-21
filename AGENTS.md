# AGENTS.md

Read `README.md` first for the product overview, environment behaviour, and the standard development commands.

## Repository Guidance

- The CLI in `cli/` must stay in feature parity with the web client; if you add or change a web-facing endpoint, update the CLI as well.
- When validating against the live system, use the CLI entry point (`bun run --cwd cli src/index.ts`) rather than ad-hoc `curl` commands or throwaway scripts.
- Run `bun run lint`, `bun run format:check`, and `bun test` before handing work off.

## Deployment

Rift runs continuously from a prebuilt bundle, so editing source does not change what the running server serves. After any change expected to work, rebuild and redeploy it:

- Run `bun run build`, then restart the `Rift` scheduled task
- Confirm the restart in `%LOCALAPPDATA%\Rift\rift.out.log`, which is overwritten on each start
- The task runs a wrapper script kept outside the repo, holding the roots, host, and port for the machine it serves. Change deployment settings there, not here

Build from a committed state. A bundle built from uncommitted work reproduces no branch, which makes a later rebuild silently change what is deployed.

## Dependency Management

Always pin dependencies to exact versions — no `^`, `~`, or bare package names. `.bunfmt` sets `save-exact=true` so `bun add` pins automatically. `bun.lock` must be committed.
