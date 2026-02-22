# CLAUDE.md

## CLI Feature Parity

The CLI (`cli/`) must maintain feature parity with the web client. Every API endpoint exposed to the web client must have a corresponding CLI subcommand.

## Git Conventions

- Default PR merge: `gh pr merge --squash --delete-branch && git fetch --prune`
- Ideal commit: small enough for a single subject line (no body needed)
- When a body is needed, use bullet points with `-`
- Always run `cargo fmt` before committing
- Never use `git -C <repo>` for the repo you're working in—it breaks permission checks
- When updating PRs to fix failing tests, prefer amending the commit to pushing additional commits. Check with the user if you feel you need to violate this guideline