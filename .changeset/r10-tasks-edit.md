---
'freelo-cli': minor
---

R10 — `freelo tasks edit <id>`: partial update of a task's name, due date,
worker, priority, plus name-mode label add/remove diff.

The second write slice. Reuses R09's shared infra (`src/lib/dry-run.ts`,
write-flow conventions) verbatim — no new shared helpers introduced.

New files:

- `src/commands/tasks/edit.ts` — Commander leaf, validation,
  fan-out orchestration (remove → add → edit → refresh).
- `src/api/tasks-edit.ts` — `buildEditTaskBody` (pure body-builder),
  `editTask`, `addTaskLabels`, `removeTaskLabels` (label diff endpoints
  short-circuit when names is empty).
- `src/ui/human/tasks-edit.ts` — single-task human renderer.
- `docs/specs/0020-tasks-edit.md` — design + plan + 15 decision summaries.
- `docs/commands/tasks-edit.md` — user docs.

New envelope schema **`freelo.tasks.edit/v1`** (public contract — additive):

```json
{
  "schema": "freelo.tasks.edit/v1",
  "data": {
    "task": { /* TaskDetail | null */ },
    "tasklist_id": 314,
    "project_id": 42,
    "applied_changes": {
      "edit": { "name": "...", "priority_enum": "h" },
      "labels_added": ["urgent"],
      "labels_removed": ["wontfix"]
    },
    "would": [ /* present in --dry-run; up to 3 entries */ ]
  },
  "rate_limit": { ... },
  "request_id": "...",
  "dry_run": true
}
```

CLI surface:

```
freelo tasks edit <id>
                  [--name <str>] [--worker <id>]...
                  [--due YYYY-MM-DD]
                  [--priority low|normal|high | --clear-priority]
                  [--add-label <name>]... [--remove-label <name>]...
                  [--dry-run]
```

Notes:

- Edit verb is **POST `/task/{id}`** per OpenAPI :1690-1714 (the spec's
  documented partial-update verb).
- Label changes go through the explicit `/task-labels/add-to-task/{id}`
  and `/remove-from-task/{id}` endpoints, NOT the edit-body `labels[]`
  field. This keeps `applied_changes.labels_added` / `labels_removed`
  honest and the surface symmetrical with R09.
- Wire order: remove-labels → add-labels → edit-body → refresh GET. Fan-out
  is **not transactional**; on partial failure the CLI surfaces the error
  verbatim and `applied_changes` reflects only what the wire confirmed.
- If every write succeeds but the post-edit refresh GET fails, the
  envelope is success (exit 0) with `data.task: null` and a `notice`
  explaining the freshness gap.
- `--description` / `--description-file` deferred to R15
  (`tasks description set`); `<id>...` and `--stdin` deferred until a
  real batch use case appears.

See `docs/specs/0020-tasks-edit.md` for the full design.
