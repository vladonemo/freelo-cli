# 0009 — `freelo projects list` (R03)

**Status:** Accepted — all 17 §7 recommendations adopted 2026-04-26; ready for /plan
**Run:** 2026-04-25-projects-list
**Owner:**
**Tier:** Yellow — first paginating endpoint, first table renderer, first `--all`/`--cursor`/`--fields` semantics, first cross-endpoint scope dispatcher, and the introduction of `src/api/pagination.ts` as a shared abstraction. New runtime dep `cli-table3` is already in `package.json`'s declared tech stack but lands as an actual import (lazy) for the first time. Reuses R01 (auth, error envelope, rate-limit retry) and R02 (config / output mode); no auth or schema-store changes.

---

## 1. Problem

After R01–R02, the CLI can authenticate and emit envelopes but cannot fetch a single Freelo resource. A user (human or agent) cannot answer the most basic question — *what projects do I have access to?* — without leaving the terminal.

R03 fills that hole and, in doing so, lays four pieces of infrastructure every later read command will reuse:

1. **Pagination normalization.** Five different list endpoints in the Freelo API will never have a uniform pagination shape (the API specialist confirmed `/projects` is a bare array; the four sibling endpoints share a wrapper but with different inner keys). One `src/api/pagination.ts` reduces them to a single internal `{ data, page, perPage, total, nextCursor }` shape, and the resulting envelope `paging` field is what R05 (tasklists), R07 (tasks), R08 (notifications) etc. will all emit.
2. **`--page N` / `--all` / `--cursor <n>` semantics.** The first command that has them sets the precedent for every list command after. They must compose well with each other and with `--output ndjson` (streaming) and `--output json` (single envelope).
3. **`--fields a,b,c` projection.** Applied at the envelope-builder layer so every consumer (json, ndjson, human) sees the same subset.
4. **A `human`-mode table renderer.** First lazy-loaded `cli-table3` use; sets the column-width / truncation / date-formatting policy R05+ inherit.

R03's user-visible deliverable: `freelo projects list` returns the active user's projects in any of five scopes, paginated, with a stable `freelo.projects.list/v1` envelope agents can pin against.

## 2. Proposal

### 2.1 Subcommand signature

```
freelo projects list [--scope owned|invited|archived|templates|all]
                     [--page N | --all | --cursor <n>]
                     [--fields a,b,c]
```

Hangs off a new `freelo projects` parent (`src/commands/projects.ts`), mirroring `src/commands/auth.ts`'s shape. Inherited globals from R01: `--output`, `--color`, `--profile`, `-v/-vv`, `--request-id`. `--yes` is registered globally but unused here (no destructive op).

| Flag | Type / values | Default | Purpose |
|---|---|---|---|
| `--scope` | `owned` \| `invited` \| `archived` \| `templates` \| `all` | `owned` | Selects which Freelo endpoint to call. See §2.2. |
| `--page <N>` | int >= 1 (1-indexed for the user) | unset | Single-page fetch. Mapped to `?p=N-1` on the wire (Freelo is 0-indexed). Mutually exclusive with `--all` and `--cursor`. |
| `--all` | boolean | `false` | Client-side iterates pages until `nextCursor === null`. Mutually exclusive with `--page` / `--cursor`. |
| `--cursor <n>` | int >= 0 (0-indexed; matches the value emitted in `paging.next_cursor`) | unset | Fetches a single page at cursor `n`. Designed for agent round-tripping: read `next_cursor` from the previous envelope, pass it back. Mutually exclusive with `--page` / `--all`. |
| `--fields <list>` | comma-separated string | unset (full envelope per scope; see §2.7) | Projects each record down to the listed snake_case keys before rendering. |

When none of `--page` / `--all` / `--cursor` is given: fetches **page 1** (i.e. `?p=0`) and returns it; envelope's `paging.next_cursor` indicates whether more pages exist. This is the agent-friendly default — one round-trip per invocation, agent decides whether to follow the cursor.

**Mutual exclusion** is enforced at parse time (Commander hook). If two of the three are set, throw `ValidationError({ code: 'VALIDATION_ERROR', exitCode: 2, hintNext: "Pick one of --page, --all, or --cursor." })`.

**Per-command `meta`** (consumed by the introspector):

```ts
export const meta = { outputSchema: 'freelo.projects.list/v1', destructive: false } as const;
```

### 2.2 `--scope` to endpoint mapping

| `--scope` | Endpoint | Pagination | Inner data key | Entity |
|---|---|---|---|---|
| `owned` *(default)* | `GET /projects` | **none** (bare array) | n/a | `ProjectWithTasklists` |
| `invited` | `GET /invited-projects` | `Paginated` | `invited_projects` | `ProjectWithTasklists` |
| `archived` | `GET /archived-projects` | `Paginated` | `archived_projects` | `ProjectWithTasklists` |
| `templates` | `GET /template-projects` | `Paginated` | `template_projects` | `ProjectWithTasklists` |
| `all` | `GET /all-projects` | `Paginated` | `projects` | `ProjectFull` |

The default is `owned` because it matches the Freelo web UI's default landing view and is cheapest (one endpoint, one round-trip, no pagination concerns). Agents that want everything across all states pick `--scope all` explicitly.

### 2.3 Envelope shape — `freelo.projects.list/v1`

The envelope uses an **`entity_shape` discriminator** to handle the mixed entity case (`--scope all` → `ProjectFull`; the other four → `ProjectWithTasklists`). Agents key off the discriminator before reading fields specific to one shape. This is Option B from the design questions — the alternative is an all-fields-optional union, which forces every consumer into "is field present?" guard logic across the entire shape; the discriminator localises that to one decision.

