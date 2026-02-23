# CLAUDE.md

## Project

Imp is a personal AI assistant that runs as a Rust binary in Docker, connecting to Telegram for chat and using the Anthropic Messages API for intelligence.

## Build & Test

```bash
cargo build        # Build
cargo test         # Run tests
cargo clippy       # Lint
cargo fmt --check  # Check formatting
```

## Git Conventions

- Default PR merge: `gh pr merge --squash --delete-branch && git fetch --prune`
- Ideal commit: small enough for a single subject line (no body needed)
- When a body is needed, use bullet points with `-`
- Always run `cargo fmt` before committing
- Never use `git -C <repo>` for the repo you're working in—it breaks permission checks
- When updating PRs to fix failing tests, prefer amending the commit to pushing additional commits. Check with the user if you feel you need to violate this guideline
- Never add PR numbers to commit subject lines (e.g., ending in "(#9)"). These will be added by the GitHub PR machinery; adding one manually will (a) likely be wrong and (b), result in doubled-up PR numbers