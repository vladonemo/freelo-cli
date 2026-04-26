# API research — R06 `freelo tasklists show <id>`

**Run:** 2026-04-26-1946-r06-tasklists-show
**Source:** `docs/api/freelo-api.yaml` (single authoritative reference).

This memo answers four questions the orchestrator brief raised, citing OpenAPI line numbers.

## 1. `GET /tasklist/{id}` — response shape

OpenAPI :1264-1288 (operation `getTasklist`). Returns `TasklistDetail` directly (single object, NOT wrapped in a paginated envelope).

`TasklistDetail` schema at :5092-5126:

```yaml
TasklistDetail:
  allOf:
    - $ref: '#/components/schemas/TasklistBasic'   # id, name
    - type: object
      properties:
        project_id: { type: integer }              # ← TOP-LEVEL, ALWAYS PRESENT
        date_add: { type: string, format: date-time }
        date_edited_at: { type: string, format: date-time }
        tasks: # array of brief task objects
          - id, name, due_date, due_date_end, worker (UserBasic), parent_task_id
```

**Critical for R06:** `project_id` is a **top-level integer field** at `data.project_id`. The user gives us only a tasklist id; we read `project_id` from the first response and use it as the path parameter for the `/assignable-workers` call. **No separate `--project` flag is required.**

## 2. `TasklistDetail` vs. R05's `TasklistFull`

These are **different shapes** despite both being "tasklist". Comparison:

| Field          | TasklistFull (R05) | TasklistDetail (R06) |
| -------------- | ------------------ | -------------------- |
| `id`, `name`   | yes                | yes                  |
| `date_add`, `date_edited_at` | yes  | yes                  |
| `state`        | **yes**            | **no**               |
| `project` (object ref) | **yes**    | **no**               |
| `project_id` (int) | no             | **yes**              |
| `real_minutes_spent` | **yes**      | **no**               |
| `budget`, `real_cost` | **yes**     | **no**               |
| `tasks` (embedded)  | no            | **yes**              |

`TasklistDetail` is **leaner** on metrics (`budget`, `real_cost`, `real_minutes_spent`, `state` are all absent) and **richer** on the embedded `tasks` array.

**Decision implication:** R06 introduces a new `TasklistDetailSchema` rather than reusing `TasklistFullSchema`. With `.passthrough()` we still tolerate any field Freelo decides to bolt on later. R05.5 hardening already taught us to expect drift.

## 3. `GET /project/{pid}/tasklist/{tid}/assignable-workers` — response shape

OpenAPI :1235-1262 (operation `getAssignableWorkers`). Path requires **both** `project_id` and `tasklist_id`.

Response schema at :1259-1262:

```yaml
'200':
  content:
    application/json:
      schema:
        type: array
        items:
          $ref: '#/components/schemas/UserBasic'
```

**This is materially different from R04's `/project/{id}/workers`.** R04's workers endpoint returns the standard paginated wrapper (`{ total, count, page, per_page, data: { workers: [...] } }`). R06's `/assignable-workers` returns a **bare `UserBasic[]` array** — no pagination wrapper, no inner key, no page parameter.

**Decision implication:** R06 does NOT use `normalizePaginated` / `fetchAllPages` for the assignable-workers side-car. It's a single GET that returns the full list. The command code is simpler than R04's; the implementer should NOT copy R04's `fetchAllWorkers` helper.

`UserBasic` (:4880-4886) is `{ id: integer, fullname: string }` — same as R05.5 (`fullname` already loosened to `.nullable().optional()` after the hardening sweep).

## 4. Behavior when the resource doesn't exist or is forbidden

OpenAPI :1278 explicitly documents:

> Performs both a tasklist fetch (ACL-checked) and a project fetch (ACL-checked). If the caller has no access to either, returns 404.

Two implications:

1. **404 collapses both not-found and not-permitted.** Hint must mention both possibilities ("not found, or your account does not have access"). Same wording as R04's 404 hint.
2. **403 is theoretically possible** (e.g., for the `/assignable-workers` call when the caller lacks tasklist ACL but has project access). R04 already maps 403 to a permission-flavoured hint; we apply the same pattern.

5xx, 401, 429 — handled identically to R04 / R05 by the R01 HTTP client. No per-endpoint logic.

## 5. Other observations

- **No `?p=N` query parameter** on `/tasklist/{id}` (it's a single-resource GET).
- **No `?per_page=N` knob** on `/assignable-workers` — the endpoint returns the full list every time.
- **No filter knobs** on either endpoint (no `state`, no `worker_id`, etc.).
- **`UserBasic` deduplication** is the API's responsibility; we render it as-is.

## Summary for the architect

- One mandatory call: `GET /tasklist/{id}` → `TasklistDetail` (carries `project_id`).
- One optional call (under `--with assignable-workers`): `GET /project/{project_id}/tasklist/{id}/assignable-workers` → bare `UserBasic[]`.
- New entity schema: `TasklistDetailSchema` (NOT `TasklistFullSchema`).
- No pagination plumbing on the side-car.
- 404 / 403 hint rewriting per R04's pattern.
- No new dependencies.

## API-specialist verdict

R06 is structurally close to R04 but **simpler on the side-car path** and **needs a new schema for the detail entity**. Materially-different signal: side-car is a bare array, not paginated. This is captured explicitly in §3 of the spec so the implementer doesn't reach for `normalizePaginated`.
