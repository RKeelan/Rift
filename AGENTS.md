# AGENTS.md

Read `README.md` first for the product overview, environment behaviour, and the standard development commands.

## Repository Guidance

- Give every endpoint that changes a file or a repo a method other than `GET`, `HEAD`, or `OPTIONS`. The `RIFT_ALLOW_WRITES` switch refuses requests by method, so a mutating `GET` would bypass it.
- Validate API changes with tests, and UI changes in the real client on Android (see Testing on Android).
- Run `bun run lint`, `bun run format:check`, and `bun test` before handing work off.

## Testing on Android

Rift's users reach it from Chrome on Android, so that is where a UI change has to work. The on-screen keyboard, touch selection and the visual viewport all behave differently there than in desktop Chrome, and bugs in them pass unit tests and desktop checks alike. When the machine has the Android emulator, test in its Chrome; desktop Chrome at phone width (360px and 412px) is the fallback.

- The emulator cannot resolve tailnet names. Run `bun scripts/emulator-proxy.ts`, which serves the deployed Rift under `/rift/` on `127.0.0.1:13001`, then `adb reverse tcp:8080 tcp:13001`, and open `http://localhost:8080/rift/` in the emulator's Chrome.
- Drive it as a person would: `adb shell input` taps, swipes and key events, and the on-screen keyboard for typing. Record with `adb shell screenrecord`.
- To measure layout and scrolling, forward Chrome's DevTools socket with `adb forward tcp:9222 localabstract:chrome_devtools_remote` and attach a CDP client, such as Playwright's `connect_over_cdp`. Sample positions frame by frame before deciding what causes a jump.
- Exercise changes in a scratch repository under one of the roots, never in a real one, and check staging with `git diff --cached`.
- Leave the emulator's other apps and their data alone. Never take control of the host's desktop windows or keyboard to reach a browser.

## Deployment

Rift runs continuously from a prebuilt bundle, so editing source does not change what the running server serves. Rebuild and redeploy as soon as a task is complete, before asking for approval to commit — every change is tested on a phone, and a change that is not deployed cannot be tested:

- Run `bun run build`, then restart the `Rift` Windows service (`nssm restart Rift`)
- Confirm the restart in `%LOCALAPPDATA%\Rift\rift.out.log`; NSSM rotates the log on each start
- The service is managed by NSSM, and its environment—roots, host, port, and access settings—lives in the service configuration outside the repo. Change deployment settings there, not here

Deploying uncommitted work is expected, so the running bundle often reproduces no commit. Rebuild after every later change, including anything that comes out of review, so the deployment never lags the working tree.

## Dependency Management

Always pin dependencies to exact versions — no `^`, `~`, or bare package names. `.bunfmt` sets `save-exact=true` so `bun add` pins automatically. `bun.lock` must be committed.
