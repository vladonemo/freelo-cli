# freelo tasklists create

Create a new tasklist in a project, emitting a stable
`freelo.tasklists.create/v1` envelope. First write surface in the
`tasklists` group; reuses the Wave 2 shared write infrastructure
(`--dry-run`).

## Synopsis

```bash
freelo tasklists create --project <id> --name <str> [--budget <str>] [--dry-run]
```

## Options

| Flag                  | Type / values                               | Required | Purpose                                                                                                                                                     |
| --------------------- | ------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--project <id>`      | positive integer                            | yes      | Project id to create the tasklist in.                                                                                                                       |
| `--name <str>`        | non-empty string                            | yes      | Tasklist name. Whitespace-only values exit 2.                                                                                                               |
| `--budget <str>`      | digits-only string                          | no       | Budget in base units (no decimal separator), e.g. `"100000"` for 1000.00 of the project's currency. Stringified to avoid float drift; verbatim passthrough. |
| `--dry-run`           | flag                                        | no       | Skip the POST. The envelope echoes the body that _would_ have gone on the wire, with no rate-limit / request-id meta.                                       |
| `--output <mode>`     | `auto` (default), `human`, `json`, `ndjson` | no       | `auto` resolves to `json` on a non-TTY, `human` otherwise. Inherited global flag.                                                                           |
| `--profile <name>`    | string                                      | no       | Credential profile to use. Inherited global flag.                                                                                                           |
| `--request-id <uuid>` | string                                      | no       | Override the auto-generated request ID.                                                                                                                     |

Validation runs before any HTTP call. Missing `--project`, missing/empty
`--name`, or a `--budget` that isn't digits-only all exit 2 with a clear
message and no network traffic.

## Endpoint called

`POST /project/{project_id}/tasklists`

Request body:

```jsonc
{
  "name": "QA checklist",
  "budget": "100000", // omitted when --budget is not set
}
```

Response shape: `TasklistWithBudget` — `{ id, name, budget? }`.

## Envelope

`schema: "freelo.tasklists.create/v1"`

Live success:

```jsonc
{
  "schema": "freelo.tasklists.create/v1",
  "data": {
    "project_id": 100,
    "tasklist": {
      "id": 9001,
      "name": "QA checklist",
      "budget": { "amount": "100000", "currency": "CZK" },
    },
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-05-09T20:30:00Z" },
  "request_id": "...",
}
```

`--dry-run`:

```jsonc
{
  "schema": "freelo.tasklists.create/v1",
  "dry_run": true,
  "data": {
    "project_id": 100,
    "would": {
      "method": "POST",
      "path": "/project/100/tasklists",
      "body": { "name": "QA checklist" },
    },
  },
}
```

Agents key off `data.tasklist.id` (the new tasklist's id) and `dry_run`
to distinguish live from dry-run envelopes. None of the documented fields
are removed, renamed, or retyped within `v1`; new fields are additive only.

## Examples

### Minimal — human and agent

```bash
$ freelo tasklists create --project 100 --name "QA checklist"
Created tasklist #9001 (QA checklist) in project #100.
```

### With budget

```bash
$ freelo tasklists create --project 100 --name "Sprint 7" --budget 250000
Created tasklist #9002 (Sprint 7) in project #100.
```

### Dry-run

```bash
$ freelo tasklists create --project 100 --name "Test" --budget 100000 --dry-run --output json
{"schema":"freelo.tasklists.create/v1","dry_run":true,"data":{"project_id":100,"would":{"method":"POST","path":"/project/100/tasklists","body":{"name":"Test","budget":"100000"}}}}
```

## Errors and exit codes

| Trigger                                | Exit | Code               | Notes                                              |
| -------------------------------------- | ---- | ------------------ | -------------------------------------------------- |
| Missing `--project` or non-positive id | 2    | `VALIDATION_ERROR` |                                                    |
| Missing or empty `--name`              | 2    | `VALIDATION_ERROR` | `--name is required.` or `--name cannot be empty.` |
| `--budget` not digits-only             | 2    | `VALIDATION_ERROR` | Hint mentions "base units" / "100000 = 1000.00".   |
| HTTP 400                               | 4    | `FREELO_API_ERROR` | Generic server-side validation hint.               |
| HTTP 401                               | 3    | `AUTH_EXPIRED`     | Hint suggests `freelo auth login`.                 |
| HTTP 403                               | 4    | `FORBIDDEN`        | Hint mentions "permission to create tasklists".    |
| HTTP 404                               | 4    | `FREELO_API_ERROR` | Hint mentions project not found / no access.       |
| HTTP 422                               | 4    | `FREELO_API_ERROR` | Server message passed through.                     |
| HTTP 429                               | 6    | `RATE_LIMITED`     | Retryable.                                         |
| HTTP 5xx                               | 4    | `SERVER_ERROR`     | Retryable.                                         |
| Network failure                        | 5    | `NETWORK_ERROR`    |                                                    |

## Required Freelo permissions

Caller must be a project manager or higher. A 403 indicates the account
lacks the necessary role on that project.

## Notes and intentional gaps

- **`--budget` is a verbatim string.** Freelo's wire format is base units
  with no decimal separator — `"100000"` = 1000.00 of the project's
  currency. The CLI does **not** parse or normalize: the string is passed
  through unchanged to avoid float-precision drift. Validate decimals
  client-side before invoking.
- **No `--description` / ACL flags in v1.** `POST /project/{id}/tasklists`
  documents only `name` and `budget`. The flag will be added when Freelo
  adds the field.
- **Create is non-idempotent.** Posting the same body twice creates two
  tasklists. Agents that need at-most-once semantics should track the new
  id from the envelope.

## Related commands

- [`freelo tasklists list`](./tasklists-list.md) — discover existing tasklists.
- [`freelo tasklists show`](./tasklists-show.md) — read one tasklist's detail.
- [`freelo tasklists create-from-template`](./tasklists-create-from-template.md) — copy from a template.
