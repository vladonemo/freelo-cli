# 0014 — `freelo tasklists list` (R05)

**Status:** Accepted — all 7 §7 recommendations adopted 2026-04-26; ready for /plan
**Run:** 2026-04-26-1537-r05-tasklists-list
**Owner:** orchestrator (architect role)
**Tier:** **Yellow** — additive: new public command, new envelope schema, new entity schema. No infra changes; reuses R03's pagination, `--page`/`--all`/`--cursor`, `--fields`, and `cli-table3` renderer wholesale. No auth / config / HTTP / release-tooling impact. No new runtime dependencies.

---

## 1. Problem

After R03 (`projects list`) and R04 (`projects show <id>`), the CLI can answer "what projects exist" and "what's inside one project". The next read-essential gap is "what tasklists exist" — both scoped to a single project (the most common workflow: open a project, browse its phases) and across all projects (cross-project reporting, picker building).

R05 fills that hole with **one new command, one new envelope schema, zero new infrastructure**. Every primitive R05 needs (pagination, projection, `--page`/`--all`/`--cursor` semantics, table renderer, lazy `cli-table3`, `fetchAllPages` driver, `PartialPagesError` mid-stream protocol) is already in `src/api/pagination.ts` and `src/ui/table.ts` from R03. R05 adds:

1. A `tasklists` parent command (`src/commands/tasklists.ts`).
2. A `list` leaf command (`src/commands/tasklists/list.ts`).
3. A `Tasklist` entity schema (`src/api/schemas/tasklist.ts`).
4. An HTTP wrapper for `/all-tasklists` (`src/api/tasklists.ts`).
5. A human renderer (`src/ui/human/tasklists-list.ts`).
6. A `freelo.tasklists.list/v1` envelope schema as a public, agent-pinnable contract.

R05's user-visible deliverable: `freelo tasklists list [--project <id>] [--page N|--all|--cursor <n>]` returns tasklists across the caller's accessible projects, optionally narrowed to one project, with the same paging/projection/output-mode semantics R03 set as precedent.

## 2. Proposal

### 2.1 Subcommand signature

```
freelo tasklists list [--project <id>]
                      [--page N | --all | --cursor <n>]
                      [--fields a,b,c]
```

Hangs off a new `freelo tasklists` parent (`src/commands/tasklists.ts`), mirroring `src/commands/projects.ts`. Inherits the same global flags: `--output`, `--color`, `--profile`, `-v/-vv`, `--request-id`, `-y/--yes` (unused — read-only command, no destructive op).

| Flag | Type / values | Default | Purpose |
|---|---|---|---|
| `--project <id>` | int >= 1 | unset | Filter to tasklists in this single project. When unset, lists tasklists across all projects the caller can see. See §2.2. |
| `--page <N>` | int >= 1 (1-indexed for the user) | unset | Single-page fetch. Mapped to `?p=N-1` on the wire (Freelo is 0-indexed). Mutually exclusive with `--all` and `--cursor`. |
| `--all` | boolean | `false` | Client-side iterates pages until `nextCursor === null`. Mutually exclusive with `--page` / `--cursor`. |
| `--cursor <n>` | int >= 0 (0-indexed; matches `paging.next_cursor`) | unset | Fetches a single page at cursor `n`. Designed for agent round-trip: read `next_cursor` from a previous envelope, pass it back. Mutually exclusive with `--page` / `--all`. |
| `--fields <list>` | comma-separated string | unset (full default field set per §2.7) | Projects each record down to the listed snake_case keys before rendering. |

When none of `--page` / `--all` / `--cursor` is given: fetches **page 1** (i.e. `?p=0`) and returns it; envelope's `paging.next_cursor` indicates whether more pages exist. This is the agent-friendly default — one round-trip per invocation, agent decides whether to follow the cursor. Same as R03.

**Mutual exclusion** is enforced at parse time. Two of the three set → `ValidationError({ code: 'VALIDATION_ERROR', exitCode: 2, hintNext: "Pick one of --page, --all, or --cursor." })`.

**`--project` validation** runs **before** any HTTP call. Non-integer, zero, or negative values → `ValidationError` (exit 2), **never** Commander's `InvalidArgumentError` (which exits 1 — see Calibration §1-2). Mirror R04's `parseProjectId` pattern in `src/commands/projects/show.ts:35-47`.

**Per-command `meta`** (consumed by the introspector):

```ts
export const meta = { outputSchema: 'freelo.tasklists.list/v1', destructive: false } as const;
```

### 2.2 `--project` to endpoint mapping

| `--project` | Endpoint | Inner data key | Entity | Notes |
|---|---|---|---|---|
| **unset** *(default)* | `GET /all-tasklists?p=N` | `tasklists` | `TasklistFull` | Lists all tasklists visible to the caller across all projects. |
| **`<id>`** | `GET /all-tasklists?projects_ids[]=<id>&p=N` | `tasklists` | `TasklistFull` | Filters server-side by project. |

**Single endpoint backs both modes.** This deviates from the roadmap's nominal endpoint list — see Open Question #1 (load-bearing). The OpenAPI spec only documents `POST /project/{project_id}/tasklists`; there is no `GET` operation on that path (`docs/api/freelo-api.yaml:1140-1178`). `/all-tasklists` accepts `projects_ids[]` (`:1198-1203`) for server-side filtering, which fully implements the user-facing "filter to one project" outcome with documented endpoints.

**No discriminator.** Unlike R03 (which has two entity shapes — `ProjectWithTasklists` and `ProjectFull` — and uses an `entity_shape` discriminator), R05 returns one entity shape (`TasklistFull`) for both modes. The envelope's `data` carries a `scope` field (`'project' | 'all'`) for round-trip clarity, but no `entity_shape` field.

