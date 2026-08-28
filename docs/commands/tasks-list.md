# freelo tasks list

List tasks across the projects you can see, optionally scoped to a single
project + tasklist, with a stable `freelo.tasks.list/v1` envelope agents
can pin against.

## Synopsis

```bash
freelo tasks list [--project <id>...] [--tasklist <id>...]
                  [--worker <id>] [--state <id>]
                  [--label <name>...] [--without-label <name>]
                  [--due-from YYYY-MM-DD] [--due-to YYYY-MM-DD] [--no-due]
                  [--finished-overdue]
                  [--finished-from YYYY-MM-DD] [--finished-to YYYY-MM-DD]
                  [--search <query>]
                  [--order-by priority|name|date_add|date_edited_at|due_date]
                  [--order asc|desc]
                  [--page N | --all | --cursor <n>]
                  [--fields a,b,c]
```

## Routing

The CLI dispatches to one of two Freelo endpoints based on the flag combo:

| Flags                                                                  | Endpoint                              | Pagination  | Entity shape   |
| ---------------------------------------------------------------------- | ------------------------------------- | ----------- | -------------- |
| Exactly one `--project` AND one `--tasklist` AND no other filters      | `GET /project/{p}/tasklist/{t}/tasks` | unpaginated | `task_summary` |
| Anything else (default; multiple projects/tasklists; any other filter) | `GET /all-tasks`                      | paginated   | `task_full`    |

The `data.endpoint` and `data.entity_shape` fields in the envelope tell
agents which path was taken so they can interpret per-entity fields without
guessing.

> **Note:** `/tasklist/{id}/finished-tasks` is reserved for R07.5 and not
> reachable in v1. To list finished tasks today, use `--state <id>` (where
> `<id>` is the numeric finished-state id; visible on any returned
> `state.id` field). The `--finished-from`, `--finished-to`, and
> `--finished-overdue` flags always route to `/all-tasks` with the
> equivalent server-side filter.

## Options

| Flag                     | Type                                                     | Default | Purpose                                                                                                                                                                    |
| ------------------------ | -------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--project <id>`         | int >= 1, repeatable                                     | unset   | Filter to tasks in this project (or any of these projects when repeated). Maps to `projects_ids[]=<id>...`                                                                 |
| `--tasklist <id>`        | int >= 1, repeatable                                     | unset   | Filter to tasks in this tasklist. Maps to `tasklists_ids[]=<id>...`                                                                                                        |
| `--worker <id>`          | int >= 1                                                 | unset   | Filter to tasks assigned to this user (`worker_id=<id>`).                                                                                                                  |
| `--state <id>`           | int >= 1                                                 | unset   | Filter by numeric state id (`state_id=<id>`).                                                                                                                              |
| `--label <name>`         | non-empty string, repeatable                             | unset   | OR-filter by label name (`with_labels[]=<name>...`). The deprecated singular `with_label` is **never** emitted.                                                            |
| `--without-label <name>` | non-empty string                                         | unset   | Exclude tasks carrying this label (`without_label=<name>`).                                                                                                                |
| `--due-from <date>`      | strict `YYYY-MM-DD`                                      | unset   | Tasks with `due_date >= <date>` (`due_date_range[date_from]`).                                                                                                             |
| `--due-to <date>`        | strict `YYYY-MM-DD`                                      | unset   | Tasks with `due_date <= <date>` (`due_date_range[date_to]`).                                                                                                               |
| `--no-due`               | boolean                                                  | `false` | Tasks with no due date (`no_due_date=true`). Mutually exclusive with `--due-from`/`--due-to`.                                                                              |
| `--finished-overdue`     | boolean                                                  | `false` | Tasks finished after their due date (`finished_overdue=true`).                                                                                                             |
| `--finished-from <date>` | strict `YYYY-MM-DD`                                      | unset   | Tasks finished on or after this date (`finished_date_range[date_from]`).                                                                                                   |
| `--finished-to <date>`   | strict `YYYY-MM-DD`                                      | unset   | Tasks finished on or before this date (`finished_date_range[date_to]`).                                                                                                    |
| `--search <query>`       | string                                                   | unset   | Free-text search (`search_query=<q>`). Not supported on the per-tasklist active route — drop `--project` to land on `/all-tasks`.                                          |
| `--order-by <field>`     | `priority`/`name`/`date_add`/`date_edited_at`/`due_date` | unset\* | Order key (`order_by=<field>`). Accepted on both routes. \*On the per-tasklist route, omitting **both** order flags sends `order_by=priority` — see [Ordering](#ordering). |
| `--order <dir>`          | `asc`/`desc`                                             | unset\* | Order direction (`order=<dir>`). \*See [Ordering](#ordering).                                                                                                              |
| `--page <N>`             | int >= 1 (1-indexed for the user)                        | unset   | Single-page fetch. Mapped to `?p=N-1` on the wire. Mutually exclusive with `--all`/`--cursor`.                                                                             |
| `--all`                  | boolean                                                  | `false` | Iterate every page until exhausted. Mutually exclusive with `--page`/`--cursor`. No-op on the per-tasklist (unpaginated) route.                                            |
| `--cursor <n>`           | int >= 0 (0-indexed)                                     | unset   | Resume at the cursor reported by a prior envelope. On the per-tasklist route, only `--cursor 0` is allowed (anything else fails closed).                                   |
| `--fields <list>`        | comma-separated snake_case keys                          | unset   | Project each record down to these top-level keys. Validated against the entity shape _for the resolved route_ (so `state` is invalid on `task_summary`).                   |

## Ordering

Ordering is server-side. Nothing in the response exposes the applied order, so
it can only be requested, never reconstructed locally.

**Per-tasklist route** (`--project <p> --tasklist <t>`, no other filters): when
you pass **neither** `--order-by` nor `--order`, the CLI explicitly requests
`order_by=priority&order=asc`. On this endpoint `priority` means the tasklist's
**manual / drag-and-drop board order** — the order the tasks appear in on the
Freelo web board. It is _not_ the L/M/H task priority field (Freelo reuses the
word; the sort key and the `priority_enum` field are unrelated).

```bash
freelo tasks list --project 42 --tasklist 101
# wire: GET /v1/project/42/tasklist/101/tasks?order_by=priority&order=asc
```

Passing either flag turns the default off for both halves, so an explicit
choice is always honored verbatim:

```bash
freelo tasks list --project 42 --tasklist 101 --order-by date_add
# wire: GET /v1/project/42/tasklist/101/tasks?order_by=date_add
#       (no `order` is sent; the server applies its own default direction)
```

`applied_filters` continues to echo only the flags **you** passed, so the
envelope is unchanged for callers that never sorted explicitly.

**`/all-tasks` route** (every other invocation shape): unchanged. No order
parameter is sent unless you pass one, and the server's documented default
there is `date_add`. `/all-tasks` has no concept of manual board order — if you
need board order, use the per-tasklist route.

### Sorting by deadline (`--order-by due_date`)

Both routes accept `due_date`, so this works whether you're looking at one
tasklist or everything you can see:

```bash
freelo tasks list --project 42 --tasklist 101 --order-by due_date
# wire: GET /v1/project/42/tasklist/101/tasks?order_by=due_date

