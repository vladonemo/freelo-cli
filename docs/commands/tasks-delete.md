# freelo tasks delete

Soft-delete one or more tasks. **The first destructive command in the
CLI** — gates every wire call behind a confirmation step (TTY prompt or
`--yes` bypass). Idempotent: a 404 from the API (the task was already
deleted) maps to a success envelope with `already_in_target_state: true`.

Three input shapes:

- **Positional** — `freelo tasks delete 9012 9013 9014 --yes`
- **`--ids`** — `freelo tasks delete --ids "9012,9013,9014" --yes`
- **`--stdin`** (NDJSON) — pipe `{"id": <task_id>}` rows in

## Synopsis

```bash
freelo tasks delete <id>...   [--yes] [--dry-run]
freelo tasks delete --ids "1,2,3"   [--yes] [--dry-run]
freelo tasks delete --stdin   [--yes] [--dry-run]
# Per-line NDJSON: {"id": <task_id>}
```

## Options

| Flag           | Type / values    | Default | Purpose                                                                                                                     |
| -------------- | ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `<id>...`      | positive integer | —       | One or more numeric task ids. Mutex with `--ids` and `--stdin`.                                                             |
| `--ids <list>` | string           | unset   | Comma- or space-separated list of task ids. Mutex with positional and `--stdin`.                                            |
| `--stdin`      | boolean          | false   | Read NDJSON from stdin, one `{"id": <int>}` per line. Mutex with positional and `--ids`.                                    |
| `--dry-run`    | boolean          | false   | Skip the `DELETE /task/{id}` call AND the confirmation prompt. Envelope echoes the path that would have been called.        |
| `-y, --yes`    | boolean (global) | false   | Bypass the confirmation prompt. **Required** in non-TTY mode (otherwise the run fails closed with `CONFIRMATION_REQUIRED`). |

`--output`, `--color`, `--profile`, `-v/-vv`, `--request-id` are inherited
global flags.

## Confirmation policy

The shared `confirmDestructive` helper (`src/lib/confirm.ts`) gates every
destructive command. R13 is the first caller; the policy:

| Mode                            | `--yes`? | `--dry-run`? | Behaviour                                                                                         |
| ------------------------------- | -------- | ------------ | ------------------------------------------------------------------------------------------------- |
| Any                             | yes      | —            | Bypass; proceed silently to the DELETE.                                                           |
| Any                             | —        | yes          | Bypass; emit dry-run envelope; **no DELETE happens**.                                             |
| TTY (interactive shell)         | no       | no           | Prompt: `Delete N task(s)? (y/N)`. Default is **no**. Decline → `CONFIRMATION_REQUIRED` (exit 2). |
| **Non-TTY** (pipe / agent / CI) | no       | no           | Throw `CONFIRMATION_REQUIRED` (exit 2) **before any wire call**. Never hangs waiting on stdin.    |

Confirmation is **per-run, not per-id** — one prompt for the whole batch.

## Behavior

```
Input resolution:
  positional / --ids / --stdin → one of three sources, mutex-checked.

Confirmation gate (once for the whole run):
  --yes OR --dry-run → bypass.
  Non-TTY without --yes → throw CONFIRMATION_REQUIRED (exit 2).
  TTY without --yes → prompt; declined → CONFIRMATION_REQUIRED (exit 2).

For each id:
  --dry-run        → emit envelope with `would: { method: 'DELETE', path: '/task/{id}', body: {} }`.
  Live DELETE       → emit success envelope.
  DELETE returns 404 → emit success envelope with `already_in_target_state: true` (idempotent).
  Other HTTP error  → bubble (single-id) or per-line error envelope (multi/batch).
```

**No GET pre-check.** R13 deliberately does not fetch the task before
deletion (spec 0024 decision 4) — paying two round-trips for a destructive
op is not justified, and the DELETE response is authoritative.
`previous_state` is therefore always `null` in v1 envelopes.

## Permissions

- API key with delete permission on the task. Without permission, DELETE
  returns 403 (`FORBIDDEN`, exit 4).
- Caller must be the assignee, author, or a project manager.

## Envelope

`schema: "freelo.tasks.delete/v1"`

Live success:

```json
{
  "schema": "freelo.tasks.delete/v1",
  "data": {
    "task_id": 9012,
    "previous_state": null,
    "current_state": "deleted",
    "already_in_target_state": false
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-04-27T20:30:00Z" },
  "request_id": "..."
}
```

Idempotent skip (DELETE returned 404 — task was already gone):

```json
{
  "schema": "freelo.tasks.delete/v1",
  "data": {
    "task_id": 9012,
    "previous_state": null,
    "current_state": "deleted",
    "already_in_target_state": true
  }
}
```

Dry-run (no DELETE happens):

```json
{
  "schema": "freelo.tasks.delete/v1",
  "dry_run": true,
  "data": {
    "task_id": 9012,
    "previous_state": null,
    "current_state": "deleted",
    "already_in_target_state": false,
    "would": { "method": "DELETE", "path": "/task/9012", "body": {} }
  }
}
```

In **batch mode** (`--stdin`), each envelope carries an additional
`data.line_index` field (0-indexed across non-empty input lines). Single,
positional-multi, and `--ids` envelopes do **not** carry `line_index`
(matches R11/R12 byte-compat convention).

## Examples

### Single task

```bash
$ freelo tasks delete 9012 --yes
Deleted task #9012.

$ freelo tasks delete 9012 --yes --output json
{"schema":"freelo.tasks.delete/v1","data":{"task_id":9012,"previous_state":null,"current_state":"deleted","already_in_target_state":false},"rate_limit":{...}}
```

