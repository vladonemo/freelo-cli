# Spec 0027 — `freelo comments list` (R16)

**Status:** Draft → Implement
**Run:** 2026-04-27-2234-comments-list
**Tier:** Yellow
**Roadmap:** R16 (`docs/roadmap.md:335-339`)
**Depends on:** R08 (`SubtaskSchema` paginated wrapper precedent), R03 (`fetchAllPages`, `pagingFromNormalized`, `PartialPagesError`)

---

## 1. Problem

R16 is the first vertical slice for the **comments** resource group. Today an agent driving the CLI cannot read comments at all — the only comment-related surface is implicit (e.g. `count_comments` on a task summary). R16 closes that gap with a single read command:

- `freelo comments list` — paginated activity feed of every comment the caller can see, with optional filters by project / type / time-window and the standard `--page` / `--all` paging dichotomy.

This is also the first leaf under a brand-new top-level `comments` subcommand. Subsequent slices (R17 — `comments add`, R18 — `comments edit/delete`) extend the same group.

## 2. API surface

### 2.1 `GET /all-comments` (the only documented endpoint)

OpenAPI :2665-2726.

- **Path:** `/all-comments`
- **Query params (all optional):**
  - `projects_ids[]: integer[]` — filter to comments under these projects (OR across ids).
  - `type: 'all'|'task'|'document'|'file'|'link'` — comment-target type (default `all`).
  - `order_by: 'date_add'|'date_edited_at'` — sort field (default `date_add`).
  - `order: 'asc'|'desc'` — sort direction (default `desc`).
  - `p: integer` — 0-indexed page (default 0). `PageParam` shared.
- **Response shape:** `PaginatedResponse` wrapper (`{ total, count, page, per_page, data: { comments: CommentFull[] } }`).
- **Item shape:** `CommentFull` (OpenAPI :5607-5667). Already-typed in this codebase? **No.** R16 introduces the first `CommentFull` schema (see §4.1).

### 2.2 What we explicitly do **not** call

- **`GET /task/{task_id}/comments`** — not documented in `docs/api/freelo-api.yaml`. Only the POST counterpart exists (:2576-2617). Calling it autonomously would violate the orchestrator's hard rule "never guess API behavior". Deferred (decision 1, recorded in `docs/runs/2026-04-27-2234-comments-list/decisions/01-scope-narrow.md`).

## 3. CLI surface

### 3.1 New top-level subcommand

```
freelo comments list [--project <id> ...] [--type <all|task|document|file|link>]
                     [--order-by <date_add|date_edited_at>] [--order <asc|desc>]
                     [--page N | --all] [--since YYYY-MM-DD]
```

Registered exactly like `tasks` / `subtasks`: a thin `register(program, getConfig, env)` in `src/commands/comments.ts` that creates the `comments` subcommand and delegates each leaf to a `register*` factory. R16 only ships `registerList`; future slices add `registerAdd` / `registerEdit` / `registerDelete`.

### 3.2 Flag reference

| Flag | Type / values | Default | Notes |
|---|---|---|---|
| `--project <id>` | positive int (repeatable) | — | Maps to wire `projects_ids[]`. Repeat for OR (`--project 11 --project 22`). |
| `--type <v>` | enum: `all` \| `task` \| `document` \| `file` \| `link` | `all` | Maps to wire `type`. |
| `--order-by <v>` | enum: `date_add` \| `date_edited_at` | `date_add` | Maps to wire `order_by`. |
| `--order <v>` | enum: `asc` \| `desc` | `desc` | Maps to wire `order`. |
| `--page <n>` | 1-indexed positive int | (omitted) | Single-page mode. **Mutex** with `--all`. CLI uses **1-indexed** for human ergonomics (mirrors `tasks list --page`); subtracted by 1 to map to wire 0-indexed `p=`. |
| `--all` | boolean | false | Iterate `?p=0,1,…` until exhausted. **Mutex** with `--page`. |
| `--since <YYYY-MM-DD>` | ISO date | (none) | **Client-side** post-filter on `date_add` (or `date_edited_at` when `--order-by date_edited_at` — see §4.3). Iteration short-circuits the moment an item's chosen-field timestamp falls strictly before `since` (server default order is `desc`, so this is bounded). **Mutex** with `--page N`. |

`--output`, `--color`, `--profile`, `-v`, `--request-id` are inherited globals.

