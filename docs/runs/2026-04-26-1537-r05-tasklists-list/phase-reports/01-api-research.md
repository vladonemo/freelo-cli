# API research — R05 tasklists list

**Run:** 2026-04-26-1537-r05-tasklists-list
**Agent:** freelo-api-specialist (orchestrator-impersonated)
**Source:** `docs/api/freelo-api.yaml`

---

## Headline finding (load-bearing)

**`GET /project/{project_id}/tasklists` does NOT exist in the OpenAPI spec.**

The path `/project/{project_id}/tasklists` is documented at `freelo-api.yaml:1140-1178` but only carries a `post:` operation (`createTasklist`). There is no `get:` operation. The roadmap entry for R05 (`docs/roadmap.md:139-143`) names this endpoint, but the spec doesn't back it.

This is the central dispatcher decision input for the architect.

---

## 1. `GET /project/{project_id}/tasklists` — NOT DOCUMENTED

- `freelo-api.yaml:1140` — path declaration.
- `freelo-api.yaml:1141-1178` — only `post:` (createTasklist).
- No `get:` block.
- No analogous "list tasklists scoped to a project" endpoint elsewhere — searched exhaustively (grep `tasklists`, all `^  /` paths from :97 through :4660).

**Workaround options:**

| Option | Path | Risk |
|---|---|---|
| W1. Use `/all-tasklists?projects_ids[]=<id>` | Documented (:1180-1233). Filters server-side by project. | None — fully documented. |
| W2. Use `/project/{id}` and read embedded `data.tasklists[*]` | Documented (:5092-5126 `TasklistDetail`; embedded in ProjectDetail). | Loses tasklist metadata Freelo only exposes via /all-tasklists (date_add, state, project, real_minutes_spent, budget). |
| W3. Pause and ask human to confirm endpoint exists despite OpenAPI gap | — | Burns budget + agent rate-limit. Roadmap names it, so a real endpoint may exist undocumented. |

**Recommendation to architect:** W1. Single endpoint backs both modes. The user-facing CLI flag (`--project <id>`) just toggles whether `projects_ids[]=<id>` is appended. This collapses the dispatcher decision (Option B vs common subset) — only one entity shape ships, no discriminator needed.

---

## 2. `GET /all-tasklists` — fully documented (:1180-1233)

**Wire shape:**

```yaml
:1180  /all-tasklists:
:1181    get:
:1196      operationId: getAllTasklists
:1197      parameters:
:1198        - name: projects_ids[]
:1200          schema: { type: array, items: { type: integer } }
:1204        - name: order_by
:1207          schema: { enum: [name, date_add, date_edited_at], default: date_add }
:1210        - name: order
:1213          schema: { enum: [asc, desc], default: asc }
:1216        - $ref: PageParam        # ?p=<int>, 0-indexed (:4766-4772)
:1217      responses:
:1218        '200':
:1222            schema:
:1223              allOf:
:1224                - PaginatedResponse                   (:4814-4824)
:1225                - properties:
:1226                    data:
:1227                      properties:
:1228                        tasklists:                    # inner key = 'tasklists'
:1230                          items: TasklistFull         (:5065-5090)
```

**Pagination shape: same as R03's paginated wrappers** — `{ total, count, page, per_page, data: { tasklists: [...] } }`. Inner key: `tasklists`. **R03's `normalizePaginated` reuses verbatim.**

**Default order:** `date_add asc` (server-side; :1195 says so explicitly in the description).

**Filter:** `projects_ids[]=<int>` (repeating query param for multiple). For R05's single `--project <id>`, send a single `projects_ids[]=<id>`.

**ACL behavior** (:1193-1194): "ACL is applied — tasklists the caller can't see are filtered out, even if `projects_ids[]` includes their project." So a `--project <id>` for a project the caller can't see returns a 200 with empty `tasklists`, not 404. There's no documented 403/404 from `/all-tasklists`.

---

## 3. `TasklistFull` entity (:5065-5090)

```yaml
TasklistFull:
  allOf:
    - TasklistBasic                       (:4910-4916: { id, name })
    - properties:
        date_add:           date-time
        date_edited_at:     date-time
        state:              State          ({ id, state })
        project:
          allOf:
            - ProjectBasic                 ({ id, name })
            - properties:
                state: State
        real_minutes_spent: integer
        budget:             Currency       ({ amount: string, currency: enum })
        real_cost:          Currency
```

