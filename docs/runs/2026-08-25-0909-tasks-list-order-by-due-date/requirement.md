# Requirement — M08: widen `freelo tasks list --order-by` to accept `due_date`

**Run:** 2026-08-25-0909-tasks-list-order-by-due-date
**Source:** `docs/roadmap-migration-2026-08.md` slice M08 (merged to main in PR #112)
**Extends:** R07 (`tasks list`, shipped) · follows #108 sort-order fix (`freelo-cli@0.20.2`, shipped)

## Original input

M08 — widen `freelo tasks list`'s `--order-by` to accept `due_date`.

**What changed upstream:** the tasklist-scoped route
(`GET /project/{project_id}/tasklist/{tasklist_id}/tasks`) — the same one #108 touched — has its
`order_by` query param enum in `docs/api/freelo-api.yaml` now listing
`[priority, name, date_add, date_edited_at, due_date]` (previously four values, no `due_date`).
Upstream's own description on that param: "tasks without a due date are always last; all-day tasks
sort at the start of their day (00:00)."

**Scope, mechanical:**

1. Check `docs/api/freelo-api.yaml` directly to see whether `/all-tasks`'s separate `order_by` enum
   *also* gained `due_date` in this same refresh, or only the tasklist-scoped route did — don't
   assume, verify. If both routes gained it, widen both; if only the tasklist route did, widen only
   that one and say so explicitly in the PR body (don't silently under- or over-scope).
2. Widen the CLI's `--order-by` enum in `src/commands/tasks/list.ts` (Commander flag validation) and
   the corresponding zod/type unions in `src/api/tasks.ts` and `src/api/schemas/task.ts` to accept
   `due_date` wherever the spec now documents it.
3. Update `docs/commands/tasks-list.md`'s `## Ordering` section (added by the #108 fix) to mention
   the new value and its null-last/all-day tie-break behavior.
4. This is additive (new enum value on an existing flag, no envelope schema change, no breaking
   change) — should tier Green per the roadmap slice's own read, but confirm at triage rather than
   assuming.

## Run parameters

- `allowNetwork: false` (default — no live check needed, the enum value is already documented in the
  refreshed spec)
- `autoShip: false` (default)
- Budgets: 30 min wall clock, 40 agent calls, 8 retries, 25 files (standard)

## Pre-flight (orchestrator, per calibration #6)

- `git rev-parse --abbrev-ref HEAD` → `main`
- working tree clean
- `HEAD == origin/main == 01a26a9` (`docs(api): refresh cached OpenAPI spec, add migration roadmap
  for new endpoints (#112)`)

Branch will be cut from this verified `main`.

## Orchestrator scope pre-verification (step 1 of the requirement)

Direct read of `docs/api/freelo-api.yaml`:

| Path | Line | `order_by` enum | default |
|---|---|---|---|
| `/project/{project_id}/tasklist/{tasklist_id}/tasks` | 1522 | `[priority, name, date_add, date_edited_at, due_date]` | `priority` |
| `/all-tasks` | 1639 | `[priority, name, date_add, date_edited_at, due_date]` | `date_add` |

**Both routes gained `due_date`.** `/all-tasks` also carries the same upstream description text:
"When `due_date`, tasks without a due date are always last; all-day tasks sort at the start of their
day (00:00). Results are tie-broken by task id for stable pagination."

Therefore the widening applies to **both** code paths, not just the tasklist-scoped one. This must
be stated in the PR body.
