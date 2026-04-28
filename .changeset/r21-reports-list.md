---
'freelo-cli': minor
---

R21 — `freelo reports list`. First read surface for the **work-reports** (time-entries) resource group: paginated list of every finalized work report the caller can see, with filters by task / project / worker and a `date_reported` window.

```
freelo reports list [--task <id> ...] [--project <id> ...] [--worker <id> ...]
                    [--from YYYY-MM-DD] [--to YYYY-MM-DD]
                    [--page N | --all]
```

Wraps `GET /work-reports` (OpenAPI `getWorkReports`, yaml :2947-3043).

**New envelope schema (additive surface):** `freelo.reports.list/v1` — `data: { applied_filters, reports: WorkReportFull[] }`. `applied_filters` echoes only keys the user explicitly set (mirrors `comments list` precedent).

**Filter mapping (1-1 wire equivalents):**

- `--task <id>` (repeatable) → `tasks_ids[]`
- `--project <id>` (repeatable) → `projects_ids[]`
- `--worker <id>` (repeatable) → `users_ids[]`
- `--from <YYYY-MM-DD>` → `date_reported_range[date_from]` (inclusive)
- `--to <YYYY-MM-DD>` → `date_reported_range[date_to]` (inclusive)
- `--page N` (1-indexed) → wire `p=N-1`. Mutex with `--all`.
- `--all` → iterate `?p=0,1,…` until exhausted. Mutex with `--page`.

**One OpenAPI-vs-roadmap discrepancy resolved.** (See spec 0033 §2 and decision 1.)

The R21 roadmap line names `GET /task/{task_id}/work-reports` as a second endpoint, but `docs/api/freelo-api.yaml` documents only `POST` at that path (used by R22 to create work reports). Per the orchestrator hard rule "API behavior not in `docs/api/freelo-api.yaml` → don't guess the API" — and matching the R16 (`comments list`) precedent — R21 ships against the global `GET /work-reports` only, with `--task` mapped to the documented `tasks_ids[]` filter. A potential R21.5 (task-scoped GET) is queued if/when the OpenAPI surfaces such an endpoint.

**Out of scope for this slice (deferred to follow-ups):**

- `--label <uuid>` (`tasks_labels[]` server-side filter).
- `--currency` (server defaults to CZK).
- `--with-own-taskless` (load-bearing implicit caller scope).
- `--fields` projection.
- Task-scoped GET endpoint (decision 1 above).
- Logging / editing / deleting work reports — R22.

No new dependencies.