### 2.3 Envelope shape — `freelo.tasklists.list/v1`

```jsonc
{
  "schema": "freelo.tasklists.list/v1",
  "data": {
    "scope":          "project" | "all",        // round-trip of --project presence
    "project_id":     42 | null,                // null when scope === 'all'
    "tasklists":      [ /* TasklistFull items, see §4 */ ]
  },
  "paging": {
    "page":        0,    // 0-indexed, mirroring Freelo's wire format
    "per_page":    25,   // server-discovered
    "total":       137,
    "next_cursor": 1     // null on last page
  },
  "rate_limit": { "remaining": 42, "reset_at": "2026-04-25T18:30:00Z" },
  "request_id": "..."
}
```

**Why `data` is an object, not a bare array.** Same three reasons as R03 §2.3:

1. The `scope` round-trip needs a home next to the data.
2. `project_id` echoes back what the caller passed (or `null` when no filter).
3. Future fields (e.g. echoed `applied_filters` when R05.5 adds `--order-by`/`--order`) have a place to land without a v2 bump.

**Field naming:** snake_case throughout, matching what the Freelo API emits. Wire-format `date_add` (not `created_at`); `real_minutes_spent` (not `minutesSpent`). One naming convention per envelope.

**Paging always present.** Even though `/all-tasklists` is always paginated and never bare, we keep `paging` as a top-level field for envelope-shape uniformity with R03 (`freelo.projects.list/v1`). Agents do not have to special-case "is `paging` defined" per command.

### 2.4 Pagination semantics

Identical to R03 §2.4. Three switches; one wins per invocation. None set ≡ `--page 1`.

#### `--page N` (single page)

- User-facing 1-indexed; mapped to `?p=N-1` on the wire.
- Returns one envelope. `paging.page` is `N-1`. `paging.next_cursor` is `N` if `N * per_page < total`, else `null`.
- `--page 99` past the last page returns `tasklists: []`, `paging.next_cursor: null`. Exit 0.

#### `--cursor <n>` (single page, agent round-trip form)

- 0-indexed integer; the value an agent reads from a previous envelope's `paging.next_cursor`.
- Equivalent to `--page n+1` in effect. Designed so an agent's loop is `while (cursor !== null) { call --cursor cursor; cursor = response.paging.next_cursor }`.
- `--cursor 0` is valid (fetches the first page).
- No special-case for `--project` — it stacks orthogonally (`--project 42 --cursor 1` calls `?projects_ids[]=42&p=1`).

#### `--all` (client-side iteration)

Iterates `?p=0`, `?p=1`, ... until `nextCursor === null`.

| Output mode | Behavior |
|---|---|
| `json` (incl. `auto`-resolved-to-json) | One **merged** envelope: `data.tasklists` is the concatenation of all pages; `paging.page = total_pages - 1`, `paging.per_page = server-reported`, `paging.total = server-reported`, `paging.next_cursor = null`. Server order preserved across pages. |
| `ndjson` | One envelope **per page**. Each line is a complete `freelo.tasklists.list/v1` envelope. (Same per-page granularity as R03 — agents resume from `paging.next_cursor` on partial failure.) |
| `human` | Single table; pages fetched silently and concatenated. Spinner allowed in human-mode only when stdout is a TTY (lazy `ora`). |

**Mid-stream `--all` error policy:** Same as R03 §5 — the partial accumulated envelope is emitted to stdout (with `notice: "Partial result; iteration aborted at page N."`), then the underlying error is surfaced to stderr; `paging.next_cursor` in the partial envelope points at the page that failed. Exit follows the underlying error class (4 for `FreeloApiError`, 5 for `NetworkError`, 6 for `RateLimitedError`).

**`--project <id>` × `--all`:** standard. The driver sends `?projects_ids[]=<id>&p=0`, `?projects_ids[]=<id>&p=1`, ..., merges. No special case.

#### Default (no flag)

Equivalent to `--page 1`. Returns one envelope. Agent reads `paging.next_cursor`; if non-null, pages with `--cursor`.

### 2.5 `--fields` projection

Comma-separated snake_case keys. Applied at the envelope-builder layer, **before** rendering — so json/ndjson/human all see the same subset. Reuses `projectFields` (from `src/api/pagination.ts`) which already throws `ValidationError` for `EMPTY_FIELDS`, `UNKNOWN_FIELD`, `NESTED_FIELDS_UNSUPPORTED` with the spec-defined `hintNext`.

The valid-fields list comes from a per-scope registry in the new `src/api/schemas/tasklist.ts` file (mirrors `DEFAULT_FIELDS` in `project.ts`). For R05, both scopes (`'project'` and `'all'`) share the same field set — the entity is identical.

```bash
# default (no --fields) — full TasklistFull payload
freelo tasklists list

# explicit projection
freelo tasklists list --fields id,name,project,date_add

# unknown field → ValidationError exit 2
freelo tasklists list --fields foo
```

The `projectFields` helper's `scopeForMessage` parameter is reused; for tasklists, pass `'tasklist'` (string used only in error wording). The `hintNext` it produces still says "Run 'freelo projects list --output json' once..." — that's a copy-paste leak from R03 in the helper. **Decision:** leave it for now, fix in a follow-up. `freelo --introspect` is mentioned in the same hint and works for any command, so the user gets the right path. Open Question #5 captures this.

### 2.6 `human`-mode rendering

Lazy `cli-table3` via the existing `src/ui/table.ts` (no new file). Default columns when no `--fields`:

- `id`, `name`, `project`, `date_add`, `state`

