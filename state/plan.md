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

## Task 3: WebSocket relay

### Requirements

Add the WebSocket layer on top of the session manager so clients can stream messages to and from an agent session in real time.

- WebSocket endpoint at `ws://host/api/sessions/:id/ws`:
  - On connect, send a `history` message containing the session's buffered messages
  - Relay incoming `ClientMessage` (parsed from JSON) to the adapter via `send()`
  - Relay adapter `ServerMessage` events to all connected WebSocket clients
  - Handle client disconnect gracefully — do not stop the session
  - If the session id does not exist or is stopped at connect time, close the socket with code 4404 or 4410 and a JSON error message
  - If a session stops while clients are connected (adapter exit or explicit delete), send a `session_event` with `event: "stopped"` to all connected clients, then close their sockets with code 4410
- Support multiple simultaneous WebSocket connections to the same session
- Maximum incoming WebSocket message size: 1 MB. Messages exceeding this are rejected and the socket is closed with an error
- On adapter error or crash, send a `session_event` error message to all connected clients
- Graceful shutdown: close all WebSocket connections with a close frame before the server exits (extends the SIGTERM/SIGINT handler from Task 2)
- Add WebSocket upgrade proxy to the Vite dev server config so that `ws://localhost:5173/api/sessions/:id/ws` proxies to Express

### Verification

- Integration test: create echo session via REST, connect WebSocket client, send a `user_message`, verify `assistant_text` and `tool_use`/`tool_result` events arrive in order
- Test reconnection: connect, receive events, disconnect, reconnect, verify `history` message replays all prior events
- Test invalid session: connect to a non-existent session id, verify socket closes with error code
- Test stopped session: stop a session via REST, attempt WebSocket connect, verify it closes with error

### Validation

- Start server (echo mode)
- Create a session with curl, then `wscat -c ws://localhost:3000/api/sessions/<id>/ws`
- Observe the `history` message (empty initially)
- Type a message, observe echo response with simulated tool-call events
- Disconnect and reconnect, confirm `history` replays all prior messages

---

## Task 4: App shell with tab bar and routing

### Requirements

Set up the frontend navigation structure, global error handling, and PWA configuration. After this task the app has a bottom tab bar, four routed views, and installs as a standalone PWA.

- On app load, fetch `GET /api/health` to determine whether the working directory is a git repo. If the health check fails, default to showing all four tabs (optimistic). Retry on next tab navigation
- React Router with four routes: `/chat`, `/files`, `/changes`, `/history`; default redirect to `/chat`
- Bottom tab bar component with icons and labels for each tab; highlights the active tab. If the working directory is not a git repo, hide the Changes and History tabs
- Each route renders a placeholder page with the tab name as heading
- Mobile viewport meta tag, full-height layout, no horizontal scroll
- `vite-plugin-pwa` configured with:
  - Service worker: `cacheFirst` for Vite's content-hashed static assets (`/assets/*`), `networkFirst` for the navigation route (`index.html`), `networkFirst` for API calls
  - `skipWaiting` and `clientsClaim` enabled so new versions activate immediately
  - `manifest.json` with app name "Imp", theme colour, `display: standalone`
- CSS reset and base styles: system font stack, dark theme, touch-friendly tap targets (minimum 44px)
- Shared `useApi` hook or utility for REST calls that handles non-2xx responses by parsing the error envelope and surfacing errors through a toast/banner component at the top of the screen. All subsequent frontend tasks use this utility for API calls
- All views show a loading indicator (spinner or skeleton) during initial data fetch. This is a cross-cutting requirement for all frontend tasks (5–9), driven by the latency of phone-over-Tailscale connections

### Verification

- Component tests: tab bar renders four tabs, clicking a tab navigates to the correct route
- PWA: assert `manifest.json` exists in build output with required fields; assert service worker file is generated
- Component test: error banner renders when `useApi` encounters a non-2xx response

### Validation

- Open app on phone, confirm tab bar appears at bottom with four tabs
- Tap each tab, confirm navigation works and the correct placeholder renders
- Add to home screen (iOS or Android), reopen — app launches in standalone mode without browser chrome

---

## Task 5: Session hook and WebSocket connection

