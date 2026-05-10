# freelo custom-fields enum rename

Rename (relabel) an enum option. The option's uuid is preserved, so existing task values referencing it continue to resolve.

## Synopsis

```bash
freelo custom-fields enum rename <enum_uuid> --value <str> [--dry-run]
```

## Arguments

| Argument      | Purpose                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| `<enum_uuid>` | Enum-option uuid from `freelo custom-fields enum list --field <uuid>`. Required. |

## Options

| Flag            | Type / values | Default | Purpose                                                          |
| --------------- | ------------- | ------- | ---------------------------------------------------------------- |
| `--value <str>` | string        | —       | New display value (required, non-empty).                         |
| `--dry-run`     | flag          | `false` | Skip the wire call; envelope echoes the body that would be sent. |

## Output schema

`freelo.custom-fields.enum-rename/v1`. Envelope `data`:

```json
{
  "enum_uuid": "opt-cccc",
  "applied_changes": { "value": "Showstopper" }
}
```

## Errors

| Status | Hint                                                                                |
| ------ | ----------------------------------------------------------------------------------- |
| 400    | Server-side validation rejected the new value (likely duplicate within the field).  |
| 403    | Account is not a project commander on the option's project.                         |
| 404    | Enum option not found. Run `freelo custom-fields enum list --field <uuid>` for ids. |

## Examples

```bash
freelo custom-fields enum rename opt-cccc-... \
  --value "Showstopper" \
  --output json
```
