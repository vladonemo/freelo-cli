# Spec 0033 — `freelo reports list` (R21)

**Status:** Draft → Implement
**Run:** 2026-04-28-2111-r21-reports-list
**Tier:** Yellow
**Roadmap:** R21 (`docs/roadmap.md:433-438`)
**Depends on:** R07 (`tasks list` — query helper, paging precedent), R03 (`fetchAllPages`, `pagingFromNormalized`, `PartialPagesError`), R16 (`comments list` — scope-narrowing precedent for missing task-scoped GET)

---

## 1. Problem

R21 is the first vertical slice for the **reports** (work-reports / time-entries) resource group. Today, after R19 / R20 (`time start/stop/edit/status`), an agent can drive the live timer but cannot read the historical record of finalized work reports. R21 closes that gap with a single read command:

- `freelo reports list` — paginated list of every work report the caller can see, with filter combinations across project, worker, task, and a reported-date window.

R22 will follow with `reports log` / `reports edit` / `reports delete` (the write surface). Subsequent slices extend the same `reports` namespace.

## 2. API surface

### 2.1 `GET /work-reports` (the only documented list endpoint)

OpenAPI `docs/api/freelo-api.yaml:2947-3043`.

- **Path:** `/work-reports`
- **Query params (all optional):**
  - `projects_ids[]: integer[]` — filter to reports whose project is in this set.
  - `users_ids[]: integer[]` — filter by worker id (the user whose time is logged).
  - `tasks_ids[]: integer[]` — filter by task id.
  - `tasks_labels[]: string[]` — filter by task-label UUIDs (deferred from R21 — agents that need this can hand-craft `--filter` via R22+; not in the roadmap line).
  - `date_reported_range[date_from]: string (date)` — inclusive lower bound on `date_reported`.
  - `date_reported_range[date_to]: string (date)` — inclusive upper bound on `date_reported`.
  - `date_add_range[date_from] / [date_to]` — server-side filter on `date_add`. Not surfaced in v1 (the roadmap line names only `--from` / `--to`, mapping to the more useful `date_reported_range`).
  - `date_edited_from: string (date)` — incremental-sync filter; not surfaced in v1.
  - `with_own_taskless: boolean` — implicitly scopes to caller. Not surfaced in v1 (load-bearing footgun; explicit defer).
  - `p: integer` — 0-indexed page (default 0). `PageParam` shared.
- **Response shape:** `PaginatedResponse` wrapper (`{ total, count, page, per_page, data: { reports: WorkReportFull[] } }`).
- **Item shape:** `WorkReportFull` (OpenAPI `:5713-5771`) — extends `WorkReport` (`:5669-5698`) with extra task/project/tasklist context fields.

### 2.2 What we explicitly do **not** call

- **`GET /task/{task_id}/work-reports`** — not in `docs/api/freelo-api.yaml`. Only the POST counterpart exists (`:3045-3093`, used by R22). Calling it autonomously would violate the orchestrator's hard rule "never guess API behavior". The roadmap line names this endpoint, but the same precedent applied to R16 (comments-list) — narrow to the global endpoint with a `--task` filter mapped to the documented `tasks_ids[]` parameter. Decision logged at `docs/decisions/2026-04-28-2111-r21-reports-list-1-scope-narrow.md`.

## 3. CLI surface

### 3.1 New top-level subcommand namespace

```
freelo reports list [--task <id>...] [--project <id>...] [--worker <id>...]
                    [--from YYYY-MM-DD] [--to YYYY-MM-DD]
                    [--page N | --all]
```

Registered exactly like `comments` / `time`: a thin `register(program, getConfig, env)` in `src/commands/reports.ts` that creates the `reports` subcommand and delegates to `registerList`. R21 only ships `registerList`; R22 adds `registerLog` / `registerEdit` / `registerDelete`.

### 3.2 Flag reference

