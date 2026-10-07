# AGENTS.md

Read `README.md` first for the product overview, environment behaviour, and the standard development commands.

## Repository Guidance

- Give every endpoint that changes a file or a repo a method other than `GET`, `HEAD`, or `OPTIONS`. The `RIFT_ALLOW_WRITES` switch refuses requests by method, so a mutating `GET` would bypass it.
- Validate API changes with tests, and UI changes in the real client on Android (see Testing on Android).
- Hold every change to the speed requirements, and measure one that could slow an interaction (see Speed requirements).
- Run `bun run lint`, `bun run format:check`, and `bun test` before handing work off.

## Testing on Android

Rift's users reach it from Chrome on Android, so that is where a UI change has to work. The on-screen keyboard, touch selection and the visual viewport all behave differently there than in desktop Chrome, and bugs in them pass unit tests and desktop checks alike. When the machine has the Android emulator, test in its Chrome; desktop Chrome at phone width (360px and 412px) is the fallback.

- The emulator cannot resolve tailnet names. Run `bun scripts/emulator-proxy.ts`, which serves the deployed Rift under `/rift/` on `127.0.0.1:13001`, then `adb reverse tcp:8080 tcp:13001`, and open `http://localhost:8080/rift/` in the emulator's Chrome.
- Drive it as a person would: `adb shell input` taps, swipes and key events, and the on-screen keyboard for typing. Record with `adb shell screenrecord`.
- To measure layout and scrolling, forward Chrome's DevTools socket with `adb forward tcp:9222 localabstract:chrome_devtools_remote` and attach a CDP client, such as Playwright's `connect_over_cdp`. Sample positions frame by frame before deciding what causes a jump.
- Exercise changes in a scratch repository under one of the roots, never in a real one, and check staging with `git diff --cached`.
- Leave the emulator's other apps and their data alone. Never take control of the host's desktop windows or keyboard to reach a browser.

## Android UI Guidelines

Follow Android's UI guidelines by default, and depart from them only where a decision has been made to, recorded below. In particular:

