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
