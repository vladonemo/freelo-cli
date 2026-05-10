# freelo custom-fields restore

**Restore** one or more soft-deleted custom-field definitions. Reverses a
prior `freelo custom-fields delete`. Previously-preserved task values
become visible again.

**Non-destructive** — restore brings hidden data back, it doesn't destroy
anything new. No `--yes` flag, no confirmation gate.

## Synopsis

```bash
freelo custom-fields restore <uuid>... [--ids <list>] [--stdin] [--dry-run]
```

Pick exactly one input source: positional `<uuid>...`, `--ids <list>`, or
`--stdin` (NDJSON `{"uuid": "..."}` per line).

## Options

| Flag           | Type / values        | Default | Purpose                                                                   |
| -------------- | -------------------- | ------- | ------------------------------------------------------------------------- |
| `<uuid>...`    | UUID list            | —       | One or more positional uuids. Mutex with `--ids` and `--stdin`.           |
| `--ids <list>` | comma- or whitespace | —       | Inline list of uuids. Mutex with positional and `--stdin`.                |
| `--stdin`      | flag                 | off     | Read NDJSON from stdin: `{"uuid": "..."}` per line. Mutex with the above. |
| `--dry-run`    | flag                 | off     | Skip the POST per uuid. Envelope reflects what _would_ have been called.  |

## Wire mapping

`POST /custom-field/restore/{uuid}` (yaml :4168-4196).

No body. Response: `{ "custom_field": { ... } }` (200).

## Envelope

`schema: freelo.custom-fields.restore/v1` (one envelope per uuid).

| Field                     | Type          | Always present    | Notes                                                                                     |
| ------------------------- | ------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| `uuid`                    | string        | yes               | The uuid acted on.                                                                        |
| `previous_state`          | `null`        | yes               | Reserved (always null v1).                                                                |
| `current_state`           | `'active'`    | yes               | Constant.                                                                                 |
| `already_in_target_state` | boolean       | yes               | True iff 404-as-idempotent skip.                                                          |
| `custom_field`            | `CustomField` | live success only | Server-returned full definition. Absent on dry-run AND on the 404-skip path (decision 7). |
| `would`                   | `Would`       | dry-run only      | Method/path/body that would be sent.                                                      |
| `line_index`              | int           | `--stdin` only    | Per-line correlation in NDJSON batch mode (0-indexed).                                    |

## Idempotency

Single-arm 404 heuristic (decision 3, mirrors `delete`):

1. **HTTP 404** → `already_in_target_state: true`, exit 0. The OpenAPI
   conflates "doesn't exist" with "was never soft-deleted" (yaml :4177);
   both map to "user got the active end-state they asked for".
2. **Any other non-2xx** → re-throw the typed `FreeloApiError`.

> Trade-off: `restore` of a totally non-existent uuid silently "succeeds"
> because the wire cannot disambiguate that case from the
> already-active case. If certainty matters, follow up with
> `freelo custom-fields list --project <id>` to verify.

## Validation

| Input                     | Behaviour                                                            |
| ------------------------- | -------------------------------------------------------------------- |
| No input source           | `ValidationError` exit 2 — "No custom-field uuids supplied."         |
| Two or more input sources | `ValidationError` exit 2 — "Pick exactly one input source ..."       |
| Malformed positional uuid | `ValidationError` exit 2 (UUID regex).                               |
| Malformed uuid in `--ids` | `ValidationError` exit 2.                                            |
| Malformed uuid in NDJSON  | Per-line `freelo.error/v1` envelope on stdout, exit 2 at end of run. |
| Empty `--stdin`           | Silent success, exit 0.                                              |

## HTTP error mapping

| Status             | Exit | Behaviour                                                              |
| ------------------ | ---- | ---------------------------------------------------------------------- |
| `200`              | 0    | Success envelope with `custom_field`.                                  |
| `404`              | 0    | Idempotent skip — `already_in_target_state: true` (no `custom_field`). |
| `401` AUTH_EXPIRED | 3    | (top-level handler)                                                    |
| `403`              | 4    | (project-commander role required)                                      |
| `429` RATE_LIMITED | 6    | (retryable; honour `Retry-After`)                                      |
| `5xx`              | 4    | (server error; transient)                                              |
| Network failure    | 5    | NETWORK_ERROR.                                                         |

## Examples

```bash
# Single positional
$ freelo custom-fields restore "11111111-..."
{"schema":"freelo.custom-fields.restore/v1","data":{"uuid":"11111111-...","current_state":"active","already_in_target_state":false,"custom_field":{"uuid":"...","name":"Severity",...}}}

# Multi positional / --ids / --stdin (same shapes as delete)
$ freelo custom-fields restore "uuid-a" "uuid-b"
$ freelo custom-fields restore --ids "uuid-a,uuid-b"
$ cat ids.ndjson | freelo custom-fields restore --stdin

# Dry-run
$ freelo custom-fields restore "11111111-..." --dry-run
{"schema":"freelo.custom-fields.restore/v1","data":{"uuid":"11111111-...","would":{"method":"POST","path":"/custom-field/restore/11111111-...","body":{}},...},"dry_run":true}

# Human mode (TTY default)
$ freelo custom-fields restore "11111111-..." --output human
Restored custom field "Severity" (uuid=11111111…).

# Idempotent re-restore
$ freelo custom-fields restore "11111111-..." --output human
Already active: custom field 11111111….

# Undo a recent bulk delete (idempotent — safe to re-run)
$ jq -c '.data | select(.already_in_target_state == false) | {uuid: .uuid}' deleted.ndjson \
    | freelo custom-fields restore --stdin --output ndjson
```

## Required Freelo permissions

- **Project commander** role on the field's project. 403 otherwise.

## Related commands

- `freelo custom-fields delete <uuid>` — soft-delete a field.
- `freelo custom-fields list --project <id>` — list active fields. Soft-deleted fields are excluded server-side.
- `freelo custom-fields create` — define a new field instead of restoring.
