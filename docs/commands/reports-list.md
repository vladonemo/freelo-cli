# freelo reports list

Browse work reports (finalized time entries) across every project the caller can see, with optional filters by task, project, worker, and a `date_reported` window. Maps to Freelo's `GET /work-reports` endpoint.

## Synopsis

```bash
freelo reports list [--task <id> ...] [--project <id> ...] [--worker <id> ...]
                    [--from YYYY-MM-DD] [--to YYYY-MM-DD]
                    [--page N | --all]
```

## Options

| Flag                  | Type / values             | Default   | Purpose                                                                                                                              |
| --------------------- | ------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--task <id>`         | positive int (repeatable) | —         | Filter to reports on these tasks (OR across ids). Maps to wire `tasks_ids[]`.                                                        |
| `--project <id>`      | positive int (repeatable) | —         | Filter to reports under these projects (OR across ids). Maps to wire `projects_ids[]`.                                               |
| `--worker <id>`       | positive int (repeatable) | —         | Filter to reports logged by these workers (OR across ids). Maps to wire `users_ids[]`.                                               |
| `--from <YYYY-MM-DD>` | ISO date                  | (none)    | Inclusive lower bound on `date_reported`. Maps to wire `date_reported_range[date_from]`.                                             |
| `--to <YYYY-MM-DD>`   | ISO date                  | (none)    | Inclusive upper bound on `date_reported`. Maps to wire `date_reported_range[date_to]`.                                               |
| `--page <n>`          | 1-indexed positive int    | (omitted) | Single-page mode. **Mutex** with `--all`. CLI is 1-indexed (`--page 1` = first page); the wire is 0-indexed.                         |
| `--all`               | boolean                   | false     | Iterate every page client-side until exhausted. **Mutex** with `--page`. On mid-stream failure, emits a partial envelope + `notice`. |

`--output`, `--color`, `--profile`, `-v`/`-vv`, `--request-id` are inherited
global flags.

## Permissions

- API key with read access to the projects whose reports you want to see. The endpoint is **ACL-filtered** — only reports on entities the caller can read are included.
- Browsing other users' reports requires the appropriate role (project owner / commander / reporting rights). Without it, those rows are simply not returned (no error).

## Envelope

`schema: "freelo.reports.list/v1"`

```json
{
  "schema": "freelo.reports.list/v1",
  "data": {
    "applied_filters": {
      "tasks": [9012],
      "projects": [11],
      "workers": [7],
      "from": "2026-04-01",
      "to": "2026-04-30"
    },
    "reports": [
      {
        "id": 7001,
        "date_add": "2026-04-25T10:00:00Z",
        "date_reported": "2026-04-25",
        "date_edited_at": "2026-04-25T10:30:00Z",
        "note": "Wired up the dashboard feature flag",
        "minutes": 90,
        "cost": { "amount": "1500", "currency": "CZK" },
        "author": { "id": 7, "fullname": "Alice" },
        "worker": { "id": 7, "fullname": "Alice" },
        "task": { "id": 9012, "name": "Wire up the dashboard" },
        "tasklist": { "id": 50, "name": "Sprint A" },
        "project": { "id": 11, "name": "Apollo" }
      }
    ]
  },
  "paging": { "page": 0, "per_page": 25, "total": 137, "next_cursor": 1 },
  "rate_limit": { "remaining": 41, "reset_at": "2026-04-27T20:30:00Z" }
}
```

`applied_filters` echoes only the keys you explicitly set. Unset keys are
omitted (so a flagless invocation produces `applied_filters: {}`).

### Field reference

- **`id`** — server work-report id; load-bearing identity.
- **`date_reported`** — `YYYY-MM-DD`, the date the work was performed.
- **`date_add`** — ISO timestamp the report was logged at (may differ from `date_reported` for backdated entries).
- **`minutes`** — non-negative integer; the unit of work logged.
- **`cost.amount`** — string-form decimal amount (the wire is sometimes a number, sometimes a string; the CLI normalizes to string for envelope stability).
- **`cost.currency`** — `CZK`, `EUR`, or `USD`. Defaults to `CZK` server-side when not configured per-project.
- **`author`** — who logged the report.
- **`worker`** — whose time the report represents (often the same as `author`, but can differ when a project owner logs time on behalf of another worker).
- **`task`** / **`tasklist`** / **`project`** — context blocks; `null` for taskless reports.

### `worker` vs `author`

- `author` is the user who _created_ the report (e.g. via `time stop` or the future R22 `reports log`).
- `worker` is the user whose hours the report represents.
- For self-logged time they're the same. For "I logged this on behalf of someone else" workflows, they differ. The human renderer surfaces `worker` (matches the user's mental model — "whose hours are these").

## Examples

### Most-recent reports (default)

```bash
$ freelo reports list
ID    DATE        WORKER  PROJECT  TASK                   MINUTES  NOTE
7001  2026-04-25  Alice   Apollo   Wire up the dashboard  90       Wired up the dashboard feature flag
7002  2026-04-10  Bob     Apollo   Refactor auth          45       Refactor auth helper
```

### Time spent on one project this month

```bash
$ FREELO_API_KEY=$KEY FREELO_EMAIL=$EMAIL freelo reports list \
    --project 235826 --from 2026-04-01 --to 2026-04-30 --output json
