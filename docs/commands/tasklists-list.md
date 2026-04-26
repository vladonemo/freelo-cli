# freelo tasklists list

List tasklists across the projects you can see, optionally filtered to one
project, with a stable `freelo.tasklists.list/v1` envelope agents can pin
against.

## Synopsis

```bash
freelo tasklists list [--project <id>]
                      [--page N | --all | --cursor <n>]
                      [--fields a,b,c]
```

## Options

| Flag                  | Type / values                                      | Default   | Purpose                                                                                                                                  |
| --------------------- | -------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `--project <id>`      | int >= 1                                           | unset     | Filter to tasklists in this single project. When unset, lists tasklists across all projects you can see.                                 |
| `--page <N>`          | int >= 1 (1-indexed for the user)                  | unset     | Single-page fetch. Mapped to `?p=N-1` on the wire (Freelo is 0-indexed). Mutually exclusive with `--all` and `--cursor`.                 |
| `--all`               | boolean                                            | `false`   | Iterate every page client-side until exhausted. Mutually exclusive with `--page` / `--cursor`.                                           |
| `--cursor <n>`        | int >= 0 (0-indexed; matches `paging.next_cursor`) | unset     | Resume at the cursor value reported by a prior envelope. Designed for agent loops without arithmetic. Mutually exclusive with the above. |
| `--fields <list>`     | comma-separated string                             | unset     | Project each record down to the listed snake_case keys before rendering.                                                                 |
| `--output <mode>`     | `auto` (default), `human`, `json`, `ndjson`        | `auto`    | `auto` resolves to `json` on a non-TTY, `human` otherwise. Inherited global flag.                                                        |
| `--profile <name>`    | string                                             | `default` | Credential profile to use. Inherited global flag.                                                                                        |
| `--request-id <uuid>` | string                                             | unset     | Override the auto-generated request ID.                                                                                                  |

When none of `--page`, `--all`, or `--cursor` is given, the command fetches
**page 1** (`?p=0` on the wire) and returns it.

## Endpoint mapping

A single Freelo endpoint backs both modes:

| `--project` | Endpoint                                     | Inner key   | Entity         |
| ----------- | -------------------------------------------- | ----------- | -------------- |
| **unset**   | `GET /all-tasklists?p=N`                     | `tasklists` | `TasklistFull` |
| `<id>`      | `GET /all-tasklists?projects_ids[]=<id>&p=N` | `tasklists` | `TasklistFull` |

The `data.scope` discriminator on the envelope (`'project' | 'all'`) and
`data.project_id` echo back the caller's intent so an agent can tell at a
glance whether the result was scoped.

> **Note:** The Freelo OpenAPI spec only documents `POST` on
> `/project/{id}/tasklists`. The per-project listing here uses the
> documented `?projects_ids[]=<id>` filter on `/all-tasklists`. ACL
> filtering means a non-existent or invisible project returns an empty
> result set with HTTP 200 — the same observable behaviour a hypothetical
> `GET /project/{id}/tasklists` would have.

## Required Freelo permissions

Standard Basic auth from `freelo auth login` (or `FREELO_API_KEY` +
`FREELO_EMAIL`). No additional Freelo permissions or scopes beyond what
`auth login` already establishes.

## Examples

### Agent invocation — list every tasklist (default scope)

```bash
$ FREELO_API_KEY=sk-... FREELO_EMAIL=agent@acme.cz freelo tasklists list --output json
```

```json
{
  "schema": "freelo.tasklists.list/v1",
  "data": {
    "scope": "all",
    "project_id": null,
    "tasklists": [
      {
        "id": 101,
        "name": "Backlog",
        "date_add": "2026-01-15T10:00:00+01:00",
        "state": { "id": 1, "state": "active" },
        "project": { "id": 42, "name": "Site redesign" },
        "real_minutes_spent": 120
      }
    ]
  },
  "paging": { "page": 0, "per_page": 25, "total": 137, "next_cursor": 1 },
  "rate_limit": { "remaining": 99, "reset_at": null },
  "request_id": "..."
}
```

### Agent invocation — narrow to one project

```bash
$ freelo tasklists list --project 42 --output json
```

