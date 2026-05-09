# freelo tasks share

Get (or create) a public, unauthenticated URL for a task. Anyone holding
the link can view the task read-only — useful for sharing with clients or
external collaborators who don't have a Freelo account.

The companion command is [`freelo tasks unshare`](./tasks-unshare.md),
which revokes the link.

## Synopsis

```bash
freelo tasks share <id> [--dry-run]
```

## Options

| Flag        | Type / values | Default | Purpose                                                                |
| ----------- | ------------- | ------- | ---------------------------------------------------------------------- |
| `<id>`      | positive int  | —       | Task id (numeric). Required.                                           |
| `--dry-run` | boolean       | false   | Skip the wire call; envelope echoes the path that would have been hit. |

`--output`, `--color`, `--profile`, `-v/-vv`, `--request-id` are inherited
global flags.

## Wire mapping

```
GET /public-link/task/{task_id}
```

The Freelo endpoint is a "GET that creates" — first call mints the URL,
subsequent calls return the same one. The CLI passes the URL through
verbatim. To rotate, run [`tasks unshare`](./tasks-unshare.md) then
`tasks share` again.

> Note: the Freelo OpenAPI documents this as `GET`, even though create-style
> verbs are usually `POST`. The CLI follows the documented contract.

## Idempotency

The wire is idempotent on the server side: same task → same URL until
revoked. The CLI cannot tell whether a given call **created** the link
or **returned** an existing one — Freelo's response is identical in
either case. The envelope's `created` field is therefore `null` on
every live call. Agents that need this distinction must track state
externally.

## Envelope

`schema: freelo.tasks.share/v1`

| Field     | Type            | Always present | Notes                                                                                   |
| --------- | --------------- | -------------- | --------------------------------------------------------------------------------------- |
| `task_id` | int             | yes            | Echo of `<id>` positional.                                                              |
| `url`     | string          | yes            | The public URL on the live path; the literal `<dry-run: not yet known>` on `--dry-run`. |
| `created` | boolean \| null | yes            | Always `null` (wire collapses create / existing). Slot reserved for forward-compat.     |
| `would`   | object          | dry-run only   | `{ method: 'GET', path: '/public-link/task/<id>', body: {} }`                           |

## Examples

```bash
# Get (or create) a shareable URL for a task:
$ freelo tasks share 4567 --output json
{"schema":"freelo.tasks.share/v1","data":{"task_id":4567,"url":"https://app.freelo.io/share/abc123","created":null}}

# Human mode prints one terse line — copy the URL out of stdout:
$ freelo tasks share 4567
Public link for task #4567: https://app.freelo.io/share/abc123

# Pipe the URL straight into a clipboard tool (macOS):
$ freelo tasks share 4567 --output json | jq -r .data.url | pbcopy

# Dry-run echoes the path; no URL is created:
$ freelo tasks share 4567 --dry-run --output json
{"schema":"freelo.tasks.share/v1","dry_run":true,"data":{"task_id":4567,"url":"<dry-run: not yet known>","created":null,"would":{"method":"GET","path":"/public-link/task/4567","body":{}}}}

# Validation: non-numeric <id>:
$ freelo tasks share abc
# stderr: VALIDATION_ERROR — <id> must be a positive integer. exit 2.
```

## Permissions

- API key with read access to the task. The link grants read-only access
  to anyone who holds it; no Freelo account is required to view.
- 401 → `AUTH_EXPIRED` (exit 3); 403 → `FORBIDDEN` (exit 4); 404 →
  `NOT_FOUND` (exit 4) — the **task** doesn't exist or isn't visible to
  you. (404 on `unshare` means something different — see that page.)

## Security note

The URL is opaque but **public**. Anyone who learns it can view the task,
including any comments, file attachments, and metadata visible at the
share level. Treat the URL as sensitive:

- Don't paste it into public chat / issue trackers if the task contains
  confidential data.
- Rotate via `tasks unshare <id>` followed by `tasks share <id>` if you
  suspect the URL has leaked.

## See also

- [`freelo tasks unshare`](./tasks-unshare.md) — revoke the link.
- [`freelo tasks show`](./tasks-show.md) — inspect a task's metadata.
