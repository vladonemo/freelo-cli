# freelo tasks move

Move a task between tasklists, optionally crossing project boundaries.
Idempotent: a task that is already in the target tasklist is skipped (no
redundant POST). Emits a stable `freelo.tasks.move/v1` envelope.

Two modes:

- **Single mode** — one task, one destination, on the command line.
- **Batch mode** (`--stdin`, **R12.5**) — many tasks, one row per move,
  NDJSON in / NDJSON out, continue-on-error.

## Synopsis

```bash
# Single mode
freelo tasks move <id> --to-tasklist <id>
                       [--to-project <id>]
                       [--dry-run]

# Batch mode (R12.5) — one envelope per row
freelo tasks move --stdin [--dry-run]
# Per-line NDJSON: {"id": <task_id>, "to_tasklist": <tasklist_id>, "to_project"?: <project_id>}
```

## Options

| Flag                 | Type / values    | Default | Purpose                                                                                                                                                                                                                                                    |
| -------------------- | ---------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<id>`               | positive integer | —       | The task to move. Required in single mode; rejected with `--stdin`.                                                                                                                                                                                        |
| `--to-tasklist <id>` | positive integer | —       | Destination tasklist id. **Required in single mode.** Rejected with `--stdin` (use per-row `to_tasklist` instead). The destination project is **derived from this id** by Freelo (cross-project moves work transparently).                                 |
| `--to-project <id>`  | positive integer | unset   | Optional post-move assertion (single mode only). On mismatch, the envelope carries a `notice` (exit stays 0). Rejected with `--stdin` (use per-row `to_project` instead).                                                                                  |
| `--dry-run`          | boolean          | false   | Skip the `POST /task/{id}/move/{tasklist_id}` call. **The pre-check `GET /task/{id}` still runs** so the envelope reflects observed state; `would` echoes the path that would have been called. `to_project_id` is `null` in dry-run. Works in both modes. |
| `--stdin`            | boolean          | false   | Batch mode. Read NDJSON from stdin, one move per line. Mutex with `<id>`, `--to-tasklist`, `--to-project`.                                                                                                                                                 |

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

```bash
$ freelo tasks list --label "ready-for-qa" --output json \
  | jq -r '.data.tasks[].id' \
  | xargs -I{} freelo tasks move {} --to-tasklist 1200 --output json
```

For relocations to **different** destinations per row, see batch mode below.

## Batch input via `--stdin` (R12.5)

`--stdin` reads NDJSON from stdin and emits one envelope per row, in input
order. Per-row idempotency is preserved (a row whose `to_tasklist` matches
the task's current tasklist returns `already_in_target_tasklist: true`).

### Per-line shape

```jsonc
{
  "id": <task_id, positive integer>,
  "to_tasklist": <tasklist_id, positive integer>,
  "to_project": <project_id, positive integer>   // optional, per-row assertion
}
```

Unknown keys reject the line with a `VALIDATION_ERROR` (zod `.strict()`).
Per-row `to_project` is a post-move assertion — same semantics as single
mode's `--to-project`.

### Output

One envelope per row on stdout, in input order:

- Successful row → `freelo.tasks.move/v1` with an additional `data.line_index` field
  (0-indexed across non-empty input lines).
- Failed row → `freelo.error/v1` with `error.context.line_index` and (when known)
  `error.context.task_id`.

### Failure semantics

**Continue-on-error.** A bad line does not abort the run; subsequent lines still
process. The exit code at end-of-run is the **max** of per-line exit codes:

| Per-line failure                      | Exit |
| ------------------------------------- | ---- |
| Line is not valid JSON                | 2    |
| Line schema fails (missing/typed)     | 2    |
| Pre-check observes `state: 'deleted'` | 2    |
| Pre-check 401                         | 3    |
| Pre-check / POST 403, 404, 5xx, 4xx   | 4    |
| Network failure                       | 5    |
| HTTP 429                              | 6    |

Run-level exit = `max(per-line exit codes)`. Empty stdin → silent exit 0.

### Examples

**Multiple tasks to multiple destinations:**

```bash
$ cat <<EOF | freelo tasks move --stdin --output json
{"id": 9012, "to_tasklist": 1200}
{"id": 9013, "to_tasklist": 1200}
{"id": 9014, "to_tasklist": 5500, "to_project": 99}
EOF
{"schema":"freelo.tasks.move/v1","data":{"task_id":9012,...,"line_index":0},...}
{"schema":"freelo.tasks.move/v1","data":{"task_id":9013,...,"line_index":1},...}
{"schema":"freelo.tasks.move/v1","data":{"task_id":9014,...,"to_project_id":99,"line_index":2},...}
$ echo $?
0
```

**Mixed success and failure (continue-on-error):**

```bash
$ cat <<EOF | freelo tasks move --stdin --output json
{"id": 9012, "to_tasklist": 1200}
{"id": 99999, "to_tasklist": 1200}
EOF
{"schema":"freelo.tasks.move/v1","data":{"task_id":9012,...,"line_index":0},...}
{"schema":"freelo.error/v1","error":{"code":"NOT_FOUND","http_status":404,"context":{"line_index":1,"task_id":99999},...}}
$ echo $?
4
```

**Batch dry-run (no POST, no refresh GET; pre-check still runs):**

```bash
$ echo '{"id": 9012, "to_tasklist": 1200}' | freelo tasks move --stdin --dry-run --output json
{"schema":"freelo.tasks.move/v1","dry_run":true,"data":{"task_id":9012,...,"would":{"method":"POST","path":"/task/9012/move/1200","body":{}},"line_index":0}}
```

**Composed pipeline (move all unfinished tasks from one tasklist to another):**

```bash
$ freelo tasks list --tasklist 1100 --state active --output ndjson \
  | jq -c '{id: .id, to_tasklist: 1200}' \
  | freelo tasks move --stdin --output ndjson
```

### Mutex rules

`--stdin` is mutually exclusive with `<id>`, `--to-tasklist`, and `--to-project`.
Combining them fails fast with `VALIDATION_ERROR` (exit 2) before any HTTP runs.

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

## Non-goals

- **`--pairs <id>:<list>,<id>:<list>` shell sugar.** `--stdin` NDJSON is the
  documented batch contract. Defer until real users ask.
- **Global `--to-project` in `--stdin` mode.** Per-row only — different rows
  can target different projects.
- **Fail-fast / `--abort-on-error` flag in batch.** Continue-on-error is the
  only semantic; matches R09 (`tasks create --stdin`) and R11
  (`tasks finish --stdin`).
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

See [spec 0022](../specs/0022-tasks-move.md) for the single-mode design and
[spec 0023](../specs/0023-tasks-move-batch.md) for batch mode (R12.5).
