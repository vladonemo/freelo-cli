# freelo custom-fields enum list

List the enum options defined on an enum-typed custom field. Read-only.

The returned `options` array preserves Freelo's server-side ordering (typically the order in which options were added). Use the `value` field as the human label and `uuid` as the immutable identifier required by `freelo custom-fields value set --enum <uuid>`.

## Synopsis

```bash
freelo custom-fields enum list --field <uuid> [--output <mode>]
```

## Options

| Flag              | Type / values               | Default | Purpose                                                    |
| ----------------- | --------------------------- | ------- | ---------------------------------------------------------- |
| `--field <uuid>`  | string                      | —       | Custom-field uuid (required). Must be an enum-typed field. |
| `--output <mode>` | `auto\|human\|json\|ndjson` | `auto`  | Output mode. Inherits global default.                      |

No `--dry-run` — read commands have nothing to dry-run.

## Output schema

`freelo.custom-fields.enum-list/v1`. Envelope `data`:

```json
{
  "field_uuid": "11111111-1111-1111-1111-111111111111",
  "options": [
    { "uuid": "opt-aaaa", "value": "Critical" },
    { "uuid": "opt-bbbb", "value": "Major" }
  ]
}
```

## Examples

Agent-style (env-var auth + JSON):

```bash
FREELO_API_KEY=… FREELO_EMAIL=me@x \
  freelo custom-fields enum list \
    --field 11111111-1111-1111-1111-111111111111 \
    --output json
```
