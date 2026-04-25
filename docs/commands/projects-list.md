# freelo projects list

List the active user's projects in any of five scopes, with a stable
`freelo.projects.list/v1` envelope agents can pin against.

## Synopsis

```bash
freelo projects list [--scope owned|invited|archived|templates|all]
                     [--page N | --all | --cursor <n>]
                     [--fields a,b,c]
```

## Options

| Flag                  | Type / values                                      | Default   | Purpose                                                                                                                                  |
| --------------------- | -------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `--scope <name>`      | `owned`, `invited`, `archived`, `templates`, `all` | `owned`   | Selects which Freelo endpoint to call (see "Scope mapping" below).                                                                       |
| `--page <N>`          | int >= 1 (1-indexed for the user)                  | unset     | Single-page fetch. Mapped to `?p=N-1` on the wire (Freelo is 0-indexed). Mutually exclusive with `--all` and `--cursor`.                 |
| `--all`               | boolean                                            | `false`   | Iterate every page client-side until exhausted. Mutually exclusive with `--page` / `--cursor`.                                           |
| `--cursor <n>`        | int >= 0 (0-indexed; matches `paging.next_cursor`) | unset     | Resume at the cursor value reported by a prior envelope. Designed for agent loops without arithmetic. Mutually exclusive with the above. |
| `--fields <list>`     | comma-separated string                             | unset     | Project each record down to the listed snake_case keys before rendering.                                                                 |
| `--output <mode>`     | `auto` (default), `human`, `json`, `ndjson`        | `auto`    | `auto` resolves to `json` on a non-TTY, `human` otherwise. Inherited global flag.                                                        |
| `--profile <name>`    | string                                             | `default` | Credential profile to use. Inherited global flag.                                                                                        |
| `--request-id <uuid>` | string                                             | unset     | Override the auto-generated request ID.                                                                                                  |

When none of `--page`, `--all`, or `--cursor` is given, the command fetches
**page 1** (`?p=0` on the wire) and returns it.

## Scope mapping

| `--scope`   | Endpoint                 | Pagination        | Inner key           | Entity shape     |
| ----------- | ------------------------ | ----------------- | ------------------- | ---------------- |
| `owned`     | `GET /projects`          | none (bare array) | n/a                 | `with_tasklists` |
| `invited`   | `GET /invited-projects`  | paginated wrapper | `invited_projects`  | `with_tasklists` |
| `archived`  | `GET /archived-projects` | paginated wrapper | `archived_projects` | `with_tasklists` |
| `templates` | `GET /template-projects` | paginated wrapper | `template_projects` | `with_tasklists` |
| `all`       | `GET /all-projects`      | paginated wrapper | `projects`          | `full`           |

The `data.entity_shape` discriminator on the envelope tells agents which
fields each item in `data.projects` carries.

For `--scope owned`, the envelope's `paging` is synthesized as a single page
(`page: 0`, `next_cursor: null`) so agents do not need to special-case it.

## Required Freelo permissions

Standard Basic auth from `freelo auth login` (or `FREELO_API_KEY` +
`FREELO_EMAIL`). No additional Freelo permissions or scopes beyond what
`auth login` already establishes.

## Examples

### Agent invocation — list owned projects (default)

```bash
$ FREELO_API_KEY=sk-... FREELO_EMAIL=agent@acme.cz freelo projects list --output json
```

```json
{
  "schema": "freelo.projects.list/v1",
  "data": {
    "entity_shape": "with_tasklists",
    "scope": "owned",
    "projects": [
      {
        "id": 42,
        "name": "Site redesign",
        "date_add": "2026-01-15T10:00:00+01:00",
        "date_edited_at": "2026-04-20T14:32:00+01:00",
        "tasklists": [{ "id": 101, "name": "Backlog" }],
        "client": { "id": 7, "email": "client@example.cz", "name": "Acme s.r.o." }
      }
    ]
  },
  "paging": { "page": 0, "per_page": 1, "total": 1, "next_cursor": null },
  "rate_limit": { "remaining": 99, "reset_at": null },
  "request_id": "..."
}
```

