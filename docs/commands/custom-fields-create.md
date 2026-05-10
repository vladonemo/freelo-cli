# freelo custom-fields create

Create a **custom-field definition** on a project. Caller must be a project
commander. The `--type` uuid comes from `freelo custom-fields types`.

## Synopsis

```bash
freelo custom-fields create --project <id> --name <str> --type <type-uuid> [--uuid <uuid>] [--dry-run]
```

Single-shot: no batch input. Non-destructive — no `--yes`. Supports
`--dry-run` per the agent-safe-writes contract.

## Options

| Flag             | Type / values | Default | Purpose                                                                                                            |
| ---------------- | ------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `--project <id>` | positive int  | —       | Project id (numeric). Required.                                                                                    |
| `--name <str>`   | string        | —       | Display name for the new custom field. Required, non-empty after trim.                                             |
| `--type <uuid>`  | UUID          | —       | UUID of the type from `freelo custom-fields types` (text / number / enum). Required.                               |
| `--uuid <uuid>`  | UUID          | —       | Optional pre-assigned UUID for the new field — useful for deterministic provisioning. Server generates if omitted. |
| `--dry-run`      | flag          | off     | Skip the POST; envelope echoes the body that would have been sent.                                                 |

## Wire mapping

`POST /custom-field/create/{project_id}` (yaml :4043-4095).

Request body:

```jsonc
{
  "name": "Severity", // required
  "type": "2f7bfe3a-c950-470e-b910-95b4caf5dc4f", // required (text-uuid)
  "uuid": "11111111-2222-3333-4444-555555555555", // optional
}
```

Response (200): `{ "custom_field": { ... } }`.

## Envelope

`schema: freelo.custom-fields.create/v1`

| Field          | Type          | Live | Dry-run | Notes                                                          |
| -------------- | ------------- | ---- | ------- | -------------------------------------------------------------- |
| `project_id`   | int           | yes  | yes     | Echo of `--project <id>`.                                      |
| `custom_field` | `CustomField` | yes  | —       | Server-returned full definition (uuid + type + project + ...). |
| `would`        | `Would`       | —    | yes     | Method/path/body that would be sent.                           |

## Validation

| Input                          | Behaviour                              |
| ------------------------------ | -------------------------------------- |
| Missing `--project`            | `ValidationError` exit 2.              |
| Missing or whitespace `--name` | `ValidationError` exit 2.              |
| Missing `--type`               | `ValidationError` exit 2.              |
| `--project 0` or non-numeric   | `ValidationError` exit 2.              |
| `--type not-a-uuid`            | `ValidationError` exit 2 (UUID regex). |
| `--uuid bad`                   | `ValidationError` exit 2.              |

The CLI does NOT pre-validate that `--type` is one of the documented type
uuids. The server enforces that (404 / 400) and the catalog may grow.

## HTTP error mapping

| Status                          | Exit | Hint                                                                                                                    |
| ------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------- |
| `400` mentioning `name`         | 4    | "Server rejected --name; check it's non-empty and unique on the project."                                               |
| `400` mentioning `type`         | 4    | "Server rejected --type; pass a uuid from `freelo custom-fields types`."                                                |
| `400` mentioning `uuid`         | 4    | "Server rejected --uuid; must be a v4 UUID, unused on this project."                                                    |
| `400` generic                   | 4    | "Server-side validation rejected the request; review the message."                                                      |
| `401` AUTH_EXPIRED              | 3    | (top-level handler)                                                                                                     |
| `402` / `PlanExceededException` | 4    | "Plan limit reached — check the Freelo subscription tier."                                                              |
| `403`                           | 4    | "Account is not a project commander on the target project — required to create custom fields."                          |
| `404`                           | 4    | "Project not found, OR --type uuid is not in the catalog. Run `freelo projects list` and `freelo custom-fields types`." |
| `429` RATE_LIMITED              | 6    | (retryable; honour `Retry-After`)                                                                                       |
| `5xx`                           | 4    | (server error; transient)                                                                                               |
| Network failure                 | 5    | NETWORK_ERROR.                                                                                                          |

## Examples

```bash
# Discover the type uuid first
$ TEXT_UUID=$(freelo custom-fields types --output json | jq -r '.data.types[] | select(.name=="text") | .uuid')

# Create a Severity field on project 100
$ freelo custom-fields create --project 100 --name "Severity" --type "$TEXT_UUID"
{"schema":"freelo.custom-fields.create/v1","data":{"project_id":100,"custom_field":{"uuid":"...","name":"Severity",...}}}

# Provision with a deterministic uuid (idempotent script)
$ freelo custom-fields create --project 100 --name "Story Points" \
    --type "b1e56fa9-a97a-429b-8ab4-82bebe58933a" \
    --uuid "11111111-2222-3333-4444-555555555555"

# Dry-run — preview the body
$ freelo custom-fields create --project 100 --name "Severity" --type "$TEXT_UUID" --dry-run
{"schema":"freelo.custom-fields.create/v1","data":{"project_id":100,"would":{"method":"POST","path":"/custom-field/create/100","body":{"name":"Severity","type":"..."}}},"dry_run":true}

# Human mode
$ freelo custom-fields create --project 100 --name "Severity" --type "$TEXT_UUID" --output human
Created custom field "Severity" on project #100 (uuid=...).
```

## Required Freelo permissions

- **Project commander** role on the target project. 403 `UserIsNotProjectCommander` otherwise.
- The account must be on a plan that allows the operation. 402
  `PlanExceededException` when the plan limit is reached.

## Related commands

- `freelo custom-fields types` — discover the `--type` uuids.
- `freelo custom-fields list --project <id>` — list existing fields on a project; check `is_commander`.
- `freelo custom-fields rename <uuid> --name <new>` — rename after creation.
- `freelo custom-fields delete <uuid>` — soft-delete.
- `freelo custom-fields restore <uuid>` — restore a soft-deleted field.
