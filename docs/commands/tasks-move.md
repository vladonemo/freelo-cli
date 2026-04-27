# freelo tasks move

Move a task between tasklists, optionally crossing project boundaries.
Idempotent: a task that is already in the target tasklist is skipped (no
redundant POST). Emits a stable `freelo.tasks.move/v1` envelope.

## Synopsis

```bash
freelo tasks move <id> --to-tasklist <id>
                       [--to-project <id>]
                       [--dry-run]
```

Single-id only in v1 — no `--ids` / `--stdin` batch input. Compose with
`xargs` if you need to relocate many tasks (see Examples below).

## Options

| Flag                 | Type / values    | Default | Purpose                                                                                                                                                                                                                               |
| -------------------- | ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<id>`               | positive integer | —       | The task to move. Required.                                                                                                                                                                                                           |
| `--to-tasklist <id>` | positive integer | —       | Destination tasklist id. **Required.** The destination project is **derived from this id** by Freelo (cross-project moves work transparently).                                                                                        |
| `--to-project <id>`  | positive integer | unset   | Optional post-move assertion. The destination project is server-derived from `--to-tasklist`; this flag adds a sanity check — on mismatch, the envelope carries a `notice` (exit stays 0).                                            |
| `--dry-run`          | boolean          | false   | Skip the `POST /task/{id}/move/{tasklist_id}` call. **The pre-check `GET /task/{id}` still runs** so the envelope reflects observed state; `would` echoes the path that would have been called. `to_project_id` is `null` in dry-run. |

`--output`, `--color`, `--profile`, `-v/-vv`, `--request-id` are inherited
global flags.

## Behavior

```
1. GET /task/{id}                    — observe current tasklist/project
2. If task.tasklist.id == --to-tasklist
       → emit envelope (already_in_target_tasklist: true), no POST, no refresh GET.
   If task.state.state == 'deleted'
       → reject with VALIDATION_ERROR (exit 2).
3. If --dry-run
       → emit envelope with `would`, no POST, no refresh GET.
4. POST /task/{id}/move/{tasklist_id}
5. GET /task/{id}                    — refresh to surface the post-move shape
6. If --to-project supplied AND post-move project.id != --to-project
       → emit `notice` on the envelope (exit stays 0).
