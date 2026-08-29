# freelo taskchecks edit

Rename a **simple checklist item**, and/or assign or clear its worker.

> **Which kind of id do you have?** These commands accept only a _simple_ checklist item id (a
> `tasks_checks.id`). A _smart_ subtask — one with its own task id — returns `404` here and is edited with
> [`freelo tasks edit`](./tasks-edit.md) instead. See [Two id spaces](#two-id-spaces) below.

## Synopsis

```bash
freelo taskchecks edit <id> [--name <str>] [--worker <id> | --clear-worker] [--notify-author] [--dry-run]
```

## Arguments

| Argument | Notes                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `<id>`   | The `tasks_checks.id` of a simple checklist item. Positive integer, validated locally before any network call. Required. |

## Options

| Flag              | Type   | Default | Purpose                                                                            |
| ----------------- | ------ | ------- | ---------------------------------------------------------------------------------- |
| `--name <str>`    | string | —       | New name. Must be non-empty.                                                       |
| `--worker <id>`   | int    | —       | Assign a worker by **user id**. Mutex with `--clear-worker`.                       |
| `--clear-worker`  | bool   | false   | Unassign the worker (sends `worker: null`). Mutex with `--worker`.                 |
| `--notify-author` | bool   | false   | Keep yourself in the notification recipients even though you triggered the change. |
| `--dry-run`       | bool   | false   | Skip the `POST`. The envelope echoes the exact body that would have been sent.     |

At least one of `--name`, `--worker` or `--clear-worker` is required. `--notify-author` on its own is a
usage error (exit 2): it is a modifier on a change, and there would be no change to modify.

## Only two fields are editable

This is a much smaller surface than [`freelo tasks edit`](./tasks-edit.md), and deliberately so. The Freelo
endpoint behind this command accepts **only** `name` and `worker`; sending `priority_enum`, `priority`,
`due_date` or `due_date_end` returns a `400`. Rather than offer flags that are guaranteed to fail, the CLI
does not define them.

If you need priorities or due dates, you are holding the wrong kind of item — a simple checklist item has no
storage for them. Use a smart subtask and `freelo tasks edit`.

There are no batch surfaces (`--ids`, `--stdin`) on `edit`, because the payload differs per item. The other
three taskcheck commands carry no payload and do batch — see
[`taskchecks finish`](./taskchecks-finish.md).

## Two id spaces

Freelo stores checklist items in two different places, and enforces the split at the HTTP level:

| Kind       | Storage                               | Managed with                                     |
| ---------- | ------------------------------------- | ------------------------------------------------ |
| **simple** | a `tasks_checks` row, `task_id: null` | `freelo taskchecks edit\|delete\|finish\|reopen` |
| **smart**  | a real task, with its own task id     | `freelo tasks edit\|delete\|finish\|reopen`      |

`freelo subtasks add` creates a smart subtask when it can and **silently falls back** to a simple checklist
item when the parent's tasklist cannot host one — so a project can easily contain both.

To tell them apart, list them and read the `type` field:

```console
$ freelo subtasks list --task 3310 --output json | jq -c '.data.items[] | {id, type, task_id, name}'
{"id":4821,"type":"taskcheck","task_id":null,"name":"Draft intro"}
{"id":991,"type":"subtask","task_id":991,"name":"Review copy"}
```

`type: "taskcheck"` → use these commands. `type: "subtask"` → use `freelo tasks …`.

**The CLI will not guess between the two.** It would be technically possible to try `/taskcheck/{id}` and
retry against `/task/{id}` on a `404`, but the two id sequences are independent and overlap in range, so a
typo'd or stale checklist id is quite likely to be a valid, live, **unrelated** task you own. A fallback
would then quietly edit the wrong object and report success. Reporting an error you can act on is the safer
trade. See [spec 0066 §3](../specs/0066-m03-taskchecks.md) for the full derivation.

## A 404 is an error, never a silent success

If the id is not a simple checklist item you can see, the command fails with exit 4:

```json
{
  "schema": "freelo.error/v1",
  "error": {
    "code": "NOT_FOUND",
    "message": "Taskcheck 991 not found.",
    "http_status": 404,
    "retryable": false,
    "hint_next": "This endpoint only accepts a *simple* checklist item id (a `tasks_checks.id`). A smart subtask — one with its own task id — returns 404 here; use `freelo tasks edit 991` instead. The id may also not exist, or not be visible to you. Run `freelo subtasks list --task <parent-id>` and check each item's `type` field: `taskcheck` = simple (use `freelo taskchecks`), `subtask` = smart (use `freelo tasks`)."
  }
}
```

The **message** stays a plain not-found. The CLI cannot tell "wrong id space" from "does not exist" from
"not visible to you", so it asserts none of them; all three live in `hint_next`.

## Envelope

`schema: "freelo.taskchecks.edit/v1"`

```json
{
  "schema": "freelo.taskchecks.edit/v1",
  "data": {
    "taskcheck_id": 4821,
    "applied_changes": ["name", "worker"],
    "notify_author": false
  },
  "rate_limit": { "remaining": 4998, "reset_at": "2026-08-29T11:00:00Z" }
}
```

| Field             | Notes                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `taskcheck_id`    | The id you asked to edit, echoed for trace correlation.                                                                           |
| `applied_changes` | Which CLI fields were sent: `"name"`, `"worker"`, `"clear_worker"`. An echo of **intent** — the API's 200 body carries no entity. |
| `notify_author`   | What the command asked for.                                                                                                       |
| `would`           | Present only with `--dry-run`: `{ "method": "POST", "path": "/taskcheck/<id>", "body": { … } }`.                                  |

## Examples

Rename an item interactively:

```console
$ freelo taskchecks edit 4821 --name "Draft the introduction"
Edited taskcheck 4821 (name).
```

Hand an item to a colleague, as an agent would:

```console
$ FREELO_API_KEY=… FREELO_EMAIL=… freelo taskchecks edit 4821 --worker 512 --output json
{"schema":"freelo.taskchecks.edit/v1","data":{"taskcheck_id":4821,"applied_changes":["worker"],"notify_author":false},"rate_limit":{"remaining":4998,"reset_at":"2026-08-29T11:00:00Z"}}
```

Check the wire body before committing to it:

```console
$ freelo taskchecks edit 4821 --clear-worker --dry-run --output json
{"schema":"freelo.taskchecks.edit/v1","data":{"taskcheck_id":4821,"applied_changes":["clear_worker"],"notify_author":false,"would":{"method":"POST","path":"/taskcheck/4821","body":{"worker":null}}},"dry_run":true}
```

## Permissions

You need write access to the parent task's project. Freelo returns `404` rather than `403` for items you
cannot see, so an ACL failure is indistinguishable from a missing id — see above.

## Exit codes

| Code | When                                                                               |
| ---- | ---------------------------------------------------------------------------------- |
| 0    | The edit succeeded.                                                                |
| 2    | Usage / validation error (bad id, empty `--name`, mutex flags, nothing to change). |
| 3    | `AUTH_EXPIRED` — credentials rejected (401).                                       |
| 4    | API error, including `NOT_FOUND` (404), `FORBIDDEN` (403), rate limiting, and 5xx. |

## See also

- [`freelo subtasks list`](./subtasks-list.md) — find checklist item ids and their `type`.
- [`freelo subtasks add`](./subtasks-add.md) — create them.
- [`freelo taskchecks finish`](./taskchecks-finish.md) / [`reopen`](./taskchecks-reopen.md) / [`delete`](./taskchecks-delete.md)
- [`freelo tasks edit`](./tasks-edit.md) — the smart-subtask equivalent.
- [spec 0066](../specs/0066-m03-taskchecks.md) — design rationale.
