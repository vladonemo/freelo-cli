# freelo tasks finish

Mark one or more tasks as finished. Idempotent: tasks that are already
finished are skipped (no redundant POST). Emits a stable
`freelo.tasks.finish/v1` envelope.

## Synopsis

```bash
freelo tasks finish <id>...
                    [--ids <a,b,c>]
                    [--stdin]
                    [--dry-run]
```

Exactly one source of ids is allowed: positional `<id>...`, `--ids`, or
`--stdin`. Combining sources is rejected with `VALIDATION_ERROR` (exit 2).
Calling the command with no ids resolved (no positional, no `--ids`, empty
`--stdin`) is silent success (exit 0).

## Options

| Flag        | Type / values                  | Default | Purpose                                                                                                                                                       |
| ----------- | ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<id>...`   | positive integers (variadic)   | —       | One or more numeric task ids on the command line. Mutex with `--ids` and `--stdin`.                                                                           |
| `--ids <l>` | comma- or space-separated list | unset   | Same as positional but useful when callers already have a comma-list. Mutex with `<id>...` and `--stdin`.                                                     |
| `--stdin`   | boolean                        | false   | Read NDJSON from stdin (one `{"id": <int>}` per line). Mutex with `<id>...` and `--ids`.                                                                      |
| `--dry-run` | boolean                        | false   | Skip the `POST /task/{id}/finish` call. **The pre-check `GET /task/{id}` still runs** so the envelope reflects observed state and the `would` block is exact. |

`--output`, `--color`, `--profile`, `-v/-vv`, `--request-id` are inherited
global flags.

## Behavior

For each id (in input order):

1. `GET /task/{id}` — pre-check the current state.
2. If `state.state === 'finished'` already → emit a success envelope with
   `already_in_target_state: true`. **No POST is sent.** Exit 0 for the id.
3. If `state.state === 'deleted'` → reject with `VALIDATION_ERROR`
   (exit 2). Deleted tasks are not addressable via the finish endpoint.
4. Otherwise → `POST /task/{id}/finish`. On success, emit a success
   envelope with `current_state: 'finished'`.

In **single-id mode** (one positional id, no `--ids`, no `--stdin`), errors
bubble up to the top-level handler: a `freelo.error/v1` envelope on stderr,
the typed exit code on the process. In **multi-id mode** (more than one id
from any source), per-id error envelopes go to stdout interleaved with the
success stream, and the **highest-numerically exit code observed** wins at
end-of-stream (R09 batch semantics — `2` for validation, `3` auth-expired,
`4` HTTP 4xx/5xx, `5` network, `6` rate-limit).

## Permissions

- API key with write permission on the task.
- Caller must be the assignee, author, or a project manager — otherwise the
  POST returns 403 (Freelo's `RoleActionForbiddenException`).

## Envelope

`schema: "freelo.tasks.finish/v1"`

Live success (POST happened):

```json
{
  "schema": "freelo.tasks.finish/v1",
  "data": {
    "task_id": 9012,
    "previous_state": "active",
    "current_state": "finished",
    "already_in_target_state": false,
    "verb": "finish"
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-04-27T20:30:00Z" },
  "request_id": "..."
}
```

Idempotent skip (no POST happened — task was already finished):

```json
{
  "schema": "freelo.tasks.finish/v1",
  "data": {
    "task_id": 9012,
    "previous_state": "finished",
    "current_state": "finished",
    "already_in_target_state": true,
    "verb": "finish"
  },
  "rate_limit": { "remaining": 39, "reset_at": "2026-04-27T20:30:00Z" }
}
```

Dry-run (POST always skipped; pre-check GET still runs):

```json
{
  "schema": "freelo.tasks.finish/v1",
  "dry_run": true,
  "data": {
    "task_id": 9012,
    "previous_state": "active",
    "current_state": "active",
    "already_in_target_state": false,
    "verb": "finish",
    "would": { "method": "POST", "path": "/task/9012/finish", "body": {} }
  }
}
```

In **batch from `--stdin`**, `data.line_index` (0-indexed) is included on
every envelope — both successes and per-line errors (the latter via
`error.context.line_index`).

## Examples

### Single id

```bash
$ freelo tasks finish 9012
Finished task #9012 (was active).

$ freelo tasks finish 9012 --output json
{"schema":"freelo.tasks.finish/v1","data":{"task_id":9012,"previous_state":"active","current_state":"finished","already_in_target_state":false,"verb":"finish"},"rate_limit":{...}}
```

### Already finished — idempotent skip

```bash
$ freelo tasks finish 9012 --output json
{"schema":"freelo.tasks.finish/v1","data":{"task_id":9012,"previous_state":"finished","current_state":"finished","already_in_target_state":true,"verb":"finish"},"rate_limit":{...}}
$ echo $?
0
```

### Multiple ids (positional)

```bash
$ freelo tasks finish 9012 9013 9014 --output ndjson
{"schema":"freelo.tasks.finish/v1","data":{"task_id":9012,...}}
{"schema":"freelo.tasks.finish/v1","data":{"task_id":9013,...}}
{"schema":"freelo.tasks.finish/v1","data":{"task_id":9014,...}}
```

### `--ids` flag

```bash
$ freelo tasks finish --ids 9012,9013,9014 --output ndjson
... (same shape)
```

### NDJSON via stdin (pipe-friendly)

```bash
$ printf '{"id":9012}\n{"id":9013}\n' | freelo tasks finish --stdin --output ndjson
{"schema":"freelo.tasks.finish/v1","data":{"task_id":9012,"line_index":0,...}}
{"schema":"freelo.tasks.finish/v1","data":{"task_id":9013,"line_index":1,...}}
```

### Combining with `tasks list` (close every task with a label)

```bash
$ freelo tasks list --scope all-tasks --label "ready-to-close" --output json \
  | jq -c '.data.tasks[] | { id }' \
  | freelo tasks finish --stdin --output ndjson
```

### Dry-run

```bash
$ freelo tasks finish 9012 --dry-run --output json
{"schema":"freelo.tasks.finish/v1","dry_run":true,"data":{"task_id":9012,"previous_state":"active","current_state":"active","already_in_target_state":false,"verb":"finish","would":{"method":"POST","path":"/task/9012/finish","body":{}}}}
```

## Errors

| Trigger                                      | code               | exit |
| -------------------------------------------- | ------------------ | ---- |
| `<id>` not a positive integer (any source)   | `VALIDATION_ERROR` | 2    |
| `--ids 0` / `--ids ""` / non-int NDJSON `id` | `VALIDATION_ERROR` | 2    |
| Combining positional, `--ids`, `--stdin`     | `VALIDATION_ERROR` | 2    |
| Pre-check observes `state: 'deleted'`        | `VALIDATION_ERROR` | 2    |
| Pre-check 401                                | `AUTH_EXPIRED`     | 3    |
| Pre-check / POST 403                         | `FORBIDDEN`        | 4    |
| Pre-check / POST 404                         | `NOT_FOUND`        | 4    |
| Pre-check / POST 5xx                         | `SERVER_ERROR`     | 4    |
| Pre-check / POST 422 / other 4xx             | `FREELO_API_ERROR` | 4    |
| HTTP 429                                     | `RATE_LIMITED`     | 6    |
| Network failure                              | `NETWORK_ERROR`    | 5    |

## Non-goals (R11 v1)

- `--yes` / TTY confirmation prompts. Finish is reversible (the inverse,
  `tasks reopen`, is in this same slice). Destructive verbs in R12+ get
  confirmation surfaces.
- `--all-finished-in-tasklist` / sweeping shortcuts. Compose via `tasks list`.
- Per-id rate-limit budgeting / parallelism. Sequential by design.

See [spec 0021](../specs/0021-tasks-finish-reopen.md) for the full design.
