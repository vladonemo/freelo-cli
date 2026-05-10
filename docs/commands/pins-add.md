# freelo pins add

Pin a URL to a project.

**The wire field is `link`, not `url`** — the CLI flag mirrors the API exactly.

**Server-side dispatcher:**

- **Internal-resource URLs** (tasks, documents, files, project-links, project-directories) are **fetch-or-create idempotent** — the server returns the existing pin if one already exists for the same target.
- **External URLs** always create a new pin row, even on duplicate.

The CLI does **not** distinguish the two cases client-side. It surfaces whatever the server returns. Agents who care about deduplication can call `freelo pins list` first.

No client-side URL syntax validation — Freelo's URL recognizer is canonical.

## Synopsis

```bash
freelo pins add --project <id> --link <url> [--title <str>] [--dry-run]
```

## Options

| Flag              | Type / values               | Default | Purpose                                                                          |
| ----------------- | --------------------------- | ------- | -------------------------------------------------------------------------------- |
| `--project <id>`  | positive integer            | —       | Target project id (required).                                                    |
| `--link <url>`    | URL string                  | —       | Full URL to pin (required, non-empty after trim).                                |
| `--title <str>`   | string                      | —       | Optional display title. If omitted, the server derives one from the link target. |
| `--dry-run`       | flag                        | `false` | Skip the POST; envelope echoes `would.path` and `would.body`.                    |
| `--output <mode>` | `auto\|human\|json\|ndjson` | `auto`  | Output mode.                                                                     |

## Output schema

`freelo.pins.add/v1`. Envelope `data`:

```json
{
  "project_id": 100,
  "pin": { "id": 99, "link": "https://example.com/spec", "title": "Spec doc" },
  "applied_link": "https://example.com/spec",
  "applied_title": "Spec doc"
}
```

`applied_title` is omitted when `--title` was not passed.

## Examples

```bash
# External link with a custom title
freelo pins add --project 100 \
  --link "https://example.com/spec" --title "Spec doc" --output json

# Internal-resource link (fetch-or-create idempotent server-side)
freelo pins add --project 100 \
  --link "https://app.freelo.io/task/123456"

# Dry-run preview
freelo pins add --project 100 --link "https://x" --title "X" --dry-run
```

## Errors

| Status / source     | Exit | Hint                                                                                                          |
| ------------------- | ---- | ------------------------------------------------------------------------------------------------------------- |
| Missing `--project` | 2    | `VALIDATION_ERROR`. Required flag.                                                                            |
| Missing `--link`    | 2    | `VALIDATION_ERROR`. Required flag, non-empty after trim.                                                      |
| Empty `--title`     | 2    | `VALIDATION_ERROR`. Empty after trim is rejected when supplied — omit `--title` to let the server derive one. |
| 400                 | 4    | Server-side validation rejected the request; verify `--link` is well-formed.                                  |
| 401                 | 3    | Auth credentials expired or invalid.                                                                          |
| 403                 | 4    | Account does not have permission to pin items in the project.                                                 |
| 404                 | 4    | Project not found. Run `freelo projects list` for ids.                                                        |
| 429                 | 6    | Rate-limited; retry after `Retry-After`.                                                                      |
| 5xx                 | 4    | Server error; retryable.                                                                                      |
| Network             | 5    | Connection failed.                                                                                            |
