# Imp MVP Implementation Plan

## Context

Imp is a personal AI assistant that runs as a Rust binary in Docker, connecting to Telegram for chat and using the Anthropic Messages API for intelligence. The MVP delivers three capabilities: conversational chat, scheduled reminders/initiated conversations, and web content fetching from whitelisted domains. The design follows Nanoclaw's patterns (single orchestrator, SQLite persistence, polling scheduler) but drops multi-user isolation since Imp serves a single owner.

The LLM backend is abstracted behind a trait so it can later be swapped for the Claude Agent SDK in containers, a self-hosted model, or another provider.

## Architecture

```
Telegram (teloxide)
    ↕ mpsc channel
Orchestrator (main.rs)
    ├── Agent trait → AnthropicAgent (HTTP to Messages API)
    ├── ToolExecutor → schedule_task, list_tasks, cancel_task, web_fetch
    ├── Scheduler (tokio::spawn, 60s poll loop)
    └── Database (SQLite via rusqlite)
```

Messages flow: Telegram → inbound channel → load history from DB → call Agent with tools → execute any tool calls → store response → send back via Telegram.

Scheduler flow: poll DB for due tasks → build prompt → call Agent → send result via Telegram.

## Project Structure

```
imp/
├── Cargo.toml
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .gitignore
├── src/
│   ├── main.rs            # Entry point, wires subsystems together
│   ├── config.rs           # Env var loading, validation
│   ├── db.rs               # SQLite schema, CRUD operations
│   ├── error.rs            # Unified error types
│   ├── agent/
│   │   ├── mod.rs          # Agent + ToolExecutor traits
│   │   ├── types.rs        # Message, ContentBlock, ToolDefinition (mirror Anthropic API)
│   │   ├── anthropic.rs    # HTTP client, tool-use loop
│   │   └── tools.rs        # Tool definitions (JSON schemas) + ImpToolExecutor dispatch
│   ├── telegram.rs         # teloxide bot, owner filtering, message splitting
│   ├── scheduler.rs        # Polling loop, cron evaluation, task execution
│   └── web_fetch.rs        # URL fetching with domain whitelist, HTML→text
└── data/                   # Runtime (Docker volume)
    └── imp.db
```

## Key Dependencies

| Crate | Purpose |
|---|---|
| tokio (full) | Async runtime |
| teloxide | Telegram bot framework |
| reqwest (json, rustls-tls) | HTTP client for Anthropic API + web fetch |
| rusqlite (bundled) | SQLite with statically-linked C library |
| serde / serde_json | Serialization |
| cron | Cron expression parsing |
| chrono | Time handling |
| dotenvy | .env file loading |
| tracing / tracing-subscriber | Structured logging |
| html2text | HTML→plain text conversion |
| uuid (v4) | ID generation |
| thiserror / anyhow | Error handling |
| async-trait | async fn in dyn traits |

## Key Design Decisions

- **Direct Anthropic API, not Agent SDK**: Avoids container overhead. The Messages API supports tool use natively. The `Agent` trait allows swapping implementations later.
- **`std::sync::Mutex<Connection>` + `spawn_blocking`**: `rusqlite::Connection` is `!Send`, so DB operations run on the blocking thread pool. Single-user volume makes this adequate.
- **Message content stored as JSON**: Preserves full content blocks (text + tool_use + tool_result) needed to reconstruct conversations for the API.
- **Owner-only filtering**: Telegram messages from non-owner chat IDs are silently dropped.
- **Tool-use loop cap**: Max 10 iterations to prevent runaway loops.

## Database Schema

Three tables:

- **messages**: id, role, content (JSON), timestamp, token_estimate
- **scheduled_tasks**: id, prompt, schedule_type (cron/once), schedule_value, next_run, status (active/paused/completed), created_at
- **task_run_logs**: task_id, run_at, duration_ms, status, result, error

## Tools Exposed to the Agent

1. **schedule_task**(prompt, schedule_type, schedule_value) — create a recurring or one-time task
2. **list_tasks**() — list all scheduled tasks with status and next run time
3. **cancel_task**(task_id) — cancel a task by ID
4. **web_fetch**(url) — fetch and return content from a whitelisted URL as plain text

## Implementation Order

### ~~Step 1: Project skeleton and config~~ ✓

- `cargo init`, set up `Cargo.toml` with all dependencies
- Implement `config.rs` (env var loading) and `error.rs`
- Set up tracing in `main.rs`
- Create `.env.example`, `.gitignore`
- **Verify**: `cargo build` succeeds

### ~~Step 2: Database layer~~ ✓

- Implement `db.rs`: schema creation, message CRUD, task CRUD, context window loading
- **Verify**: unit tests against in-memory SQLite

### ~~Step 3: Agent core~~ ✓

- Implement `agent/types.rs` (Anthropic API request/response types)
- Implement `agent/mod.rs` (Agent + ToolExecutor traits)
- Implement `agent/anthropic.rs` (HTTP client, tool-use loop)
- Implement `agent/tools.rs` (tool JSON schemas, ImpToolExecutor stub)
- **Verify**: hardcoded prompt → Claude response round-trip

### Step 4: Telegram integration

- Implement `telegram.rs` (teloxide dispatcher, owner filter, message splitting)
- Wire Telegram → Agent → Telegram in `main.rs` (no tools yet)
- Remove `#[allow(dead_code)]` / `#![allow(dead_code)]` from `config.rs`, `error.rs`, `db.rs`, and `agent/mod.rs` now that `main.rs` uses them
- **Verify**: send Telegram message, get Claude response back

### Step 5: Tool execution

- Implement tool handlers in `agent/tools.rs` (schedule, list, cancel)
- Implement `web_fetch.rs` (domain whitelist, HTML→text, truncation)
- Wire tools into the agent loop
- **Verify**: "Fetch the front page of Hacker News" works end-to-end

### Step 6: Scheduler

- Implement `scheduler.rs` (polling loop, cron evaluation, task→agent→Telegram pipeline)
- Wire into `main.rs` alongside Telegram listener
- **Verify**: "remind me in 2 minutes to drink water" fires and delivers

### Step 7: Docker and polish

- Write `Dockerfile` (multi-stage: rust:slim builder → debian:bookworm-slim runtime)
- Write `docker-compose.yml` with volume for data/
- Add graceful shutdown (ctrl-c handler)
- **Verify**: full system runs in Docker, survives restart

## Verification

- Unit tests: DB operations, domain whitelist logic, message splitting, cron next-run computation
- Integration test: mock Anthropic API returning tool_use responses, verify loop executes tools correctly
- Manual smoke tests: end-to-end Telegram chat, scheduled reminder delivery, web fetch, unauthorized user rejection

## Reference Files

- `~/Src/External/Nanoclaw/src/task-scheduler.ts` — scheduler loop pattern
- `~/Src/External/Nanoclaw/src/db.ts` — schema and persistence patterns
- `~/Src/External/Nanoclaw/src/types.ts` — type abstractions
