# AGENTS.md

Read `README.md` first for the product overview, environment behaviour, and the standard development commands.

## Repository Guidance

- The CLI in `cli/` must stay in feature parity with the web client; if you add or change a web-facing endpoint, update the CLI as well.
- When validating against the live system, use the CLI entry point (`bun run --cwd cli src/index.ts`) rather than ad-hoc `curl` commands or throwaway scripts.
- Run `bun run lint`, `bun run format:check`, and `bun test` before handing work off.

## Dependency Management

Always pin dependencies to exact versions — no `^`, `~`, or bare package names. `.bunfmt` sets `save-exact=true` so `bun add` pins automatically. `bun.lock` must be committed.
