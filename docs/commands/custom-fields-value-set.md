# freelo custom-fields value set

**Upsert** a custom-field value on a task. The command dispatches between two
distinct Freelo endpoints based on the value flag:

- `--value <str>` → `POST /custom-field/add-or-edit-value` (text / number).
- `--enum <uuid>` → `POST /custom-field/add-or-edit-enum-value` (enum option).

Upsert semantics — if the task already has a value for `(task_id,
custom_field_uuid)`, it is updated; otherwise a new value record is created.
The two flags are mutually exclusive and exactly one is required (when not
piping NDJSON via `--stdin`).

## Synopsis

```bash
freelo custom-fields value set --task <id> --field <uuid> (--value <str>|--enum <uuid>) [--dry-run]
freelo custom-fields value set --stdin [--dry-run]   # NDJSON batch
```

This command is **not destructive in the user-data sense** (upsert; history
row written but no other field is lost), so it does **not** require `--yes`.

## Options

| Flag             | Type / values | Default | Purpose                                                                |
| ---------------- | ------------- | ------- | ---------------------------------------------------------------------- |
| `--task <id>`    | positive int  | —       | Task id (numeric). Required when not using `--stdin`.                  |
| `--field <uuid>` | string        | —       | Custom-field uuid. Discover via `freelo custom-fields list --project`. |
| `--value <str>`  | string        | —       | Scalar value (text or number). Mutex with `--enum`.                    |
| `--enum <uuid>`  | string        | —       | Enum-option uuid. Mutex with `--value`.                                |
| `--stdin`        | flag          | off     | Read NDJSON jobs from stdin. Mutex with the flag-driven inputs.        |
| `--dry-run`      | flag          | off     | Skip the wire call; envelope reflects what _would_ have been sent.     |

## Wire mapping

### Scalar — `POST /custom-field/add-or-edit-value`

Body is **snake_case**:

```jsonc
{
  "custom_field_uuid": "<field-uuid>",
  "task_id": 123,
  "value": "the value as a string",
}
```

Response: `{ "custom_field_value": <CustomFieldValue> }`.

### Enum — `POST /custom-field/add-or-edit-enum-value`

Body is **camelCase** (sic — Freelo's server quirk):

```jsonc
{
  "customFieldUuid": "<field-uuid>",
  "task_id": 123,
  "value": "<enum-option-uuid>",
}
```

`value` here is the **uuid of an enum option**, not its display string.
Response: `{ "customFieldEnum": <CustomFieldValue> }` (also camelCase wrapper).

## Envelope

`schema: freelo.custom-fields.value-set/v1`

| Field                 | Type                            | Notes                                                                      |
| --------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `task_id`             | int                             | Echo of `--task`.                                                          |
| `field_uuid`          | string                          | Echo of `--field`.                                                         |
| `kind`                | `'scalar' \| 'enum'`            | Which endpoint was hit (dispatch hint for downstream consumers).           |
| `value_uuid`          | string \| null                  | Server-generated record uuid. `null` on dry-run or empty server response.  |
| `value`               | string                          | For scalar: the string. For enum: the enum-option uuid.                    |
| `previous_value_uuid` | string \| null                  | Always `null` in v1 (no pre-GET). Reserved for future minor bumps.         |
| `would`               | object — `{method, path, body}` | Present **only** on `--dry-run`.                                           |
| `line_index`          | int                             | Present **only** on `--stdin` batch (zero-indexed across non-empty lines). |

## Validation

| Input                                | Behaviour                                                           |
| ------------------------------------ | ------------------------------------------------------------------- |
| Both `--value` and `--enum`          | `ValidationError` exit 2.                                           |
| Neither `--value` nor `--enum`       | `ValidationError` exit 2 ("Pass exactly one of --value or --enum"). |
| `--task 0`, `--task -1`, non-numeric | `ValidationError` exit 2.                                           |
| `--field "   "` (whitespace only)    | `ValidationError` exit 2.                                           |
| Flag input + `--stdin`               | `ValidationError` exit 2 (mutex).                                   |

## HTTP error mapping

| Status                            | Exit | Hint                                                                                  |
| --------------------------------- | ---- | ------------------------------------------------------------------------------------- |
| `400` mentioning `value` (scalar) | 4    | "Scalar fields expect a string. For enum-typed fields use --enum <enum-option-uuid>." |
| `400` generic                     | 4    | "Server-side validation rejected the request; review the message and adjust flags."   |
| `401` AUTH_EXPIRED                | 3    | (re-auth required)                                                                    |
| `403`                             | 4    | (account lacks permission)                                                            |
| `404` (scalar) or `404` generic   | 4    | "Task or custom field not found. Verify --task and --field."                          |
| `404` mentioning Enum (enum)      | 4    | "Enum option uuid not found. Run `freelo custom-fields enum list` (R43) for ids."     |
| `409`                             | 4    | "Custom field is in a different project than the task. The two must share a project." |
| `429` RATE_LIMITED                | 6    | (retryable; honour `Retry-After`)                                                     |
| `5xx`                             | 4    | (server error; transient)                                                             |
| Network failure                   | 5    | NETWORK_ERROR.                                                                        |

## Batch input via `--stdin` (NDJSON)

Each line is a job. Mutex of `value` / `enum` is enforced per line.

```jsonc
{ "task_id": 123, "field_uuid": "...", "value": "high" }
{ "task_id": 124, "field_uuid": "...", "enum":  "<enum-option-uuid>" }
```

Per-line errors emit one `freelo.error/v1` envelope with `line_index` (and
`task_id` when the line parsed far enough to know one). Successes interleave
normally. Exit code is the **highest** observed across the batch.

## Examples

```bash
# Scalar set (text/number):
$ freelo custom-fields value set --task 7 --field 11111111-... --value "high" --output json
{"schema":"freelo.custom-fields.value-set/v1","data":{"task_id":7,"field_uuid":"...","kind":"scalar","value_uuid":"cfv-...","value":"high",...}}

# Enum set (the value is the enum-option uuid, not the label):
$ freelo custom-fields value set --task 7 --field 11111111-... --enum aaaa-... --output json

# Dry-run shows what would be sent:
$ freelo custom-fields value set --task 7 --field 11111111-... --value "x" --dry-run --output json
{"schema":"freelo.custom-fields.value-set/v1","data":{...,"would":{"method":"POST","path":"/custom-field/add-or-edit-value","body":{...}}},"dry_run":true}

# Batch via NDJSON:
$ printf '{"task_id":7,"field_uuid":"...","value":"a"}\n{"task_id":8,"field_uuid":"...","value":"b"}\n' \
    | freelo custom-fields value set --stdin --output json
```

## Required Freelo permissions

- Write access (commander or worker with edit rights) on the task's project.
- 403 otherwise; 409 if the task and the custom field are in different
  projects (Freelo's cross-project rule).

## Related commands

- `freelo custom-fields list --project <id>` — discover field uuids.
- `freelo custom-fields value clear` — remove a value.
- `freelo custom-fields enum list --field <uuid>` — discover enum-option uuids (R43, future).
- `freelo tasks show <id>` — see the current values on a task (`custom_fields[]`).