### Requirements

Build the client-side session lifecycle management and WebSocket connection hook. This task handles all the plumbing; Task 6 builds the UI on top of it.

- **`useAgentSession` hook** (`client/src/hooks/useAgentSession.ts`):
  - On mount, check `localStorage` for an existing session id
  - If found, fetch session status from `GET /api/sessions/:id`. If the session is still `running`, connect WebSocket. If the response is 404 (e.g., server restarted and lost all sessions), treat it the same as "not found in localStorage"
  - If not found in localStorage, or session is `stopped`, or the server returned 404: clear the stored id, create a new session via `POST /api/sessions`, store the new id in `localStorage`, connect WebSocket
  - Expose: `messages: ServerMessage[]`, `send(content: string): void`, `status: "connecting" | "connected" | "disconnected" | "error" | "stopped"`, `sessionId: string | null`, `newSession(): void`
  - When a `session_event` with `event: "stopped"` is received, set status to `"stopped"`. The UI should disable the send button and prompt the user to start a new session
  - `newSession()`: stops the current session (if running), clears `localStorage`, creates a fresh session — provides the user a recovery path when a session is stuck
  - On receiving a `history` message, replace local `messages` state with the replayed history
  - On WebSocket close, reconnect with exponential backoff (initial 1s, max 30s, reset on successful connect)
  - On `session_event` with `error`, surface it via the status and include the error message
- Single-tab usage is the expected mode for this phone-first app. No multi-tab coordination is implemented
- Concurrent sends (user sends another message while the agent is still processing) are allowed — messages are forwarded to the adapter's `send()`. Behaviour depends on the adapter: the echo adapter processes them independently; the deferred ClaudeCodeAdapter request must define whether Claude Code queues or rejects concurrent input

### Verification

- Hook test with mock WebSocket: verify session creation flow (no localStorage → POST → connect)
- Hook test: verify reconnection flow (localStorage has id → GET → connect)
- Hook test: verify reconnect with backoff on disconnect (mock timers)
- Hook test: verify `history` message replaces message state
- Hook test: verify `send()` serialises a `ClientMessage` and sends over WebSocket
- Hook test: verify `newSession()` stops old session, clears storage, creates new one

### Validation

- Start server (echo mode)
- Open browser dev tools, confirm a session is created and WebSocket connects (network tab)
- Refresh the page, confirm the same session id is reused and history is replayed
- Stop the server, wait, restart — confirm the client reconnects automatically

---

## Task 6: Chat view

### Requirements

Build the chat UI that renders the conversation using the `useAgentSession` hook from Task 5. This replaces the Chat tab placeholder from Task 4.

- **`DiffViewer` component** (`client/src/components/DiffViewer.tsx`): a reusable component that renders a unified diff with line-level red/green colouring. Accepts a diff string as input. Tasks 8 and 9 reuse this component. Build this component first within this task
- **Message rendering:**
  - User messages: plain text in a right-aligned bubble
  - `assistant_text`: rendered as Markdown using `react-markdown`, left-aligned
  - `tool_use`: collapsible card showing the tool name as header. Summary line derived from the tool name and first key of the input (e.g., "Read: src/index.ts", "Bash: npm test"). Collapsed by default. Expandable body shows the input as formatted JSON
  - `tool_result`: appended inside the corresponding `tool_use` card (matched by `id`). Assumption: `tool_use` always arrives before its corresponding `tool_result` (the adapter guarantees this ordering). If a `tool_result` arrives without a matching `tool_use` in the current message list (e.g., due to buffer eviction), render it as a standalone preformatted block. Output shown as preformatted text. If the output contains a unified diff, render it with `DiffViewer`
  - Diff detection heuristic: look for consecutive lines matching `--- a/<path>` and `+++ b/<path>` (with actual file paths) followed immediately by at least one `@@ ... @@` hunk header. This is checked regardless of tool name. Document that false positives are possible but unlikely given the path requirement
  - `session_event` with `error`: rendered as a dismissible error banner at the top
- **Chat header:** "New session" button that calls `newSession()` from the hook, with a confirmation prompt
- **Input bar:**
  - Text area that auto-grows up to 6 lines, pinned to the bottom above the tab bar
  - Send button (disabled when input is empty or session status is not `connected`)
  - Enter sends on desktop; shift+enter for newline
