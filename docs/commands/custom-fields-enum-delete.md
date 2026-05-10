# freelo custom-fields enum delete

Delete one or more enum options. Destructive — requires `--yes` (non-TTY) or interactive confirmation (TTY).

Two endpoints, switched by `--force`:

- **Default (safe):** `DELETE /custom-field-enum/delete/{uuid}` — refuses (400) if the option is referenced by any task value.
- **`--force`:** `DELETE /custom-field-enum/force-delete/{uuid}` — cascades; referencing task values are CLEARED server-side.

The CLI never overrides the server's safe-delete refusal. If the safe path returns 400 (in-use), the CLI surfaces the error with a hint to retry with `--force`.

Idempotent: HTTP 404 on either path is treated as `already_in_target_state: true`, exit 0 (single-arm; mirrors `custom-fields delete`).

## Synopsis

```bash
freelo custom-fields enum delete <enum_uuid>... [--force] [--yes] [--dry-run]
freelo custom-fields enum delete --ids "a,b,c"   [--force] [--yes] [--dry-run]
freelo custom-fields enum delete --stdin         [--force] [--yes] [--dry-run]   # NDJSON {"uuid":"..."}
```

Exactly one input source: positional, `--ids`, or `--stdin`.

## Options

| Flag        | Type / values             | Default | Purpose                                                         |
| ----------- | ------------------------- | ------- | --------------------------------------------------------------- |
| `--ids`     | comma- or space-separated | —       | Batch input via flag. Mutex with positional and `--stdin`.      |
| `--stdin`   | flag                      | `false` | NDJSON batch input from stdin.                                  |
| `--force`   | flag                      | `false` | Use the cascading endpoint (CLEARS referencing task values).    |
| `--yes`     | flag (root)               | `false` | Skip the interactive confirmation. Required for non-TTY.        |
| `--dry-run` | flag                      | `false` | Skip the wire call; envelope echoes `would.path` for each uuid. |

## Confirmation copy

| Mode      | Single                                                                 | Multi (`N`)                                                             |
| --------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Safe      | `Delete 1 enum option?`                                                | `Delete N enum options?`                                                |
| `--force` | `Force-delete 1 enum option? Referencing task values will be CLEARED.` | `Force-delete N enum options? Referencing task values will be CLEARED.` |

Non-TTY without `--yes` → `ConfirmationError`, exit 2 (`CONFIRMATION_REQUIRED`).

## Output schema

`freelo.custom-fields.enum-delete/v1`. One envelope per uuid:

```json
{
  "enum_uuid": "opt-cccc",
  "force": false,
  "previous_state": null,
  "current_state": "deleted",
  "already_in_target_state": false
}
```

## Errors

| Status | Path | Hint                                                                                     |
| ------ | ---- | ---------------------------------------------------------------------------------------- |
| 400    | safe | Option is in use by at least one task value. Retry with `--force` to clear those values. |
| 401    | both | Auth credentials expired or invalid.                                                     |
| 403    | both | Not a project commander.                                                                 |
| 404    | both | Idempotent skip — `already_in_target_state: true`, exit 0.                               |
| 5xx    | both | Server error; retryable.                                                                 |
| 429    | both | Rate-limited; retry after `Retry-After`.                                                 |

## Examples

```bash
# safe delete, single
freelo custom-fields enum delete opt-cccc-... --yes --output json

# force delete batch from stdin
echo '{"uuid":"opt-aaaa-..."}' \
  | freelo custom-fields enum delete --stdin --force --yes --output ndjson
```