### Multiple tasks (positional)

```bash
$ freelo tasks delete 9012 9013 9014 --yes --output ndjson
{"schema":"freelo.tasks.delete/v1","data":{"task_id":9012,"current_state":"deleted","already_in_target_state":false}}
{"schema":"freelo.tasks.delete/v1","data":{"task_id":9013,"current_state":"deleted","already_in_target_state":false}}
{"schema":"freelo.tasks.delete/v1","data":{"task_id":9014,"current_state":"deleted","already_in_target_state":false}}
```

### `--ids` flag

```bash
$ freelo tasks delete --ids "9012, 9013, 9014" --yes --output ndjson
# Same shape as positional multi-id above.
```

### Dry-run (no destructive effect, no confirmation needed)

```bash
$ freelo tasks delete 9012 --dry-run --output json
{"schema":"freelo.tasks.delete/v1","dry_run":true,"data":{"task_id":9012,"previous_state":null,"current_state":"deleted","already_in_target_state":false,"would":{"method":"DELETE","path":"/task/9012","body":{}}}}
$ echo $?
0
```

Dry-run skips both the DELETE and the confirmation prompt. Use it to
verify what an agent's pipeline would delete before flipping `--yes` on.

### Batch via `--stdin`

```bash
$ cat <<EOF | freelo tasks delete --stdin --yes --output json
{"id": 9012}
{"id": 9013}
{"id": 9014}
EOF
{"schema":"freelo.tasks.delete/v1","data":{"task_id":9012,...,"line_index":0},...}
{"schema":"freelo.tasks.delete/v1","data":{"task_id":9013,...,"line_index":1},...}
{"schema":"freelo.tasks.delete/v1","data":{"task_id":9014,...,"line_index":2},...}
```

### Compose with `tasks list` (delete every task with a label)

```bash
$ freelo tasks list --label "drafts-to-clean" --output ndjson \
  | jq -c '{id: .id}' \
  | freelo tasks delete --stdin --yes --output ndjson
```

### Continue-on-error in batch

A bad row does not abort the run; subsequent rows still process. The
exit code at end-of-run is the **max** of per-row exit codes.

```bash
$ cat <<EOF | freelo tasks delete --stdin --yes --output json
{"id": 9012}
{"id": 99999}
EOF
{"schema":"freelo.tasks.delete/v1","data":{"task_id":9012,...,"line_index":0},...}
{"schema":"freelo.tasks.delete/v1","data":{"task_id":99999,"current_state":"deleted","already_in_target_state":true,...,"line_index":1},...}
$ echo $?
0
```

(99999 didn't exist, so the API returned 404 — but R13 treats that as
**idempotent already-deleted**, so the row is a success.)

A real failure (e.g. permission error mid-batch):

```bash
$ cat <<EOF | freelo tasks delete --stdin --yes --output json
{"id": 9012}
{"id": 9013}
EOF
{"schema":"freelo.tasks.delete/v1","data":{"task_id":9012,...,"line_index":0},...}
{"schema":"freelo.error/v1","error":{"code":"FORBIDDEN","http_status":403,"context":{"line_index":1,"task_id":9013},...}}
$ echo $?
4
```

### Confirmation in non-TTY without `--yes`

```bash
$ echo '{"id": 9012}' | freelo tasks delete --stdin --output json
{"schema":"freelo.error/v1","error":{"code":"CONFIRMATION_REQUIRED","message":"Delete 1 task? Refusing in non-interactive mode without --yes.","retryable":false,"hint_next":"Pass --yes to bypass the prompt, or run from a TTY.","docs_url":null}}
$ echo $?
2
```

## Errors

| Trigger                                             | code                    | exit |
| --------------------------------------------------- | ----------------------- | ---- |
| `<id>` not a positive integer                       | `VALIDATION_ERROR`      | 2    |
| `--ids` empty / no source supplied                  | `VALIDATION_ERROR`      | 2    |
| Combining input sources (positional + `--ids` etc.) | `VALIDATION_ERROR`      | 2    |
| NDJSON line not valid JSON or missing/extra fields  | `VALIDATION_ERROR`      | 2    |
| Non-TTY without `--yes` (no `--dry-run`)            | `CONFIRMATION_REQUIRED` | 2    |
| TTY user declines the prompt                        | `CONFIRMATION_REQUIRED` | 2    |
| DELETE 401                                          | `AUTH_EXPIRED`          | 3    |
| DELETE 403                                          | `FORBIDDEN`             | 4    |
| DELETE 404                                          | (success, idempotent)   | 0    |
| DELETE 5xx / other 4xx                              | `SERVER_ERROR`          | 4    |
| HTTP 429                                            | `RATE_LIMITED`          | 6    |
| Network failure                                     | `NETWORK_ERROR`         | 5    |

In batch mode, per-row failures emit `freelo.error/v1` envelopes on stdout
and the run-level exit is `max(per-row exit codes)`.

## Non-goals

- **No `--cascade`** flag. Freelo's DELETE already cascades to subtasks
  server-side; the CLI doesn't expose a knob.
- **No `--ids-from-query`.** Compose
  `freelo tasks list --output json | jq | freelo tasks delete --stdin`.
- **No per-id confirmation prompt** in batch mode. One prompt per run is
  the contract.
- **No "trash" listing or restore.** Freelo's UI handles restore; out of
  scope for the CLI.

See [spec 0024](../specs/0024-tasks-delete.md) for the design rationale,
the confirmation policy decision matrix, and the full mandatory-test list.
