# freelo labels delete

**GLOBAL hard-delete** for one or more project labels. The label is removed across every project that uses it, not just from a single project. Maps to Freelo's `DELETE /project-labels/{labelId}` endpoint.

> Destructive. Confirmation policy mirrors `freelo tasks delete` and `freelo reports delete`: TTY shows a prompt; non-TTY requires `-y` / `--yes` or fails closed with `CONFIRMATION_REQUIRED` (exit 2).

## Synopsis

```bash
freelo labels delete <id>...               [--yes] [--dry-run]
freelo labels delete --ids <list>           [--yes] [--dry-run]
freelo labels delete --stdin                [--yes] [--dry-run]
```

Pick exactly one input source. Mixing positional, `--ids`, and `--stdin` returns `VALIDATION_ERROR` (exit 2).

## Options

| Flag           | Type / values    | Default | Purpose                                                                    |
| -------------- | ---------------- | ------- | -------------------------------------------------------------------------- |
| `<id>...`      | positive int     | —       | One or more positional label ids.                                          |
| `--ids <list>` | comma/space list | —       | Numeric label ids in a single string. Mutex with positional and `--stdin`. |
| `--stdin`      | bool             | false   | Read NDJSON: one `{"id": <int>}` per line.                                 |
| `--dry-run`    | bool             | false   | Skip the DELETE and the confirmation prompt. Envelope echoes the call.     |
| `-y, --yes`    | bool (global)    | false   | Bypass confirmation. Required in non-TTY mode.                             |

## Idempotency

The CLI uses a **two-arm heuristic** (spec 0035 decision 09):

1. **HTTP 404** — Label was already gone. Envelope reports `already_in_target_state: true`, exit 0.
2. **Other non-2xx** — Hard error (re-thrown as `FreeloApiError`).

There's no documented 400 fallback for "already deleted" on this endpoint, so unlike `reports delete`'s four-arm matrix the labels heuristic is just two arms.

## Confirmation copy

The TTY prompt explicitly says **"GLOBALLY (across all projects)"** so a human user can't miss the scope (decision 10):

```
$ freelo labels delete 12 13
Delete 2 labels GLOBALLY (across all projects)? [y/N] y
Deleted label #12.
Deleted label #13.
```

## Envelope

`schema: "freelo.labels.delete/v1"`

```json
{
  "schema": "freelo.labels.delete/v1",
  "data": {
    "label_id": 12,
    "previous_state": null,
    "current_state": "deleted",
    "already_in_target_state": false
  },
  "rate_limit": { "remaining": 999, "reset_at": "..." }
}
```

When the label was already gone (idempotent skip), `already_in_target_state: true`. Dry-run adds `data.would: { method: "DELETE", path: "/project-labels/12", body: {} }` and `dry_run: true`.

`--stdin` mode adds `data.line_index` (0-indexed) so callers can correlate envelopes with input rows.

## Examples

### Single id with auto-yes

```bash
$ freelo labels delete 12 --yes --output json
{"schema":"freelo.labels.delete/v1","data":{"label_id":12,"previous_state":null,"current_state":"deleted","already_in_target_state":false}}
```

### Batch via NDJSON pipe

```bash
$ printf '{"id":12}\n{"id":13}\n' | freelo labels delete --stdin --yes --output json
{"schema":"freelo.labels.delete/v1","data":{"label_id":12,"current_state":"deleted","already_in_target_state":false,"line_index":0}, ...}
{"schema":"freelo.labels.delete/v1","data":{"label_id":13,"current_state":"deleted","already_in_target_state":false,"line_index":1}, ...}
```

## Errors

| Trigger                       | Code                    | Exit |
| ----------------------------- | ----------------------- | ---- |
| Bad `<id>` (non-positive int) | `VALIDATION_ERROR`      | 2    |
| Multiple input sources        | `VALIDATION_ERROR`      | 2    |
| No input source supplied      | `VALIDATION_ERROR`      | 2    |
| Non-TTY without `--yes`       | `CONFIRMATION_REQUIRED` | 2    |
| TTY user declines prompt      | `CONFIRMATION_REQUIRED` | 2    |
| 401                           | `AUTH_EXPIRED`          | 3    |
| 403                           | `FORBIDDEN`             | 4    |
| 404                           | (idempotent, exit 0)    | 0    |
| 5xx                           | `SERVER_ERROR`          | 4    |
| 429                           | `RATE_LIMITED`          | 6    |

## See also

- `freelo labels list` — discover label ids.
- `freelo labels detach` — remove a label from one project (non-destructive).
- `freelo tasks delete` — confirmation policy table & reasoning.