| Flag | Type / values | Default | Notes |
|---|---|---|---|
| `--task <id>` | positive int (repeatable) | — | Maps to wire `tasks_ids[]`. Repeat for OR. R21 uses repeatable form — single `--task <id>` is the most common case but the wire field is array-shaped, and aligning early avoids a breaking change later. |
| `--project <id>` | positive int (repeatable) | — | Maps to wire `projects_ids[]`. Repeat for OR. |
| `--worker <id>` | positive int (repeatable) | — | Maps to wire `users_ids[]`. Repeat for OR. |
| `--from <YYYY-MM-DD>` | ISO date | (none) | Maps to wire `date_reported_range[date_from]` (inclusive). |
| `--to <YYYY-MM-DD>` | ISO date | (none) | Maps to wire `date_reported_range[date_to]` (inclusive). |
| `--page <n>` | 1-indexed positive int | (omitted) | Single-page mode. **Mutex** with `--all`. CLI uses **1-indexed** for human ergonomics (mirrors `comments list --page` / `tasks list --page`). Subtracted by 1 to map to wire 0-indexed `p=`. |
| `--all` | boolean | false | Iterate `?p=0,1,…` until exhausted. **Mutex** with `--page`. |

`--output`, `--color`, `--profile`, `-v`, `--request-id` are inherited globals.

#### 3.2.1 Why `--task` / `--project` / `--worker` are repeatable

The wire fields (`tasks_ids[]`, `projects_ids[]`, `users_ids[]`) are array-shaped per OpenAPI. The most common agent invocation is single-value, but repeating for OR-across-ids matches the documented server behavior and matches the precedent set by `comments list --project` and `tasks list --worker`. The roadmap line shows `--task <id>` (singular), but that's a writing convention — the runtime supports `--task 11 --task 22`.

#### 3.2.2 `--from` / `--to` semantics

Both are validated client-side as `YYYY-MM-DD` (same regex used in `comments list --since`). They map directly onto `date_reported_range[date_from]` / `date_reported_range[date_to]` — server-side filters, not client post-filters. Server treats them as inclusive (per Freelo convention; same as `due_date_range` on `tasks list`).

When **both** are given and `from > to`, we let the server return zero results (no client-side mutex check). Validating that combination client-side would just duplicate the server's behavior — the CLI errs on the side of letting the server own its semantic rules.

#### 3.2.3 `--page` indexing convention

**Decision 2:** `--page` is **1-indexed** in the CLI (`--page 1` = first page). Same as `comments list` / `tasks list` (spec 0027 §3.2.1). The **wire** stays 0-indexed; the **envelope `paging.page`** echoes the wire value (0-indexed) — so agents resume from the cursor the server returned, regardless of the human flag form.

### 3.3 Output schema: `freelo.reports.list/v1`

Envelope `data`:

```jsonc
{
  "applied_filters": {
    "tasks": [9012, 9013],          // present only when --task given
    "projects": [11, 22],            // present only when --project given
    "workers": [7],                  // present only when --worker given
    "from": "2026-04-01",            // present only when --from given
    "to":   "2026-04-30"             // present only when --to given
  },
  "reports": [WorkReportFull, ...]   // see §4.1
}
```

Envelope-level fields:

- `paging`: present on every response.
  - **`--page N`** (1-indexed CLI → 0-indexed wire): `paging` reflects the wire response.
  - **`--all`**: synthesized — `page: 0, per_page: <merged-length>, total: <observed-server-total>, next_cursor: null` (mirrors R03/R16 `--all` convention via `pagingFromNormalized` on the merged page).
  - **Default** (no `--page`, no `--all`): `paging` reflects the wire response for `p=0`.
- `rate_limit`: from the last GET (last fetched page when `--all`).
- `notice`: present on `--all` partial-pages failure (mirrors R03/R16) — preserved exactly from prior commands.

### 3.4 Human renderer

`cli-table3` with columns: `id`, `date`, `worker`, `project`, `task`, `minutes`, `note` (truncated). Empty list → `(no work reports)` line.

- `id` — `WorkReportFull.id`, fallback `-`.
- `date` — `date_reported` slice (already `YYYY-MM-DD` per OpenAPI).
- `worker` — `worker.fullname` or numeric id, `-` when missing (mirrors `comments list` author-cell formatter).
- `project` — `project.name` or `-`.
- `task` — `task.name` or `-`.
- `minutes` — integer; right-aligned conceptually but cli-table3 default is fine.
- `note` — truncated to 60 chars (or `-` when null/empty).

## 4. Data model

### 4.1 New wire schemas — `WorkReportFull` family

New file: `src/api/schemas/report.ts`. Loose-by-design (passthrough, nullable+optional on most non-id fields), mirroring the conventions in `src/api/schemas/comment.ts` and `src/api/schemas/task.ts`.

