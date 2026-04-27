# 0017 — `freelo tasks list` (R07)

**Status:** Accepted by orchestrator (autonomous run); ready for /plan
**Run:** 2026-04-27-0602-r07-tasks-list
**Owner:** orchestrator (architect role)
**Tier:** **Yellow** — additive: new public command, new envelope schema, new entity schema, new shared lib `src/lib/query.ts`. Reuses R03 pagination + projection + table renderer wholesale. No auth / config / HTTP / release-tooling impact. No new runtime dependencies.

---

## 1. Problem

After R03–R06 the CLI can list and show projects and tasklists. The most-used resource — **tasks** — is still missing. Operators (and agents) need a single workhorse read that:

1. Filters tasks across all accessible projects (cross-project dashboards).
2. Drills into a single tasklist (board view).
3. Lists finished tasks in a tasklist (archive view).

R07 fills that hole with **one new command**, one new envelope schema, and one new shared utility (`src/lib/query.ts`) that array params for any future write/list command can reuse. Every other primitive (pagination, projection, `--page`/`--all`/`--cursor`, lazy `cli-table3`, `fetchAllPages`, `PartialPagesError` mid-stream protocol, `ValidationError` exit-2 parser pattern) is already in place from R03–R06.

R07's user-visible deliverable: `freelo tasks list` returns task records from any of three Freelo endpoints — selected by the flag combination (see §2.2) — with a stable `freelo.tasks.list/v1` envelope agents can pin against.

## 2. Proposal

### 2.1 Subcommand signature

```
freelo tasks list [--project <id>]... [--tasklist <id>]... [--worker <id>]
                  [--state <id>] [--label <name>]... [--without-label <name>]
                  [--due-from YYYY-MM-DD] [--due-to YYYY-MM-DD] [--no-due]
                  [--finished-overdue] [--finished-from YYYY-MM-DD] [--finished-to YYYY-MM-DD]
                  [--search <text>]
                  [--order-by priority|name|date_add|date_edited_at] [--order asc|desc]
                  [--page N | --all | --cursor <n>]
                  [--fields a,b,c]
```

Hangs off a new `freelo tasks` parent (`src/commands/tasks.ts`), mirroring the `tasklists` parent. Inherits the same global flags: `--output`, `--color`, `--profile`, `-v/-vv`, `--request-id`, `-y/--yes` (unused — read-only command, no destructive op).

| Flag | Type / values | Default | Purpose |
|---|---|---|---|
| `--project <id>` | int >= 1, **repeatable** (Commander variadic via `.option(..., (raw, prev) => ...)`) | unset | Filter to tasks in these projects. Multiple `--project` flags accumulate into an array. |
| `--tasklist <id>` | int >= 1, **repeatable** | unset | Filter to tasks in these tasklists. Multiple flags accumulate. See §2.2 for the route-selection rules when this is used with `--project`. |
| `--worker <id>` | int >= 1 | unset | Filter by assignee. Mapped to `?worker_id=`. (`/all-tasks` only — see §2.2.) |
| `--state <id>` | int >= 1 | unset | Filter by task state id. Mapped to `?state_id=`. (`/all-tasks` only.) |
| `--label <name>` | string, **repeatable** | unset | Include tasks with at least one of these labels (case-insensitive). Mapped to repeating `?with_labels[]=`. CLI never emits the deprecated singular `with_label` form (see §2.5). |
| `--without-label <name>` | string | unset | Exclude tasks with this label (case-insensitive). Mapped to `?without_label=`. **Single value only** — Freelo's spec exposes only the singular form (OpenAPI :1507-1511); `--without-label` is therefore non-repeatable in v1. (See OQ #5.) |
| `--due-from <date>` | `YYYY-MM-DD` | unset | Mapped to `?due_date_range[date_from]=`. |
| `--due-to <date>` | `YYYY-MM-DD` | unset | Mapped to `?due_date_range[date_to]=`. |
| `--no-due` | boolean | `false` | Mapped to `?no_due_date=true`. Mutually exclusive with `--due-from` / `--due-to` (see §5). |
| `--finished-overdue` | boolean | `false` | Mapped to `?finished_overdue=true`. (`/all-tasks` only.) |
| `--finished-from <date>` | `YYYY-MM-DD` | unset | Mapped to `?finished_date_range[date_from]=`. (`/all-tasks` only.) |
| `--finished-to <date>` | `YYYY-MM-DD` | unset | Mapped to `?finished_date_range[date_to]=`. (`/all-tasks` only.) |
| `--search <text>` | string | unset | Mapped to `?search_query=`. Available on `/all-tasks` and `/tasklist/{id}/finished-tasks`. **Forbidden** when the route resolves to `/project/{p}/tasklist/{t}/tasks` (which has no `search_query`); attempting it → `ValidationError` (see §5). |
| `--order-by <key>` | enum: `priority \| name \| date_add \| date_edited_at` | unset (server default) | Mapped to `?order_by=`. Applies to `/all-tasks` and `/project/{p}/tasklist/{t}/tasks`; ignored on `/tasklist/{id}/finished-tasks` (which has no `order_by`). |
| `--order <dir>` | enum: `asc \| desc` | unset (server default) | Mapped to `?order=`. Same applicability as `--order-by`. |
| `--page <N>` | int >= 1 | unset | Single-page fetch. Mapped to `?p=N-1` on the wire. Mutually exclusive with `--all` / `--cursor`. |
| `--all` | boolean | `false` | Iterate pages until exhausted. Mutually exclusive with `--page` / `--cursor`. **`/project/{p}/tasklist/{t}/tasks` is unpaginated** — `--all` returns the single bare-array result without iterating. (See §2.4 + §5.) |
| `--cursor <n>` | int >= 0 | unset | Single-page fetch at cursor `n`. Mutually exclusive. |
| `--fields <list>` | comma-separated string | unset (full default) | Top-level field projection. Validated **before** any HTTP call. |

**Mutual exclusion** of `--page` / `--all` / `--cursor` is enforced at action-time (existing pattern from R03/R05/R06). Two of the three set → `ValidationError({ exitCode: 2, hintNext: 'Pick one of --page, --all, or --cursor.' })`.

**Numeric parsers** (`--project`, `--tasklist`, `--worker`, `--state`, `--page`, `--cursor`) reuse the `parsePositiveIntFlag` / `parseNonNegativeIntFlag` pattern from `src/commands/tasklists/list.ts:44-62` — both throw `ValidationError` (exit 2), **never** Commander's `InvalidArgumentError` (Calibration §1-2).

**Date parsers** (`--due-from`, `--due-to`, `--finished-from`, `--finished-to`) require strict `YYYY-MM-DD` (regex `^\d{4}-\d{2}-\d{2}$` plus `Date.parse` non-NaN). Bad input → `ValidationError` (exit 2). The CLI does not normalize timezones or range-validate from < to.

**Per-command `meta`** (consumed by the introspector):

```ts
export const meta = { outputSchema: 'freelo.tasks.list/v1', destructive: false } as const;
```

### 2.2 Flag combination → endpoint mapping

The CLI dispatches to one of three endpoints based on the flag combination. The decision tree is evaluated **after** validation (§5):

```
                                 ┌───────────────────────────┐
                                 │   --finished-overdue OR    │
                                 │   --finished-from OR       │
                                 │   --finished-to set?       │
                                 └─────────────┬──────────────┘
                                               │ yes
                  ┌────────────────────────────┴────────────────────────────┐
                  │ exactly 1 --tasklist AND zero --project (or --project's │
                  │ value is irrelevant, see below)?                        │
                  └────────────────────────┬───────────────────────────────┘
                          yes              │              no
            ┌──────────────────┐           │     ┌──────────────────────────┐
            │ /tasklist/{id}/  │           │     │ /all-tasks               │
            │ finished-tasks   │           │     │ (use finished_overdue,   │
            │ (paginated)      │           │     │ finished_date_range)     │
            └──────────────────┘           │     └──────────────────────────┘
                                           │
                                           ▼
                  ┌─────────── if NO finished-* flags ────────────┐
                  │  exactly 1 --project AND exactly 1 --tasklist?│
                  └────────────────────┬──────────────────────────┘
                          yes          │          no
            ┌────────────────────┐     │    ┌──────────────┐
            │ /project/{p}/      │     │    │ /all-tasks   │
            │ tasklist/{t}/tasks │     │    │ (paginated)  │
            │ (NOT paginated)    │     │    └──────────────┘
            └────────────────────┘     │
```

Concretely:

| Flag combination | Endpoint | Pagination | Inner key | Entity |
|---|---|---|---|---|
| `--finished-overdue` OR `--finished-from` OR `--finished-to` set, **and** exactly one `--tasklist`, **and** zero `--project` | `GET /tasklist/{tasklist_id}/finished-tasks` | paginated | `finished_tasks` | `TaskFinished` |
| `--finished-*` set, but **not** the above shape | `GET /all-tasks` | paginated | `tasks` | `TaskFull` |
| Exactly one `--project` AND exactly one `--tasklist` AND no `--finished-*` AND no `--worker`/`--state`/`--label`/`--without-label`/`--due-*`/`--no-due`/`--search` | `GET /project/{project_id}/tasklist/{tasklist_id}/tasks` | **unpaginated** (bare array) | n/a | `TaskSummary` |
| Anything else (zero or multiple `--project`, multiple `--tasklist`, any other filter…) | `GET /all-tasks` | paginated | `tasks` | `TaskFull` |

