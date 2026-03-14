# Rift

[![CI](https://github.com/RKeelan/Rift/actions/workflows/ci.yml/badge.svg)](https://github.com/RKeelan/Rift/actions/workflows/ci.yml)

Mobile-first coding agent frontend.

## Usage

```powershell
bun install
bun run dev
```

`bun run dev` starts the Express API and the Vite dev server on port 3000.

If `REPOS_ROOT` is unset, Rift infers it from the current working directory. When you run Rift from a checkout under your home directory, it looks for a common source directory name between your home directory and the checkout root, using the first match it finds. The recognised names are `src`, `source`, and `repos`, case-insensitively. If Rift cannot infer a source root that way, it falls back to your home directory.

Set `REPOS_ROOT` explicitly to override that behaviour:

```powershell
REPOS_ROOT=/path/to/repos bun run dev
```

To serve over Tailscale (e.g. from a desktop to a phone):

```powershell
bun run tailscale && bun run prod
```

`bun run prod` builds the app and starts the server with the `/rift` base path.

Set `REPOS_ROOT` explicitly for production in the same way:

```powershell
bun run tailscale && REPOS_ROOT=/path/to/repos bun run prod
```

## Development

```powershell
bun run build        # build all workspaces
bun test             # run tests
bun run lint         # lint with Biome
bun run format:check # check formatting with Biome
```
