# freelo subtasks list

List subtasks (taskchecks) under one parent task, paginated. Reuses R08's
`SubtaskSchema` and the standard pagination infrastructure (`--page` /
`--all` / partial-result envelopes).

## Synopsis

```bash
freelo subtasks list --task <id> [--page N | --all]
```

## Options

| Flag          | Type / values    | Default | Purpose                                                                                                                        |
| ------------- | ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `--task <id>` | positive integer | —       | Parent task id. Required.                                                                                                      |
| `--page <n>`  | non-negative int | 0       | Single-page mode. Mutex with `--all`. Page is 0-indexed (matches Freelo's wire format).                                        |
| `--all`       | boolean          | false   | Iterate every page client-side until exhausted. Mutex with `--page`. On mid-stream failure, emits a partial envelope + notice. |

`--output`, `--color`, `--profile`, `-v/-vv`, `--request-id` are inherited
global flags.

## Permissions

- API key with read access to the parent task. Without permission, `GET
/task/{id}/subtasks` returns 403 (`FORBIDDEN`, exit 4).
- Subtasks are ACL-filtered by the parent task's tasklist rules — the
  response only contains rows the caller can see.

## Envelope

`schema: "freelo.subtasks.list/v1"`

```json
{
  "schema": "freelo.subtasks.list/v1",
  "data": {
    "task_id": 9012,
    "subtasks": [
      {
        "id": 5001,
        "task_id": 9012,
        "name": "Smart subtask",
        "worker": { "id": 7, "fullname": "Alice" },
        "due_date": "2026-05-01T00:00:00Z",
        "state": { "id": 1, "state": "active" }
      },
      {
        "id": 5002,
        "task_id": 9012,
        "name": "Simple checklist row"
      }
    ]
  },
  "paging": { "page": 0, "per_page": 25, "total": 2, "next_cursor": null },
  "rate_limit": { "remaining": 41, "reset_at": "2026-04-27T20:30:00Z" }
}
```

The `subtasks` array can mix **smart** taskchecks (full task with worker /
due date / state) and **simple** taskchecks (lean checklist rows with only
`id` / `task_id` / `name`). The Freelo API returns both shapes uniformly
through this endpoint; downstream renderers / agents should tolerate
either.

## Examples

### Single page (default)

```bash
$ freelo subtasks list --task 9012
ID    NAME                  WORKER  DUE_DATE    STATE
5001  Smart subtask         Alice   2026-05-01  active
5002  Simple checklist row  -       -           -
```

### `--all` (iterate every page)

```bash
$ freelo subtasks list --task 9012 --all --output json
{"schema":"freelo.subtasks.list/v1","data":{"task_id":9012,"subtasks":[...]},"paging":{"page":0,"per_page":50,"total":50,"next_cursor":null},...}
```

### Specific page

```bash
$ freelo subtasks list --task 9012 --page 2 --output json
{"schema":"freelo.subtasks.list/v1","data":{...},"paging":{"page":2,...,"next_cursor":3}}
```

### Empty result

```bash
$ freelo subtasks list --task 9012
ID  NAME            WORKER  DUE_DATE  STATE
    (no subtasks)
```

### Partial result on mid-stream failure (`--all`)

If `--all` succeeds for one or more pages then hits a 5xx, the partial
result is emitted on stdout with a `notice`, and the underlying error is
re-thrown to stderr. Agents resume by reading `paging.next_cursor` (or
the failed page index from `notice`):

```bash
$ freelo subtasks list --task 9012 --all --output json
{"schema":"freelo.subtasks.list/v1","data":{"task_id":9012,"subtasks":[...50 rows...]},"paging":{"page":0,...,"next_cursor":1},"notice":"Partial result; iteration aborted at page 1."}
freelo: SERVER_ERROR (HTTP 503)
$ echo $?
4
```

### Compose with `tasks show`

```bash
$ TASK_ID=$(freelo tasks list --label "spec-review" --output ndjson | jq -r '.id' | head -1)
$ freelo subtasks list --task "$TASK_ID" --output ndjson | jq '.data.subtasks[] | select(.state.state == "active") | .id'
```

## Errors

| Trigger                                               | code               | exit |
| ----------------------------------------------------- | ------------------ | ---- |
| `--task` missing / non-positive / non-integer         | `VALIDATION_ERROR` | 2    |
| `--page` negative                                     | `VALIDATION_ERROR` | 2    |
| `--page` and `--all` combined                         | `VALIDATION_ERROR` | 2    |
| GET 401                                               | `AUTH_EXPIRED`     | 3    |
| GET 403                                               | `FORBIDDEN`        | 4    |
| GET 404 (parent task missing)                         | `NOT_FOUND`        | 4    |
| GET 5xx                                               | `SERVER_ERROR`     | 4    |
| HTTP 429 (after read-retry exhaustion)                | `RATE_LIMITED`     | 6    |
| Network failure                                       | `NETWORK_ERROR`    | 5    |
| Mid-stream failure on `--all` after at least one page | (inner cause)      | 4-6  |

See [spec 0025](../specs/0025-subtasks-list-add.md) for the design
rationale and the full mandatory-test list.
