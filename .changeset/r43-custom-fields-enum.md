---
'freelo-cli': minor
---

feat(commands): `custom-fields enum list / add / rename / delete` (R43)

Four new subcommands under a new `custom-fields enum` sub-parent — the third
slice of Wave 7 (enum-option management on enum-typed custom fields):

- `freelo custom-fields enum list --field <uuid>` — list the enum options
  defined on an enum field. Wire: `GET /custom-field-enum/get-for-custom-field/{uuid}`.
- `freelo custom-fields enum add --field <uuid> --value <str>` — add a new
  enum option. Wire: `POST /custom-field-enum/create/{uuid}`.
- `freelo custom-fields enum rename <enum_uuid> --value <str>` — rename
  (relabel) an existing enum option; uuid preserved so existing task values
  keep resolving. Wire: `PATCH /custom-field-enum/change/{uuid}`.
- `freelo custom-fields enum delete <enum_uuid>... [--force] [--yes]` —
  delete one or more enum options. Default refuses if the option is in use
  (returns 400 with a `--force` hint). `--force` switches to
  `DELETE /custom-field-enum/force-delete/{uuid}` which cascades, clearing
  referencing task values. Both endpoints are 404-idempotent (single-arm,
  mirrors `custom-fields delete` from R41). Supports batch via positional /
  `--ids` / `--stdin` NDJSON.

Schemas added (additive):

- `freelo.custom-fields.enum-list/v1` — `{ field_uuid, options: { uuid, value }[] }`.
- `freelo.custom-fields.enum-add/v1` — `{ field_uuid, option: { uuid, value } }`.
- `freelo.custom-fields.enum-rename/v1` — `{ enum_uuid, applied_changes: { value } }`.
- `freelo.custom-fields.enum-delete/v1` — `{ enum_uuid, force, previous_state, current_state, already_in_target_state, line_index?, would? }`.

Closes the third gap in Wave 7. R44 (`notes` + `pins`) is the final slice.