**Why this dispatch.** The roadmap names three endpoints; each has materially different semantics:

- `/project/{p}/tasklist/{t}/tasks` is the only endpoint that returns **active** (non-finished) tasks scoped to a tasklist as a flat array (no pagination). It accepts only `order_by` / `order`. Any `--worker`, `--state`, etc. forces `/all-tasks` because the per-tasklist endpoint can't filter that way.
- `/tasklist/{tasklist_id}/finished-tasks` is the **only** way to retrieve finished tasks scoped to one tasklist. It accepts `search_query` and pagination, but no other filters. The `--finished-*` flags are the user signal that they want this endpoint.
- `/all-tasks` is the workhorse — it accepts every filter the other two don't.

**`--finished-overdue` is `/all-tasks`-only per the OpenAPI spec** (:1530). Combining `--finished-overdue` with `--tasklist` (single) routes to `/tasklist/{id}/finished-tasks`, which returns finished tasks in that tasklist regardless of overdue status. That's potentially confusing — see OQ #4. Decision: **forbid `--finished-overdue` together with a single-tasklist combination** that would route to `/tasklist/{id}/finished-tasks`. If the user passes `--finished-overdue --tasklist 42`, route to `/all-tasks` with `?tasklists_ids[]=42&finished_overdue=true` — `/all-tasks` does support combining them. (The dispatch tree above is updated accordingly: `--finished-overdue` always routes to `/all-tasks`; only `--finished-from` / `--finished-to` (plus exactly one `--tasklist`, zero `--project`) routes to `/tasklist/{id}/finished-tasks`.)

**Revised dispatch (binding):**

| Flag combination | Endpoint | Pagination | Inner key | Entity |
|---|---|---|---|---|
| (`--finished-from` OR `--finished-to`) AND exactly one `--tasklist` AND zero `--project` AND no `--worker`/`--state`/`--label`/`--without-label`/`--due-*`/`--no-due`/`--finished-overdue` | `GET /tasklist/{tasklist_id}/finished-tasks` | paginated | `finished_tasks` | `TaskFinished` |
| Exactly one `--project` AND exactly one `--tasklist` AND no `--worker`/`--state`/`--label`/`--without-label`/`--due-*`/`--no-due`/`--finished-*`/`--search` | `GET /project/{project_id}/tasklist/{tasklist_id}/tasks` | **unpaginated** | n/a | `TaskSummary` |
| Anything else | `GET /all-tasks` | paginated | `tasks` | `TaskFull` |

The dispatch is **observable** via `data.endpoint` in the envelope (§2.3) so agents can see which route the CLI took.

**No-flags default.** `freelo tasks list` (no flags) → `/all-tasks?p=0`. Agent-friendly: returns first page of every accessible task in every accessible project, in server-default order.

### 2.3 Envelope shape — `freelo.tasks.list/v1`

The envelope uses an **`entity_shape` discriminator** to handle the three task shapes (`TaskFull` for `/all-tasks`, `TaskSummary` for `/project/{p}/tasklist/{t}/tasks`, `TaskFinished` for `/tasklist/{id}/finished-tasks`). Same pattern as R03's `freelo.projects.list/v1`.

```jsonc
{
  "schema": "freelo.tasks.list/v1",
  "data": {
    "endpoint":      "all-tasks" | "tasklist-tasks" | "tasklist-finished-tasks",
    "entity_shape":  "task_full" | "task_summary" | "task_finished",
    "applied_filters": {
      // echoes the filter args the user passed, for round-trip clarity.
      // Only includes keys the user actually set; absent keys mean "not filtered".
      "projects":       [42, 43] | undefined,
      "tasklists":      [101]    | undefined,
      "worker":         7        | undefined,
      "state":          1        | undefined,
      "labels":         ["bug", "p1"] | undefined,
      "without_label":  "wontfix" | undefined,
      "due_from":       "2026-04-01" | undefined,
      "due_to":         "2026-04-30" | undefined,
      "no_due":         true        | undefined,
      "finished_overdue": true      | undefined,
      "finished_from":  "2026-04-01" | undefined,
      "finished_to":    "2026-04-30" | undefined,
      "search":         "redesign" | undefined,
      "order_by":       "priority" | undefined,
      "order":          "asc"     | undefined
    },
    "tasks":          [ /* per-shape items */ ]
  },
  "paging": {
    "page":        0,
    "per_page":    25,
    "total":       137,
    "next_cursor": 1
  },
  "rate_limit": { "remaining": 42, "reset_at": "2026-04-25T18:30:00Z" },
  "request_id": "..."
}
```

**Why `data` is an object with a discriminator.** Same logic as R03: agents key off `entity_shape` before reading shape-specific fields. The `endpoint` field is a related-but-distinct discriminator — it tells the agent **which endpoint backed the call**, useful for debugging and for understanding why certain filters were respected/ignored. Both fields are kept because they answer different questions:

- `endpoint`: "where did the CLI route?"
- `entity_shape`: "what fields does each item have?"

The mapping is 1-1 today (each endpoint emits one shape), but if Freelo ever extended e.g. `/all-tasks` to return both `TaskFull` and `TaskFinished` based on filters, `entity_shape` would diverge from `endpoint` and agents would key on the right one for their need.

**`applied_filters` is ALWAYS present** (object), even when empty (`{}`). Agents can iterate its keys without an existence check. Empty object means "no filters were applied — server-default sweep".

**`paging` is always present.** For the unpaginated `/project/{p}/tasklist/{t}/tasks` route, `paging` is **synthesized** via `synthesizeUnpaginated` (existing helper from `src/api/pagination.ts:35-43`). `paging.page === 0`, `paging.per_page === tasks.length`, `paging.total === tasks.length`, `paging.next_cursor === null`. Agents loop on `next_cursor !== null` and the synthesized null terminates the loop trivially. (Same precedent as R03 `--scope owned`.)

**Field naming:** snake_case throughout, matching what Freelo emits. Wire-format `date_add`, `due_date`, `count_subtasks`, `worker.fullname`. One naming convention per envelope.

### 2.4 Pagination semantics

Three switches; one wins per invocation. None set ≡ `--page 1`. Identical to R03 §2.4 / R05 §2.4 modulo the unpaginated route.

#### Single-page (`--page N` / `--cursor n` / default)

Same as R03/R05.

#### `--all` (client-side iteration)

For paginated routes (`/all-tasks`, `/tasklist/{id}/finished-tasks`): iterates `?p=0, 1, ...` until `nextCursor === null`. Output composition by mode is identical to R05 §2.4:

- **`json`** → one merged envelope (`data.tasks` = concat).
- **`ndjson`** → one envelope per page on stdout.
- **`human`** → single table; pages fetched silently.

For the unpaginated route (`/project/{p}/tasklist/{t}/tasks`): `--all` returns the single bare-array result wrapped in `synthesizeUnpaginated`. No iteration; no error. Documented behavior (matches R03 `--scope owned`).

**Mid-stream `--all` error policy:** Same as R03 §5 / R05 §5. The partial accumulated envelope is emitted to stdout (with `notice: 'Partial result; iteration aborted at page N.'`); the underlying error envelope goes to stderr; exit follows the underlying error class.

### 2.5 Array param encoding — `src/lib/query.ts` (NEW shared lib)

**Roadmap requirement:** "encodes array params as `projects_ids[]=...` repeating, not PHP-brackets-in-key".

The roadmap intent is clear: when a request has multiple `projects_ids[]` values, the wire format must be **repeating key=value pairs**:

```
?projects_ids[]=42&projects_ids[]=43&with_labels[]=bug
```

NOT:

```
?projects_ids=[42,43]
?projects_ids[0]=42&projects_ids[1]=43
?projects_ids%5B0%5D=42
```

Node's built-in `URLSearchParams.append` already encodes `[` and `]` (as `%5B` / `%5D`) and supports repeating keys. So `URLSearchParams` is **almost sufficient** — Freelo's API treats `projects_ids[]=42&projects_ids[]=43` and `projects_ids%5B%5D=42&projects_ids%5B%5D=43` identically (URL decoding happens before route matching). The R05 `getAllTasklists` wrapper at `src/api/tasklists.ts:46-50` already proved this works.

**Why a dedicated `src/lib/query.ts` then?** Because R07 has 15 query params with three different encoding shapes:

1. **Repeating arrays:** `projects_ids[]`, `tasklists_ids[]`, `with_labels[]`.
2. **Bracketed object:** `due_date_range[date_from]`, `due_date_range[date_to]`, `finished_date_range[date_from]`, `finished_date_range[date_to]`.
3. **Scalars:** `worker_id`, `state_id`, `without_label`, `no_due_date`, `finished_overdue`, `search_query`, `order_by`, `order`, `p`.

