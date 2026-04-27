# 0018 — `freelo tasks show <id>` (R08)

**Status:** Accepted — ready for implementation
**Run:** 2026-04-27-0535-tasks-show
**Tier:** Yellow (additive new command + new envelope schema; no auth/HTTP-defaults touch)
**Branch:** `feat/tasks-show`
**Cross-reference:** structurally a sibling of spec 0013 (R04 `projects show`) and spec 0016 (R06 `tasklists show`). Where the pattern is identical, this spec defers to those.

---

## 1. Problem

R07 lets agents enumerate tasks (`freelo tasks list`). The natural follow-up — *"give me everything about this one task, including its long-form description, subtasks, and multi-project membership"* — has no command yet. R08 fills that hole and is the prerequisite for the daily-driver write commands in Wave 2 (R09 `tasks create`, R10 `tasks edit`, etc.) which need the full task shape to round-trip diffs.

## 2. Background — what the API gives us

Full notes inline (no separate API memo for this slice; the surface is small).

1. **`GET /task/{task_id}`** — `getTask` (OpenAPI :1662-1689, schema :5381-5448). Returns `TaskDetail`: a rich object carrying `id`, `name`, dates, `priority_enum`, `count_subtasks`, `cost`, `author`, `worker`, `state`, `comments[]` (with files), `labels[]`, `project`, `tasklist`, `custom_fields`, `total_time_estimate`, `users_time_estimates`, `tracking_users`, plus a documented `multi_project_task` block when the task is multi-project (description :1676). Single object, NOT paginated.
2. **`GET /task/{task_id}/description`** — `getTaskDescription` (OpenAPI :2002-2025). Returns a single `Comment` (id, content, date_add, files[]) — not paginated. Empty descriptions still return 200 with empty/null fields (description :2014).
3. **`GET /task/{task_id}/subtasks`** — `getSubtasksInTask` (OpenAPI :2380-2415). Returns the standard paginated wrapper with inner key `subtasks`, items are `Subtask` (id, task_id, name, dates, count_comments, count_subtasks, author, worker, state, project, tasklist, labels — :5482-5530). Pagination: `?p=N`.
4. **`GET /task/{task_id}/projects`** — **NOT documented** in the OpenAPI. Only `POST /task/{id}/projects` (assign-to-project) and `DELETE /task/{id}/projects/{project_id}` (remove-from-project) are defined. The roadmap line for R08 names `GET /task/{task_id}/projects` but the contract does not expose it.

   The equivalent data is **embedded in `TaskDetail.multi_project_task`** per the OpenAPI description (`docs/api/freelo-api.yaml:1676`): *"For multi-project tasks, the response contains a `multi_project_task` block mapping the task across its projects and may expose a `parent_task_id` if this is a subtask linked to a multi-project parent."*

   **Decision (logged as decision 1):** v1 surfaces the embedded block under `data.projects` when `--with projects` is set. No second HTTP call for that side-car. The roadmap's R08 entry is updated to reflect this in the spec PR.

## 3. Proposal

### 3.1 Subcommand signature

```
freelo tasks show <id> [--with description,subtasks,projects]
```

Hangs off the existing `freelo tasks` parent (created by R07). Inherited globals from R01: `--output`, `--color`, `--profile`, `-v/-vv`, `--request-id`. `--yes` is registered globally but unused (no destructive op).

| Argument / flag | Type / values | Default | Purpose |
|---|---|---|---|
| `<id>` (positional, required) | int >= 1 | — | Task id (Freelo `task_id` path param). |
| `--with <list>` | comma-separated string; allowed values: `description`, `subtasks`, `projects` | unset | Side-cars to include. Order-independent. Duplicates collapse. v1 ships all three values. |

**Per-command `meta`** (consumed by the introspector, mandatory at the leaf level since R02.5):

```ts
export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.show/v1',
  destructive: false,
};
```

### 3.2 Envelope shape — `freelo.tasks.show/v1`

```jsonc
{
  "schema": "freelo.tasks.show/v1",
  "data": {
    "task":         { /* TaskDetail — see §4.1 */ },
    "description":  { /* Comment — present only when --with description */ },
    "subtasks":     [ /* Subtask[] — present only when --with subtasks */ ],
    "projects":     { /* MultiProjectBlock or null — present only when --with projects */ }
  },
  "rate_limit": { "remaining": 42, "reset_at": "2026-04-25T18:30:00Z" },
  "request_id": "..."
}
```

