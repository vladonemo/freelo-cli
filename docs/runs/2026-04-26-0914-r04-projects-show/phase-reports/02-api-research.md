# Phase 2a — Freelo API research (api-specialist role)

**Run:** 2026-04-26-0914-r04-projects-show
**Source of truth:** `docs/api/freelo-api.yaml` (offline; no real API calls).

## Endpoints in scope

### 1. `GET /project/{project_id}` — `getProject`

- OpenAPI lines: **530–556** (operation), schema **4969–5024** (`ProjectDetail`).
- Path parameter: `project_id: integer` (`ProjectIdParam` at :4774-4779). **Integer required.**
- No query parameters. **Not paginated.**
- 200 response: `ProjectDetail` (the rich variant).
- `ProjectDetail` extends `ProjectFull` (already wired in R03) and adds:
  - **Embedded `tasklists`** (per :4974-5004): an array where each entry is `{ id, name, tasks[] }` and each task carries `{ id, name, due_date?, due_date_end?, worker, parent_task_id? }`.
  - **Embedded `workers`** (per :5005-5023): an array where each entry is `{ id, fullname, hour_rate? }`. `hour_rate` is `{ amount: integer, currency: string, is_fixed: boolean } | null`.
- Description (:543-546) explicitly states tasklists are ACL-filtered for the caller, and budget/spent numbers are caller-specific.
- Auth: standard Basic auth (no extra scope). 4xx/5xx mapped to `FreeloApiError` by R01's HTTP client.

### 2. `GET /project/{project_id}/workers` — `getProjectWorkers`

- OpenAPI lines: **583–619**.
- Path parameter: `project_id: integer`. Query parameter: `?p=<int>` (`PageParam` at :4766-4772, 0-indexed default 0).
- 200 response: `allOf [PaginatedResponse, { data: { workers: UserBasic[] } }]` — the standard paginated wrapper used in R03 (`{ total, count, page, per_page, data: { workers: [...] } }`), inner key **`workers`**.
- `UserBasic` (at :4880-4886): `{ id: integer, fullname: string }`.
- Description (:589-598): **paginated**, includes workers + owner + guests, deleted (former) workers excluded, **NOT** filtered by ACL-tasklist membership.

### 3. Labels — **no per-project labels endpoint exists**

The roadmap mentions `--with labels`, but exhaustive search of the OpenAPI spec confirms there is **no** `GET /project/{id}/labels`, no `?project_id=` filter on any labels endpoint, and **no `labels` array embedded in `ProjectDetail`**.

What exists in the labels space:

| Endpoint | Lines | Returns |
|---|---|---|
| `GET /project-labels/find-available` | 833-859 | All labels the caller can assign **anywhere** — own private labels + public labels from any project the caller participates in. **Workspace-scoped, not project-scoped.** |
| `POST /project-labels/{labelId}` | 861-904 | Edit a global label (write only) |
| `DELETE /project-labels/{labelId}` | 905-932 | Delete a global label (write only) |
| `POST /project-labels/add-to-project/{projectId}` | 934-988 | Attach label to project (write only) |
| `POST /project-labels/remove-from-project/{projectId}` | 990-1036 | Detach label from project (write only) |

`ProjectDetail` embeds **`tasklists`** (with tasks) and **`workers`** (with hour_rate). It does **not** embed `labels`.

The closest reads are:
- `/project-labels/find-available` — workspace-scope, not project-scope.
- The POST `/project-labels/add-to-project/{projectId}` body description (:951-952) hints that the server *knows* which labels are on a project (it swallows duplicates), but no GET surface exposes that list.

## Permissions / 404 behavior

Not documented inline for `GET /project/{id}` (no explicit 404/403 response in the OpenAPI). The R01 `FreeloApiError` taxonomy maps:
- `401` → `AUTH_EXPIRED` (exit 3)
- `403` → `FREELO_API_ERROR` with status 403 (exit 4)
- `404` → `FREELO_API_ERROR` with status 404 (exit 4)
- `429` → `RATE_LIMITED` (exit 6, retried per R01's policy)
- `5xx` → `FREELO_API_ERROR` (exit 4)

No special per-endpoint behavior surfaces from the spec. The `ErrorResponse` body is `{ errors: string[] }` (at :4803-4812).

## Rate limits

Identical to all other endpoints — the HTTP client's existing `RateLimit-Remaining` / `RateLimit-Reset` header parsing (R01) applies unchanged.

## Summary for the architect

1. **`/project/{id}` is `ProjectDetail`** — extends `ProjectFull` (already in R03) with embedded `tasklists` (with embedded tasks!) and `workers` (with `hour_rate`). New schema needed; can be additive on top of `ProjectFullSchema`.
2. **`/project/{id}/workers`** is paginated `{ workers: UserBasic[] }` under the standard `PaginatedResponse` wrapper. R03's `normalizePaginated()` works as-is with `innerKey: 'workers'` and `itemSchema: UserBasicSchema`.
3. **Labels — there is no read API.** The roadmap's `--with labels` cannot be implemented from the documented surface. Three options for the orchestrator:
   - **Option A — drop `--with labels` from R04.** Ship `freelo projects show <id> [--with workers]` only. Update roadmap and re-scope. Simplest, fastest, cleanest.
   - **Option B — `--with labels` calls `/project-labels/find-available`** and exposes the **workspace-scoped** label set. Mismatched semantics: an agent expects "labels on this project", gets "labels I can use anywhere". Confusing; inconsistent with the spec verb "show one project's labels".
   - **Option C — defer R04 until labels read API exists.** Wait for Freelo to add a per-project labels endpoint. Indefinite pause.
4. `ProjectDetail` embeds workers + tasklists already. `--with workers` could either (a) call the **paginated** `/project/{id}/workers` for the full list, or (b) just project the embedded `workers` already in `ProjectDetail`. Roadmap says the endpoint is `/project/{id}/workers` so (a) is the intent. The architect must decide whether to expose **both** (embedded summary + full paginated detail).

## Recommendation to the architect

Drop `--with labels` from R04 and ship `freelo projects show <id> [--with workers]`. Add a non-goal entry capturing the gap and a follow-up roadmap note (R04.5 "labels read API blocked on Freelo").
