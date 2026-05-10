---
'freelo-cli': minor
---

feat(commands): `custom-fields types` and `custom-fields list` (R40)

Two new read-only subcommands under a new top-level `custom-fields` parent
— the first slice of Wave 7 (custom fields, notes, pinned items):

- `freelo custom-fields types` — list the server-curated catalog of
  custom-field type definitions (`text`, `number`, `enum`). Wire:
  `GET /custom-field/get-types`.
- `freelo custom-fields list --project <id>` — list all custom-field
  definitions configured on a project, plus an `is_commander` boolean
  signalling whether the caller can call the R41+ mutation endpoints
  on that project. Wire: `GET /custom-field/find-by-project/{project_id}`.

Both leaves are pure GETs with no `--dry-run`, no `--yes`, no destructive
behaviour.

Schemas added (additive):

- `freelo.custom-fields.types/v1` — `{ types: { uuid, name }[] }`.
- `freelo.custom-fields.list/v1` — `{ project_id, custom_fields[], is_commander }`.

R41 (create / rename / delete / restore), R42 (value set / clear), and R43
(enum CRUD) build on this parent in later slices.