- Make every touch target at least 48dp square, which is 48 CSS pixels ([Android accessibility](https://developer.android.com/guide/topics/ui/accessibility/apps)).
- Set text meant for reading, such as the editor's, at Material 3's Body Large size of 16sp, which is 16 CSS pixels ([Material 3 type scale](https://m3.material.io/styles/typography/type-scale-tokens)).

Decided departures:

- Line-picking targets are only a line tall (24px), because a target per line could be 48px tall only if every line were. To make up for it, a changed line's number picks it as well as its 36px-wide gutter cell.

## Speed requirements

The requirements are on the UI, as a user experiences it on a phone: every interaction should answer so quickly that the wait goes unnoticed. Rift is used from Chrome on Android phones, as an installed PWA, over Tailscale to the server machine, so each figure holds on a phone, with its network hop and its CPU included. Each is a 90th percentile.

* Every interaction shows its result within 100 ms of the finger lifting, the long-standing limit for a response to feel instantaneous ([Nielsen](https://www.nngroup.com/articles/response-times-3-important-limits/)). Opening a file is done once its changes are marked and the Stage strips above them can act. Staging, unstaging and saving are done once the editor shows the new state and its strips can act again.
* An interaction that needs nothing from the server—picking a line, typing, moving between changes, the Unstaged/Staged switch, going back to the list—draws its result within 50 ms. Chrome's RAIL model gives input handling 50 ms so that the result reaches the screen within 100 ms even when the input arrives while the page is busy ([RAIL](https://web.dev/articles/rail)).

Times run from the finger lifting, or the key going down, to the end of the main thread's work on the frame that first draws the result. The display shows that frame a refresh or two later.

### Meeting them

Nothing below is a requirement in itself. Each is a way to keep an interaction within its time on a phone, and a change that meets the requirements another way needs none of them.

- Wait on at most one round trip to the server: send the requests an interaction needs together, or as one. Each further round trip adds another hop over the network, which no work on the server can shorten.
- Keep each endpoint the client waits on within about 50 ms on loopback on the server machine, writes included, which leaves the rest of the 100 ms for the hop and for Chrome to handle the response and draw it.
- Draw what the client already knows without waiting for the server, and fetch or build ahead what the next tap will need, as the Unstaged/Staged switch keeps both sides of a file built.

### Where the server's time goes

The server runs each git command as a process of its own, through simple-git, and starting a process is slow on Windows. On the server machine in October 2026, each git process added about 35 ms to an endpoint while the machine was otherwise quiet, and up to seven times that while other work loaded it. Two things make each start dearer than it need be:

- The `git` on Windows' PATH is Git for Windows' launcher in `cmd`, which starts the real `git.exe` in turn, so each command starts two processes. Started with `Bun.spawn`, the real `git.exe` took 15 ms and the launcher 27 ms.
- simple-git starts processes with `node:child_process`, which under Bun took 12 to 14 ms longer each than `Bun.spawn`.

Before running the command it was asked for, an endpoint checks that the directory is a repository, and one that names a file also finds the repository's top level. So `/api/git/diff` and `/api/git/base-content` start three processes, `/api/git/status` and `/api/git/log` two, staging or unstaging by line five, and committing six. `/api/files/content` starts none and answers in about a millisecond.

### Measuring speed

`scripts/measure-speed.ts` times the running service from the server machine, 20 times each by default, and reports the median and the 90th percentile. Its client mode needs `scripts/emulator-proxy.ts` running:

```powershell
bun scripts/emulator-proxy.ts
bun scripts/measure-speed.ts --repo <root>/<scratch repo>
```

- `--mode server` times each endpoint the client waits on, straight to `127.0.0.1:13000`.
- `--mode spawn` times starting git from Bun, through the launcher and directly, with `node:child_process` and with `Bun.spawn`.
- `--mode client` drives headless Chrome at a phone's width through the proxy: opening a changed file from the Files list, picking a line, staging a change from its strip, the switch, going back to the list, opening the Files tab from the History tab, typing, and saving.
- `--mode device` times the same interactions in Chrome on an Android device, as described below.

Without `--mode` it runs the first three. It stages, unstages and saves one file in the repo named, one with unstaged changes in two or more places and nothing staged (`--file` chooses it), then puts the file and its index entry back as they were, so name a scratch repository. `--runs` sets the count, and `--cpu-slowdown 4` runs Chrome's CPU four times slower.

The requirements hold on a phone, and the server and client figures leave out its network hop and its slower CPU, so they are a floor: a requirement missed on the server machine is missed on a phone too, but one met there may still be missed on one. `tailscale ping <phone>` from the server machine times the hop.

#### On an Android device

Device mode runs on the server machine, like the others, and drives a device attached to that machine's adb, sending each tap and key through Android's own input pipeline with `adb shell input`:

```powershell
bun scripts/measure-speed.ts --mode device --serial <serial> --client <rift url> --repo <root>/<scratch repo>
```

- `--serial` names the device as `adb devices` lists it. Every adb command the script runs names it, so no other attached device is touched.
- `--client` is Rift's address as the device reaches it.
- `--adb` gives adb's path, when adb is not on the PATH or under `ANDROID_HOME` or `ANDROID_SDK_ROOT`.

Open Rift on the device first, in a Chrome tab or the installed app, and leave it in the foreground with no unsaved edits. The script forwards Chrome's DevTools socket, which the installed app shares, and attaches to that page. It will not open a page itself, because on a phone a page opened over DevTools stays in the background and the taps would land on whatever is showing, and it will not start on a page with unsaved edits, because it navigates the page. It maps the page's CSS pixels to the screen's by tapping twice on a layer it lays over the page, which takes both taps and does nothing with them, and it taps only elements a finger could reach on screen.

Each figure runs from the input event's `timeStamp`, which Android sets when it takes the touch or key, so the time adb spends delivering the input is left out. Chrome keeps that timestamp on the same monotonic clock as `performance.now()`, and the script checks each one: it has to fall after the script began watching for the result and before the page's first handler ran. The report also gives the time from the timestamp to that handler, and adb's delivery time.

When the run ends, or fails, or is stopped with Ctrl+C, the script puts back the page's URL and its `localStorage`, which holds the selected repo and any drafts, closes the on-screen keyboard if it is up, and puts the file and its index entry back.

- For the emulator, run `bun scripts/emulator-proxy.ts` and `adb -s <serial> reverse tcp:8080 tcp:13001`, open `http://localhost:8080/rift/` in its Chrome (see Testing on Android), and pass that address as `--client`.
- For a phone, turn on USB or wireless debugging, check that `adb devices` lists it, open Rift at the address it normally uses, and pass that address as `--client`. It has to stay unlocked, with Rift in the foreground, until the run ends.

A device run sends taps and key presses to the device for several minutes, so run it on someone's phone only once they have agreed to it.

Only a phone's figures show a requirement met, because only they include a phone's network hop and its CPU. The emulator, like the server machine, gives a floor.

## Deployment

Rift runs continuously from a prebuilt bundle, so editing source does not change what the running server serves. Rebuild and redeploy as soon as a task is complete, before asking for approval to commit — every change is tested on a phone, and a change that is not deployed cannot be tested:

- Run `bun run build`, then restart the `Rift` Windows service (`nssm restart Rift`)
- Confirm the restart in `%LOCALAPPDATA%\Rift\rift.out.log`; NSSM rotates the log on each start
- The service is managed by NSSM, and its environment—roots, host, port, and access settings—lives in the service configuration outside the repo. Change deployment settings there, not here

Deploying uncommitted work is expected, so the running bundle often reproduces no commit. Rebuild after every later change, including anything that comes out of review, so the deployment never lags the working tree.

## Dependency Management

Always pin dependencies to exact versions — no `^`, `~`, or bare package names. `.bunfmt` sets `save-exact=true` so `bun add` pins automatically. `bun.lock` must be committed.

The root `package.json` overrides `@codemirror/state`, `@codemirror/view`, and `@codemirror/language`, so every CodeMirror package shares the client's copy; without them, bumping the client's pins leaves the language packages on the old version, and two copies of `@codemirror/state` break the editor. The overrides decide what is installed, and Dependabot bumps only the client's pins, so raise the overrides to match on the Dependabot branch. A client test fails while they disagree.
