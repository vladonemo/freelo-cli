# freelo subtasks add

Create a subtask (taskcheck) under a parent task. Additive — no confirmation
gate. Two notable behaviours differ from R09 `tasks create`:

1. **Smart-vs-simple fallback.** Freelo's API auto-falls-back from a **smart
   taskcheck** (full task with worker / due date / tracking users) to a
   **simple taskcheck** (a checkbox row with only a name) when the parent's
   tasklist can't host smart ones. The response envelope's
   `data.storage_form` reflects which form was actually persisted, and
   `data.input_ignored[]` lists fields you set that the server discarded on
   the simple path.
2. **`--worker` is singular** (not repeatable). The roadmap spec prescribes
   one worker per subtask in v1; richer assignment is deferred to a future
   slice.

Two input shapes:

- **Single mode** — `freelo subtasks add --task <id> --name <str> [...]`
- **`--stdin`** (NDJSON) — pipe `{"name": ..., "worker"?: ..., "due"?: ...}` rows in

## Synopsis

```bash
freelo subtasks add --task <id> --name <str> [--worker <id>] [--due YYYY-MM-DD] [--dry-run]
freelo subtasks add --task <id> --stdin [--dry-run]
# Per-line NDJSON: {"name": "...", "worker"?: <int>, "due"?: "YYYY-MM-DD"}
```

## Options

| Flag            | Type / values    | Default | Purpose                                                                                              |
| --------------- | ---------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `--task <id>`   | positive integer | —       | Parent task id. Required.                                                                            |
| `--name <str>`  | non-empty string | —       | Subtask title. Required in single mode; forbidden with `--stdin` (per-line `name` instead).          |
| `--worker <id>` | positive integer | unset   | Worker user id. May be silently discarded on the simple-fallback path (surfaced in `input_ignored`). |
| `--due <date>`  | YYYY-MM-DD       | unset   | Due date. Sent as `<date>T00:00:00Z` on the wire. May be discarded on the simple path.               |
| `--dry-run`     | boolean          | false   | Skip the POST; envelope echoes the body that would have been sent.                                   |
| `--stdin`       | boolean          | false   | Batch mode: read NDJSON from stdin (one subtask per line). Mutex with `--name`/`--worker`/`--due`.   |

`--output`, `--color`, `--profile`, `-v/-vv`, `--request-id` are inherited
global flags. Use `--request-id <uuid>` to thread a stable id through the
envelope and Freelo's request log.

## Smart-vs-simple fallback

