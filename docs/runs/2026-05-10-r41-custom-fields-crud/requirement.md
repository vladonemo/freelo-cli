# Requirement — R41 custom-fields CRUD

R41 — `freelo custom-fields create` / `rename` / `delete` / `restore`

From `docs/roadmap.md` (Wave 7):

> **Endpoints:** `POST /custom-field/create/{project_id}`, `PATCH /custom-field/rename/{uuid}`,
> `DELETE /custom-field/delete/{uuid}`, `POST /custom-field/restore/{uuid}`.
> **CLI:** four small commands.
> **Depends on:** R40, R13.

R40 (custom-fields types/list) already shipped on main. Reuse:
- `src/api/custom-fields.ts`
- `src/api/schemas/custom-field.ts`
- `src/commands/custom-fields.ts`
- `test/msw/handlers.ts` `customFieldsTypesHandlers` / `customFieldsListHandlers`

R13 (`tasks delete`) destructive-op pattern:
- `src/lib/confirm.ts`, `src/lib/idempotency.ts`, `src/lib/batch.ts`, `src/lib/dry-run.ts`

## Run config

- Run id: `2026-05-10-r41-custom-fields-crud`
- Budget: defaults (30 min, 40 calls, 8 retries, 25 files)
- allowNetwork: false
- autoShip: false