Rules (every key follows R04/R06's "absent vs. present" convention):

- `data.task` is **always** present (the `/task/{id}` call is mandatory).
- `data.description` is **only present** when `--with description` was passed. Value is the parsed `Comment` (id + content + date_add + files[]).
- `data.subtasks` is **only present** when `--with subtasks` was passed. Value is the merged-across-pages `Subtask[]` array (`fetchAllPages` over `/task/{id}/subtasks?p=N`). Empty list renders as `[]` (key present, empty array).
- `data.projects` is **only present** when `--with projects` was passed. Value is `data.task.multi_project_task` projected into the side-car slot — **may be `null`** when the task is single-project. Agents key off the key's *presence* (set or not) and the *value* (object or null) separately. No second HTTP call.
- No `paging` field at the top level. Paginated subtasks fetch all pages internally and merge into one array (mirrors R04 workers).
- `rate_limit` reflects the **last** HTTP call made. When at least one side-car triggered an HTTP call (description or subtasks), it's that call's headers; otherwise it's the `/task/{id}` call's headers. Matches R04 / R06 pattern.

Field naming: snake_case mirrors the wire format. The envelope key is `description` (singular, mirrors the URL path) and `subtasks` (plural, mirrors the inner data key).

### 3.3 Per-side-car call shape

Sequence when `--with description,subtasks,projects` (worst case, all three):

1. `GET /task/{id}` → validate as `TaskDetail` → `data.task`. **Mandatory.**
2. *(if `--with description`)* `GET /task/{id}/description` → validate as `Comment` → `data.description`.
3. *(if `--with subtasks`)* `GET /task/{id}/subtasks?p=0`, `?p=1`, … until `nextCursor === null` (reuses R03's `fetchAllPages` + `normalizePaginated` with `innerKey: 'subtasks'`, `itemSchema: SubtaskSchema`). Merge into one `Subtask[]`.
4. *(if `--with projects`)* No HTTP call. Project the already-fetched `data.task.multi_project_task` into `data.projects`.

All HTTP calls are **strictly sequential** — keeps the error envelope deterministic (a 404 short-circuits before any side-car runs). Parallelization is a future optimization (see §6).

When `--with` is unset: only step 1 runs.

### 3.4 Human-mode rendering

```
Task: Audit auth flow (#9001)
Project:  Site redesign (#42)
Tasklist: Backend QA (#314)
State:    active
Worker:   Jane Doe
Author:   Owner Name
Due:      2026-04-30
Created:  2026-01-15
Edited:   2026-04-20
Priority: m
Subtasks (count): 3
Comments (count): 7
Labels:   urgent, backend
```

When `--with description` is set, append (after a blank line):

```
DESCRIPTION
<comment.content as plain text — HTML not rendered in v1; agents use --output json for fidelity>
```

When `--with subtasks` is set, append (after a blank line) a table:

```
SUBTASKS
ID    NAME                                   STATE     WORKER
8001  Sub 1                                  active    Jane Doe
8002  Sub 2                                  finished  (none)
…
```

Empty subtasks list under `--with subtasks`: header row + `(no subtasks)` body row, matching R04's convention.

When `--with projects` is set and `data.projects` is non-null, append:

```
MULTI-PROJECT MEMBERSHIP
<JSON-stringified multi_project_task block — agents prefer --output json>
```

When `data.projects` is null (single-project task), render `(single-project task)` as a single-line note. Agents reading JSON see `null`; humans see the note.

The renderer is in `src/ui/human/tasks-show.ts`, called from `renderAsync()`. Lazy `cli-table3` via `src/ui/table.ts`. The renderer reads `data.task` defensively (the schema uses `.passthrough()` so unknown fields pass through; the renderer pulls only the fields it documents).

### 3.5 Validation and error mapping

Same patterns as R04/R06 — only wording changes:

- **Missing `<id>` argument** — Commander error (exit 1, code `commander.missingArgument`). No special handling.
- **`<id>` not a positive integer** — `ValidationError({ exitCode: 2 })` with hint `"<id> must be a positive integer."`. Validated via `parseTaskId(raw)`. Calibration §1-2: throw `ValidationError`, **NOT** Commander's `InvalidArgumentError`.
- **Unknown `--with` value** — `ValidationError({ exitCode: 2 })` with hint `"--with accepts only: description, subtasks, projects."`. Validated synchronously **before** any HTTP call.
- **Empty `--with ""`** — `ValidationError({ exitCode: 2 })` with hint `"Specify at least one --with value, or omit --with."`.
- **404 on `/task/{id}`** — `FreeloApiError(httpStatus: 404, code: 'FREELO_API_ERROR', exitCode: 4)`. Command catches and rewrites `hintNext` to `"Task ${id} not found, or your account does not have access."`.
- **403 on `/task/{id}`** — `FreeloApiError(httpStatus: 403, code: 'FREELO_API_ERROR', exitCode: 4)`. Hint: `"Account does not have permission to view task ${id}."`.
- **404 / 403 on `/task/{id}/description`** — same rewrite, scoped: hint mentions `"description for task ${id}"`. Uncommon (the description endpoint always 200s when the task is visible) but covered for completeness.
- **404 / 403 on `/task/{id}/subtasks`** — same rewrite, scoped: hint mentions `"subtasks for task ${id}"`. Mid-stream pagination errors unwrap `PartialPagesError` (mirrors R04 workers — see `fetchAllWorkers` in `src/commands/projects/show.ts`).
- **401** anywhere — `FreeloApiError(code: 'AUTH_EXPIRED', exitCode: 3)` (handled by R01 client; no per-command logic).
- **5xx / network / 429** — handled identically to R04/R06 (R01 HTTP client retries 429s on GETs, bubbles 5xx as `FREELO_API_ERROR` with `code: SERVER_ERROR`).

Calibration §4 acknowledged: each new `try/catch` arm (one per HTTP call site = three arms total) gets at least one test triggering it.

## 4. Data model

### 4.1 `TaskDetail` schema (new)

Lives in `src/api/schemas/task.ts` next to the existing `TaskSummarySchema`, `TaskFullSchema`, `TaskFinishedSchema`. Built from scratch (not extended from `TaskFull`) because the field overlap is partial — `TaskDetail` adds `priority_enum`, `count_subtasks`, `cost`, `comments[]`, `custom_fields[]`, `total_time_estimate`, `users_time_estimates[]`, `tracking_users[]`, `multi_project_task` block, etc.

```ts
const PriorityEnumSchema = z.enum(['l', 'm', 'h']);

const FileBasicSchema = z.object({
  id: z.number().int(),
  uuid: z.string(),
  filename: z.string().nullable().optional(),
  size: z.number().int().nullable().optional(),
}).passthrough();

const CommentWithFilesSchema = z.object({
  id: z.number().int(),
  content: z.string().nullable().optional(),
  date_add: z.string().nullable().optional(),
  author: UserBasicSchema.nullable().optional(),
  is_description: z.boolean().nullable().optional(),
  files: z.array(FileBasicSchema).nullable().optional(),
}).passthrough();

const TimeEstimateSchema = z.object({ minutes: z.number().int() }).passthrough();

const UserTimeEstimateSchema = z.object({
  minutes: z.number().int(),
  user: UserBasicSchema,
}).passthrough();

const ProjectBasicRefSchema = z.object({
  id: z.number().int(),
  name: z.string().nullable().optional(),
}).passthrough();

const TasklistBasicRefSchema = z.object({
  id: z.number().int(),
  name: z.string().nullable().optional(),
}).passthrough();

// Multi-project task block — shape only loosely documented in the OpenAPI
// description. We accept any object with an optional list of projects each
// with id+name. The `passthrough()` lets unknown shape extensions through.
const MultiProjectBlockSchema = z.object({
  projects: z.array(z.object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
  }).passthrough()).nullable().optional(),
}).passthrough();

export const TaskDetailSchema = z.object({
  id: z.number().int(),
  name: z.string().nullable().optional(),
  date_add: z.string().nullable().optional(),
  date_edited_at: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  due_date_end: z.string().nullable().optional(),
  date_finished: z.string().nullable().optional(),
  minutes: z.number().int().nullable().optional(),
  priority_enum: PriorityEnumSchema.nullable().optional(),
  count_subtasks: z.number().int().nullable().optional(),
  parent_task_id: z.number().int().nullable().optional(),
  cost: CurrencySchema.nullable().optional(),
  author: UserBasicSchema.nullable().optional(),
  worker: UserBasicSchema.nullable().optional(),
  state: StateSchema.nullable().optional(),
  comments: z.array(CommentWithFilesSchema).nullable().optional(),
  labels: z.array(TaskLabelSchema).nullable().optional(),
  project: ProjectBasicRefSchema.nullable().optional(),
  tasklist: TasklistBasicRefSchema.nullable().optional(),
  custom_fields: z.array(z.unknown()).nullable().optional(),
  total_time_estimate: TimeEstimateSchema.nullable().optional(),
  users_time_estimates: z.array(UserTimeEstimateSchema).nullable().optional(),
  tracking_users: z.array(UserBasicSchema).nullable().optional(),
  multi_project_task: MultiProjectBlockSchema.nullable().optional(),
}).passthrough();

export type TaskDetail = z.infer<typeof TaskDetailSchema>;
```

`CurrencySchema`, `StateSchema`, `TaskLabelSchema` — already present in `src/api/schemas/task.ts` (private) or `src/api/schemas/tasklist.ts` (Currency). Reuse the local declarations; promote the Currency one if convenient or duplicate (decision deferred to implementer — same situation as R06 `FetchOpts`).

`PriorityEnumSchema` — uses the wire alphabet `l|m|h` (low/medium/high), per OpenAPI :1737 and :5466. Roadmap describes priorities as `low|normal|high` for the **write** path (R09); for the **read** path we surface what Freelo returns.

### 4.2 `Subtask` schema (new)

```ts
export const SubtaskSchema = z.object({
  id: z.number().int(),
  task_id: z.number().int().nullable().optional(),
  name: z.string().nullable().optional(),
  date_add: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  due_date_end: z.string().nullable().optional(),
  count_comments: z.number().int().nullable().optional(),
  count_subtasks: z.number().int().nullable().optional(),
  author: UserBasicSchema.nullable().optional(),
  worker: UserBasicSchema.nullable().optional(),
  state: StateSchema.nullable().optional(),
  project: ProjectBasicRefSchema.nullable().optional(),
  tasklist: TasklistBasicRefSchema.nullable().optional(),
  labels: z.array(TaskLabelSchema).nullable().optional(),
}).passthrough();

export type Subtask = z.infer<typeof SubtaskSchema>;
```

OpenAPI :5482-5530.

### 4.3 `TaskComment` (description) schema (new — leaner alias)

The `/task/{id}/description` endpoint returns the bare `Comment` schema (OpenAPI :5574-5587 — `id`, `content`, `date_add`, `files[]`). We declare a small schema for it; we do **not** reuse `CommentWithFilesSchema` because that's the richer shape used inside `TaskDetail.comments`.

```ts
export const TaskCommentSchema = z.object({
  id: z.number().int().nullable().optional(),
  content: z.string().nullable().optional(),
  date_add: z.string().nullable().optional(),
  files: z.array(FileBasicSchema).nullable().optional(),
}).passthrough();

export type TaskComment = z.infer<typeof TaskCommentSchema>;
```

`id` is `.nullable().optional()` (NOT required) because the OpenAPI says "If the task has no description yet, the response is still 200 but fields may be empty / null" (:2014). Hardening per the R05.5 lessons.

### 4.4 Envelope data schema (new)

```ts
export const TasksShowDataSchema = z.object({
  task: TaskDetailSchema,
  description: TaskCommentSchema.optional(),
  subtasks: z.array(SubtaskSchema).optional(),
  // `projects` is the multi_project_task block; may be null when the task
  // is single-project, present-and-null vs. absent are distinct (decision 1).
  projects: MultiProjectBlockSchema.nullable().optional(),
});

export type TasksShowData = z.infer<typeof TasksShowDataSchema>;
```

The runtime-Zod schema is exported because both the command and the human renderer consume the inferred type. `MultiProjectBlockSchema` is exported alongside.

### 4.5 New API functions

`src/api/tasks.ts` adds three:

```ts
export async function getTaskDetail(
  client: HttpClient,
  taskId: number,
  opts: FetchOpts,
): Promise<ApiResponse<TaskDetail>>;

export async function getTaskDescription(
  client: HttpClient,
  taskId: number,
  opts: FetchOpts,
): Promise<ApiResponse<TaskComment>>;

export async function getTaskSubtasks(
  client: HttpClient,
  taskId: number,
  opts: FetchOpts & { page: number },
): Promise<{ page: NormalizedPage<Subtask>; raw: ApiResponse<unknown> }>;
```

`getTaskDetail` validates with `TaskDetailSchema`. `getTaskDescription` validates with `TaskCommentSchema`. `getTaskSubtasks` follows R04's `getProjectWorkers` pattern: `client.request(... schema: z.unknown() ...)` then `normalizePaginated(raw.data, 'subtasks', SubtaskSchema)`. The `signal` / `requestId` plumbing matches the existing R07 wrappers exactly.

Reuses the local `FetchOpts` type already declared in `src/api/tasks.ts` (R07 line 16-19).

## 5. CLI behaviour matrix

| Invocation | HTTP calls | `data.task` | `data.description` | `data.subtasks` | `data.projects` | Exit |
|---|---|---|---|---|---|---|
| `freelo tasks show 9001` | `GET /task/9001` | present | absent | absent | absent | 0 |
| `freelo tasks show 9001 --with description` | `GET /task/9001`, `GET /task/9001/description` | present | present | absent | absent | 0 |
| `freelo tasks show 9001 --with subtasks` | `GET /task/9001`, `GET /task/9001/subtasks?p=0..` | present | absent | present (full) | absent | 0 |
| `freelo tasks show 9001 --with projects` | `GET /task/9001` only | present | absent | absent | present (object or null) | 0 |
| `freelo tasks show 9001 --with description,subtasks,projects` | `GET /task/9001`, `GET .../description`, `GET .../subtasks?p=0..` | present | present | present | present | 0 |
| `freelo tasks show 9001 --with description,description` (dup) | as `--with description` | present | present | absent | absent | 0 |
| `freelo tasks show 9001 --with bogus` | none (validation fails first) | n/a | n/a | n/a | n/a | 2 |
| `freelo tasks show 9001 --with ""` | none | n/a | n/a | n/a | n/a | 2 |
| `freelo tasks show abc` | none | n/a | n/a | n/a | n/a | 2 |
| `freelo tasks show 0` | none | n/a | n/a | n/a | n/a | 2 |
| `freelo tasks show 99999` (404 on detail) | one | n/a (error) | n/a | n/a | n/a | 4 |
| `freelo tasks show 7` (403 on detail) | one | n/a (error) | n/a | n/a | n/a | 4 |
| `freelo tasks show 9001 --with description` (404 on description) | two | n/a (error) | n/a | n/a | n/a | 4 |
| `freelo tasks show 9001 --with subtasks` (5xx on subtasks) | two | n/a (error) | n/a | n/a | n/a | 4 |
| `freelo tasks show 9001` (5xx on detail) | one | n/a (error) | n/a | n/a | n/a | 4 |
| `freelo tasks show 9001` (401 anywhere) | one | n/a (error) | n/a | n/a | n/a | 3 |

## 6. Non-goals (v1)

- **`--with comments`.** `TaskDetail` already embeds the full comments thread under `data.task.comments` (OpenAPI :5423-5426). Adding it as a top-level side-car would be redundant. If we ever want comments at the envelope top level, that's an additive R08.x.
- **Parallel HTTP calls for the side-cars.** v1 is sequential for deterministic error ordering. A future optimization can parallelize description + subtasks (they're independent of each other once `data.task` is fetched). Not breaking when added.
- **`--fields a,b,c` projection** on the task object. The shape is large but agents prune client-side; non-breaking to add later.
- **`--subtasks-page N`, `--subtasks-cursor C`.** Subtasks fetch is opaque "all or nothing" in v1. Knobs are non-breaking to add later.
- **HTML rendering of `data.description.content`** in human mode. v1 prints the raw content. Agents read JSON anyway.
- **A real `GET /task/{id}/projects` call.** Not in the OpenAPI; embedded data is the source of truth. If Freelo ever adds the endpoint, R08 can switch to it transparently — the envelope shape under `data.projects` is already defined.

## 7. Open questions — resolved

### OQ#1 — `--with projects`: separate HTTP call or embedded projection?

`GET /task/{id}/projects` is **not documented** in `docs/api/freelo-api.yaml`. Only `POST` (assign-to-project) and `DELETE` (remove-from-project) exist on that path. The roadmap line for R08 names the GET, but the contract doesn't expose it.

The autonomous-sdlc rules say "API behavior not in `docs/api/freelo-api.yaml`" → **Pause**. Here we **do not pause** because the documented data answers the same agent question:

> *"For multi-project tasks, the response contains a `multi_project_task` block mapping the task across its projects."* (OpenAPI :1676)

That block is already part of `TaskDetail`, fetched by step 1. The `--with projects` side-car is therefore a **projection** of the already-fetched detail into a top-level envelope key, not a new HTTP call.

**Resolved: project the embedded block.** Documented as decision 1 in the run's decisions log. The roadmap's R08 entry will be updated in the spec PR.

Alternatives considered:

- **Pause and ask.** Heavy-handed for a slice that has a documented answer.
- **Probe the live API for an undocumented `GET /task/{id}/projects`.** Forbidden by the run config (`allowNetwork: false`).
- **Drop `--with projects` from v1.** Loses the user-visible feature listed in the roadmap and the requirement.

The chosen design preserves the requirement, stays on documented behavior, and is forward-compatible — if Freelo ever adds the GET, R08.x can switch to it without a breaking envelope bump (the data shape under `data.projects` is the same multi-project block either way).

### OQ#2 — `data.projects` value: empty array, null, or absent for single-project tasks?

Three states matter to agents:
1. **`--with projects` not requested** → `data.projects` is *absent*.
2. **`--with projects` requested, task is multi-project** → `data.projects` is the block object.
3. **`--with projects` requested, task is single-project** → `data.projects` is `null` (the block isn't present in the wire response).

**Resolved:** keep all three states distinct. `null` ≠ absent ≠ object. Agents can `'projects' in data` for "did the user ask?" and `data.projects !== null` for "is it multi-project?". This is the only side-car that can legitimately be `null` (description and subtasks always have a value when fetched).

### OQ#3 — Error hint specificity per call site

Resolved: same pattern as R06 OQ#3. Three `try/catch` arms (one per HTTP call site: detail / description / subtasks), each rewriting `hintNext` to mention the right resource. Calibration §4 binding — each arm has at least one test triggering it.

### OQ#4 — `request_id` propagation

Resolved: all HTTP calls receive the same `appConfig.requestId` (when set). The envelope's `request_id` is whatever `appConfig.requestId` is — not derived from the HTTP layer's per-call requestIds. Consistent with R04 / R06.

### OQ#5 — Why not extend `TaskFullSchema` for `TaskDetail`?

`TaskDetail` is materially richer than `TaskFull`: adds `priority_enum`, `count_subtasks`, `cost`, `comments[]`, `custom_fields[]`, `total_time_estimate`, `users_time_estimates[]`, `tracking_users[]`, `multi_project_task`, `parent_task_id`, `minutes`, `date_finished`, plus a leaner `project` / `tasklist` (without nested `state`). Extending `TaskFullSchema` would force every new field to be `.optional()` to satisfy zod, at which point we've effectively rewritten the schema.

**Resolved: declare `TaskDetailSchema` from scratch.** Same pattern as R06 OQ#5 (`TasklistDetail` not extended from `TasklistFull`).

## 8. Plan

### 8.1 Files to add (new)

1. `src/commands/tasks/show.ts` — leaf command. Exports `registerShow(parent, getConfig, env)` and `meta`. Mirrors the R04 `projects/show.ts` shape (with `fetchAllPages` for the subtasks side-car) plus the R06 detail-then-bare-call pattern (for description).
2. `src/ui/human/tasks-show.ts` — pure shape → string mapper. Lazy-imports `cli-table3` via `src/ui/table.ts` for the subtasks table.
3. `test/commands/tasks/show.test.ts` — end-to-end via `program.parseAsync` (mirror of `test/commands/tasklists/show.test.ts`'s harness).
4. `test/api/tasks-show.test.ts` — `getTaskDetail` + `getTaskDescription` + `getTaskSubtasks` HTTP wrapper tests via MSW.
5. `test/fixtures/tasks/show-task-9001.json` — `TaskDetail` fixture (single-project + multi-project variants).
6. `test/fixtures/tasks/show-task-9001-multi.json` — `TaskDetail` with `multi_project_task` populated.
7. `test/fixtures/tasks/show-description.json` — `TaskComment` fixture.
8. `test/fixtures/tasks/show-subtasks-page0.json`, `show-subtasks-page1.json` — paginated `subtasks` fixtures (multi-page).
9. `.changeset/<auto>.md` — `minor`, summary: `feat(commands): add 'freelo tasks show <id>' for task detail with optional description, subtasks, and projects side-cars`. Schema callout: introduces `freelo.tasks.show/v1`.
10. `docs/commands/tasks-show.md` — user-facing.

### 8.2 Files to modify

11. `src/commands/tasks.ts` — register the `show` subcommand alongside `list`.
12. `src/api/schemas/task.ts` — add `TaskDetailSchema`, `SubtaskSchema`, `TaskCommentSchema`, `MultiProjectBlockSchema`, `TasksShowDataSchema`. Also surface helper schemas (`PriorityEnumSchema`, `FileBasicSchema`, `CommentWithFilesSchema`, `TimeEstimateSchema` — but `TimeEstimateSchema` is already declared inline at line 28, reuse it; `UserTimeEstimateSchema` is already declared inline at line 30, reuse it; `StateSchema` is already declared at line 15, reuse it; `TaskLabelSchema` is already declared at line 20, reuse it; `ProjectRefSchema` is at line 37 with `state`; we need leaner `ProjectBasicRefSchema` / `TasklistBasicRefSchema` — declare new). Reuse `CurrencySchema` from `src/api/schemas/tasklist.ts` (export it from there) or duplicate it locally. Implementer's call.
13. `src/api/tasks.ts` — add `getTaskDetail`, `getTaskDescription`, `getTaskSubtasks` functions.
14. `test/msw/handlers.ts` — add `tasksShowHandlers` factory namespace: `detailOk(id, body)`, `detailNotFound(id)`, `detailForbidden(id)`, `detailUnauthorized(id)`, `detailServerError(id, status)`, `descriptionOk(id, body)`, `descriptionNotFound(id)`, `descriptionForbidden(id)`, `descriptionServerError(id, status)`, `subtasksPaged(id, pages)`, `subtasksNotFound(id)`, `subtasksForbidden(id)`, `subtasksServerError(id, status)`, `subtasksMidStreamError({id, pages, failPage, status})`.
15. `docs/roadmap.md` — update the R08 entry to clarify that `--with projects` projects from the embedded `multi_project_task` block (rather than calling a `GET /task/{id}/projects` that doesn't exist in the documented OpenAPI). One-line note.
16. `README.md` — autogen Commands block updated by `pnpm fix:readme`.

### 8.3 Test plan (≥85% branch coverage on `src/commands/**` is enforced)

`test/commands/tasks/show.test.ts` cases (Calibration §1-2 — exit-code assertions are non-negotiable):

**Happy paths:**
- Default (no `--with`) → envelope has `data.task`, no other side-car keys. Exit 0.
- `--with description` → `data.description` is the parsed `TaskComment`. Exit 0.
- `--with subtasks` single page → `data.subtasks` is the merged list. Exit 0.
- `--with subtasks` multi-page → `data.subtasks` includes items from every page. Exit 0.
- `--with subtasks` empty page → `data.subtasks` is `[]`. Exit 0.
- `--with projects` (multi-project task) → `data.projects` is the block object. Exit 0.
- `--with projects` (single-project task) → `data.projects` is `null` (key present, value null). Exit 0.
- `--with description,subtasks,projects` → all three side-cars present. Exit 0.
- `--with description,description` (duplicate) → treated as one. Exit 0.
- `--request-id <uuid>` round-trips into envelope. Exit 0.
- `--output human` smoke (no error envelope, exit 0).
- `--output human --with subtasks` empty → `(no subtasks)` row. Exit 0.
- `--output human --with projects` single-project → `(single-project task)` note. Exit 0.

**Validation errors (no HTTP):**
- Non-numeric `<id>` (`abc`) → exit 2, `freelo.error/v1`, `code: VALIDATION_ERROR`.
- Zero `<id>` → exit 2, `code: VALIDATION_ERROR`.
- `--with bogus` → exit 2, `hint_next` mentions `description, subtasks, projects`.
- `--with ""` → exit 2.

**Detail-call error paths:**
- 404 on `/task/{id}` → exit 4, hint mentions `task ${id} not found / no access`.
- 403 on `/task/{id}` → exit 4, hint mentions `permission` and the task id.
- 5xx on `/task/{id}` → exit 4, `code: SERVER_ERROR`, no 404/403 hint injection.
- 401 on `/task/{id}` → exit 3, `code: AUTH_EXPIRED`.

**Description-call error paths (after detail succeeds):**
- 404 on `/task/{id}/description` → exit 4, hint mentions `description for task ${id}`.
- 403 on `/task/{id}/description` → exit 4, hint mentions `permission` + `description`.
- 5xx on `/task/{id}/description` → exit 4, `code: SERVER_ERROR`.

**Subtasks-call error paths (after detail succeeds):**
- 404 on `/task/{id}/subtasks` → exit 4, hint mentions `subtasks for task ${id}`.
- 403 on `/task/{id}/subtasks` → exit 4, hint mentions `permission` + `subtasks`.
- 5xx mid-stream on `/task/{id}/subtasks?p=N` → exit 4, `PartialPagesError` unwraps to underlying `FreeloApiError`.

`test/api/tasks-show.test.ts` cases:

- `getTaskDetail` URL = `/task/{id}` (verify via MSW request matching).
- `getTaskDetail` parses through `TaskDetailSchema` (round-trips `multi_project_task` block).
- `getTaskDescription` URL = `/task/{id}/description`. Empty fields tolerated (id null, content null).
- `getTaskSubtasks` URL = `/task/{id}/subtasks?p=N`. Returns normalized page.
- `getTaskSubtasks` rejects malformed wrapper (missing `data.subtasks` key).
- All three wrappers propagate `requestId` and `signal` (one positive case each).

### 8.4 Commit slicing

Single PR. **Two commits** for clean review:

1. `feat(api): add TaskDetail, Subtask, TaskComment schemas and task-detail HTTP wrappers` — `src/api/schemas/task.ts`, `src/api/tasks.ts`, `test/api/tasks-show.test.ts`, `test/fixtures/tasks/show-*.json`, `test/msw/handlers.ts`.
2. `feat(commands): add 'freelo tasks show <id>' with description, subtasks, and projects side-cars` — `src/commands/tasks/show.ts`, `src/commands/tasks.ts`, `src/ui/human/tasks-show.ts`, `test/commands/tasks/show.test.ts`, `.changeset/<auto>.md`, `docs/commands/tasks-show.md`, `docs/roadmap.md`, `README.md` (via `pnpm fix:readme`).

Calibration §3 — each commit must be green on its own committed tree:

```
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme
```

`check:readme` is only meaningful after commit 2 runs `fix:readme`. Run all five gates as the final pre-push step on the **committed** tree.

### 8.5 Acceptance criteria

- All test cases in §8.3 pass.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme` clean on the final committed tree.
- Coverage thresholds (`src/commands/**` ≥ 85% branches; project-wide thresholds in `vitest.config.ts`) not regressed.
- `freelo --introspect` includes `tasks show` with `args: [{ name: 'id', required: true, ... }]` and `flags: [{ name: '--with', ... }]` plus inherited globals. (The introspect golden file does NOT register the tasks tree, so the golden does not need updating.)
- `freelo tasks show --help` mentions `--with description,subtasks,projects`.
- The changeset captures `freelo.tasks.show/v1` as a new public envelope schema.
- `docs/roadmap.md` R08 entry reflects the embedded-projection decision for `--with projects`.

### 8.6 Risks and mitigations

| Risk | Mitigation |
|---|---|
| `TaskDetail` schema drifts from real responses (e.g. `priority_enum` is sometimes empty string instead of one of `l|m|h`) | `passthrough()` absorbs unknowns; every field is `.nullable().optional()`. The `priority_enum` field is `PriorityEnumSchema.nullable().optional()`; if Freelo emits empty strings, loosen to `z.string().nullable().optional()` in a follow-up. |
| `multi_project_task` shape varies per Freelo (loosely documented) | `MultiProjectBlockSchema.passthrough()` accepts any object; we only project, never validate the shape strictly. |
| Coverage drop on `src/commands/tasks/show.ts` | Spec §8.3 covers every error branch with a targeted test. Three `try/catch` arms each have at least one test triggering them. Calibration §4 binding. |
| `getTaskDescription` returns mostly-null body when description is empty | `TaskCommentSchema` declares every field `.nullable().optional()` (including `id`). One test case asserts an empty-description response parses cleanly. |
| `pnpm fix:readme` produces a churn-y diff | Run it once at the end of commit 2; commit the README change in the same commit. |

### 8.7 Out of scope for /implement (re-stated)

Do not introduce: `--with comments` (already embedded), parallel HTTP calls, `--fields` projection, subtasks pagination knobs, HTML rendering, a real `GET /task/{id}/projects` HTTP call (not in the OpenAPI).

```
ARCHITECT phase=plan run=2026-04-27-0535-tasks-show status=ok files=16 commits=2 new_deps=0
```
