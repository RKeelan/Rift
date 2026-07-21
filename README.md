# Rift

[![CI](https://github.com/RKeelan/Rift/actions/workflows/ci.yml/badge.svg)](https://github.com/RKeelan/Rift/actions/workflows/ci.yml)

Mobile-first front-end for local repositories.

## Usage

```powershell
bun install
bun run dev
```

`bun run dev` starts the Express API on port 13000 and the Vite dev server on port 5173. Open the Vite URL (not the Express port) during development.

The client is served under the `/rift/` sub-path, so the dev URL is <http://localhost:5173/rift/>. See [Sub-path deployment](#sub-path-deployment).

If `REPOS_ROOT` is unset, Rift infers it from the current working directory. When you run Rift from a checkout under your home directory, it looks for a common source directory name between your home directory and the checkout root, using the first match it finds. The recognised names are `src`, `source`, and `repos`, case-insensitively. If Rift cannot infer a source root that way, the server refuses to start — set `REPOS_ROOT` explicitly so a misconfigured run does not expose your entire home directory.

Set `REPOS_ROOT` explicitly to override that behaviour:

```powershell
REPOS_ROOT=/path/to/repos bun run dev
```

### Multiple roots

`REPOS_ROOT` accepts several directories separated by the platform path delimiter (`;` on Windows, `:` elsewhere):

```powershell
$env:REPOS_ROOT = "C:\Users\you\Src\you;C:\Users\you\OneDrive\Writing"
```

Each root is named after its final path segment, and that label qualifies every repo name the API returns — `you/Rift`, `Writing/Coder`. Roots whose last segment collides grow leftward until the labels differ. A repo name always resolves against the single root it names, so one root can never reach into another.

Rift only lists repositories that are immediate children of a root. Point each root directly at a directory of checkouts rather than at a tree containing them; the shallow scan is what keeps large sibling folders, such as photo or archive directories, from being walked on every dashboard load.

By default the server binds to `127.0.0.1`. To expose it on other interfaces (for example, when fronting it with `tailscale serve`), set `HOST`:

```powershell
HOST=0.0.0.0 bun run prod
```

Tailscale's `tailscale serve` command forwards from localhost, so the default `127.0.0.1` binding is sufficient there:

```powershell
bun run tailscale && bun run prod
```

`bun run prod` builds the app and starts the server.

### Sub-path deployment

The client is built with a base path of `/rift/`, set by `base` in `client/vite.config.ts`. Rift therefore lives at `https://<host>/rift` rather than at the host root, leaving the root free for other services on the same machine.

`bun run tailscale` mounts it accordingly:

```powershell
tailscale serve --bg --set-path=/rift 13000
```

`--set-path` strips the prefix before forwarding, so the server still receives `/` and `/api/...` and needs no base-path handling of its own. Only browser-facing URLs know about the prefix: the Vite dev server proxies `/rift/api` to the API with the same prefix stripped, so development and production behave alike.

Changing the base path means changing it in three places that must agree — `base` in the Vite config, the `BASE` constant in `client/src/__tests__/pwa.test.ts`, and the `--set-path` argument in the `tailscale` script. The PWA tests fail if the first two diverge.

Reinstall the PWA after changing the base path. An installed app keeps its original `start_url`, and its service worker keeps the scope it was registered with, so it will not follow the app to a new path. Uninstall it and clear the site data for the host before installing again.

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
