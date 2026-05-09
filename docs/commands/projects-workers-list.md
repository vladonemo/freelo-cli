# freelo projects workers list

List the workers (active members + owner + guests) on a Freelo project.

Paginated client-side; defaults to fetching every page until exhausted.
The wire endpoint is `GET /project/{id}/workers` (per-page; one round-trip
per `?p=N` value).

## Synopsis

```bash
freelo projects workers list --project <id> [--page N | --all] [--fields <list>]
```

## Options

| Flag              | Type / values                               | Required | Purpose                                                            |
| ----------------- | ------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `--project <id>`  | positive integer                            | yes      | Numeric project id. Use `freelo projects list` to find it.         |
| `--page <n>`      | non-negative integer (0-indexed)            | no       | Fetch one page only. Mutex with `--all` (default).                 |
| `--all`           | flag                                        | no       | Fetch every page (default behaviour; pass to be explicit).         |
| `--fields <list>` | comma-separated: `id`, `fullname`           | no       | Column projection for human and JSON modes. Default: both columns. |
| `--output <mode>` | `auto` (default), `human`, `json`, `ndjson` | no       | `auto` resolves to `json` on a non-TTY, `human` otherwise.         |

## Endpoint called

`GET /project/{id}/workers?p=N` — paginated. Items are basic user records:
`{ id, fullname?: string|null }`. The bare endpoint does not carry hourly
rates; if you need them, use [`freelo projects show <id>`](./projects-show.md).

## Envelope

`schema: "freelo.projects.workers.list/v1"`

```jsonc
{
  "schema": "freelo.projects.workers.list/v1",
  "data": {
    "project_id": 9001,
    "workers": [
      { "id": 305, "fullname": "Jane Doe" },
      { "id": 150, "fullname": "Bob Smith" },
    ],
  },
  "paging": { "page": 0, "per_page": 25, "total": 2, "next_cursor": null },
  "rate_limit": { "remaining": 40, "reset_at": "2026-05-09T20:30:00Z" },
}
```

`paging.next_cursor` is `null` when the final page has been reached (or when
`--page N` returns the last page).

## Examples

**Human mode (TTY):**

```bash
$ freelo projects workers list --project 9001
ID    FULLNAME
305   Jane Doe
150   Bob Smith
```

**Agent mode (env-auth, JSON):**

```bash
$ FREELO_API_KEY=*** FREELO_EMAIL=bot@example.com \
  freelo projects workers list --project 9001 --output json
{"schema":"freelo.projects.workers.list/v1","data":{...},"paging":{...}}
```

**Single page:**

```bash
$ freelo projects workers list --project 9001 --page 0 --output json
```

**Pipeline — extract just the ids:**

```bash
$ freelo projects workers list --project 9001 --output json \
  | jq -r '.data.workers[].id'
305
150
```

## Permissions

The caller must be a member of the project (any role) to list its workers.
Lacking access → HTTP 403 → exit 4.

## Errors

| Cause                               | `code`             | exit   |
| ----------------------------------- | ------------------ | ------ |
| `--project` missing or not positive | `VALIDATION_ERROR` | 2      |
| `--page` not a non-negative integer | `VALIDATION_ERROR` | 2      |
| `--fields` empty / unknown column   | `VALIDATION_ERROR` | 2      |
| 401 (auth)                          | `AUTH_EXPIRED`     | 3      |
| 403 (no access)                     | `FORBIDDEN`        | 4      |
| 404 (project not found)             | `NOT_FOUND`        | 4      |
| 429 (rate-limited after retry)      | `RATE_LIMITED`     | 6      |
| 5xx                                 | `SERVER_ERROR`     | 4      |
| Network failure                     | `NETWORK_ERROR`    | 5      |
| Mid-stream pagination failure       | underlying class   | varies |

See also: [`freelo projects workers remove`](./projects-workers-remove.md).