The Freelo server first attempts to create a smart taskcheck (a full task
with rich metadata). If the parent's tasklist can't host one (e.g. because
the parent is itself a taskcheck, or it's in a multi-project block), the
server catches `SmartTaskcheckCanNotBeCreatedException` internally and
silently falls back to creating a **simple taskcheck** — a checkbox row
with only a name. Fields you sent for `worker` / `due_date` /
`tracking_users_ids` are silently dropped.

The CLI surfaces this through two response-envelope fields:

- **`data.storage_form: 'smart' | 'simple'`** — inferred from the response
  shape. A smart taskcheck has any of `worker`, `due_date`, `state`,
  `tasklist`, or `project` populated. A simple one returns only the lean
  `id` / `task_id` / `name` shell.
- **`data.input_ignored: ['worker', 'due']`** — only present on the
  `'simple'` path AND only for fields you actually set that the server
  discarded. Always non-empty when present (an empty array is omitted).

**Limitation accepted in v1.** A smart subtask created with no rich fields
(e.g. `--name "x"` only) can return a lean response and be misclassified
as `'simple'`. The trade-off is acceptable because (a) calling the row
"simple" when there's no rich data is functionally correct, and (b) the
alternative would cost an extra round-trip GET that still wouldn't be
deterministic.

## Permissions

- API key with write access to the parent task. Without permission, POST
  returns 403 (`FORBIDDEN`, exit 4).
- The parent task must exist (or 404 → `NOT_FOUND`, exit 4).

## Envelope

`schema: "freelo.subtasks.add/v1"`

### Live success — smart storage

```json
{
  "schema": "freelo.subtasks.add/v1",
  "data": {
    "task_id": 9012,
    "subtask": {
      "id": 5001,
      "task_id": 9012,
      "name": "My subtask",
      "worker": { "id": 7, "fullname": "Alice" },
      "due_date": "2026-05-01T00:00:00Z",
      "state": { "id": 1, "state": "active" }
    },
    "storage_form": "smart"
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-04-27T20:30:00Z" }
}
```

### Live success — simple storage with discarded inputs

```json
{
  "schema": "freelo.subtasks.add/v1",
  "data": {
    "task_id": 9012,
    "subtask": {
      "id": 5002,
      "task_id": 9012,
      "name": "My checklist row",
      "date_add": "2026-04-27T20:30:00Z"
    },
    "storage_form": "simple",
    "input_ignored": ["worker", "due"]
  }
}
```

### Dry-run

```json
{
  "schema": "freelo.subtasks.add/v1",
  "dry_run": true,
  "data": {
    "task_id": 9012,
    "would": {
      "method": "POST",
      "path": "/task/9012/subtasks",
      "body": {
        "name": "My subtask",
        "worker": 7,
        "due_date": "2026-05-01T00:00:00Z"
      }
    }
  }
}
```

`subtask` and `storage_form` are **absent** in dry-run envelopes — the CLI
doesn't pretend to know which storage form the server would pick without
actually calling.

### Batch mode (`--stdin`)

Each row gets one envelope on stdout. Per-row envelopes carry an extra
`data.line_index` (0-indexed across non-empty input lines).

## Examples

### Single subtask, smart storage

```bash
$ freelo subtasks add --task 9012 --name "Audit the auth flow" --worker 7 --due 2026-05-01
Created subtask #5001 "Audit the auth flow".
```

### Single subtask, simple storage (with note)

```bash
$ freelo subtasks add --task 9012 --name "Tickbox row" --worker 7 --due 2026-05-01
Created simple taskcheck #5002 "Tickbox row". Note: server fell back to a simple taskcheck; ignored: worker, due.
```

### Dry-run

```bash
$ freelo subtasks add --task 9012 --name "Test" --worker 7 --due 2026-05-01 --dry-run --output json
{"schema":"freelo.subtasks.add/v1","dry_run":true,"data":{"task_id":9012,"would":{"method":"POST","path":"/task/9012/subtasks","body":{"name":"Test","worker":7,"due_date":"2026-05-01T00:00:00Z"}}}}
```

### Batch via `--stdin`

```bash
$ cat <<EOF | freelo subtasks add --task 9012 --stdin --output ndjson
{"name": "Subtask A"}
{"name": "Subtask B", "worker": 7}
{"name": "Subtask C", "due": "2026-05-15"}
EOF
{"schema":"freelo.subtasks.add/v1","data":{"task_id":9012,"subtask":{...},"storage_form":"smart","line_index":0},...}
{"schema":"freelo.subtasks.add/v1","data":{"task_id":9012,"subtask":{...},"storage_form":"smart","line_index":1},...}
{"schema":"freelo.subtasks.add/v1","data":{"task_id":9012,"subtask":{...},"storage_form":"smart","line_index":2},...}
```

### Compose with `tasks list`

```bash
$ freelo tasks list --label "kickoff" --output ndjson | jq -c '{task: .id}' | while read row; do
    TASK_ID=$(echo "$row" | jq -r '.task')
    echo '{"name":"Pre-flight check"}' | freelo subtasks add --task "$TASK_ID" --stdin
  done
```

## Errors

| Trigger                                                 | code               | exit |
| ------------------------------------------------------- | ------------------ | ---- |
| `--task` missing / non-positive / non-integer           | `VALIDATION_ERROR` | 2    |
| `--name` missing or empty (single mode)                 | `VALIDATION_ERROR` | 2    |
| `--worker` non-positive                                 | `VALIDATION_ERROR` | 2    |
| `--due` not in YYYY-MM-DD                               | `VALIDATION_ERROR` | 2    |
| `--name` / `--worker` / `--due` combined with `--stdin` | `VALIDATION_ERROR` | 2    |
| NDJSON line not valid JSON or missing/extra fields      | `VALIDATION_ERROR` | 2    |
| Per-line `task` key in NDJSON                           | `VALIDATION_ERROR` | 2    |
| POST 401                                                | `AUTH_EXPIRED`     | 3    |
| POST 403                                                | `FORBIDDEN`        | 4    |
| POST 404 (parent task missing)                          | `NOT_FOUND`        | 4    |
| POST 5xx / 422                                          | `FREELO_API_ERROR` | 4    |
| HTTP 429                                                | `RATE_LIMITED`     | 6    |
| Network failure                                         | `NETWORK_ERROR`    | 5    |

In batch mode, per-row failures emit `freelo.error/v1` envelopes on stdout
and the run-level exit is `max(per-row exit codes)`.

## Non-goals

- **No `--priority`, `--description`, `--label`, `--tracking-user`** in v1.
  The roadmap spec lists only `--worker` and `--due` for the initial slice;
  richer flags can land later as a strict additive expansion.
- **No `subtasks delete` / `subtasks edit` / `subtasks finish`.** Subtasks
  are read-and-add-only in this slice.
- **No idempotency.** Creating two subtasks with the same name is allowed
  (it's not an absorbing-state op).
- **No confirmation gate.** `subtasks add` is additive, not destructive.

See [spec 0025](../specs/0025-subtasks-list-add.md) for the design rationale,
the storage-form inference heuristic, and the full mandatory-test list.
