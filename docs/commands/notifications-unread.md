# freelo notifications unread

Mark one or more notifications as unread (re-surface them in the unread feed). Maps to Freelo's `POST /notification/{id}/mark-as-unread` endpoint, one POST per id. The endpoint is **server-side idempotent** — re-marking is safe.

## Synopsis

```bash
freelo notifications unread <id>...
freelo notifications unread --ids <list>
freelo notifications unread --stdin
```

`<id>...`, `--ids`, and `--stdin` are **mutually exclusive** — pick exactly one input source per invocation. There is **no `--all-unread`** equivalent (the API does not surface a "list all read" filter).

## Options

| Flag           | Type / values                          | Default | Purpose                                                                       |
| -------------- | -------------------------------------- | ------- | ----------------------------------------------------------------------------- |
| `<id>`         | positive int (variadic positional)     | —       | One or more numeric notification ids.                                         |
| `--ids <list>` | comma- / space-separated positive ints | —       | List of ids in one flag (e.g. `--ids "1,2,3"`).                               |
| `--stdin`      | boolean                                | false   | Read NDJSON from stdin, one `{"id": <int>}` per line.                         |
| `--dry-run`    | boolean                                | false   | Skip the POST per id. Each envelope carries `dry_run: true` and `data.would`. |

`--output`, `--color`, `--profile`, `-v`/`-vv`, `--request-id` are inherited global flags.

## Idempotency

Server-side idempotent. The CLI cannot pre-check per-id state (no GET-single endpoint), so it always POSTs and reports `posted: true`. To verify the state flip, observe `is_unread` via `freelo notifications list` before/after.

## Envelope

`schema: "freelo.notifications.unread/v1"`

### Single-id mode

```json
{
  "schema": "freelo.notifications.unread/v1",
  "data": { "notification_id": 42, "posted": true },
  "rate_limit": { "remaining": 41, "reset_at": "2026-04-29T20:30:00Z" }
}
```

### Multi-id / `--ids` / `--stdin` mode

NDJSON: one envelope per id, in input order. Per-id failures emit a `freelo.error/v1` envelope on stdout with `context.notification_id` and `context.input_index` / `context.line_index`.

### `--dry-run` envelope

```json
{
  "schema": "freelo.notifications.unread/v1",
  "dry_run": true,
  "data": {
    "notification_id": 42,
    "would": {
      "method": "POST",
      "path": "/notification/42/mark-as-unread",
      "body": {}
    }
  }
}
```

## Examples

```bash
# Mark one notification as unread.
freelo notifications unread 42 --output json

# Several at once.
freelo notifications unread 42 43 --output json

# Same, via --ids.
freelo notifications unread --ids "42 43" --output json

# From a pipeline.
freelo notifications list --output ndjson \
  | jq -c 'select(.data.id == 42) | {id: .data.id}' \
  | freelo notifications unread --stdin --output json
```

## Exit codes

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | success (including empty `--stdin`)                                     |
| 1    | unknown option (e.g. `--all-unread`)                                    |
| 2    | usage / validation error (invalid id, mutex violation, bad NDJSON line) |
| 3    | auth expired / missing                                                  |
| 4    | API error (4xx/5xx; highest-of for batch)                               |
| 5    | network failure                                                         |
| 6    | rate-limited after retry budget                                         |

## See also

- [`notifications list`](./notifications-list.md) — list notifications (use to find ids and observe state).
- [`notifications read`](./notifications-read.md) — mark notifications as read.
