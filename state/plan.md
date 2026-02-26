# Plan: Multi-repo support

Replace the single-`WORKING_DIR` server model with a repo-aware server that can operate on any repository under a configurable root directory.

**Note on WebSocket/chat route**: The WebSocket endpoint operates on session IDs, and the session already carries the resolved repo path internally. No changes needed to `ws.ts`.

## Task 1: Replace WORKING_DIR with REPOS_ROOT and reparameterise file/git routes

### Requirements

- Replace `WORKING_DIR` env var with `REPOS_ROOT` (defaults to `~/Src`). Update `AppConfig` to replace `workingDir` with `reposRoot`. Update `createApp()` in `app.ts` to pass `config.reposRoot` to route factories instead of `config.workingDir`
- Add a shared repo-resolution utility that takes `(reposRoot, repoName)` and returns a validated absolute path: the repo name is a relative path (e.g. `RKeelan/Rift`), must not contain `..` or be absolute, must resolve to a directory under `reposRoot`, and must exist. Returns null/throws on invalid input
- Reparameterise `fileRoutes(workingDir)` → `fileRoutes(reposRoot)`: each request must include a `repo` query parameter, resolved via the utility above. Remove the cached `gitRepoStatus` closure variable (`files.ts` lines 72-78), which assumes a single working directory; re-check per request instead
- Reparameterise `gitRoutes(workingDir)` → `gitRoutes(reposRoot)`: each request must include a `repo` query parameter. Replace the single `simpleGit(workingDir)` instance created at router-creation time (`git.ts` line 46) with per-request `simpleGit(resolvedPath)` calls
- Update health endpoint to accept an optional `repo` query parameter; without it, return `{ status: "ok" }` without `gitRepo`
- Update `.env.example` to document `REPOS_ROOT` and remove `WORKING_DIR`
- Update startup log in `index.ts` to show `REPOS_ROOT` instead of `Working directory`
- Update all existing server tests to pass `repo` where needed

### Verification

- Test `GET /api/files?repo=foo&path=.` resolves correctly
- Test `GET /api/git/status?repo=foo` resolves correctly
- Test that a `repo` value with `..` or absolute path is rejected (403)
- Test that a nonexistent repo returns 404
- Existing file and git tests pass (updated to include `repo`)

### Validation

- `curl localhost:3000/api/files?repo=Rift&path=.` lists Rift's root directory
- `curl localhost:3000/api/git/status?repo=Rift` shows git status

## Task 4: Update the CLI for multi-repo support

Depends on: Tasks 1, 2, 3

### Requirements

- Add `repos list` command that calls `GET /api/repos`
- Add `--repo <name>` option to `files ls`, `files cat`, `git status`, `git diff`, `git log`, `git show`, and `git show-diff` commands (appends `repo=<name>` to query params)
- Add `--repo <name>` option to `session create` (sends `{ repo }` in the POST body)
- Update `health` command to accept optional `--repo`
- Note: the `chat` command operates on an existing session ID and needs no changes

### Verification

- Existing CLI tests updated for `--repo` parameter

### Validation

- `bun run --cwd cli src/index.ts repos list` shows repos
- `bun run --cwd cli src/index.ts files ls --repo Rift` lists Rift's root directory
- `bun run --cwd cli src/index.ts session create --repo Rift` creates a session

## Task 5: Add session dashboard and repo picker to the client

Depends on: Tasks 1, 2, 3

### Requirements

- Replace the current auto-create-single-session flow with a dashboard model that supports multiple concurrent sessions
- Add a dashboard page (`/` or `/sessions`) as the app's landing page. It shows:
  - Active sessions (from `GET /api/sessions`), each displaying its repo name and creation time. Tapping a session navigates to it
  - A stop/close action on each active session (calls `DELETE /api/sessions/:id`); stopped sessions disappear from the list
  - A "New Session" action that opens the repo picker
- Add a repo picker (page or modal) that calls `GET /api/repos`, displays available repos, and creates a session via `POST /api/sessions { repo: "<name>" }` on selection
- Add a `SessionContext` provider that stores the currently selected session (id and repo name) and exposes it to all pages. Populate it when navigating to a session from the dashboard
- Restructure routing: session-specific pages (`/chat`, `/files`, `/changes`, `/history`) require a session to be selected in `SessionContext`; if none, redirect to the dashboard
- Update `useAgentSession` to connect to a specific session ID (passed in, not auto-created). Remove the auto-create and localStorage-based session recovery logic
- Update `useGitRepo` to pass the `repo` query param (from `SessionContext`) to the health endpoint
- `FilesPage`, `ChangesPage`, and `HistoryPage` read the repo name from `SessionContext` and include `repo=<name>` in their API calls
- The tab bar or header shows the current repo name; tapping it returns to the dashboard

### Verification

- Hook-level tests for session selection logic
- Existing client tests updated for the new flow

### Validation

- Open the app in a browser; the dashboard appears showing any active sessions
- Tap "New Session"; the repo picker shows available repos
- Select a repo; the chat page loads with a session bound to that repo
- Files/Changes/History pages show data from the selected repo
- Navigate back to dashboard; the session appears in the list
- Stop a session from the dashboard; it disappears from the active list
- Create a second session in a different repo; both appear on the dashboard
- Tap between sessions to switch