**Top-level envelope** (R01's `Envelope<T>`):

```jsonc
{
  "schema": "freelo.projects.list/v1",
  "data": {
    "entity_shape": "with_tasklists" | "full",
    "scope":        "owned" | "invited" | "archived" | "templates" | "all",
    "projects": [ /* per-shape items, see §4.3-4.4 */ ]
  },
  "paging": {
    "page":        0,    // 0-indexed, mirroring Freelo's wire format
    "per_page":    25,   // server-discovered; see §6 OQ#1
    "total":       137,
    "next_cursor": 1     // null when on last page or scope === 'owned'
  },
  "rate_limit": { "remaining": 42, "reset_at": "2026-04-25T18:30:00Z" },
  "request_id": "..."
}
```

**Why `data` is an object, not a bare array.** Three reasons:

1. The discriminator (`entity_shape`) needs a home next to the data, not on a sibling `meta` field. Stuffing it into `paging` would be a category error — `paging` is for paging.
2. `--scope` round-trips. Agents that did not pass `--scope` (defaulted to `owned`) can read `data.scope` to confirm.
3. Future fields (e.g. effective `--fields` projection echoed back; per-page summaries when `--all` aggregates) have a place to land without a v2 bump.

Field naming: snake_case throughout, matching what the Freelo API emits. We do **not** rename `date_add` → `created_at`; agents should be able to map field names to API docs 1:1.

### 2.4 Pagination semantics

Three switches; one wins per invocation. None set ≡ `--page 1`.

#### `--page N` (single page)

- User-facing 1-indexed; mapped to `?p=N-1` on the wire.
- Returns one envelope. `paging.page` is `N-1` (matches Freelo's 0-indexed wire). `paging.next_cursor` is `N` if `(N) * per_page < total`, else `null`.
- `--scope owned` ignores `--page` past 1 (no pagination on the endpoint); requesting `--page 2 --scope owned` produces an empty `projects: []` and `paging.next_cursor: null`. See §5 edge case "page past last page".

#### `--cursor <n>` (single page, agent round-trip form)

- 0-indexed integer; the value an agent reads from a previous envelope's `paging.next_cursor`.
- Equivalent to `--page n+1` in effect, but the protocol is "echo back what we told you". Designed so an agent's loop is `while (cursor !== null) { call --cursor cursor; cursor = response.paging.next_cursor }` without arithmetic.
- On `--scope owned` (no pagination), `--cursor 0` works (fetches the only page); any other value → `ValidationError('CURSOR_OUT_OF_RANGE')` exit 2 with hint `Scope 'owned' is unpaginated; use --cursor 0 or omit it.`. See §5 "cursor mismatch".

#### `--all` (client-side iteration)

Iterates `?p=0`, `?p=1`, ... until `(p+1) * per_page >= total` (i.e. `nextCursor === null`).

**Output composition under `--all`:**

| Output mode | Behavior |
|---|---|
| `json` (incl. `auto`-resolved-to-json) | One **merged** envelope: `data.projects` is the concatenation of all pages; `paging.page = total_pages - 1`, `paging.per_page = server-reported`, `paging.total = server-reported total at last page`, `paging.next_cursor = null`. Ordering preserved (server order across pages). |
| `ndjson` | One envelope **per page** (not per project — preserves `paging` per-page so agents can see progress and resume on partial failure). Each line is a complete `freelo.projects.list/v1` envelope. |
| `human` | Single table; pages fetched silently and concatenated. (Spinner allowed in human-mode only — see §2.6.) |

**Rationale for "envelope per page, not per project" in ndjson:** an agent restarting after a network blip mid-iteration uses the last successfully-emitted envelope's `paging.next_cursor` as its resume point. Per-project ndjson would break that.

**Rate-limit interaction.** R01's GET retry policy (jittered backoff, max 3 attempts on 429) applies per page. An agent sending `--all` against a large workspace may hit `RateLimitedError` if the budget is exhausted on a single page; the partial envelope path under §5 ("mid-stream pagination error") handles emission of accumulated data plus an error envelope on stderr.

**`--scope owned` under `--all`.** The endpoint has no pagination; `--all` terminates after one fetch. Documented; not an error.

#### Default (no flag)

Equivalent to `--page 1`. Returns one envelope. Agent reads `paging.next_cursor`; if non-null, pages with `--cursor`.

### 2.5 `--fields` projection

Comma-separated snake_case keys. Applied at the envelope-builder layer (in `src/api/pagination.ts`-adjacent projector, **before** rendering — so json/ndjson/human all see the same subset). Unknown field name → `ValidationError('UNKNOWN_FIELD')` exit 2 with the list of valid fields for the active scope.

```bash
# default (scope=owned), no --fields → all ProjectWithTasklists fields
freelo projects list

# explicit projection
freelo projects list --fields id,name,date_add

# scope=all, projecting state.id (nested) — not supported in v1; see §6 OQ#11
freelo projects list --scope all --fields id,name,state          # OK; emits the full state object
freelo projects list --scope all --fields id,name,state.id       # ValidationError, only top-level keys
```

`id` is not implicitly added; if the user passes `--fields name`, only `name` is emitted. (Agents that need stable identity across pages add `id` themselves.)

**Naming convention.** Field names are the **wire-format Freelo names**, snake_case (e.g. `date_add`, not `dateAdd`, not `date_start`). The roadmap example mentions `date_start` — this is a typo; projects do not have a `date_start` field. The default is documented in §2.7.

### 2.6 `human`-mode rendering

`cli-table3` lazy-loaded behind `await import('cli-table3')` inside `src/ui/table.ts` (new file). Imported only when `mode === 'human'`. ESLint's `no-restricted-imports` rule enforces.

Column policy for v1 (deliberately boring; flashy can come later):

- Default columns (no `--fields`): `id`, `name`, `date_add`, plus `state` for `--scope all`.
- Column widths: capped at 40 chars for `name`, with truncation suffix `…` (single Unicode character). Other columns auto-size.
- Date formatting: ISO-8601 verbatim. No relative dates, no timezone conversion.
- No color on state values. (R03 stays monochrome on data; chalk is reserved for headers and error messages, which already exist in R01.)
- Empty list: prints the table header with `(no projects)` in the body row. Stays consistent with `auth-whoami`'s "no profile" rendering pattern.
- Spinner: optional in human mode under `--all` only (multi-page fetch is the only case that takes long enough to warrant one). Lazy-loaded via `ora`; never attached in non-TTY.

### 2.7 Default `--fields` (when none given)

| Scope | Default fields | Notes |
|---|---|---|
| `owned`, `invited`, `archived`, `templates` | `id, name, date_add, date_edited_at, tasklists, client` | Full `ProjectWithTasklists`. Nested `tasklists` and `client` emitted as objects. |
| `all` | `id, name, date_add, date_edited_at, owner, state, minutes_budget, budget, real_minutes_spent, real_cost` | Full `ProjectFull`. |

Default `--fields` are full-payload because agents typically want everything. `--fields` is the **trim down** knob, not the **opt-in** knob.

### 2.8 Examples

**Agent-style (env auth, json out, default scope):**

```bash
$ FREELO_API_KEY=sk-... FREELO_EMAIL=agent@acme.cz freelo projects list --output json
{"schema":"freelo.projects.list/v1","data":{"entity_shape":"with_tasklists","scope":"owned","projects":[{"id":42,"name":"Site redesign","date_add":"2026-01-15T10:00:00+01:00","date_edited_at":"2026-04-20T14:32:00+01:00","tasklists":[{"id":101,"name":"Backlog"}],"client":{"id":7,"email":"client@example.cz","name":"Acme s.r.o."}}]},"rate_limit":{"remaining":99,"reset_at":"2026-04-25T18:30:00Z"},"request_id":"..."}
$ echo $?
0
```

**Agent-style, paginated, scope=all, projection:**

```bash
$ freelo projects list --scope all --cursor 1 --fields id,name,state --output json
{"schema":"freelo.projects.list/v1","data":{"entity_shape":"full","scope":"all","projects":[{"id":50,"name":"R&D","state":{"id":1,"state":"active"}},{"id":51,"name":"Old marketing","state":{"id":2,"state":"archived"}}]},"paging":{"page":1,"per_page":25,"total":137,"next_cursor":2},"rate_limit":{"remaining":98,"reset_at":"2026-04-25T18:30:00Z"},"request_id":"..."}
```

**Agent-style, full sweep with `--all` + `--output ndjson`:**

```bash
$ freelo projects list --scope all --all --output ndjson
{"schema":"freelo.projects.list/v1","data":{"entity_shape":"full","scope":"all","projects":[/*page 0*/]},"paging":{"page":0,"per_page":25,"total":137,"next_cursor":1},"rate_limit":{...},"request_id":"..."}
{"schema":"freelo.projects.list/v1","data":{"entity_shape":"full","scope":"all","projects":[/*page 1*/]},"paging":{"page":1,"per_page":25,"total":137,"next_cursor":2},"rate_limit":{...},"request_id":"..."}
... (one envelope per page)
{"schema":"freelo.projects.list/v1","data":{"entity_shape":"full","scope":"all","projects":[/*last page*/]},"paging":{"page":5,"per_page":25,"total":137,"next_cursor":null},"rate_limit":{...},"request_id":"..."}
```

**Human (TTY), default scope:**

```
$ freelo projects list
ID    NAME                                       DATE_ADD                  TASKLISTS
42    Site redesign                              2026-01-15T10:00:00+01:00 2
43    Brand refresh                              2026-02-03T09:14:00+01:00 5
```

(Tasklists and client are summarised in human mode — count for `tasklists`, name for `client`. JSON output preserves the full objects.)

**Error: mutually exclusive flags.**

```bash
$ freelo projects list --page 2 --all --output json
{"schema":"freelo.error/v1","error":{"code":"VALIDATION_ERROR","message":"Flags --page, --all, and --cursor are mutually exclusive.","http_status":null,"request_id":"...","retryable":false,"hint_next":"Pick one of --page, --all, or --cursor.","docs_url":null}}
$ echo $?
2
```

**Error: unknown field.**

```bash
$ freelo projects list --fields id,name,date_start --output json
{"schema":"freelo.error/v1","error":{"code":"VALIDATION_ERROR","message":"Unknown field 'date_start' for scope 'owned'. Valid fields: id, name, date_add, date_edited_at, tasklists, client.","http_status":null,"request_id":"...","retryable":false,"hint_next":"Run 'freelo projects list --output json' once to see the full envelope, or check 'freelo --introspect'.","docs_url":null}}
$ echo $?
2
```

**Error: 401 from the API (R01-shaped).**

```bash
$ FREELO_API_KEY=bad freelo projects list --output json
{"schema":"freelo.error/v1","error":{"code":"AUTH_ERROR","message":"Authentication failed.","http_status":401,"request_id":"...","retryable":false,"hint_next":"Run 'freelo auth login' or set FREELO_API_KEY/FREELO_EMAIL.","docs_url":null}}
$ echo $?
3
```

## 3. API surface

Five endpoints. All GET. All require Basic auth (R01 already wires this via `HttpClient`). Cited line numbers refer to `docs/api/freelo-api.yaml`.

| # | Endpoint | OpenAPI lines | Wrapper | Inner key | Entity |
|---|---|---|---|---|---|
| 1 | `GET /projects` | :146-? (subset of :146-465) | bare array, **no pagination** | n/a | `ProjectWithTasklists` |
| 2 | `GET /all-projects` | :146-465 | `PaginatedResponse` (:4814-4824) | `data.projects[]` | `ProjectFull` (:4944-4967) |
| 3 | `GET /invited-projects` | :146-465 | `PaginatedResponse` | `data.invited_projects[]` | `ProjectWithTasklists` |
| 4 | `GET /archived-projects` | :146-465 | `PaginatedResponse` | `data.archived_projects[]` | `ProjectWithTasklists` |
| 5 | `GET /template-projects` | :146-465 | `PaginatedResponse` | `data.template_projects[]` | `ProjectWithTasklists` |

**Pagination wire format** (`:4814-4824`):

```yaml
PaginatedResponse:
  type: object
  properties:
    total:    { type: integer }   # total items across all pages
    count:    { type: integer }   # items in *this* page (we infer; OpenAPI doesn't say)
    page:     { type: integer }   # 0-indexed
    per_page: { type: integer }   # server-controlled; no client knob exists
```

**Page parameter** (`:4766-4772`): `?p=<int>`, 0-indexed, default `0`. **Not `?page=`.**

**Endpoint-specific filters on `/all-projects`** (out of scope for R03, captured in §6 OQ#13 for explicit deferral): `order_by`, `order`, `tags[]` (with magic `"without"`), `states_ids[]` (1=active, 2=archived, 3=template; 4/5 unknown), `users_ids[]`, `created_in_range[date_from|date_to]`. R03 passes none of these — relying on server defaults — so behavior is "the user's full visible projects in `--scope all`, in the server's default order". When R03.5 adds filter flags, the envelope's `data` shape stays the same and adds an optional `applied_filters` field (additive, minor bump).

**Auth scope.** Standard Basic auth from R01. No additional Freelo permissions needed beyond what `auth login` already establishes.

**Rate limits.** R01's headers parser captures `RateLimit-Remaining` / `RateLimit-Reset`. The envelope's `rate_limit` field carries the **last page's** values when `--all` is used (prior pages' values aren't aggregated — most recent wins).

## 4. Data model

### 4.1 `src/api/pagination.ts` (new)

The shared abstraction. Exports:

```ts
/** Internal normalized shape; never serialized to envelope directly. */
export type NormalizedPage<T> = {
  data: T[];
  page: number;        // 0-indexed
  perPage: number;
  total: number;
  nextCursor: number | null;  // null on last page or unpaginated endpoints
};

/** Builds the `paging` field of the envelope from a NormalizedPage. */
export function pagingFromNormalized<T>(p: NormalizedPage<T>): Paging;

/** For the `/projects` bare-array case: synthesize a single-page NormalizedPage. */
export function synthesizeUnpaginated<T>(items: T[]): NormalizedPage<T>;

/**
 * Wrapper-key dispatcher. Given the raw paginated body and an inner key
 * ('projects' | 'invited_projects' | ...), returns NormalizedPage<T>.
 * Validates with the supplied per-endpoint schema (which inspects `data.<key>`).
 */
export function normalizePaginated<T>(
  raw: unknown,
  innerKey: string,
  itemSchema: ZodSchema<T>,
): NormalizedPage<T>;

/** `--all` driver: calls fetchPage(p) until nextCursor === null, with abort + page callback. */
export async function fetchAllPages<T>(opts: {
  fetchPage: (p: number) => Promise<NormalizedPage<T>>;
  signal?: AbortSignal;
  /** Called after each successful page; ndjson mode uses this for streaming. */
  onPage?: (page: NormalizedPage<T>) => void;
}): Promise<NormalizedPage<T>>;
```

`fetchAllPages` returns a single merged `NormalizedPage<T>` (all data concatenated; `page` = last-page index; `total` = last-page-reported total). The `onPage` callback is what `ndjson` mode uses to emit one envelope per page; `json` mode passes no callback and consumes the merged result.

**Why a synthesized single-page `NormalizedPage` for `/projects`** (resolving the design question on the no-paging endpoint): the envelope shape is uniform across scopes (`paging` always present, with `next_cursor: null` on the unpaginated case). Agents do not have to special-case "is `paging` defined" per scope — they always check `next_cursor`. **Recommendation accepted for the spec** — see §6 OQ#3 for the alternative.

### 4.2 `src/api/schemas/project.ts` (new)

Zod schemas for both entity variants and the per-endpoint paginated wrappers.

```ts
import { z } from 'zod';

const StateSchema = z.object({
  id: z.number().int(),
  state: z.enum(['active', 'archived', 'finished', 'deleted', 'template']),
});

const UserBasicSchema = z.object({ id: z.number().int(), fullname: z.string() });

const TasklistBasicSchema = z.object({ id: z.number().int(), name: z.string() });

const ClientSchema = z.object({
  id: z.number().int(),
  email: z.string().optional(),
  name: z.string().optional(),
  company: z.string().optional(),
  company_id: z.string().optional(),
  company_tax_id: z.string().optional(),
  street: z.string().optional(),
  town: z.string().optional(),
  zip: z.string().optional(),
}).passthrough();   // Freelo may add fields; non-strict at the entity level.

const CurrencySchema = z.object({
  amount: z.string(),
  currency: z.enum(['CZK', 'EUR', 'USD']),
});

export const ProjectWithTasklistsSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  date_add: z.string().optional(),         // ISO-8601 datetime; OpenAPI marks not required
  date_edited_at: z.string().optional(),
  tasklists: z.array(TasklistBasicSchema).optional(),
  client: ClientSchema.optional(),
}).passthrough();

export const ProjectFullSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  date_add: z.string().optional(),
  date_edited_at: z.string().optional(),
  owner: UserBasicSchema.optional(),
  state: StateSchema.optional(),
  minutes_budget: z.number().int().nullable().optional(),
  budget: CurrencySchema.optional(),
  real_minutes_spent: z.number().int().optional(),
  real_cost: CurrencySchema.optional(),
}).passthrough();

export type ProjectWithTasklists = z.infer<typeof ProjectWithTasklistsSchema>;
export type ProjectFull = z.infer<typeof ProjectFullSchema>;

/** Per-endpoint wrapper schemas — built dynamically by `normalizePaginated`. */
export const PaginatedWrapperSchema = z.object({
  total: z.number().int(),
  count: z.number().int(),
  page: z.number().int(),
  per_page: z.number().int(),
  data: z.record(z.string(), z.unknown()),  // inner key checked positionally
});

/** Bare-array shape for `/projects`. */
export const ProjectsBareArraySchema = z.array(ProjectWithTasklistsSchema);
```

**`.passthrough()` on entities** is a deliberate choice. Freelo documents fields loosely; new fields may appear without notice. We trust `id` and `name` (universally present), validate the documented fields when present, and let the rest pass through. This matches R01's existing `users-me.ts` posture.

**Required vs. optional.** Per OpenAPI, only `id` and `name` are non-optional in the entity. The schemas reflect that. The default `--fields` set in §2.7 is the *intent* set; missing fields appear as `undefined` in the projected output (json: `null`; human table: empty cell).

### 4.3 `ProjectListSchema` — the envelope `data` shape

```ts
export const ProjectListDataSchema = z.discriminatedUnion('entity_shape', [
  z.object({
    entity_shape: z.literal('with_tasklists'),
    scope: z.enum(['owned', 'invited', 'archived', 'templates']),
    projects: z.array(ProjectWithTasklistsSchema),
  }),
  z.object({
    entity_shape: z.literal('full'),
    scope: z.literal('all'),
    projects: z.array(ProjectFullSchema),
  }),
]);

export type ProjectListData = z.infer<typeof ProjectListDataSchema>;
```

Discriminated union: agents read `data.entity_shape`, then know which fields to expect on each item in `data.projects`. Zod gives us both runtime guarantees and the inferred type.

### 4.4 Envelope shape recap

Reusing R01's `Envelope<T>` from `src/ui/envelope.ts`:

```ts
type ProjectsListEnvelope = Envelope<ProjectListData>;
// schema:    'freelo.projects.list/v1'
// data:      ProjectListData
// paging:    Paging (always present in v1; next_cursor: null when scope === 'owned' or last page)
// rate_limit: from last fetched page
// request_id: from --request-id or generated
```

**Paging always present.** Even for `--scope owned` (synthesized via `synthesizeUnpaginated`). This avoids the special case in agent loops.

### 4.5 Field projection model

A small `src/api/projection.ts` (or colocated in `src/api/pagination.ts` — implementer's call, locked decision in plan):

```ts
/** Project an array of records to the listed top-level fields. Returns the
 *  same shape with absent fields stripped. Unknown field names throw
 *  ValidationError before the API call is made. */
export function projectFields<T extends Record<string, unknown>>(
  records: T[],
  fields: readonly string[],
  knownFields: readonly string[],
): Partial<T>[];
```

Validation runs **before** the HTTP call. Saves a network round-trip on bad input. The valid-fields list comes from the per-scope default-fields registry in §2.7.

## 5. Edge cases

- **`--scope owned` is unpaginated.** `--page 1` is fine, returns the bare array as `paging.page = 0`, `paging.per_page = projects.length`, `paging.total = projects.length`, `paging.next_cursor = null`. `--page 2` returns `projects: []`, same `paging`. `--all` terminates after one fetch. `--cursor 0` works; `--cursor n>=1` → `ValidationError('CURSOR_OUT_OF_RANGE')` exit 2.
- **`--page N` past the last page.** Server typically returns `data: { <key>: [] }` with `page: N-1`, `total` unchanged. Envelope emits `projects: []`, `paging.next_cursor: null`. Exit 0 — empty result is success, not error. (Matches R01's "no results = exit 0" rule.)
- **`--cursor n` that does not match any prior `paging.next_cursor`.** No client-side validation against history (we don't keep history). Sent as `?p=n` to the server; server returns whatever it returns. If `n` is past `total`, behaves as "page past last page" above. If `n < 0`, caught by Commander's int validator → `ValidationError`.
- **Empty result on a paginated endpoint.** `projects: []`, `paging.total: 0`, `paging.next_cursor: null`. Exit 0.
- **Mid-stream pagination error under `--all`.** A 4xx/5xx/network error mid-iteration:
  - Already-emitted pages (ndjson mode): not retracted; agent has them.
  - Accumulated pages (json mode): the partial merged envelope is **emitted to stdout** with a `notice: "Partial result; iteration aborted at page N."` annotation, **then** the error envelope is emitted to **stderr**.
  - Exit code follows the underlying error (4 for API, 5 for network, 6 for rate-limit-budget-exhausted).
  - `paging.next_cursor` in the partial json envelope points at the page that failed (so the agent can retry from there with `--cursor`).
  - Rationale: dropping accumulated work would be hostile to agents iterating large workspaces under flaky network. Emitting the partial + the error preserves both pieces of information.
- **`--fields` with all-unknown fields.** `ValidationError` lists the valid set. No API call.
- **`--fields` with a mix of known + unknown.** Same — fail closed before the API call.
- **`--fields` with zero fields specified (`--fields=""`).** Treat as "no fields requested" → `ValidationError('EMPTY_FIELDS')` exit 2 with hint `Specify at least one field, or omit --fields for the default set.`. (Empty projection is ambiguous: agents that meant "id only" should say so.)
- **`--scope all` with a mix of state IDs.** R03 passes no `states_ids[]`; server returns whatever its default is (per OpenAPI: undocumented). The envelope emits whatever the server gives. Documented as "server-default" in `--help`.
- **Nested-field projection (e.g. `state.id`)** — not supported in v1. `ValidationError('NESTED_FIELDS_UNSUPPORTED')` exit 2. (See §6 OQ#11.)
- **Concurrent invocations / `--all` interleave with another caller modifying projects.** Server-side ordering may shift; we may see the same project on two pages or miss one. Documented; not a bug in R03. Agents that need stronger consistency wait for R-future "snapshots".
- **Server returns a `count` that disagrees with `data.<key>.length`.** Trust `data.<key>.length`; log a warning at `-v` info level if they disagree. `total` is trusted as-is for `next_cursor` math.
- **`per_page` differs across pages under `--all`.** The server is allowed to (we don't have a contract from Freelo guaranteeing stability). The merged envelope emits the **last page's** `per_page`; the iteration uses each page's reported `per_page` to compute `next_cursor`. (The `--all` driver does not assume a fixed `per_page`.)
- **`projects` is missing from the wrapper entirely** (server returns wrapper without `data`). Zod fails validation → `FreeloApiError({ code: 'VALIDATION_ERROR' })` from the client (R01's existing shape), exit 4. No silent fallback.
- **`/projects` returns `data: { projects: [...] }` (i.e., the API specialist's research is wrong and `/projects` actually wraps).** The bare-array schema fails; the client surfaces `VALIDATION_ERROR`. The implementer's MSW fixture must lock down our assumption; if a real-world response disagrees, we file a bug and adjust the schema (additive, not breaking — `ProjectsBareArraySchema` becomes a `z.union(bareArray, paginatedShape)`).
- **`--all` interrupted by SIGINT mid-iteration.** R01's abort signal propagates through `fetchAllPages`; partial accumulated envelope emitted as in "mid-stream pagination error" above; exit 130.
- **`--output ndjson` with `--page 1` (single page).** One envelope on stdout, identical to `--output json` modulo trailing newline policy.
- **`--scope` with a non-enum value.** Commander's choice validator throws → `ValidationError`, exit 2.

## 6. Non-goals

Explicitly deferred to follow-up slices. Each is captured here so /plan does not absorb them.

- **Filter flags on `--scope all`.** `--state`, `--tag`, `--owner`, `--created-from`, `--created-to`, `--order-by`, `--order` — all deferred to **R03.5**. R03 ships listing + pagination + projection. The envelope's `data` shape will gain an optional `applied_filters` field then; that addition is additive (minor bump).
- **`--page-size <n>` knob.** Server controls `per_page`; no client tuning in v1. (See §6 OQ#1; may revisit when we know the server's ceiling.)
- **`--scope all` paging with `tags[]="without"` magic value.** Tied to filter-flag deferral.
- **Color coding state values in human mode.** Boring on purpose.
- **Relative dates ("3 days ago") in human mode.** Defer until a real consumer asks.
- **Nested-field projection (`--fields state.id`).** Defer — current zod doesn't make this trivial without a custom path resolver. (See §6 OQ#11.)
- **`--watch` mode** (long-poll for changes). Out of scope; future "feeds" surface.
- **YAML output mode.** Existing CLI-wide non-goal.
- **Custom column ordering in human mode.** `--fields` controls projection but column order in the table follows the `--fields` order; column-customization beyond that is out of scope.
- **`--scope mine`** (intersection of "owned + invited + I have a task assigned to me"). Unknown if Freelo even supports the underlying query. Defer.
- **Caching of pagination results across invocations.** Every invocation is a fresh fetch. Caching is a future optimization.
- **Server-side cursor tokens.** Freelo uses page indices, not opaque cursors. We expose page indices as `next_cursor` for protocol uniformity with future cursor-based endpoints; this does not commit us to opaque tokens later (additive change).
- **`projects show <id>`.** That's R04's job. R03 does not embed deep project detail.

## 7. Open questions

> **Resolution (2026-04-26):** All 17 recommendations below were accepted by the human gate. The planner treats every "Recommendation:" as a load-bearing decision; do not relitigate.

> Each line ends with a **Recommendation**. When the human accepts "all OQs as recommended", the spec is internally consistent and /plan can proceed.

Items 1–7 originate from the API specialist's research. Items 8–17 are CLI/envelope design choices.

1. **`per_page` default and ceiling — UNKNOWN.** Three options: (a) discover at runtime from the first response; (b) probe once during spec to lock the value (requires a one-off API call against a real account); (c) document as runtime-discovered, no client knob, no assumption baked in. **Recommendation:** (c). Trust whatever the server reports; don't introduce a client knob (`--page-size`) until a real user asks. The `--all` driver doesn't care — it iterates by `next_cursor` regardless of `per_page`. Document in `--help`: "page size is server-controlled".

2. **`/projects` has no paging.** Two options: (a) synthesize a single-page `paging` shape (`page: 0`, `per_page: count`, `total: count`, `next_cursor: null`); (b) special-case the envelope so `paging` is **omitted** for `--scope owned`. **Recommendation:** (a). Synthesize. Uniform envelope shape across all five scopes is more valuable than honesty about "this endpoint has no paging" — agents loop on `next_cursor !== null` and the synthesized null cursor terminates the loop trivially. Documented in §4.1.

3. **`order_by` default differs across endpoints.** OpenAPI's documented default for `/all-projects` is `date_add`; other endpoints don't document one. Should the CLI pass an explicit `order_by` to keep results deterministic? **Recommendation:** No — defer to R03.5. R03 passes nothing; behavior is "server default". Document this in `--help`. Adding `--order-by` later is additive (envelope's `data` gains `applied_filters.order_by`).

4. **`tags[]="without"` magic value exposure.** Two options: (a) `--no-tag` flag; (b) `--tag without` (literal). **Recommendation:** Defer to R03.5 along with all filter flags. When it lands, prefer `--no-tag` — `--tag without` exposes a server-implementation detail to users. Captured here so R03.5 doesn't reopen.

5. **`states_ids[]` default.** Should `--scope all` pass all known IDs explicitly, or rely on server defaults? **Recommendation:** Server defaults. We don't pass `states_ids[]` from R03. (Filter flags are R03.5.) Documented in §3 and §5.

6. **State enum ID mapping for `finished` and `deleted` — UNKNOWN.** OpenAPI documents 1=active, 2=archived, 3=template; 4 and 5 are unknown. **Recommendation:** Skip. R03 does not filter by state. The entity schema's `state.state` enum includes all five strings, so when the server returns one of them with an unknown numeric ID, we pass it through unchanged. If R03.5 adds `--state finished`, we probe at that point; until then, the unknown IDs are not blocking.

7. **Date timezone for `date_add` / `date_edited_at` — unspecified by OpenAPI.** Real responses appear to include a TZ offset (`+01:00`) but this is not contractual. **Recommendation:** Treat the field as `z.string()` (the schema does); pass through verbatim. No CLI-side parsing or normalization in R03. Human-mode renderer prints the string verbatim. If a future renderer wants `--relative` or local-tz conversion, that's a follow-up.

8. **Default `--scope`.** Roadmap doesn't pick. **Recommendation:** `owned`. Matches the website's default landing view; cheapest endpoint; fastest happy-path.

9. **Mixed entity shapes — discriminator vs. union vs. coercion.** §2.3 picks the discriminator (Option B). **Recommendation:** Discriminator (`entity_shape: 'with_tasklists' | 'full'`). Cleaner agent UX than an all-optional union; doesn't lose information like the lowest-common-subset approach would.

10. **`--all` output composition.** §2.4 picks per-page envelopes for ndjson and a single merged envelope for json. **Recommendation:** As stated. Per-project ndjson would break resume-from-cursor; per-page is the right granularity.

11. **Nested-field projection (`--fields state.id`).** **Recommendation:** Out of scope for R03. Top-level keys only. Future: a small JSONPath-lite resolver, with a rule that the projected envelope uses dotted keys (`"state.id": 1`) so agents can round-trip the field name. Captured as a non-goal.

12. **Field naming in `--fields` — wire snake_case vs. normalized.** **Recommendation:** Wire snake_case (Freelo's emission). One naming convention per envelope; matches the API docs 1:1.

13. **Filter flags scope.** Roadmap mentions only `--scope` and `--fields`. Should this slice expose `--state`, `--tag`, `--owner` for `--scope all`? **Recommendation:** No — R03.5. Keeps the slice focused. Adding them later is purely additive (envelope gains `applied_filters`; `--help` gains rows).

14. **Mid-stream `--all` error policy.** §5 picks "emit partial + error envelope to stderr; exit follows underlying error". **Recommendation:** As stated. Alternative is "discard partial, exit error" — hostile to agents.

15. **Default `--fields` for each scope.** §2.7 picks the full payload per scope. **Recommendation:** As stated. `--fields` is a trim, not an opt-in.

16. **`cli-table3` lazy-import vs. simple padded-row rendering** (the auth-whoami pattern). The R02 plan punted on `cli-table3` for `config profiles` and used padded rows. **Recommendation:** Use `cli-table3` here — projects-list is the first command with truly tabular data (5+ columns, dynamic widths), padded rows would be ugly. New `src/ui/table.ts` wrapper with lazy import. Sets the table-renderer policy R05+ inherit. (R02's auth-whoami row-pad pattern stays for the config commands; the two coexist.)

17. **`--scope owned` with `--cursor n>=1` — error vs. silent empty.** §5 picks `ValidationError('CURSOR_OUT_OF_RANGE')`. **Recommendation:** Error. Silent-empty is less helpful for agents debugging "why did my loop stop"; error tells them they used the wrong protocol against an unpaginated scope.

---

**Coverage note for /plan.** Per `.claude/docs/sdlc.md` Phase 4: ≥90% line coverage on `src/commands/projects/` and `src/api/`. New files needing dedicated unit tests at minimum: `src/api/pagination.ts` (normalize, synthesize, fetchAllPages with mocked fetchPage), `src/api/projection.ts` (or projection-in-pagination), `src/api/schemas/project.ts` (round-trip fixtures), `src/ui/table.ts` (lazy-load assertion + render fixture). Integration tests in `test/commands/projects-list.test.ts` cover all five scopes via MSW, all three pagination flags, `--fields`, and the error envelopes.

**Lazy-import discipline.** `cli-table3` and `ora` (if used for the `--all` spinner) **must** be `await import(...)`-loaded behind `isInteractive` checks. Top-level static imports are an ESLint failure per existing R01 config. Re-stated here because R03 is the first slice that actually consumes either dependency in production code.

**Rate-limit retry under `--all`.** Each page goes through the same `HttpClient.request` path R01 wired up; 429s on a single page get jittered backoff (max 3 attempts). The driver does not add its own retry layer — one retry policy, one place. If a single page exhausts the budget, the partial-result protocol from §5 takes over.

**Summary box for the orchestrator:**

```
ARCHITECT run=2026-04-25-projects-list status=ok spec=docs/specs/0009-projects-list.md open_questions=17 new_deps=0
```

(`cli-table3` is already in the declared tech stack; lands as an actual import in this slice but counts as zero **new** package.json additions per the dependency policy. `ora` is similarly pre-declared.)

---

## 8. Plan (R03 implementation)

> Authored 2026-04-26 by orchestrator (architect role) on resumption. Spec §1–§7 are the contract; this section translates them into files, tests, and commits.

### 8.1 Dependency note

`cli-table3@^0.6` is added to `dependencies` in this slice. The existing tech-stack doc already declares it; `package.json` at HEAD does not list it. See decision log `0001-cli-table3-is-a-new-package-json-dep.md`. No `pnpm changeset` callout needed beyond the standard `minor` entry for the new command — agents do not see the dep, only the renderer.

`ora` is already in `dependencies`. No new dev deps.

### 8.2 File-by-file plan

**New source files (8):**

1. `src/api/schemas/project.ts` — zod schemas:
   - `StateSchema`, `UserBasicSchema`, `TasklistBasicSchema`, `ClientSchema`, `CurrencySchema` (private).
   - `ProjectWithTasklistsSchema` (with `.passthrough()`), `ProjectFullSchema` (with `.passthrough()`).
   - `ProjectsBareArraySchema = z.array(ProjectWithTasklistsSchema)` for `/projects`.
   - Per-endpoint paginated wrapper schema **factories**: `paginatedProjectsWrapperSchema(innerKey, itemSchema)` returns a schema that asserts `{ total, count, page, per_page, data: { [innerKey]: T[] } }`.
   - Exports inferred types `ProjectWithTasklists`, `ProjectFull`.
   - `ProjectListDataSchema` — discriminated union on `entity_shape`.
   - Default `--fields` registries per scope (§2.7) as a frozen map.

2. `src/api/pagination.ts` — pagination + projection abstractions:
   - `NormalizedPage<T>` type.
   - `pagingFromNormalized<T>(p: NormalizedPage<T>): Paging` (matches `src/ui/envelope.ts` `Paging` type).
   - `synthesizeUnpaginated<T>(items: T[]): NormalizedPage<T>` — single page; `nextCursor: null`.
   - `normalizePaginated<T>(raw, innerKey, itemSchema)` — validates wrapper, extracts inner array, returns `NormalizedPage<T>`. Computes `nextCursor` as `(page+1) * per_page < total ? page + 1 : null`. Also tolerates server `count !== data.length` per spec §5 (logs at info level via injected logger when caller passes one; in v1 we keep it silent — coverage cost vs. value).
   - `fetchAllPages<T>({ fetchPage, signal, onPage })` — iterates `?p=0,1,...` until `nextCursor === null`. On each page calls `onPage` (used by ndjson). Returns merged `NormalizedPage<T>` (`data` = concat of pages, `page` = last page index, `per_page` = last page's, `total` = last page's, `nextCursor: null`). On thrown error mid-iteration, attaches `accumulated` and `lastPage` fields to the error via a typed wrapper class `PartialPagesError<T>` so the command layer can emit the partial envelope.
   - `projectFields<T>(records, fields, knownFields)` — top-level projection; throws `ValidationError('UNKNOWN_FIELD' | 'EMPTY_FIELDS' | 'NESTED_FIELDS_UNSUPPORTED')` with the exact `hintNext` strings from spec §2.5 and §5. (Co-located in `pagination.ts` per spec §4.5 implementer-call.)

3. `src/api/projects.ts` — HTTP client wrappers, one per endpoint:
   - `getOwnedProjects(client, opts): Promise<NormalizedPage<ProjectWithTasklists>>` — `GET /projects`, validates with `ProjectsBareArraySchema`, returns `synthesizeUnpaginated(parsed)`.
   - `getAllProjects(client, opts: { page: number; ... }): Promise<NormalizedPage<ProjectFull>>` — `GET /all-projects?p=N`, validates with paginated wrapper for `projects` key.
   - `getInvitedProjects(...)` — `GET /invited-projects?p=N`, inner key `invited_projects`.
   - `getArchivedProjects(...)` — `GET /archived-projects?p=N`, inner key `archived_projects`.
   - `getTemplateProjects(...)` — `GET /template-projects?p=N`, inner key `template_projects`.
   - All five accept `{ signal?, requestId? }` and return `{ page: NormalizedPage<T>, raw: ApiResponse<unknown> }` so commands keep `rateLimit` from the underlying call.

4. `src/commands/projects.ts` — parent command registrar (mirrors `src/commands/auth.ts`).

5. `src/commands/projects/list.ts` — leaf command:
   - Per-command `meta = { outputSchema: 'freelo.projects.list/v1', destructive: false }`.
   - Registers `--scope`, `--page`, `--all`, `--cursor`, `--fields` (with Commander parsers/validators).
   - `preAction` (or in-action, per existing pattern) enforces mutual exclusion of `--page`/`--all`/`--cursor`.
   - Action coordinator: validates `--fields` against the per-scope registry **before** any HTTP call. Dispatches to the correct API function. Builds the envelope (using `pagingFromNormalized`) and calls `render`.
   - Special-case `--all` × `ndjson`: calls `fetchAllPages` with an `onPage` callback that emits one envelope per page; never emits a merged envelope.
   - Mid-stream `--all` error: catches `PartialPagesError`; emits the partial envelope on stdout (with `notice: 'Partial result; iteration aborted at page N.'`); re-throws the underlying error to `handleTopLevelError` for stderr emission. `paging.next_cursor` is set to the page that failed.

6. `src/ui/table.ts` — lazy `cli-table3` wrapper:
   - `async renderTable(headers: string[], rows: string[][], opts?: { maxNameWidth?: number }): Promise<string>` — `await import('cli-table3')` inside; never imported at module top-level.
   - Truncation policy: any cell that is the "name" column (per the spec, hard-coded width 40) gets `…` suffix when truncated. Other columns auto-size.

7. `src/ui/human/projects-list.ts` — pure shape → string mapper:
   - `renderProjectsListHuman(data: ProjectListData): string` — picks the default columns per `entity_shape` + scope (§2.6), or honors `--fields` order if a `_fields` hint was attached. Calls `await renderTable(...)` with the assembled rows.
   - Empty list → header + `(no projects)` row, per spec §2.6.
   - Nested values (tasklists, client) summarised: tasklist count, client name.

8. `src/lib/parse-fields.ts` — small helper to parse `--fields a,b,c` into `string[]`, validating non-empty and trimming. Keeps `commands/projects/list.ts` thin.

**Modified source files (3):**

9. `src/bin/freelo.ts` — register `projects` parent next to `auth` and `config`. Add `const { register: registerProjects } = await import('../commands/projects.js');` and `registerProjects(program, getAppConfig, env);`.

10. `package.json` — add `"cli-table3": "0.6.5"` (or latest 0.6.x). Pinned version.

11. `pnpm-lock.yaml` — regenerated by `pnpm install`.

**Changeset (1):**

12. `.changeset/<auto>.md` — `minor`, summary: `feat(commands): add 'freelo projects list' for paginated project listing across five scopes`. Schema callout: introduces `freelo.projects.list/v1` envelope with `entity_shape` discriminator.

**README autogen (1):**

13. `README.md` — autogenerated commands block updated by `pnpm fix:readme`.

**Test files (5 new):**

14. `test/api/schemas/project.test.ts` — round-trip fixtures for both entity shapes; passthrough behaviour; required-field minimality (only `id`, `name`); state enum coverage; paginated wrapper factory.

15. `test/api/pagination.test.ts` — `synthesizeUnpaginated`, `normalizePaginated` (each scope's inner key), `fetchAllPages` driver (3 pages, abort signal, mid-stream error → `PartialPagesError`), `projectFields` (known/unknown/empty/nested).

16. `test/api/projects.test.ts` — each of the five endpoint wrappers via MSW. Validates request URL (incl. `?p=N`), response parsing.

17. `test/commands/projects/list.test.ts` — end-to-end via `program.parseAsync`. Cases:
    - `--scope owned` default → `entity_shape: with_tasklists`, paging synthesized.
    - `--scope all` → `entity_shape: full`.
    - `--page 1` → `?p=0`, returns first page.
    - `--page 99` past-end → empty `data`, `paging.next_cursor: null`.
    - `--cursor 2` → `?p=2`, paging echoes back.
    - `--all --output json` → merged envelope (3 MSW pages).
    - `--all --output ndjson` → one envelope per page on stdout.
    - `--scope owned --cursor 1` → `ValidationError('CURSOR_OUT_OF_RANGE')` exit 2.
    - `--scope owned --all` → terminates after one fetch (no error).
    - `--page 2 --all` → `ValidationError` mutually-exclusive, exit 2.
    - `--fields id,name` → projects projected; missing fields absent.
    - `--fields date_start` → `ValidationError('UNKNOWN_FIELD')` exit 2; lists valid fields.
    - `--fields ""` → `ValidationError('EMPTY_FIELDS')`.
    - `--fields state.id` → `ValidationError('NESTED_FIELDS_UNSUPPORTED')`.
    - 401 → `freelo.error/v1` with `code: AUTH_EXPIRED`, exit 3.
    - 5xx → `freelo.error/v1` with `code: SERVER_ERROR`, exit 4.
    - Mid-stream `--all` error: stdout has partial envelope with `notice`; stderr has error envelope; `paging.next_cursor` points at failed page.
    - Schema discriminator visible in envelope (json mode).
    - Help text mentions all flags.

18. `test/ui/table.test.ts` — `renderTable` produces expected string for a 3-row × 4-col input; truncation at 40 chars on name column. No top-level import of `cli-table3` (regex assertion against the file source — see §8.5).

**Test fixture file (2 new):**

19. `test/fixtures/projects/owned.json` — bare array of three `ProjectWithTasklists` records.

20. `test/fixtures/projects/all-page0.json`, `all-page1.json`, `all-page2.json` — `PaginatedResponse<ProjectFull>` shape; total=`75`, per_page=`25`. Page 2 has empty tail.

**MSW handlers (1 modified):**

21. `test/msw/handlers.ts` — add `projectsHandlers` factory namespace mirroring `usersMeHandlers`, with handlers for: each endpoint OK shape, 401, 5xx, malformed paginated body (missing inner key), 429 (one retry budget burn).

**Doc files (2 new):**

22. `docs/commands/projects-list.md` — user-facing, two realistic examples (agent + human), required Freelo permissions note, link to spec.

23. `docs/getting-started.md` — append a "Listing projects" section with a copy-pasteable agent invocation. (If the file does not yet exist, create it; we'll glob to confirm.)

**File count:** 11 new src/test files + 3 modified src + 1 changeset + 1 README + 2 doc files + 2 fixture files = **20 files**. Within the 25-file budget.

### 8.3 Test strategy

Per `vitest.config.ts`: `src/api/**` ≥ 90% lines/statements, 80% functions, 80% branches; `src/commands/**` ≥ 90/90/85/90. Existing thresholds — must hold after this change.

- **Unit (fast, no MSW):** `pagination.test.ts`, `project.test.ts` (schemas), `parse-fields.test.ts`, `table.test.ts`.
- **Integration (with MSW):** `projects.test.ts` (api wrappers), `list.test.ts` (full command).
- **Lazy-import discipline test:** in `test/ui/table.test.ts`, read `src/ui/table.ts` source and assert no top-level `import` of `cli-table3` (mirrors spec §2.6 lazy-load rule). Co-locate with the table tests so reviewers see them together.
- **Snapshot tests:** allowed only for the human renderer's table output (one snapshot per scope/columns combination — kept small).

### 8.4 MSW handler list

Five GET endpoints. Inner keys per spec §2.2.

```ts
projectsHandlers.ownedOk(items?)            // GET /projects → bare array
projectsHandlers.allOk({ page, total, perPage, items? })  // GET /all-projects → wrapper, key 'projects'
projectsHandlers.invitedOk({ page, ... })   // GET /invited-projects → wrapper, key 'invited_projects'
projectsHandlers.archivedOk({ page, ... })  // GET /archived-projects → wrapper, key 'archived_projects'
projectsHandlers.templatesOk({ page, ... }) // GET /template-projects → wrapper, key 'template_projects'

projectsHandlers.unauthorized(scope)        // 401 for any of the five
projectsHandlers.serverError(scope, status?) // 5xx for any of the five
projectsHandlers.malformedWrapper(scope)    // wrapper missing inner key
projectsHandlers.allMidStreamError({ failPage, status }) // succeeds for p<failPage, errors at failPage
```

The `--all` mid-stream error handler counts requests across pages so a single test can drive the partial-result branch.

### 8.5 Lazy-import enforcement

ESLint's `no-restricted-imports` rule already forbids top-level `cli-table3` imports in `src/**/*.ts` (verified in `eslint.config.js`). The new `src/ui/table.ts` uses `await import('cli-table3')` inside the function body. The test in `test/ui/table.test.ts` re-asserts this (defense in depth) by parsing the source.

### 8.6 Rollout slicing

Single PR with **5 commits**, each green on its own:

1. `feat(api): add project schemas and pagination primitives`
   Files: `src/api/schemas/project.ts`, `src/api/pagination.ts`, `src/lib/parse-fields.ts`. Tests: `test/api/schemas/project.test.ts`, `test/api/pagination.test.ts`.

2. `feat(api): add HTTP wrappers for the five project list endpoints`
   Files: `src/api/projects.ts`, `test/msw/handlers.ts` (add `projectsHandlers`), `test/fixtures/projects/*.json`, `test/api/projects.test.ts`.

3. `feat(ui): add lazy cli-table3 renderer and projects-list human renderer`
   Files: `src/ui/table.ts`, `src/ui/human/projects-list.ts`, `test/ui/table.test.ts`. Adds `cli-table3` to `package.json` deps.

4. `feat(commands): add 'freelo projects list' across five scopes with paging`
   Files: `src/commands/projects.ts`, `src/commands/projects/list.ts`, `src/bin/freelo.ts` (registration), `test/commands/projects/list.test.ts`. Adds the changeset.

5. `docs(commands): document 'freelo projects list' and regenerate README`
   Files: `docs/commands/projects-list.md`, `docs/getting-started.md`, `README.md` (via `pnpm fix:readme`).

Each commit must pass `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme` on its own tree before push (per orchestrator's discipline note for this run). Note: the `check:readme` gate only applies after commit 5; commits 1–4 will leave it stale until commit 5 runs `fix:readme`. **Resolution:** run all five commits in sequence, then run the full gate suite once at the end on the final tree before push. Individual commit-by-commit gating is for typecheck/lint/test/build; check:readme runs once at the end.

### 8.7 Risks and mitigations

| Risk | Mitigation |
|---|---|
| MSW `onUnhandledRequest: 'error'` breaks if a test forgets to set up a handler | Each test explicitly calls `server.use(projectsHandlers.xxx())`; the test setup file already enforces error mode. |
| `cli-table3` v0.6.x ESM compat | `cli-table3` ships CJS; Node ESM `await import('cli-table3')` works (default export). Verified pattern in `ora` consumption elsewhere. If it bites, fall back to `import('cli-table3').then(m => m.default)`. |
| `ProjectFull.budget` schema drift (server returns null vs. object) | `.passthrough()` + `.optional()` on every entity field that OpenAPI doesn't mark required absorbs the drift. |
| `--all` test brittleness on page count | Use a fixture with exactly 3 pages (total=75, per_page=25). MSW counts `?p=N`; the driver halts when `next_cursor === null`. |
| Coverage drop on `src/commands/**` | The leaf command's branch coverage is the risk; structure the action handler so each error branch is reachable from a single targeted test. |

### 8.8 Out of scope (re-stated for /implement)

Do not introduce: filter flags (`--state`, `--tag`, `--owner`, etc.), `--page-size`, nested-field projection, color coding, relative dates, snapshot caching. Per spec §6.

### 8.9 Acceptance criteria

- All test cases in §8.2 #17 pass.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme` clean on the final tree.
- Coverage thresholds in `vitest.config.ts` not regressed.
- `freelo --introspect` includes `projects list` with the expected flag set.
- `freelo projects list --help` is self-documenting (mentions all five scopes, all three pagination modes, `--fields`).
- The changeset captures the new `freelo.projects.list/v1` envelope as a public schema commitment.

```
ARCHITECT phase=plan run=2026-04-26-r03-projects-list status=ok files=20 commits=5 new_deps=cli-table3@0.6.5
```
