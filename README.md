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

The development server refuses writes unless they are enabled, like any other instance (see [Access control](#access-control)). To edit and stage during development, set `RIFT_ALLOW_WRITES` first:

```powershell
$env:RIFT_ALLOW_WRITES = "1"
bun run dev
```

The Vite dev server listens on every interface. Its API proxy marks requests from other devices as forwarded and strips any Tailscale headers they carry, so the API refuses them; during development the API is usable only from this machine.

If `REPOS_ROOT` is unset, Rift infers it from the current working directory. When you run Rift from a checkout under your home directory, it looks for a common source directory name between your home directory and the checkout root, using the first match it finds. The recognised names are `src`, `source`, and `repos`, case-insensitively. If Rift cannot infer a source root that way, the server refuses to start — set `REPOS_ROOT` explicitly so a misconfigured run does not expose your entire home directory.

Set `REPOS_ROOT` explicitly to override that behaviour:

```powershell
REPOS_ROOT=/path/to/repos bun run dev
```

### Multiple roots

`REPOS_ROOT` accepts several directories separated by the platform path delimiter (`;` on Windows, `:` elsewhere):

```powershell
$env:REPOS_ROOT = "C:\Users\you\Src\you;C:\Users\you\OneDrive\Notes"
```

Each root is named after its final path segment, and that label qualifies every repo name the API returns — `you/Rift`, `Notes/Journal`. Roots whose last segment collides grow leftward until the labels differ. A drive root such as `O:\` is named after its letter (`O`), and the POSIX root `/` is named `root`. A repo name always resolves against the single root it names, so one root can never reach into another.

Rift only lists repositories that are immediate children of a root. Point each root directly at a directory of checkouts rather than at a tree containing them; the shallow scan is what keeps large sibling folders, such as photo or archive directories, from being walked on every dashboard load.

### Serving other devices

`bun run prod` builds the app and starts the server. Other devices reach it through `tailscale serve`, which forwards from localhost:

```powershell
bun run tailscale && bun run prod
```

### Access control

The server binds to `127.0.0.1` by default, and refuses to start if `HOST` names anything other than a loopback address: an address in `127.0.0.0/8`, `::1`, or `localhost`.

Rift checks every request, for the client as well as the API, and sorts it by how it arrived:

* A request with no proxy headers came straight from a process on this machine, such as the Vite dev server or a local browser. Rift allows it, since such a process can already read and write the files directly.
* A request with any proxy header (`x-forwarded-for`, `forwarded`, `via`, or any `tailscale-*` header, among others) came through a proxy. Rift allows it only if `tailscale serve` identified the caller, in `tailscale-user-login`, as one of the logins in `RIFT_ALLOWED_LOGINS`. Everything else gets a 403: Funnel requests, requests from tagged devices (which carry no identity), and requests from other logins. tailscaled replaces any identity header the caller sends, so the login cannot be forged through it.

The loopback binding is what makes the first rule safe. Bound to loopback, the server can be reached from another machine only through tailscaled, and everything tailscaled forwards carries proxy headers.

`RIFT_ALLOWED_LOGINS` is a comma-separated list of Tailscale logins, compared case-insensitively. When it is unset or empty, every proxied request is refused, so a deployment that omits it fails closed.

```powershell
$env:RIFT_ALLOWED_LOGINS = "you@example.com,partner@example.com"
```

`RIFT_ALLOW_WRITES` decides whether Rift may change anything. Unless it is `1`, `true`, `yes`, or `on`, every request that would change the filesystem or a repository (saving a file, staging, unstaging, committing) gets a 403, from local callers as well as proxied ones. The switch treats every method other than `GET`, `HEAD`, and `OPTIONS` as a write. The client reads the setting from `/api/health` and disables its editing, staging and commit controls when writes are refused.

```powershell
$env:RIFT_ALLOW_WRITES = "1"
```

The server logs both settings when it starts, and logs each request it refuses.

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
