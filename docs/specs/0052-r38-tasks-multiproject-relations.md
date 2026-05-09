# Spec 0052 — `freelo tasks project add` / `remove` + `tasks relations` / `find-relations` (R38, Wave 6)

**Status:** Draft
**Owner:** orchestrator (run `2026-05-09-1200-r38-tasks-multiproject-relations`)
**Roadmap:** R38
**Date:** 2026-05-09
**Depends on:** R10 (`tasks edit`, spec 0020) — task-id parsing pattern; R13 (`tasks delete`, spec 0024) — destructive single-id confirm + 404-idempotency pattern; R33 (`projects invite`, spec 0046) — `--project <id>...` repeatable flag pattern; R35 / R36 / R37 (specs 0049–0051) — most recent precedents for parent + leaves shape (R35, R37) and read-only single command (R36 `share`).

## 1. Problem

Freelo has two distinct task surfaces the CLI does not yet expose:

1. **Multi-project membership (UVVP — `Úkol Více Vlastních Projektů`).** A task that lives in one project can be promoted to additionally appear in another project, with a child task linked to the same logical parent. This is the primary mechanism for cross-team visibility (e.g. one ticket visible in both Sales and Engineering). The wire endpoints are `POST /task/{id}/projects` (yaml :1893-1941) and `DELETE /task/{id}/projects/{project_id}` (yaml :1971-2000).

2. **Task relations.** Freelo lets you record typed cross-references between tasks — `blocked_by`, `blocks`, `related_to`, `duplicate_of`. The wire endpoints to query relations are `GET /task/{id}/relations` (per-task, yaml :1943-1969) and `POST /tasks/relations` (bulk, yaml :1614-1660). Note: there is **no documented endpoint to *create*** relations — both endpoints are read-only / query-only. The CLI command is correctly named `find-relations` accordingly.

Today an agent or shell script that wants to:

1. Share a task with another team without duplicating it manually,
2. Roll back an accidental cross-team assignment,
3. Inspect what a task is blocking / blocked by before closing it,
4. Build a dependency graph across many tasks for status reporting,

…has to leave the terminal. There is no programmatic surface in the CLI today.

## 2. Proposal

### 2.1 CLI surface (additive — one new parent + two new top-level leaves)

```
freelo tasks project add    <id> --tasklist <id>... [--dry-run]
freelo tasks project remove <id> --project  <id>   [--yes] [--dry-run]
freelo tasks relations      <id>
freelo tasks find-relations --task <id>...
```

Three structurally distinct shapes, one per surface:

| shape                                  | precedent                  | rationale                                                         |
| -------------------------------------- | -------------------------- | ----------------------------------------------------------------- |
| `project` parent + `add` / `remove`    | R37 (`estimate set/clear`) | Two verbs, share a noun (`project`), one destructive, one not.    |
| `relations <id>` (top-level leaf)      | R36 `share` (read-only)    | One single-id read-only; no shared option surface to consolidate. |
| `find-relations` (top-level sibling)   | none — new shape           | Bulk read, no positional id; flag-driven. See decision 1.         |

### 2.2 Wire mapping

#### `tasks project add <id> --tasklist <id>...`

```
POST /task/{id}/projects
Content-Type: application/json
{ "tasklist_id": <int> }
```

Per yaml :1911-1922 the **request body takes `tasklist_id`, not `project_id`.** The Freelo server derives the target project from the tasklist. The roadmap CLI sketch says `--project <id>...` but that would be a lie — we cannot send a project id to a body that expects a tasklist id, and we will not invent a project-id-to-tasklist-id GET that doesn't exist. See decision 2.

`--tasklist <id>` is repeatable. Each value fans out to **one POST**: yaml :1911-1922 documents a single-tasklist request body, no array form. With N tasklists, the CLI issues N sequential POSTs. See decision 3.

Response (yaml :1923-1937): `{ task: { id: <int>, uuid: <str> } }`. The `id` field is the **child task id** (the new task in the secondary project) — the parent task id is `<id>` (positional). Both are surfaced in the envelope.

#### `tasks project remove <id> --project <id>`

```
DELETE /task/{id}/projects/{project_id}
(no body)
```

Single project per call (yaml :1971). Single-id v1; `--project` is **not** repeatable on `remove` because the destructive prompt copy and exit-code semantics get muddled when one DELETE succeeds and another 403s. Single-id matches the roadmap.

Response (yaml :1990-1996): `SuccessResponse`.

403 on primary-project removal (yaml :1984): the server returns 403 `AclException` — we do **not** re-classify as idempotent here. A 403 is informative ("you tried to remove the primary; use `tasks delete` instead") and surfaces as `FreeloApiError` exit 4 with a `hintNext`.

404: defensive forward-compat, mirrors R13/R35/R36/R37 — re-classify as `already_in_target_state: true`.

#### `tasks relations <id>`

```
GET /task/{id}/relations
(no body)
```

