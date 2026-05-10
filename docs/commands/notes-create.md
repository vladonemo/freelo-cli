# freelo notes create

Create a project-level note (rich-text block attached to a project, not a task). Notes share storage with documents internally — Freelo's `Document` entity backs the response shape.

Content is **optional** — a name-only note is valid (the wire body simply omits `content`).

## Synopsis

```bash
freelo notes create --project <id> --name <str> [--content <str>|--from-file <path>|--editor|-] [--dry-run]
```

## Options

| Flag                 | Type / values               | Default | Purpose                                                                      |
| -------------------- | --------------------------- | ------- | ---------------------------------------------------------------------------- |
| `--project <id>`     | positive integer            | —       | Target project id (required).                                                |
| `--name <str>`       | string                      | —       | Note title (required, non-empty after trim).                                 |
| `--content <str>`    | string                      | —       | Inline content. Mutex with `--from-file`, `--editor`, `-`.                   |
| `--from-file <path>` | path                        | —       | Read content from a UTF-8 file. Mutex with `--content`, `--editor`, `-`.     |
| `--editor`           | flag                        | `false` | Open `$VISUAL`/`$EDITOR` for content. Requires a TTY. Mutex with the others. |
| `-` (positional)     | sentinel                    | —       | Read content from stdin to EOF. Mutex with the other content flags.          |
| `--dry-run`          | flag                        | `false` | Skip the POST; envelope echoes `would.path` and `would.body`.                |
| `--output <mode>`    | `auto\|human\|json\|ndjson` | `auto`  | Output mode.                                                                 |

If no content flag is supplied, a name-only note is created and `data.source` is `null`.

## Output schema

`freelo.notes.create/v1`. Envelope `data`:

```json
{
  "project_id": 100,
  "note": { "id": 1234, "name": "Meeting minutes", "content": "...", "...": "..." },
  "byte_length": 1024,
  "source": "message"
}
```

`source` is one of `message | file | editor | stdin | null`.

## Examples

```bash
# Inline content, JSON output
freelo notes create --project 100 --name "Meeting minutes" \
  --content "Discussion notes from 2026-05-10..." --output json

# Content from a file
freelo notes create --project 100 --name "Spec draft" --from-file ./spec.md

# Name-only note
freelo notes create --project 100 --name "Reminder: backup"

# Dry-run preview of the wire body
freelo notes create --project 100 --name "Test" --content "Body" --dry-run
```

## Errors

| Status / source     | Exit | Hint                                                                              |
| ------------------- | ---- | --------------------------------------------------------------------------------- |
| Missing `--project` | 2    | `VALIDATION_ERROR`. Required flag.                                                |
| Missing `--name`    | 2    | `VALIDATION_ERROR`. Required flag, non-empty after trim.                          |
| Empty `--content`   | 2    | `VALIDATION_ERROR`. Empty after trim is rejected to avoid silent body-clobbering. |
| 400                 | 4    | Server-side validation rejected the request.                                      |
| 401                 | 3    | Auth credentials expired or invalid.                                              |
| 403                 | 4    | Account does not have permission to create notes in the project.                  |
| 404                 | 4    | Project not found. Run `freelo projects list` for ids.                            |
| 429                 | 6    | Rate-limited; retry after `Retry-After`.                                          |
| 5xx                 | 4    | Server error; retryable.                                                          |
| Network             | 5    | Connection failed.                                                                |
