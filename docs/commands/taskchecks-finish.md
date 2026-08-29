# freelo taskchecks finish

Mark one or more **simple checklist items** as finished.

> **Which kind of id do you have?** This command accepts only a _simple_ checklist item id (a
> `tasks_checks.id`). A _smart_ subtask returns `404` here and is finished with
> [`freelo tasks finish`](./tasks-finish.md). See [Two id spaces](./taskchecks-edit.md#two-id-spaces).

## Synopsis

```bash
freelo taskchecks finish [id...] [--ids <list>] [--stdin] [--notify-author] [--dry-run]
```

## Arguments

| Argument  | Notes                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| `[id...]` | One or more `tasks_checks.id` values. Positive integers, validated locally. Mutex with `--ids` and `--stdin`. |

## Options

| Flag              | Type   | Default | Purpose                                                                                  |
| ----------------- | ------ | ------- | ---------------------------------------------------------------------------------------- |
| `--ids <list>`    | string | —       | Comma- or space-separated list of ids. Mutex with positional `<id>` and `--stdin`.       |
| `--stdin`         | bool   | false   | Read NDJSON from stdin, one `{"id": <int>}` per line. Mutex with positional and `--ids`. |
| `--notify-author` | bool   | false   | Keep yourself in the notification recipients even though you triggered the change.       |
| `--dry-run`       | bool   | false   | Skip every `POST`. The envelope echoes the call that would have been made.               |

Exactly one input source must be supplied. An input source that resolves to zero ids — an empty `--stdin`
pipe — is a **silent success**, exit 0.

This command is **not** confirmation-gated: it is exactly reversible with
[`freelo taskchecks reopen`](./taskchecks-reopen.md).

## The CLI does not report whether the item was already finished

`freelo tasks finish` reports `previous_state` and `already_in_target_state`, because it can read the task
back first. **This command cannot.** Freelo exposes no `GET /taskcheck/{id}`, and a checklist id doesn't
reveal its parent task's id, so there is no way to observe an item's state — before or after.

Consequently the envelope carries neither field, and the CLI makes **no claim** about repeat calls. Whether
finishing an already-finished item is a server-side no-op is not documented, so the CLI passes the server's
answer straight through: a `200` is reported as success, anything else surfaces as the matching typed error.
If you need to know an item's state, read it from `freelo subtasks list`.

## A 404 is an error, not an "already finished" success

A `404` here is a real error, exit 4. The one cause Freelo documents is _"you passed an id from the other id
space"_ — the item exists, untouched, and is finishable through `freelo tasks finish`. Absorbing that into a
success would report `exit 0` for an item that never changed. The message stays a plain not-found (the CLI
can't distinguish wrong-id-space from missing from invisible); the alternatives live in `hint_next`.

## Envelope

`schema: "freelo.taskchecks.finish/v1"`

```json
{
  "schema": "freelo.taskchecks.finish/v1",
  "data": {
    "taskcheck_id": 4821,
    "verb": "finish",
    "current_state": "finished",
    "notify_author": false
  },
  "rate_limit": { "remaining": 4998, "reset_at": "2026-08-29T11:00:00Z" }
}
```

| Field           | Notes                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `taskcheck_id`  | The id you asked to finish.                                                                             |
| `verb`          | Always `"finish"` here. `reopen` emits `"reopen"` against the same shape.                               |
| `current_state` | Always `"finished"` — derived from the verb; the API's 200 body carries no state.                       |
| `notify_author` | What the command asked for.                                                                             |
| `would`         | Present only with `--dry-run`: `{ "method": "POST", "path": "/taskcheck/<id>/finish", "body": { … } }`. |
| `line_index`    | Present only in `--stdin` mode: the 0-based input line.                                                 |

One envelope is emitted per id.

## Examples

Tick one item off:

```console
$ freelo taskchecks finish 4821
Finished taskcheck 4821.
```

Tick off a whole checklist as an agent, keeping yourself notified:

```console
$ FREELO_API_KEY=… FREELO_EMAIL=… freelo taskchecks finish --ids "4821,4822" --notify-author --output json
{"schema":"freelo.taskchecks.finish/v1","data":{"taskcheck_id":4821,"verb":"finish","current_state":"finished","notify_author":true},"rate_limit":{"remaining":4998,"reset_at":"2026-08-29T11:00:00Z"}}
{"schema":"freelo.taskchecks.finish/v1","data":{"taskcheck_id":4822,"verb":"finish","current_state":"finished","notify_author":true},"rate_limit":{"remaining":4997,"reset_at":"2026-08-29T11:00:00Z"}}
```

Finish every simple checklist item under a task:

```bash
freelo subtasks list --task 3310 --output json \
  | jq -c '.data.items[] | select(.type == "taskcheck") | {id}' \
  | freelo taskchecks finish --stdin
```

## Batch behavior

- **Single id**: the error bubbles normally — one error envelope on **stderr**.
- **Multiple ids**: processing **continues past failures**; successes and per-item `freelo.error/v1`
  envelopes interleave on **stdout** in input order, and the **highest** exit code wins.

Per-item error envelopes carry `context.line_index` (`--stdin`) or `context.input_index` (positional /
`--ids`), plus `taskcheck_id` when the item parsed.

## Permissions

You need write access to the parent task's project. Freelo returns `404` rather than `403` for items you
cannot see.

## Exit codes

| Code | When                                                                               |
| ---- | ---------------------------------------------------------------------------------- |
| 0    | All transitions succeeded (or the input resolved to zero ids).                     |
| 2    | Usage / validation error.                                                          |
| 3    | `AUTH_EXPIRED` — credentials rejected (401).                                       |
| 4    | API error, including `NOT_FOUND` (404), `FORBIDDEN` (403), rate limiting, and 5xx. |

## See also

- [`freelo taskchecks reopen`](./taskchecks-reopen.md) — the exact inverse.
- [`freelo taskchecks edit`](./taskchecks-edit.md) — including the [id-space explanation](./taskchecks-edit.md#two-id-spaces).
- [`freelo tasks finish`](./tasks-finish.md) — the smart-subtask equivalent.
- [spec 0066](../specs/0066-m03-taskchecks.md) — design rationale.
