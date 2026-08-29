# freelo taskchecks reopen

Move one or more finished **simple checklist items** back to active.

> **Which kind of id do you have?** This command accepts only a _simple_ checklist item id (a
> `tasks_checks.id`). A _smart_ subtask returns `404` here and is reopened with
> [`freelo tasks reopen`](./tasks-reopen.md). See [Two id spaces](./taskchecks-edit.md#two-id-spaces).

## Synopsis

```bash
freelo taskchecks reopen [id...] [--ids <list>] [--stdin] [--dry-run]
```

## Arguments

| Argument  | Notes                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| `[id...]` | One or more `tasks_checks.id` values. Positive integers, validated locally. Mutex with `--ids` and `--stdin`. |

## Options

| Flag           | Type   | Default | Purpose                                                                                  |
| -------------- | ------ | ------- | ---------------------------------------------------------------------------------------- |
| `--ids <list>` | string | —       | Comma- or space-separated list of ids. Mutex with positional `<id>` and `--stdin`.       |
| `--stdin`      | bool   | false   | Read NDJSON from stdin, one `{"id": <int>}` per line. Mutex with positional and `--ids`. |
| `--dry-run`    | bool   | false   | Skip every `POST`. The envelope echoes the call that would have been made.               |

Exactly one input source must be supplied. An input source that resolves to zero ids — an empty `--stdin`
pipe — is a **silent success**, exit 0.

This command is **not** confirmation-gated: it is exactly reversible with
[`freelo taskchecks finish`](./taskchecks-finish.md).

## There is no `--notify-author` here

`freelo taskchecks edit` and `freelo taskchecks finish` both accept `--notify-author`. This command does
not, and neither does [`taskchecks delete`](./taskchecks-delete.md).

The reason is the API's, not the CLI's: the endpoint behind `reopen` (`POST /taskcheck/{id}/activate`)
declares **no request body at all**, so there is nothing to put a notification preference into. Offering a
flag that silently did nothing would be worse than not offering it.

## The wire verb is `activate`

The CLI calls this `reopen` to match [`freelo tasks reopen`](./tasks-reopen.md); Freelo calls the endpoint
`/activate`. This only matters when you're reading `--dry-run` output or correlating against API logs:

```console
$ freelo taskchecks reopen 4821 --dry-run --output json
{"schema":"freelo.taskchecks.reopen/v1","data":{"taskcheck_id":4821,"verb":"reopen","current_state":"active","notify_author":false,"would":{"method":"POST","path":"/taskcheck/4821/activate","body":{}}},"dry_run":true}
```

## The CLI does not report whether the item was already active

As with [`finish`](./taskchecks-finish.md#the-cli-does-not-report-whether-the-item-was-already-finished),
Freelo exposes no way to read a single checklist item back, so the envelope carries no `previous_state` and
no `already_in_target_state`, and the CLI makes no claim about repeat calls.

## A 404 is an error, not an "already active" success

A `404` here is a real error, exit 4 — the item may exist as a _smart_ subtask, in which case it is
untouched and reopenable through `freelo tasks reopen`. The message stays a plain not-found; the
alternatives (wrong id space / doesn't exist / not visible to you) live in `hint_next`.

## Envelope

`schema: "freelo.taskchecks.reopen/v1"`

```json
{
  "schema": "freelo.taskchecks.reopen/v1",
  "data": {
    "taskcheck_id": 4821,
    "verb": "reopen",
    "current_state": "active",
    "notify_author": false
  },
  "rate_limit": { "remaining": 4998, "reset_at": "2026-08-29T11:00:00Z" }
}
```

| Field           | Notes                                                                                |
| --------------- | ------------------------------------------------------------------------------------ |
| `taskcheck_id`  | The id you asked to reopen.                                                          |
| `verb`          | Always `"reopen"`.                                                                   |
| `current_state` | Always `"active"` — derived from the verb; the API's 200 body carries no state.      |
| `notify_author` | Always `false` — this endpoint takes no body. Present so the shape matches `finish`. |
| `would`         | Present only with `--dry-run`, using the `/activate` wire path.                      |
| `line_index`    | Present only in `--stdin` mode: the 0-based input line.                              |

One envelope is emitted per id.

## Examples

Un-tick an item you finished by mistake:

```console
$ freelo taskchecks reopen 4821
Reopened taskcheck 4821.
```

Reopen a batch as an agent:

```console
$ FREELO_API_KEY=… FREELO_EMAIL=… freelo taskchecks reopen 4821 4822 --output json
{"schema":"freelo.taskchecks.reopen/v1","data":{"taskcheck_id":4821,"verb":"reopen","current_state":"active","notify_author":false},"rate_limit":{"remaining":4998,"reset_at":"2026-08-29T11:00:00Z"}}
{"schema":"freelo.taskchecks.reopen/v1","data":{"taskcheck_id":4822,"verb":"reopen","current_state":"active","notify_author":false},"rate_limit":{"remaining":4997,"reset_at":"2026-08-29T11:00:00Z"}}
```

## Batch behavior

Identical to [`taskchecks finish`](./taskchecks-finish.md#batch-behavior): single-id errors bubble to
stderr; multi-id runs continue past failures with per-item `freelo.error/v1` envelopes on stdout and the
highest exit code winning.

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

- [`freelo taskchecks finish`](./taskchecks-finish.md) — the exact inverse.
- [`freelo taskchecks edit`](./taskchecks-edit.md) — including the [id-space explanation](./taskchecks-edit.md#two-id-spaces).
- [`freelo tasks reopen`](./tasks-reopen.md) — the smart-subtask equivalent.
- [spec 0066](../specs/0066-m03-taskchecks.md) — design rationale.