Returns `{ relations: [TaskRelation, ...] }` (yaml :1955-1965). Each `TaskRelation` (yaml :4870-4879) has `type` (`blocked_by` | `blocks` | `related_to` | `duplicate_of`), `related_task_id`, `related_task_name`. Empty array on no relations is a valid 200 response.

403 / 404 → `FreeloApiError` per the standard top-level handler.

#### `tasks find-relations --task <id>...`

```
POST /tasks/relations
Content-Type: application/json
{ "task_ids": [<int>, <int>, ...] }
```

Single bulk POST (yaml :1614-1658). Body has 1–100 task ids; the CLI enforces the upper bound client-side. Response: `{ tasks: [{ task_id: <int>, relations: [TaskRelation, ...] }, ...] }`. Tasks the caller cannot access are **silently omitted** by the server (yaml :1622). The CLI surfaces this honestly: agents diff `validated.task_ids` against `data.tasks[*].task_id` to detect omissions.

### 2.3 Output schemas

Four new envelope schemas, one per leaf:

#### `freelo.tasks.project.add/v1`

| field                | type                              | always present | notes                                                                            |
| -------------------- | --------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| `task_id`            | int                               | yes            | echo of `<id>` positional (the parent task)                                      |
| `tasklist_ids`       | int[]                             | yes            | echo of `--tasklist <id>...`, deduplicated, length >= 1 on the validated path    |
| `assignments`        | array of `{ tasklist_id, child_task_id, child_task_uuid }` | live only | one entry per tasklist that successfully POSTed; on a fan-out failure mid-loop, contains the entries completed so far |
| `would`              | object                            | dry-run only   | `{ method: 'POST', path, body: { tasklist_ids } }` — collapsed echo for clarity  |

#### `freelo.tasks.project.remove/v1`

| field                       | type    | always present | notes                                                                              |
| --------------------------- | ------- | -------------- | ---------------------------------------------------------------------------------- |
| `task_id`                   | int     | yes            | echo of `<id>` positional                                                          |
| `project_id`                | int     | yes            | echo of `--project <id>`                                                           |
| `already_in_target_state`   | boolean | yes            | `true` only on the defensive 404 path; `false` on live 200. Dry-run: `false`.      |
| `would`                     | object  | dry-run only   | `{ method: 'DELETE', path, body: {} }`                                             |

#### `freelo.tasks.relations/v1`

| field      | type             | always present | notes                                                                |
| ---------- | ---------------- | -------------- | -------------------------------------------------------------------- |
| `task_id`  | int              | yes            | echo of `<id>` positional                                            |
| `relations`| `TaskRelation[]` | yes            | empty array on no relations                                          |

`TaskRelation`:
```ts
{ type: 'blocked_by' | 'blocks' | 'related_to' | 'duplicate_of'; related_task_id: number; related_task_name: string }
```

#### `freelo.tasks.find-relations/v1`

| field       | type                                                       | always present | notes                                                                            |
| ----------- | ---------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| `task_ids`  | int[]                                                      | yes            | echo of `--task <id>...`, deduplicated, length 1–100                             |
| `tasks`     | `{ task_id: number; relations: TaskRelation[] }[]`         | yes            | only tasks the caller can access; `task_ids \ tasks[*].task_id` = inaccessible    |

### 2.4 Validation rules

- `<id>` positional (on `project add`, `project remove`, `relations`) — positive integer. `ValidationError` exit 2 (calibration §1-2).
- `--tasklist <id>` (on `project add`) — repeatable. Each value: positive integer. **At least one required**; missing → `ValidationError` exit 2. Duplicates: silently deduplicate (R33 `projects invite` precedent for `--user` / `--project` in the same call).
- `--project <id>` (on `project remove`) — single value, positive integer, **required**.
- `--task <id>` (on `find-relations`) — repeatable. Each value: positive integer. **At least one, at most 100, required**; deduplicate. Out-of-range → `ValidationError` exit 2 with explicit "max 100".
- `find-relations` does **not** accept a positional `<id>` argument — pure flag-driven (mirrors `projects invite`).
- `relations` does **not** accept `--task` (single-id only).
- Destructive flag (`--yes`) only meaningful on `project remove`.
- All four leaves accept `--dry-run` except the read-only `relations` and `find-relations` (no destructive or stateful effect to skip; `--dry-run` would be a no-op surprise — see decision 5).

### 2.5 Confirmation policy (`project remove` only)

Mirrors R13 / R35 / R36 / R37 byte-for-byte for the single-id flow:

- `--yes` → unconditional proceed.
- `--dry-run` → unconditional proceed (no destructive effect).
- TTY without `--yes` → prompt: `"Remove task #<id> from project #<project_id>?"`. Decline → `ConfirmationError` (exit 2).
- Non-TTY without `--yes` → throw `ConfirmationError` (exit 2) immediately (fail closed).

