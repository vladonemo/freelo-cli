# 0016 — `freelo tasklists show <id>` (R06)

**Status:** Accepted — ready for implementation
**Run:** 2026-04-26-1946-r06-tasklists-show
**Tier:** Yellow (additive new command + new envelope schema; no auth/HTTP-defaults touch)
**Branch:** `feat/tasklists-show`
**Cross-reference:** structurally a clone of spec 0013 (R04 `freelo projects show <id>`). Where the pattern is identical, this spec defers to 0013 instead of restating.

---

## 1. Problem

R05 lets agents enumerate tasklists (`freelo tasklists list`). The natural follow-up — "give me everything about this one tasklist plus who I can assign tasks to" — has no command yet. R06 fills that hole and is the prerequisite for task-level slices (R07+: `freelo tasks list`, then create / edit / move flows that need to know the assignable worker pool).

## 2. Background — what the API gives us

Full notes: `docs/runs/2026-04-26-1946-r06-tasklists-show/phase-reports/02-api-research.md`. Key facts:

1. **`GET /tasklist/{tasklist_id}`** — `getTasklist` (OpenAPI :1264-1288). Returns `TasklistDetail` (:5092-5126) with a **top-level `project_id` integer** field. Single object, NOT paginated. `TasklistDetail` is a different (leaner) shape than R05's `TasklistFull`: no `state`, no `budget`, no `real_cost`, no `real_minutes_spent`, no nested `project` object. It DOES carry an embedded `tasks` array.
2. **`GET /project/{project_id}/tasklist/{tasklist_id}/assignable-workers`** — `getAssignableWorkers` (OpenAPI :1235-1262). Returns a **bare `UserBasic[]` array — NOT a paginated wrapper**. This is materially different from R04's `/project/{id}/workers`. No `normalizePaginated`, no `?p=N`, no inner key.
3. **404 collapses not-found and not-permitted** for both endpoints (OpenAPI :1278 documents this explicitly for `/tasklist/{id}`; the same applies to `/assignable-workers`). Hint wording must cover both.

The command needs both endpoints' results to satisfy the requirement, and the second endpoint's path requires the `project_id` we read from the first endpoint's response.

## 3. Proposal

### 3.1 Subcommand signature

```
freelo tasklists show <id> [--with assignable-workers]
```

Hangs off the existing `freelo tasklists` parent (already created by R05). Inherited globals from R01: `--output`, `--color`, `--profile`, `-v/-vv`, `--request-id`. `--yes` is registered globally but unused (no destructive op).

| Argument / flag | Type / values | Default | Purpose |
|---|---|---|---|
| `<id>` (positional, required) | int >= 1 | — | Tasklist id (Freelo `tasklist_id` path param). |
| `--with <list>` | comma-separated string; allowed value(s): `assignable-workers` (v1) | unset | Side-cars to include. v1 accepts `assignable-workers` only; future slices add more values without breaking the contract. |

**Per-command `meta`** (consumed by the introspector — mandatory at the leaf level):

```ts
export const meta: CommandMeta = {
  outputSchema: 'freelo.tasklists.show/v1',
  destructive: false,
};
```

### 3.2 Envelope shape — `freelo.tasklists.show/v1`

```jsonc
{
  "schema": "freelo.tasklists.show/v1",
  "data": {
    "tasklist": { /* TasklistDetail — see §4.1 */ },
    "assignable_workers": [ /* UserBasic[] — present only when `--with assignable-workers` was passed */ ]
  },
  "rate_limit": { "remaining": 42, "reset_at": "2026-04-25T18:30:00Z" },
  "request_id": "..."
}
```

- `data.tasklist` is **always** present (the `/tasklist/{id}` call is mandatory).
- `data.assignable_workers` is **only present** when `--with assignable-workers` is set. Absent (not `null`, not `[]`) otherwise — agents key off presence/absence. Identical pattern to R04's `data.workers` (spec 0013 §3.2).
- No `paging` field. The side-car is a bare array; there are no pages to walk.
- `rate_limit` reflects the **last** HTTP call made: when `--with assignable-workers` is set, the `/assignable-workers` response's headers; otherwise the `/tasklist/{id}` response's headers. Matches R04's pattern.