```

### Time spent by one worker on two specific tasks

```bash
$ freelo reports list --worker 7 --task 9012 --task 9013 --all --output json
```

### Sum minutes across the result set with `jq`

```bash
$ freelo reports list --worker 7 --from 2026-04-01 --to 2026-04-30 --all --output json \
    | jq '[.data.reports[].minutes] | add'
390
```

### `--all` partial result on mid-stream failure

If `--all` succeeds for one or more pages then hits a 5xx, the partial
result is emitted on stdout with a `notice`, and the underlying error is
re-thrown to stderr. Agents resume from `paging.next_cursor`:

```bash
$ freelo reports list --all --output json
{"schema":"freelo.reports.list/v1","data":{"reports":[...50 rows...]},"paging":{"page":0,"next_cursor":1},"notice":"Partial result; iteration aborted at page 1."}
freelo: SERVER_ERROR (HTTP 503)
$ echo $?
4
```

## Errors

| Trigger                                               | code               | exit |
| ----------------------------------------------------- | ------------------ | ---- |
| `--task` / `--project` / `--worker` non-positive int  | `VALIDATION_ERROR` | 2    |
| `--from` / `--to` invalid format / unreal date        | `VALIDATION_ERROR` | 2    |
| `--page` zero / negative / non-numeric                | `VALIDATION_ERROR` | 2    |
| `--page` and `--all` combined                         | `VALIDATION_ERROR` | 2    |
| GET 401                                               | `AUTH_EXPIRED`     | 3    |
| GET 403                                               | `FORBIDDEN`        | 4    |
| GET 404                                               | `NOT_FOUND`        | 4    |
| GET 5xx                                               | `SERVER_ERROR`     | 4    |
| HTTP 429 (after read-retry exhaustion)                | `RATE_LIMITED`     | 6    |
| Network failure                                       | `NETWORK_ERROR`    | 5    |
| Server returns a malformed `WorkReportFull` row       | `VALIDATION_ERROR` | 4    |
| Mid-stream failure on `--all` after at least one page | (inner cause)      | 4-6  |

## Limitations (v1)

- **No task-scoped GET endpoint.** Freelo's OpenAPI contract does not document a `GET /task/{task_id}/work-reports` (only the POST counterpart used by R22 to create work reports). The CLI uses the global `/work-reports` endpoint with `--task` mapped to `tasks_ids[]` — same precedent as R16 (`comments list`). Track in roadmap entry **R21**.
- **No `--label <uuid>` flag.** The wire endpoint supports `tasks_labels[]` filtering by task-label UUID, but the roadmap line doesn't surface it; deferred to a follow-up that can also surface labels read across other commands.
- **No `--currency` flag.** Server defaults to CZK and converts costs to that currency for comparability. The envelope passes through `cost.currency` as-is.
- **No `--with-own-taskless` flag.** The wire boolean implicitly scopes to the caller (load-bearing footgun); not surfaced without explicit thinking.
- **No `--per-page` flag.** Server controls page size (default 25).
- **No `--cursor <n>` flag.** Use `--page` (1-indexed) instead. Future-additive.
- **No `--fields` projection.** All `WorkReportFull` fields are returned.
- **No write surface.** Logging / editing / deleting work reports is **R22**.

See [spec 0033](../specs/0033-r21-reports-list.md) for the full design rationale, the scope-narrowing decision, and the mandatory-test list.
