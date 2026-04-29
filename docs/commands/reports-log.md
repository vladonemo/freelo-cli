# freelo reports log

Log a finalized **work report** (time entry) directly on a task — bypasses the live timer flow. Useful for retroactive timesheet entry (R22).

> Maps to `POST /task/{task_id}/work-reports`. The endpoint expects `minutes` (required) plus optional `date_reported`, `note`, and `cost`. The CLI in v1 surfaces only `--minutes`, `--date`, and `--note` — `cost` defaults to the worker's hourly rate × minutes server-side, and the `--cost` flag is deferred to a future slice.

## Synopsis

```bash
# Single-mode: log one work report.
freelo reports log --task <id> --minutes <n> [--date YYYY-MM-DD] [--note <str>] [--dry-run]

# Batch via NDJSON on stdin. Per-row keys: task, minutes, date?, note?
freelo reports log --stdin [--dry-run]
```

`--task` and `--minutes` are required in single-mode. In `--stdin` mode, every NDJSON row supplies its own `task` and `minutes`; single-mode flags are mutex with `--stdin`.

## Options

| Flag                  | Type             | Default        | Purpose                                                                                           |
| --------------------- | ---------------- | -------------- | ------------------------------------------------------------------------------------------------- |
| `--task <id>`         | positive integer | —              | Numeric task id to log time against. **Required in single-mode**; ignored / mutex with `--stdin`. |
| `--minutes <n>`       | positive integer | —              | Duration in whole minutes. **Required in single-mode**.                                           |
| `--date <YYYY-MM-DD>` | ISO date         | server "today" | Backdate the report. Wire field `date_reported`.                                                  |
| `--note <str>`        | string           | unset          | Free-form note. Empty string accepted (sent as `note: ""`).                                       |
| `--dry-run`           | boolean          | false          | Skip the POST; envelope echoes the body that would have been sent.                                |
| `--stdin`             | boolean          | false          | Read NDJSON from stdin (mutex with single-mode flags).                                            |

`--output`, `--color`, `--profile`, `-v/-vv`, `--request-id` are inherited global flags.

## Why no `--cost` / `--worker` flag?

The roadmap line for R22 lists only `--minutes`, `--date`, `--note` on the CLI surface. The OpenAPI body fields `worker_id` (delegate to another user) and `cost` (override the rate calculation) are documented but out of scope for this slice. The wire field `cost` uses string-encoded cents (e.g. `"100025"` = 1000.25) per OpenAPI yaml :3082-3084; if you need `--cost`, watch for a follow-up slice that adds the helper.

## NDJSON `--stdin` shape

Per-line, one JSON object per line. Unknown keys rejected via strict schema.

```jsonc
{ "task": 4567, "minutes": 90 }
{ "task": 4567, "minutes": 30, "date": "2026-04-25" }
{ "task": 4568, "minutes": 60, "note": "Bugfix triage" }
```

| Key       | Type             | Required | Purpose                                  |
| --------- | ---------------- | -------- | ---------------------------------------- |
| `task`    | positive integer | yes      | Wire path segment.                       |
| `minutes` | positive integer | yes      | Wire body `minutes`.                     |
| `date`    | `YYYY-MM-DD`     | no       | Wire body `date_reported`.               |
| `note`    | string           | no       | Wire body `note`. Empty string accepted. |

Each emitted envelope carries an additional `data.line_index` (0-indexed across non-empty input lines).

## Output schema

`freelo.reports.log/v1` — additive, `/v1`.

### Live shape (`data`)

```jsonc
{
  "schema": "freelo.reports.log/v1",
  "data": {
    "report": {
      "id": 7001,
      "date_add": "2026-04-25T10:00:00Z",
      "date_reported": "2026-04-25",
      "minutes": 90,
      "note": "Wired up the dashboard",
      "task": { "id": 4567, "name": "Wire up the dashboard" },
      "cost": { "amount": "1500", "currency": "CZK" },
      "worker": { "id": 7, "fullname": "Alice" },
      "author": { "id": 7, "fullname": "Alice" },
    },
    "applied_input": { "task_id": 4567, "minutes": 90, "note": "Wired up the dashboard" },
  },
  "rate_limit": { "remaining": 999, "reset_at": "..." },
}
```

`applied_input` echoes the user's input — keys are present **only** when the user passed the corresponding flag (`task_id` and `minutes` always present; `date_reported` and `note` only when set).

### Dry-run shape

