# freelo custom-fields rename

Change the **display name** of an existing custom-field definition. The
field's UUID and type are immutable via this endpoint — only `name` mutates.

## Synopsis

```bash
freelo custom-fields rename <uuid> --name <str> [--dry-run]
```

Single-shot, non-destructive. No `--yes`, no batch input. Supports
`--dry-run`.

## Options

| Flag           | Type / values | Default | Purpose                                                                        |
| -------------- | ------------- | ------- | ------------------------------------------------------------------------------ |
| `<uuid>`       | UUID          | —       | Custom-field uuid from `freelo custom-fields list --project <id>`. Positional. |
| `--name <str>` | string        | —       | New display name. Required, non-empty after trim.                              |
| `--dry-run`    | flag          | off     | Skip the POST; envelope echoes the body that would have been sent.             |

## Wire mapping

`POST /custom-field/rename/{uuid}` (yaml :4097-4136).

> **Verb is POST**, not PATCH. The roadmap entry says PATCH but the OpenAPI
> says POST and the OpenAPI is authoritative. Same precedent as
> `freelo labels rename` (R23 spec 0035).

Request body:

```jsonc
{ "name": "New name" }
 // required
```

Response (200): `{ "custom_field": { ... } }`.

## Envelope

`schema: freelo.custom-fields.rename/v1`

| Field             | Type                | Live | Dry-run | Notes                                          |
| ----------------- | ------------------- | ---- | ------- | ---------------------------------------------- |
| `uuid`            | string              | yes  | yes     | Echo of positional `<uuid>`.                   |
| `applied_changes` | `{ name?: string }` | yes  | yes     | The change applied (or that would be applied). |
| `would`           | `Would`             | —    | yes     | Method/path/body that would be sent.           |

## Validation

| Input                    | Behaviour                              |
| ------------------------ | -------------------------------------- |
| Malformed `<uuid>`       | `ValidationError` exit 2 (UUID regex). |
| Missing `--name`         | `ValidationError` exit 2.              |
| Whitespace-only `--name` | `ValidationError` exit 2.              |

## HTTP error mapping

| Status             | Exit | Hint                                                                                |
| ------------------ | ---- | ----------------------------------------------------------------------------------- |
| `400` generic      | 4    | "Server-side validation rejected the request; review the message."                  |
| `401` AUTH_EXPIRED | 3    | (top-level handler)                                                                 |
| `403`              | 4    | "Account is not a project commander of the field's project."                        |
| `404`              | 4    | "Custom field not found. Run `freelo custom-fields list --project <id>` for uuids." |
| `429` RATE_LIMITED | 6    | (retryable; honour `Retry-After`)                                                   |
| `5xx`              | 4    | (server error; transient)                                                           |
| Network failure    | 5    | NETWORK_ERROR.                                                                      |

> **404 is NOT idempotent.** Renaming a deleted field is a real failure (the
> user's intent — "rename" — cannot be satisfied on a deleted field). Same
> precedent as `freelo labels rename` (decision 6 in spec 0055).

## Examples

```bash
# Rename a field
$ freelo custom-fields rename "11111111-2222-3333-4444-555555555555" --name "Points"
{"schema":"freelo.custom-fields.rename/v1","data":{"uuid":"11111111-...","applied_changes":{"name":"Points"}}}

# Dry-run
$ freelo custom-fields rename "11111111-..." --name "Points" --dry-run
{"schema":"freelo.custom-fields.rename/v1","data":{"uuid":"...","applied_changes":{"name":"Points"},"would":{"method":"POST","path":"/custom-field/rename/...","body":{"name":"Points"}}},"dry_run":true}

# Human mode
$ freelo custom-fields rename "11111111-..." --name "Points" --output human
Renamed custom field 11111111… → "Points".
```

## Required Freelo permissions

- **Project commander** role on the field's project. 403 otherwise.

## Related commands

- `freelo custom-fields list --project <id>` — discover uuids; check `is_commander`.
- `freelo custom-fields create` — define a new field.
- `freelo custom-fields delete` / `restore` — soft-delete and restore.