- **Auto-scroll:** scroll to bottom on new messages unless the user has scrolled up manually (detected by scroll position being more than 100px from bottom). Resume auto-scroll when the user scrolls back to the bottom
- **Connection status:** small indicator dot in the header (green = connected, yellow = connecting, red = disconnected)

### Verification

- Component tests for `DiffViewer`: renders coloured lines for valid unified diffs; renders plain text for non-diff content; handles empty input
- Component tests for `MessageList`: renders user bubbles, Markdown content, tool cards
- Component tests for `ToolCallCard`: renders summary, expands on tap to show detail, appends tool result when received, renders standalone block for unmatched `tool_result`
- Component tests for `ChatInput`: auto-grows, disables send when empty or disconnected
- Test diff detection: strings with `--- a/file`/`+++ b/file`/`@@` render as coloured diff; strings with just `---` or `---`/`+++` without paths do not

### Validation

- Start server (echo mode), open Chat tab on phone
- Send a message, observe the echo response with Markdown formatting and tool-call cards
- Tap a tool card to expand it, confirm JSON input and preformatted output display correctly
- Close the browser tab, reopen, confirm chat history is restored
- Scroll up mid-conversation, confirm auto-scroll pauses; scroll back to bottom, confirm it resumes
- Observe the connection status indicator changes colour when server is stopped/restarted
- Tap "New session", confirm a fresh session is created

---

## Task 7: File browser

### Requirements

Add a file tree and syntax-highlighted file viewer to the Files tab.

- REST endpoints:
  - `GET /api/files?path=<dir>` — returns directory listing (name, type, size) for the given path relative to the working directory; defaults to root. Entries sorted: directories first, then files, alphabetically. Respects `.gitignore` rules by using `git check-ignore` via `simple-git` (if the working directory is a git repo) to filter out ignored files and directories. When checking directories, append a trailing `/` to the path so that patterns like `node_modules/` match correctly. In non-git directories, all files are shown. Maximum 1,000 entries returned; if a directory exceeds this, return the first 1,000 with a `truncated: true` flag
  - `GET /api/files/content?path=<file>` — returns file content as plain text. Maximum file size: 1 MB; files exceeding this return 413 with the standard error envelope. Binary files (detected by null bytes in the first 8 KB) return 415 with a message indicating binary files are not supported
  - **Security:** both endpoints normalise and validate the `path` parameter against the working directory root. Reject any resolved path that escapes the working directory with 403 and the standard error envelope
- Frontend Files view (replaces the Files tab placeholder):
  - Collapsible directory tree, lazy-loaded (fetches children on expand)
  - Tapping a file opens it in a read-only CodeMirror 6 editor configured with `EditorView.editable(false)` and `EditorState.readOnly`. Syntax highlighting by file extension. Language packages are lazy-loaded (dynamic `import()`): the file renders immediately as plain text, and highlighting applies asynchronously once the language pack loads. Unrecognised extensions remain as plain text with no error. Core languages: JavaScript/TypeScript, Python, Go, Rust, JSON, Markdown, CSS/HTML, shell scripts
  - Binary files and oversized files show an appropriate error message instead of the editor
  - Truncated directory listings show a message indicating not all entries are displayed
  - Breadcrumb bar showing current path
  - Back button returns to tree from file view

### Verification

- API tests: directory listing returns correct entries sorted correctly; gitignored files are excluded; file content returns correct text; path traversal attempts (`../`, absolute paths) return 403; oversized file returns 413; binary file returns 415; directory with >1,000 entries returns truncated result
- Component tests: tree expands directories, file tap opens viewer, error states render appropriate messages

### Validation

- Open Files tab on phone, browse the project directory, open a source file, confirm syntax highlighting renders correctly
- Confirm `node_modules` is not shown (assuming it is gitignored)
- Verify scrolling within the editor works smoothly and does not conflict with tab swiping
- Attempt to navigate above the working directory via URL manipulation, confirm it is rejected
- Open a large file (>1 MB), confirm an error message is shown

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
