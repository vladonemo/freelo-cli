# freelo custom-fields enum add

Add a new enum option to an enum-typed custom field. Single-shot, non-destructive.

## Synopsis

```bash
freelo custom-fields enum add --field <uuid> --value <str> [--dry-run]
```

## Options

| Flag             | Type / values | Default | Purpose                                                            |
| ---------------- | ------------- | ------- | ------------------------------------------------------------------ |
| `--field <uuid>` | string        | —       | Custom-field uuid (required). Must be an enum-typed field.         |
| `--value <str>`  | string        | —       | Display value of the new option (required, non-empty).             |
| `--dry-run`      | flag          | `false` | Skip the POST; envelope echoes the body that would have been sent. |

## Output schema

`freelo.custom-fields.enum-add/v1`. Envelope `data`:

```json
{
  "field_uuid": "11111111-1111-1111-1111-111111111111",
  "option": { "uuid": "opt-cccc", "value": "Blocker" }
}
```

## Errors

| Status | Hint                                                                              |
| ------ | --------------------------------------------------------------------------------- |
| 400    | Server rejected --value. Check the option label is non-empty and not duplicated.  |
| 403    | Account is not a project commander on the field's project.                        |
| 404    | Custom field not found. Run `freelo custom-fields list --project <id>` for uuids. |

## Examples

```bash
freelo custom-fields enum add \
  --field 11111111-1111-1111-1111-111111111111 \
  --value "Blocker" \
  --output json
```