```jsonc
{
  "schema": "freelo.reports.log/v1",
  "dry_run": true,
  "data": {
    "applied_input": { "task_id": 4567, "minutes": 90 },
    "would": {
      "method": "POST",
      "path": "/task/4567/work-reports",
      "body": { "minutes": 90 },
    },
  },
}
```

`report` is **absent** in dry-run mode (no POST happened, no report exists).

## Examples

### Single-mode

```bash
$ freelo reports log --task 4567 --minutes 90 --note "Wired up the dashboard" --output json
{"schema":"freelo.reports.log/v1","data":{"report":{"id":7001,"minutes":90,"task":{"id":4567,"name":"Wire up the dashboard"},...},"applied_input":{"task_id":4567,"minutes":90,"note":"Wired up the dashboard"}},"rate_limit":{...}}
```

### Backdate (Friday timesheet entry)

```bash
$ freelo reports log --task 4567 --minutes 240 --date 2026-04-24 --note "Friday's PR review"
Logged 240m on task #4567 "Wire up the dashboard" (report #7001).
```

### Dry-run (verify before flipping `--dry-run` off)

```bash
$ freelo reports log --task 4567 --minutes 90 --dry-run --output json
{"schema":"freelo.reports.log/v1","dry_run":true,"data":{"applied_input":{"task_id":4567,"minutes":90},"would":{"method":"POST","path":"/task/4567/work-reports","body":{"minutes":90}}}}
```

### Batch via NDJSON

```bash
$ cat <<EOF | freelo reports log --stdin --output ndjson
{"task":4567,"minutes":30}
{"task":4567,"minutes":60,"note":"second"}
{"task":4568,"minutes":15,"date":"2026-04-24"}
EOF
{"schema":"freelo.reports.log/v1","data":{"report":{...},"applied_input":{"task_id":4567,"minutes":30},"line_index":0},...}
{"schema":"freelo.reports.log/v1","data":{"report":{...},"applied_input":{"task_id":4567,"minutes":60,"note":"second"},"line_index":1},...}
{"schema":"freelo.reports.log/v1","data":{"report":{...},"applied_input":{"task_id":4568,"minutes":15,"date_reported":"2026-04-24"},"line_index":2},...}
```

### Continue-on-error in batch

A bad row does not abort the run; subsequent rows still process. The exit code at end-of-run is the **max** of per-row exit codes.

```bash
$ cat <<EOF | freelo reports log --stdin --output ndjson
not-json
{"task":4567,"minutes":30}
EOF
{"schema":"freelo.error/v1","error":{"code":"VALIDATION_ERROR","context":{"line_index":0},...}}
{"schema":"freelo.reports.log/v1","data":{...,"line_index":1},...}
$ echo $?
2
```

## Errors and exit codes

| Trigger                                                  | Code                                | Exit |
| -------------------------------------------------------- | ----------------------------------- | ---- |
| `--task` / `--minutes` missing or non-int / non-positive | `VALIDATION_ERROR`                  | 2    |
| `--date` not `YYYY-MM-DD` / not a real date              | `VALIDATION_ERROR`                  | 2    |
| Single-mode flag set with `--stdin`                      | `VALIDATION_ERROR`                  | 2    |
| Auth missing / 401                                       | `AUTH_EXPIRED`                      | 3    |
| 400 (e.g. `WorkReportCanNotBeCreatedException`)          | `FREELO_API_ERROR`                  | 4    |
| 403                                                      | `FORBIDDEN`                         | 4    |
| 5xx                                                      | `SERVER_ERROR`                      | 4    |
| 200 with malformed body (zod fail)                       | `VALIDATION_ERROR` (FreeloApiError) | 4    |
| Network failure                                          | `NETWORK_ERROR`                     | 5    |
| 429 (after retry exhaustion)                             | `RATE_LIMITED`                      | 6    |

## See also

- [`freelo reports list`](./reports-list.md) — read your work reports.
- [`freelo reports edit`](./reports-edit.md) — amend an existing report.
- [`freelo reports delete`](./reports-delete.md) — remove a report.
- [`freelo time start`](./time-start.md) / [`freelo time stop`](./time-stop.md) — live-timer flow (alternative to `reports log`).

## Required scopes

Standard Freelo API token (`FREELO_API_KEY` + `FREELO_EMAIL`). Token's owner must have access to the target task's project / tasklist; otherwise the server returns 400 `WorkerHasNoAccessToTasklistException`.