Field naming: snake_case mirrors the wire format. `assignable_workers` (snake) — chosen to match the canonical Freelo pluralization convention used throughout the codebase (`real_minutes_spent`, `parent_task_id`, etc.) even though the URL hyphenates as `assignable-workers`. Identical to how R04 uses `data.workers`.

### 3.3 `--with assignable-workers` — call shape

Sequence under `--with assignable-workers`:

1. Fetch `GET /tasklist/{id}` → validate as `TasklistDetail` → store `data.tasklist`.
2. Read `data.tasklist.project_id` (always present per OpenAPI). If somehow absent (e.g., a future API regression that drops the field), throw a `FreeloApiError` with code `FREELO_API_ERROR` and a hint pointing at the API contract — see §3.5.
3. Fetch `GET /project/{project_id}/tasklist/{id}/assignable-workers` → validate as `z.array(UserBasicSchema)` → store as `data.assignable_workers`.

Without `--with assignable-workers`: only step 1 runs. `data.assignable_workers` is absent.

The two HTTP calls are **strictly sequential** — call 2 depends on call 1's response body for the `project_id` path parameter. Parallelization is structurally impossible. Captured as resolved Open Question in §7.

There is no client-side iteration / `fetchAllPages` for the side-car: the endpoint returns the full list in one round-trip. Mid-stream errors don't exist (only one HTTP call); a non-2xx on `/assignable-workers` after a successful `/tasklist/{id}` call surfaces as a `FreeloApiError` (exit 4), no partial envelope.

### 3.4 Human-mode rendering

```
Tasklist: Backend QA (#314)
Project:  42
Created:  2026-01-15
Edited:   2026-04-20
Tasks (embedded): 7
```

When `--with assignable-workers` is set, append a worker table (id + fullname columns, name truncated to 40):

```
ASSIGNABLE WORKERS
ID    FULLNAME
9     Owner Name
17    Jane Doe
…
```

Empty workers list (after `--with assignable-workers`) renders the header row + `(no assignable workers)` body row, matching R04's convention (spec 0013 §3.4).

The renderer lives in `src/ui/human/tasklists-show.ts`, called from `renderAsync()`. Lazy `cli-table3` via `src/ui/table.ts`.

### 3.5 Validation and error mapping

Per spec 0013 §3.5 — same patterns; only the wording changes:

