# AGENTS.md

Read `README.md` first for the product overview, environment behaviour, and the standard development commands.

## Repository Guidance

- Give every endpoint that changes a file or a repo a method other than `GET`, `HEAD`, or `OPTIONS`. The `RIFT_ALLOW_WRITES` switch refuses requests by method, so a mutating `GET` would bypass it.
- Validate API changes with tests, and UI changes in the real client in a browser at phone width (360px and 412px).
- Run `bun run lint`, `bun run format:check`, and `bun test` before handing work off.

## Deployment

Rift runs continuously from a prebuilt bundle, so editing source does not change what the running server serves. Rebuild and redeploy as soon as a task is complete, before asking for approval to commit — every change is tested on a phone, and a change that is not deployed cannot be tested:

- Run `bun run build`, then restart the `Rift` Windows service (`nssm restart Rift`)
- Confirm the restart in `%LOCALAPPDATA%\Rift\rift.out.log`; NSSM rotates the log on each start
- The service is managed by NSSM, and its environment—roots, host, port, and access settings—lives in the service configuration outside the repo. Change deployment settings there, not here

Deploying uncommitted work is expected, so the running bundle often reproduces no commit. Rebuild after every later change, including anything that comes out of review, so the deployment never lags the working tree.

## Dependency Management

Always pin dependencies to exact versions — no `^`, `~`, or bare package names. `.bunfmt` sets `save-exact=true` so `bun add` pins automatically. `bun.lock` must be committed.
