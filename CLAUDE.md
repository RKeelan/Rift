# CLAUDE.md

## CLI Feature Parity

The CLI (`cli/`) must maintain feature parity with the web client. Every API endpoint exposed to the web client must have a corresponding CLI subcommand.

## Validation

When validating endpoints against the live system, use the CLI (`bun run --cwd cli src/index.ts`) rather than ad-hoc curl commands or scripts.

## Git Conventions

- Default PR merge: `gh pr merge --squash --delete-branch && git fetch --prune`
- Ideal commit: small enough for a single subject line (no body needed)
- When a body is needed, use bullet points with `-`
- Always run `bun run lint` and `bun run format:check` before committing
- Never use `git -C <repo>` for the repo you're working in—it breaks permission checks
- When updating PRs to fix failing tests, prefer amending the commit to pushing additional commits. Check with the user if you feel you need to violate this guideline
- Never add PR numbers to commit subject lines (e.g., ending in "(#9)"). These will be added by the GitHub PR machinery; adding one manually will (a) likely be wrong and (b), result in doubled-up PR numbers