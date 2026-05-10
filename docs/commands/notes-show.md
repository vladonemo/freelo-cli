# freelo notes show

Show a single note by id, including its full content, embedded files, and embedded comments.

The Note shape is loose (most fields nullable / optional per Freelo's OpenAPI). The CLI passes the response through with `.passthrough()`, so any future fields surface via `--output json`.

## Synopsis

```bash
freelo notes show <id> [--output <mode>]
```

## Options

| Flag              | Type / values               | Default | Purpose                                 |
| ----------------- | --------------------------- | ------- | --------------------------------------- |
| `<id>`            | positive integer            | —       | Numeric note id (positional, required). |
| `--output <mode>` | `auto\|human\|json\|ndjson` | `auto`  | Output mode.                            |

No `--dry-run` — read commands have nothing to dry-run.

## Output schema

`freelo.notes.show/v1`. Envelope `data`:

```json
{
  "note": {
    "id": 1234,
    "name": "Meeting minutes",
    "content": "...",
    "date_add": "2026-05-10T00:00:00Z",
    "date_edited_at": "2026-05-10T01:00:00Z",
    "author": { "id": 5, "fullname": "Jane Doe" },
    "project": { "id": 100, "name": "Project X" },
    "files": [],
    "comments": []
  }
}
```

## Examples

```bash
# Read a note's full content
freelo notes show 1234 --output json

# Human summary in a TTY
freelo notes show 1234
```

## Errors

| Status  | Exit | Hint                                                                                                                                  |
| ------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 401     | 3    | Auth credentials expired or invalid.                                                                                                  |
| 403     | 4    | Account does not have permission to read this note.                                                                                   |
| 404     | 4    | Note not found, or your account does not have permission to read it (Freelo collapses the two cases to avoid leaking note existence). |
| 429     | 6    | Rate-limited; retry after `Retry-After`.                                                                                              |
| 5xx     | 4    | Server error; retryable.                                                                                                              |
| Network | 5    | Connection failed.                                                                                                                    |
