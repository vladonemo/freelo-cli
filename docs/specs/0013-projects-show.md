# 0013 — `freelo projects show <id>` (R04)

**Status:** Accepted — ready for implementation
**Run:** 2026-04-26-0914-r04-projects-show
**Tier:** Yellow (additive new command + new envelope schema; no auth/HTTP-defaults touch)
**Branch:** `feat/projects-show`

---

## 1. Problem

R03 lets agents enumerate projects (`freelo projects list`). The natural follow-up — *"give me everything about this one project"* — has no command yet. Filling that hole completes the project read surface and is the prerequisite for tasklist/task-level slices (R05+).

## 2. Background — what the API gives us

API research (full notes: `docs/runs/2026-04-26-0914-r04-projects-show/phase-reports/02-api-research.md`) inspected the relevant Freelo OpenAPI surface:

1. **`GET /project/{project_id}`** — `getProject` (OpenAPI :530-556, schema :4969-5024). Returns `ProjectDetail`: extends `ProjectFull` with **embedded `tasklists`** (each carrying its own embedded `tasks[]`) and **embedded `workers`** (each with `hour_rate`). No query params; not paginated.
2. **`GET /project/{project_id}/workers`** — `getProjectWorkers` (OpenAPI :583-619). Standard `PaginatedResponse` wrapper, inner key `workers`, items are `UserBasic` (`{ id, fullname }`). Includes workers + owner + guests; deleted workers excluded; **NOT** ACL-filtered by tasklist membership.
3. **Labels — no per-project read API.** The roadmap mentions `--with labels`, but exhaustive inspection of the OpenAPI confirms there is no `GET /project/{id}/labels`, no `?project_id=` filter, and `ProjectDetail` does not embed a `labels` array. The closest read endpoint is `GET /project-labels/find-available`, which is **workspace-scoped** ("everything the caller can assign anywhere"), not project-scoped.

## 3. Proposal

### 3.1 Subcommand signature

```
freelo projects show <id> [--with workers]
```

Hangs off the existing `freelo projects` parent. Inherited globals from R01: `--output`, `--color`, `--profile`, `-v/-vv`, `--request-id`. `--yes` is registered globally but unused (no destructive op).

| Argument / flag | Type / values | Default | Purpose |
|---|---|---|---|
| `<id>` (positional, required) | int >= 1 | — | Project id (Freelo `project_id` path param). |
| `--with <list>` | comma-separated string; allowed value(s): `workers` (v1) | unset | Side-cars to include. v1 accepts `workers` only; future slices add more values without breaking the contract. |

**Per-command `meta`** (consumed by the introspector — mandatory at the leaf level since R02.5):

```ts
export const meta: CommandMeta = {
  outputSchema: 'freelo.projects.show/v1',
  destructive: false,
};
```

### 3.2 Envelope shape — `freelo.projects.show/v1`

```jsonc
{
  "schema": "freelo.projects.show/v1",
  "data": {
    "project": { /* ProjectDetail — see §4.1 */ },
    "workers": [ /* UserBasic[] — present only when `--with workers` was passed */ ]
  },
  "rate_limit": { "remaining": 42, "reset_at": "2026-04-25T18:30:00Z" },
  "request_id": "..."
}
```

