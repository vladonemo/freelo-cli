# R14 — `freelo subtasks` (smart list)

**Run:** 2026-04-27-2300-subtasks-list-add
**Source:** docs/roadmap.md (R14)
**Date:** 2026-04-27

## Verbatim requirement

> ### R14 — `freelo subtasks` (smart list)
>
> **Outcome:** Inspect and add subtasks (taskchecks).
> **Endpoints:** `GET /task/{task_id}/subtasks`, `POST /task/{task_id}/subtasks`.
> **CLI:**
>
> ```
> freelo subtasks list --task <id>
> freelo subtasks add --task <id> --name <str> [--worker <id>] [--due YYYY-MM-DD]
> ```
>
> **Notes:** The POST endpoint auto-falls-back from smart subtask to simple taskcheck when the tasklist can't host smart ones — surface this in help text.
> **Depends on:** R08.

## Run parameters

- run-id: 2026-04-27-2300-subtasks-list-add
- branch: feat/subtasks-list-add (TBD by plan; may split)
- budgets: 30 min wall clock, 40 agent calls, 8 retries, 25 files
- allowNetwork: false (MSW only)
- autoShip: false

## Notable constraints (from invocation)

- Both verbs ride the same endpoint pair.
- Smart-vs-simple fallback in help text is mandated.
- New envelope schemas: `freelo.subtasks.list/v1`, `freelo.subtasks.add/v1`.
- Surface storage form (`smart_subtask` vs `taskcheck`) in the add response.
- Writes are agent-safe: `--dry-run`, batch input matching `tasks move --stdin` precedent, idempotency where sensible. Additive, not destructive.
- Likely Yellow tier: stop at PR-open.