```

## Permissions

- API key with write permission on the source task and ACL on the destination
  tasklist's project. Without ACL, the POST returns 403 (Freelo's
  `RoleActionForbiddenException`).
- Caller must be the assignee, author, or a project manager.

## Envelope

`schema: "freelo.tasks.move/v1"`

Live success (move happened):

```json
{
  "schema": "freelo.tasks.move/v1",
  "data": {
    "task_id": 9012,
    "from_tasklist_id": 1100,
    "to_tasklist_id": 1200,
    "from_project_id": 42,
    "to_project_id": 42,
    "already_in_target_tasklist": false,
    "task": { "id": 9012, "tasklist": { "id": 1200, "name": "In progress" }, "...": "..." }
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-04-27T20:30:00Z" },
  "request_id": "..."
}
```

Idempotent skip (no POST happened — task was already in target tasklist):

```json
{
  "schema": "freelo.tasks.move/v1",
  "data": {
    "task_id": 9012,
    "from_tasklist_id": 1200,
    "to_tasklist_id": 1200,
    "from_project_id": 42,
    "to_project_id": 42,
    "already_in_target_tasklist": true,
    "task": { "...": "pre-check TaskDetail" }
  },
  "rate_limit": { "remaining": 39, "reset_at": "2026-04-27T20:30:00Z" }
}
```

Dry-run (POST always skipped; pre-check GET still runs):

```json
{
  "schema": "freelo.tasks.move/v1",
  "dry_run": true,
  "data": {
    "task_id": 9012,
    "from_tasklist_id": 1100,
    "to_tasklist_id": 1200,
    "from_project_id": 42,
    "to_project_id": null,
    "already_in_target_tasklist": false,
    "task": { "...": "pre-check TaskDetail" },
    "would": { "method": "POST", "path": "/task/9012/move/1200", "body": {} }
  }
}
```

Note: `to_project_id` is `null` in dry-run — the destination tasklist's
project is **not** fetched as part of the dry-run preview.

## Examples

### Cross-tasklist within the same project

```bash
$ freelo tasks move 9012 --to-tasklist 1200
Moved task #9012 from tasklist #1100 to tasklist #1200.

$ freelo tasks move 9012 --to-tasklist 1200 --output json
{"schema":"freelo.tasks.move/v1","data":{"task_id":9012,"from_tasklist_id":1100,"to_tasklist_id":1200,"from_project_id":42,"to_project_id":42,"already_in_target_tasklist":false,"task":{...}},"rate_limit":{...}}
```

### Cross-project move

The destination project is server-derived from the destination tasklist:

```bash
$ freelo tasks move 9012 --to-tasklist 5500 --output json
{"schema":"freelo.tasks.move/v1","data":{"task_id":9012,"from_tasklist_id":1100,"to_tasklist_id":5500,"from_project_id":42,"to_project_id":99,"already_in_target_tasklist":false,"task":{...}}}
```

In human mode the project change is surfaced explicitly:

```bash
$ freelo tasks move 9012 --to-tasklist 5500
Moved task #9012 from tasklist #1100 to tasklist #5500 (project #42 → #99).
```

### Cross-project assertion (post-hoc sanity check)

`--to-project` does NOT influence the move (the API derives the project
from the destination tasklist). It IS a sanity check — the CLI verifies
post-move and emits a `notice` on mismatch:

```bash
# Match — no notice.
$ freelo tasks move 9012 --to-tasklist 5500 --to-project 99 --output json
{"schema":"freelo.tasks.move/v1","data":{...,"to_project_id":99}}

# Mismatch — notice present, exit 0 (the move succeeded).
$ freelo tasks move 9012 --to-tasklist 5500 --to-project 42 --output json
{"schema":"freelo.tasks.move/v1","data":{...,"to_project_id":99},"notice":"--to-project asserted 42 but post-move task is in project 99. Verify destination tasklist id and the project graph."}
```

### Already in target tasklist (idempotent skip)

```bash
$ freelo tasks move 9012 --to-tasklist 1200 --output json
{"schema":"freelo.tasks.move/v1","data":{"task_id":9012,"from_tasklist_id":1200,"to_tasklist_id":1200,"from_project_id":42,"to_project_id":42,"already_in_target_tasklist":true,"task":{...}}}
$ echo $?
0
```

### Dry-run

```bash
$ freelo tasks move 9012 --to-tasklist 1200 --dry-run --output json
{"schema":"freelo.tasks.move/v1","dry_run":true,"data":{"task_id":9012,"from_tasklist_id":1100,"to_tasklist_id":1200,"from_project_id":42,"to_project_id":null,"already_in_target_tasklist":false,"task":{...},"would":{"method":"POST","path":"/task/9012/move/1200","body":{}}}}
```

### Compose with `tasks list` (move every task with a label)

`tasks move` is single-id — agents compose for batch:

```bash
$ freelo tasks list --label "ready-for-qa" --output json \
  | jq -r '.data.tasks[].id' \
  | xargs -I{} freelo tasks move {} --to-tasklist 1200 --output json
```

### Move on a deleted task (refused)

```bash
$ freelo tasks move 9012 --to-tasklist 1200
freelo: Task 9012 is deleted; cannot move a deleted task.
$ echo $?
2
```

## Errors

| Trigger                                | code               | exit |
| -------------------------------------- | ------------------ | ---- |
| `<id>` not a positive integer          | `VALIDATION_ERROR` | 2    |
| `--to-tasklist` missing                | `VALIDATION_ERROR` | 2    |
| `--to-tasklist` not a positive integer | `VALIDATION_ERROR` | 2    |
| `--to-project` not a positive integer  | `VALIDATION_ERROR` | 2    |
| Pre-check observes `state: 'deleted'`  | `VALIDATION_ERROR` | 2    |
| Pre-check 401                          | `AUTH_EXPIRED`     | 3    |
| Pre-check / POST 403                   | `FORBIDDEN`        | 4    |
| Pre-check / POST 404                   | `NOT_FOUND`        | 4    |
| Pre-check / POST 5xx                   | `SERVER_ERROR`     | 4    |
| Pre-check / POST 422 / other 4xx       | `FREELO_API_ERROR` | 4    |
| HTTP 429                               | `RATE_LIMITED`     | 6    |
| Network failure                        | `NETWORK_ERROR`    | 5    |

## Non-goals (R12 v1)

- **Batch input** (`--ids`, `--stdin`). Move takes two ids — source AND
  destination tasklist — which doesn't fit R09/R11's "one verb, list of
  ids" mold cleanly. Compose via `xargs` for now; revisit if real demand
  shows up.
- **`--work-reports-action` and `--custom-fields-action` flags.** Both
  default to sensible server-side values (`move_to_target_project`,
  `nothing`) and most callers don't need to override them. Out for v1.
- **Multi-project task body field** (`multi_project_task.source_tasklist_id`).
  Multi-project task work lives in R38 (`tasks project add` / `relations`).
- **Pre-move `--to-project` verification.** Would require an extra
  destination-tasklist GET; the post-move check is sufficient and avoids
  doubling the read load.
- **Confirmation prompt / `--yes` flag.** Move is reversible (run the
  command again with the original tasklist id).

See [spec 0022](../specs/0022-tasks-move.md) for the full design.
