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

## Task 8: Changes view

### Requirements

Add a working-tree diff view to the Changes tab, showing staged and unstaged modifications. Uses the shared `DiffViewer` component from Task 6.

- REST endpoints:
  - `GET /api/git/status` — returns list of changed files with their status (modified, added, deleted, renamed, untracked) and staging state (staged, unstaged, or both). If the working directory is not a git repo, return `{ error: { code: "NOT_GIT_REPO", message: "..." } }` with status 400
  - `GET /api/git/diff?path=<file>&staged=<bool>` — returns unified diff for a specific file (staged or unstaged). If the diff exceeds 1 MB, return a truncated version with a `truncated: true` flag
  - **Security:** validate the `path` parameter the same way as the file browser endpoints (normalise, reject escapes with 403)
- Frontend Changes view (replaces the Changes tab placeholder):
  - Two sections: "Staged" and "Unstaged", each listing changed files with status badges (colour-coded: green for added, yellow for modified, red for deleted)
  - Tapping a file shows its unified diff using the shared `DiffViewer` component
  - Refresh button in the header to update status. Auto-refresh when the Changes tab gains focus (tab switch or app foreground)
  - "Last refreshed" timestamp displayed below the header
  - Empty state message when the working tree is clean
  - If the server returns `NOT_GIT_REPO`, show a message indicating the working directory is not a git repository

### Verification

- API tests using a temporary git repo: create, modify, stage, and delete files; verify status endpoint returns correct data; verify diff endpoint returns correct unified diff; verify path traversal is rejected; verify non-git directory returns `NOT_GIT_REPO`
- Component tests: file list renders staged/unstaged sections with correct badges, diff viewer displays coloured lines, non-git-repo error renders appropriate message

### Validation

- Make changes to a file in the working directory, open the Changes tab, confirm the file appears in "Unstaged"
- Stage the file with `git add`, refresh, confirm it moves to "Staged"
- Tap the file to view its diff

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