Doing this inline in `src/api/tasks.ts` would be a 60-line tangle. A reusable, tested `buildQuery(params)` helper isolates the encoding so future write commands can compose URL params consistently. Test surface is small (one file).

**API:**

```ts
/**
 * Encode a typed param map into a URL query string (no leading `?`).
 *
 *   buildQuery({
 *     'projects_ids[]':         [42, 43],
 *     'tasklists_ids[]':        [101],
 *     'with_labels[]':          ['bug', 'p1'],
 *     'without_label':          'wontfix',
 *     'due_date_range[date_from]': '2026-04-01',
 *     'no_due_date':            true,
 *     'p':                      0,
 *   })
 *   //=>
 *   "projects_ids%5B%5D=42&projects_ids%5B%5D=43&tasklists_ids%5B%5D=101
 *    &with_labels%5B%5D=bug&with_labels%5B%5D=p1&without_label=wontfix
 *    &due_date_range%5Bdate_from%5D=2026-04-01&no_due_date=true&p=0"
 *
 *  Encoding rules:
 *  - Array values (`number[]`, `string[]`) are emitted as repeating
 *    key=value pairs. The bracketed key (`projects_ids[]`) is encoded once
 *    (URLSearchParams.append handles the `[]` percent-encoding).
 *  - Boolean values: `true` → `"true"`, `false` → omitted entirely (matches
 *    Freelo's "default false" for `no_due_date` / `finished_overdue` —
 *    don't bloat the URL with defaults).
 *  - `undefined` values are omitted.
 *  - All other values are toString-coerced.
 */
export function buildQuery(
  params: Readonly<Record<string, string | number | boolean | readonly (string | number)[] | undefined>>,
): string;
```

**`with_label` (deprecated singular) handling — explicit policy:**

Per OpenAPI :1501-1506, `with_label` is the deprecated single-value alias for `with_labels[]`. Per the API description: "when both are sent, `with_label` is merged into the array". The roadmap calls out: "CLI normalizes to the array form".

**Decision (binding):** The CLI **never emits `with_label`** on the wire. The CLI surface only exposes `--label <name>` (repeatable), which always maps to `with_labels[]`. `buildQuery` rejects a `with_label` key (TypeScript wouldn't surface it, but a runtime guard makes the policy explicit). If a future R07.5 needed to expose the deprecated form, that would be an additive flag like `--legacy-label` (don't add it without a real consumer).

This is the "explicit handling of the `with_label` vs `with_labels[]` merge quirk" the roadmap calls for: **resolved by never sending the singular form**. The merge quirk only matters when a client mixes both; we never do.

### 2.6 `--fields` projection

Comma-separated snake_case keys. Reuses `projectFields` from `src/api/pagination.ts`. The valid-fields list comes from a **per-entity-shape** registry in the new `src/api/schemas/task.ts`:

- `TASK_FULL_DEFAULT_FIELDS`
- `TASK_SUMMARY_DEFAULT_FIELDS`
- `TASK_FINISHED_DEFAULT_FIELDS`

Validation runs **after** route resolution (so the right registry is picked) but **before** any HTTP call. Same `EMPTY_FIELDS` / `UNKNOWN_FIELD` / `NESTED_FIELDS_UNSUPPORTED` errors with the spec-defined `hintNext`. The `scopeForMessage` parameter passed to `projectFields` is the entity-shape string (e.g. `'task_full'`) so the error message lists the right field set.

### 2.7 `human`-mode rendering

Lazy `cli-table3` via the existing `src/ui/table.ts`. Default columns by entity shape:

- `task_full`: `id`, `name`, `worker`, `due_date`, `project`, `tasklist`, `state`
- `task_summary`: `id`, `name`, `worker`, `due_date`, `count_comments`, `count_subtasks`
- `task_finished`: `id`, `name`, `worker`, `date_finished`, `finished_by`

Summarisation (mirror R05 `project` → `project.name`):
- `worker` → `worker.fullname` (fall back to `String(worker.id)` when `fullname` is null/undefined — same fallback as R05.5 spec 0015 §1).
- `project` → `project.name`.
- `tasklist` → `tasklist.name`.
- `state` → `state.state` (string, not the numeric id).
- `finished_by` → `finished_by.fullname` (with same null fallback).
- `due_date` / `date_finished` / `date_add` → ISO-8601 verbatim (no relative dates).

Empty list: header row + `(no tasks)` body row.

### 2.8 Default `--fields` (when none given)

Per entity shape:

- `task_full`: `id, name, date_add, date_edited_at, due_date, due_date_end, count_comments, count_subtasks, author, worker, labels, parent_task_id, total_time_estimate, state, project, tasklist`
- `task_summary`: `id, name, date_add, date_edited_at, due_date, due_date_end, count_comments, count_subtasks, author, worker, labels, parent_task_id, total_time_estimate`
- `task_finished`: `id, name, date_add, date_edited_at, due_date, due_date_end, count_comments, count_subtasks, author, worker, labels, parent_task_id, total_time_estimate, date_finished, finished_by`

Default `--fields` = full payload per entity shape. `--fields` is the trim-down knob, not the opt-in knob.

### 2.9 Examples

**Agent-style — no flags, default `/all-tasks`:**

```bash
$ FREELO_API_KEY=sk-... FREELO_EMAIL=agent@acme.cz freelo tasks list --output json
{"schema":"freelo.tasks.list/v1","data":{"endpoint":"all-tasks","entity_shape":"task_full","applied_filters":{},"tasks":[{"id":1001,"name":"Hero copy","worker":{"id":7,"fullname":"Jan Novák"},"due_date":"2026-04-30T17:00:00+02:00","project":{"id":42,"name":"Site redesign","state":{"id":1,"state":"active"}},"tasklist":{"id":101,"name":"Backlog","state":{"id":1,"state":"active"}},"state":{"id":1,"state":"active"}}]},"paging":{"page":0,"per_page":25,"total":7,"next_cursor":null},"rate_limit":{"remaining":99,"reset_at":"2026-04-27T07:00:00Z"},"request_id":"..."}
$ echo $?
0
```

**Agent-style — filter to multiple projects + label:**

```bash
$ freelo tasks list --project 42 --project 43 --label bug --label p1 --output json
{"schema":"freelo.tasks.list/v1","data":{"endpoint":"all-tasks","entity_shape":"task_full","applied_filters":{"projects":[42,43],"labels":["bug","p1"]},"tasks":[/*…*/]},"paging":{...},...}
```

**Agent-style — drill into one tasklist (per-tasklist active tasks, unpaginated):**

```bash
$ freelo tasks list --project 42 --tasklist 101 --output json
{"schema":"freelo.tasks.list/v1","data":{"endpoint":"tasklist-tasks","entity_shape":"task_summary","applied_filters":{"projects":[42],"tasklists":[101]},"tasks":[/*…*/]},"paging":{"page":0,"per_page":3,"total":3,"next_cursor":null},...}
```

**Agent-style — finished tasks in a tasklist with a date range:**

```bash
$ freelo tasks list --tasklist 101 --finished-from 2026-04-01 --finished-to 2026-04-30 --output json
{"schema":"freelo.tasks.list/v1","data":{"endpoint":"tasklist-finished-tasks","entity_shape":"task_finished","applied_filters":{"tasklists":[101],"finished_from":"2026-04-01","finished_to":"2026-04-30"},"tasks":[/*…*/]},"paging":{"page":0,"per_page":25,"total":12,"next_cursor":null},...}
```

**Agent-style — `--all` with `--output ndjson`:**

```bash
$ freelo tasks list --label bug --all --output ndjson
{"schema":"freelo.tasks.list/v1","data":{"endpoint":"all-tasks","entity_shape":"task_full","applied_filters":{"labels":["bug"]},"tasks":[/*page0*/]},"paging":{"page":0,"per_page":25,"total":75,"next_cursor":1},...}
{"schema":"freelo.tasks.list/v1","data":{"endpoint":"all-tasks","entity_shape":"task_full","applied_filters":{"labels":["bug"]},"tasks":[/*page1*/]},"paging":{"page":1,"per_page":25,"total":75,"next_cursor":2},...}
{"schema":"freelo.tasks.list/v1","data":{"endpoint":"all-tasks","entity_shape":"task_full","applied_filters":{"labels":["bug"]},"tasks":[/*page2*/]},"paging":{"page":2,"per_page":25,"total":75,"next_cursor":null},...}
```

**Human (TTY) — default `/all-tasks`:**

```
$ freelo tasks list
ID    NAME                                       WORKER         DUE_DATE                  PROJECT          TASKLIST     STATE
1001  Hero copy                                  Jan Novák      2026-04-30T17:00:00+02:00 Site redesign    Backlog      active
1002  Footer links                               (unassigned)   —                         Site redesign    Backlog      active
```

**Error: `--no-due` with `--due-from`:**

