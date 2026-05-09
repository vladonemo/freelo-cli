# freelo projects delete

Soft-delete one or more Freelo projects. Deleted projects disappear from all
listings but their data is retained in the database; restore via
[`freelo projects activate`](./projects-activate.md).

Destructive — requires `--yes` (in non-TTY mode) or interactive confirmation
(in TTY mode). Reusing an already-deleted id is **idempotent**: a 404 from the
DELETE endpoint is reported as success with `already_in_target_state: true`.

## Synopsis

```bash
freelo projects delete <id>... [--ids "a,b,c"] [--stdin] [--yes] [--dry-run]
```

## Options

| Flag              | Type / values                               | Required | Purpose                                                                                                                  |
| ----------------- | ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `<id>...`         | one or more positive integers (variadic)    | one of   | Project ids passed positionally.                                                                                         |
| `--ids "a,b,c"`   | comma- or space-separated positive integers | one of   | Same effect as positional, in flag form. Mutex with positional and `--stdin`.                                            |
| `--stdin`         | flag                                        | one of   | Read NDJSON from stdin (`{"id": <int>}` per line). Mutex with positional and `--ids`.                                    |
| `--yes` / `-y`    | flag (global)                               | no       | Bypass the confirmation prompt. Required in non-TTY mode for the command to proceed.                                     |
| `--dry-run`       | flag                                        | no       | Skip the DELETE. The envelope echoes the call that would have run. Confirmation is also skipped (no destructive effect). |
| `--output <mode>` | `auto` (default), `human`, `json`, `ndjson` | no       | `auto` resolves to `json` on a non-TTY, `human` otherwise.                                                               |

## Confirmation policy

- `--yes` → unconditional proceed.
- `--dry-run` → unconditional proceed (no destructive effect).
- TTY without `--yes` → one prompt for the whole run:

  > Delete N project(s)? This is a soft-delete; restore via 'freelo projects activate'.

  User declines → exit 2 (`CONFIRMATION_REQUIRED`), no wire calls.

- Non-TTY without `--yes` → exit 2 (`CONFIRMATION_REQUIRED`) immediately, no
  wire calls. Never prompts when stdin is piped or absent.

## Endpoint called

`DELETE /project/{id}`

No request body. Response is a generic success envelope.

## Envelope

`schema: "freelo.projects.delete/v1"`

Live success:

```jsonc
{
  "schema": "freelo.projects.delete/v1",
  "data": {
    "project_id": 9001,
    "current_state": "deleted",
    "already_in_target_state": false,
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-05-09T20:30:00Z" },
}
```

Idempotent re-delete (404 from server):

```jsonc
{
  "schema": "freelo.projects.delete/v1",
  "data": {
    "project_id": 9001,
    "current_state": "deleted",
    "already_in_target_state": true,
  },
}
```

`--dry-run`:

```jsonc
{
  "schema": "freelo.projects.delete/v1",
  "dry_run": true,
  "data": {
    "project_id": 9001,
    "current_state": "deleted",
    "already_in_target_state": false,
    "would": { "method": "DELETE", "path": "/project/9001", "body": {} },
  },
}
```

## Examples

### Single project (TTY, prompt confirms)

```bash
$ freelo projects delete 9001
? Delete 1 project? This is a soft-delete; restore via 'freelo projects activate'. (y/N)
Deleted project #9001.
```

### Agent style — bypass prompt with `--yes`

```bash
$ FREELO_API_KEY=*** FREELO_EMAIL=bot@x \
    freelo projects delete 9001 --yes --output json
{"schema":"freelo.projects.delete/v1","data":{"project_id":9001,"current_state":"deleted","already_in_target_state":false},...}
```

### Batch via NDJSON

```bash
$ printf '{"id":9001}\n{"id":9002}\n' | \
    freelo projects delete --stdin --yes --output json
{"schema":"freelo.projects.delete/v1","data":{"project_id":9001,...,"line_index":0},...}
{"schema":"freelo.projects.delete/v1","data":{"project_id":9002,...,"line_index":1},...}
```

### Dry-run

```bash
$ freelo projects delete 9001 --dry-run --output json
{"schema":"freelo.projects.delete/v1","dry_run":true,"data":{"project_id":9001,"current_state":"deleted","already_in_target_state":false,"would":{"method":"DELETE","path":"/project/9001","body":{}}}}
```

## Errors and exit codes

| Trigger                           | Exit | Code                    | Notes                                                    |
| --------------------------------- | ---- | ----------------------- | -------------------------------------------------------- |
| Bad `<id>` (non-integer / `<= 0`) | 2    | `VALIDATION_ERROR`      | Reported at parse time.                                  |
| Combining input sources           | 2    | `VALIDATION_ERROR`      | Pick exactly one of positional/`--ids`/`--stdin`.        |
| Non-TTY without `--yes`           | 2    | `CONFIRMATION_REQUIRED` | Pass `--yes` or run from a TTY.                          |
| TTY user declines prompt          | 2    | `CONFIRMATION_REQUIRED` | No wire calls fired.                                     |
| HTTP 401                          | 3    | `AUTH_EXPIRED`          | Re-authenticate.                                         |
| HTTP 403                          | 4    | `FORBIDDEN`             | Account lacks project-admin permission.                  |
| HTTP 404                          | 0    | (re-classified)         | Treated as success-with-`already_in_target_state: true`. |
| HTTP 422                          | 4    | `FREELO_API_ERROR`      | Server message passed through.                           |
| HTTP 429                          | 6    | `RATE_LIMITED`          | Retryable.                                               |
| HTTP 5xx                          | 4    | `SERVER_ERROR`          | Retryable.                                               |
| Network failure                   | 5    | `NETWORK_ERROR`         | Connection reset, DNS failure, etc.                      |

In multi-id and stdin batch modes, per-id failures emit a `freelo.error/v1`
envelope to stdout and the run's final exit code is the **highest** observed
exit code.

## Required Freelo permissions

Project-admin (usually owner / commander).

## Notes and intentional gaps

- **Soft-delete is reversible.** `freelo projects activate <id>` restores the
  project. The confirmation prompt mentions this so users understand the
  blast radius.
- **No GET pre-check.** The DELETE response is the source of truth; a 404 is
  treated as idempotent already-deleted.
- **Server-side cascade.** Per the Freelo OpenAPI, deleting a project may
  cascade to tasklists/tasks and may stop running timetrackings server-side;
  webhooks fire. The CLI does not pre-stop trackers or pre-finish tasks.

## Related commands

- [`freelo projects activate`](./projects-activate.md) — undelete a soft-deleted project.
- [`freelo projects archive`](./projects-archive.md) — non-destructive way to retire a project.
- [`freelo projects show`](./projects-show.md) — read project state.
