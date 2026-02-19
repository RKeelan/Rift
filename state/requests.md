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

## Session persistence across server restarts

The current plan stores session message buffers in memory only. If the server process restarts, all session history is lost. The description lists "Session persistence" as a design principle — sessions should survive closing the browser, and the current plan achieves this (sessions persist as long as the server runs). However, surviving server restarts requires persisting session state to disk.

This needs further planning because:
- The storage format must be chosen (SQLite, flat JSON files, or similar)
- The message buffer can grow large; a persistence strategy needs to address truncation or compaction
- The agent process itself does not survive a server restart; persistence would restore history but not the running agent. The UX for this "zombie session" state needs design
- Interaction with the `ClaudeCodeAdapter` needs thought — can Claude Code resume a conversation from stored context?