```bash
$ freelo tasks list --no-due --due-from 2026-04-01 --output json
{"schema":"freelo.error/v1","error":{"code":"VALIDATION_ERROR","message":"--no-due and --due-from/--due-to are mutually exclusive.","http_status":null,"request_id":"...","retryable":false,"hint_next":"Pick either --no-due or a --due-from/--due-to range.","docs_url":null}}
$ echo $?
2
```

**Error: `--search` with the per-tasklist active route:**

```bash
$ freelo tasks list --project 42 --tasklist 101 --search redesign --output json
{"schema":"freelo.error/v1","error":{"code":"VALIDATION_ERROR","message":"--search is not supported when listing active tasks of a single tasklist.","hint_next":"Drop --project to use /all-tasks, or drop --search."}}
$ echo $?
2
```

**Error: bad date format:**

```bash
$ freelo tasks list --due-from 2026/04/01 --output json
{"schema":"freelo.error/v1","error":{"code":"VALIDATION_ERROR","message":"--due-from must be in YYYY-MM-DD format.","hint_next":"Use ISO date format, e.g. 2026-04-01."}}
$ echo $?
2
```

**Error: 401 from the API:**

```bash
$ FREELO_API_KEY=bad freelo tasks list --output json
{"schema":"freelo.error/v1","error":{"code":"AUTH_ERROR","message":"Authentication failed.","http_status":401,...}}
$ echo $?
3
```

## 3. API surface

Three GET endpoints. All require Basic auth (R01-wired). Cited line numbers refer to `docs/api/freelo-api.yaml`.

| # | Endpoint | OpenAPI lines | Wrapper | Inner key | Entity |
|---|---|---|---|---|---|
| 1 | `GET /all-tasks` | :1436-1570 | `PaginatedResponse` (:4814-4824) | `data.tasks[]` | `TaskFull` (:5263-5287) |
| 2 | `GET /project/{project_id}/tasklist/{tasklist_id}/tasks` | :1361-1401 | **bare array** (no pagination) | n/a | `TaskSummary` (:5220-5261) |
| 3 | `GET /tasklist/{tasklist_id}/finished-tasks` | :1572-1612 | `PaginatedResponse` | `data.finished_tasks[]` | `TaskFinished` (:5289-5298) |

### Pagination wire format

Same as R03/R05 — `{ total, count, page, per_page, data: { [innerKey]: T[] } }`. Page param `?p=<int>`, 0-indexed.

### Filters supported per endpoint

**`/all-tasks`** (:1456-1553) — supports every R07 filter:
- `search_query`, `state_id`, `projects_ids[]`, `tasklists_ids[]`, `order_by`, `order`, `with_labels[]`, `with_label` (deprecated, never emitted), `without_label`, `no_due_date`, `due_date_range[date_from]`, `due_date_range[date_to]`, `finished_overdue`, `finished_date_range[date_from]`, `finished_date_range[date_to]`, `worker_id`, `p`.

**`/project/{p}/tasklist/{t}/tasks`** (:1378-1392) — supports only:
- `order_by` (default `priority`), `order` (default `asc`).

**`/tasklist/{tasklist_id}/finished-tasks`** (:1589-1595) — supports only:
- `search_query`, `p`.

R07 silently drops unsupported filters when routing to the per-tasklist or finished-tasks endpoints? **No** — R07 forbids combinations that would silently drop filters. The dispatch tree (§2.2) routes to `/all-tasks` whenever any filter the per-tasklist routes don't support is set. The two exceptions:

- `--order-by` / `--order` with the per-tasklist active route → forwarded.
- `--search` / `--finished-from` / `--finished-to` with the per-tasklist finished route → forwarded.

If the user passes a flag that's incompatible with the resolved route (e.g. `--search` with `/project/{p}/tasklist/{t}/tasks`), the CLI emits `ValidationError` (exit 2) — see §5.

### Auth + rate limits

Basic auth from R01. Rate-limit headers parsed by R01's HttpClient. Envelope's `rate_limit` field carries the **last fetched page's** values when `--all` is used.

### Roadmap fidelity

The roadmap's three endpoints map 1:1 to this spec's §3 table. No deviation.

## 4. Data model

### 4.1 `src/api/schemas/task.ts` (new)

Zod schemas for the three task entity variants. Mirrors `src/api/schemas/project.ts` posture: `.passthrough()` on entities, `.nullable().optional()` on every non-required field, only `id` + `name` are universally required.

```ts
import { z } from 'zod';
import { UserBasicSchema } from './project.js';

const StateSchema = z.object({
  id: z.number().int(),
  state: z.enum(['active', 'archived', 'finished', 'deleted', 'template']),
});

const TaskLabelSchema = z.object({
  uuid: z.string(),
  name: z.string(),
  color: z.string().nullable().optional(),
});

const TimeEstimateSchema = z.object({ minutes: z.number().int() });

const UserTimeEstimateSchema = z.object({
  minutes: z.number().int(),
  user: UserBasicSchema,
});

const ProjectRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    state: StateSchema.nullable().optional(),
  })
  .passthrough();

const TasklistRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    state: StateSchema.nullable().optional(),
  })
  .passthrough();

/** TaskSummary per OpenAPI :5220-5261. Backs /project/{p}/tasklist/{t}/tasks. */
export const TaskSummarySchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    date_add: z.string().nullable().optional(),
    date_edited_at: z.string().nullable().optional(),
    due_date: z.string().nullable().optional(),
    due_date_end: z.string().nullable().optional(),
    count_comments: z.number().int().nullable().optional(),
    count_subtasks: z.number().int().nullable().optional(),
    author: UserBasicSchema.nullable().optional(),
    worker: UserBasicSchema.nullable().optional(),
    labels: z.array(TaskLabelSchema).nullable().optional(),
    parent_task_id: z.number().int().nullable().optional(),
    total_time_estimate: TimeEstimateSchema.nullable().optional(),
    users_time_estimates: z.array(UserTimeEstimateSchema).nullable().optional(),
  })
  .passthrough();

/** TaskFull per OpenAPI :5263-5287. Backs /all-tasks. Adds state/project/tasklist. */
export const TaskFullSchema = TaskSummarySchema.and(
  z.object({
    state: StateSchema.nullable().optional(),
    project: ProjectRefSchema.nullable().optional(),
    tasklist: TasklistRefSchema.nullable().optional(),
  }),
);

/** TaskFinished per OpenAPI :5289-5298. Backs /tasklist/{id}/finished-tasks. */
export const TaskFinishedSchema = TaskSummarySchema.and(
  z.object({
    date_finished: z.string().nullable().optional(),
    finished_by: UserBasicSchema.nullable().optional(),
  }),
);

export type TaskSummary = z.infer<typeof TaskSummarySchema>;
export type TaskFull = z.infer<typeof TaskFullSchema>;
export type TaskFinished = z.infer<typeof TaskFinishedSchema>;

export type TaskEntityShape = 'task_full' | 'task_summary' | 'task_finished';
export type EndpointKey = 'all-tasks' | 'tasklist-tasks' | 'tasklist-finished-tasks';

export type AppliedFilters = {
  projects?: number[];
  tasklists?: number[];
  worker?: number;
  state?: number;
  labels?: string[];
  without_label?: string;
  due_from?: string;
  due_to?: string;
  no_due?: true;
  finished_overdue?: true;
  finished_from?: string;
  finished_to?: string;
  search?: string;
  order_by?: 'priority' | 'name' | 'date_add' | 'date_edited_at';
  order?: 'asc' | 'desc';
};

export type TaskListData =
  | {
      endpoint: 'all-tasks';
      entity_shape: 'task_full';
      applied_filters: AppliedFilters;
      tasks: TaskFull[];
    }
  | {
      endpoint: 'tasklist-tasks';
      entity_shape: 'task_summary';
      applied_filters: AppliedFilters;
      tasks: TaskSummary[];
    }
  | {
      endpoint: 'tasklist-finished-tasks';
      entity_shape: 'task_finished';
      applied_filters: AppliedFilters;
      tasks: TaskFinished[];
    };

export const TASK_FULL_DEFAULT_FIELDS: readonly string[] = Object.freeze([
  'id', 'name', 'date_add', 'date_edited_at', 'due_date', 'due_date_end',
  'count_comments', 'count_subtasks', 'author', 'worker', 'labels',
  'parent_task_id', 'total_time_estimate', 'state', 'project', 'tasklist',
]);

export const TASK_SUMMARY_DEFAULT_FIELDS: readonly string[] = Object.freeze([
  'id', 'name', 'date_add', 'date_edited_at', 'due_date', 'due_date_end',
  'count_comments', 'count_subtasks', 'author', 'worker', 'labels',
  'parent_task_id', 'total_time_estimate',
]);

export const TASK_FINISHED_DEFAULT_FIELDS: readonly string[] = Object.freeze([
  'id', 'name', 'date_add', 'date_edited_at', 'due_date', 'due_date_end',
  'count_comments', 'count_subtasks', 'author', 'worker', 'labels',
  'parent_task_id', 'total_time_estimate', 'date_finished', 'finished_by',
]);
```