#### 3.2.1 `--page` indexing convention

**Decision 2:** `--page` is **1-indexed** in the CLI (`--page 1` = first page). This matches the precedent set by `tasks list --page` (spec 0017 §2.5: `parsePositiveIntFlag('--page', ...)`, then `targetPage = page - 1`). Subtasks deviates (0-indexed) — but tasks/list is the more recent and audience-tested precedent and a 1-indexed CLI flag is standard human-facing UX (cf. `man more`, `gh pr list --page`, etc.).

The **wire** stays 0-indexed. The **envelope `paging.page`** echoes the wire value (0-indexed) — it's the cursor agents resume from, and consistency with the rest of the codebase (every other command's `paging.page` is wire-form) is more important than matching the human flag form. Documented in the user-facing doc.

#### 3.2.2 `--since` semantics (the only client-side bit)

`--since` is implemented as a **post-filter** because `/all-comments` does not accept any time-window query parameter. Three rules govern its behavior:

1. **Mutex with `--page N`.** Mixing them gives a misleading count: a fixed page might contain 0 matches and the user has no way to tell whether the rest of the feed has more. Validation error at parse time, exit 2.
2. **`--all` short-circuits.** The server's default order is `date_add desc` (or `date_edited_at desc` when `--order-by date_edited_at`). When iterating with `--all`, as soon as an item's order-field value falls **strictly before** the `since` cutoff, we stop fetching the next page and emit only the matches accumulated so far. This bounds the iteration cost.
3. **Default page (no `--page`, no `--all`).** Fetches `?p=0` only and post-filters that page. The envelope's `paging` reflects the wire response (so the count of unfiltered items on that page is recoverable from `paging.per_page` minus filtered-out count — but we explicitly **do not** mutate `total`/`per_page` to pretend the filter ran server-side). This is the CLI's "best-effort default" — agents that want exhaustive `--since` results should pass `--all`.

**Filter field selection.** When the user specified `--order-by`, the post-filter compares `--since` against the same field (so the short-circuit is monotonic with respect to iteration order). Otherwise it compares against `date_add` (the default). When `--order asc` is set, the **short-circuit is disabled** (we'd be iterating away from older items, so a single old item near the top doesn't tell us the rest of the feed predates `since`); we still post-filter each fetched page, but iterate to exhaustion.

`--since` is parsed as `YYYY-MM-DD` and treated as midnight-UTC (`<date>T00:00:00Z`) — same convention as R09's `--due` mapping.

### 3.3 Output schema: `freelo.comments.list/v1`

Envelope `data`:

```jsonc
{
  "applied_filters": {
    "projects": [11, 22],          // present only when --project given
    "type": "task",                // present only when --type given (always present otherwise? no — omitted when default)
    "order_by": "date_add",        // present only when --order-by given
    "order": "desc",               // present only when --order given
    "since": "2026-04-01"          // present only when --since given
  },
  "comments": [CommentFull, ...]   // CommentFull from §4.1
}
```

Envelope-level fields:

- `paging`: present on every response.
  - **`--page N`** (1-indexed CLI → 0-indexed wire): `paging` reflects the wire response.
  - **`--all`**: synthesized — `page: 0, per_page: <merged-length-after-filter>, total: <observed-server-total>, next_cursor: null` (mirrors R03/R14 `--all` convention).
  - **Default** (no `--page`, no `--all`): `paging` reflects the wire response for `p=0`. **Note:** when `--since` post-filters out items, `paging.per_page` and `paging.total` continue to reflect the **server-side wire values**, not the post-filtered counts. We do not invent server-side numbers we did not get from the server.
- `rate_limit`: from the last GET (last fetched page when `--all`).
- `notice`: present on `--all` partial-pages failure (mirrors R03/R14) — preserved exactly from prior commands.

### 3.4 Human renderer

`cli-table3` with columns: `id`, `type`, `project`, `task`, `author`, `date_add`, `content` (truncated). Empty list → "(no comments)" line.

`type` is derived per-row from `CommentFull.task != null ? 'task' : (.document != null ? 'document' : (.file != null ? 'file' : (.link != null ? 'link' : '?'))`.

`project` shows `project.name` (or `-` if unset). `task` shows `task.name` (or `-`). `author` shows `author.fullname` (or `author.id`). `date_add` is sliced to `YYYY-MM-DD`. `content` is truncated to 60 chars with the standard ellipsis.

