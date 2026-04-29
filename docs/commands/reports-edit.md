# freelo reports edit

Amend an existing **work report** — change `minutes`, `note`, or `date_reported` (R22).

> Maps to **`POST /work-reports/{id}`**. The OpenAPI verb is POST, not PATCH (the roadmap text was wrong; same trap as R18 comments-edit and R20 time-edit). The CLI surface stays as the roadmap intended (`<id>` positional + change flags); only the wire verb differs. See spec 0034 decision 01.

> ACL note: only the report's author and the project's owner / commander can edit. Other callers receive **HTTP 404** (`NotFoundException` — Freelo hides existence from non-authorized users). The CLI surfaces the 404 as `NOT_FOUND` exit 4 verbatim — agents decide whether to retry or treat as missing.

## Synopsis

```bash
# Single-mode: amend one work report.
freelo reports edit <id> [--minutes <n>] [--note <str>] [--date YYYY-MM-DD] [--dry-run]

# Batch via NDJSON on stdin. Per-row keys: id, minutes?, note?, date?
freelo reports edit --stdin [--dry-run]
```

**At least one** of `--minutes`, `--note`, `--date` is required (empty edit rejected with `VALIDATION_ERROR` exit 2). In `--stdin` mode, every row needs at least one change field too — empty rows fail per-line.

## Options

| Flag                  | Type             | Default | Purpose                                                                              |
| --------------------- | ---------------- | ------- | ------------------------------------------------------------------------------------ |
| `<id>`                | positive integer | —       | Positional. Numeric work-report id from `reports list`. **Required in single-mode**. |
| `--minutes <n>`       | positive integer | unset   | New duration in whole minutes.                                                       |
| `--note <str>`        | string           | unset   | New note. Empty string accepted (sent as `note: ""`).                                |
| `--date <YYYY-MM-DD>` | ISO date         | unset   | New `date_reported`.                                                                 |
| `--dry-run`           | boolean          | false   | Skip the POST; envelope echoes the body that would have been sent.                   |
| `--stdin`             | boolean          | false   | Read NDJSON from stdin (mutex with positional `<id>` and single-mode flags).         |

`--output`, `--color`, `--profile`, `-v/-vv`, `--request-id` are inherited global flags.

## Why no `--task` / `--cost` flags?

The OpenAPI body documents both `task_id` (re-parent the report to a different task) and `cost` (override the rate calculation). Both are out of scope for R22 per the roadmap CLI block — stays narrow. If you need to re-parent or override cost, use the Freelo web UI or wait for a follow-up slice.

## NDJSON `--stdin` shape

Per-line, one JSON object per line. Unknown keys rejected via strict schema. **At least one of `minutes` / `note` / `date` is required per row** (empty edit emits a per-line `VALIDATION_ERROR` and contributes exit 2 to the run).

```jsonc
{ "id": 7001, "minutes": 60 }
{ "id": 7002, "note": "Updated note" }
{ "id": 7003, "date": "2026-04-30" }
{ "id": 7004, "minutes": 30, "note": "All three", "date": "2026-04-25" }
```

| Key       | Type             | Required    | Purpose                    |
| --------- | ---------------- | ----------- | -------------------------- |
| `id`      | positive integer | yes         | Wire path segment.         |
| `minutes` | positive integer | conditional | Wire body `minutes`.       |
| `note`    | string           | conditional | Wire body `note`.          |
| `date`    | `YYYY-MM-DD`     | conditional | Wire body `date_reported`. |

Each emitted envelope carries an additional `data.line_index` (0-indexed across non-empty input lines).

## Output schema

`freelo.reports.edit/v1` — additive, `/v1`.

### Live shape (`data`)

```jsonc
{
  "schema": "freelo.reports.edit/v1",
  "data": {
    "report": {
      "id": 7001,
      "minutes": 60,
      "note": "Updated",
      "task": { "id": 4567, "name": "..." },
    },
    "applied_changes": { "minutes": 60, "note": "Updated" },
  },
  "rate_limit": { "remaining": 998, "reset_at": "..." },
}
```

