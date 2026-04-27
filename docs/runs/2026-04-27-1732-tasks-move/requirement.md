# Requirement — R12 `freelo tasks move <id>`

`freelo tasks move <id>` — move a task between tasklists, optionally cross-project.
First write slice that targets a task already in flight.

- **Endpoint:** `POST /task/{task_id}/move/{tasklist_id}` (OpenAPI :1842-1891).
- **CLI surface:** `freelo tasks move <id> --to-tasklist <id> [--to-project <id>] [--dry-run]`
- **Depends on:** R10 (already shipped — `freelo tasks edit`).
- **Inherits:** envelope schema `freelo.tasks.move/v1`, structured errors, exit codes,
  `--dry-run`, batch via `--ids` / `--stdin` NDJSON if natural, idempotency stance —
  moving to the *current* tasklist should be a no-op success.

## Run parameters

- `allowNetwork`: false (MSW only)
- `autoShip`: false
- Budgets: defaults (30 min, 40 agent calls, 8 retries, 25 files)

## Hard rules (recap)

- Tier likely Yellow → leave PR open for human merge.
- Branch: `feat/tasks-move`.
- Run gates AFTER commit on clean tree:
  `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`.
- Every spec-assigned exit code MUST have a test row.
- Coverage: 80% lines, 90% on `src/api/` and `src/commands/`.
- Changeset: `minor` (new envelope schema).
- README autogen: `pnpm fix:readme` after build.
