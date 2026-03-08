# Rift

[![CI](https://github.com/RKeelan/Rift/actions/workflows/ci.yml/badge.svg)](https://github.com/RKeelan/Rift/actions/workflows/ci.yml)

Mobile-first coding agent frontend.

## Usage

```powershell
bun install
bun run dev          # start Express API + Vite dev server on port 3000
```

To serve over Tailscale (e.g. from a desktop to a phone):

```powershell
bun run tailscale & bun run prod
```

## Development

```powershell
bun run build        # build all workspaces
bun test             # run tests
bun run lint         # lint with Biome
bun run format:check # check formatting with Biome
```
