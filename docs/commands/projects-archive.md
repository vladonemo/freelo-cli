# freelo projects archive

Archive one or more Freelo projects. Archived projects are hidden from default
listings but remain readable and can be restored via `freelo projects activate`.

Archive is **idempotent on the server**: re-archiving an already-archived
project succeeds with a 200 no-op.

## Synopsis

```bash
freelo projects archive <id>... [--ids "a,b,c"] [--stdin] [--dry-run]
```

## Options

| Flag              | Type / values                               | Required | Purpose                                                                               |
| ----------------- | ------------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `<id>...`         | one or more positive integers (variadic)    | one of   | Project ids passed positionally.                                                      |
| `--ids "a,b,c"`   | comma- or space-separated positive integers | one of   | Same effect as positional, in flag form. Mutex with positional and `--stdin`.         |
| `--stdin`         | flag                                        | one of   | Read NDJSON from stdin (`{"id": <int>}` per line). Mutex with positional and `--ids`. |
| `--dry-run`       | flag                                        | no       | Skip the POST. The envelope echoes the call that would have run.                      |
| `--output <mode>` | `auto` (default), `human`, `json`, `ndjson` | no       | `auto` resolves to `json` on a non-TTY, `human` otherwise.                            |

Validation runs before any HTTP call. Bad ids exit 2 with a clear message.
Combining input sources also exits 2.

## Endpoint called

`POST /project/{id}/archive`

Empty request body. Response is a generic success envelope; the CLI does not
surface the wire body.

## Envelope

`schema: "freelo.projects.archive/v1"`

Live success:

```jsonc
{
  "schema": "freelo.projects.archive/v1",
  "data": {
    "project_id": 9001,
    "current_state": "archived",
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-05-09T20:30:00Z" },
  "request_id": "...",
}
```

Stdin / batch mode adds `line_index` per envelope (0-indexed).

`--dry-run`:

```jsonc
{
  "schema": "freelo.projects.archive/v1",
  "dry_run": true,
  "data": {
    "project_id": 9001,
    "current_state": "archived",
    "would": { "method": "POST", "path": "/project/9001/archive", "body": {} },
  },
}
```

## Examples

### Single project — human and agent

```bash
$ freelo projects archive 9001
Archived project #9001.

$ FREELO_API_KEY=*** FREELO_EMAIL=bot@x \
    freelo projects archive 9001 --output json
{"schema":"freelo.projects.archive/v1","data":{"project_id":9001,"current_state":"archived"},"rate_limit":{...}}
```

### Batch via NDJSON

```bash
$ printf '{"id":9001}\n{"id":9002}\n{"id":9003}\n' | \
    freelo projects archive --stdin --output json
{"schema":"freelo.projects.archive/v1","data":{"project_id":9001,"current_state":"archived","line_index":0},...}
{"schema":"freelo.projects.archive/v1","data":{"project_id":9002,"current_state":"archived","line_index":1},...}
{"schema":"freelo.projects.archive/v1","data":{"project_id":9003,"current_state":"archived","line_index":2},...}
```

## Errors and exit codes

| Trigger                           | Exit | Code               | Notes                                             |
| --------------------------------- | ---- | ------------------ | ------------------------------------------------- |
| Bad `<id>` (non-integer / `<= 0`) | 2    | `VALIDATION_ERROR` | Reported at parse time; no HTTP fired.            |
| Combining input sources           | 2    | `VALIDATION_ERROR` | Pick exactly one of positional/`--ids`/`--stdin`. |
| HTTP 401                          | 3    | `AUTH_EXPIRED`     | Re-authenticate.                                  |
| HTTP 403                          | 4    | `FORBIDDEN`        | Account lacks project-admin permission.           |
| HTTP 404                          | 4    | `NOT_FOUND`        | Project missing or not visible to caller.         |
| HTTP 422                          | 4    | `FREELO_API_ERROR` | Server message passed through.                    |
| HTTP 429                          | 6    | `RATE_LIMITED`     | Retryable.                                        |
| HTTP 5xx                          | 4    | `SERVER_ERROR`     | Retryable.                                        |
| Network failure                   | 5    | `NETWORK_ERROR`    | Connection reset, DNS failure, etc.               |

In multi-id and stdin batch modes, per-id failures emit a `freelo.error/v1`
envelope to stdout (alongside successes) and the run's final exit code is the
**highest** observed exit code.

## Required Freelo permissions

Project-admin (owner / commander). A 403 indicates the account lacks the
necessary role.

## Notes and intentional gaps

- **No GET pre-check.** Archive is server-side-idempotent, so the CLI does not
  fetch state first. As a consequence, the envelope does not include a
  `previous_state` field — call `freelo projects show` first if you need it.
- **Archiving does not stop running timetrackings.** Check timetracking state
  separately (`freelo time status`) if you need to clean those up.

## Related commands

- [`freelo projects activate`](./projects-activate.md) — restore an archived (or deleted) project.
- [`freelo projects delete`](./projects-delete.md) — soft-delete a project.
- [`freelo projects show`](./projects-show.md) — read state and full detail.
