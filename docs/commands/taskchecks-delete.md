# freelo taskchecks delete

Delete one or more **simple checklist items** by id.

> **Soft delete.** The row is marked deleted, not physically removed, and there is no undelete endpoint.
>
> **Which kind of id do you have?** This command accepts only a _simple_ checklist item id (a
> `tasks_checks.id`). A _smart_ subtask returns `404` here and is deleted with
> [`freelo tasks delete`](./tasks-delete.md). See [Two id spaces](./taskchecks-edit.md#two-id-spaces).

## Synopsis

```bash
freelo taskchecks delete [id...] [--ids <list>] [--stdin] [--dry-run] [--yes]
```

## Arguments

| Argument  | Notes                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| `[id...]` | One or more `tasks_checks.id` values. Positive integers, validated locally. Mutex with `--ids` and `--stdin`. |

## Options

| Flag           | Type   | Default | Purpose                                                                                        |
| -------------- | ------ | ------- | ---------------------------------------------------------------------------------------------- |
| `--ids <list>` | string | —       | Comma- or space-separated list of ids. Mutex with positional `<id>` and `--stdin`.             |
| `--stdin`      | bool   | false   | Read NDJSON from stdin, one `{"id": <int>}` per line. Mutex with positional and `--ids`.       |
| `--dry-run`    | bool   | false   | Skip every `DELETE` **and** the confirmation prompt. The envelope echoes what would be called. |
| `--yes`, `-y`  | bool   | false   | **Global flag.** Bypasses the confirmation prompt. Required in non-TTY contexts.               |

Exactly one input source must be supplied. Zero sources is a usage error (exit 2); more than one is a usage
error (exit 2). An input source that resolves to zero ids — an empty `--stdin` pipe — is a **silent
success**, exit 0.

There is **no `--notify-author`** on this command. The Freelo endpoint behind it declares no request body at
all, so there is nothing to send. `edit` and `finish` do accept it — the asymmetry is the API's, not the
CLI's.

## Confirmation

This command is destructive, so it goes through the shared confirmation gate:

| Situation           | Behavior                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `--yes`             | Proceeds silently.                                                                                 |
| `--dry-run`         | Proceeds silently — nothing is destroyed, so there is nothing to gate.                             |
| TTY, no `--yes`     | Prompts once for the whole run (`Delete 3 checklist items?`), defaulting to no. Declining exits 2. |
| Non-TTY, no `--yes` | Fails closed immediately: `CONFIRMATION_REQUIRED`, exit 2. No wire calls, no credentials.          |

The prompt fires **once per invocation**, not once per id. With `--stdin` it fires after the pipe has been
buffered, so an empty pipe never prompts.

## A 404 is an error, not an "already deleted" success

`freelo tasks delete` treats a `404` as an idempotent success and reports `already_in_target_state: true`.
**This command deliberately does not** — a `404` is a real error, exit 4.

The reason is specific to this endpoint. The one `404` cause Freelo documents here is _"you passed an id
from the other id space"_ — i.e. the item **still exists, untouched**, and is deletable through
`freelo tasks delete`. Absorbing that into a success would print "deleted", exit `0`, and leave the user
with no idea their checklist item is still there. (A `404` may also mean the id doesn't exist or isn't
visible to you; the CLI cannot tell these apart, so the message stays a plain not-found and the
possibilities live in `hint_next`.)

One consequence: passing the **same id twice** in one invocation reports the second as a `404`. De-duplicate
upstream if you need tolerance.

## No `already_in_target_state` field

Unlike every other delete command in this CLI, the envelope carries **no** `already_in_target_state` and no
`previous_state`. Freelo exposes no way to read a single checklist item back — there is no
`GET /taskcheck/{id}`, and a checklist id doesn't reveal its parent task — so the CLI genuinely cannot know
what state the item was in. Emitting `false` would assert knowledge it does not have; omitting the field
correctly tells a consumer nothing.

## Envelope

`schema: "freelo.taskchecks.delete/v1"`

```json
{
  "schema": "freelo.taskchecks.delete/v1",
  "data": { "taskcheck_id": 4821, "current_state": "deleted" },
  "rate_limit": { "remaining": 4998, "reset_at": "2026-08-29T11:00:00Z" }
}
```

| Field           | Notes                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `taskcheck_id`  | The id you asked to delete, echoed for trace correlation.                                       |
| `current_state` | Always `"deleted"` — derived from the verb; the API's 200 body carries no state.                |
| `would`         | Present only with `--dry-run`: `{ "method": "DELETE", "path": "/taskcheck/<id>", "body": {} }`. |
| `line_index`    | Present only in `--stdin` mode: the 0-based input line.                                         |

One envelope is emitted per id.

## Examples

Delete one item interactively:

```console
$ freelo taskchecks delete 4821
? Delete 1 checklist item? (y/N) y
Deleted taskcheck 4821.
```

Clear out every finished checklist item under a task, composing with `subtasks list`:

```bash
freelo subtasks list --task 3310 --output json \
  | jq -c '.data.items[] | select(.type == "taskcheck") | {id}' \
  | freelo taskchecks delete --stdin --yes
```

Preview a batch before committing to it:

```console
$ freelo taskchecks delete --ids "4821,4822" --dry-run --output json
{"schema":"freelo.taskchecks.delete/v1","data":{"taskcheck_id":4821,"current_state":"deleted","would":{"method":"DELETE","path":"/taskcheck/4821","body":{}}},"dry_run":true}
{"schema":"freelo.taskchecks.delete/v1","data":{"taskcheck_id":4822,"current_state":"deleted","would":{"method":"DELETE","path":"/taskcheck/4822","body":{}}},"dry_run":true}
```

## Batch behavior

- **Single id**: the error bubbles normally — one error envelope on **stderr**, exit code from that error.
- **Multiple ids**: processing **continues past failures**. Successes and per-item `freelo.error/v1`
  envelopes are interleaved on **stdout** in input order, and the **highest** exit code wins.

Per-item error envelopes carry a `context` object: `line_index` (from `--stdin`) or `input_index`
(positional / `--ids`), plus `taskcheck_id` when the item parsed.

## Permissions

You need write access to the parent task's project. Freelo returns `404` rather than `403` for items you
cannot see.

## Exit codes

| Code | When                                                                                         |
| ---- | -------------------------------------------------------------------------------------------- |
| 0    | All deletions succeeded (or the input resolved to zero ids).                                 |
| 2    | Usage / validation error, or `CONFIRMATION_REQUIRED` (non-TTY without `--yes`, or declined). |
| 3    | `AUTH_EXPIRED` — credentials rejected (401).                                                 |
| 4    | API error, including `NOT_FOUND` (404), `FORBIDDEN` (403), rate limiting, and 5xx.           |

## See also

- [`freelo taskchecks edit`](./taskchecks-edit.md) — including the [id-space explanation](./taskchecks-edit.md#two-id-spaces).
- [`freelo tasks delete`](./tasks-delete.md) — the smart-subtask equivalent.
- [spec 0066](../specs/0066-m03-taskchecks.md) — design rationale.
