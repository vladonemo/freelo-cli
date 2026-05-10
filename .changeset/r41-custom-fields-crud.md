---
'freelo-cli': minor
---

feat(commands): `custom-fields create` / `rename` / `delete` / `restore` (R41)

Four new subcommands under the existing `custom-fields` parent — the second
slice of Wave 7 (custom fields, notes, pinned items):

- `freelo custom-fields create --project <id> --name <str> --type <type-uuid> [--uuid <uuid>] [--dry-run]`
  — define a custom field on a project. Single-shot, non-destructive.
  Wire: `POST /custom-field/create/{project_id}`.
- `freelo custom-fields rename <uuid> --name <str> [--dry-run]` — rename a
  custom-field definition. Single-shot, non-destructive. Wire:
  `POST /custom-field/rename/{uuid}` (verb is **POST**, not PATCH — the
  OpenAPI spec is authoritative; same precedent as `labels rename`).
- `freelo custom-fields delete <uuid>... [--ids <list>] [--stdin] [--yes] [--dry-run]`
  — soft-delete one or more custom-field definitions. **Destructive** —
  requires `--yes` (non-TTY) or interactive confirmation (TTY). Idempotent:
  404 → `already_in_target_state: true`, exit 0. Batch via positional /
  `--ids` / `--stdin` (NDJSON). Wire: `DELETE /custom-field/delete/{uuid}`.
- `freelo custom-fields restore <uuid>... [--ids <list>] [--stdin] [--dry-run]`
  — restore one or more soft-deleted custom-field definitions.
  Non-destructive (no `--yes`). Idempotent: 404 → `already_in_target_state:
  true`, exit 0 (the OpenAPI conflates "doesn't exist" with "was never
  soft-deleted"; both map to the active end-state). Live success carries
  the full `custom_field` server response. Wire: `POST /custom-field/restore/{uuid}`.

Schemas added (additive):

- `freelo.custom-fields.create/v1`  — `{ project_id, custom_field?, would? }`.
- `freelo.custom-fields.rename/v1`  — `{ uuid, applied_changes: { name? }, would? }`.
- `freelo.custom-fields.delete/v1`  — `{ uuid, previous_state: null, current_state: 'deleted', already_in_target_state, would?, line_index? }`.
- `freelo.custom-fields.restore/v1` — `{ uuid, previous_state: null, current_state: 'active', already_in_target_state, custom_field?, would?, line_index? }`.

Reuses the established R13 destructive-op primitives (`confirmDestructive`,
`iterateLines` / `parseNdjsonLine` / `ExitCodeAccumulator`, `dryRunEnvelope`,
`Would`) and the R40 wire wrappers / zod schemas / parent registrar.

R42 (value set / clear) and R43 (enum CRUD) round out Wave 7 in later slices.