### Agent invocation — full sweep with `--all` and `ndjson` streaming

```bash
$ freelo projects list --scope all --all --output ndjson
{"schema":"freelo.projects.list/v1","data":{"entity_shape":"full","scope":"all","projects":[/*page 0*/]},"paging":{"page":0,"per_page":25,"total":137,"next_cursor":1},...}
{"schema":"freelo.projects.list/v1","data":{"entity_shape":"full","scope":"all","projects":[/*page 1*/]},"paging":{"page":1,"per_page":25,"total":137,"next_cursor":2},...}
{"schema":"freelo.projects.list/v1","data":{"entity_shape":"full","scope":"all","projects":[/*last page*/]},"paging":{"page":5,"per_page":25,"total":137,"next_cursor":null},...}
```

One envelope per page, so an agent restarting after a network blip can
resume from the last successfully-emitted envelope's `paging.next_cursor`.

### Agent invocation — projection with `--fields`

```bash
$ freelo projects list --scope all --cursor 1 --fields id,name,state --output json
{"schema":"freelo.projects.list/v1","data":{"entity_shape":"full","scope":"all","projects":[{"id":50,"name":"R&D","state":{"id":1,"state":"active"}}]},"paging":{"page":1,"per_page":25,"total":137,"next_cursor":2},...}
```

`--fields` accepts wire-format snake_case keys only. Nested paths
(`--fields state.id`) are not supported in v1. Unknown field names fail
closed before any HTTP call is made.

### Human invocation (TTY)

```bash
$ freelo projects list
```

```
ID  NAME                                       DATE_ADD                  TASKLISTS
42  Site redesign                              2026-01-15T10:00:00+01:00 2
43  Brand refresh                              2026-02-03T09:14:00+01:00 5
```

`tasklists` is summarised as a count and `client` as a name. Use
`--output json` to see the full nested structures.

## Error envelopes

Mutual-exclusion of pagination flags:

```json
{
  "schema": "freelo.error/v1",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Flags --page, --all, and --cursor are mutually exclusive.",
    "http_status": null,
    "request_id": null,
    "retryable": false,
    "hint_next": "Pick one of --page, --all, or --cursor.",
    "docs_url": null
  }
}
```

Unknown `--fields` value:

```json
{
  "schema": "freelo.error/v1",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Unknown field 'date_start' for scope 'owned'. Valid fields: id, name, date_add, date_edited_at, tasklists, client.",
    "http_status": null,
    "request_id": null,
    "retryable": false,
    "hint_next": "Run 'freelo projects list --output json' once to see the full envelope, or check 'freelo --introspect'.",
    "docs_url": null
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
  follows the underlying error.

This preserves both the accumulated work and the failure context — dropping
either would be hostile to agents iterating large workspaces under flaky
network.

## Exit codes

| Code | Meaning                                                                              |
| ---- | ------------------------------------------------------------------------------------ |
| 0    | Success.                                                                             |
| 2    | Validation error (mutually-exclusive flags, unknown / empty / nested `--fields`, …). |
| 3    | Auth error (no credentials, or 401 from the API).                                    |
| 4    | Freelo API error (5xx, 4xx other than 401, or schema mismatch).                      |
| 5    | Network error.                                                                       |
| 6    | Rate-limit budget exhausted after retries.                                           |
| 130  | SIGINT — Ctrl-C mid-request.                                                         |

## Envelope schema commitment

`freelo.projects.list/v1` is a public contract. Field removal, rename, or
retype is breaking and will trigger a `/v(n+1)` bump with a dedicated
changeset entry. Additions (e.g. `applied_filters` when filter flags land
in R03.5) are minor and additive.

## See also

- [`freelo --introspect`](./introspect.md) — discover the full command tree
  programmatically.
- [Getting started](../getting-started.md) — listing projects is the first
  command most users reach for after `freelo auth whoami`.
