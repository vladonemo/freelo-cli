# freelo custom-fields value clear

**Clear** a custom-field value on a task. Destructive — gates on the standard
confirmation policy (`--yes` for non-TTY, interactive prompt for TTY).

The DELETE endpoint takes a **value-uuid**, not a field-uuid, so this command
performs **read-then-delete**:

1. `GET /task/{task_id}` → look up `custom_fields[].field_uuid === <field>`
   to recover the `value_uuid`.
2. If no entry / no `value_uuid` → idempotent skip
   (`already_in_target_state: true`, no DELETE issued).
3. Otherwise `DELETE /custom-field/delete-value/{value_uuid}`. On 404 (race
   condition) → idempotent skip.

## Synopsis

```bash
freelo custom-fields value clear --task <id> --field <uuid> [--yes] [--dry-run]
freelo custom-fields value clear --stdin [--yes] [--dry-run]   # NDJSON batch
```

## Options

| Flag             | Type / values | Default | Purpose                                                                |
| ---------------- | ------------- | ------- | ---------------------------------------------------------------------- |
| `--task <id>`    | positive int  | —       | Task id (numeric). Required when not using `--stdin`.                  |
| `--field <uuid>` | string        | —       | Custom-field uuid. Discover via `freelo custom-fields list --project`. |
| `--stdin`        | flag          | off     | Read NDJSON jobs from stdin. Mutex with the flag-driven inputs.        |
| `--dry-run`      | flag          | off     | Skip both the read-back and the DELETE; envelope carries `would`.      |
| `--yes`          | flag (root)   | off     | Bypass interactive confirmation (required in non-TTY mode).            |

## Wire mapping

Read-back: `GET /task/{task_id}` → `TaskDetail` with `custom_fields[]` of
`CustomFieldWithValue` (yaml :6135-6166). The CLI re-validates just the
`custom_fields[]` slice locally to recover the `(field_uuid → value_uuid)`
mapping.

Delete: `DELETE /custom-field/delete-value/{uuid}` (yaml :4296-4324). 200 →
success. 404 → idempotent skip.

## Envelope

`schema: freelo.custom-fields.value-clear/v1`

| Field                     | Type                            | Notes                                                               |
| ------------------------- | ------------------------------- | ------------------------------------------------------------------- |
| `task_id`                 | int                             | Echo of `--task`.                                                   |
| `field_uuid`              | string                          | Echo of `--field`.                                                  |
| `value_uuid`              | string \| null                  | The deleted record's uuid. `null` when read-back found nothing.     |
| `previous_state`          | `'set' \| 'absent'`             | `'absent'` only when read-back found nothing.                       |
| `current_state`           | `'absent'`                      | Always `'absent'` on success.                                       |
| `already_in_target_state` | bool                            | `true` for either idempotent arm.                                   |
| `would`                   | object — `{method, path, body}` | Present **only** on `--dry-run`. `path` carries a placeholder uuid. |
| `line_index`              | int                             | Present **only** on `--stdin` batch.                                |

## Idempotency (two arms)

| Trigger                                                         | `already_in_target_state` | exit |
| --------------------------------------------------------------- | ------------------------- | ---- |
| Read-back returned no `custom_fields[]` entry for the field.    | `true`                    | 0    |
| Read-back returned an entry but its `value_uuid` is null/empty. | `true`                    | 0    |
| Read-back found a `value_uuid`; DELETE returned 404.            | `true`                    | 0    |
| Read-back found a `value_uuid`; DELETE returned 200.            | `false`                   | 0    |

The first two arms issue **only** the read-back call (no DELETE). The third
arm issues both (DELETE returns 404 from a race condition).

## Validation

| Input                                | Behaviour                                             |
| ------------------------------------ | ----------------------------------------------------- |
| Missing `--task`                     | `ValidationError` exit 2.                             |
| Missing `--field`                    | `ValidationError` exit 2.                             |
| `--task 0`, `--task -1`, non-numeric | `ValidationError` exit 2.                             |
| `--field "   "` (whitespace only)    | `ValidationError` exit 2.                             |
| Flag input + `--stdin`               | `ValidationError` exit 2 (mutex).                     |
| Non-TTY without `--yes`              | `ConfirmationError` exit 2 (`CONFIRMATION_REQUIRED`). |

## HTTP error mapping

| Status (origin)              | Exit | Hint                                                      |
| ---------------------------- | ---- | --------------------------------------------------------- |
| `404` (read-back; task gone) | 4    | "Task not found. Verify --task; run `freelo tasks list`." |
| `403` (read-back)            | 4    | "Account cannot read this task — read-back required."     |
| `401` (any)                  | 3    | AUTH_EXPIRED — re-auth required.                          |
| `403` (DELETE)               | 4    | "Account cannot edit custom-field values on this task."   |
| `404` (DELETE)               | 0    | Idempotent skip — `already_in_target_state: true`.        |
| `429` RATE_LIMITED           | 6    | retryable; honour `Retry-After`.                          |
| `5xx`                        | 4    | server error; transient.                                  |
| Network failure              | 5    | NETWORK_ERROR.                                            |

## Batch input via `--stdin` (NDJSON)

```jsonc
{ "task_id": 123, "field_uuid": "..." }
{ "task_id": 124, "field_uuid": "..." }
```

The `--yes` confirmation gate fires once for the whole batch. Per-line errors
emit `freelo.error/v1` envelopes with `line_index` (and `task_id` when known).
Exit code is the **highest** observed across the batch.

## Examples

```bash
# Single clear:
$ freelo custom-fields value clear --task 7 --field 11111111-... --yes --output json
{"schema":"freelo.custom-fields.value-clear/v1","data":{...,"already_in_target_state":false}}

# Idempotent — nothing was set:
$ freelo custom-fields value clear --task 7 --field 99999999-... --yes --output json
{"schema":"freelo.custom-fields.value-clear/v1","data":{"task_id":7,"field_uuid":"...","value_uuid":null,"previous_state":"absent","current_state":"absent","already_in_target_state":true}}

# Dry-run (no wire calls at all):
$ freelo custom-fields value clear --task 7 --field 11111111-... --dry-run --output json
{"schema":"freelo.custom-fields.value-clear/v1","data":{...,"would":{"method":"DELETE","path":"/custom-field/delete-value/<would-be-resolved-from-task>",...}},"dry_run":true}

# Batch via NDJSON:
$ printf '{"task_id":7,"field_uuid":"..."}\n{"task_id":8,"field_uuid":"..."}\n' \
    | freelo custom-fields value clear --stdin --yes --output json

# Human mode:
$ freelo custom-fields value clear --task 7 --field 11111111-...
Cleared value on task #7, field 11111111….
```

## Note on the read-back

Each `value clear` invocation issues an **extra** `GET /task/{task_id}`
because the DELETE endpoint identifies values by their value-uuid (not by
field-uuid). This is the only documented way to resolve the `(task,
field) → value-uuid` mapping. Callers that already have a value-uuid in
hand (e.g. from a previous `freelo tasks show <id>`) should — in the
future — be able to call the underlying API directly; right now the CLI
always performs the read-back.

## Required Freelo permissions

- Read access on the task (for the read-back).
- Write access on the task's project (for the DELETE).
- 403 on either side surfaces with a distinct hint so callers can tell
  which step rejected the call.

## Related commands

- `freelo custom-fields value set` — upsert a value (pair to this command).
- `freelo custom-fields list --project <id>` — discover field uuids.
- `freelo tasks show <id>` — see current values on a task (`custom_fields[]`).
