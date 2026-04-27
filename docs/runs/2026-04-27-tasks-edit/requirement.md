# R10 — `freelo tasks edit <id>`

Source: `docs/roadmap.md` §R10 (verbatim).

> **Outcome:** Partial update of a task (name, due date, workers, priority, labels).
> **Endpoints:** `PATCH /task/{task_id}` (or the spec's edit verb), `POST /task-labels/add-to-task/{task_id}` and `/remove-from-task/{task_id}` for label diff.
> **CLI:** same flags as `tasks create` where overlapping, plus `--add-label`, `--remove-label`.
> **Depends on:** R09.

## Run config

- run-id: `2026-04-27-tasks-edit`
- branch: `feat/tasks-edit` (off `main` @ `89c6af3`)
- budget: defaults (30m / 40 calls / 8 retries / 25 files)
- allowNetwork: false (MSW only)
- autoShip: false
