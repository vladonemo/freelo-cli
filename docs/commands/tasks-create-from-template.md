# freelo tasks create-from-template

Copy a single task from a project template into a target project,
emitting a stable `freelo.tasks.create-from-template/v1` envelope.

Sibling of [`freelo tasklists create-from-template`](./tasklists-create-from-template.md)
(R34) — same flag family, different endpoint. Use this command when you want
to drop one canonical template task (e.g. "Kickoff checklist", "Bug report")
into a project; use the tasklist variant when you want to clone the whole list.

## Synopsis

```bash
freelo tasks create-from-template <template_id> --source-task <id> [--target-project <id>] [--target-tasklist <id>] [--date-start <YYYY-MM-DD>] [--worker <id>]... [--dry-run]
```

## Arguments and options

| Flag / arg                  | Type / values                               | Required | Purpose                                                                                          |
| --------------------------- | ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `<template_id>`             | positive integer                            | yes      | Source project template id (`state=3`). Find via `freelo projects list --scope templates`.       |
| `--source-task <id>`        | positive integer                            | yes      | Source task id **inside** the template. Maps to wire field `task_id`.                            |
| `--target-project <id>`     | positive integer                            | no       | Existing project to land the copy in. Omit to create a new project (Freelo's default behaviour). |
| `--target-tasklist <id>`    | positive integer                            | no       | Existing tasklist (in the target project) to land the copy in.                                   |
| `--date-start <YYYY-MM-DD>` | ISO-8601 date                               | no       | Anchor for floating template due dates. Maps to `preset_date_from`.                              |
| `--worker <id>`             | positive integer (repeatable)               | no       | Template member user id to invite. Repeat for multiple workers.                                  |
| `--dry-run`                 | flag                                        | no       | Skip the POST. The envelope echoes the body that _would_ have gone on the wire.                  |
| `--output <mode>`           | `auto` (default), `human`, `json`, `ndjson` | no       | `auto` resolves to `json` on a non-TTY, `human` otherwise. Inherited global flag.                |
| `--profile <name>`          | string                                      | no       | Credential profile.                                                                              |
| `--request-id <uuid>`       | string                                      | no       | Override the auto-generated request ID.                                                          |

Note the deliberate path/body ID interleaving: `<template_id>` (path) is
the **source project template**, while `--source-task <id>` (body field
`task_id`) is the **source task inside that template**.

## Endpoint called

`POST /task/create-from-template/{template_id}`

Request body:

```jsonc
{
  "task_id": 7,
  "target_project_id": 100, // optional
  "target_tasklist_id": 200, // optional, only meaningful with target_project_id
  "preset_date_from": "2026-09-01", // optional
  "users_ids": [11, 22], // optional
}
```

Response shape:

```jsonc
{
  "id": 9100,
  "name": "Kickoff checklist",
  "tasklist": {
    "id": 200,
    "name": "Onboarding",
  },
}
```

## Envelope

`schema: "freelo.tasks.create-from-template/v1"`

Live success:

```jsonc
{
  "schema": "freelo.tasks.create-from-template/v1",
  "data": {
    "template_id": 50,
    "task": {
      "id": 9100,
      "name": "Kickoff checklist",
      "tasklist": { "id": 200, "name": "Onboarding" },
    },
  },
  "rate_limit": { "remaining": 39, "reset_at": "2026-05-09T20:30:00Z" },
}
```

`--dry-run`:

```jsonc
{
  "schema": "freelo.tasks.create-from-template/v1",
  "dry_run": true,
  "data": {
    "template_id": 50,
    "would": {
      "method": "POST",
      "path": "/task/create-from-template/50",
      "body": { "task_id": 7 },
    },
  },
}
```

## Examples

### Minimal — copy a template task into a freshly-created project

```bash
$ freelo tasks create-from-template 50 --source-task 7
Created task #9100 (Kickoff checklist) from template #50 (in tasklist #200, "Onboarding").
```

### Copy into an existing project + tasklist, with a date anchor

```bash
$ freelo tasks create-from-template 50 \
    --source-task 7 \
    --target-project 100 \
    --target-tasklist 200 \
    --date-start 2026-09-01 \
    --worker 11 --worker 22
Created task #9101 (Kickoff checklist) from template #50 (in tasklist #200, "Onboarding").
```

### Dry-run

```bash
$ freelo tasks create-from-template 50 --source-task 7 --dry-run --output json
{"schema":"freelo.tasks.create-from-template/v1","dry_run":true,"data":{"template_id":50,"would":{"method":"POST","path":"/task/create-from-template/50","body":{"task_id":7}}}}
```

## Errors and exit codes

| Trigger                                                            | Exit | Code               | Notes                                                    |
| ------------------------------------------------------------------ | ---- | ------------------ | -------------------------------------------------------- |
| Non-positive `<template_id>`                                       | 2    | `VALIDATION_ERROR` |                                                          |
| Missing or non-positive `--source-task`                            | 2    | `VALIDATION_ERROR` |                                                          |
| Bad `--date-start` (format or calendar)                            | 2    | `VALIDATION_ERROR` | Must be `YYYY-MM-DD` and a real calendar date.           |
| Non-positive `--target-project` / `--target-tasklist` / `--worker` | 2    | `VALIDATION_ERROR` |                                                          |
| HTTP 400 mentioning `task_id`                                      | 4    | `FREELO_API_ERROR` | Hint: source task id must be inside the template.        |
| HTTP 400 mentioning `users_ids`                                    | 4    | `FREELO_API_ERROR` | Hint: worker ids must be members of the template.        |
| HTTP 400 mentioning `target_project_id`                            | 4    | `FREELO_API_ERROR` | Hint: target project must be accessible to the caller.   |
| HTTP 400 mentioning `target_tasklist_id`                           | 4    | `FREELO_API_ERROR` | Hint: target tasklist must be inside the target project. |
| HTTP 400 generic                                                   | 4    | `FREELO_API_ERROR` | Generic server-side validation hint.                     |
| HTTP 401                                                           | 3    | `AUTH_EXPIRED`     |                                                          |
| HTTP 403                                                           | 4    | `FORBIDDEN`        | Hint: account lacks permission to use this template.     |
| HTTP 404                                                           | 4    | `FREELO_API_ERROR` | Hint suggests `freelo projects list --scope templates`.  |
| HTTP 422                                                           | 4    | `FREELO_API_ERROR` |                                                          |
| HTTP 429                                                           | 6    | `RATE_LIMITED`     | Retryable.                                               |
| HTTP 5xx                                                           | 4    | `SERVER_ERROR`     | Retryable.                                               |
| Network failure                                                    | 5    | `NETWORK_ERROR`    |                                                          |

## Notes

- `users_ids` (the wire field behind `--worker`) must be a subset of the template's members; the server enforces, the CLI does not.
- `--target-tasklist` is only meaningful with `--target-project`. The CLI does not enforce that combination; the server does.
- `preset_date_from` shifts floating template due-dates relative to this date — same semantics as R31 / R34.
- The endpoint **does not accept a `name` field** — the copy preserves the template's task name. To rename after copy, use `freelo tasks edit <id> --name <str>`.
- If both `--target-project` and `--target-tasklist` are omitted, Freelo creates a new project for the copy (template-driven default behaviour).

## Related commands

- [`freelo tasklists create-from-template`](./tasklists-create-from-template.md) — clone a tasklist (vs. a single task).
- [`freelo projects create-from-template`](./projects-create-from-template.md) — clone an entire project.
- [`freelo tasks create`](./tasks-create.md) — create a brand-new task (no template).
- [`freelo tasks edit`](./tasks-edit.md) — rename / amend a task post-copy.
