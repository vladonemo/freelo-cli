# Requirement — R18 from roadmap

**Source:** `docs/roadmap.md` §R18
**Invoked via:** `/auto R18 from roadmap`
**Date:** 2026-04-28

## Slice

### R18 — `freelo comments edit` / `comments delete`

**Endpoints:** `PATCH /comment/{comment_id}`, `DELETE /comment/{comment_id}`.
**CLI:**

```
freelo comments edit <id> …
freelo comments delete <id> [--yes]
```

**Depends on:** R17 (just landed in 6cfcd3b), R13 (confirm helper from `tasks delete`).

## Notes for the orchestrator

- Two new write commands in one slice.
- `comments edit` is a partial update; reuse the editor/stdin/`--from-file` input pattern from R15 (`src/lib/input.ts`) — same options as `comments add` from R17.
- `comments delete` is destructive — use `src/lib/confirm.ts` shipped in R13. Non-TTY without `--yes` must fail with `CONFIRMATION_REQUIRED` (exit 2). Non-TTY-with-`--yes` proceeds.
- Both commands inherit the agent-safe write contract: `--dry-run`, batch (`--id` repeatable / `--ids` / `--stdin` NDJSON), idempotency (delete of an already-deleted comment → `already_in_target_state: true`).
- Output schemas: `freelo.comments.edit/v1`, `freelo.comments.delete/v1`.
- Changeset: `freelo-cli: minor` (additive surface).

## Constraints

- `--ship`: NOT set. Stop at PR.
- `--allow-network`: NOT set. MSW only for tests.
- Budget: defaults (30 min wall, 40 calls, 8 retries, 25 files).
