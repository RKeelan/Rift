# Plan: Rift — Mobile-First Coding Agent Frontend

## Technology Choices

- **Backend**: TypeScript, Node.js, Express, ws (WebSocket)
- **Frontend**: React, TypeScript, Vite (with vite-plugin-pwa), CodeMirror 6
- **Structure**: Monorepo with Bun workspaces: `server/`, `client/`, `shared/`
- **Runtime/package manager**: Bun
- **Dev workflow**: Vite dev server proxies API/WebSocket to Express; production Express serves built static files. `concurrently` runs both dev servers
- **Git operations**: `simple-git` library
- **Linting/formatting**: Biome
- **Testing**: Bun's built-in test runner (`bun test`), React Testing Library (components, using `happy-dom` for DOM), supertest (API endpoints)
- **Security model**: Rift is a personal tool accessed over Tailscale. Tailscale provides the authentication and network boundary. Session endpoints do not require additional auth

---

## Task 9: Git history view

### Requirements

Add a git log view to the History tab showing recent commits with expandable diffs. Uses the shared `DiffViewer` component from Task 6.

- REST endpoints:
  - `GET /api/git/log?limit=<n>&offset=<n>` — returns commit list (hash, author, date, subject) with pagination; `limit` defaults to 25, `offset` defaults to 0. If the working directory is not a git repo, return `NOT_GIT_REPO` error as in Task 8
  - `GET /api/git/commit/:hash` — returns commit metadata and a list of changed files (path, status, additions, deletions). Does not include inline diffs; per-file diffs are fetched on demand
  - `GET /api/git/commit/:hash/diff?path=<file>` — returns the unified diff for a single file within a commit. If the diff exceeds 1 MB, return a truncated version with a `truncated: true` flag
  - **Security:** validate the `hash` parameter matches `/^[0-9a-f]{7,40}$/` (minimum 7 characters, git's default short-hash length) before passing to `simple-git`. Reject invalid values with 400 and the standard error envelope. Validate `path` the same way as file browser endpoints
- Frontend History view (replaces the History tab placeholder):
  - Scrollable list of commits showing abbreviated hash (7 chars), subject, author, relative date
  - Tapping a commit expands it inline to show the list of changed files
  - Tapping a file within an expanded commit fetches and displays its diff using `DiffViewer`
  - "Load more" button at the bottom for pagination
  - Empty state for repos with no commits
  - If the server returns `NOT_GIT_REPO`, show a message indicating the working directory is not a git repository

### Verification

- API tests using a temporary git repo with several commits: verify log pagination returns correct subsets, commit detail returns file list, per-file diff returns correct diff, malformed hash returns 400, non-git directory returns `NOT_GIT_REPO`
- Component tests: commit list renders entries with correct fields, expanding a commit shows file list, tapping a file shows diff, "Load more" button fetches next page

### Validation

- Open History tab on phone, scroll through commits, tap one to see its changed files
- Tap a file to see its diff
- Tap "Load more", confirm older commits appear