`project add` is non-destructive (it's additive — creating a child task in a new project); no confirmation gate.

### 2.6 Idempotency

#### `project add`

The server upserts on a duplicate `tasklist_id` (creating a child task in a project where the task already has a child is silently a no-op) **or** it returns 403 / 4xx. The OpenAPI does not document the duplicate-tasklist case. We do **not** surface `already_in_target_state` on `add` — mirroring R37 `set` decision 5: be honest about wire ambiguity. See decision 4.

#### `project remove`

Live 200: `already_in_target_state: false` (we cannot tell if the link existed).
Defensive 404: `already_in_target_state: true` (forward-compat — yaml :1985 does say 404 if not present in project, so this **is** the documented behavior, not just defensive).

#### `relations` / `find-relations`

Read-only — idempotency is not applicable. No `already_in_target_state` field.

### 2.7 Dry-run behaviour

- `project add --dry-run`: no wire call, single envelope with `dry_run: true`, `data.would.body.tasklist_ids` = the deduplicated array. We collapse the per-tasklist fan-out into one echo for clarity (decision 6) — agents can still derive the N round-trips by counting `tasklist_ids`. `data.assignments` is **omitted** on dry-run (no child task ids known).
- `project remove --dry-run`: no wire call, no prompt. `data.would.body = {}`.
- `relations` / `find-relations`: **no `--dry-run`** flag (decision 5 — read-only, dry-run would always be a no-op surprise).

### 2.8 Help text

```
Usage: freelo tasks project [options] [command]

Manage which projects a task is visible in (multi-project membership, UVVP).
Promotes a single-project task into a cross-team task by creating a child
in another project, or rolls back an accidental cross-team assignment.

Commands:
  add    <id> --tasklist <id>...         Add the task to one or more secondary projects.
  remove <id> --project  <id>             Remove the task from a single secondary project.

Options for `add`:
  --tasklist <id>   Numeric tasklist id (repeatable). The target project is derived from
                    the tasklist by Freelo. At least one required.
  --dry-run         Skip the POST(s); envelope echoes the body that would have been sent.

Options for `remove`:
  --project <id>    Numeric project id of the SECONDARY project to remove the task from.
                    Required. Removing the task's primary project requires `freelo tasks
                    delete <id>` instead — Freelo returns 403 AclException otherwise.
  --yes             Bypass the confirmation prompt (required in non-TTY mode).
  --dry-run         Skip the DELETE; envelope echoes the path that would have been called.

Usage: freelo tasks relations [options] <id>

Show all typed relations on a single task (blocked_by, blocks, related_to, duplicate_of).
Read-only. Empty array if the task has no relations. Relations to tasks the caller
cannot access are silently filtered out by Freelo.

Usage: freelo tasks find-relations [options]

Bulk-fetch relations for many tasks at once (1–100 per call). Read-only. Tasks the caller
cannot access are silently omitted from the response.

Options:
  --task <id>   Numeric task id (repeatable). At least one, at most 100. Required.
```

### 2.9 Examples

```bash
# Add a task to two more projects (one POST per --tasklist):
$ freelo tasks project add 4567 --tasklist 100 --tasklist 200 --output json
{"schema":"freelo.tasks.project.add/v1","data":{"task_id":4567,"tasklist_ids":[100,200],"assignments":[{"tasklist_id":100,"child_task_id":9001,"child_task_uuid":"abc-001"},{"tasklist_id":200,"child_task_id":9002,"child_task_uuid":"abc-002"}]}}

# Dry-run — single envelope, no per-tasklist call:
$ freelo tasks project add 4567 --tasklist 100 --tasklist 200 --dry-run --output json
{"schema":"freelo.tasks.project.add/v1","dry_run":true,"data":{"task_id":4567,"tasklist_ids":[100,200],"would":{"method":"POST","path":"/task/4567/projects","body":{"tasklist_ids":[100,200]}}}}

# Remove from a secondary project (TTY prompts):
$ freelo tasks project remove 4567 --project 42
? Remove task #4567 from project #42? (y/N) y
{"schema":"freelo.tasks.project.remove/v1","data":{"task_id":4567,"project_id":42,"already_in_target_state":false}}

# Already removed → idempotent success:
$ freelo tasks project remove 4567 --project 42 --yes --output json
{"schema":"freelo.tasks.project.remove/v1","data":{"task_id":4567,"project_id":42,"already_in_target_state":true}}

# Show relations for one task:
$ freelo tasks relations 4567 --output json
{"schema":"freelo.tasks.relations/v1","data":{"task_id":4567,"relations":[{"type":"blocks","related_task_id":9876,"related_task_name":"Ship the thing"}]}}

# No relations — empty array:
$ freelo tasks relations 4567 --output json
{"schema":"freelo.tasks.relations/v1","data":{"task_id":4567,"relations":[]}}

# Bulk relations (one POST):
$ freelo tasks find-relations --task 4567 --task 4568 --task 4569 --output json
{"schema":"freelo.tasks.find-relations/v1","data":{"task_ids":[4567,4568,4569],"tasks":[{"task_id":4567,"relations":[{"type":"blocks","related_task_id":9876,"related_task_name":"X"}]},{"task_id":4568,"relations":[]}]}}
# Note: 4569 omitted from `tasks` — caller cannot access it.

# Validation: too many --task ids:
$ freelo tasks find-relations --task 1 --task 2 ... (101 of them)
# stderr: VALIDATION_ERROR — --task accepts at most 100 ids per call. exit 2.

# Validation: removal of primary project:
$ freelo tasks project remove 4567 --project <primary_id> --yes
# stderr: FREELO_API_ERROR — Role action forbidden. Hint: removing a task's primary project requires `freelo tasks delete <id>`. exit 4.
```

## 3. Data model

### 3.1 New file: `src/api/schemas/task-projects.ts`

```ts
import { z } from 'zod';

/**
 * `POST /task/{task_id}/projects` response (yaml :1923-1937).
 * `task.id` and `task.uuid` are the child task identifiers in the new
 * (secondary) project. We treat them as required-on-200 but `.passthrough()`
 * the wrapper for forward-compat.
 */
export const AssignTaskToProjectResponseSchema = z
  .object({
    task: z
      .object({
        id: z.number().int(),
        uuid: z.string(),
      })
      .passthrough(),
  })
  .passthrough();
export type AssignTaskToProjectResponse = z.infer<typeof AssignTaskToProjectResponseSchema>;

/**
 * `DELETE /task/{task_id}/projects/{project_id}` response (yaml :1990-1996) —
 * generic `SuccessResponse`.
 */
export const RemoveTaskFromProjectResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();
export type RemoveTaskFromProjectResponse = z.infer<typeof RemoveTaskFromProjectResponseSchema>;

/* ---- envelope `data` types -------------------------------------------- */

export type ProjectAddAssignment = {
  tasklist_id: number;
  child_task_id: number;
  child_task_uuid: string;
};

export type ProjectAddWould = {
  method: 'POST';
  path: string;
  body: { tasklist_ids: number[] };
};

export type TasksProjectAddData = {
  task_id: number;
  tasklist_ids: number[];
  assignments?: ProjectAddAssignment[];
  would?: ProjectAddWould;
};

export type ProjectRemoveWould = {
  method: 'DELETE';
  path: string;
  body: Record<string, never>;
};

export type TasksProjectRemoveData = {
  task_id: number;
  project_id: number;
  already_in_target_state: boolean;
  would?: ProjectRemoveWould;
};
```

### 3.2 New file: `src/api/schemas/task-relations.ts`

```ts
import { z } from 'zod';

export const TaskRelationTypeSchema = z.enum(['blocked_by', 'blocks', 'related_to', 'duplicate_of']);
export type TaskRelationType = z.infer<typeof TaskRelationTypeSchema>;

/**
 * `TaskRelation` per yaml :4870-4879. The OpenAPI marks none of the fields
 * `required:`; we treat them all as required-on-the-wire but apply
 * `.nullable().optional()` defensively for `related_task_name` (Freelo
 * occasionally returns null names for orphaned references).
 */
export const TaskRelationSchema = z
  .object({
    type: TaskRelationTypeSchema,
    related_task_id: z.number().int(),
    related_task_name: z.string().nullable().optional(),
  })
  .passthrough();
export type TaskRelation = z.infer<typeof TaskRelationSchema>;

/** `GET /task/{task_id}/relations` response (yaml :1955-1965). */
export const GetTaskRelationsResponseSchema = z
  .object({
    relations: z.array(TaskRelationSchema),
  })
  .passthrough();
export type GetTaskRelationsResponse = z.infer<typeof GetTaskRelationsResponseSchema>;

/** `POST /tasks/relations` response (yaml :1645-1658). */
export const FindTaskRelationsResponseSchema = z
  .object({
    tasks: z.array(
      z
        .object({
          task_id: z.number().int(),
          relations: z.array(TaskRelationSchema),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type FindTaskRelationsResponse = z.infer<typeof FindTaskRelationsResponseSchema>;

/* ---- envelope `data` types -------------------------------------------- */

/**
 * `freelo.tasks.relations/v1` envelope `data`. Read-only.
 */
export type TasksRelationsData = {
  task_id: number;
  relations: TaskRelation[];
};

/**
 * `freelo.tasks.find-relations/v1` envelope `data`. Read-only bulk.
 *
 * `tasks[*].task_id` is a subset of `task_ids` — the server silently omits
 * tasks the caller cannot access. Agents diff to detect inaccessible ids.
 */
export type TasksFindRelationsData = {
  task_ids: number[];
  tasks: { task_id: number; relations: TaskRelation[] }[];
};
```

### 3.3 New files: `src/api/tasks-projects.ts`, `src/api/tasks-relations.ts`

Thin wire wrappers. Match the shape of `tasks-share.ts` and `tasks-estimate.ts`:

- `tasks-projects.ts`: `assignTaskPath(taskId)`, `removeTaskFromProjectPath(taskId, projectId)`, `assignTaskToProject(client, taskId, tasklistId, opts)`, `removeTaskFromProject(client, taskId, projectId, opts)`.
- `tasks-relations.ts`: `taskRelationsPath(taskId)`, `findTaskRelationsPath()` (constant `/tasks/relations`), `getTaskRelations(client, taskId, opts)`, `findTaskRelations(client, taskIds, opts)`.

### 3.4 New files: command leaves

| Path                                                | Pattern source                      |
| --------------------------------------------------- | ----------------------------------- |
| `src/commands/tasks/project.ts` (parent registrar)  | `src/commands/tasks/estimate.ts`    |
| `src/commands/tasks/project/add.ts`                 | `src/commands/projects/invite.ts` (repeatable flag fan-out + dry-run echo) |
| `src/commands/tasks/project/remove.ts`              | `src/commands/tasks/estimate/clear.ts` (single-id destructive + idempotent 404) |
| `src/commands/tasks/relations.ts`                   | `src/commands/tasks/share.ts` (read-only single-id)                       |
| `src/commands/tasks/find-relations.ts`              | `src/commands/projects/invite.ts` (flag-driven, no positional)            |

### 3.5 New files: `src/ui/human/tasks-project-{add,remove}.ts`, `src/ui/human/tasks-{relations,find-relations}.ts`

One-line / few-line human renderers (TTY mode):

```
Task #4567 added to 2 project(s) via tasklist(s) #100, #200.
[dry-run] Task #4567 would be added to 2 project(s) via tasklist(s) #100, #200.

Task #4567 removed from project #42.
Task #4567 was already removed from project #42.
[dry-run] Task #4567 would be removed from project #42.

Task #4567 — 1 relation(s):
  blocks → #9876 "Ship the thing"

Task #4567 — no relations.

3 task(s) queried, 2 visible:
  #4567 — 1 relation(s):  blocks → #9876
  #4568 — no relations
```

## 4. Edge cases

| edge case                                                              | handling                                                                                       |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `project add` + 200 (1 tasklist)                                       | live envelope; `assignments` length 1                                                          |
| `project add` + 200 (N tasklists)                                      | sequential POSTs; `assignments` length N                                                       |
| `project add` + mid-fan-out 4xx                                        | accumulate completed `assignments`; throw on first failure with `ExitCodeAccumulator` semantics |
| `project add` + 403 (no access to derived target project)              | `FreeloApiError` exit 4                                                                        |
| `project add` + 404 (task or tasklist not found)                       | `FreeloApiError` exit 4                                                                        |
| `project add` + duplicate `--tasklist 100 --tasklist 100`              | dedupe to `[100]`; one POST; `tasklist_ids: [100]` in envelope                                 |
| `project add` + missing `--tasklist`                                   | `ValidationError` exit 2                                                                       |
| `project add` + non-numeric `<id>` / non-numeric `--tasklist`          | `ValidationError` exit 2                                                                       |
| `project add` + `--dry-run`                                            | one envelope, no wire calls; `assignments` omitted; `would.body.tasklist_ids` echo              |
| `project remove` + 200                                                 | live envelope; `already_in_target_state: false`                                                |
| `project remove` + 403 (primary project)                               | `FreeloApiError` exit 4 with `hintNext: 'use freelo tasks delete <id> to remove the task entirely'` |
| `project remove` + 404 (not in project)                                | re-classify as `already_in_target_state: true` (yaml :1985 documents this — first-class)       |
| `project remove` + non-TTY without `--yes`                             | `ConfirmationError` exit 2                                                                     |
| `project remove` + TTY, decline                                        | `ConfirmationError` exit 2                                                                     |
| `project remove` + `--dry-run`                                         | no prompt, no DELETE, envelope `dry_run: true`                                                 |
| `project remove` + missing `--project`                                 | `ValidationError` exit 2                                                                       |
| `relations` + 200 with array                                           | envelope `relations: [...]`                                                                    |
| `relations` + 200 with empty array                                     | envelope `relations: []`                                                                       |
| `relations` + 403                                                      | `FreeloApiError` exit 4                                                                        |
| `relations` + 404                                                      | `FreeloApiError` exit 4                                                                        |
| `relations` + non-numeric `<id>`                                       | `ValidationError` exit 2                                                                       |
| `find-relations` + 200 (all visible)                                   | envelope `tasks` length == `task_ids` length                                                   |
| `find-relations` + 200 (some inaccessible)                             | envelope `tasks` length < `task_ids` length; agents diff to find missing                       |
| `find-relations` + missing `--task`                                    | `ValidationError` exit 2                                                                       |
| `find-relations` + 101 `--task` ids                                    | `ValidationError` exit 2 (max 100)                                                             |
| `find-relations` + duplicate `--task 1 --task 1`                       | dedupe to `[1]`; one POST                                                                      |
| any leaf + 401                                                         | `FreeloApiError` exit 3                                                                        |
| any leaf + 5xx                                                         | `FreeloApiError` exit 4                                                                        |

## 5. Non-goals

- **No `--stdin` / `--ids` batch mode anywhere.** Single-id v1 with repeatable `--tasklist` / `--task` flags. Future R38.5 may add NDJSON for `find-relations` with rich rows.
- **No relation creation / deletion.** The OpenAPI documents no endpoints for it. Agents must use the Freelo web UI to create relations.
- **No relation rendering as a graph.** Plain table in TTY mode; agents consume JSON.
- **No `--tasklist` repeatable on `remove`.** Single-id removal only — see §2.2.
- **No project-id-to-tasklist-id resolver.** `--tasklist` is mandatory on `add` (decision 2). Agents pass tasklist ids directly.
- **No `--all` flag** to remove a task from all secondary projects in one call. Loop over projects in user code if needed.
- **No envelope changes elsewhere.** `freelo.tasks.show/v1` already exposes `multi_project_task` info via `.passthrough()`; we don't extend it.

## 6. Open questions

None. All decisions resolved in §7.

## 7. Decisions made autonomously

### Decision 1 — Layout shape per surface

**Question:** Roadmap suggests four leaves under `tasks`. Which structural layout?

**Decision:**
- `tasks project add` / `tasks project remove` — parent + leaves under a `project` parent.
- `tasks relations <id>` — top-level single leaf.
- `tasks find-relations` — top-level single leaf, no positional, flag-driven.

**Alternatives considered:**
- All four siblings under `tasks` (no parent) → rejected; `add` and `remove` clearly share the `project` noun and an option surface (`--project` vs `--tasklist`); R37 precedent for parent + leaves applies.
- `tasks relations get` / `tasks relations find` parent → rejected; only two leaves and they have entirely different option surfaces (single-id positional vs `--task` flag); the noun is the same but the verbs aren't a pair.
- `tasks find-relations <id>...` (positional) → rejected; mixing positional with `--task` repeatable would be ambiguous; the OpenAPI bulk endpoint takes a body array, so a flag-driven shape is the natural reflection.

**Rationale:** Match each surface to its closest precedent. `project` parent matches R37 (`estimate set/clear`). `relations` matches R36 (`share` — single-id read-only). `find-relations` is novel but follows `projects invite` (flag-driven, no positional).

### Decision 2 — `add` uses `--tasklist <id>...`, NOT `--project <id>...`

**Question:** Roadmap CLI sketch says `--project <id>...` but `POST /task/{id}/projects` body takes `tasklist_id`. Which name?

**Decision:** `--tasklist <id>...`. Roadmap text is wrong; OpenAPI is authoritative.

**Alternatives considered:**
- Match roadmap (`--project <id>`) → rejected; would require either an undocumented project-id-to-tasklist-id resolver (forbidden API guess per CLAUDE.md "Never guess API behavior") or hand the user-supplied project-id straight to a body that expects a tasklist-id (silently broken).
- Accept both `--tasklist <id>` and `--project <id>` as aliases → rejected; the project-id alias would still need the lookup, and a "pick a tasklist for me" is opinionated UX that hides what's actually happening.
- Add a `--project <id> --auto-tasklist` flag → rejected; over-engineered; add later if demand emerges.

**Rationale:** Mirrors R36 share-verb precedent: roadmap is shorthand, OpenAPI is contract. Document the divergence in the spec and the help text. The CLI flag name reflects the wire reality. Agents know the tasklist id (`freelo tasklists list --project <id>`).

### Decision 3 — `--tasklist` fans out to N POSTs (not one bulk POST)

**Question:** With N values, do we issue 1 bulk POST or N POSTs?

**Decision:** N POSTs. The OpenAPI body is `{ tasklist_id: <int> }` (single, yaml :1919-1922) — there is no documented array form.

**Alternatives considered:**
- Single POST with a custom `tasklist_ids` body field → rejected; forbidden API guess.
- Accept only one `--tasklist` per call → rejected; loses agent ergonomics; one-by-one is what the user did anyway.

**Rationale:** The body shape is single. Fan out at the CLI layer; surface the per-call results in `assignments`.

### Decision 4 — `add` does not surface `already_in_target_state`

**Question:** Should `add` distinguish "first add" from "already in this project"?

**Decision:** No.

**Alternatives considered:**
- GET pre-check the task's current projects → rejected; doubles round-trips; the documented detail endpoint (`GET /task/{id}`) returns this info but using it for a defensive precheck on every `add` is wasteful.
- Re-classify a 4xx (e.g. unique-constraint) as idempotent → rejected; OpenAPI does not document this case; speculation.

**Rationale:** Mirrors R37 `set` decision 5 and R23 `labels attach` decision 8 (the "fetch-or-create" pattern is honest about wire ambiguity). `assignments` already echoes per-tasklist child task ids; agents can detect "second-call-returns-same-child-id" externally if they need to.

### Decision 5 — `relations` and `find-relations` do NOT support `--dry-run`

**Question:** Should the read-only commands support `--dry-run` for symmetry?

**Decision:** No.

**Alternatives considered:**
- Add `--dry-run` returning the would-call envelope → rejected; for read-only ops, the dry-run envelope is identical in shape to the live envelope minus the payload, so it conveys nothing; a no-op surprise.
- Add `--dry-run` echoing the request for inspection → rejected; agents who want the would-call shape have `freelo --introspect` and the spec docs.

**Rationale:** `--dry-run` is a write-side concept ("don't perform the side effect"). Read ops have no side effect. R36 `share` (a "GET that creates") supports dry-run because it is stateful on the server. Pure GETs and pure read POSTs do not.

### Decision 6 — `add` dry-run collapses N would-calls into one envelope echo

**Question:** With multiple `--tasklist` ids, do we emit one envelope per tasklist or one collapsed envelope?

**Decision:** One collapsed envelope. `data.would.body.tasklist_ids` is an array.

**Alternatives considered:**
- Per-tasklist NDJSON output on dry-run → rejected; live mode emits one envelope with `assignments[]`, so dry-run should match shape.
- One envelope with `data.would` as an array of single-tasklist would-calls → rejected; redundant — `tasklist_ids` already enumerates the targets, and the path is the same for all.

**Rationale:** Consistency between live and dry-run shapes. Agents that consume `dry_run: true` envelopes do not have to switch parsing modes between shapes.

### Decision 7 — `find-relations` 100-id cap is enforced client-side

**Question:** OpenAPI says `maxItems: 100`. Should the CLI pre-validate or let the server reject?

**Decision:** Pre-validate. >100 → `ValidationError` exit 2.

**Alternatives considered:**
- Server-only validation → rejected; trip is slow; the error is not actionable from a 400 generic body; calibration §1-2 favours fail-fast at parse time.
- Auto-chunk into multiple requests of ≤100 each → rejected; doubles complexity, hides round-trip count, ambiguous for partial-failure semantics. Future R38.5 could add `--chunk-size`.

**Rationale:** OpenAPI documents the cap; we surface the cap as a user-friendly validation error rather than a generic 400.

### Decision 8 — `project remove` 404 maps to `already_in_target_state: true`; 403 stays an error

**Question:** Both 403 and 404 are documented for `DELETE /task/{id}/projects/{project_id}`. Same handling?

**Decision:** No — 404 → idempotent success; 403 → `FreeloApiError` with a hint.

**Alternatives considered:**
- Both → idempotent → rejected; 403 is informative (caller tried to remove the *primary* project, which requires a different verb); silently swallowing it would mask a real user error.
- Both → error → rejected; for 404 specifically, yaml :1985 documents that "Returns 404 if the task is not present in the given project at all" — this **is** the documented "already removed" signal.

**Rationale:** Match the OpenAPI's documented semantics. 404 is specifically the "not in this project" signal — perfect for idempotency. 403 is the "wrong verb for this case" signal — surface with hint.

### Decision 9 — relations envelope `relations` field is ALWAYS present (even when empty)

**Question:** Should empty relations omit the field or emit `[]`?

**Decision:** Always emit `[]`. Same on `find-relations` — `tasks[*].relations` is always present.

**Alternatives considered:**
- Omit when empty → rejected; agents would need a key-presence check; defensive code in every consumer.
- Set to `null` → rejected; `[]` is the obvious idiomatic empty-list signal.

**Rationale:** Schema stability — always-present arrays are easier to consume. Mirrors `tasks list/v1` and `comments list/v1` precedent.

## Plan

### Branch

`feat/tasks-multiproject-relations` (from `main`).

### Files to create (12 new src/, 4 new test, 2 new docs/, 1 spec, 1 changeset = 20 new)

| Path                                                  | Intent                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `docs/specs/0052-r38-tasks-multiproject-relations.md` | This spec.                                                              |
| `src/api/schemas/task-projects.ts`                    | Zod schemas + envelope `data` types for `add` / `remove`.               |
| `src/api/schemas/task-relations.ts`                   | Zod schemas + envelope `data` types for `relations` / `find-relations`. |
| `src/api/tasks-projects.ts`                           | `assignTaskToProject()` / `removeTaskFromProject()` wire wrappers.      |
| `src/api/tasks-relations.ts`                          | `getTaskRelations()` / `findTaskRelations()` wire wrappers.             |
| `src/commands/tasks/project.ts`                       | Parent `tasks project` registrar (no `meta`, only children).            |
| `src/commands/tasks/project/add.ts`                   | `tasks project add <id> --tasklist <id>... [--dry-run]` leaf.           |
| `src/commands/tasks/project/remove.ts`                | `tasks project remove <id> --project <id> [--yes] [--dry-run]` leaf.    |
| `src/commands/tasks/relations.ts`                     | `tasks relations <id>` top-level read-only leaf.                        |
| `src/commands/tasks/find-relations.ts`                | `tasks find-relations --task <id>...` top-level read-only leaf.         |
| `src/ui/human/tasks-project-add.ts`                   | Human renderer for `add`.                                               |
| `src/ui/human/tasks-project-remove.ts`                | Human renderer for `remove`.                                            |
| `src/ui/human/tasks-relations.ts`                     | Human renderer for `relations`.                                         |
| `src/ui/human/tasks-find-relations.ts`                | Human renderer for `find-relations`.                                    |
| `test/commands/tasks/project-add.test.ts`             | Integration tests (MSW).                                                |
| `test/commands/tasks/project-remove.test.ts`          | Integration tests (MSW + confirm helper).                               |
| `test/commands/tasks/relations.test.ts`               | Integration tests (MSW).                                                |
| `test/commands/tasks/find-relations.test.ts`          | Integration tests (MSW).                                                |
| `docs/commands/tasks-project.md`                      | User docs covering both `add` and `remove`.                             |
| `docs/commands/tasks-relations.md`                    | User docs covering `relations` and `find-relations`.                    |
| `.changeset/r38-tasks-multiproject-relations.md`      | `freelo-cli: minor` — four new subcommands.                             |

### Files to modify (3)

| Path                       | Change                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `src/commands/tasks.ts`    | Import + call `registerProject`, `registerRelations`, `registerFindRelations`.       |
| `test/msw/handlers.ts`     | Append `tasksProjectAddHandlers`, `tasksProjectRemoveHandlers`, `tasksRelationsHandlers`, `tasksFindRelationsHandlers` blocks. |
| `README.md`                | Autogen Commands block — regenerate via `pnpm fix:readme`.                            |

### Files NOT modified

- `src/api/client.ts` — no client changes; reuses GET / POST / DELETE.
- `src/api/schemas/task.ts` — no envelope shape change; `multi_project_task` already passes through.
- `src/lib/confirm.ts` — reused as-is.
- `src/lib/dry-run.ts` — reused as-is.
- `src/ui/envelope.ts` — reused as-is.
- `test/fixtures/introspect-golden.json` — only specific subtrees are locked; verify by grep.

### New runtime dependencies

**None.** All needed primitives present.

### Test strategy

#### `test/commands/tasks/project-add.test.ts`

- Happy path live (1 tasklist): exit 0, `assignments` length 1, body shape `{ tasklist_id: 100 }`.
- Happy path live (N tasklists): exit 0, `assignments` length N, N requests captured.
- Dedup `--tasklist 100 --tasklist 100`: exit 0, `tasklist_ids: [100]`, 1 request.
- Dry-run (1 tasklist): no wire call, envelope `dry_run: true`, `would.body.tasklist_ids: [100]`.
- Dry-run (N tasklists): no wire call, `would.body.tasklist_ids: [100, 200]`.
- Mid-fan-out 4xx: first POST 200, second 403 → exit 4 (FreeloApiError); `assignments` echoes the first.
- Validation: missing `--tasklist` → exit 2.
- Validation: non-numeric `<id>` → exit 2.
- Validation: non-numeric `--tasklist` → exit 2.
- HTTP 401 → exit 3.
- HTTP 404 → exit 4.
- HTTP 5xx → exit 4.
- Human mode: line contains `Task #4567 added to 2 project(s)`.

#### `test/commands/tasks/project-remove.test.ts`

- Happy path live + `--yes`: exit 0, `already_in_target_state: false`.
- Defensive 404 → idempotent: exit 0, `already_in_target_state: true`.
- 403 (primary project): exit 4, `code: 'FORBIDDEN'`, hint contains `tasks delete`.
- Dry-run: no wire call, `would.path` echoes `/task/4567/projects/42`.
- Non-TTY without `--yes`: exit 2 `CONFIRMATION_REQUIRED`, no wire call (calibration §7).
- TTY accepts: exit 0; calibration §7. Prompt copy contains `task #4567` and `project #42`.
- TTY declines: exit 2 (calibration §7).
- Validation: missing `--project` → exit 2.
- Validation: non-numeric `<id>` / `--project` → exit 2.
- HTTP 401 → exit 3, HTTP 5xx → exit 4.
- Human mode lines.

#### `test/commands/tasks/relations.test.ts`

- Happy path 200 with relations: envelope `relations: [...]`.
- Happy path 200 empty: envelope `relations: []`.
- Validation: non-numeric `<id>` → exit 2.
- HTTP 401 → exit 3, 403/404/5xx → exit 4.
- Human mode lines.

#### `test/commands/tasks/find-relations.test.ts`

- Happy path with all visible: envelope `tasks` length == `task_ids` length.
- Happy path with some inaccessible: `tasks` length < `task_ids` length.
- Dedup `--task 1 --task 1`: 1 POST, `task_ids: [1]`.
- Validation: missing `--task` → exit 2.
- Validation: 101 `--task` ids → exit 2.
- Validation: non-numeric `--task` → exit 2.
- HTTP 401 → exit 3, 5xx → exit 4.
- Human mode lines.

#### Coverage callouts

- Calibration §1 — full test phase before commit.
- Calibration §2 — every error-class path has an explicit `exitCode` assertion: `ValidationError` (2), `ConfirmationError` (2), `FreeloApiError` (3 / 4).
- Calibration §3 — five-gate before push (`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`).
- Calibration §4 — new `try/catch` arms in `project-add.ts` (mid-fan-out) and `project-remove.ts` (defensive 404). Both covered by mandatory tests.
- Calibration §7 — TTY-prompt tests in `project-remove.test.ts` clear `process.env.CI` around the test body.

### Rollout

Single landable slice. PR squash:

`feat(commands): tasks project add / remove + tasks relations / find-relations (R38)`
