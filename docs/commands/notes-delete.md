# freelo notes delete

Soft-delete one or more notes. Destructive — requires `--yes` (non-TTY) or interactive confirmation (TTY).

**API quirk:** Freelo's `DELETE /note/{id}` returns the deleted Note's last state in the response body, not the usual `SuccessResponse`. The CLI surfaces this on `data.note` for audit-log use cases. On a 404-idempotent skip (already-deleted), the envelope omits `data.note` (no body to echo).

Idempotent: HTTP 404 → `already_in_target_state: true`, exit 0 (single-arm; mirrors `labels delete`, `custom-fields delete`).

## Synopsis

```bash
freelo notes delete <id>... [--yes] [--dry-run]
freelo notes delete --ids "a,b,c" [--yes] [--dry-run]
freelo notes delete --stdin       [--yes] [--dry-run]   # NDJSON {"id":<int>}
```

Exactly one input source: positional, `--ids`, or `--stdin`.

## Options

| Flag        | Type / values             | Default | Purpose                                                       |
| ----------- | ------------------------- | ------- | ------------------------------------------------------------- |
| `--ids`     | comma- or space-separated | —       | Batch input via flag. Mutex with positional and `--stdin`.    |
| `--stdin`   | flag                      | `false` | NDJSON batch input from stdin.                                |
| `--yes`     | flag (root)               | `false` | Skip the interactive confirmation. Required for non-TTY.      |
| `--dry-run` | flag                      | `false` | Skip the wire call; envelope echoes `would.path` for each id. |

## Confirmation copy

| Single           | Multi (`N`)       |
| ---------------- | ----------------- |
| `Delete 1 note?` | `Delete N notes?` |

Non-TTY without `--yes` → `ConfirmationError`, exit 2 (`CONFIRMATION_REQUIRED`).

## Output schema

`freelo.notes.delete/v1`. One envelope per id:

```json
{
  "note_id": 1234,
  "note": { "id": 1234, "name": "Meeting minutes", "...": "..." },
  "previous_state": null,
  "current_state": "deleted",
  "already_in_target_state": false
}
```

On a 404-idempotent skip, `data.note` is absent and `already_in_target_state` is `true`.

## Examples

```bash
# Single, agent-style
freelo notes delete 1234 --yes --output json

# Multi positional
freelo notes delete 1234 1235 1236 --yes

# Batch from stdin
echo '{"id":1234}' | freelo notes delete --stdin --yes --output ndjson

# Dry-run preview
freelo notes delete 1234 --dry-run
```

## Errors

| Status  | Exit | Hint                                                       |
| ------- | ---- | ---------------------------------------------------------- |
| 401     | 3    | Auth credentials expired or invalid.                       |
| 403     | 4    | Account does not have permission to delete the note.       |
| 404     | 0    | Idempotent skip — `already_in_target_state: true`, exit 0. |
| 429     | 6    | Rate-limited; retry after `Retry-After`.                   |
| 5xx     | 4    | Server error; retryable.                                   |
| Network | 5    | Connection failed.                                         |