## 4. Data model

### 4.1 New wire schema — `CommentFull`

Lives in **new file** `src/api/schemas/comment.ts` (mirrors `subtask.ts` keeping the resource scoped to its own file).

```ts
import { z } from 'zod';
import { UserBasicSchema } from './user.js';     // R02 — already exists?
// ...if UserBasicSchema lives in another file, we re-export from there.

/**
 * `CommentFull` — single item in the `/all-comments` paginated response.
 * OpenAPI :5607-5667. Corresponds to the union of "task comment", "document
 * comment", "file comment", "link comment" — discriminated only by which of
 * `task` / `document` / `file` / `link` is non-null on a given row.
 *
 * All entity-link blocks (`task`, `document`, `file`, `link`) are
 * `.nullable().optional()` to match the spec.
 */
export const CommentFullSchema = z.object({
  id: z.number().int().nullable().optional(),
  uuid: z.string().nullable().optional(),
  content: z.string(),
  date_add: z.string(),                          // ISO datetime
  date_edited_at: z.string(),                    // ISO datetime (matches `date_add` for never-edited)
  author: UserBasicSchema,
  task: z.object({ id: z.number().int(), name: z.string() }).nullable().optional(),
  tasklist: TasklistBasicSchema.nullable().optional(),
  project: ProjectBasicSchema.nullable().optional(),
  document: z.object({ uuid: z.string(), name: z.string() }).nullable().optional(),
  link: z.object({ uuid: z.string(), name: z.string() }).nullable().optional(),
  file: z.object({ uuid: z.string() }).nullable().optional(),
  files: z.array(FileFullSchema).optional(),
}).passthrough();

export type CommentFull = z.infer<typeof CommentFullSchema>;
```

`UserBasicSchema`, `TasklistBasicSchema`, `ProjectBasicSchema`, `FileFullSchema` already exist in the codebase (`src/api/schemas/users-me.ts`, `tasklist.ts`, `project.ts`, `task.ts` respectively — confirm during implement; if any is missing, declare a minimal local version with `.passthrough()`). The implementer may inline minimal versions if cross-file imports are awkward; tests assert the field set on the envelope, not the imported symbol.

#### 4.1.1 Envelope-data schema

In the same file:

```ts
/**
 * `freelo.comments.list/v1` envelope `data` shape.
 *
 *   - `applied_filters`: echo of the user's parsed flags (only keys explicitly
 *     set are emitted; unset keys are omitted, mirroring `tasks list`).
 *   - `comments`: post-filtered `CommentFull` array.
 */
export const CommentsListAppliedFiltersSchema = z.object({
  projects: z.array(z.number().int()).optional(),
  type: z.enum(['all', 'task', 'document', 'file', 'link']).optional(),
  order_by: z.enum(['date_add', 'date_edited_at']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  since: z.string().optional(),     // YYYY-MM-DD
});
export type CommentsListAppliedFilters = z.infer<typeof CommentsListAppliedFiltersSchema>;

export const CommentsListDataSchema = z.object({
  applied_filters: CommentsListAppliedFiltersSchema,
  comments: z.array(CommentFullSchema),
});
export type CommentsListData = z.infer<typeof CommentsListDataSchema>;
```

`applied_filters` is **always** an object (possibly empty `{}`). Mirrors `tasks list`'s `applied_filters` precedent.

### 4.2 New wire wrapper

New file `src/api/comments.ts`:

```ts
import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';
import { CommentFullSchema, type CommentFull } from './schemas/comment.js';
import { type NormalizedPage, normalizePaginated } from './pagination.js';
import { buildQuery } from '../lib/query.js';

export type FetchOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type AllCommentsFilters = {
  projects?: readonly number[];
  type?: 'all' | 'task' | 'document' | 'file' | 'link';
  orderBy?: 'date_add' | 'date_edited_at';
  order?: 'asc' | 'desc';
};

export type AllCommentsOpts = FetchOpts & {
  /** 0-indexed page; mapped to `?p=N` on the wire. */
  page: number;
  filters: AllCommentsFilters;
};

export type CommentsListResult = {
  page: NormalizedPage<CommentFull>;
  raw: ApiResponse<unknown>;
};

export async function getAllComments(
  client: HttpClient,
  opts: AllCommentsOpts,
): Promise<CommentsListResult> {
  const { filters } = opts;
  const params: Record<
    string,
    string | number | boolean | readonly (string | number)[] | undefined
  > = { p: opts.page };
  if (filters.projects !== undefined && filters.projects.length > 0) {
    params['projects_ids[]'] = filters.projects;
  }
  if (filters.type !== undefined) params['type'] = filters.type;
  if (filters.orderBy !== undefined) params['order_by'] = filters.orderBy;
  if (filters.order !== undefined) params['order'] = filters.order;

  const qs = buildQuery(params);
  const path = qs.length > 0 ? `/all-comments?${qs}` : '/all-comments';
  const raw = await client.request({
    method: 'GET',
    path,
    schema: z.unknown(),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  const page = normalizePaginated(raw.data, 'comments', CommentFullSchema);
  return { page, raw };
}
```

