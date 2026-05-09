# R38 — Task multi-project membership + task relations

**Roadmap:** Wave 6 (Advanced task surface).
**Date:** 2026-05-09.
**Run-id:** `2026-05-09-1200-r38-tasks-multiproject-relations`.

## Endpoints

- `POST /task/{id}/projects` — assign task to additional project (multi-project promotion).
- `DELETE /task/{id}/projects/{project_id}` — remove task from a secondary project.
- `GET /task/{id}/relations` — get a single task's relations.
- `POST /tasks/relations` — bulk find relations across many tasks.

## Roadmap CLI sketch

```
freelo tasks project add <id> --project <id>...
freelo tasks project remove <id> --project <id> [--yes]
freelo tasks relations <id>
freelo tasks find-relations --task <id>...
```

## Constraints

- `allowNetwork: false` — MSW only.
- `autoShip: false` — do NOT pass `--ship`.
- File budget — stop at 25 files; pause if pressed beyond.
- Follow R35/R36/R37 patterns (specs 0049–0051).

## Notes from parent

- `POST /task/{id}/projects` accepts `tasklist_id`, NOT `project_id` per OpenAPI :1893-1941. Roadmap text is misleading.
- `DELETE /task/{id}/projects/{project_id}` returns 403 AclException on primary-project removal attempts.
- `POST /tasks/relations` is a *find/query* endpoint, not a *create* endpoint (yaml :1614-1658 — it returns relations grouped by task id; it does not create relations). The CLI command name `find-relations` aligns with this. Confirmed.
- Subcommand layout: `tasks project add` / `tasks project remove` (parent + leaves), `tasks relations <id>` and `tasks find-relations --task <id>...` (top-level siblings, no parent).
