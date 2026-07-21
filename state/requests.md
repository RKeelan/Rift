# Deferred Requests

## ClaudeCodeAdapter implementation

Implement a `ClaudeCodeAdapter` that launches `claude --output-format stream-json` as a child process and translates its stdin/stdout protocol into Imp's `ServerMessage` types. This is deferred because the exact stdin/stdout protocol for Claude Code's `stream-json` mode has not been verified. The implementation requires:

- Researching the actual `stream-json` stdin protocol (plain text? JSON? line-delimited?)
- Mapping all stream-json output event types (`content_block_start`, `content_block_delta`, `content_block_stop`, `message_start`, `message_stop`, tool input streaming) to `ServerMessage` types
- Deciding how to aggregate streaming text deltas into `assistant_text` messages
- Buffering partial tool input before emitting a complete `tool_use` message
- Handling unknown event types, process crashes, and agent timeouts
- End-to-end testing with a real Claude Code instance (requires API key)

This should be gated behind an environment variable (`AGENT_COMMAND=claude`) and tested in isolation from the main test suite.

## CLI parity for base-content and file writes

`AGENTS.md` requires the CLI in `cli/` to stay at feature parity with the web client, but two endpoints have no command behind them. Both were noticed while fixing the `Base file not found` bug in `/api/git/base-content`, and neither is a one-line addition.

`GET /api/git/base-content` is the smaller gap. It returns `text/plain`, so `rift git base-content <path>` follows the shape of `files cat` in `cli/src/commands/files.ts` — call `api.getText()`, then write raw text in text mode and wrap it in `{ content }` for JSON. The only real decision is the `--staged` flag, which now selects the base revision: the index when absent, `HEAD` when present.

`PUT /api/files/content` is the awkward one, because the endpoint enforces optimistic concurrency. It rejects any request whose `expectedMtimeMs` does not match the file on disk, and `ApiClient` has no `put()` method to begin with. A `rift files write` command therefore needs:

- A `put()` on `ApiClient` in `cli/src/api.ts`, mirroring `post()`
- A way to obtain the current mtime. `GET /api/files/content` returns it in the `x-file-mtime-ms` header, but `getText()` discards headers, so either it grows a header-aware variant or the command takes the value as a flag
- A decision on the default. Read-then-write inside one command reintroduces the race the header exists to prevent, so the safer default is to require `--expect-mtime <ms>` and offer `--force` for the deliberate clobber
- A source for the content itself — a `<file>` argument, or stdin when the argument is `-`

Both commands need coverage in `cli/src/__tests__/commands.test.ts`.

## Session persistence across server restarts

The current plan stores session message buffers in memory only. If the server process restarts, all session history is lost. The description lists "Session persistence" as a design principle — sessions should survive closing the browser, and the current plan achieves this (sessions persist as long as the server runs). However, surviving server restarts requires persisting session state to disk.

This needs further planning because:
- The storage format must be chosen (SQLite, flat JSON files, or similar)
- The message buffer can grow large; a persistence strategy needs to address truncation or compaction
- The agent process itself does not survive a server restart; persistence would restore history but not the running agent. The UX for this "zombie session" state needs design
- Interaction with the `ClaudeCodeAdapter` needs thought — can Claude Code resume a conversation from stored context?
