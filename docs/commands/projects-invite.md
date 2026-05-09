# freelo projects invite

Invite existing users (by id) and/or external people (by email) to one or
more Freelo projects in a single bulk POST. Maps to
`POST /users/manage-workers`.

Unknown emails trigger user creation server-side — the freshly-created users
come back in the response's `newly_created_users` bucket. Existing users get
access to the listed projects via `newly_invited_users_to_projects`.

## Synopsis

```bash
freelo projects invite --project <id>...
                       [--user <id>...] [--email <addr>...]
                       [--dry-run]
```

`--user` and `--email` are **not** mutually exclusive: the wire body accepts
both arrays in one call. You can mix existing-user ids and new-people emails
in a single invocation. At least one of `--user` / `--email` must be
non-empty.

`--project` is required and repeatable. Every listed project receives every
listed invitee in one atomic server transaction.

## Options

| Flag              | Type / values                               | Required | Purpose                                                                                           |
| ----------------- | ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `--project <id>`  | positive integer (repeatable)               | yes      | Numeric project id. Pass at least one. The whole call is atomic across all listed projects.       |
| `--user <id>`     | positive integer (repeatable)               | one of   | Numeric user id of an existing Freelo user. Combine with `--email` in one invocation if you wish. |
| `--email <addr>`  | RFC-shaped email (repeatable)               | one of   | Email address. Unknown addresses provision a new user account server-side.                        |
| `--dry-run`       | flag                                        | no       | Skip the POST; envelope echoes the call that would have been sent.                                |
| `--output <mode>` | `auto` (default), `human`, `json`, `ndjson` | no       | `auto` resolves to `json` on a non-TTY, `human` otherwise.                                        |

Duplicate values within `--project`, `--user`, or `--email` are deduplicated
first-seen-wins before being sent on the wire (the dry-run envelope reflects
the deduplicated shape).

## Endpoint called

| Endpoint                     | Body                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `POST /users/manage-workers` | `{ "projects_ids": [9001, 9002], "users_ids": [305], "emails": ["new@x.io"] }` |

`users_ids` and `emails` are emitted only when non-empty; `projects_ids` is
always present (and required by the server).

## Envelope

`schema: "freelo.projects.invite/v1"`

Live success:

```jsonc
{
  "schema": "freelo.projects.invite/v1",
  "data": {
    "projects_ids": [9001, 9002],
    "users_ids": [305],
    "emails": ["new@x.io"],
    "result": {
      "newly_invited_users_to_projects": [
        /* existing users granted access on this call */
      ],
      "newly_created_users": [{ "id": 5001, "email": "new@x.io" }],
      "newly_invited_users": [{ "id": 5001, "email": "new@x.io", "projects_ids": [9001, 9002] }],
      "removed_users_from_projects": [],
    },
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-05-09T20:30:00Z" },
}
```

`--dry-run`:

```jsonc
{
  "schema": "freelo.projects.invite/v1",
  "dry_run": true,
  "data": {
    "projects_ids": [9001, 9002],
    "users_ids": [305],
    "emails": ["new@x.io"],
    "would": {
      "method": "POST",
      "path": "/users/manage-workers",
      "body": {
        "projects_ids": [9001, 9002],
        "users_ids": [305],
        "emails": ["new@x.io"],
      },
    },
  },
}
```

`data.users_ids` is present only when `--user` was supplied; `data.emails`
only when `--email` was supplied. `data.result` and `data.would` are mutually
exclusive: `result` on live success, `would` on `--dry-run`.

## Examples

**Human mode (TTY) — single new email, single project:**

```bash
$ freelo projects invite --project 9001 --email new@x.io
Invited 1 person to 1 project.
  - new@x.io  (newly created user, id 5001)
```

**Agent mode — combined existing user + new email across two projects:**

```bash
$ FREELO_API_KEY=*** FREELO_EMAIL=bot@example.com \
  freelo projects invite \
    --project 9001 --project 9002 \
    --user 305 --email new@x.io \
    --output json
{"schema":"freelo.projects.invite/v1","data":{"projects_ids":[9001,9002],"users_ids":[305],"emails":["new@x.io"],"result":{...}},"rate_limit":{...}}
```

**Dry-run — preview the body before committing:**

```bash
$ freelo projects invite --project 9001 --user 305 --user 150 --dry-run --output json
{"schema":"freelo.projects.invite/v1","dry_run":true,"data":{"projects_ids":[9001],"users_ids":[305,150],"would":{"method":"POST","path":"/users/manage-workers","body":{"projects_ids":[9001],"users_ids":[305,150]}}}}
```

## Permissions

- The caller must have invite rights on **every** project in `--project`.
  The server enforces this atomically — if any single project rejects the
  caller, the whole call fails (no partial-success).
- Inviting via `--email` to an unknown address provisions a **new user
  account** in the Freelo workspace. The same plan-limit checks apply as in
  the web UI; exceeding the seat limit returns a 403 / 422 with the
  CLI surfacing a plan-flavored hint.
- `removed_users_from_projects` in the response surfaces only when an ACL
  adjustment implicitly removed someone (rare; not produced by ordinary
  invite calls).

## Out of scope (v1)

- **`--acl-tasklist <id>`** — the OpenAPI body schema does not document a
  tasklist-scoping field, even though the description prose mentions it.
  Tracked as R33.5; will land if real workflows need it.
- **`--stdin` / NDJSON batch** — the endpoint is array-typed across three
  dimensions (projects, users, emails); a per-row NDJSON shape would be
  ambiguous.
- **Removing workers** — see [`freelo projects workers remove`](./projects-workers-remove.md).

## Errors

| Cause                                              | `code`             | exit |
| -------------------------------------------------- | ------------------ | ---- |
| `--project` missing or not positive                | `VALIDATION_ERROR` | 2    |
| Neither `--user` nor `--email`                     | `VALIDATION_ERROR` | 2    |
| `--user` not positive integer                      | `VALIDATION_ERROR` | 2    |
| `--email` not RFC-shaped                           | `VALIDATION_ERROR` | 2    |
| 400 (server validation; field-level)               | `FREELO_API_ERROR` | 4    |
| 401 (auth)                                         | `AUTH_EXPIRED`     | 3    |
| 403 (no invite permission, or plan limit exceeded) | `FORBIDDEN`        | 4    |
| 404 (one or more projects not found)               | `NOT_FOUND`        | 4    |
| 422 (semantic rejection, e.g. seat limit)          | `FREELO_API_ERROR` | 4    |
| 429                                                | `RATE_LIMITED`     | 6    |
| 5xx                                                | `SERVER_ERROR`     | 4    |
| Network failure                                    | `NETWORK_ERROR`    | 5    |

A 400 response is hint-rewritten by scanning both the top-level message and
the server's `errors[]` field-level strings: messages mentioning `emails`,
`users_ids`, or `projects_ids` get a flag-specific hint pointing at the
relevant CLI flag. 403 / 422 messages mentioning `plan` / `seat` / `limit` /
`exceed` get a plan-flavored hint instead of the default permission hint.

See also: [`freelo projects workers remove`](./projects-workers-remove.md),
[`freelo projects workers list`](./projects-workers-list.md).