freelo tasks list --order-by due_date --order asc --all
# wire: GET /v1/all-tasks?p=0&order_by=due_date&order=asc
```

Freelo defines the sort, not the CLI — the CLI forwards the key and renders what
comes back, in the order it comes back. Two rules are worth knowing before you
read the output:

- **Tasks with no due date always sort last**, regardless of `--order asc` or
  `--order desc`. `desc` reverses the dated tasks among themselves; it does not
  float the undated ones to the top. To work with undated tasks directly, filter
  for them with `--no-due` instead of sorting.
- **All-day tasks sort at the start of their day** (00:00), so an all-day task
  comes before a timed task due later the same day.

On `/all-tasks` the server additionally tie-breaks equal due dates **by task
id**, which is what keeps page boundaries stable while you walk `--all` or
`--cursor`. The per-tasklist route is unpaginated and carries no such guarantee,
so ties there may come back in any order.

As with every other value, passing `--order-by due_date` on the per-tasklist
route suppresses the `order_by=priority&order=asc` board-order default for both
halves — you get `order_by=due_date` and no `order` parameter unless you pass
`--order` yourself.

## Examples

### Agent (JSON envelope)

```bash
freelo tasks list --output json --project 42 --label bug --label p1
```

Returns one envelope:

```json
{
  "schema": "freelo.tasks.list/v1",
  "data": {
    "endpoint": "all-tasks",
    "entity_shape": "task_full",
    "applied_filters": { "projects": [42], "labels": ["bug", "p1"] },
    "tasks": [
      /* TaskFull[] */
    ]
  },
  "paging": { "page": 0, "per_page": 25, "total": 17, "next_cursor": 1 },
  "rate_limit": { "remaining": 199, "reset_at": "2026-04-27T07:00:00Z" }
}
```

### Human

```bash
freelo tasks list --project 42 --tasklist 101
```

Renders a table with `ID / NAME / WORKER / DUE_DATE / COUNT_COMMENTS`.

### Streamed pagination

```bash
freelo tasks list --output ndjson --all --search redesign
```

Emits one envelope per page on stdout; the last envelope's
`paging.next_cursor` is `null`. Agents can `read line by line` and stop
early.

## Permissions

Read-only. Any task the caller can see in the Freelo UI is returned;
ACL-filtered tasks just don't appear (no error).

## Schema

Public envelope: `freelo.tasks.list/v1`. The `data.endpoint` and
`data.entity_shape` discriminators identify which Freelo route answered
the request and which task shape its records carry. `data.applied_filters`
echoes the user's parsed filters (always an object, possibly `{}`).

Field additions to entity records are forward-compatible (entity schemas
use `.passthrough()`); discriminator-value additions in v1 (`task_finished`

- `tasklist-finished-tasks`) are reserved for R07.5.

## Forbidden flag combinations

- `--page` + `--all`, `--page` + `--cursor`, `--all` + `--cursor` — pick one.
- `--no-due` + (`--due-from` or `--due-to`) — pick one of the two date
  postures.
- `--search` with exactly one `--project` AND exactly one `--tasklist`
  (and no other unsupported filter) — Freelo's per-tasklist active route
  doesn't honor `search_query`. Drop `--project` to use `/all-tasks`, or
  drop `--search`.
- `--cursor n` (`n >= 1`) on the per-tasklist active route — the route is
  unpaginated; use `--cursor 0` or omit it.
