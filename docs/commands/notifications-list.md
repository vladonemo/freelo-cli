# freelo notifications list

List notifications addressed to the calling user (paginated, server-side ACL-filtered). Maps to Freelo's `GET /all-notifications` endpoint.

## Synopsis

```bash
freelo notifications list [--unread] [--project <id> ...] [--type <s> ...]
                          [--page N | --all]
```

## Options

| Flag             | Type / values             | Default   | Purpose                                                                                                                                         |
| ---------------- | ------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `--unread`       | boolean                   | false     | Filter to unread notifications only. Sends wire `only_unread=true`.                                                                             |
| `--project <id>` | positive int (repeatable) | —         | Filter to notifications scoped to these projects (OR across ids). Maps to wire `projects_ids[]`.                                                |
| `--type <s>`     | string (repeatable)       | —         | Filter to one or more notification type strings (e.g. `task_assigned`). Server is the authority on valid types. Maps to `notification_types[]`. |
| `--page <n>`     | 1-indexed positive int    | (omitted) | Single-page mode. **Mutex** with `--all`. CLI is 1-indexed (`--page 1` = first page); the wire is 0-indexed.                                    |
| `--all`          | boolean                   | false     | Iterate every page client-side until exhausted. **Mutex** with `--page`. On mid-stream failure, emits a partial envelope + `notice`.            |

`--output`, `--color`, `--profile`, `-v`/`-vv`, `--request-id` are inherited global flags.

## Permissions

- API key with access to your own notifications. The endpoint is **always scoped to the caller** — there is no way to read another user's notifications through this endpoint.
- Filters with `--project` or `--type` narrow down within the caller's notifications; they do not grant cross-user visibility.

## Envelope

`schema: "freelo.notifications.list/v1"`

```json
{
  "schema": "freelo.notifications.list/v1",
  "data": {
    "applied_filters": {
      "only_unread": true,
      "projects": [11],
      "types": ["task_assigned"]
    },
    "items": [
      {
        "id": 1001,
        "type": "task_assigned",
        "date_action": "2026-04-25T10:00:00Z",
        "is_unread": true,
        "is_new": true,
        "author": { "id": 7, "fullname": "Alice" },
        "who": { "id": 8, "fullname": "Bob" },
        "task": { "id": 5, "name": "Ship R28" },
        "tasklist": { "id": 3, "name": "Backlog" },
        "project": { "id": 11, "name": "Apollo" },
        "comment": null,
        "document": null,
        "file": null,
        "more_comments": false,
        "more_users": []
      }
    ]
  },
  "paging": { "page": 0, "per_page": 25, "total": 4, "next_cursor": null },
  "rate_limit": { "remaining": 41, "reset_at": "2026-04-29T20:30:00Z" }
}
```

`applied_filters` echoes only the keys you explicitly set. Unset keys are omitted (so a flagless invocation produces `applied_filters: {}`).

### Field reference

- **`id`** — numeric notification id; load-bearing identity. Use it for `freelo notifications read` / `unread`.
- **`type`** — wire string (e.g. `task_assigned`, `comment_created`). Free-form; the server is the authority.
- **`is_unread`** — `true` while the notification is in the unread feed; `false` after it has been read.
- **`is_new`** — `true` when the user hasn't seen it yet (separate signal from `is_unread`).
- **`author`** / **`who`** — participants in the notification-triggering event.
- **`task`** / **`tasklist`** / **`project`** — context blocks; any may be `null` depending on the event type.
- **`date_action`** — ISO timestamp of when the underlying action happened.

The schema is **permissive** — Freelo may add fields without bumping the schema version. Removed/renamed fields would require a `/v2` bump and a changeset callout.

## Examples

```bash
# All notifications (page 0).
freelo notifications list --output json

# Unread only.
freelo notifications list --unread --output json

# Unread, scoped to two projects.
freelo notifications list --unread --project 11 --project 22 --output json

# Filter by type.
freelo notifications list --type task_assigned --type comment_created --output json

# Drain every page client-side.
freelo notifications list --all --output json
```

## Pagination

- `--page` is 1-indexed CLI → 0-indexed wire (`--page 1` → `?p=0`).
- `--all` iterates `?p=0, 1, 2, …` until `next_cursor` is null. Mid-stream failure (e.g. 5xx on page 3) emits a partial envelope on **stdout** with `notice`, then re-throws as the top-level error envelope on **stderr**. Exit code reflects the underlying failure.

## Exit codes

| Code | Meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| 0    | success (including empty result)                                 |
| 2    | usage / validation error (invalid flag combo, bad numeric input) |
| 3    | auth expired / missing                                           |
| 4    | API error (4xx/5xx; including 404 / 429-after-retry)             |
| 5    | network failure                                                  |
| 6    | rate-limited after retry budget                                  |

## See also

- [`notifications read`](./notifications-read.md) — mark notifications as read.
- [`notifications unread`](./notifications-unread.md) — mark notifications as unread.
