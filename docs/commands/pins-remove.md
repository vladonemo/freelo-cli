# freelo pins remove

Remove one or more pinned items. Destructive — requires `--yes` (non-TTY) or interactive confirmation (TTY).

The underlying target (task / document / file / link) is **NOT affected** — only the pin row is removed.

Idempotent: HTTP 404 → `already_in_target_state: true`, exit 0 (single-arm; yaml :1123 conflates "doesn't exist" with "no ACL on project"; both map to "user got the absent end-state").

## Synopsis

```bash
freelo pins remove <id>... [--yes] [--dry-run]
freelo pins remove --ids "a,b,c" [--yes] [--dry-run]
freelo pins remove --stdin       [--yes] [--dry-run]   # NDJSON {"id":<int>}
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

| Single                  | Multi (`N`)              |
| ----------------------- | ------------------------ |
| `Remove 1 pinned item?` | `Remove N pinned items?` |

Non-TTY without `--yes` → `ConfirmationError`, exit 2 (`CONFIRMATION_REQUIRED`).

## Output schema

`freelo.pins.remove/v1`. One envelope per id:

```json
{
  "pin_id": 99,
  "previous_state": null,
  "current_state": "removed",
  "already_in_target_state": false
}
```

## Examples

```bash
# Single
freelo pins remove 99 --yes --output json

# Multi positional
freelo pins remove 99 100 101 --yes

# Batch from stdin
echo '{"id":99}' | freelo pins remove --stdin --yes --output ndjson

# Dry-run preview
freelo pins remove 99 --dry-run
```

## Errors

| Status  | Exit | Hint                                                       |
| ------- | ---- | ---------------------------------------------------------- |
| 401     | 3    | Auth credentials expired or invalid.                       |
| 403     | 4    | Account does not have permission to remove the pin.        |
| 404     | 0    | Idempotent skip — `already_in_target_state: true`, exit 0. |
| 429     | 6    | Rate-limited; retry after `Retry-After`.                   |
| 5xx     | 4    | Server error; retryable.                                   |
| Network | 5    | Connection failed.                                         |
