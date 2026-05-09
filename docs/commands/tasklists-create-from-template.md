# freelo tasklists create-from-template

Copy a tasklist from a project template into a target project (or a new
one), emitting a stable `freelo.tasklists.create-from-template/v1`
envelope.

## Synopsis

```bash
freelo tasklists create-from-template <template_id> --source-tasklist <id> [--target-project <id>] [--target-tasklist <id>] [--date-start <YYYY-MM-DD>] [--worker <id>]... [--dry-run]
```

## Arguments and options

| Flag / arg                  | Type / values                               | Required | Purpose                                                                                          |
| --------------------------- | ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `<template_id>`             | positive integer                            | yes      | Source project template id (`state=3`). Find via `freelo projects list --scope templates`.       |
| `--source-tasklist <id>`    | positive integer                            | yes      | Source tasklist id **inside** the template. Maps to wire field `tasklist_id`.                    |
| `--target-project <id>`     | positive integer                            | no       | Existing project to copy into. Omit to create a new project.                                     |
| `--target-tasklist <id>`    | positive integer                            | no       | Existing tasklist (in the target project) to copy tasks into instead of creating a new tasklist. |
| `--date-start <YYYY-MM-DD>` | ISO-8601 date                               | no       | Anchor for floating template due dates. Maps to `preset_date_from`.                              |
| `--worker <id>`             | positive integer (repeatable)               | no       | User id to invite from the template's member list. Repeat for multiple workers.                  |
| `--dry-run`                 | flag                                        | no       | Skip the POST. The envelope echoes the body that _would_ have gone on the wire.                  |
| `--output <mode>`           | `auto` (default), `human`, `json`, `ndjson` | no       | `auto` resolves to `json` on a non-TTY, `human` otherwise. Inherited global flag.                |
| `--profile <name>`          | string                                      | no       | Credential profile.                                                                              |
| `--request-id <uuid>`       | string                                      | no       | Override the auto-generated request ID.                                                          |

Note the deliberate path/body ID interleaving: `<template_id>` (path) is
the **source project template**, while `--source-tasklist <id>` (body
field `tasklist_id`) is the **source tasklist inside that template**.

## Endpoint called

`POST /tasklist/create-from-template/{template_id}`

Request body:

```jsonc
{
  "tasklist_id": 7,
  "target_project_id": 100, // optional
  "target_tasklist_id": 200, // optional, only meaningful with target_project_id
  "preset_date_from": "2026-09-01", // optional
  "users_ids": [11, 22], // optional
}
```

Response shape:

```jsonc
{
  "id": 9002,
  "name": "QA checklist",
  "tasks": [{ "id": 100, "name": "Smoke test" }],
}
```

## Envelope

`schema: "freelo.tasklists.create-from-template/v1"`

Live success:

```jsonc
{
  "schema": "freelo.tasklists.create-from-template/v1",
  "data": {
    "template_id": 50,
    "tasklist": {
      "id": 9002,
      "name": "QA checklist",
      "tasks": [{ "id": 100, "name": "Smoke test" }],
    },
  },
  "rate_limit": { "remaining": 39, "reset_at": "2026-05-09T20:30:00Z" },
}
```

`--dry-run`:

```jsonc
{
  "schema": "freelo.tasklists.create-from-template/v1",
  "dry_run": true,
  "data": {
    "template_id": 50,
    "would": {
      "method": "POST",
      "path": "/tasklist/create-from-template/50",
      "body": { "tasklist_id": 7 },
    },
  },
}
```

## Examples

### Minimal — copy a tasklist into a freshly-created project

```bash
$ freelo tasklists create-from-template 50 --source-tasklist 7
Created tasklist #9002 (QA checklist) from template #50.
```

### Copy into an existing project, with date anchor and workers

```bash
$ freelo tasklists create-from-template 50 \
    --source-tasklist 7 \
    --target-project 100 \
    --date-start 2026-09-01 \
    --worker 11 --worker 22
Created tasklist #9003 (QA checklist) from template #50.
```

### Dry-run

```bash
$ freelo tasklists create-from-template 50 --source-tasklist 7 --dry-run --output json
{"schema":"freelo.tasklists.create-from-template/v1","dry_run":true,"data":{"template_id":50,"would":{"method":"POST","path":"/tasklist/create-from-template/50","body":{"tasklist_id":7}}}}
```

## Errors and exit codes

| Trigger                                     | Exit | Code               | Notes                                                   |
| ------------------------------------------- | ---- | ------------------ | ------------------------------------------------------- |
| Non-positive `<template_id>`                | 2    | `VALIDATION_ERROR` |                                                         |
| Missing or non-positive `--source-tasklist` | 2    | `VALIDATION_ERROR` |                                                         |
| Bad `--date-start` (format or calendar)     | 2    | `VALIDATION_ERROR` | Must be `YYYY-MM-DD` and a real calendar date.          |
| Non-positive `--worker`                     | 2    | `VALIDATION_ERROR` |                                                         |
| HTTP 400 mentioning `users_ids`             | 4    | `FREELO_API_ERROR` | Hint mentions "members of the template".                |
| HTTP 400 mentioning `target_project_id`     | 4    | `FREELO_API_ERROR` | Hint mentions target-project-not-accessible.            |
| HTTP 400 generic                            | 4    | `FREELO_API_ERROR` | Generic server-side validation hint.                    |
| HTTP 401                                    | 3    | `AUTH_EXPIRED`     |                                                         |
| HTTP 403                                    | 4    | `FORBIDDEN`        | Hint mentions "permission to use this template".        |
| HTTP 404                                    | 4    | `FREELO_API_ERROR` | Hint suggests `freelo projects list --scope templates`. |
| HTTP 422                                    | 4    | `FREELO_API_ERROR` |                                                         |
| HTTP 429                                    | 6    | `RATE_LIMITED`     | Retryable.                                              |
| HTTP 5xx                                    | 4    | `SERVER_ERROR`     | Retryable.                                              |
| Network failure                             | 5    | `NETWORK_ERROR`    |                                                         |

## Notes

- `users_ids` (the wire field behind `--worker`) must be a subset of the
  template's members; the server enforces, the CLI does not.
- `--target-tasklist` is meaningful only with `--target-project`. The CLI
  does not enforce that combination; the server does.
- `preset_date_from` shifts floating due-dates relative to this date —
  same semantics as R31's `--date-start` for `freelo projects create-from-template`.

## Related commands

- [`freelo tasklists create`](./tasklists-create.md) — vanilla create (no template).
- [`freelo projects create-from-template`](./projects-create-from-template.md) — clone an entire project.
