# freelo tasks relations / find-relations

Read **typed cross-references** between tasks — `blocked_by`, `blocks`,
`related_to`, `duplicate_of`. Both commands are **read-only**.

> Freelo's API does not document any endpoint to create or delete relations.
> Use the Freelo web UI to manage relations; use the CLI to query them.

Two top-level commands under `tasks` (no parent):

- `freelo tasks relations <id>` — relations on a single task.
- `freelo tasks find-relations --task <id>...` — bulk relations across many tasks
  (1–100 per call).

## Synopsis

```bash
freelo tasks relations      <id>
freelo tasks find-relations --task <id>...
```

Neither command supports `--dry-run` (read-only — dry-run on a pure GET is a
no-op surprise; see spec 0052 decision 5).

## `tasks relations`

Returns all typed relations on a single task. Empty array on no relations is
a valid response. Relations to tasks the caller cannot access are silently
filtered out by Freelo (yaml :1950).

### Options

| Flag   | Type / values | Default | Purpose                      |
| ------ | ------------- | ------- | ---------------------------- |
| `<id>` | positive int  | —       | Task id (numeric). Required. |

### Wire mapping

`GET /task/{task_id}/relations`. No body. Response:

```jsonc
{
  "relations": [
    { "type": "blocks", "related_task_id": 9876, "related_task_name": "Ship the thing" },
  ],
}
```

### Envelope

`schema: freelo.tasks.relations/v1`

| Field       | Type                                                                                                                               | Always present | Notes                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| `task_id`   | int                                                                                                                                | yes            | Echo of `<id>` positional.                                                                 |
| `relations` | `{ type: 'blocked_by' \| 'blocks' \| 'related_to' \| 'duplicate_of'; related_task_id: int; related_task_name?: string \| null }[]` | yes            | Empty `[]` is a valid response. `related_task_name` may be `null` for orphaned references. |

### Examples

```bash
# Show relations:
$ freelo tasks relations 4567 --output json
{"schema":"freelo.tasks.relations/v1","data":{"task_id":4567,"relations":[{"type":"blocks","related_task_id":9876,"related_task_name":"Ship the thing"}]}}

# No relations — empty array:
$ freelo tasks relations 4567 --output json
{"schema":"freelo.tasks.relations/v1","data":{"task_id":4567,"relations":[]}}

# Human mode:
$ freelo tasks relations 4567
Task #4567 — 1 relation(s):
  blocks → #9876 "Ship the thing"
```

## `tasks find-relations`

Bulk-fetch relations for 1–100 task ids in a single POST. Use this when you need
the dependency graph across many tasks (e.g. dashboards, status reports).

> **Despite the verb being `POST`, this endpoint is read-only.** It does not
> create relations. The endpoint name (`/tasks/relations`) and request body
> shape (`{ task_ids: [...] }`) reflect a query batch, not a mutation. The CLI
> command name `find-relations` makes this explicit.

### Options

| Flag          | Type / values | Default | Purpose                                                                          |
| ------------- | ------------- | ------- | -------------------------------------------------------------------------------- |
| `--task <id>` | positive int  | —       | Numeric task id (repeatable). At least one, at most 100. Required. Deduplicated. |

`tasks find-relations` does **not** accept a positional `<id>`. All ids go through `--task`.

### Wire mapping

`POST /tasks/relations` with body `{ "task_ids": [<int>, ...] }` (1–100 ids).
Response:

```jsonc
{
  "tasks": [
    {
      "task_id": 4567,
      "relations": [{ "type": "blocks", "related_task_id": 9876, "related_task_name": "X" }],
    },
    { "task_id": 4568, "relations": [] },
  ],
}
```

### Envelope

`schema: freelo.tasks.find-relations/v1`

| Field      | Type                                            | Always present | Notes                                                                                                                                          |
| ---------- | ----------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `task_ids` | int[]                                           | yes            | Echo of `--task`, deduplicated. Length is in `[1, 100]`.                                                                                       |
| `tasks`    | `{ task_id: int; relations: TaskRelation[] }[]` | yes            | Server response. **`tasks[*].task_id` is a subset of `task_ids`** — Freelo silently omits inaccessible tasks. Diff to detect inaccessible ids. |

> **Inaccessible tasks are silently omitted.** If `task_ids = [1, 2, 3]` but the
> caller cannot see task 3, the response is `tasks: [{ id: 1 }, { id: 2 }]` —
> task 3 is gone, no error, no flag. Agents diff `task_ids \ tasks[*].task_id`
> to detect this.

### Examples

```bash
# Bulk relations (one POST):
$ freelo tasks find-relations --task 4567 --task 4568 --task 4569 --output json
{"schema":"freelo.tasks.find-relations/v1","data":{"task_ids":[4567,4568,4569],"tasks":[{"task_id":4567,"relations":[{"type":"blocks","related_task_id":9876,"related_task_name":"X"}]},{"task_id":4568,"relations":[]}]}}
# Note: 4569 omitted — caller cannot access it.

# Validation: too many --task ids:
$ freelo tasks find-relations --task 1 --task 2 ... (101 of them)
freelo: --task accepts at most 100 ids per call (got 101).
  hint: Split your query across multiple invocations.
# exit 2

# Human mode:
$ freelo tasks find-relations --task 4567 --task 4568 --task 4569
3 task(s) queried, 2 visible:
  #4567 — 1 relation(s): blocks → #9876
  #4568 — no relations
```

## Required Freelo permissions

- Read access to each queried task. Inaccessible tasks return `403`/`404` for
  the single-task verb and are silently omitted from the bulk response.
- Read access to related tasks for them to appear in the response — relations
  pointing to invisible tasks are filtered server-side.

## Related commands

- `freelo tasks show <id>` — full task detail (including labels, workers, etc.).
- `freelo tasks list` — find the task ids you want to query.
