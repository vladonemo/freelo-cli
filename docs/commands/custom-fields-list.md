# freelo custom-fields list

List all **custom-field definitions configured on a project**, plus an
`is_commander` boolean indicating whether the caller can call the R41+
mutation endpoints (create / rename / delete / restore) on that project.

Soft-deleted fields are excluded server-side. An empty `custom_fields: []`
is a valid 200 response.

## Synopsis

```bash
freelo custom-fields list --project <id>
```

This command is **read-only**: no `--dry-run`, no `--yes` (spec 0054
decision 5).

## Options

| Flag             | Type / values | Default | Purpose                                                              |
| ---------------- | ------------- | ------- | -------------------------------------------------------------------- |
| `--project <id>` | positive int  | —       | Project id (numeric). Required. Discover via `freelo projects list`. |

## Wire mapping

`GET /custom-field/find-by-project/{project_id}`. No body, no query.
Response:

```jsonc
{
  "custom_fields": [
    {
      "uuid": "<uuid>",
      "name": "Severity",
      "custom_fields_types_uuid": "2f7bfe3a-c950-470e-b910-95b4caf5dc4f",
      "project_id": 100,
      "author_id": 5,
      "date_add": "2025-01-01T00:00:00Z",
      "priority": 1,
    },
  ],
  "is_commander": true,
}
```

## Envelope

`schema: freelo.custom-fields.list/v1`

| Field           | Type            | Always present | Notes                                                                    |
| --------------- | --------------- | -------------- | ------------------------------------------------------------------------ |
| `project_id`    | int             | yes            | Echo of `--project <id>`. Agent self-correlation.                        |
| `custom_fields` | `CustomField[]` | yes            | Server-returned array. May be empty `[]` (no fields configured).         |
| `is_commander`  | boolean         | yes            | True if the caller can call the R41+ mutation endpoints on this project. |

`CustomField` shape (per `docs/api/freelo-api.yaml:6054-6073`):

| Field                      | Type                     | Notes                                |
| -------------------------- | ------------------------ | ------------------------------------ |
| `uuid`                     | string                   | Required-on-the-wire (decision 7).   |
| `name`                     | string                   | Required-on-the-wire (decision 7).   |
| `custom_fields_types_uuid` | string \| null \| absent | Defensive: `.nullable().optional()`. |
| `project_id`               | int \| null \| absent    | Same.                                |
| `author_id`                | int \| null \| absent    | Same.                                |
| `date_add`                 | string \| null \| absent | Same. ISO-8601 when present.         |
| `priority`                 | int \| null \| absent    | Same.                                |

Unknown future fields pass through untouched (forward-compatible).

## Validation

| Input                         | Behaviour                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| Missing `--project`           | `ValidationError` exit 2 with hint pointing at `freelo projects list`.                                    |
| `--project abc` (non-numeric) | `ValidationError` exit 2 — Commander's `InvalidArgumentError` is rewritten to the typed error (calib §1). |
| `--project 0`, `--project -5` | `ValidationError` exit 2.                                                                                 |

## HTTP error mapping

| Status                        | Exit | Hint                                                                                  |
| ----------------------------- | ---- | ------------------------------------------------------------------------------------- |
| `400` mentioning `project_id` | 4    | "must reference a project the caller can access. Run `freelo projects list` for ids." |
| `400` generic                 | 4    | "Server-side validation rejected the request; review the message and adjust flags."   |
| `401` AUTH_EXPIRED            | 3    | (top-level handler — re-auth required)                                                |
| `403`                         | 4    | "Account does not have permission to read custom fields on this project."             |
| `404`                         | 4    | "Project not found. Run `freelo projects list` for ids."                              |
| `429` RATE_LIMITED            | 6    | (retryable; honour `Retry-After`)                                                     |
| `5xx`                         | 4    | (server error; transient)                                                             |
| Network failure               | 5    | NETWORK_ERROR.                                                                        |

## Examples

```bash
# JSON for agents:
$ freelo custom-fields list --project 100 --output json
{"schema":"freelo.custom-fields.list/v1","data":{"project_id":100,"custom_fields":[{"uuid":"...","name":"Severity",...}],"is_commander":true}}

# Empty project (no fields configured):
$ freelo custom-fields list --project 200 --output json
{"schema":"freelo.custom-fields.list/v1","data":{"project_id":200,"custom_fields":[],"is_commander":false}}

# Decide whether you can mutate (jq):
$ if [ "$(freelo custom-fields list --project 100 --output json | jq -r '.data.is_commander')" = "true" ]; then echo "can create"; else echo "read-only"; fi

# Human mode (TTY default):
$ freelo custom-fields list --project 100
Project #100 — 2 custom field(s), is_commander=true:
  Severity      type=2f7bfe3a…  priority=1  uuid=11111111…
  Story Points  type=b1e56fa9…  priority=2  uuid=22222222…

# Empty:
$ freelo custom-fields list --project 200
Project #200 — no custom fields, is_commander=false.
```

> Human mode abbreviates UUIDs to the first 8 chars + ellipsis for
> readability. Use `--output json` (default for agents / non-TTY) for full
> UUIDs.

## Required Freelo permissions

- Read access to the project (any role). 403 otherwise.
- Project commander role to act on the R41+ mutation endpoints; this is
  surfaced via the `is_commander` boolean so agents can branch without a
  speculative POST.

## Related commands

- `freelo custom-fields types` — server-curated type catalog (R40, sibling slice).
- `freelo projects list` — discover project ids.
- `freelo projects show <id>` — full project detail.
