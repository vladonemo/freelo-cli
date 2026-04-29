# freelo reports delete

Remove one or more **work reports** (R22). Destructive — gates every wire call behind a confirmation step (TTY prompt or `--yes` bypass), and uses a four-arm idempotency heuristic so second-deletes don't fail noisily.

> Maps to `DELETE /work-reports/{id}` (yaml :3144-3171). Empty body. The OpenAPI doesn't document second-delete behavior; the CLI heuristic infers idempotent skip from response shape — see [Idempotency](#idempotency).

> The confirmation policy is identical to [`freelo tasks delete`](./tasks-delete.md). See that page for the full decision matrix.

## Synopsis

```bash
freelo reports delete <id>...   [--yes] [--dry-run]
freelo reports delete --ids "1,2,3"   [--yes] [--dry-run]
freelo reports delete --stdin   [--yes] [--dry-run]
# Per-line NDJSON: {"id": <report_id>}
```

Three input shapes:

- **Positional** — `freelo reports delete 7001 7002 7003 --yes`
- **`--ids`** — `freelo reports delete --ids "7001,7002,7003" --yes`
- **`--stdin`** (NDJSON) — pipe `{"id": <id>}` rows in

## Options

| Flag           | Type             | Default | Purpose                                                                                                                 |
| -------------- | ---------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `<id>...`      | positive integer | —       | One or more numeric report ids. Mutex with `--ids` and `--stdin`.                                                       |
| `--ids <list>` | string           | unset   | Comma- or space-separated list. Mutex with positional and `--stdin`.                                                    |
| `--stdin`      | boolean          | false   | Read NDJSON from stdin, one `{"id": <int>}` per line. Mutex with positional and `--ids`.                                |
| `--dry-run`    | boolean          | false   | Skip the DELETE and the confirmation prompt. Envelope echoes the path that would have been called.                      |
| `-y, --yes`    | boolean (global) | false   | Bypass confirmation. **Required** in non-TTY mode (otherwise the run fails closed with `CONFIRMATION_REQUIRED` exit 2). |

`--output`, `--color`, `--profile`, `-v/-vv`, `--request-id` are inherited global flags.

## Confirmation policy

The shared `confirmDestructive` helper (`src/lib/confirm.ts`) gates every destructive command. R22 reuses it byte-for-byte:

| Mode                            | `--yes`? | `--dry-run`? | Behaviour                                                                                           |
| ------------------------------- | -------- | ------------ | --------------------------------------------------------------------------------------------------- |
| Any                             | yes      | —            | Bypass; proceed silently to the DELETE.                                                             |
| Any                             | —        | yes          | Bypass; emit dry-run envelope; **no DELETE happens**.                                               |
| TTY (interactive shell)         | no       | no           | Prompt: `Delete N report(s)? (y/N)`. Default is **no**. Decline → `CONFIRMATION_REQUIRED` (exit 2). |
| **Non-TTY** (pipe / agent / CI) | no       | no           | Throw `CONFIRMATION_REQUIRED` (exit 2) **before any wire call**. Never hangs waiting on stdin.      |

Confirmation is **per-run, not per-id** — one prompt for the whole batch.

## Idempotency

A second-delete on a report that was already gone is **not** an error in this CLI. The four-arm heuristic (spec 0034 decision 02):

| Wire response                                                    | CLI behavior                               | Exit |
| ---------------------------------------------------------------- | ------------------------------------------ | ---- |
| **Arm 1**: HTTP 404                                              | `already_in_target_state: true`            | 0    |
| **Arm 2**: HTTP 400, body matches `/not found\|does not exist/i` | `already_in_target_state: true`            | 0    |
| **Arm 3**: HTTP 400, body contains `UserCannotDeleteWorkReport`  | hard `FREELO_API_ERROR` (ACL — observable) | 4    |
| **Arm 4**: any other non-2xx                                     | hard `FreeloApiError`                      | 4    |

The body-text match (arm 2) is best-effort; if Freelo changes the message text, the heuristic falls through to arm 4 (hard error) and the slice will need a fixture update. Arms 1 and 3 are documented in the OpenAPI / Freelo response patterns and stable.

## Output schema

`schema: "freelo.reports.delete/v1"` — additive, `/v1`. Mirrors `freelo.tasks.delete/v1` modulo the field rename `task_id` → `report_id`.

Live success:

```json
{
  "schema": "freelo.reports.delete/v1",
  "data": {
    "report_id": 7001,
    "previous_state": null,
    "current_state": "deleted",
    "already_in_target_state": false
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-04-29T20:30:00Z" },
  "request_id": "..."
}
```

Idempotent skip (DELETE returned 404 — report was already gone):

```json
{
  "schema": "freelo.reports.delete/v1",
  "data": {
    "report_id": 7001,
    "previous_state": null,
    "current_state": "deleted",
    "already_in_target_state": true
  }
}
```

Dry-run (no DELETE happens):