The `project` column summarises to `project.name` (mirrors how R03's human renderer summarises `client` → name). State summarises to `state.state` string.

Column policy (inherits R03 §2.6):
- Name column capped at 40 chars with `…` truncation suffix.
- Other columns auto-size.
- Date formatting: ISO-8601 verbatim. No relative dates.
- Empty list: header row + `(no tasklists)` body row.
- No color on data values.
- Spinner: optional in human mode under `--all` only (lazy `ora`); never attached in non-TTY.

### 2.7 Default `--fields` (when none given)

Both scopes share the same field set since the entity is identical:

```
id, name, date_add, date_edited_at, state, project, real_minutes_spent, budget, real_cost
```

Default `--fields` are full-payload. `--fields` is the **trim down** knob, not the **opt-in** knob.

### 2.8 Examples

**Agent-style (env auth, json out, default scope):**

```bash
$ FREELO_API_KEY=sk-... FREELO_EMAIL=agent@acme.cz freelo tasklists list --output json
{"schema":"freelo.tasklists.list/v1","data":{"scope":"all","project_id":null,"tasklists":[{"id":101,"name":"Backlog","project":{"id":42,"name":"Site redesign","state":{"id":1,"state":"active"}},"date_add":"2026-01-15T10:00:00+01:00","state":{"id":1,"state":"active"},"real_minutes_spent":120}]},"paging":{"page":0,"per_page":25,"total":137,"next_cursor":1},"rate_limit":{"remaining":99,"reset_at":"2026-04-25T18:30:00Z"},"request_id":"..."}
$ echo $?
0
```

**Agent-style, scoped to a project:**

```bash
$ freelo tasklists list --project 42 --output json
{"schema":"freelo.tasklists.list/v1","data":{"scope":"project","project_id":42,"tasklists":[/* tasklists in project 42 */]},"paging":{"page":0,"per_page":25,"total":7,"next_cursor":null},"rate_limit":{...},"request_id":"..."}
```

**Agent-style, full sweep with `--all` + ndjson:**

```bash
$ freelo tasklists list --all --output ndjson
{"schema":"freelo.tasklists.list/v1","data":{"scope":"all","project_id":null,"tasklists":[/*page 0*/]},"paging":{"page":0,"per_page":25,"total":137,"next_cursor":1},"rate_limit":{...},"request_id":"..."}
{"schema":"freelo.tasklists.list/v1","data":{"scope":"all","project_id":null,"tasklists":[/*page 1*/]},"paging":{"page":1,"per_page":25,"total":137,"next_cursor":2},"rate_limit":{...},"request_id":"..."}
... (one envelope per page)
{"schema":"freelo.tasklists.list/v1","data":{"scope":"all","project_id":null,"tasklists":[/*last page*/]},"paging":{"page":5,"per_page":25,"total":137,"next_cursor":null},"rate_limit":{...},"request_id":"..."}
```

**Human (TTY), default scope:**

```
$ freelo tasklists list
ID    NAME                                       PROJECT          DATE_ADD                  STATE
101   Backlog                                    Site redesign    2026-01-15T10:00:00+01:00 active
102   Sprint 1                                   Site redesign    2026-02-01T09:00:00+01:00 active
```

**Error: `--project abc` (non-numeric):**

```bash
$ freelo tasklists list --project abc --output json
{"schema":"freelo.error/v1","error":{"code":"VALIDATION_ERROR","message":"--project must be a positive integer.","http_status":null,"request_id":"...","retryable":false,"hint_next":"--project is the numeric project id from `freelo projects list`.","docs_url":null}}
$ echo $?
2
```

**Error: `--project 0`:**

```bash
$ freelo tasklists list --project 0 --output json
$ echo $?
2
```

**Error: mutually exclusive flags:**

```bash
$ freelo tasklists list --page 2 --all --output json
{"schema":"freelo.error/v1","error":{"code":"VALIDATION_ERROR","message":"Flags --page, --all, and --cursor are mutually exclusive."}}
$ echo $?
2
```

**Error: 401 from the API (R01-shaped):**

```bash
$ FREELO_API_KEY=bad freelo tasklists list --output json
{"schema":"freelo.error/v1","error":{"code":"AUTH_ERROR","message":"Authentication failed.","http_status":401,...}}
$ echo $?
3
```

## 3. API surface

One endpoint. GET. Basic auth (R01 already wires this via `HttpClient`). Cited line numbers refer to `docs/api/freelo-api.yaml`.

| # | Endpoint | OpenAPI lines | Wrapper | Inner key | Entity |
|---|---|---|---|---|---|
| 1 | `GET /all-tasklists` | :1180-1233 | `PaginatedResponse` (:4814-4824) | `data.tasklists[]` | `TasklistFull` (:5065-5090) |

**Pagination wire format** (same as R03 §3): `{ total, count, page, per_page, data: { tasklists: [...] } }`. Page parameter `?p=<int>`, 0-indexed.

**Filter:** `projects_ids[]=<int>` query param (`:1198-1203`), repeating for multiple. R05 sends a single `?projects_ids[]=<id>` when `--project <id>` is set. Multi-project filter is **deferred** to R05.5.

**Endpoint-specific filters out of scope for R05:**

- `order_by` (enum: `name | date_add | date_edited_at`, default `date_add`) — :1204-1209
- `order` (enum: `asc | desc`, default `asc`) — :1210-1215
- multi-`projects_ids[]`

R05 passes none of these. Server defaults apply: `date_add asc` (per :1195 description). When R05.5 lands, the envelope's `data` gains an optional `applied_filters` field (additive, minor bump).

**Auth.** Standard Basic auth from R01.

**Rate limits.** R01's headers parser captures `RateLimit-Remaining` / `RateLimit-Reset`. The envelope's `rate_limit` field carries the **last page's** values when `--all` is used.

**Roadmap deviation.** The roadmap (`docs/roadmap.md:141`) names `GET /project/{project_id}/tasklists` as one of the two endpoints. **That endpoint is not in the OpenAPI spec** — only `POST /project/{project_id}/tasklists` is documented (`:1140-1178`). R05 implements the user-facing outcome (filter to one project) via `?projects_ids[]=<id>` on `/all-tasklists`. See Open Question #1.

## 4. Data model

### 4.1 `src/api/schemas/tasklist.ts` (new)

Zod schemas for `TasklistFull` and the envelope `data` shape. Mirrors the structure of `src/api/schemas/project.ts`.

```ts
import { z } from 'zod';

const StateSchema = z.object({
  id: z.number().int(),
  state: z.enum(['active', 'archived', 'finished', 'deleted', 'template']),
});

const CurrencySchema = z.object({
  amount: z.string(),
  currency: z.enum(['CZK', 'EUR', 'USD']),
});

const ProjectRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    state: StateSchema.nullable().optional(),
  })
  .passthrough();

/**
 * `TasklistFull` per OpenAPI :5065-5090. Only `id` and `name` are universally
 * required (inherited from TasklistBasic). Every extension field is optional;
 * matches R03's posture of trusting `id` + `name` and validating the rest only
 * when present.
 *
 * `.nullable().optional()` on every optional field — Freelo treats null and
 * absent interchangeably (same convention as project.ts).
 */
export const TasklistFullSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    date_add: z.string().nullable().optional(),
    date_edited_at: z.string().nullable().optional(),
    state: StateSchema.nullable().optional(),
    project: ProjectRefSchema.nullable().optional(),
    real_minutes_spent: z.number().int().nullable().optional(),
    budget: CurrencySchema.nullable().optional(),
    real_cost: CurrencySchema.nullable().optional(),
  })
  .passthrough();

export type TasklistFull = z.infer<typeof TasklistFullSchema>;

/**
 * Envelope `data` shape. No discriminator — single entity shape across both
 * scopes. Agents read `data.scope` and `data.project_id` for round-trip.
 */
export const TasklistListDataSchema = z.object({
  scope: z.enum(['project', 'all']),
  project_id: z.number().int().nullable(),
  tasklists: z.array(TasklistFullSchema),
});

export type TasklistListData = z.infer<typeof TasklistListDataSchema>;

/**
 * Default `--fields` registry. Both scopes share the same field set since
 * the entity is identical. Frozen so accidental mutation throws.
 */
export const TASKLIST_DEFAULT_FIELDS: readonly string[] = Object.freeze([
  'id',
  'name',
  'date_add',
  'date_edited_at',
  'state',
  'project',
  'real_minutes_spent',
  'budget',
  'real_cost',
]);
```

`.passthrough()` retains forward-compat with future Freelo additions, same posture as R03's project schemas.

### 4.2 `src/api/tasklists.ts` (new)

One HTTP wrapper.

```ts
import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';
import { TasklistFullSchema, type TasklistFull } from './schemas/tasklist.js';
import { type NormalizedPage, normalizePaginated } from './pagination.js';

export type FetchTasklistsOpts = {
  signal?: AbortSignal;
  requestId?: string;
  /** 0-indexed page; mapped to `?p=N` on the wire. */
  page: number;
  /** When set, filter to one project via `?projects_ids[]=<id>`. */
  projectId?: number;
};

export type TasklistsListResult<T> = {
  page: NormalizedPage<T>;
  raw: ApiResponse<unknown>;
};

/**
 * `GET /all-tasklists` — paginated; inner key `tasklists`. Optional
 * `?projects_ids[]=<id>` filter.
 */
export async function getAllTasklists(
  client: HttpClient,
  opts: FetchTasklistsOpts,
): Promise<TasklistsListResult<TasklistFull>> {
  const params = new URLSearchParams();
  params.set('p', String(opts.page));
  if (opts.projectId !== undefined) {
    params.append('projects_ids[]', String(opts.projectId));
  }
  const raw = await client.request({
    method: 'GET',
    path: `/all-tasklists?${params.toString()}`,
    schema: z.unknown(),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  const page = normalizePaginated(raw.data, 'tasklists', TasklistFullSchema);
  return { page, raw };
}
```

**Reuses `normalizePaginated` from `src/api/pagination.ts:50-75`** — wrapper shape is identical to R03's paginated endpoints. No new pagination primitive.

### 4.3 Envelope shape recap

Reusing R01's `Envelope<T>` from `src/ui/envelope.ts`:

```ts
type TasklistsListEnvelope = Envelope<TasklistListData>;
// schema:    'freelo.tasklists.list/v1'
// data:      TasklistListData
// paging:    Paging (always present; next_cursor: null on last page)
// rate_limit: from last fetched page
// request_id: from --request-id or generated
```

## 5. Edge cases

- **`--page N` past the last page.** Server returns wrapper with `data: { tasklists: [] }`. Envelope emits `tasklists: []`, `paging.next_cursor: null`. Exit 0.
- **`--cursor n` past `total`.** Same as above — empty page, `paging.next_cursor: null`. Exit 0.
- **Empty result set.** `tasklists: []`, `paging.total: 0`, `paging.next_cursor: null`. Exit 0.
- **`--project <id>` for a project the caller can't see.** Per OpenAPI `:1193-1194`, ACL filtering returns 200 with `tasklists: []`. Exit 0. This is the **expected** behavior; the CLI does not pre-check that the project exists. (See Open Question #2.)
- **`--project <id>` for a non-existent project.** Per `/all-tasklists`'s ACL-filtered nature, most likely 200-empty (same as ACL-blocked). If Freelo ever returns 404 for this, the existing `FreeloApiError` path handles it (exit 4). **Documented as: "an empty result set is the contract; non-existent and ACL-filtered are indistinguishable."**
- **`--project abc` (non-numeric).** `ValidationError` exit 2 with hint "--project is the numeric project id from `freelo projects list`." Validated **before** any HTTP call. **Test case mandatory.**
- **`--project 0` / negative.** `ValidationError` exit 2. Validated **before** any HTTP call. **Test case mandatory.**
- **`--project` parser throws Commander's `InvalidArgumentError`.** **Forbidden** — falls through to exit 1 instead of the spec-mandated exit 2. Use `ValidationError` only. (See Calibration §1-2.)
- **Mutually exclusive `--page`/`--all`/`--cursor`.** Two or more set → `ValidationError` exit 2.
- **`--fields` empty / unknown / nested.** Reuses R03's `projectFields` validation; throws `ValidationError` with the existing `EMPTY_FIELDS` / `UNKNOWN_FIELD` / `NESTED_FIELDS_UNSUPPORTED` codes and `hintNext` strings.
- **Mid-stream pagination error under `--all`.** Same protocol as R03 §5: partial envelope on stdout (with `notice`), error envelope on stderr; exit code follows the underlying error class. `paging.next_cursor` in the partial envelope points at the failed page.
- **`--all` interrupted by SIGINT mid-iteration.** R01's abort signal propagates through `fetchAllPages`. Partial accumulated envelope emitted as in "mid-stream pagination error" above; exit 130.
- **Server returns wrapper missing `data.tasklists` key.** Zod fails validation in `normalizePaginated` → `FreeloApiError({ code: 'VALIDATION_ERROR' })`, exit 4. No silent fallback.
- **Server returns `count !== data.tasklists.length`.** Trust `data.tasklists.length` for items; trust wrapper's `total` for `next_cursor` math. Same as R03's `normalizePaginated` behavior (`pagination.ts:65-67`).
- **`per_page` differs across pages under `--all`.** Same as R03 — driver doesn't assume stability; iteration uses each page's reported `per_page` to compute `next_cursor`.
- **Concurrent modifications during `--all`.** Server ordering may shift; same project's tasklist may appear twice or be missed. Documented; not a bug.
- **`--output ndjson` with `--page 1` (single page).** One envelope on stdout, identical to `--output json` modulo trailing newline policy.

## 6. Non-goals

Explicitly deferred to follow-up slices:

- **Filter flags beyond `--project <id>`.** `--order-by`, `--order`, multi-`--project <id> --project <id2>` — all deferred to **R05.5**. R05 ships listing + single-project filter + pagination + projection. The envelope's `data` shape will gain optional `applied_filters` then; that addition is additive (minor bump).
- **`--page-size <n>` knob.** Server controls `per_page`; no client tuning in v1.
- **`--scope` flag**. R03 uses `--scope` to dispatch among five endpoints; R05 has only one endpoint, so `--project` (a filter) is the only relevant axis.
- **Color coding state values in human mode.** Boring on purpose.
- **Relative dates.** Defer until a real consumer asks.
- **Nested-field projection (`--fields project.name`).** Defer; same reason as R03.
- **`--watch` mode.** Out of scope.
- **YAML output mode.** Existing CLI-wide non-goal.
- **`tasklists show <id>`.** R06.
- **Filter by tasklist state (active/archived/finished).** No documented state filter on `/all-tasklists`. Defer to R05.5 if it turns out the API supports it via undocumented param; until then, results include all states.
- **Caching.** Every invocation is a fresh fetch.
- **Friendlier hint when `--fields` lists `state` or `project` but the user wants nested fields.** Spec §2.5 leaves the hint as-is; OQ #5 captures the copy-paste leak from R03.

## 7. Open questions

> **Resolution (2026-04-26):** All 7 recommendations below were accepted by the human gate. The planner treats every "Recommendation:" as a load-bearing decision; do not relitigate.

> Each line ends with a **Recommendation**. When the human accepts "all OQs as recommended", the spec is internally consistent and /plan can proceed.

Items 1–3 originate from the API specialist's research. Items 4–7 are CLI/envelope design choices.

1. **Roadmap names a non-existent endpoint.** `docs/roadmap.md:141` lists `GET /project/{project_id}/tasklists`. The OpenAPI spec only documents `POST` on that path (`docs/api/freelo-api.yaml:1140-1178`). Three options: (a) implement via `/all-tasklists?projects_ids[]=<id>` and document the deviation; (b) pause and ask human to confirm an undocumented endpoint exists; (c) try the path optimistically and fall back to (a) on 404 — adds unobservable complexity. **Recommendation:** (a). `/all-tasklists?projects_ids[]=<id>` fully implements the user-facing outcome with documented endpoints. ACL filtering (`:1193-1194`) ensures the same per-project visibility a hypothetical `/project/{id}/tasklists` would have. Document the deviation in §3 and the user-facing docs page. If a real undocumented endpoint exists with materially different semantics (e.g. richer entity or no ACL filter), R05.5 can add it without a v2 envelope bump (the entity shape is the same).

2. **Behavior when `--project <id>` names a non-existent project.** OpenAPI doesn't say. ACL filtering implies 200-empty is most likely. **Recommendation:** trust 200-empty as the contract. Document as: "an empty result set is indistinguishable from 'project doesn't exist' or 'caller can't see it'." If Freelo ever returns 404 for `/all-tasklists?projects_ids[]=<bad>`, the existing `FreeloApiError` path handles it (exit 4). No CLI-side pre-check.

3. **`order_by` / `order` / multi-project filter.** Documented and out-of-scope. **Recommendation:** Defer to R05.5. R05 sends server defaults (`date_add asc`). Documented in §6. Adding flags later is additive.

4. **Default `--fields` set.** §2.7 picks the full `TasklistFull` payload. Alternative: trim to `id, name, project, date_add, state` only. **Recommendation:** Full payload, matching R03's "agents typically want everything" precedent. `--fields` is the trim-down knob.

5. **`projectFields` `hintNext` mentions `freelo projects list`.** The helper in `src/api/pagination.ts:212-215` is hardcoded to project the user toward "Run 'freelo projects list --output json' once to see the full envelope". When R05 reuses `projectFields`, the hint will tell tasklist users to run `projects list`. **Recommendation:** Leave it for now — `freelo --introspect` is mentioned in the same hint and works for any command. Capture as a refactor in a follow-up cleanup (rename `projectFields` to `projectRecordFields`, parameterize the example command). Cost of fixing in R05: 4 unrelated test files would need touching; risk of fixing it: zero, but pulls scope out of this slice. Same reason `parsePositiveInt` in `src/commands/projects/list.ts` still throws `InvalidArgumentError` despite Calibration §1-2 — pre-existing, fix in a sweep.

6. **`scope` field name in envelope.** R03 uses `data.scope: 'owned' | 'invited' | ... | 'all'` for the five-way endpoint dispatch. R05 uses `data.scope: 'project' | 'all'` for a two-way mode. Consistent name, different semantics. Alternative: omit `data.scope` entirely and infer from `project_id !== null`. **Recommendation:** Keep `data.scope`. Two reasons: (1) explicit > inferred for agent UX; (2) consistent field name across all `freelo.*.list/v1` envelopes lets agents write generic list-handling code that reads `data.scope` regardless of resource. The set of values varies per command, but that's documented per envelope.

7. **Human-mode `project` column.** When listing across all projects (`--project` unset), the `project` column is meaningful. When scoped to one project, every row shows the same project name — redundant. Two options: (a) always show `project` column; (b) drop `project` column when `data.scope === 'project'`. **Recommendation:** (a). Consistency across modes; agents and humans alike read the same column set. Cost is one redundant column when scoped; benefit is no special-case logic. (Matches R03's "show `state` only on `--scope all`" precedent in spirit but inverted — R03's column set varies because the entity varies; R05's entity is the same regardless of `--project`.)

---

**Coverage note for /plan.** Per `vitest.config.ts`: `src/api/**` ≥ 90% lines/statements; `src/commands/**` ≥ 85% branches (server-enforced via branch protection per Calibration §4). New files needing tests: `src/api/schemas/tasklist.ts` (round-trip fixtures), `src/api/tasklists.ts` (MSW-driven, both modes), `src/commands/tasklists/list.ts` (full E2E with all error-path exit-code assertions per Calibration §2). Reuse R03's `pagination.ts` and `parse-fields.ts` — no new tests for them.

**Lazy-import discipline.** `cli-table3` and `ora` continue to be `await import(...)`-loaded behind `isInteractive` checks. ESLint's `no-restricted-imports` rule already enforces.

**Rate-limit retry under `--all`.** Each page goes through R01's `HttpClient.request` path; 429s on a single page get jittered backoff (max 3 attempts). The `--all` driver does not add its own retry layer — same posture as R03.

**Summary box for the orchestrator:**

```
ARCHITECT run=2026-04-26-1537-r05-tasklists-list status=ok spec=docs/specs/0014-tasklists-list.md open_questions=7 new_deps=0
```

(No new dependencies. `cli-table3` and `ora` already in deps from R03/R02.)

---

## 8. Plan

Implementation plan for R05. Reuses R03/R04 infrastructure end-to-end; no new primitives. Slicing favors small, self-contained commits that each pass CI.

### 8.1 Files to create

| # | Path | Intent |
|---|---|---|
| 1 | `src/api/schemas/tasklist.ts` | `TasklistFullSchema`, `TasklistListDataSchema`, `TASKLIST_DEFAULT_FIELDS`. Mirrors `src/api/schemas/project.ts` shape. Exports `TasklistFull` and `TasklistListData` types. |
| 2 | `src/api/tasklists.ts` | `getAllTasklists(client, opts)` — `GET /all-tasklists?p=N[&projects_ids[]=<id>]`. Reuses `normalizePaginated` + `NormalizedPage<TasklistFull>`. |
| 3 | `src/commands/tasklists.ts` | Parent command. Mirrors `src/commands/projects.ts` (parent has no `meta`; defers to leaves). |
| 4 | `src/commands/tasklists/list.ts` | Leaf command. `meta = { outputSchema: 'freelo.tasklists.list/v1', destructive: false }`. Mirrors `src/commands/projects/list.ts` minus the scope-dispatch switch. **Critical:** `parsePositiveInt` (for `--project` and `--page`) MUST throw `ValidationError` (exit 2), NOT `InvalidArgumentError` (exit 1). See spec §2.1 + Calibration §1-2. |
| 5 | `src/ui/human/tasklists-list.ts` | Human renderer. Reuses `renderTable` from `src/ui/table.ts`. Default columns: `id, name, project, date_add, state`. Project column summarises to `project.name`; state to `state.state`. |
| 6 | `test/fixtures/tasklists/all-page0.json` | Wrapper-shaped paginated fixture (3 items, total=7, per_page=3, page=0). |
| 7 | `test/fixtures/tasklists/all-page1.json` | Page 1 (3 items). |
| 8 | `test/fixtures/tasklists/all-page2.json` | Page 2 (1 item, last page). |
| 9 | `test/fixtures/tasklists/project-42-page0.json` | Wrapper-shaped fixture for `?projects_ids[]=42` (2 items, total=2, last page). |
| 10 | `test/commands/tasklists/list.test.ts` | E2E tests via `runCli(run, ...)`. Coverage targets per Calibration §2/§4. |
| 11 | `docs/commands/tasklists-list.md` | User-facing doc. Two realistic examples + permissions note + envelope schema reference. |

### 8.2 Files to modify

| # | Path | Edit |
|---|---|---|
| M1 | `test/msw/handlers.ts` | Add `tasklistsHandlers = { allTasklistsOk(pages, opts?), allTasklistsByProject(projectId, pages), unauthorized(), serverError(status), allMidStreamError({pages, failPage, status?}) }`. Mirrors `projectsHandlers`. The `allTasklistsByProject` factory inspects `?projects_ids[]=` query param to select a fixture; missing/different ids return empty. |
| M2 | `src/bin/freelo.ts` | Add `const { register: registerTasklists } = await import('../commands/tasklists.js');` and `registerTasklists(program, getAppConfig, env);`. One line in each section, mirroring the `registerProjects` registration. |
| M3 | `docs/getting-started.md` | Add a one-line cross-link under the "Browse projects" section pointing to tasklists-list. |
| M4 | `README.md` | Regenerated by `pnpm fix:readme` after build. The autogen Commands block between markers will pick up `tasklists list` from `--introspect`. **No manual edit.** |
| M5 | `.changeset/<random>.md` | New changeset, `freelo-cli: minor` (additive command + new envelope schema). |

### 8.3 New dependencies

**None.** Every primitive is already imported from R03/R04:
- `commander`, `zod`, `commander/Option` — already in deps
- `cli-table3` (lazy) — already used by `src/ui/table.ts`
- `ora` (lazy, optional, human-mode + `--all` only) — already a dep, R03 doesn't actually wire a spinner; R05 won't either (deferred)

### 8.4 Test strategy

**Unit-level via the new schema file** is implicit (zod schemas validate on construction in tests). No standalone schema test file — round-trip happens inside the integration tests' `parseFirstJson` flow. Mirrors R03's posture.

**Integration tests** in `test/commands/tasklists/list.test.ts`. Same harness as `projects/list.test.ts` (`captureOutput`, `runCli`, `parseFirstJson`, `parseAllJson`, conf mock, env-var auth, `vi.doMock('conf', ...)`). The full suite below MUST land in one go — coverage thresholds are server-enforced.

**Required test cases** (each is a `it(...)`):

Happy paths:
1. **Default scope (no `--project`) → page 1** — `allTasklistsOk({0: page0})`. Asserts envelope `schema === 'freelo.tasklists.list/v1'`, `data.scope === 'all'`, `data.project_id === null`, `data.tasklists.length === 3`, `paging.page === 0`, `paging.next_cursor === 1`, exit 0.
2. **`--project 42` scope → server-filtered** — `allTasklistsByProject(42, {0: page0})`. Asserts `data.scope === 'project'`, `data.project_id === 42`, request URL contains `projects_ids%5B%5D=42`, exit 0.
3. **`--page 1`** — single-page flag. Asserts `paging.page === 0`.
4. **`--page 99` past end** — synthesized empty page. Asserts `data.tasklists.length === 0`, `paging.next_cursor === null`, exit 0.
5. **`--cursor 1`** — single-page agent round-trip. Asserts `paging.page === 1`, `paging.next_cursor === 2`.
6. **`--all` json mode** — merged single envelope. Asserts `data.tasklists.length === 7` (3+3+1), `paging.next_cursor === null`.
7. **`--all` ndjson mode** — one envelope per page. Asserts `parseAllJson(stdout).length === 3`, last page's `next_cursor === null`.
8. **`--fields id,name`** — projection. Asserts each `data.tasklists[i]` has only `id` and `name` keys.
9. **Empty result** — `allTasklistsOk({0: {total:0, count:0, page:0, per_page:25, data:{tasklists:[]}}})`. Asserts `data.tasklists.length === 0`, `paging.total === 0`, exit 0.

**Validation errors (exit code MUST be asserted on each — Calibration §2):**

10. **`--project abc` (non-numeric)** → exit 2, `error.code === 'VALIDATION_ERROR'`. **Critical:** ensures `ValidationError` (BaseError) was thrown, NOT `InvalidArgumentError`.
11. **`--project 0`** → exit 2, `error.code === 'VALIDATION_ERROR'`.
12. **`--project -1`** → exit 2, `error.code === 'VALIDATION_ERROR'`.
13. **`--page abc`** → exit 2, `error.code === 'VALIDATION_ERROR'` (parser must throw `ValidationError`).
14. **`--cursor -1`** → exit 2.
15. **`--page 2 --all`** (mutex) → exit 2, hint mentions "Pick one".
16. **`--page 1 --cursor 1`** (mutex) → exit 2.
17. **`--all --cursor 0`** (mutex) → exit 2.
18. **`--fields ''` (empty)** → exit 2, hint mentions "at least one field".
19. **`--fields foo` (unknown)** → exit 2, message contains `foo`.
20. **`--fields project.name` (nested)** → exit 2, hint mentions "top-level".

**HTTP error paths (exit codes per typed error class — Calibration §2):**

21. **401 from `/all-tasklists`** → exit 3 (`AUTH_ERROR`).
22. **5xx from `/all-tasklists`** → exit 4 (`SERVER_ERROR`).
23. **404 from `/all-tasklists`** → exit 4 (`FREELO_API_ERROR`).
24. **First-page error during `--all`** → exit 4 with underlying error (no `PartialPagesError` wrapper, since no pages succeeded).
25. **Mid-stream error during `--all` (json mode)** → partial envelope on stdout (with `notice`), error envelope on stderr, exit follows underlying class. Mirrors R03's mid-stream test.
26. **Malformed wrapper (server returns `data: {}` missing `tasklists` key)** → exit 4, `FreeloApiError` with code `VALIDATION_ERROR`.

**Coverage targets (server-enforced — Calibration §3-5):**

- `src/api/**` ≥ 90% lines/statements (vitest config). New file `src/api/tasklists.ts` is small (<25 lines of branched code); single happy-path + 401 path + missing-key path covers it.
- `src/commands/**` ≥ 85% branches. New file `src/commands/tasklists/list.ts` will have one `try/catch` plus the `--all` driver's `try/catch` for `PartialPagesError`. Both arms covered by tests #24, #25 above. **The implementer MUST grep its diff for `catch (` introductions and verify each arm has a matching test before declaring implement done — Calibration §4.**

### 8.5 Commit slicing

Three commits. Each commit must independently pass `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme` on the committed tree (Calibration §3). Push only when all five pass.

| # | Conventional commit | Files | Why this slice |
|---|---|---|---|
| C1 | `feat(api): add tasklist schema and getAllTasklists wrapper` | files 1, 2 (`src/api/schemas/tasklist.ts`, `src/api/tasklists.ts`) | Pure additive; types/schemas/wrapper. Compiles standalone. No tests yet — covered in C3 because the wrapper is exercised through the command. |
| C2 | `feat(commands): add tasklists list subcommand (R05)` | files 3, 4, 5 + M2 (parent + leaf + human renderer + bin registration) | Wires the full command surface. After this commit, `freelo tasklists list --help` works. Still no tests but typecheck/build/check:readme all green; `pnpm fix:readme` is run in C3. |
| C3 | `test(commands): cover tasklists list (R05)` + `docs(commands): document tasklists list (R05)` | files 6-11 + M1 + M3 + M4 + M5 | Tests, fixtures, MSW handlers, docs, README regeneration, changeset. Locks in coverage and the autogen README block. |

If C2's typecheck/build fails (likely the only risk: `meta.outputSchema` literal-type mismatch with `attachMeta`), retry once with the fix. If still red, halt and pause per orchestrator policy.

**One alternative slicing considered:** single commit. Rejected — three slices give three CI checkpoints. If C3 introduces a coverage regression, C1+C2 still land cleanly and C3 can iterate without fighting `--amend`.

### 8.6 Rollout order

1. C1: api + schema. CI gate: typecheck + lint + build + test (existing tests stay green; no new test paths yet) + check:readme.
2. C2: commands + bin wiring. CI gate: same five gates. **`pnpm fix:readme` is NOT run here** — the autogen block changes, but check:readme verifies the *committed* block matches what `--introspect` emits from the *built* binary. C2 introduces the new command, so check:readme will fail without a regenerated README. **Therefore: run `pnpm fix:readme` and stage the README change as part of C2** so the gate passes. Reorder: C2's file set includes `README.md`.
3. C3: tests + docs + changeset. CI gate: all five. Coverage threshold ≥85% branches on `src/commands/**` enforced.

**Corrected slicing:**

| # | Conventional commit | Files |
|---|---|---|
| C1 | `feat(api): add tasklist schema and getAllTasklists wrapper` | files 1, 2 |
| C2 | `feat(commands): add tasklists list subcommand (R05)` | files 3, 4, 5 + M2 + M4 (regenerated README) |
| C3 | `test(commands): cover tasklists list (R05)` | files 6-10 + M1 |
| C4 | `docs(commands): document tasklists list (R05)` | file 11 + M3 + M5 (changeset) |

Four commits, each independently CI-clean. C3 lands tests on top of code already in main if interrupted; C4 is purely additive docs.

**Decision:** Go with the four-commit split. The implementer agent picks final commit boundaries but MUST keep README regeneration in the same commit as the bin registration (C2) so `check:readme` never sees a half-state.

### 8.7 Definition-of-done

- [ ] All 26 test cases pass.
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme` green on the committed tree of HEAD.
- [ ] Coverage ≥85% branches on `src/commands/**`, ≥90% lines/statements on `src/api/**`.
- [ ] `freelo tasklists list --help` works on the built binary.
- [ ] `freelo --introspect` includes `tasklists list` with `outputSchema: 'freelo.tasklists.list/v1'`.
- [ ] Changeset present with `minor` bump and an entry mentioning the new schema.
- [ ] README autogen block regenerated.
- [ ] User docs page exists with two examples.
- [ ] Branch `feat/tasklists-list` pushed; `gh pr create` opens PR; `gh pr merge --auto --squash` is enabled.
- [ ] Yellow tier: PR is opened with auto-merge enabled. Branch protection holds it until CI is green; human reviews and merges.

### 8.8 Plan size

This plan is intentionally compact (~190 lines including this section heading) because R05 is a reuse slice. No new primitives; no new deps; no auth/HTTP/release surface; no security review needed. The implementer should be able to execute end-to-end in one orchestrator pass.

```
ARCHITECT run=2026-04-26-1537-r05-tasklists-list phase=plan status=ok plan_in=docs/specs/0014-tasklists-list.md commits=4 new_files=11 modified_files=5 new_deps=0
```