```ts
const CurrencySchema = z.object({
  amount: z.union([z.string(), z.number()])
    .refine((v) => typeof v === 'string' || (Number.isFinite(v) && !Number.isNaN(v)),
            { message: 'amount must be a finite number or a string' })
    .transform((v) => String(v)),
  currency: z.enum(['CZK', 'EUR', 'USD']),
});
// Same shape and rationale as src/api/schemas/project.ts CurrencySchema —
// declared locally here per the precedent in tasklist.ts / task.ts (avoid
// cross-file private exports).

const TaskRefSchema = z.object({
  id: z.number().int(),
  name: z.string().nullable().optional(),
  minutes: z.number().int().nullable().optional(),
  parent_task_id: z.number().int().nullable().optional(),
  cost: CurrencySchema.nullable().optional(),
  // Loose: omit `labels`, `total_time_estimate`, `users_time_estimates`
  // from the typed surface (passthrough() preserves them in case agents
  // want to extract them; not part of the v1 envelope contract).
}).passthrough();

const ProjectRefSchema = z.object({
  id: z.number().int(),
  name: z.string().nullable().optional(),
}).passthrough();

const TasklistRefSchema = z.object({
  id: z.number().int(),
  name: z.string().nullable().optional(),
}).passthrough();

const UserBasicSchema = z.object({
  id: z.number().int(),
  fullname: z.string().nullable().optional(),
}).passthrough();
// Local copy rather than import — `UserBasicSchema` from `project.ts` does
// NOT use passthrough(); the WorkReport `author`/`worker` fields can carry
// avatar/email on some endpoints. Stay loose.

export const WorkReportFullSchema = z.object({
  id: z.number().int(),
  date_add: z.string().nullable().optional(),         // ISO date-time
  date_reported: z.string(),                          // YYYY-MM-DD; required per spec
  date_edited_at: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  minutes: z.number().int(),
  cost: CurrencySchema.nullable().optional(),
  author: UserBasicSchema.nullable().optional(),
  worker: UserBasicSchema.nullable().optional(),
  task: TaskRefSchema.nullable().optional(),
  tasklist: TasklistRefSchema.nullable().optional(),
  project: ProjectRefSchema.nullable().optional(),
}).passthrough();

export type WorkReportFull = z.infer<typeof WorkReportFullSchema>;

export const ReportsListAppliedFiltersSchema = z.object({
  tasks: z.array(z.number().int()).optional(),
  projects: z.array(z.number().int()).optional(),
  workers: z.array(z.number().int()).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type ReportsListAppliedFilters = z.infer<typeof ReportsListAppliedFiltersSchema>;

export const ReportsListDataSchema = z.object({
  applied_filters: ReportsListAppliedFiltersSchema,
  reports: z.array(WorkReportFullSchema),
});
export type ReportsListData = z.infer<typeof ReportsListDataSchema>;
```

**Loose schema rationale:** every consumer of a Freelo entity in this codebase has had at least one shape surprise (R05.5 fixed three of them at once). Defaulting to passthrough + nullable.optional on every block is cheap insurance; agents can downcast in their own consumers if they want strictness.

### 4.2 Wire wrapper — `getWorkReports`

New file: `src/api/reports.ts`. Mirrors `getAllComments` byte-for-byte modulo names.

```ts
export type WorkReportsFilters = {
  tasks?: readonly number[];
  projects?: readonly number[];
  workers?: readonly number[];
  from?: string;   // YYYY-MM-DD
  to?: string;     // YYYY-MM-DD
};

export type WorkReportsOpts = FetchOpts & {
  page: number;
  filters: WorkReportsFilters;
};

export type ReportsListResult = {
  page: NormalizedPage<WorkReportFull>;
  raw: ApiResponse<unknown>;
};

export async function getWorkReports(
  client: HttpClient,
  opts: WorkReportsOpts,
): Promise<ReportsListResult> {
  const params: Record<string, ...> = { p: opts.page };
  if (filters.tasks?.length)    params['tasks_ids[]']    = filters.tasks;
  if (filters.projects?.length) params['projects_ids[]'] = filters.projects;
  if (filters.workers?.length)  params['users_ids[]']    = filters.workers;
  if (filters.from !== undefined) params['date_reported_range[date_from]'] = filters.from;
  if (filters.to   !== undefined) params['date_reported_range[date_to]']   = filters.to;

  const qs = buildQuery(params);
  const path = qs.length > 0 ? `/work-reports?${qs}` : '/work-reports';
  const raw = await client.request({
    method: 'GET',
    path,
    schema: z.unknown(),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  const page = normalizePaginated(raw.data, 'reports', WorkReportFullSchema);
  return { page, raw };
}
```