### 4.2 `src/lib/query.ts` (new shared lib)

Per spec §2.5. Pure function; no deps; no I/O. Test surface: one file, ~10 cases.

### 4.3 `src/api/tasks.ts` (new)

Three HTTP wrappers, one per endpoint. Each accepts a typed `opts` object covering only the params it actually supports. Each returns `{ page: NormalizedPage<T>, raw: ApiResponse<unknown> }` so the command keeps `rateLimit` from the underlying call.

```ts
import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';
import {
  TaskFullSchema, TaskSummarySchema, TaskFinishedSchema,
  type TaskFull, type TaskSummary, type TaskFinished,
} from './schemas/task.js';
import {
  type NormalizedPage, normalizePaginated, synthesizeUnpaginated,
} from './pagination.js';
import { buildQuery } from '../lib/query.js';

export type FetchOpts = { signal?: AbortSignal; requestId?: string };

export type TasksListResult<T> = {
  page: NormalizedPage<T>;
  raw: ApiResponse<unknown>;
};

export type AllTasksOpts = FetchOpts & {
  page: number;
  filters: {
    projects?: readonly number[];
    tasklists?: readonly number[];
    worker?: number;
    state?: number;
    labels?: readonly string[];
    withoutLabel?: string;
    dueFrom?: string;
    dueTo?: string;
    noDue?: boolean;
    finishedOverdue?: boolean;
    finishedFrom?: string;
    finishedTo?: string;
    search?: string;
    orderBy?: 'priority' | 'name' | 'date_add' | 'date_edited_at';
    order?: 'asc' | 'desc';
  };
};

/** GET /all-tasks?<query> */
export async function getAllTasks(
  client: HttpClient,
  opts: AllTasksOpts,
): Promise<TasksListResult<TaskFull>> { /* … */ }

export type TasklistTasksOpts = FetchOpts & {
  projectId: number;
  tasklistId: number;
  orderBy?: 'priority' | 'name' | 'date_add' | 'date_edited_at';
  order?: 'asc' | 'desc';
};

/** GET /project/{p}/tasklist/{t}/tasks — bare array. */
export async function getTasklistActiveTasks(
  client: HttpClient,
  opts: TasklistTasksOpts,
): Promise<TasksListResult<TaskSummary>> { /* … synthesizeUnpaginated */ }

export type TasklistFinishedOpts = FetchOpts & {
  tasklistId: number;
  page: number;
  search?: string;
};

/** GET /tasklist/{t}/finished-tasks?<query> */
export async function getTasklistFinishedTasks(
  client: HttpClient,
  opts: TasklistFinishedOpts,
): Promise<TasksListResult<TaskFinished>> { /* … */ }
```

## 5. Edge cases

(Each test case in §8.3 plan corresponds to one of these.)

