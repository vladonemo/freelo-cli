# freelo notifications read

Mark one or more notifications as read. Maps to Freelo's `POST /notification/{id}/mark-as-read` endpoint, one POST per id. The endpoint is **server-side idempotent** — re-marking an already-read notification returns 200.

## Synopsis

```bash
freelo notifications read <id>...
freelo notifications read --ids <list>
freelo notifications read --stdin
freelo notifications read --all-unread
```

`<id>...`, `--ids`, `--stdin`, and `--all-unread` are **mutually exclusive** — pick exactly one input source per invocation.

## Options

| Flag           | Type / values                          | Default | Purpose                                                                                                                                                                                                                                             |
| -------------- | -------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<id>`         | positive int (variadic positional)     | —       | One or more numeric notification ids.                                                                                                                                                                                                               |
| `--ids <list>` | comma- / space-separated positive ints | —       | List of ids in one flag (e.g. `--ids "1,2,3"` or `--ids "1 2 3"`).                                                                                                                                                                                  |
| `--stdin`      | boolean                                | false   | Read NDJSON from stdin, one `{"id": <int>}` per line. Bad lines emit a per-line error envelope; valid lines proceed. Highest of all per-line exit codes wins.                                                                                       |
| `--all-unread` | boolean                                | false   | Drain the unread feed: list all unread notifications via `GET /all-notifications?only_unread=true`, then POST `mark-as-read` for each id. Per-id failures continue (highest exit code wins). On empty unread set, emits a single `notice` envelope. |
| `--dry-run`    | boolean                                | false   | Skip the POST per id. Each per-id envelope carries `dry_run: true` and `data.would = { method, path, body }`. With `--all-unread`, the **list** call still runs (to know what _would_ be POSTed); the per-id POSTs do not.                          |

`--output`, `--color`, `--profile`, `-v`/`-vv`, `--request-id` are inherited global flags.

## Idempotency

The endpoint is server-side idempotent — re-marking is safe. The CLI cannot pre-check current state per id (no GET-single endpoint exists), so it always POSTs and reports `posted: true`. Agents that need to distinguish first-mark from re-mark must observe `is_unread` via `freelo notifications list --unread` before/after.

## Confirmation

`--all-unread` does **not** require `--yes`. Marking-as-read is reversible (use `freelo notifications unread <id>` to revert), so it is not destructive in the data-loss sense. This matches the precedent set by `freelo tasks finish --ids …`.

## Envelope

`schema: "freelo.notifications.read/v1"`

### Single-id mode

One success envelope on stdout:

```json
{
  "schema": "freelo.notifications.read/v1",
  "data": { "notification_id": 42, "posted": true },
  "rate_limit": { "remaining": 41, "reset_at": "2026-04-29T20:30:00Z" }
}
```

### Multi-id / `--ids` / `--stdin` / `--all-unread` mode

NDJSON: one envelope per id, in input order. Per-id failures emit a `freelo.error/v1` envelope (with a `context.notification_id` and either `context.input_index` or `context.line_index`) on stdout — the success path's stream — so agents can correlate.

```jsonl
{"schema":"freelo.notifications.read/v1","data":{"notification_id":42,"posted":true,"input_index":0},...}
{"schema":"freelo.error/v1","error":{"code":"NOT_FOUND","http_status":404,"context":{"input_index":1,"notification_id":43},...}}
{"schema":"freelo.notifications.read/v1","data":{"notification_id":44,"posted":true,"input_index":2},...}
```

### `--all-unread` per-id envelope

```json
{
  "schema": "freelo.notifications.read/v1",
  "data": {
    "notification_id": 1001,
    "posted": true,
    "source": "all-unread",
    "input_index": 0
  },
  ...
}
```

### `--all-unread` with zero unread

```json
{
  "schema": "freelo.notifications.read/v1",
  "data": {},
  "notice": "No unread notifications.",
  "rate_limit": { "remaining": 41, "reset_at": "2026-04-29T20:30:00Z" }
}
```

### `--dry-run` envelope

```json
{
  "schema": "freelo.notifications.read/v1",
  "dry_run": true,
  "data": {
    "notification_id": 42,
    "would": {
      "method": "POST",
      "path": "/notification/42/mark-as-read",
      "body": {}
    }
  }
}
```

## Examples

```bash
# Mark one notification as read.
freelo notifications read 42 --output json

# Mark several at once.
freelo notifications read 42 43 44 --output json

# Same, via --ids.
freelo notifications read --ids "42,43,44" --output json

# From an NDJSON pipeline.
echo '{"id":42}' '{"id":43}' | tr ' ' '\n' | freelo notifications read --stdin --output json

# Drain the entire unread feed.
freelo notifications read --all-unread --output json

# Preview what --all-unread would do, without POSTing.
freelo notifications read --all-unread --dry-run --output json
```

## Exit codes

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | success (including empty `--all-unread` and empty `--stdin`)            |
| 2    | usage / validation error (invalid id, mutex violation, bad NDJSON line) |
| 3    | auth expired / missing                                                  |
| 4    | API error (4xx/5xx; highest-of for batch)                               |
| 5    | network failure                                                         |
| 6    | rate-limited after retry budget                                         |

## See also

- [`notifications list`](./notifications-list.md) — list notifications (use to find ids and observe state).
- [`notifications unread`](./notifications-unread.md) — revert a read flag.