```json
{
  "schema": "freelo.reports.delete/v1",
  "dry_run": true,
  "data": {
    "report_id": 7001,
    "previous_state": null,
    "current_state": "deleted",
    "already_in_target_state": false,
    "would": { "method": "DELETE", "path": "/work-reports/7001", "body": {} }
  }
}
```

In **batch mode** (`--stdin`), each envelope carries an additional `data.line_index` field (0-indexed across non-empty input lines). Single, positional-multi, and `--ids` envelopes do **not** carry `line_index`.

## Examples

### Single report

```bash
$ freelo reports delete 7001 --yes
Deleted report #7001.
```

### Multiple via positional

```bash
$ freelo reports delete 7001 7002 7003 --yes --output ndjson
{"schema":"freelo.reports.delete/v1","data":{"report_id":7001,"current_state":"deleted","already_in_target_state":false}}
{"schema":"freelo.reports.delete/v1","data":{"report_id":7002,"current_state":"deleted","already_in_target_state":false}}
{"schema":"freelo.reports.delete/v1","data":{"report_id":7003,"current_state":"deleted","already_in_target_state":false}}
```

### Dry-run

```bash
$ freelo reports delete 7001 --dry-run --output json
{"schema":"freelo.reports.delete/v1","dry_run":true,"data":{"report_id":7001,"previous_state":null,"current_state":"deleted","already_in_target_state":false,"would":{"method":"DELETE","path":"/work-reports/7001","body":{}}}}
$ echo $?
0
```

### Batch via NDJSON

```bash
$ cat <<EOF | freelo reports delete --stdin --yes --output ndjson
{"id": 7001}
{"id": 7002}
{"id": 99999}
EOF
{"schema":"freelo.reports.delete/v1","data":{"report_id":7001,"already_in_target_state":false,"line_index":0}}
{"schema":"freelo.reports.delete/v1","data":{"report_id":7002,"already_in_target_state":false,"line_index":1}}
{"schema":"freelo.reports.delete/v1","data":{"report_id":99999,"already_in_target_state":true,"line_index":2}}
$ echo $?
0
```

(99999 didn't exist — the 404 was idempotent-skipped.)

### Non-TTY without `--yes` (agent failure mode)

```bash
$ echo '{"id": 7001}' | freelo reports delete --stdin --output json
{"schema":"freelo.error/v1","error":{"code":"CONFIRMATION_REQUIRED","message":"Delete 1 report? Refusing in non-interactive mode without --yes.","retryable":false,"hint_next":"Pass --yes to bypass the prompt, or run from a TTY."}}
$ echo $?
2
```

### Compose with `reports list`

Delete every report on a specific task in a date range:

```bash
$ freelo reports list --task 4567 --from 2026-04-01 --to 2026-04-30 --output ndjson \
  | jq -c '{id: .id}' \
  | freelo reports delete --stdin --yes --output ndjson
```

## Errors and exit codes

| Trigger                                            | Code                    | Exit |
| -------------------------------------------------- | ----------------------- | ---- |
| `<id>` not a positive integer                      | `VALIDATION_ERROR`      | 2    |
| `--ids` empty / no source supplied                 | `VALIDATION_ERROR`      | 2    |
| Combining input sources                            | `VALIDATION_ERROR`      | 2    |
| NDJSON line not valid JSON or extra fields         | `VALIDATION_ERROR`      | 2    |
| Non-TTY without `--yes` (no `--dry-run`)           | `CONFIRMATION_REQUIRED` | 2    |
| TTY user declines the prompt                       | `CONFIRMATION_REQUIRED` | 2    |
| DELETE 401                                         | `AUTH_EXPIRED`          | 3    |
| DELETE 403                                         | `FORBIDDEN`             | 4    |
| DELETE 404 (any body)                              | (success, idempotent)   | 0    |
| DELETE 400 with "not found" / "does not exist"     | (success, idempotent)   | 0    |
| DELETE 400 with `UserCannotDeleteWorkReport` (ACL) | `FREELO_API_ERROR`      | 4    |
| DELETE 5xx / other 4xx                             | `SERVER_ERROR`          | 4    |
| HTTP 429                                           | `RATE_LIMITED`          | 6    |
| Network failure                                    | `NETWORK_ERROR`         | 5    |

In batch mode, per-row failures emit `freelo.error/v1` envelopes on stdout and the run-level exit is `max(per-row exit codes)`.

## Non-goals

- **No "trash" listing or restore.** Freelo's UI handles restore; out of scope for the CLI.
- **No per-id confirmation prompt** in batch mode. One prompt per run is the contract.
- **No `--cascade`** flag. The endpoint already removes the report cleanly; there's nothing to cascade.

## See also

- [`freelo reports list`](./reports-list.md) — find the report id.
- [`freelo reports log`](./reports-log.md) — create a new report.
- [`freelo reports edit`](./reports-edit.md) — amend a report.
- [`freelo tasks delete`](./tasks-delete.md) — same confirmation policy and `--ids` / `--stdin` shape.

See [spec 0034](../specs/0034-r22-reports-write.md) for the design rationale, the four-arm idempotency decision, and the full mandatory-test list.