- **`--page N` past the last page.** Server returns wrapper with empty inner array. Envelope emits `tasks: []`, `paging.next_cursor: null`. Exit 0.
- **`--cursor n` past `total`.** Same as above.
- **`--cursor n` on the unpaginated route (`/project/{p}/tasklist/{t}/tasks`).** `--cursor 0` works (returns the only page). `--cursor n>=1` → `ValidationError('CURSOR_OUT_OF_RANGE')` exit 2 with hint "This route is unpaginated; use --cursor 0 or omit it." — same precedent as R03 `--scope owned --cursor 1`.
- **Empty result.** `tasks: []`, `paging.total: 0`, `paging.next_cursor: null`. Exit 0.
- **`--project` for a project the caller can't see.** ACL-filtered: 200 with empty result. Exit 0. Same posture as R05 OQ #2.
- **`--project abc` (non-numeric).** `ValidationError` (exit 2). **Mandatory test.**
- **`--project 0` / negative.** `ValidationError` (exit 2). **Mandatory test.**
- **`--tasklist abc` / `0` / negative.** `ValidationError` (exit 2). **Mandatory test.**
- **`--worker abc` / `0`.** `ValidationError` (exit 2). **Mandatory test.**
- **`--state abc` / `0`.** `ValidationError` (exit 2).
- **`--page abc`.** `ValidationError` (exit 2). **Mandatory test.**
- **`--cursor -1`.** `ValidationError` (exit 2). **Mandatory test.**
- **`--page 2 --all` (mutex).** `ValidationError` (exit 2). **Mandatory test.**
- **`--page 1 --cursor 1` (mutex).** `ValidationError` (exit 2).
- **`--all --cursor 0` (mutex).** `ValidationError` (exit 2).
- **`--no-due --due-from 2026-04-01` (mutex).** `ValidationError` (exit 2). Hint: "Pick either --no-due or a --due-from/--due-to range." **Mandatory test.**
- **`--no-due --due-to 2026-04-30` (mutex).** Same as above.
- **`--due-from 2026/04/01` (bad format).** `ValidationError` (exit 2). Hint: "Use ISO date format, e.g. 2026-04-01."
- **`--due-from 2026-13-01` (parses regex but invalid date).** `ValidationError` (exit 2) — `Date.parse` returns NaN.
- **`--due-from 2026-04-01 --due-to 2026-03-01` (range inverted).** **NOT validated client-side.** Forwarded to Freelo verbatim. Server returns whatever it returns (likely empty). Documented; not a bug. (Range validation is a CLI nicety we'll add when a real consumer trips on it.)
- **`--search redesign --project 42 --tasklist 101` (route forces per-tasklist active, but `--search` not supported there).** `ValidationError` (exit 2). Hint: "--search is not supported when listing active tasks of a single tasklist. Drop --project to use /all-tasks, or drop --search."
- **`--worker 7 --project 42 --tasklist 101` (per-tasklist active doesn't support `--worker`).** Route falls through to `/all-tasks` with `?projects_ids[]=42&tasklists_ids[]=101&worker_id=7`. **No error** — the dispatch tree (§2.2) explicitly routes "anything that needs filtering the per-tasklist route doesn't support" to `/all-tasks`. **Mandatory test.**
- **`--finished-overdue --tasklist 101` (forces /all-tasks with tasklists_ids[] + finished_overdue).** Routes to `/all-tasks`. **Mandatory test.**
- **`--finished-from 2026-04-01 --tasklist 101` (no `--project`).** Routes to `/tasklist/101/finished-tasks?finished_date_range[date_from]=2026-04-01`. **Wait** — OpenAPI :1589-1595 lists only `search_query` and `p` for `/tasklist/{id}/finished-tasks`; `finished_date_range[*]` is **NOT** documented for that endpoint. Re-evaluate: routing to `/tasklist/{id}/finished-tasks` and dropping `--finished-from` would silently lose the filter. Routing to `/all-tasks?tasklists_ids[]=101&finished_date_range[date_from]=2026-04-01` preserves the filter. **Decision (binding):** Routes to `/all-tasks`. The `/tasklist/{id}/finished-tasks` route is reserved for invocations where `--finished-from`/`--finished-to` are NOT set. **Updated dispatch tree (§2.2) reflects this — the only flag combination that lands on `/tasklist/{id}/finished-tasks` is "exactly one `--tasklist`, zero `--project`, no other filters, and the user is implicitly asking for finished-only via the absence of `--state`". That's vague. Cleaner: introduce an explicit `--finished` boolean flag.
- **Unresolvable: how does the user say "I want finished tasks in this tasklist"?** With the current flag set, the only way to land on `/tasklist/{id}/finished-tasks` is for the dispatch to infer it. That's a usability gap. **Decision (binding for this slice):** Add an explicit `--finished` boolean flag (yes/no — default false). When `--finished --tasklist <id>` is set with no `--project` and no other filter the per-tasklist finished route doesn't support, route to `/tasklist/{id}/finished-tasks`. Otherwise (or with multiple `--tasklist`, or with `--project`, or with any unsupported filter) route to `/all-tasks` with `?state_id=<finished-state-id>` — except we don't know the finished state ID without probing the server. **Drop the route entirely from R07** and revisit in R07.5 when `freelo states list` exists. **For R07, the finished-tasks endpoint is not exposed.** R07 ships with two routes only: `/all-tasks` and `/project/{p}/tasklist/{t}/tasks`. Documented as a known limitation; envelope's `endpoint` discriminator only takes those two values for v1; adding `tasklist-finished-tasks` later is **additive** (the envelope already declares it as a possibility — see §2.3 — and adding a code path that emits it is a `minor` bump).

  → **OPEN QUESTION #4** captures this.
- **Mutually exclusive `--page`/`--all`/`--cursor`.** Standard mutex error (exit 2).
- **`--fields` empty / unknown / nested.** Reuses `projectFields` validation; exit 2.
- **`--fields` valid for one entity-shape but not another.** The route resolves first; the registry for that shape is then used. If the user passed `--project 42 --tasklist 101 --fields state` (state is `task_full`-only), the route resolves to `/project/{p}/tasklist/{t}/tasks` (entity = `task_summary`); validation throws `UNKNOWN_FIELD` because `state` isn't in `TASK_SUMMARY_DEFAULT_FIELDS`. **Mandatory test.**
- **`--label "" ` (empty string).** `ValidationError` (exit 2) — empty label is meaningless.
- **`--label X --label X` (duplicate).** Sent verbatim (`with_labels[]=X&with_labels[]=X`). Server dedupes. Documented; not a bug.
- **Mid-stream pagination error under `--all`.** Same protocol as R03/R05 §5.
- **`--all` interrupted by SIGINT.** R01's abort signal propagates; partial envelope on stdout; exit 130.
- **Server returns wrapper missing `data.tasks` / `data.finished_tasks`.** `FreeloApiError({ code: 'VALIDATION_ERROR' })` from `normalizePaginated`; exit 4.
- **Server returns 401.** `FreeloApiError`-via-AUTH path; exit 3.
- **Server returns 5xx.** `FreeloApiError`; exit 4.
- **Server returns 429 once.** R01's retry-with-backoff handles it transparently. **Mandatory test** for `RateLimitedError` exit code (6) when the budget is exhausted (server returns 429 four times consecutively): test asserts `exitCode === 6` and `error.code === 'RATE_LIMITED'`. (Per Calibration §1: "every typed error class triggered must have a test asserting its exit code".)
- **Network error (no response).** `NetworkError` from R01's HttpClient; exit 5. **Mandatory test** asserting `exitCode === 5` and `error.code === 'NETWORK_ERROR'`.
- **`/all-tasks` returns wrapper `data: { tasks: [...] }` with non-task objects.** Each item validated by `TaskFullSchema`; on failure, `FreeloApiError` (exit 4).
- **URL length under heavy `--label`/`--project` use.** Freelo's server doesn't document a limit. Node + undici's default header/URL limits are >8KB; well above any realistic flag count. Not a v1 concern.

## 6. Non-goals

- **`/tasklist/{id}/finished-tasks` route.** Deferred to R07.5 pending an explicit `--finished` flag design + state-id resolution. (See OQ #4.)
- **`--label` for the `without` magic value.** OpenAPI doesn't document `without` for tasks (only for projects' tags filter). Defer.
- **Multi-value `--without-label`.** OpenAPI exposes only the singular form. (See OQ #5.)
- **`--state` enum mapping by name (e.g. `--state active`).** R07 takes the numeric id verbatim. State-name → id requires a `freelo states list` command (future).
- **Range validation (`--due-from > --due-to`).** Forwarded to server.
- **`--watch` / streaming updates.** Out of scope.
- **`--include-subtasks` / hierarchical traversal.** Out of scope; `parent_task_id` is in the default fields so agents can build their own tree.
- **`--output yaml`.** Existing CLI-wide non-goal.
- **Color coding in human mode.** Boring on purpose.
- **Snapshot caching across invocations.** Every call is a fresh fetch.
- **`tasks show <id>` / `tasks create` / `tasks update`.** Future slices.

## 7. Open questions

> Each line ends with a **Recommendation**. The orchestrator accepts all recommendations as load-bearing decisions for /plan; do not relitigate.

1. **`/project/{p}/tasklist/{t}/tasks` filter passthrough.** OpenAPI documents only `order_by` / `order` for this endpoint. If the user passes `--worker 7 --project 42 --tasklist 101`, do we (a) route to `/all-tasks` to honor `--worker`, or (b) route to the per-tasklist route and silently drop `--worker`? **Recommendation:** (a). Spec §2.2 dispatch tree: any filter the per-tasklist route can't honor forces `/all-tasks`. Silent filter drops are hostile to agents.

2. **`with_label` (deprecated, singular) — never emit.** Per spec §2.5. **Recommendation:** Confirmed. CLI surface is `--label <name>` (repeatable) → `with_labels[]` always. Never emit `with_label`. The merge quirk only matters when both are sent; we never send the singular form.

3. **`buildQuery` location.** New file `src/lib/query.ts`, per the roadmap requirement. Could go in `src/api/tasks.ts` instead. **Recommendation:** Standalone file. Roadmap explicitly names it; future write commands will reuse the same encoding policy; test surface is small and clean to isolate.

4. **`/tasklist/{id}/finished-tasks` route — drop from R07.** §5 walks through why: with the current flag set and without `freelo states list`, the dispatch can't reliably route to this endpoint without ambiguity. **Recommendation (binding for the slice):** Drop. R07 ships with two routes (`/all-tasks`, `/project/{p}/tasklist/{t}/tasks`). The envelope schema already includes `'tasklist-finished-tasks'` and `'task_finished'` as possible discriminator values, so adding the route in R07.5 is a `minor` (additive) bump, not a `major`. Users who want finished tasks today can use `--state <id>` against `/all-tasks` once they know the finished state's numeric id (visible via the existing `state.id` field on any returned task). The CLI doesn't help them find that id; that's the R07.5 problem. The roadmap will need an addendum noting this deferral.

5. **`--without-label` repeatability.** OpenAPI lists only the singular form (:1507). **Recommendation:** Single value only in v1. Marked non-repeatable in §2.1. If a real consumer needs OR-of-without filters, R07.5 can introduce `--without-labels` (plural, repeatable) — additive.

6. **`--state` accepts numeric id only.** §6 Non-goals captures the deferral. **Recommendation:** Numeric only. State-name resolution is its own command (`freelo states list`) and its own slice.

7. **Default `--fields` per entity-shape.** §2.8 picks the full payload. **Recommendation:** Confirmed. `--fields` is the trim-down knob.

8. **Discriminator design — `endpoint` AND `entity_shape`.** §2.3 explains the distinction. **Recommendation:** Confirmed. They answer different agent questions; cost is one extra field; benefit is forward-compat if Freelo ever returns a different shape from the same endpoint based on filters.

9. **`applied_filters` always present, even when `{}`.** **Recommendation:** Confirmed. Saves agents from `if (data.applied_filters)` guards.

10. **`buildQuery` test coverage target.** Single unit-test file with ~10 cases (each encoding rule + edge case). **Recommendation:** Confirmed. Aim ≥95% line coverage on the file (it's <50 lines).

11. **`--all` on the unpaginated route — error or no-op?** R03's precedent is no-op (terminate after one fetch). **Recommendation:** No-op. Documented. Same as R03 `--scope owned --all`.

12. **Per-command meta `outputSchema`.** **Recommendation:** `'freelo.tasks.list/v1'`.

---

**Coverage note for /plan.** Per `vitest.config.ts`: `src/api/**` ≥ 90% lines/statements; `src/commands/**` ≥ 85% branches (server-enforced via branch protection per Calibration §3-5). `src/lib/**` follows the project default (≥ 85% lines). New files needing tests: `src/lib/query.ts` (unit), `src/api/schemas/task.ts` (round-trip via integration), `src/api/tasks.ts` (MSW-driven), `src/commands/tasks/list.ts` (full E2E with all error-path exit-code assertions per Calibration §2).

**Lazy-import discipline.** `cli-table3` and `ora` continue to be `await import(...)`-loaded behind `isInteractive` checks. ESLint's `no-restricted-imports` rule already enforces.

**Rate-limit retry under `--all`.** Each page goes through R01's `HttpClient.request` path; 429s on a single page get jittered backoff (max 3 attempts). The `--all` driver does not add its own retry layer. When the budget is exhausted, the error surfaces via `RateLimitedError` (exit 6) — mandatory test per Calibration §1.

**Summary box for the orchestrator:**

```
ARCHITECT run=2026-04-27-0602-r07-tasks-list status=ok spec=docs/specs/0017-tasks-list.md open_questions=12 new_deps=0
```

---

## 8. Plan

Implementation plan for R07. Reuses R03/R05/R06 infrastructure end-to-end. Three new src files (one of them the shared `src/lib/query.ts`), one new entity-schema file, one new command tree, one new human renderer, one new MSW namespace, one full integration test, two unit tests, fixtures, docs, changeset.

### 8.1 Files to create

| # | Path | Intent |
|---|---|---|
| 1 | `src/lib/query.ts` | `buildQuery(params)` — encodes typed param map into URL query string. Handles repeating arrays (`projects_ids[]=...`), bracketed objects (`due_date_range[date_from]=...`), boolean (true → "true", false → omitted), undefined (omitted). Pure; no deps. ~50 LOC. |
| 2 | `src/api/schemas/task.ts` | Zod schemas: `TaskSummarySchema`, `TaskFullSchema` (extends summary + state/project/tasklist), `TaskFinishedSchema` (extends summary + date_finished/finished_by), `TaskLabelSchema`, `TimeEstimateSchema`, `UserTimeEstimateSchema`. Type exports: `TaskSummary`, `TaskFull`, `TaskFinished`, `TaskEntityShape`, `EndpointKey`, `AppliedFilters`, `TaskListData`. Frozen field registries: `TASK_FULL_DEFAULT_FIELDS`, `TASK_SUMMARY_DEFAULT_FIELDS`, `TASK_FINISHED_DEFAULT_FIELDS`. Imports `UserBasicSchema` from `./project.js`. **Note for R07 implementation:** `TaskFinishedSchema` and the `'tasklist-finished-tasks'` discriminator are declared in the type but the runtime code path is NOT wired in v1 (per spec OQ #4 — deferred to R07.5). The schema declaration is forward-compat scaffolding so R07.5 doesn't bump `/v2`. |
| 3 | `src/api/tasks.ts` | HTTP wrappers — `getAllTasks(client, opts)` and `getTasklistActiveTasks(client, opts)`. **Both wrappers ship in R07.** A `getTasklistFinishedTasks` wrapper is **NOT** in this slice (deferred to R07.5 with the route — keeps the implementation surface honest about what runs in v1). The first wraps `GET /all-tasks?<query>` using `buildQuery` for params; returns `normalizePaginated(raw, 'tasks', TaskFullSchema)`. The second wraps `GET /project/{p}/tasklist/{t}/tasks?<query>` (only `order_by`/`order` if set); returns `synthesizeUnpaginated(parsed)` where parsed is `z.array(TaskSummarySchema).parse(raw.data)`. |
| 4 | `src/commands/tasks.ts` | Parent command. Mirrors `src/commands/tasklists.ts`. Calls `registerList(tasks, getConfig, env)`. |
| 5 | `src/commands/tasks/list.ts` | Leaf command. `meta = { outputSchema: 'freelo.tasks.list/v1', destructive: false }`. Registers all 16 flags (per §2.1, minus `--finished*` since the route is deferred — see §8.5 for the binding flag set). Implements: numeric flag parsers (reuse `parsePositiveIntFlag` / `parseNonNegativeIntFlag` pattern from R05), date flag parser (`parseDateFlag` — strict `YYYY-MM-DD`), variadic int collector (`collectInt(label, hint, raw, prev)`), variadic string collector. Mutex check (`--page`/`--all`/`--cursor`). Mutex check (`--no-due` vs `--due-from`/`--due-to`). Route resolution via `resolveRoute(opts)` — pure helper that returns `{ endpoint, entityShape }` per dispatch tree §2.2. `--search` validation against resolved route. `--fields` validation against the entity-shape registry. Builds `applied_filters` from opts. Dispatches to the right wrapper. Builds envelope. Same `runAll` ndjson/json/human pattern as R05. Mid-stream PartialPagesError handling identical to R05. |
| 6 | `src/ui/human/tasks-list.ts` | Human renderer. `renderTasksListHuman(data, opts?)`. Default columns by `entity_shape` (per §2.7). Reuses `renderTable` from `src/ui/table.ts`. Summarises `worker.fullname` (with fallback to `String(worker.id)` per R05.5 spec 0015 §1), `project.name`, `tasklist.name`, `state.state`, `finished_by.fullname`. Empty list → `(no tasks)` body row. |
| 7 | `test/lib/query.test.ts` | Unit test for `buildQuery`. Covers: empty input → ""; single scalar → "k=v"; array → "k%5B%5D=v1&k%5B%5D=v2"; bracketed object → "k%5Bsub%5D=v"; boolean true/false; undefined; mix of all; integer values; URL-encoded special chars in values. ~10 cases. |
| 8 | `test/lib/route-resolution.test.ts` | Unit test for `resolveRoute(opts)` exported from `src/commands/tasks/list.ts` (or co-located in a small `src/commands/tasks/route.ts` if the implementer prefers — see decision log). Covers each row of the §2.2 dispatch tree. ~6 cases. |
| 9 | `test/commands/tasks/list.test.ts` | Full E2E via `runCli`. Coverage targets per Calibration §2/§4. Test list in §8.3. |
| 10 | `test/fixtures/tasks/all-page0.json` | `PaginatedResponse<TaskFull>`-shaped — 3 items, total=7, per_page=3, page=0. |
| 11 | `test/fixtures/tasks/all-page1.json` | Page 1 — 3 items. |
| 12 | `test/fixtures/tasks/all-page2.json` | Page 2 — 1 item, last page. |
| 13 | `test/fixtures/tasks/all-empty.json` | `PaginatedResponse<TaskFull>` with empty inner array. |
| 14 | `test/fixtures/tasks/tasklist-tasks.json` | Bare array of 2 `TaskSummary` items for `/project/{p}/tasklist/{t}/tasks`. |
| 15 | `docs/commands/tasks-list.md` | User-facing doc. Two examples (agent + human), permissions note, schema reference, list of supported / forbidden filter combinations. |

### 8.2 Files to modify

| # | Path | Edit |
|---|---|---|
| M1 | `test/msw/handlers.ts` | Add `tasksHandlers = { allTasksOk(pages, opts?), allTasksByQuery(matchFn, response), tasklistTasksOk(projectId, tasklistId, items), unauthorized(), serverError(status), rateLimited(), networkError(), allMidStreamError({pages, failPage, status?}), malformedWrapper() }`. Mirrors `tasklistsHandlers`. The `allTasksByQuery` factory inspects the request URL to validate query-string encoding (test #2-style assertions). |
| M2 | `src/bin/freelo.ts` | Add `const { register: registerTasks } = await import('../commands/tasks.js');` and `registerTasks(program, getAppConfig, env);`. One line in each section, mirroring `registerTasklists`. |
| M3 | `docs/getting-started.md` | Append a "Listing tasks" section pointing at `tasks-list.md` (if not present, create the section). |
| M4 | `README.md` | Regenerated by `pnpm fix:readme` after build. The autogen Commands block between markers will pick up `tasks list` from `--introspect`. **No manual edit.** |
| M5 | `.changeset/<random>.md` | New changeset, `freelo-cli: minor`. Title: `feat(commands): add 'freelo tasks list' across /all-tasks and per-tasklist active routes (R07)`. Schema callout: introduces `freelo.tasks.list/v1` envelope with `endpoint` + `entity_shape` discriminators. Mentions deferral of the finished-tasks route (R07.5). |

### 8.3 New dependencies

**None.** Every primitive is already in deps:
- `commander`, `zod` — already in deps.
- `cli-table3` (lazy, via `src/ui/table.ts`) — already used.
- `URLSearchParams` — Node built-in (used inside `buildQuery`).

### 8.4 Test strategy

**Unit-level:**

- `test/lib/query.test.ts` — pure-function tests for `buildQuery`. Aim ≥95% line coverage on the file.
- `test/lib/route-resolution.test.ts` — pure-function tests for the route resolver. ≥95% branch coverage on the resolver function.
- Schema round-trip happens implicitly inside the integration test (parsed once via the wrapper).

**Integration tests** in `test/commands/tasks/list.test.ts`. Same harness as `tasklists/list.test.ts` (`captureOutput`, `runCli`, `parseFirstJson`, `parseAllJson`, conf mock, env-var auth, `vi.doMock('conf', ...)`).

**Required test cases** (each is a `it(...)`, **all must land in this slice** — coverage thresholds are server-enforced):

Happy paths (8):

1. **No flags → /all-tasks page 1.** Asserts envelope `schema === 'freelo.tasks.list/v1'`, `data.endpoint === 'all-tasks'`, `data.entity_shape === 'task_full'`, `data.applied_filters` deep-equals `{}`, `data.tasks.length === 3`, `paging.page === 0`, `paging.next_cursor === 1`, exit 0.
2. **`--project 42 --project 43 --label bug --label p1` → query encoding.** Asserts the request URL contains `projects_ids%5B%5D=42&projects_ids%5B%5D=43` (in order) AND `with_labels%5B%5D=bug&with_labels%5B%5D=p1` AND **does not** contain `with_label=` (singular). Asserts `data.applied_filters.projects deep-equals [42, 43]`, `data.applied_filters.labels deep-equals ['bug', 'p1']`, exit 0.
3. **`--project 42 --tasklist 101` → /project/{p}/tasklist/{t}/tasks (unpaginated).** Asserts `data.endpoint === 'tasklist-tasks'`, `data.entity_shape === 'task_summary'`, `data.tasks.length === 2`, `paging.next_cursor === null`, exit 0.
4. **`--project 42 --tasklist 101 --order-by name --order desc` → forwarded.** Asserts the request URL contains `order_by=name&order=desc`. Asserts `data.applied_filters.order_by === 'name'`, `data.applied_filters.order === 'desc'`.
5. **`--worker 7 --project 42 --tasklist 101` → falls through to /all-tasks.** Per spec OQ #1. Asserts `data.endpoint === 'all-tasks'`, `data.applied_filters.worker === 7`. URL contains `worker_id=7&projects_ids%5B%5D=42&tasklists_ids%5B%5D=101`.
6. **`--all --output json` → merged envelope.** 3 MSW pages. Asserts `data.tasks.length === 7` (3+3+1), `paging.next_cursor === null`.
7. **`--all --output ndjson` → one envelope per page.** Asserts `parseAllJson(stdout).length === 3`, last page's `next_cursor === null`.
8. **`--no-due --output json` → URL contains no_due_date=true.** Asserts `data.applied_filters.no_due === true`.

Date / range / search behaviors (5):

9. **`--due-from 2026-04-01 --due-to 2026-04-30` → URL contains `due_date_range%5Bdate_from%5D=2026-04-01&due_date_range%5Bdate_to%5D=2026-04-30`.** Asserts `data.applied_filters.due_from === '2026-04-01'` and `due_to === '2026-04-30'`.
10. **`--search redesign` → URL contains `search_query=redesign`.** Asserts `data.applied_filters.search === 'redesign'`.
11. **`--state 1` → URL contains `state_id=1`.** Asserts `data.applied_filters.state === 1`.
12. **`--without-label wontfix` → URL contains `without_label=wontfix`.**
13. **`--finished-overdue --tasklist 101` → routes to /all-tasks with `tasklists_ids[]=101&finished_overdue=true`.**

Validation errors (exit 2 — Calibration §2 mandatory) (12):

14. **`--project abc`** → exit 2, `error.code === 'VALIDATION_ERROR'`.
15. **`--project 0`** → exit 2.
16. **`--project -1`** → exit 2.
17. **`--tasklist abc`** → exit 2.
18. **`--worker 0`** → exit 2.
19. **`--page abc`** → exit 2.
20. **`--cursor -1`** → exit 2.
21. **`--page 2 --all` (mutex)** → exit 2, hint mentions "Pick one".
22. **`--no-due --due-from 2026-04-01` (mutex)** → exit 2, hint mentions "Pick either --no-due or".
23. **`--due-from 2026/04/01` (bad format)** → exit 2, hint mentions "YYYY-MM-DD".
24. **`--due-from 2026-13-01` (invalid date)** → exit 2.
25. **`--search redesign --project 42 --tasklist 101` (search forbidden on per-tasklist active route)** → exit 2, hint mentions "drop --project to use /all-tasks, or drop --search".

Field projection errors (3):

26. **`--fields ''`** → exit 2 via `EMPTY_FIELDS`.
27. **`--fields foo`** → exit 2 via `UNKNOWN_FIELD`.
28. **`--fields state` against per-tasklist active route (entity = `task_summary`, no `state` field)** → exit 2 via `UNKNOWN_FIELD`. Asserts the error message lists `task_summary` field set.

HTTP error paths (5 — one per typed error class per Calibration §1):

29. **401** → exit 3 (`AUTH_ERROR`).
30. **5xx** → exit 4 (`SERVER_ERROR` / `FREELO_API_ERROR`).
31. **429 four times in a row (budget exhausted)** → exit 6, `error.code === 'RATE_LIMITED'`. **Calibration §1 — `RateLimitedError` exit code MUST be asserted.**
32. **Network error (no response)** → exit 5, `error.code === 'NETWORK_ERROR'`. **Calibration §1 — `NetworkError` exit code MUST be asserted.**
33. **Malformed wrapper (server returns `data: {}` missing `tasks` key)** → exit 4, `FreeloApiError` with code `VALIDATION_ERROR`.

Mid-stream `--all` errors (2):

34. **First-page error during `--all` (no `PartialPagesError` wrapper).** Underlying error surfaces directly; exit 4.
35. **Mid-stream error during `--all` (json mode)** → partial envelope on stdout (with `notice: 'Partial result; iteration aborted at page N.'`), error envelope on stderr, exit follows underlying class (4 for FreeloApiError).

**Total:** 35 test cases. Each error-path test asserts the exit code (Calibration §2). Each typed error class triggered (`ValidationError`, `FreeloApiError`, `NetworkError`, `RateLimitedError`) has at least one test (Calibration §1).

**Coverage targets (server-enforced — Calibration §3-5):**

- `src/api/**` ≥ 90% lines/statements. New files `src/api/tasks.ts` and `src/api/schemas/task.ts` are covered by tests #1-13 and #29-35.
- `src/commands/**` ≥ 85% branches. New file `src/commands/tasks/list.ts` will have 1 outer try/catch + 1 mid-stream try/catch (mirrors R05). Both arms covered by tests #29-35. **Implementer MUST grep its diff for `catch (` introductions and verify each arm has a matching test before declaring implement done — Calibration §4.**
- `src/lib/**` ≥ 85% lines (project default). `src/lib/query.ts` covered by `test/lib/query.test.ts`.

### 8.5 Binding flag set for v1

Per OQ #4 the `/tasklist/{id}/finished-tasks` route is deferred to R07.5. The CLI **still registers all 16 flags from §2.1** to keep the public surface stable across slices, but:

- `--finished-overdue`, `--finished-from`, `--finished-to`: these are **`/all-tasks`-only** in v1. They never route to `/tasklist/{id}/finished-tasks`. The dispatch tree has only two leaves: `/all-tasks` and `/project/{p}/tasklist/{t}/tasks`.

The CLI does not error when these flags are passed; they just always force `/all-tasks` (which does support them). The deprecated route is reachable via `--state <finished-state-id>` once the user knows the id (visible on any returned `state.id` field).

If the implementer disagrees with the flag-set decision (e.g. wants to drop `--finished-from`/`--finished-to` from v1 entirely until R07.5), **pause** — flag set is the public contract.

### 8.6 Commit slicing

Three commits. Each must independently pass `pnpm typecheck && pnpm lint && pnpm test && pnpm build` on the committed tree. `pnpm check:readme` runs once on the final tree (Calibration §3).

| # | Conventional commit | Files | Why this slice |
|---|---|---|---|
| C1 | `feat(lib): add buildQuery helper for repeating-array URL params` | files 1, 7 (`src/lib/query.ts`, `test/lib/query.test.ts`) | Pure additive; types/encoding/tests. Compiles and tests standalone. **First commit on its own — green typecheck + lint + test.** |
| C2 | `feat(api): add task schemas and HTTP wrappers (R07)` | files 2, 3 + M1 (`src/api/schemas/task.ts`, `src/api/tasks.ts`, MSW handlers). Plus the route-resolution helper if extracted (decision-log entry will note in/out). | Schema + wrappers + handlers. Compiles standalone (no command yet). No tests dedicated to these files — coverage comes through C3's E2E. |
| C3 | `feat(commands): add 'freelo tasks list' (R07)` + `docs(commands): document tasks list (R07)` + `test(commands): cover tasks list (R07)` + tests + docs + changeset | files 4, 5, 6, 8, 9, 10-15 + M2, M3, M4, M5 | Wires the full command, ships docs, regenerates README, locks in coverage and the autogen README block. |

Single-PR delivery, three commits. If C2's typecheck fails (likely the only risk: `meta.outputSchema` literal-type mismatch with `attachMeta`, or `TaskFullSchema = TaskSummarySchema.and(...)` discriminator surprise), retry once with fix. If still red, halt and pause.

### 8.7 Risks and mitigations

| Risk | Mitigation |
|---|---|
| Route-resolution logic gets complex, tests miss a combination | Extract `resolveRoute(opts): { endpoint, entityShape, page? }` as a pure exported function. Unit-test each row of the dispatch tree. |
| `buildQuery` URL encoding differs from what Freelo actually expects | Test #2 asserts the exact encoded string in the request URL via MSW. If real-API behavior disagrees later, the encoding rule changes (additive — same envelope shape). |
| `with_label` (singular) accidentally emitted | Test #2 explicitly asserts the URL does NOT contain `with_label=`. Belt-and-suspenders. |
| `--fields` against per-tasklist route picks the wrong registry | Test #28 covers this exact case. |
| Coverage drop on `src/commands/**` | The leaf command's branch coverage is the risk; structure error branches so each is reachable from a single targeted test. Tests #29-35 cover all error branches. |
| `applied_filters` shape drift | Snapshot test on the JSON envelope for one happy path (test #2) catches this. |
| Schema drift at runtime (Freelo adds a field to `TaskFull`) | `.passthrough()` on entity schemas absorbs additions. Same posture as R03/R05/R06. |

### 8.8 Out of scope (re-stated for /implement)

Per spec §6:

- `/tasklist/{id}/finished-tasks` route (deferred to R07.5).
- Multi-value `--without-label`.
- `--label` with `without` magic value.
- Range validation (`--due-from > --due-to`).
- `--state <name>` resolution.
- Snapshot caching.
- `--watch` / streaming.
- YAML output.
- Color-coded human output.

### 8.9 Acceptance criteria

- All 35 test cases pass.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme` clean on the final committed tree.
- Coverage thresholds in `vitest.config.ts` not regressed.
- `freelo --introspect` includes `tasks list` with the expected flag set.
- `freelo tasks list --help` is self-documenting (mentions all 16 flags + the route deferral note for `--finished-*`).
- Changeset captures the new `freelo.tasks.list/v1` envelope as a public schema commitment.
- `data.endpoint`, `data.entity_shape`, `data.applied_filters` discriminator + filter-echo are present in every emitted envelope.

```
ARCHITECT phase=plan run=2026-04-27-0602-r07-tasks-list status=ok files=20 commits=3 new_deps=0
```
