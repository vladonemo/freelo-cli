# R23 — `freelo labels` (project labels)

**Source:** `docs/roadmap.md` Wave 4.

**Endpoints:**
- `GET /project-labels/find-available`
- `PATCH /project-labels/{labelId}`
- `DELETE /project-labels/{labelId}`
- `POST /project-labels/add-to-project/{projectId}`
- `DELETE /project-labels/remove-from-project/{projectId}`

**CLI:**

```
freelo labels list [--project <id>]
freelo labels rename <id> --name <str> [--color <hex>]
freelo labels delete <id> [--yes]
freelo labels attach --project <id> --name <str>... [--color <hex>]    # fetch-or-create
freelo labels detach --project <id> --label <id>...
```

**Depends on:** R04, R13.

## Run parameters

- Run ID: 2026-04-29-1300-r23-labels
- Branch: feat/labels (from main @ e8abf40)
- Budgets: defaults (30 min · 40 calls · 8 retries · 25 files)
- allowNetwork: false (MSW only)
- autoShip: false
