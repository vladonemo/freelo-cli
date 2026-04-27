# Requirement

Original input: "R13 from roadmap"

Resolved from `docs/roadmap.md` lines 291–301 — `freelo tasks delete <id>`.

## Key facts

- **Endpoint:** `DELETE /task/{task_id}`
- **CLI surface:** `freelo tasks delete <id>... [--yes] [--dry-run]` plus `--ids` and `--stdin` (NDJSON) batch input
- **First destructive op** — introduces `src/lib/confirm.ts` shared confirmation helper, reused by every later destructive command
- **Confirm policy:**
  - `--yes` bypasses
  - TTY without `--yes` → prompt via lazy-imported `@inquirer/prompts`
  - **Non-TTY without `--yes` → throw `ConfirmationError` (exit 2, `code: CONFIRMATION_REQUIRED`)** — never hangs
- **Idempotent "already deleted" handling** via existing `src/lib/idempotency.ts` (R11). Treat 404-after-delete or repeated DELETE as success with `already_in_target_state: true`
- **Output schema:** `freelo.tasks.delete/v1`
- **Depends on:** R09 (write infra), R11 (idempotency)

## Run parameters

- Run ID: `2026-04-27-1947-tasks-delete`
- Branch: `feat/tasks-delete`
- Budget: defaults (30 min · 40 calls · 8 retries · 25 files)
- `allowNetwork`: false (MSW only)
- `autoShip`: false
