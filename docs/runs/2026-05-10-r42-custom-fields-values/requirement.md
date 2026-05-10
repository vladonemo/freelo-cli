# R42 — custom-fields value set / value clear

Wave 7 second slice. Three endpoints:

- `POST /custom-field/add-or-edit-value` — body `{ task_id, custom_field_uuid, value }` for text/number fields.
- `POST /custom-field/add-or-edit-enum-value` — body `{ task_id, customFieldUuid, value }` (camelCase!) for enum fields, value = enum-option uuid.
- `DELETE /custom-field/delete-value/{uuid}` — value-uuid (NOT field-uuid).

CLI:

```
freelo custom-fields value set --task <id> --field <uuid> (--value <str>|--enum <uuid>)
freelo custom-fields value clear --task <id> --field <uuid>
```

Depends on R40 (already merged on main as PR #99).
Branched from main, NOT from R41's open branch (Calibration #6).

Output schemas:
- `freelo.custom-fields.value-set/v1`
- `freelo.custom-fields.value-clear/v1`

Notes for `value clear`: DELETE takes value-uuid, but the CLI surface takes (task, field). Read-then-delete via `GET /task/{task_id}` → `custom_fields[].field_uuid === <field>` → `value_uuid` → DELETE.
