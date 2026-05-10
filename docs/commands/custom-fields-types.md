# freelo custom-fields types

List the **server-curated catalog of custom-field type definitions**
(`text`, `number`, `enum`) available when creating a custom field on a
project. Each type's `uuid` is the value passed as `type` when calling the
future `freelo custom-fields create --project <id> --type <uuid>` command
(R41 — separate Wave 7 slice).

The endpoint is read-only. There is no API to mutate the type catalog —
Freelo curates it server-side.

## Synopsis

```bash
freelo custom-fields types
```

No flags, no positional arguments. Every global flag (`--output`,
`--profile`, `--request-id`, `-v` / `-vv`) is honoured.

This command is **read-only**: no `--dry-run`, no `--yes` (spec 0054
decision 5).

## Wire mapping

`GET /custom-field/get-types`. No body, no query, no path params. Response:

```jsonc
{
  "custom_field_types": [
    { "uuid": "2f7bfe3a-c950-470e-b910-95b4caf5dc4f", "name": "text" },
    { "uuid": "b1e56fa9-a97a-429b-8ab4-82bebe58933a", "name": "number" },
    { "uuid": "f9729a8f-d340-40e4-b2c0-dc46c37e18ce", "name": "enum" },
  ],
}
```

The three documented UUIDs are referenced in
`docs/api/freelo-api.yaml:4081-4085` as the canonical type-uuid set.
Unknown future types pass through untouched (forward-compatible).

## Envelope

`schema: freelo.custom-fields.types/v1`

| Field   | Type                               | Always present | Notes                                                                                  |
| ------- | ---------------------------------- | -------------- | -------------------------------------------------------------------------------------- |
| `types` | `{ uuid: string; name: string }[]` | yes            | Server-returned catalog. Currently three entries (`text`, `number`, `enum`); may grow. |

Field additions are minor. Field removals or rename / retype is breaking
and triggers a `/v2` bump.

## Examples

```bash
# Look up the type catalog:
$ freelo custom-fields types --output json
{"schema":"freelo.custom-fields.types/v1","data":{"types":[{"uuid":"2f7bfe3a-c950-470e-b910-95b4caf5dc4f","name":"text"},{"uuid":"b1e56fa9-a97a-429b-8ab4-82bebe58933a","name":"number"},{"uuid":"f9729a8f-d340-40e4-b2c0-dc46c37e18ce","name":"enum"}]}}

# Pipe through jq to grab the enum uuid:
$ freelo custom-fields types --output json | jq -r '.data.types[] | select(.name=="enum") | .uuid'
f9729a8f-d340-40e4-b2c0-dc46c37e18ce

# Human mode (TTY default):
$ freelo custom-fields types
text    2f7bfe3a-c950-470e-b910-95b4caf5dc4f
number  b1e56fa9-a97a-429b-8ab4-82bebe58933a
enum    f9729a8f-d340-40e4-b2c0-dc46c37e18ce
```

## Required Freelo permissions

A valid API key + email pair is sufficient — the type catalog is
account-scoped, not project-scoped.

## Related commands

- `freelo custom-fields list --project <id>` — list custom fields configured
  on a project (R40, sibling slice).
- `freelo projects list` — discover project ids.