`buildQuery` already emits the bracketed-array convention Freelo expects (`projects_ids%5B%5D=11`); `tests/lib/query.test.ts` covers it.

For `date_reported_range[date_from]` the bracket-encoding is identical (the helper percent-encodes `[` and `]` once via `URLSearchParams.append`).

## 5. Edge cases

1. **Empty result** — `total: 0`, `data.reports: []`. Envelope still emits `applied_filters` + `paging` + `rate_limit`; renderer prints `(no work reports)`.
2. **`--page N` past the end** — server returns `count: 0, data: { reports: [] }`. Envelope's `paging.next_cursor: null`; exit 0.
3. **Mutex `--page` / `--all`** — `ValidationError` (exit 2) at parse time, before any network call.
4. **Invalid `--from` / `--to`** — `ValidationError` (exit 2). Format: `YYYY-MM-DD` regex; `Date.parse` sanity check.
5. **Invalid `--task` / `--project` / `--worker`** — `ValidationError` (exit 2) for non-positive-int values.
6. **Auth / API failures** — `FreeloApiError` propagates with the right `httpStatus`. 401 → exit 4 with `code: 'AUTH_REQUIRED'` per the existing handler. 403 / 404 / 5xx → exit 4. 429 → `RateLimitedError` (exit 6) after retry exhaustion. Network → `NetworkError` (exit 5).
7. **`--all` mid-stream failure** — `PartialPagesError` unwrap path emits a partial envelope to stdout with `notice: "Partial result; iteration aborted at page <N>."` then re-throws for the right exit code. Same rate-limit and request-id metadata as the last successful page.
8. **Response schema mismatch** — `FreeloApiError` with `code: 'VALIDATION_ERROR'` (exit 4). Per `normalizePaginated`, the wrapper schema fails fast with the zod error message.
9. **`worker.fullname` absent** — passthrough + nullable.optional on `UserBasicSchema`. Renderer falls back to `String(worker.id)`. Same pattern as R05.5.
10. **`cost` returned as number on some rows, string on others** — `CurrencySchema` handles via union+transform. Already-tested in `src/api/schemas/project.ts` test file.

## 6. Non-goals (deferred to later slices)

- **`tasks_labels[]` filter** — useful but the roadmap line doesn't mention it; defer to a follow-up that can also surface labels read across `tasks list` / `comments list`.
- **`date_add_range[]` / `date_edited_from`** — incremental-sync usage; defer to a sync-oriented slice.
- **`with_own_taskless`** — load-bearing implicit caller scope (per OpenAPI footnote). Surface only with explicit thinking; defer.
- **`--currency` flag** — server defaults to CZK, OpenAPI documents that costs are converted. The envelope passes through `cost.currency` as-is; v1 does not surface a flag.
- **Task-scoped GET (`/task/{task_id}/work-reports`)** — not in the OpenAPI; tracked as potential R21.5.
- **`--fields` projection** — R03 ships the helper but R16 doesn't surface it; v1 of `reports list` keeps parity with `comments list` (no `--fields`). Easy to add later.

## 7. Open questions

None at draft time. The scope-narrowing decision is logged (decision 1) and follows R16 precedent. No human gate needed before plan.

## 8. Test plan (informs Phase 4 — test-writer)

Test file: `test/commands/reports/list.test.ts`. Pattern: `test/commands/comments/list.test.ts`.