The pattern mirrors `getAllTasks` byte-for-byte (R07 spec 0017 §4.3).

### 4.3 Client-side `--since` filter

Pure helper, exported for unit-testing:

```ts
/**
 * Compare a comment's date field against the `since` cutoff (parsed once at the
 * call site). Returns `true` when the comment is `>= since`.
 *
 * `field` is `'date_add'` (default) or `'date_edited_at'` — whichever the user
 * chose with `--order-by`.
 */
export function commentMatchesSince(
  c: { date_add: string; date_edited_at?: string },
  cutoffMs: number,
  field: 'date_add' | 'date_edited_at',
): boolean {
  const raw = field === 'date_edited_at' ? (c.date_edited_at ?? c.date_add) : c.date_add;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return true;     // tolerate malformed dates by including
  return t >= cutoffMs;
}
```

Short-circuit logic in the `--all` path:

```ts
// Inside fetchAllPages's onPage callback, when --since is set AND order is desc:
//   if the LAST item on the page has timestamp < cutoff → after applying the
//   filter, set a flag that aborts the next iteration.
//
// Implemented by having the command's fetchPage wrapper check the *first* page's
// last item, and throw a sentinel error after one final page if the cutoff is
// crossed. Cleaner alternative: track the cutoff state, and in the wrapper
// pre-check before fetching p+1, return a synthesized empty page.
//
// Since fetchAllPages is generic over `(p) => Promise<NormalizedPage<T>>`, the
// command-side wrapper holds the cutoff state and can short-circuit by
// returning a synthetic terminal page whose `nextCursor: null`.
```