`applied_changes` mirrors the wire body shape **exactly** — keys are present **only** when the user passed the corresponding flag. Mirrors `freelo.time.edit/v1`'s `applied_changes` precedent. Agents read `'minutes' in applied_changes` to know whether the user touched that field at all.

### Dry-run shape

```jsonc
{
  "schema": "freelo.reports.edit/v1",
  "dry_run": true,
  "data": {
    "applied_changes": { "minutes": 60 },
    "would": {
      "method": "POST",
      "path": "/work-reports/7001",
      "body": { "minutes": 60 },
    },
  },
}
```

`report` is **absent** in dry-run mode (no POST happened).

## Examples

### Fix a mistyped duration

```bash
$ freelo reports edit 7001 --minutes 60 --output json
{"schema":"freelo.reports.edit/v1","data":{"report":{"id":7001,"minutes":60},"applied_changes":{"minutes":60}},"rate_limit":{}}
```

### Re-stamp the date_reported (move a report to the right day)

```bash
$ freelo reports edit 7001 --date 2026-04-30
Edited report #7001 (date_reported=2026-04-30).
```

### Empty edit is rejected

```bash
$ freelo reports edit 7001 --output json
{"schema":"freelo.error/v1","error":{"code":"VALIDATION_ERROR","message":"`reports edit` requires at least one of --minutes, --note, or --date.","retryable":false}}
$ echo $?
2
```

### Dry-run

```bash
$ freelo reports edit 7001 --minutes 60 --dry-run --output json
{"schema":"freelo.reports.edit/v1","dry_run":true,"data":{"applied_changes":{"minutes":60},"would":{"method":"POST","path":"/work-reports/7001","body":{"minutes":60}}}}
```

### Batch via NDJSON (e.g. corrections sweep)

```bash
$ cat <<EOF | freelo reports edit --stdin --output ndjson
{"id":7001,"minutes":60}
{"id":7002,"note":"Reclassified as bugfix"}
EOF
{"schema":"freelo.reports.edit/v1","data":{"line_index":0,"applied_changes":{"minutes":60}}}
{"schema":"freelo.reports.edit/v1","data":{"line_index":1,"applied_changes":{"note":"Reclassified as bugfix"}}}
```

### Compose with `reports list`

Find every report logged by mistake on the wrong task and amend in one pipeline:

```bash
$ freelo reports list --task 4567 --from 2026-04-01 --output ndjson \
  | jq -c '{id: .id, minutes: ((.minutes | tonumber) - 5)}' \
  | freelo reports edit --stdin --output ndjson
```

## Errors and exit codes

| Trigger                                             | Code               | Exit |
| --------------------------------------------------- | ------------------ | ---- |
| `<id>` missing / non-positive                       | `VALIDATION_ERROR` | 2    |
| Empty edit (no change flag)                         | `VALIDATION_ERROR` | 2    |
| `--minutes 0` / negative / non-int                  | `VALIDATION_ERROR` | 2    |
| `--date` not `YYYY-MM-DD` / not a real date         | `VALIDATION_ERROR` | 2    |
| Positional `<id>` or change flag set with `--stdin` | `VALIDATION_ERROR` | 2    |
| Auth missing / 401                                  | `AUTH_EXPIRED`     | 3    |
| 404 (NotFoundException — ACL or genuine missing)    | `NOT_FOUND`        | 4    |
| 5xx                                                 | `SERVER_ERROR`     | 4    |
| Network failure                                     | `NETWORK_ERROR`    | 5    |
| 429 (after retry exhaustion)                        | `RATE_LIMITED`     | 6    |

## See also

- [`freelo reports list`](./reports-list.md) — find the report id.
- [`freelo reports log`](./reports-log.md) — create a new report.
- [`freelo reports delete`](./reports-delete.md) — remove a report.

## Required scopes

Standard Freelo API token. Caller must be the report's author **or** the project's owner / commander. Other callers see HTTP 404 (Freelo hides existence; the CLI surfaces it verbatim — your error envelope shows `NOT_FOUND` whether the report doesn't exist or you simply lack rights).
