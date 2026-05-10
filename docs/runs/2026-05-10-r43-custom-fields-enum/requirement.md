# Requirement — R43

`freelo custom-fields enum list` / `add` / `rename` / `delete`

From `docs/roadmap.md` (Wave 7):

> Endpoints: `GET /custom-field-enum/get-for-custom-field/{uuid}`,
> `POST /custom-field-enum/create/{uuid}`,
> `PATCH /custom-field-enum/change/{uuid}`,
> `DELETE /custom-field-enum/delete/{uuid}`,
> `DELETE /custom-field-enum/force-delete/{uuid}`.
>
> CLI:
>
> ```
> freelo custom-fields enum list --field <uuid>
> freelo custom-fields enum add --field <uuid> --value <str>
> freelo custom-fields enum rename <enum_uuid> --value <str>
> freelo custom-fields enum delete <enum_uuid> [--force] [--yes]
> ```
>
> Depends on: R41.

## Run config

- Run id: `2026-05-10-r43-custom-fields-enum`
- Spec number: 0057
- Budget defaults; `allowNetwork: false`; `autoShip: false`
- Branch: `feat/r43-custom-fields-enum` from `main` @ `13a6dc1`.