The implementer chooses the cleanest concrete realization; the unit test on `--all` short-circuit (test #18 below) locks the externally observable behavior.

### 4.4 No new dependencies

`zod`, `cli-table3`, `chalk` are already pinned and lazy-imported. Nothing else needed.

## 5. Edge cases

| Case | Behaviour |
|---|---|
| All flags omitted | Default `?p=0`, type=all (server default), no client filter. Exit 0. |
| `--project` non-numeric / zero / negative | `ValidationError` (exit 2). |
| `--type <bogus>` | `ValidationError` (exit 2; lists valid values). |
| `--order-by <bogus>` | `ValidationError` (exit 2; lists valid values). |
| `--order <bogus>` | `ValidationError` (exit 2; lists valid values). |
| `--page <0>` / negative / non-numeric | `ValidationError` (exit 2; "1-indexed positive integer"). |
| `--page` and `--all` together | `ValidationError` (exit 2). |
| `--since <not-iso>` | `ValidationError` (exit 2; "YYYY-MM-DD format"). |
| `--since` with `--page N` | `ValidationError` (exit 2; "client-side --since is mutex with --page; combine with --all or omit --page"). |
| GET 401 | `AUTH_EXPIRED`, exit 3. |
| GET 403 | `FORBIDDEN`, exit 4. |
| GET 404 | `NOT_FOUND`, exit 4. (Not expected on `/all-comments` without resource scoping; documented for completeness.) |
| GET 5xx | `SERVER_ERROR`, exit 4. |
| GET 429 (after read retry exhaustion) | `RATE_LIMITED`, exit 6. |
| Network failure | `NETWORK_ERROR`, exit 5. |
| `--all` mid-stream 5xx after at least one successful page | Partial envelope on stdout + `notice`; throws inner cause → exit derived (4 for 5xx). |

## 6. Non-goals

- **No `--task` flag.** Deferred (see Open Questions §7). Carries a non-goal entry in the spec because the original R16 roadmap text listed it.
- **No `--per-page` flag.** Server controls page size (default 25 per `PaginatedResponse`). Future expansion is strictly additive.
- No server-side `--since` (no API surface). The client-side post-filter is the only available implementation.
- No `--cursor <n>` flag in v1. (`tasks list` has it; subtasks list does not. Comments mirrors subtasks here for the lighter v1 surface — easy to add later as additive.)
- No `--fields` projection in v1. Same deferral logic.

## 7. Open questions

**OQ #1 — Task-scoped comment listing.** The original R16 roadmap entry mentioned `GET /task/{task_id}/comments`. That endpoint is **not in `docs/api/freelo-api.yaml`**. Two options for the future:

- (a) Freelo confirms the GET exists undocumented → capture the response shape via `freelo-api-specialist` (with `--allow-network`) and add it as an additive `--task` flag in a follow-up slice.
- (b) Freelo adds the GET to the spec → same path, no probing needed.

Until then, agents wanting task-scoped comments should `freelo comments list --type task | jq '.data.comments[] | select(.task.id == 9012)'`. The user-facing doc shows this composition example.

**No other open questions.** The OpenAPI spec resolves every other shape question. The CLI conventions (1-indexed `--page`, `applied_filters` echo shape, partial-pages handling) are decided autonomously per `.claude/docs/autonomous-sdlc.md` "Small UX choices with a clear precedent in the codebase → Decide, log".

## 8. Mandatory tests

Per Calibration §1-4. **Every error path that the spec assigns an exit code MUST have a test asserting that exit code.** Tests live in `test/commands/comments/list.test.ts` and `test/api/comments.test.ts` (pure-function / wire-wrapper tests).

### 8.1 Happy paths

1. Default invocation (no flags): `?p=0`, envelope `schema: 'freelo.comments.list/v1'`, `data.applied_filters` is `{}`, `data.comments[]` populated, `paging.page: 0`, `paging.next_cursor: null` (when fewer than per_page items). Exit 0.
2. `--page 1` (CLI 1-indexed): wire request asserts `?p=0`, envelope `paging.page: 0`. Exit 0.
3. `--page 3`: wire request asserts `?p=2`. Exit 0.
4. `--all`, two pages: merged `data.comments.length === sum`, `paging.next_cursor: null`, `paging.total === server-reported total of last page`. Exit 0.
5. `--project 11 --project 22`: wire request asserts both `projects_ids[]=11&projects_ids[]=22`. `applied_filters.projects: [11, 22]`. Exit 0.
6. `--type task`: wire request asserts `type=task`. `applied_filters.type: 'task'`. Exit 0.
7. `--order-by date_edited_at --order asc`: wire request asserts both; `applied_filters` reflects both. Exit 0.
8. `--since 2026-04-01`: client-side filter. Page 0 fixture has 3 items, two with `date_add >= 2026-04-01` and one before. Exit 0; envelope `data.comments` length 2; `applied_filters.since: '2026-04-01'`.
9. `--since` + `--all`: stream stops as soon as a page's last item predates the cutoff. Fixture: page 0 entirely matches, page 1 entirely predates → after fetching page 1, no further pages requested even if server says `total > sum`. Exit 0.
10. `--since` + `--all` + `--order asc`: short-circuit **disabled**; iterates to exhaustion (server signal: `next_cursor === null`) and post-filters each page individually. Exit 0.
11. Empty server response (`comments: []`): `data.comments: []`, `paging.total: 0`. Exit 0.
12. Human renderer (TTY): `cli-table3` table on default invocation; `(no comments)` line when empty.
13. `--request-id <uuid>` round-trips into envelope.

### 8.2 Validation (exit 2)

14. `--project 0` → exit 2.
15. `--project abc` → exit 2.
16. `--type bogus` → exit 2.
17. `--order-by bogus` → exit 2.
18. `--order bogus` → exit 2.
19. `--page 0` → exit 2 (1-indexed; first page is `--page 1`).
20. `--page abc` → exit 2.
21. `--page 1 --all` → exit 2 (mutex).
22. `--since not-a-date` → exit 2.
23. `--since 2026-13-99` → exit 2 (real-date check).
24. `--since 2026-04-01 --page 1` → exit 2 (mutex; specific message about combining with `--all`).

### 8.3 HTTP errors

25. GET 401 → `AUTH_EXPIRED`, exit 3.
26. GET 403 → `FORBIDDEN`, exit 4.
27. GET 404 → `NOT_FOUND`, exit 4.
28. GET 5xx → `SERVER_ERROR`, exit 4.
29. GET 429 (after retry exhaustion) → `RATE_LIMITED`, exit 6.
30. Network failure → `NETWORK_ERROR`, exit 5.

### 8.4 Pagination edge

31. `--all` mid-stream 5xx after page 0 success: partial envelope on stdout + `notice` + exit 4 (inner cause).
32. `--all` fail at page 0 (no successful pages): error propagates, no stdout envelope, exit derived.

### 8.5 Pure unit tests (`test/api/comments.test.ts`)

33. `commentMatchesSince` — date_add after cutoff → true.
34. `commentMatchesSince` — date_add before cutoff → false.
35. `commentMatchesSince` — date_add at cutoff → true (`>= since`, inclusive).
36. `commentMatchesSince` — `field: 'date_edited_at'` uses that field.
37. `commentMatchesSince` — malformed date → true (tolerant).
38. `getAllComments` — builds `?p=0` URL with no filters.
39. `getAllComments` — encodes `projects_ids[]=11&projects_ids[]=22` correctly.
40. `getAllComments` — encodes `type=task&order_by=date_edited_at&order=asc`.

### 8.6 Introspect

41. `freelo --introspect` shows `comments list` with `output_schema: 'freelo.comments.list/v1'` and `destructive: false`.

## 9. Decisions (autonomous)

1. **Top-level subcommand path**: `comments` (per roadmap text; mirrors `tasks` / `tasklists` / `subtasks` precedent — plural noun for resource collections).
2. **`--page` is 1-indexed in the CLI**, mapped to 0-indexed wire. Mirrors `tasks list`. Envelope `paging.page` echoes the wire (0-indexed) — agents resume from wire form. `subtasks list` deviates (0-indexed CLI flag), but `tasks list` is the more recent and audience-tested precedent for a paginated **list** command, and 1-indexed is the human-facing standard.
3. **Schema name**: `freelo.comments.list/v1`. Decided per CLAUDE.md envelope contract.
4. **`applied_filters` always present, possibly `{}`.** Matches `tasks list`. Keeps the envelope shape uniform across `--no-flags` and `--all-flags` invocations — agents always destructure the same key.
5. **`--since` is client-side**, mutex with `--page N`, short-circuits in `desc` order under `--all`. Decided per resume answer (option B). Filter field follows `--order-by` (default `date_add`); `--order asc` disables short-circuit (correctness over latency).
6. **`--since` parses as `YYYY-MM-DD` → midnight UTC** (`Date.parse(<date>T00:00:00Z)`). Mirrors R09 / R14 date conventions.
7. **`paging.per_page` and `paging.total` are NEVER mutated by the post-filter.** They reflect server-side wire values. The user-facing doc explains.
8. **`CommentFull` schema lives in `src/api/schemas/comment.ts`** (new file). Mirrors `subtask.ts` co-location convention.
9. **No `--cursor` flag in v1.** Mirrors `subtasks list` (lighter v1; future-additive).
10. **No `--fields` projection in v1.** Same.
11. **No `--per-page` flag in v1.** Server defaults are good enough; future-additive.
12. **Hint rewriter for `getAllComments`** — none. Unlike `subtasks list` (which surfaces resource-scoped hints for 404/403 about a specific task), `/all-comments` is global; standard error-mapper hints are appropriate.
13. **Pagination `--all` partial-result handling** — reuse `fetchAllPages` + `PartialPagesError` directly. Same envelope-with-notice pattern as R03 / R14.
14. **Test fixtures** — inline `HttpResponse.json(...)` in MSW handlers (mirrors R13 / R14 / R15). No on-disk JSON.
15. **Subtask wire fields tolerated via `.passthrough()`** in `CommentFullSchema`. Future server fields don't break the schema.
16. **`request_id` plumbing** — through `appConfig.requestId`. Mirrors all prior commands.
17. **Roadmap entry update** — `docs/roadmap.md:335-339` reduced to the actual shipped flag set, with footnote about deferred `--task`. Decision recorded in `docs/runs/2026-04-27-2234-comments-list/decisions/01-scope-narrow.md`.
18. **OQ #1 (task-scoped comments)** — left open in the spec; not blocking R16 ship.
19. **`UserBasic` / `TasklistBasic` / `ProjectBasic` reuse** — if the imports are awkward, the implementer may inline minimal local zod versions with `.passthrough()`. The envelope shape is asserted by tests, not by import-graph topology.
20. **`comments add` / `edit` / `delete`** are explicit non-goals for R16, even though they share the parent `comments` subcommand.

## 10. Plan

### 10.1 Files to create

- `src/api/schemas/comment.ts` (~80 lines) — `CommentFullSchema`, `CommentsListAppliedFiltersSchema`, `CommentsListDataSchema`, types.
- `src/api/comments.ts` (~80 lines) — `getAllComments`, `commentMatchesSince`, types.
- `src/commands/comments.ts` (~25 lines) — parent registrar, mirrors `subtasks.ts`.
- `src/commands/comments/list.ts` (~280 lines) — Commander registration + flag parsing + mutex checks + paginated fetch via `fetchAllPages` + `--since` short-circuit + envelope build.
- `src/ui/human/comments-list.ts` (~80 lines) — `cli-table3` renderer with lazy import, mirrors `subtasks-list.ts`.
- `test/commands/comments/list.test.ts` (~700 lines) — tests 1-32 + 41.
- `test/api/comments.test.ts` (~120 lines) — tests 33-40 (pure functions / URL building).
- `.changeset/r16-comments-list.md` — `freelo-cli: minor`. Documents the new schema as additive surface.
- `docs/commands/comments-list.md` — user-facing doc.

### 10.2 Files to modify

- `src/bin/freelo.ts` — register the new top-level `comments` command (one-line `register` call alongside `subtasks`).
- `test/msw/handlers.ts` — append `commentsListHandlers` (paginated GET + 401/403/404/429/5xx/network/midstream).
- `docs/roadmap.md` — update R16 entry per decision 1: drop `--task`, add footnote.
- `README.md` — auto-regenerated by `pnpm fix:readme`.

### 10.3 No new dependencies

`zod`, `cli-table3`, `chalk` already pinned. `@inquirer/prompts` not needed (read-only command). Nothing else.

### 10.4 Test strategy

- **Unit (no I/O):** `commentMatchesSince`, `getAllComments` URL-building. MSW server **not** started for the URL-building tests (use a fake `HttpClient`).
- **Integration (MSW):** `list` command tests use `runCli(run, [...])` with `captureOutput()`. Spy `process.exit` to throw `EXIT:N`. TTY state mocked via `Object.defineProperty(process.stdout, 'isTTY', ...)`.
- **Coverage**: 80% lines overall, 90% on `src/api/` and `src/commands/`. New `src/api/comments.ts` and `src/api/schemas/comment.ts` need ≥90%; commander registration needs full happy-path + every typed-error path with `exitCode` assertion (Calibration §2).
- **Pagination + short-circuit**: same `fetchAllPages` + `PartialPagesError` recovery pattern as R03 / R14. Test #9 explicitly locks the `--since` short-circuit behavior: setup MSW with 3 pages where page 1's items all predate `since`, assert page 2 is **never** requested.

### 10.5 Rollout order (one PR, one commit)

Single squash commit: `feat(commands): r16 — \`freelo comments list\` (--since client-side post-filter)`. Yellow tier: open PR, do **not** enable auto-merge. Leave for human review.

### 10.6 Risks / mitigations

- **R: client-side `--since` mis-interaction with `--order asc`.** The short-circuit only works for `desc` (default). Mitigation: §3.2.2 rule 3 — `--order asc` disables short-circuit; test #10 locks it.
- **R: agents may be confused by `paging.per_page` not matching `data.comments.length` after `--since` post-filter.** Mitigation: documented in user-facing doc (§3.3 note + docs/commands/comments-list.md). Also: test #8 explicitly asserts the wire `paging` is preserved.
- **R: `CommentFull` schema drift.** OpenAPI shape may evolve. Mitigation: `.passthrough()` on the schema (decision 15); future-additive. No test on absent fields.
- **R: `--since` is a foot-gun on default-page invocation** (silent under-counting when the cutoff is older than a page-0-end timestamp). Mitigation: doc explicitly recommends `--all` for exhaustive `--since`, and the mutex rule with `--page N` already prevents the worst case.
- **R: branch coverage on new try/catch arms (Calibration §4).** The leaf adds catch arms for 5 typed error mappings (in the wire fetch path) and the `PartialPagesError` unwrap. Each arm gets a dedicated test (#25-30, #31-32).
