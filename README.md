# Rift

[![CI](https://github.com/RKeelan/Rift/actions/workflows/ci.yml/badge.svg)](https://github.com/RKeelan/Rift/actions/workflows/ci.yml)

Mobile-first front-end for local repositories.

## Usage

```powershell
bun install
bun run dev
```

`bun run dev` starts the Express API on port 13000 and the Vite dev server on port 5173. Open the Vite URL (not the Express port) during development.

If `REPOS_ROOT` is unset, Rift infers it from the current working directory. When you run Rift from a checkout under your home directory, it looks for a common source directory name between your home directory and the checkout root, using the first match it finds. The recognised names are `src`, `source`, and `repos`, case-insensitively. If Rift cannot infer a source root that way, the server refuses to start — set `REPOS_ROOT` explicitly so a misconfigured run does not expose your entire home directory.

Set `REPOS_ROOT` explicitly to override that behaviour:

```powershell
REPOS_ROOT=/path/to/repos bun run dev
```

By default the server binds to `127.0.0.1`. To expose it on other interfaces (for example, when fronting it with `tailscale serve`), set `HOST`:

```powershell
HOST=0.0.0.0 bun run prod
```

Tailscale's `tailscale serve` command forwards from localhost, so the default `127.0.0.1` binding is sufficient there:

```powershell
bun run tailscale && bun run prod
```

`bun run prod` builds the app and starts the server.

Set `REPOS_ROOT` explicitly for production in the same way:

```powershell
REPOS_ROOT=/path/to/repos bun run prod
```

## Development

```powershell
bun run build        # build all workspaces
bun test             # run tests
bun run lint         # lint with Biome
bun run format:check # check formatting with Biome
```

## Running as a Windows service

The scripts under `scripts\` register the built server as a Windows service via [NSSM](https://nssm.cc). Run the install script as Administrator under your own user account so the API can only touch what you can.

Prerequisites: Bun and NSSM on PATH; (optional) Tailscale signed in.

```powershell
bun install
bun run build
.\scripts\install-windows-service.ps1 -ReposRoot C:\Users\me\Src -LogonUser .\me
Start-Service Rift
```

Logs land in `logs\rift.out.log` / `logs\rift.err.log` and rotate at 10 MB. The service binds `127.0.0.1:13000` by default; pass `-BindAddress` and `-Port` to change. Omitting `-LogonUser` falls back to LocalSystem and prints a warning — don't.

To expose it over the tailnet (Tailscale forwards from localhost, so the default bind is fine):

```powershell
.\scripts\configure-tailscale.ps1
```

To remove the service:

```powershell
.\scripts\uninstall-windows-service.ps1
```
