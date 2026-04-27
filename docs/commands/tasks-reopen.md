# freelo tasks reopen

Reopen one or more finished tasks (move them back to active state).
Idempotent: tasks already active are skipped (no redundant POST). Emits a
stable `freelo.tasks.reopen/v1` envelope.

The wire endpoint is `POST /task/{id}/activate`; the CLI uses the verb
`reopen` instead of `activate` to avoid ambiguity with the project-activate
endpoint (which also undeletes).

## Synopsis

```bash
freelo tasks reopen <id>...
                    [--ids <a,b,c>]
                    [--stdin]
                    [--dry-run]
```

Exactly one source of ids is allowed: positional `<id>...`, `--ids`, or
`--stdin`. The flag set, validation, and exit-code semantics are identical
to [`tasks finish`](./tasks-finish.md) — the verbs are mirror images.

## Options

See [`tasks finish`](./tasks-finish.md#options). Same flag set and types.

## Behavior

For each id (in input order):

1. `GET /task/{id}` — pre-check the current state.
2. If `state.state === 'active'` already → emit a success envelope with
   `already_in_target_state: true`. **No POST is sent.** This case also
   matches Freelo's natural API idempotency (the activate endpoint accepts
   already-active tasks and 200s without changes; the CLI short-circuits
   one round-trip earlier).
3. If `state.state === 'deleted'` → reject with `VALIDATION_ERROR`
   (exit 2). The activate endpoint does **not** undelete (per OpenAPI :1802
   — symmetry with `/project/{id}/activate` is intentionally absent).
4. Otherwise → `POST /task/{id}/activate`. On success, emit a success
   envelope with `current_state: 'active'`.

Single-id vs. multi-id mode behavior is identical to `tasks finish`.

## Permissions

- API key with write permission on the task.
- Same role rules as `tasks finish` (assignee, author, or project manager).

## Envelope

`schema: "freelo.tasks.reopen/v1"` — same data shape as
[`tasks finish`](./tasks-finish.md#envelope) but with `verb: "reopen"` and
`current_state: "active"` on live success.

```json
{
  "schema": "freelo.tasks.reopen/v1",
  "data": {
    "task_id": 9012,
    "previous_state": "finished",
    "current_state": "active",
    "already_in_target_state": false,
    "verb": "reopen"
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-04-27T20:30:00Z" }
}
```

Idempotent skip:

```json
{
  "schema": "freelo.tasks.reopen/v1",
  "data": {
    "task_id": 9012,
    "previous_state": "active",
    "current_state": "active",
    "already_in_target_state": true,
    "verb": "reopen"
  }
}
```

## Examples

### Reopen a finished task

```bash
$ freelo tasks reopen 9012
Reopened task #9012 (was finished).

$ freelo tasks reopen 9012 --output json
{"schema":"freelo.tasks.reopen/v1","data":{"task_id":9012,"previous_state":"finished","current_state":"active","already_in_target_state":false,"verb":"reopen"},"rate_limit":{...}}
```

### Already active — idempotent skip

```bash
$ freelo tasks reopen 9012 --output json
{"schema":"freelo.tasks.reopen/v1","data":{"task_id":9012,"previous_state":"active","current_state":"active","already_in_target_state":true,"verb":"reopen"}}
```

### Bulk reopen via `--stdin`

```bash
$ printf '{"id":9012}\n{"id":9013}\n' | freelo tasks reopen --stdin --output ndjson
{"schema":"freelo.tasks.reopen/v1","data":{"task_id":9012,"line_index":0,...}}
{"schema":"freelo.tasks.reopen/v1","data":{"task_id":9013,"line_index":1,...}}
```

### Deleted task: 404 short-circuit (NOT undelete)

```bash
$ freelo tasks reopen 9012
freelo: Task 9012 is deleted; cannot reopen a deleted task.
  hint: Deleted tasks are not addressable via finish/reopen. Restore via the Freelo UI first.
$ echo $?
2
```

## Errors

See [`tasks finish` error table](./tasks-finish.md#errors). Same exit-code
mapping; the wire path differs (`/task/{id}/activate` instead of
`/task/{id}/finish`).

## Non-goals (R11 v1)

- `--all-finished-in-tasklist` shortcut. Compose via `tasks list --scope
tasklist-finished-tasks` (R07.5) when that lands.

See [spec 0021](../specs/0021-tasks-finish-reopen.md) for the full design.
