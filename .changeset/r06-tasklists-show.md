---
'freelo-cli': minor
---

Add `freelo tasklists show <id> [--with assignable-workers]` for fetching a
single tasklist's detail with an optional pool of users you can assign tasks
to. The `--with assignable-workers` side-car returns a bare `UserBasic[]`
array (one round-trip — the endpoint is not paginated) and is the natural
companion to `freelo tasklists list`.

Introduces the public envelope schema **`freelo.tasklists.show/v1`** with
`data.tasklist` always present and `data.assignable_workers` present only
when the side-car was requested (absent — not `null` — otherwise; agents
detect via `'assignable_workers' in env.data`).

Backed by `GET /tasklist/{id}` (always) and
`GET /project/{project_id}/tasklist/{id}/assignable-workers` (under
`--with assignable-workers`). The user supplies only the tasklist id; the
command reads `project_id` from the first response to construct the
side-car URL.
