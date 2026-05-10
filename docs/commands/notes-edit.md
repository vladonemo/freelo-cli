# freelo notes edit

Overwrite a note's title and/or content via `POST /note/{id}`.

**Verb is POST, not PATCH** — Freelo's OpenAPI is authoritative.

**Wire requires `name`** even on a content-only edit. If you pass only `--content` (no `--name`), the CLI issues a transparent `GET /note/{id}` first to fetch the current name, then POSTs with `{ name, content }`. The auto-fetch GET error (404 / 403) bubbles before any POST, so a missing note never produces a half-written edit.

At least one change flag is required (empty edit is rejected).

## Synopsis

```bash
freelo notes edit <id> [--name <str>] [--content <str>|--from-file <path>|--editor|-] [--dry-run]
```

## Options

| Flag                 | Type / values               | Default | Purpose                                                                                                          |
| -------------------- | --------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `<id>`               | positive integer            | —       | Numeric note id (positional, required).                                                                          |
| `--name <str>`       | string                      | —       | New title (non-empty after trim if supplied).                                                                    |
| `--content <str>`    | string                      | —       | Inline new content. Mutex with `--from-file`, `--editor`, `-`.                                                   |
| `--from-file <path>` | path                        | —       | Read new content from a UTF-8 file. Mutex with the other content flags.                                          |
| `--editor`           | flag                        | `false` | Open `$VISUAL`/`$EDITOR`. Requires a TTY. Mutex with the other content flags.                                    |
| `-` (positional)     | sentinel                    | —       | Read content from stdin to EOF. Mutex with the other content flags.                                              |
| `--dry-run`          | flag                        | `false` | Skip the GET-then-POST flow. `would.body.name` is `<existing-name-from-GET>` when only `--content` was supplied. |
| `--output <mode>`    | `auto\|human\|json\|ndjson` | `auto`  | Output mode.                                                                                                     |

Single-shot only — no batch in v1.

## Output schema

`freelo.notes.edit/v1`. Envelope `data`:

```json
{
  "note_id": 1234,
  "note": { "id": 1234, "name": "New title", "content": "...", "...": "..." },
  "applied_changes": { "name": "New title", "content": "New body" },
  "source": "message",
  "byte_length": 8
}
```

`applied_changes` echoes only the keys you explicitly set on the CLI — even though the wire body always carries both `name` and `content` (because the API requires `name`), `applied_changes` reflects user intent.

## Examples

```bash
# Rename only
freelo notes edit 1234 --name "Updated title"

# Replace body only (transparent GET-then-POST)
freelo notes edit 1234 --content "New body"

# Both title and body
freelo notes edit 1234 --name "New title" --from-file ./new-body.md

# Dry-run preview
freelo notes edit 1234 --content "New body" --dry-run
```

## Errors

| Status / source              | Exit | Hint                                                                                                   |
| ---------------------------- | ---- | ------------------------------------------------------------------------------------------------------ |
| No change flags              | 2    | `VALIDATION_ERROR`. At least one of `--name`, `--content`, `--from-file`, `--editor`, `-` is required. |
| Empty `--name` / `--content` | 2    | `VALIDATION_ERROR`. Empty after trim is rejected.                                                      |
| 400 (edit POST)              | 4    | Server-side validation rejected the request; verify `--name` is non-empty.                             |
| 401                          | 3    | Auth credentials expired or invalid.                                                                   |
| 403                          | 4    | Account does not have permission to edit the note.                                                     |
| 404 (edit POST)              | 4    | Note not found, or no permission to edit it. **NOT idempotent** — edit-of-deleted is a real failure.   |
| 404 (auto-fetch GET)         | 4    | Note not found before edit could proceed.                                                              |
| 429                          | 6    | Rate-limited; retry after `Retry-After`.                                                               |
| 5xx                          | 4    | Server error; retryable.                                                                               |
| Network                      | 5    | Connection failed.                                                                                     |