```json
{
  "schema": "freelo.tasklists.list/v1",
  "data": {
    "scope": "project",
    "project_id": 42,
    "tasklists": [
      /* tasklists in project 42 */
    ]
  },
  "paging": { "page": 0, "per_page": 25, "total": 7, "next_cursor": null },
  "rate_limit": { "remaining": 98, "reset_at": null },
  "request_id": "..."
}
```

### Agent invocation — full sweep with `--all` and `ndjson` streaming

```bash
$ freelo tasklists list --all --output ndjson
{"schema":"freelo.tasklists.list/v1","data":{"scope":"all","project_id":null,"tasklists":[/*page 0*/]},"paging":{"page":0,"per_page":25,"total":137,"next_cursor":1},...}
{"schema":"freelo.tasklists.list/v1","data":{"scope":"all","project_id":null,"tasklists":[/*page 1*/]},"paging":{"page":1,"per_page":25,"total":137,"next_cursor":2},...}
{"schema":"freelo.tasklists.list/v1","data":{"scope":"all","project_id":null,"tasklists":[/*last page*/]},"paging":{"page":5,"per_page":25,"total":137,"next_cursor":null},...}
```

One envelope per page, so an agent restarting after a network blip can
resume from the last successfully-emitted envelope's `paging.next_cursor`.

### Agent invocation — projection with `--fields`

```bash
$ freelo tasklists list --fields id,name,project --output json
```

`--fields` accepts wire-format snake_case keys only. Nested paths
(`--fields project.name`) are not supported in v1. Unknown field names fail
closed before any HTTP call is made. Default keys: `id, name, date_add,
date_edited_at, state, project, real_minutes_spent, budget, real_cost`.

### Human invocation (TTY)

```bash
$ freelo tasklists list
```

```
ID    NAME                                       PROJECT          DATE_ADD                  STATE
101   Backlog                                    Site redesign    2026-01-15T10:00:00+01:00 active
102   Sprint 1                                   Site redesign    2026-02-01T09:00:00+01:00 active
```

`project` is summarised to its `name` and `state` to the state string. Use
`--output json` to see the full nested structures.

## Error envelopes

Invalid `--project` value (non-integer, zero, or negative):

```json
{
  "schema": "freelo.error/v1",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "--project must be a positive integer.",
    "http_status": null,
    "request_id": null,
    "retryable": false,
    "hint_next": "--project is the numeric project id from `freelo projects list`.",
    "docs_url": null
  }
}
```

Mutual-exclusion of pagination flags:

```json
{
  "schema": "freelo.error/v1",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Flags --page, --all, and --cursor are mutually exclusive.",
    "hint_next": "Pick one of --page, --all, or --cursor.",
    ...
  }
}
```

## Mid-stream `--all` errors

When iteration aborts mid-stream after at least one successful page:

- In `json` mode the partial merged envelope is emitted on **stdout** with
  a `notice: "Partial result; iteration aborted at page N."` field.
  `paging.next_cursor` points at the page that failed so an agent can resume
  via `--cursor`.
- In `ndjson` mode the previously emitted per-page envelopes are not
  retracted; the error envelope follows on stderr.
- The error envelope is then emitted on **stderr**, and the exit code
  follows the underlying error class.

## Exit codes

| Code | Meaning                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------- |
| 0    | Success.                                                                                        |
| 2    | Validation error (`--project` not a positive int, mutually-exclusive flags, bad `--fields`, …). |
| 3    | Auth error (no credentials, or 401 from the API).                                               |
| 4    | Freelo API error (5xx, 4xx other than 401, or schema mismatch).                                 |
| 5    | Network error.                                                                                  |
| 6    | Rate-limit budget exhausted after retries.                                                      |
| 130  | SIGINT — Ctrl-C mid-request.                                                                    |

## Envelope schema commitment

`freelo.tasklists.list/v1` is a public contract. Field removal, rename, or
retype is breaking and will trigger a `/v(n+1)` bump with a dedicated
changeset entry. Additions (e.g. `applied_filters` when filter flags like
`--order-by` land in R05.5) are minor and additive.

## See also

- [`freelo projects list`](./projects-list.md) — find project ids to pass
  to `--project`.
- [`freelo --introspect`](./introspect.md) — discover the full command tree
  programmatically.
- [Getting started](../getting-started.md).