**Happy paths:**
- Default invocation (no flags) → `?p=0`, `applied_filters: {}`, exit 0.
- `--page 1` → wire `p=0`; envelope `paging.page === 0`.
- `--page 3` → wire `p=2`; envelope `paging.page === 2`.
- `--all` across 2 pages — merged report list, `paging.next_cursor === null`.
- `--task 9012 --task 9013` → wire `tasks_ids[]=9012&tasks_ids[]=9013`; `applied_filters.tasks === [9012, 9013]`.
- `--project 11` → wire `projects_ids[]=11`.
- `--worker 7` → wire `users_ids[]=7`.
- `--from 2026-04-01 --to 2026-04-30` → wire `date_reported_range[date_from]=2026-04-01&date_reported_range[date_to]=2026-04-30`.
- All filters combined.
- Empty list — `(no work reports)` in human mode.
- `--request-id` round-trip (sent header + echoed in envelope).
- Introspect entry shows `output_schema: 'freelo.reports.list/v1'`, `destructive: false`.

**Validation paths (every typed error has an exit-code assertion — Calibration §2):**
- `--page` and `--all` together → `ValidationError`, exit 2.
- `--page abc` (non-int) → `ValidationError`, exit 2.
- `--page 0` (zero) → `ValidationError`, exit 2.
- `--task xyz` → `ValidationError`, exit 2.
- `--project 0` → `ValidationError`, exit 2.
- `--worker -1` → `ValidationError`, exit 2.
- `--from 2026/04/01` → `ValidationError`, exit 2.
- `--to 2026-13-99` → `ValidationError`, exit 2.

**HTTP error paths:**
- 401 → `FreeloApiError`, exit 4 with `AUTH_REQUIRED`.
- 403 → `FreeloApiError`, exit 4.
- 404 → `FreeloApiError`, exit 4.
- 5xx → `FreeloApiError`, exit 4.
- 429 with `Retry-After: 0` after retry exhaustion → `RateLimitedError`, exit 6.
- Network drop → `NetworkError`, exit 5.
- `--all` mid-stream 5xx after 1 success → partial envelope with `notice`, exit 4.

**Schema-validation path:**
- Server returns `data: { reports: [{ id: "not-a-number" }] }` → `FreeloApiError` with `code: 'VALIDATION_ERROR'` (exit 4).

Coverage targets: same as `src/commands/comments/list.ts` — 90%+ on `src/commands/reports/` and `src/api/reports.ts`.

## 9. Examples (agent-style)

```bash
# Default — first page, no filters
FREELO_API_KEY=$KEY FREELO_EMAIL=$EMAIL freelo reports list --output json

# Filter to one project, this month
FREELO_API_KEY=$KEY FREELO_EMAIL=$EMAIL freelo reports list \
  --project 235826 --from 2026-04-01 --to 2026-04-30 --output json

# Time spent by one worker on two specific tasks
FREELO_API_KEY=$KEY FREELO_EMAIL=$EMAIL freelo reports list \
  --worker 7 --task 9012 --task 9013 --all --output json
```

## 10. Wire-up checklist (informs Phase 6 — doc-writer)

- New page: `docs/commands/reports-list.md` (mirror `docs/commands/comments-list.md`).
- README autogen block refresh — `pnpm fix:readme` after the new command is registered.
- No new top-level help entry needed (covered by the `reports` namespace registration).
- No update to `docs/getting-started.md` in this slice (R22 will be the more "first-time-user" slice once writes land).

---

## Plan

File-level intent. Each row is one commit-sized change. No new runtime dependencies.

### New files

- **`src/api/schemas/report.ts`** — zod schemas: local `CurrencySchema`, `UserBasicSchema` (passthrough), `TaskRefSchema`, `ProjectRefSchema`, `TasklistRefSchema`, `WorkReportFullSchema`, `ReportsListAppliedFiltersSchema`, `ReportsListDataSchema`. Mirrors `src/api/schemas/comment.ts`.
- **`src/api/reports.ts`** — `getWorkReports(client, opts)` wire wrapper. Mirrors `getAllComments` in `src/api/comments.ts` byte-for-byte modulo names, schema, and the additional date-range params. Returns `{ page: NormalizedPage<WorkReportFull>, raw: ApiResponse<unknown> }`.
- **`src/ui/human/reports-list.ts`** — `cli-table3` renderer. Columns: ID, DATE, WORKER, PROJECT, TASK, MINUTES, NOTE. Empty fallback `(no work reports)`. Pattern: `src/ui/human/comments-list.ts`.
- **`src/commands/reports.ts`** — namespace registration: `register(program, getConfig, env)` creates the `reports` subcommand and delegates to `registerList`.
- **`src/commands/reports/list.ts`** — leaf command. Parses flags, mutex checks, default/--page/--all dispatch, dispatches to `getWorkReports`, builds envelope. Pattern: `src/commands/comments/list.ts`. Note: no `--since` post-filter (server-side date range is already documented), so `runAll` is simpler than the comments version (no short-circuit logic).
- **`test/commands/reports/list.test.ts`** — vitest + MSW. Covers every test bullet in §8. Pattern: `test/commands/comments/list.test.ts`.
- **`docs/commands/reports-list.md`** — user-facing doc page. Pattern: `docs/commands/comments-list.md`.
- **`.changeset/r21-reports-list.md`** — `freelo-cli: minor`; new command + new envelope schema callout per the schema-stability rule.