**Required fields:** Only `id` + `name` (from `TasklistBasic`). All `TasklistFull` extension fields are optional per OpenAPI semantics (no `required:` block).

**Notably:** the entity carries `project: { id, name, state }` — so when the caller is iterating `--project` results and wants to confirm scope round-trip, they read `tasklist.project.id`. Useful for the cross-project (`--all`) mode too — every result already names its parent project.

**Shape consistency:** `/all-tasklists` always returns `TasklistFull`. The roadmap-mentioned-but-nonexistent `/project/{id}/tasklists` would presumably have returned a different entity (perhaps `TasklistWithBudget` per the POST response shape at :1178, though that's purely speculation). With the W1 workaround, **only one entity ships** — `TasklistFull`. No discriminator needed.

---

## 4. Differences vs R03's `/projects` family

| Aspect | R03 (projects list) | R05 (tasklists list) — under W1 |
|---|---|---|
| Endpoints | 5 distinct (1 bare-array + 4 paginated) | **1** (`/all-tasklists`) |
| Entity shapes | 2 (`ProjectWithTasklists` vs `ProjectFull`) | **1** (`TasklistFull`) |
| Discriminator | `entity_shape: with_tasklists \| full` | **None needed** |
| Synthesized paging | Yes (for `/projects` bare array) | No — every call paginates |
| Inner data key | 4 different (`projects`, `invited_projects`, `archived_projects`, `template_projects`) | 1 (`tasklists`) |
| Filter by project | n/a | `projects_ids[]=<id>` query param |
| Ordering | Server default | Server default (`date_add asc`); `order_by` param available but deferred to R05.5 |

**Implication for architect:** R05's envelope shape is materially simpler than R03's. The `data` object only needs `{ scope: 'project' | 'all', tasklists: [...] }` — no `entity_shape` discriminator. R03's pagination, `--page`/`--all`/`--cursor`, and `--fields` infrastructure all reuse without modification.

---

## 5. Rate-limit headers

Same R01 contract — `X-RateLimit-Remaining` / `X-RateLimit-Reset` on every response. Already wired through `HttpClient`. No special headers documented for `/all-tasklists`.

---

## 6. 404/403 quirks

- `/all-tasklists` itself doesn't 404 — it's a global endpoint.
- For `--project <id>` on a project that **doesn't exist**: the OpenAPI spec doesn't document a 404. Empirically, ACL filtering applies (per :1193-1194), so the most probable behavior is **200 with empty `tasklists: []`**. **This is unconfirmed without a real-API call.** Architect should flag this as an Open Question with a recommendation: assume 200-empty, document the assumption, accept that 404 is possible and falls through to the existing `FreeloApiError` exit-4 path.
- For `--project <id>` on a project the caller **can't see**: ACL filter → 200 empty. Same path.
- 401: same as everywhere.

---

## 7. Out-of-scope filters that exist on `/all-tasklists` but R05 won't expose

- `order_by` (enum: `name | date_add | date_edited_at`, default `date_add`)
- `order` (enum: `asc | desc`, default `asc`)
- multi-`projects_ids[]` (R05 ships single-project only via `--project <id>`)

Mirror R03's deferral: keep the slice focused, add filter flags in R05.5 with envelope additive.

---

## Summary for architect

```
ENDPOINTS:
  - GET /all-tasklists                          (:1180-1233)  — backs BOTH modes
  - GET /project/{project_id}/tasklists         (NOT IN SPEC) — use W1 workaround

ENTITY:
  - TasklistFull only                           (:5065-5090)

PAGINATION:
  - PaginatedResponse                           (:4814-4824)
  - inner key: 'tasklists'
  - same shape as R03 paginated endpoints       — reuse normalizePaginated

DISPATCHER:
  - --project <id>  → /all-tasklists?projects_ids[]=<id>&p=<n>
  - (no flag)       → /all-tasklists?p=<n>
  - one entity, no discriminator

OPEN QUESTIONS FOR ARCHITECT:
  1. Endpoint deviation from roadmap: confirm W1 (use /all-tasklists for both).
  2. Behavior when --project <id> names a non-existent project: 200-empty assumed.
  3. order_by/order flags deferred to R05.5? (spec §6 non-goal).
```
