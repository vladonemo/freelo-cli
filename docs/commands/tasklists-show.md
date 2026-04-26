# freelo tasklists show

Show one tasklist's detail with an optional pool of users you can assign
tasks to, emitting a stable `freelo.tasklists.show/v1` envelope.

## Synopsis

```bash
freelo tasklists show <id> [--with assignable-workers]
```

## Arguments

| Argument | Type             | Required | Purpose                                            |
| -------- | ---------------- | -------- | -------------------------------------------------- |
| `<id>`   | positive integer | yes      | Numeric tasklist id. Strings or 0/negative reject. |

Validation runs before any HTTP call. A non-positive-integer `<id>` exits 2
with a clear message and no network traffic.

## Options

| Flag                  | Type / values                                  | Default   | Purpose                                                                                                       |
| --------------------- | ---------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| `--with <list>`       | comma-separated; allowed: `assignable-workers` | unset     | Include side-car payloads. Unknown values exit 2. The flag plumbing accepts a list for forward compatibility. |
| `--output <mode>`     | `auto` (default), `human`, `json`, `ndjson`    | `auto`    | `auto` resolves to `json` on a non-TTY, `human` otherwise. Inherited global flag.                             |
| `--profile <name>`    | string                                         | `default` | Credential profile to use. Inherited global flag.                                                             |
| `--request-id <uuid>` | string                                         | unset     | Override the auto-generated request ID.                                                                       |

## Endpoints called

| When                        | Endpoint                                                     | Notes                                                                                         |
| --------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Always                      | `GET /tasklist/{id}`                                         | Returns the `TasklistDetail` shape, which carries `project_id`.                               |
| `--with assignable-workers` | `GET /project/{project_id}/tasklist/{id}/assignable-workers` | Returns a **bare `UserBasic[]` array** — not paginated. One round-trip returns the full list. |

The two calls are **strictly sequential**: the second URL needs `project_id`
from the first response. The user does not supply `project_id`; the command
reads it from the `TasklistDetail` object. If the second call returns 404
or 403, the error envelope's `hint_next` is scoped to "assignable workers
for tasklist N" so you can distinguish "no such tasklist" from "the
tasklist exists but its ACL hides the worker pool."

## Envelope

`schema: "freelo.tasklists.show/v1"`

```jsonc
{
  "schema": "freelo.tasklists.show/v1",
  "data": {
    "tasklist": {
      "id": 314,
      "name": "Backend QA",
      "project_id": 42,
      "date_add": "2026-01-15T09:00:00Z",
      "date_edited_at": "2026-04-20T11:23:45Z",
      "tasks": [
        /* embedded brief tasks; may be null/absent */
      ],
    },
    "assignable_workers": [
      // present only when --with assignable-workers
      { "id": 9, "fullname": "Owner Name" },
      { "id": 17, "fullname": "Jane Doe" },
    ],
  },
  "rate_limit": { "remaining": 42, "reset_at": "2026-04-26T20:00:00Z" },
  "request_id": "...",
}
```

`data.assignable_workers` is **absent** (not `null`, not `[]`) when
`--with assignable-workers` is omitted. Agents can detect side-car presence
with `'assignable_workers' in env.data`.

## Required Freelo permissions

Standard Basic auth from `freelo auth login` (or `FREELO_API_KEY` +
`FREELO_EMAIL`). The caller must have read access to both the tasklist and
its parent project — Freelo collapses both ACL failures into a single 404.
For ACL-restricted tasklists, `--with assignable-workers` returns only
users explicitly granted tasklist ACL plus the project owner / commander;
otherwise it returns the project's full worker list.

## Examples

### Agent — fetch detail with the assignee pool

```bash
$ FREELO_API_KEY=sk-... FREELO_EMAIL=agent@acme.cz \
    freelo tasklists show 314 --with assignable-workers --output json \
  | jq '.data.assignable_workers | length'
3
```

### Agent — read project_id from the envelope to drive a follow-up call

```bash
$ pid=$(freelo tasklists show 314 --output json | jq -r '.data.tasklist.project_id')
$ echo "tasklist 314 lives in project $pid"
tasklist 314 lives in project 42
```

### Human (TTY)

```bash
$ freelo tasklists show 314 --with assignable-workers
Tasklist: Backend QA (#314)
Project:  42
Created:  2026-01-15
Edited:   2026-04-20
Tasks (embedded): 2

ASSIGNABLE WORKERS
ID   FULLNAME
9    Owner Name
17   Jane Doe
23   Karel Novak
```

### Pre-validate `worker_id` before creating a task (planned R09+)

```bash
$ freelo tasklists show 314 --with assignable-workers --output json \
  | jq -e --arg id 17 '.data.assignable_workers[] | select(.id == ($id|tonumber))'
```

A zero-exit means `worker_id=17` is a legal assignee for this tasklist.

## Errors

| Code               | Exit | When                                                                                    |
| ------------------ | ---- | --------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR` | 2    | Non-numeric `<id>`, non-positive `<id>`, unknown `--with` value, empty `--with`.        |
| `AUTH_EXPIRED`     | 3    | 401 — credentials expired or invalid. Run `freelo auth login`.                          |
| `FORBIDDEN`        | 4    | 403 — no permission to view the tasklist or its assignable-workers list.                |
| `NOT_FOUND`        | 4    | 404 — tasklist not found OR caller has no access to the tasklist or its parent project. |
| `SERVER_ERROR`     | 4    | 5xx from Freelo. The hint passes the underlying message through unchanged.              |
| `NETWORK_ERROR`    | 5    | Network failure, DNS, timeout.                                                          |
| `RATE_LIMITED`     | 6    | 429 from Freelo after the retry budget is exhausted.                                    |

The 404 path on the detail call emits a friendlier `hint_next` ("Tasklist N
not found, or your account does not have access.") to disambiguate "doesn't
exist" from "you don't have permission". The 404 path on the side-car call
mentions "assignable workers for tasklist N" specifically, so you can tell
which of the two endpoints failed.

## What's deliberately not here

- **`--with tasks`** — the embedded `tasks` array on `data.tasklist.tasks`
  already covers this. There is no separate Freelo endpoint to call.
- **`--fields a,b,c` projection** — show is a single object whose tree is
  shallow enough to prune client-side. Adding it later is non-breaking.
- **Pagination knobs for assignable-workers** — the endpoint returns the
  full list in one round-trip. There is nothing to paginate.
- **A `--project <id>` flag** — `project_id` is read from the
  `TasklistDetail` response. The user supplies the tasklist id only.

## See also

- [`freelo tasklists list`](./tasklists-list.md) — enumerate tasklists.
- [`freelo projects show`](./projects-show.md) — equivalent surface for projects.
- [`freelo auth login`](./auth-login.md) — set up credentials.
