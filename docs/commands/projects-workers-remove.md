# freelo projects workers remove

Remove one or more workers from a Freelo project. Atomic at the server: every
listed user is checked up-front, and if any single removal would be denied
(e.g. ACL, owner-protection) the whole request fails — no partial removal.

Destructive — requires `--yes` (non-TTY) or interactive confirmation (TTY).

## Synopsis

```bash
freelo projects workers remove --project <id>
                               ( --user <id>... | --email <addr>... )
                               [--yes] [--dry-run]
```

`--user` and `--email` are mutually exclusive: they map to two different
Freelo endpoints (by-ids vs by-emails) whose request bodies are not unioned
server-side. Pick one per invocation.

Repeating the chosen flag adds more users to the same single HTTP call —
the endpoints accept arrays. One invocation = one POST, regardless of how
many users you list.

## Options

| Flag              | Type / values                               | Required     | Purpose                                                                             |
| ----------------- | ------------------------------------------- | ------------ | ----------------------------------------------------------------------------------- |
| `--project <id>`  | positive integer                            | yes          | Numeric project id.                                                                 |
| `--user <id>`     | positive integer (repeatable)               | one of       | Numeric user id. Routes via `POST .../remove-workers/by-ids`.                       |
| `--email <addr>`  | RFC-shaped email (repeatable)               | one of       | User email. Routes via `POST .../remove-workers/by-emails`.                         |
| `--yes` / `-y`    | flag (global)                               | non-TTY: yes | Bypass the confirmation prompt.                                                     |
| `--dry-run`       | flag                                        | no           | Skip the POST and the confirmation prompt; envelope echoes the call that would run. |
| `--output <mode>` | `auto` (default), `human`, `json`, `ndjson` | no           | `auto` resolves to `json` on a non-TTY, `human` otherwise.                          |

Duplicate values within `--user` or `--email` are deduplicated first-seen-wins
before being sent on the wire (the dry-run envelope reflects the deduplicated
shape).

## Confirmation policy

- `--yes` → unconditional proceed.
- `--dry-run` → unconditional proceed (no destructive effect).
- TTY without `--yes` → one prompt for the whole run:

  > Remove N worker(s) from project #ID? They lose access immediately and
  > their task assignments in this project are cleared.

  User declines → exit 2 (`CONFIRMATION_REQUIRED`), no wire call.

- Non-TTY without `--yes` → exit 2 (`CONFIRMATION_REQUIRED`) immediately, no
  wire call.

## Endpoints called

| Mode      | Endpoint                                      | Body                             |
| --------- | --------------------------------------------- | -------------------------------- |
| `--user`  | `POST /project/{id}/remove-workers/by-ids`    | `{ "users_ids":   [305, 150] }`  |
| `--email` | `POST /project/{id}/remove-workers/by-emails` | `{ "users_emails": ["a@x.io"] }` |

Both return `{ "result": "success" }`. The CLI does not surface the body
(it derives the envelope from input + verb).

## Envelope

`schema: "freelo.projects.workers.remove/v1"`

Live success — by ids:

```jsonc
{
  "schema": "freelo.projects.workers.remove/v1",
  "data": {
    "project_id": 9001,
    "removed_by": "ids",
    "users_ids": [305, 150],
    "count": 2,
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-05-09T20:30:00Z" },
}
```

Live success — by emails:

```jsonc
{
  "schema": "freelo.projects.workers.remove/v1",
  "data": {
    "project_id": 9001,
    "removed_by": "emails",
    "users_emails": ["a@x.io", "b@y.io"],
    "count": 2,
  },
}
```

`--dry-run`:

```jsonc
{
  "schema": "freelo.projects.workers.remove/v1",
  "dry_run": true,
  "data": {
    "project_id": 9001,
    "removed_by": "ids",
    "users_ids": [305, 150],
    "count": 2,
    "would": {
      "method": "POST",
      "path": "/project/9001/remove-workers/by-ids",
      "body": { "users_ids": [305, 150] },
    },
  },
}
```

`removed_by` is the discriminant; agents can branch on it to read the right
sibling array.

## Examples

**Human mode (TTY) — by user ids:**

```bash
$ freelo projects workers remove --project 9001 --user 305 --user 150
> Remove 2 worker(s) from project #9001? They lose access immediately and their task assignments in this project are cleared. (y/N) y
Removed 2 workers from project #9001 (by ids).
```

**Agent mode — by email, no prompt:**

```bash
$ FREELO_API_KEY=*** FREELO_EMAIL=bot@example.com \
  freelo projects workers remove --project 9001 \
  --email a@x.io --email b@y.io --yes --output json
{"schema":"freelo.projects.workers.remove/v1","data":{"project_id":9001,"removed_by":"emails","users_emails":["a@x.io","b@y.io"],"count":2},"rate_limit":{...}}
```

**Dry-run — preview the body:**

```bash
$ freelo projects workers remove --project 9001 --user 305 --user 150 --dry-run --output json
{"schema":"freelo.projects.workers.remove/v1","dry_run":true,"data":{"project_id":9001,"removed_by":"ids","users_ids":[305,150],"count":2,"would":{"method":"POST","path":"/project/9001/remove-workers/by-ids","body":{"users_ids":[305,150]}}}}
```

## Permissions

The caller must have project-admin permission (owner or commander). Removing
the project **owner** is rejected by the server — transfer ownership first
(future Wave 6 surface).

## Errors

| Cause                                                   | `code`                  | exit |
| ------------------------------------------------------- | ----------------------- | ---- |
| `--project` missing or not positive                     | `VALIDATION_ERROR`      | 2    |
| Neither `--user` nor `--email`                          | `VALIDATION_ERROR`      | 2    |
| Both `--user` and `--email`                             | `VALIDATION_ERROR`      | 2    |
| `--user` not positive integer                           | `VALIDATION_ERROR`      | 2    |
| `--email` not RFC-shaped                                | `VALIDATION_ERROR`      | 2    |
| Non-TTY without `--yes`                                 | `CONFIRMATION_REQUIRED` | 2    |
| TTY user declines prompt                                | `CONFIRMATION_REQUIRED` | 2    |
| 400 (server validation; e.g. owner removal, unknown id) | `FREELO_API_ERROR`      | 4    |
| 401 (auth)                                              | `AUTH_EXPIRED`          | 3    |
| 403 (no remove permission)                              | `FORBIDDEN`             | 4    |
| 404 (project not found)                                 | `NOT_FOUND`             | 4    |
| 422 (e.g. email not currently a worker)                 | `FREELO_API_ERROR`      | 4    |
| 429                                                     | `RATE_LIMITED`          | 6    |
| 5xx                                                     | `SERVER_ERROR`          | 4    |
| Network failure                                         | `NETWORK_ERROR`         | 5    |

A 400 response whose message mentions the project owner triggers a hint
calling out the owner-cannot-be-removed rule. By-emails 400s without an
owner mention point at the server's "every email must currently be in the
project" pre-check.

See also: [`freelo projects workers list`](./projects-workers-list.md).
