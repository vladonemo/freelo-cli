---
'freelo-cli': minor
---

feat(commands): `custom-fields value set` and `custom-fields value clear` (R42)

Two new subcommands under the `custom-fields` parent — the first writeable
surface for custom fields (Wave 7, second slice):

- `freelo custom-fields value set --task <id> --field <uuid> (--value <str>|--enum <uuid>)`
  — upsert a custom-field value on a task. Dispatches between the scalar
  endpoint (`POST /custom-field/add-or-edit-value`, snake_case body) and the
  enum endpoint (`POST /custom-field/add-or-edit-enum-value`, camelCase body)
  based on the `--value` / `--enum` mutex.
- `freelo custom-fields value clear --task <id> --field <uuid>` — clear a
  value. Destructive; gates on `--yes` (non-TTY) or interactive prompt (TTY).
  Performs a read-then-delete (`GET /task/{task_id}` → resolve `value_uuid`
  → `DELETE /custom-field/delete-value/{uuid}`) because the DELETE endpoint
  identifies values by their value-uuid, not by field-uuid.

Idempotency for `value clear` (two arms):

1. Read-back finds no value for the field → `already_in_target_state: true`,
   no DELETE issued.
2. Read-back finds a value but DELETE returns 404 (race condition) →
   `already_in_target_state: true`.

Both new commands support `--dry-run`. Batch input is via `--stdin` NDJSON
only (each job carries multiple fields, so a positional list doesn't fit).

Schemas added (additive):

- `freelo.custom-fields.value-set/v1` — `{ task_id, field_uuid, kind: 'scalar'|'enum',
  value_uuid, value, previous_value_uuid, would?, line_index? }`.
- `freelo.custom-fields.value-clear/v1` — `{ task_id, field_uuid, value_uuid,
  previous_state: 'set'|'absent', current_state: 'absent', already_in_target_state,
  would?, line_index? }`.

R41 (field create / rename / delete / restore) and R43 (enum CRUD) build on
the same parent in later slices.