### Modified files

- **`src/bin/freelo.ts`** — add `const { register: registerReports } = await import('../commands/reports.js');` and the `registerReports(program, getAppConfig, env);` call after `registerTime`. Two-line edit.
- **`test/msw/handlers.ts`** — add `workReportsListHandlers` with `paged`, `unauthorized`, `forbidden`, `notFound`, `serverError`, `rateLimited`, `networkError`, `midStreamError`. Pattern: `commentsListHandlers`. URL: `${API_BASE}/work-reports`. Inner key: `reports`.
- **`README.md`** — refresh autogen `<!-- BEGIN AUTOGEN COMMANDS -->` block via `pnpm fix:readme` after the command lands.

### No-touch

- `src/api/client.ts` — unchanged. The HTTP client takes a `path` string; bracket encoding lives in `buildQuery`.
- `src/api/pagination.ts` — `normalizePaginated` and `fetchAllPages` already handle the `{ data: { reports: [...] } }` shape via the `innerKey` parameter.
- `src/lib/query.ts` — already emits `key[]=value` repeating-array form; bracket-in-key (`date_reported_range[date_from]`) is handled identically (URLSearchParams percent-encodes both forms once).
- `src/errors/*` — no new error classes; reuse `ValidationError`, `FreeloApiError`, `RateLimitedError`, `NetworkError`.
- `src/ui/envelope.ts` — no new envelope-level fields; `freelo.reports.list/v1` is just a new schema string.

### Test strategy

- Unit-ish leaf tests via `runCli` helper (mirrors `comments/list.test.ts` patterns).
- All HTTP exercised through MSW; no live network.
- Every typed error path has an `expect(exitCode).toBe(N)` assertion (Calibration §2).

### Rollout order

Single landable slice — no need for sub-slicing. Order of edits inside the commit:

1. Schemas first (`report.ts`).
2. Wire wrapper (`reports.ts`).
3. Human renderer (`ui/human/reports-list.ts`).
4. Leaf command (`commands/reports/list.ts`).
5. Namespace registration (`commands/reports.ts`).
6. Wire into `bin/freelo.ts`.
7. MSW handlers.
8. Tests.
9. Run local gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
10. Run `pnpm fix:readme` to regenerate the README autogen block.
11. Doc page.
12. Changeset.
13. `pnpm check:readme` to confirm autogen matches.

### Risks / known gotchas

- **`worker` vs `author` distinction.** The OpenAPI documents both — `author` is who logged the report, `worker` is whose time it represents (often the same user, but can differ). The CLI surfaces `worker` in the human renderer (matches the user's mental model — "whose hours are these"); both fields ride through in the JSON envelope (passthrough).
- **`UserBasicSchema` divergence.** `src/api/schemas/project.ts` exports a `UserBasicSchema` that is **NOT** passthrough. We declare a local copy in `report.ts` to keep the contract loose for unknown user fields (avatar, email, role) that may appear on `/work-reports`. Calls out the divergence so a future "hoist UserBasicSchema" refactor doesn't accidentally tighten this surface.
- **Date-range encoding.** `URLSearchParams.append('date_reported_range[date_from]', ...)` percent-encodes the brackets; verify in a test that the exact wire form (`date_reported_range%5Bdate_from%5D=...`) lands.
- **`time` precedent on namespace registration.** `src/commands/time.ts` already shows the pattern of a top-level subcommand with multiple leaves — copy that shape exactly so future R22 leaves slot in cleanly.

### Decision log entries to be created during implement

(None expected beyond Decision 1 — scope narrow. If the implementer hits an unexpected schema-shape surprise during MSW fixturing, log Decision 2 there.)