- `data.project` is **always** present (the `/project/{id}` call is mandatory for the command).
- `data.workers` is **only present** when `--with workers` is set. Absent (not `null`, not `[]`) otherwise — agents key off presence/absence.
- No `paging` field at the top level. The single `--with workers` side-car is fetched with internal pagination (`--all` semantics under the hood — see §3.3) and merged into a single array, so the user-facing call is one round-trip from the agent's perspective.
- `rate_limit` reflects the **last** HTTP call made (so when `--with workers` is set, it's the rate-limit headers from the final workers page, not the `/project/{id}` call). This matches R03's `--all` behavior.

Field naming: snake_case, mirroring the wire format. We do not rename `date_add` → `created_at`.

### 3.3 `--with workers` — call shape

The `/project/{id}` response already contains an embedded `workers` array. The roadmap's stated endpoint is `/project/{id}/workers` (paginated), and the command makes the explicit paginated call. Rationale captured in §7 OQ#1.

Sequence under `--with workers`:

1. Fetch `GET /project/{id}` → validate as `ProjectDetail` → store as `data.project`.
2. Fetch `GET /project/{id}/workers?p=0`, then `?p=1`, … until `nextCursor === null` (reuses R03's `fetchAllPages` + `normalizePaginated` with `innerKey: 'workers'`, `itemSchema: UserBasicSchema`).
3. Merge all worker pages into a single `UserBasic[]`. Store as `data.workers`.

Without `--with workers`: only step 1 runs. `data.workers` is absent.

The two HTTP calls are **sequential, not parallel** — keeps the error envelope deterministic (a 404 on `/project/{id}` short-circuits before the workers call). Parallelization is a future optimization; v1 prefers clarity.

If `/project/{id}/workers` paginates over many pages, every page issues its own request. There is **no** user-visible `--page` / `--cursor` for the workers side-car: it's an opaque "include the full list or don't include it at all" toggle. R03's `PartialPagesError` flow applies — a mid-stream failure during workers iteration causes an error envelope at exit; no partial-result emission for show (it's a single object, not a stream).

### 3.4 Human-mode rendering

```
Project: Site redesign (#42)
Created: 2026-01-15
Edited:  2026-04-20
State:   active
Owner:   Owner Name
Budget:  10000 CZK
Spent:   2000 CZK (120 min)
Tasklists: 3
Workers (embedded): 5
```

When `--with workers` is set, append a worker table (id + fullname columns, name truncated to 40):

```
WORKERS
ID    FULLNAME
9     Owner Name
17    Jane Doe
…
```

Empty worker list (after `--with workers`) renders the header row + `(no workers)` body row, matching R03's convention.

The renderer is in `src/ui/human/projects-show.ts`, called from `renderAsync()`.

### 3.5 Validation and error mapping

- **Missing `<id>` argument** — Commander error (exit 1, code `commander.missingArgument`). No special handling.
- **`<id>` not a positive integer** — `ValidationError({ exitCode: 2 })` with hint `"<id> must be a positive integer."`. Validated via `parsePositiveInt('<id>', raw)` (already used by R03's `--page`).
- **Unknown `--with` value** — `ValidationError({ exitCode: 2 })` with hint `"--with accepts only: workers."`. Validated synchronously **before** any HTTP call (mirrors R03's `--fields` validation discipline).
- **Empty `--with ""`** — same `ValidationError`, hint `"Specify at least one --with value, or omit --with."`.
- **404 on `/project/{id}`** — flows through `FreeloApiError(httpStatus: 404, code: 'FREELO_API_ERROR', exitCode: 4)`. The R01 client maps it; we add a `hintNext` in the command layer when we can detect 404 specifically: `"Project ${id} not found, or your account does not have access."`. Implementation: catch `FreeloApiError` in the command, re-throw with the hint when `httpStatus === 404`.
- **403 on `/project/{id}`** — `FreeloApiError(httpStatus: 403, code: 'FREELO_API_ERROR', exitCode: 4)`. Same wrap pattern; hint: `"Account does not have permission to view project ${id}."`.
- **401** — `FreeloApiError(code: 'AUTH_EXPIRED', exitCode: 3)` (handled by R01 client; nothing extra at this layer).
- **5xx / network / 429** — handled identically to R03 (R01's HTTP client retries 429s on GETs, bubbles 5xx as `FREELO_API_ERROR`).
- **Mid-stream `--with workers` failure** — `FreeloApiError` propagates; exit 4. No partial envelope (show is a single object).

## 4. Data model

### 4.1 `ProjectDetail` schema (new)

Lives in `src/api/schemas/project.ts` alongside the existing schemas. Builds on `ProjectFullSchema` (already shipped in R03) plus the embedded fields:

```ts
const TaskBriefSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  due_date: z.string().nullable().optional(),
  due_date_end: z.string().nullable().optional(),
  worker: UserBasicSchema.nullable().optional(),
  parent_task_id: z.number().int().nullable().optional(),
}).passthrough();

const TasklistWithTasksSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  tasks: z.array(TaskBriefSchema).nullable().optional(),
}).passthrough();

const HourRateSchema = z.object({
  amount: z.number().int(),
  currency: z.string(),
  is_fixed: z.boolean(),
}).passthrough();

const WorkerWithHourRateSchema = z.object({
  id: z.number().int(),
  fullname: z.string(),
  hour_rate: HourRateSchema.nullable().optional(),
}).passthrough();

export const ProjectDetailSchema = ProjectFullSchema.extend({
  tasklists: z.array(TasklistWithTasksSchema).nullable().optional(),
  workers: z.array(WorkerWithHourRateSchema).nullable().optional(),
}).passthrough();

export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;
```

Convention: every optional field is `.nullable().optional()` (matches R03's pattern; Freelo serializes null and absent interchangeably).

`UserBasicSchema` — already needed by R03's pagination tests but currently inlined privately (`src/api/schemas/project.ts` line 17-20). **Promote it to `export`** so `src/api/projects.ts` can pass it to `normalizePaginated` for the workers endpoint. No behaviour change for R03; it's a non-breaking rename of an already-existing schema's visibility.

### 4.2 Envelope data schema (new — for type-safety in the command)

```ts
export const ProjectShowDataSchema = z.object({
  project: ProjectDetailSchema,
  workers: z.array(UserBasicSchema).optional(),
});
export type ProjectShowData = z.infer<typeof ProjectShowDataSchema>;
```

Optional `workers` lines up with the "absent vs. present" envelope rule from §3.2.

### 4.3 New API functions

`src/api/projects.ts` adds two:

```ts
export async function getProjectDetail(
  client: HttpClient,
  projectId: number,
  opts: FetchOpts,
): Promise<ApiResponse<ProjectDetail>>;

export async function getProjectWorkers(
  client: HttpClient,
  projectId: number,
  opts: FetchPagedOpts,
): Promise<{ page: NormalizedPage<UserBasic>; raw: ApiResponse<unknown> }>;
```

`getProjectDetail` calls `client.request({ method: 'GET', path: '/project/${id}', schema: ProjectDetailSchema, … })` directly — no pagination wrapper.

`getProjectWorkers` uses `normalizePaginated(raw.data, 'workers', UserBasicSchema)` — identical pattern to `getInvitedProjects` and friends. The `signal` / `requestId` plumbing matches R03 exactly.

## 5. CLI behaviour matrix

| Invocation | HTTP calls | Envelope `data.project` | Envelope `data.workers` | Exit |
|---|---|---|---|---|
| `freelo projects show 42` | `GET /project/42` | present | absent | 0 |
| `freelo projects show 42 --with workers` | `GET /project/42`, then `GET /project/42/workers?p=0..` | present | present (full list) | 0 |
| `freelo projects show 42 --with bogus` | none (validation fails first) | n/a | n/a | 2 |
| `freelo projects show abc` | none | n/a | n/a | 2 |
| `freelo projects show 99 --with workers` (404 on detail) | `GET /project/99` only | n/a (error) | n/a | 4 |
| `freelo projects show 42 --with workers` (5xx on workers page 1) | `GET /project/42`, `GET /project/42/workers?p=0` | n/a (error) | n/a | 4 |

## 6. Non-goals (v1)

- **`--with labels`.** Project labels are workspace-scoped in the documented Freelo API; per-project labels read is blocked on either a Freelo API addition or an undocumented-endpoint discovery via `--allow-network` probing. Tracked as future R04.5.
- **`--fields a,b,c` projection.** R03 has it for list output; show is a single object whose tree is shallow enough that agents can prune client-side. Adding it later is non-breaking.
- **`--with tasklists`.** Embedded `tasklists` already comes back from `/project/{id}` itself. There's no separate endpoint to call. If we ever want to expose `tasklists` as a top-level array in the envelope (instead of nested in `data.project.tasklists`), it's an additive R04.x.
- **Caching, retry budgets specific to show, abort signal handling beyond what R01 already does.** All inherited.
- **Workers pagination knobs (`--workers-page`, `--workers-cursor`).** The opaque "fetch all pages" model is intentional for v1 (see §3.3). A future slice can add knobs without breaking the envelope.

## 7. Open questions — resolved

### OQ#1 — `--with workers`: paginated `/project/{id}/workers` vs. embedded `ProjectDetail.workers`?

`ProjectDetail.workers` is already populated by the single `/project/{id}` call (capped at the server's inline limit, exact value undocumented). The roadmap (line 121) explicitly lists `/project/{id}/workers` as one of the two endpoints for R04.

**Resolved: paginated `/project/{id}/workers`.** Three reasons:

1. The roadmap's explicit endpoint listing is the contract. Honor it.
2. Reuses R03's `normalizePaginated` + `fetchAllPages` plumbing — zero new pagination code.
3. The full paginated list is unconditionally complete; the embedded inline list may be truncated. Agents asking for "give me the workers" expect "all of them, please."

The cheaper alternative — projecting `data.project.workers` — is a viable future optimization (one round-trip instead of N+1) if performance ever becomes a concern. Documented here so the next architect knows the cheaper option exists. The richer embedded data (the `hour_rate` field) is **still available** to agents under `data.project.workers[*]` regardless of whether `--with workers` was passed, since `data.project` is the full `ProjectDetail`.

### OQ#2 — error hint on 404 / 403

Resolved: catch `FreeloApiError` in the command, conditionally rewrite `hintNext` based on `httpStatus`. Pattern is small (one switch on status) and avoids polluting the R01 HTTP client with per-endpoint hint logic.

### OQ#3 — request_id propagation across the two HTTP calls

Resolved: both calls receive the same `appConfig.requestId` (when set). The envelope's `request_id` is whatever `appConfig.requestId` is — not derived from the HTTP layer's per-call requestIds. (Consistent with R03's behaviour.)

## 8. Plan

### 8.1 Files to add (new)

1. `src/commands/projects/show.ts` — leaf command. Exports `registerShow(parent, getConfig, env)` and `meta`. Mirrors `src/commands/projects/list.ts`'s shape.
2. `src/ui/human/projects-show.ts` — pure shape → string mapper. Lazy-imports `cli-table3` via `src/ui/table.ts` for the workers table.
3. `test/commands/projects/show.test.ts` — end-to-end via `program.parseAsync` (mirror of `test/commands/projects/list.test.ts`'s harness).
4. `test/api/projects-show.test.ts` — `getProjectDetail` + `getProjectWorkers` HTTP wrapper tests via MSW.
5. `test/fixtures/projects/show-project-42.json` — `ProjectDetail` fixture.
6. `test/fixtures/projects/show-workers-page0.json`, `show-workers-page1.json` — paginated `workers` fixtures (multi-page).
7. `.changeset/<auto>.md` — `minor`, summary: `feat(commands): add 'freelo projects show <id>' for project detail with optional workers side-car`. Schema callout: introduces `freelo.projects.show/v1`.
8. `docs/commands/projects-show.md` — user-facing.

### 8.2 Files to modify

9. `src/commands/projects.ts` — register the `show` subcommand alongside `list`.
10. `src/api/schemas/project.ts` — add `ProjectDetailSchema`, `UserBasicSchema` (export the existing private one), `ProjectShowDataSchema`. Add the inline schemas (`HourRateSchema`, `TaskBriefSchema`, `TasklistWithTasksSchema`, `WorkerWithHourRateSchema`).
11. `src/api/projects.ts` — add `getProjectDetail` and `getProjectWorkers` functions.
12. `test/msw/handlers.ts` — add `projectShowHandlers` factory namespace: `detailOk(body)`, `detailNotFound(id)`, `detailForbidden(id)`, `workersPaged(pages)`, `workersUnauthorized()`, `workersServerError(status)`.
13. `docs/roadmap.md` (lines 119-123) — drop `--with labels` from the R04 entry; add a one-line note about the labels deferral.
14. `README.md` — autogen Commands block updated by `pnpm fix:readme`.

### 8.3 Test plan (≥85% branch coverage on `src/commands/**`)

`test/commands/projects/show.test.ts` cases:

- Default (no `--with`) → envelope has `data.project`, no `data.workers`, `data.project.workers` populated from inline.
- `--with workers` single page → `data.workers` is the merged list.
- `--with workers` multi-page → `data.workers` includes items from every page.
- `--with workers` empty page → `data.workers` is `[]` (workers key present but empty).
- `--with bogus` → exit 2, `freelo.error/v1` with hint mentioning `workers`.
- `--with ""` → exit 2.
- `--with workers,workers` (duplicate) → treated as if specified once (parser dedupes).
- Positional `<id>` not integer → exit 2.
- Positional `<id>` zero or negative → exit 2.
- 404 on detail → exit 4, error envelope with hint mentioning project not found / no access.
- 403 on detail → exit 4, error envelope with hint mentioning permission.
- 401 on detail → exit 3 (`AUTH_EXPIRED`).
- 5xx on workers page mid-stream → exit 4, error envelope.
- `--output human` smoke (no error envelope, exit 0).
- `--output json` golden envelope schema check.
- `--request-id <uuid>` round-trips into envelope.

`test/api/projects-show.test.ts` cases:

- `getProjectDetail` URL = `/project/{id}` (verify via MSW request matching).
- `getProjectDetail` parses through `ProjectDetailSchema`.
- `getProjectWorkers` URL = `/project/{id}/workers?p=N`, returns normalized page.
- `getProjectWorkers` rejects malformed wrapper (missing `data.workers` key).

### 8.4 Commit slicing

Single PR. Architect's call: **two commits** for clean review:

1. `feat(api): add ProjectDetail schema and project-detail HTTP wrappers` — `src/api/schemas/project.ts`, `src/api/projects.ts`, `test/api/projects-show.test.ts`, `test/fixtures/projects/show-*.json`, `test/msw/handlers.ts`.
2. `feat(commands): add 'freelo projects show <id>' with optional workers side-car` — `src/commands/projects/show.ts`, `src/commands/projects.ts`, `src/ui/human/projects-show.ts`, `test/commands/projects/show.test.ts`, `.changeset/<auto>.md`, `docs/commands/projects-show.md`, `docs/roadmap.md`, `README.md` (via `pnpm fix:readme`).

Each commit must be green on its own committed tree:

```
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme
```

Note: `check:readme` only changes after commit 2 runs `fix:readme`. Run it as the final gate before push.

### 8.5 Acceptance criteria

- All test cases in §8.3 pass.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme` clean on the final tree.
- Coverage thresholds in `vitest.config.ts` not regressed (lines/branches/functions/statements at the per-dir targets).
- `freelo --introspect` includes `projects show` with `args: [{ name: 'id', required: true, ... }]` and `flags: [{ name: '--with', ... }]` plus inherited globals.
- `freelo projects show --help` mentions `--with workers`.
- The changeset captures `freelo.projects.show/v1` as a new public envelope schema.
- `docs/roadmap.md` lines 119-123 no longer mention `--with labels` and carry the deferral note.

### 8.6 Risks and mitigations

| Risk | Mitigation |
|---|---|
| `ProjectDetail.workers` schema drifts from real responses (e.g. `hour_rate.amount` is sometimes a string, not an int) | Use `.passthrough()` on `WorkerWithHourRateSchema`; `.nullable().optional()` on every field. If integration probes reveal drift, narrow incrementally — passthrough absorbs unknowns. |
| `/project/{id}/workers` not actually paginated in production | Pause-worthy per orchestrator brief. Spec assumes paginated per OpenAPI :609-619; if MSW/probe shows otherwise, stop and revisit. |
| Coverage drop on `src/commands/projects/show.ts` | Cover every error branch with one targeted test; mirror the structure of `list.ts`'s test file. |
| Schema export rename (`UserBasicSchema` private → exported) breaks an internal consumer | Search for `UserBasicSchema` callers — currently zero outside the file. Safe. |
| `pnpm fix:readme` produces a churn-y diff | Run it once at the end of commit 2; commit the README change in the same commit. |

### 8.7 Out of scope (for /implement, re-stated)

Do not introduce: `--with labels` (no API), `--fields` projection, `--with tasklists` flag, parallel HTTP calls, caching, custom workers pagination knobs.

```
ARCHITECT phase=plan run=2026-04-26-0914-r04-projects-show status=ok files=14 commits=2 new_deps=0
```