- **Missing `<id>` argument** — Commander error (exit 1, code `commander.missingArgument`). No special handling.
- **`<id>` not a positive integer** — `ValidationError({ exitCode: 2 })` with hint `"<id> must be a positive integer."`. Validated via `parseTasklistId(raw)` (a one-liner mirroring `parseProjectId` in R04). Calibration §1-2: throw `ValidationError`, NOT Commander's `InvalidArgumentError`.
- **Unknown `--with` value** — `ValidationError({ exitCode: 2 })` with hint `"--with accepts only: assignable-workers."`. Validated synchronously **before** any HTTP call.
- **Empty `--with ""`** — `ValidationError({ exitCode: 2 })` with hint `"Specify at least one --with value, or omit --with."`.
- **404 on `/tasklist/{id}`** — `FreeloApiError(httpStatus: 404, code: 'FREELO_API_ERROR', exitCode: 4)`. Command catches and rewrites `hintNext` to `"Tasklist ${id} not found, or your account does not have access."`.
- **403 on `/tasklist/{id}`** — `FreeloApiError(httpStatus: 403, code: 'FREELO_API_ERROR', exitCode: 4)`. Hint: `"Account does not have permission to view tasklist ${id}."`.
- **404 / 403 on `/assignable-workers`** — same rewrite, but using the assignable-workers path: hint mentions "assignable workers for tasklist ${id}". Two separate rewrite branches (one per call site) so the hint is precise. See §4.3.
- **`project_id` missing on the `/tasklist/{id}` response** (defensive — should never happen given the OpenAPI contract; `passthrough()` on the schema means a missing `project_id` won't fail zod validation by itself if we leave it `.optional()`). Command-layer check: throw `FreeloApiError(code: 'FREELO_API_ERROR', exitCode: 4)` with hint `"Tasklist ${id} response did not include project_id; --with assignable-workers cannot proceed."`. **However:** the schema declares `project_id` as **required** (matching the OpenAPI contract), so a real missing field surfaces as a zod `VALIDATION_ERROR` from the HTTP layer — exit 4, but with the schema-validation error code. The defensive command-layer branch is unreachable in practice given the schema; we still write the test (mocking the response with `project_id` declared optional in a test-local schema, or by triggering a defensive code path) to lock the behaviour in case the schema is ever loosened.
- **401** — `FreeloApiError(code: 'AUTH_EXPIRED', exitCode: 3)` (handled by R01 client; no per-command logic).
- **5xx / network / 429** — handled identically to R04/R05 (R01 HTTP client retries 429s on GETs, bubbles 5xx as `FREELO_API_ERROR`).

## 4. Data model

### 4.1 `TasklistDetail` schema (new)

Lives in `src/api/schemas/tasklist.ts` next to the existing `TasklistFullSchema`. Built from scratch (not extended from `TasklistFullSchema`, because the field overlap is partial — see §2 of the API memo).

```ts
const TaskBriefSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  due_date: z.string().nullable().optional(),
  due_date_end: z.string().nullable().optional(),
  worker: UserBasicSchema.nullable().optional(),
  parent_task_id: z.number().int().nullable().optional(),
}).passthrough();

export const TasklistDetailSchema = z.object({
  id: z.number().int(),
  name: z.string().nullable().optional(), // R05.5 hardening — server can omit for orphaned records
  project_id: z.number().int(),            // required per OpenAPI; cmd reads it for /assignable-workers call
  date_add: z.string().nullable().optional(),
  date_edited_at: z.string().nullable().optional(),
  tasks: z.array(TaskBriefSchema).nullable().optional(),
}).passthrough();

export type TasklistDetail = z.infer<typeof TasklistDetailSchema>;
```

Reuses `UserBasicSchema` from `src/api/schemas/project.ts` (already exported). `passthrough()` per R05.5 hardening conventions; every optional field is `.nullable().optional()` since Freelo treats null and absent interchangeably.

`project_id` is **required** (`.int()` only, no `.optional()`) — locks the API contract. If Freelo ever drops the field, the schema validation fails fast at the HTTP layer.

### 4.2 Envelope data schema (new)

```ts
export const TasklistShowDataSchema = z.object({
  tasklist: TasklistDetailSchema,
  assignable_workers: z.array(UserBasicSchema).optional(),
});
export type TasklistShowData = z.infer<typeof TasklistShowDataSchema>;
```

Optional `assignable_workers` lines up with the "absent vs. present" envelope rule from §3.2.

### 4.3 New API functions

`src/api/tasklists.ts` adds two:

```ts
export async function getTasklistDetail(
  client: HttpClient,
  tasklistId: number,
  opts: FetchOpts,
): Promise<ApiResponse<TasklistDetail>>;

export async function getAssignableWorkers(
  client: HttpClient,
  projectId: number,
  tasklistId: number,
  opts: FetchOpts,
): Promise<ApiResponse<UserBasic[]>>;
```

Both use the R01 `client.request({ method: 'GET', path, schema, … })` pattern directly — no pagination wrappers.

`getTasklistDetail` validates with `TasklistDetailSchema`. `getAssignableWorkers` validates with `z.array(UserBasicSchema)` (bare array, no wrapper). The `signal` / `requestId` plumbing matches R04 exactly.

`FetchOpts` (shared) is the simple two-field opts: `{ signal?: AbortSignal; requestId?: string; }` — R04 already declared it (`src/api/projects.ts`). For R06 we declare a local `FetchOpts` in `src/api/tasklists.ts` (matching the R04 pattern of co-locating the type with its consumers) rather than introducing a shared module — that's a refactor we can do later when the third reuse appears.

## 5. CLI behaviour matrix

| Invocation | HTTP calls | `data.tasklist` | `data.assignable_workers` | Exit |
|---|---|---|---|---|
| `freelo tasklists show 314` | `GET /tasklist/314` | present | absent | 0 |
| `freelo tasklists show 314 --with assignable-workers` | `GET /tasklist/314`, then `GET /project/42/tasklist/314/assignable-workers` (where `42` came from response 1) | present | present (full list) | 0 |
| `freelo tasklists show 314 --with bogus` | none (validation fails first) | n/a | n/a | 2 |
| `freelo tasklists show 314 --with ""` | none | n/a | n/a | 2 |
| `freelo tasklists show abc` | none | n/a | n/a | 2 |
| `freelo tasklists show 0` | none | n/a | n/a | 2 |
| `freelo tasklists show 99 --with assignable-workers` (404 on detail) | `GET /tasklist/99` only | n/a (error) | n/a | 4 |
| `freelo tasklists show 314 --with assignable-workers` (5xx on assignable-workers) | both calls | n/a (error) | n/a | 4 |
| `freelo tasklists show 314 --with assignable-workers` (404 on assignable-workers) | both calls | n/a (error) | n/a | 4 |

## 6. Non-goals (v1)

- **`--with tasks`** — `TasklistDetail` already embeds the `tasks` array under `data.tasklist.tasks`. There's no separate endpoint to call. If we ever want to expose tasks at the top level of the envelope, it's an additive R06.x.
- **`--fields a,b,c` projection** — show is a single object whose tree is shallow; agents prune client-side. Adding it later is non-breaking.
- **Pagination knobs for assignable-workers** — the endpoint returns the full list in one shot; there's nothing to paginate.
- **Caching, retry budgets specific to show, abort signal handling beyond R01.** All inherited.
- **Promoting the workspace-shared `FetchOpts` type to a common module.** Local declaration is fine until a third reuse appears.

## 7. Open questions — resolved

### OQ#1 — Where does the command get `project_id` from?

The user gives us only `<id>` (the tasklist id). The `/assignable-workers` path needs both ids.

**Resolved: read `project_id` from the response of `GET /tasklist/{id}`.** The OpenAPI contract guarantees `project_id` is a top-level integer on `TasklistDetail` (:5097-5098). No need for a separate `--project <id>` flag.

Alternatives considered:
- **Add a `--project <id>` flag** — would force the user / agent to look up the project id separately, defeating the discoverability of a "show me this thing" command.
- **Make a side call to `/all-tasklists?projects_ids[]=…`** — circular: the user doesn't know the project id, so the filter doesn't help.

The chosen design forces the calls to be sequential, which is fine — the second call is opt-in (`--with`). Documented in §3.3.

### OQ#2 — `assignable-workers` URL key in the envelope: hyphenated or snake_case?

The URL has `assignable-workers`. The envelope key choices: `assignable-workers` (matches URL), `assignable_workers` (matches Freelo's snake-case wire convention), or `assignableWorkers` (camelCase).

**Resolved: `assignable_workers`.** Mirrors the rest of the wire format (every other multi-word field is snake_case: `parent_task_id`, `real_minutes_spent`, `due_date_end`, etc.). Matches how R04 uses `data.workers`. Hyphens in JSON keys force quoting, which is awkward in agent code.

### OQ#3 — Error hint specificity per call site

Resolved: catch `FreeloApiError` separately for each of the two calls, so the hint mentions the right resource ("tasklist" vs. "assignable workers for tasklist"). Two `try/catch` arms in the command. Calibration §4 acknowledged: each new catch arm must be tested.

### OQ#4 — `request_id` propagation

Resolved: both HTTP calls receive the same `appConfig.requestId` (when set). The envelope's `request_id` is whatever `appConfig.requestId` is — not derived from the HTTP layer's per-call requestIds. Consistent with R04's behaviour.

### OQ#5 — Why not extend `TasklistFullSchema`?

Field overlap is partial: `TasklistDetail` has `project_id` + `tasks` that `TasklistFull` doesn't, and `TasklistFull` has `state` / `budget` / `real_cost` / `real_minutes_spent` / `project` that `TasklistDetail` doesn't. Extending `TasklistFullSchema` would carry false expectations into the schema (zod would complain about the missing `state` etc. unless we made them all `.optional()`, at which point we've effectively rewritten the schema).

**Resolved: declare `TasklistDetailSchema` from scratch.** It's a different shape; treat it as one.

## 8. Plan

### 8.1 Files to add (new)

1. `src/commands/tasklists/show.ts` — leaf command. Exports `registerShow(parent, getConfig, env)` and `meta`. Mirrors `src/commands/projects/show.ts`'s shape, with the side-car simplified (no `fetchAllPages`).
2. `src/ui/human/tasklists-show.ts` — pure shape → string mapper. Lazy-imports `cli-table3` via `src/ui/table.ts` for the workers table.
3. `test/commands/tasklists/show.test.ts` — end-to-end via `program.parseAsync` (mirror of `test/commands/projects/show.test.ts`'s harness).
4. `test/api/tasklists-show.test.ts` — `getTasklistDetail` + `getAssignableWorkers` HTTP wrapper tests via MSW.
5. `test/fixtures/tasklists/show-tasklist-314.json` — `TasklistDetail` fixture.
6. `test/fixtures/tasklists/show-assignable-workers.json` — bare-array `UserBasic[]` fixture.
7. `.changeset/<auto>.md` — `minor`, summary: `feat(commands): add 'freelo tasklists show <id>' for tasklist detail with optional assignable-workers side-car`. Schema callout: introduces `freelo.tasklists.show/v1`.
8. `docs/commands/tasklists-show.md` — user-facing.

### 8.2 Files to modify

9. `src/commands/tasklists.ts` — register the `show` subcommand alongside `list`.
10. `src/api/schemas/tasklist.ts` — add `TasklistDetailSchema`, `TasklistShowDataSchema`, helper `TaskBriefSchema`. Reuse the already-exported `UserBasicSchema` from `src/api/schemas/project.ts`.
11. `src/api/tasklists.ts` — add `getTasklistDetail` and `getAssignableWorkers` functions. Add a local `FetchOpts` type (or reuse from R04 by importing — implementer's call).
12. `test/msw/handlers.ts` — add `tasklistShowHandlers` factory namespace: `detailOk(id, body)`, `detailNotFound(id)`, `detailForbidden(id)`, `detailServerError(id, status)`, `detailUnauthorized(id)`, `assignableWorkersOk(projectId, tasklistId, items)`, `assignableWorkersServerError(projectId, tasklistId, status)`, `assignableWorkersNotFound(projectId, tasklistId)`, `assignableWorkersForbidden(projectId, tasklistId)`.
13. `docs/getting-started.md` — add a one-line cross-reference to `freelo tasklists show` in the "next steps" or commands list section, alongside the existing `freelo tasklists list` mention.
14. `README.md` — autogen Commands block updated by `pnpm fix:readme`.

### 8.3 Test plan (≥85% branch coverage on `src/commands/**` is enforced)

`test/commands/tasklists/show.test.ts` cases (Calibration §1-2 — exit-code assertions are non-negotiable):

- Default (no `--with`) → envelope has `data.tasklist`, no `data.assignable_workers`. Exit 0.
- `--with assignable-workers` → `data.assignable_workers` is the array from the side-car. Exit 0.
- `--with assignable-workers` empty → `data.assignable_workers` is `[]` (key present but empty). Exit 0.
- `--with bogus` → exit 2, `freelo.error/v1`, hint mentions `assignable-workers`. **Asserts `ValidationError`.**
- `--with ""` → exit 2. **Asserts `ValidationError`.**
- `--with assignable-workers,assignable-workers` (duplicate) → treated as if specified once (parser dedupes). Exit 0.
- Positional `<id>` not integer (`abc`) → exit 2. **Asserts `ValidationError`.**
- Positional `<id>` zero → exit 2. **Asserts `ValidationError`.**
- Positional `<id>` negative (`-5`) → exit 2 OR exit 1 if commander treats it as a flag. (Probe in implementation; document the actual behaviour.)
- 404 on detail → exit 4, error envelope with hint mentioning "tasklist not found / no access". **Asserts `FreeloApiError`.**
- 403 on detail → exit 4, error envelope with hint mentioning "permission". **Asserts `FreeloApiError`.**
- 5xx on detail → exit 4, `SERVER_ERROR`, no 404/403-flavoured hint injection. **Asserts `FreeloApiError`.**
- 401 on detail → exit 3, `AUTH_EXPIRED`. **Asserts `FreeloApiError`.**
- 404 on assignable-workers (after detail succeeds) → exit 4, error envelope with hint mentioning the side-car. **Asserts `FreeloApiError`.**
- 403 on assignable-workers (after detail succeeds) → exit 4, hint mentions "permission". **Asserts `FreeloApiError`.**
- 5xx on assignable-workers (after detail succeeds) → exit 4, `SERVER_ERROR`. **Asserts `FreeloApiError`.**
- `--output human` smoke (no error envelope, exit 0).
- `--output json` golden envelope schema check.
- `--request-id <uuid>` round-trips into envelope.

`test/api/tasklists-show.test.ts` cases:

- `getTasklistDetail` URL = `/tasklist/{id}` (verify via MSW request matching).
- `getTasklistDetail` parses through `TasklistDetailSchema` (rejects when `project_id` missing — locks the contract).
- `getAssignableWorkers` URL = `/project/{pid}/tasklist/{tid}/assignable-workers` (no query string).
- `getAssignableWorkers` parses a bare array (rejects when wrapped in `{ data: [...] }`).
- Both wrappers propagate `requestId` and `signal` to the HTTP layer (one positive, one abort cancellation).

### 8.4 Commit slicing

Single PR. Architect's call: **two commits** for clean review:

1. `feat(api): add TasklistDetail schema and tasklist-detail HTTP wrappers` — `src/api/schemas/tasklist.ts`, `src/api/tasklists.ts`, `test/api/tasklists-show.test.ts`, `test/fixtures/tasklists/show-*.json`, `test/msw/handlers.ts`.
2. `feat(commands): add 'freelo tasklists show <id>' with optional assignable-workers side-car` — `src/commands/tasklists/show.ts`, `src/commands/tasklists.ts`, `src/ui/human/tasklists-show.ts`, `test/commands/tasklists/show.test.ts`, `.changeset/<auto>.md`, `docs/commands/tasklists-show.md`, `docs/getting-started.md`, `README.md` (via `pnpm fix:readme`).

Calibration §3 — each commit must be green on its own committed tree:

```
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme
```

`check:readme` is only meaningful after commit 2 runs `fix:readme`. Run all five gates as the final pre-push step on the committed tree.

### 8.5 Acceptance criteria

- All test cases in §8.3 pass.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme` clean on the final committed tree.
- Coverage thresholds (`src/commands/**` ≥ 85% branches; project-wide thresholds in `vitest.config.ts`) not regressed.
- `freelo --introspect` includes `tasklists show` with `args: [{ name: 'id', required: true, ... }]` and `flags: [{ name: '--with', ... }]` plus inherited globals. (The R02.5 introspect golden file does NOT register the tasklists tree, so the golden does not need updating.)
- `freelo tasklists show --help` mentions `--with assignable-workers`.
- The changeset captures `freelo.tasklists.show/v1` as a new public envelope schema.
- `docs/getting-started.md` mentions the new command.

### 8.6 Risks and mitigations

| Risk | Mitigation |
|---|---|
| `TasklistDetail` schema drifts from real responses (e.g. server stops emitting `project_id`) | `passthrough()` absorbs unknowns; `project_id` is `.int()` (required) so a regression fails fast at validation. R05.5 already taught the schema-loosening pattern for nullable strings. |
| `/assignable-workers` is actually paginated in production | API research confirms bare array per OpenAPI. If MSW probe shows otherwise during /implement, **pause and revisit** — pagination plumbing would be a material spec change. |
| Coverage drop on `src/commands/tasklists/show.ts` | Spec §8.3 covers every error branch with a targeted test. The two `try/catch` arms (one per HTTP call site) each have at least one test triggering them. Calibration §4 binding. |
| Schema declared `project_id` required, real API sometimes omits it | If discovered, loosen to `.optional()` AND add the command-layer defensive check from §3.5 with its own test. Currently we trust the OpenAPI contract. |
| `pnpm fix:readme` produces a churn-y diff | Run it once at the end of commit 2; commit the README change in the same commit. |

### 8.7 Out of scope for /implement (re-stated)

Do not introduce: `--with tasks` (no separate API), `--fields` projection, parallel HTTP calls (impossible — second call depends on first), caching, custom assignable-workers pagination knobs, `--project <id>` flag (`project_id` comes from the detail response).

```
ARCHITECT phase=plan run=2026-04-26-1946-r06-tasklists-show status=ok files=14 commits=2 new_deps=0
```
