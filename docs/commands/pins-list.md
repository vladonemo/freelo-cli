# freelo pins list

List all pinned items on a project (links, tasks, documents, files, project-links, project-directories). Read-only.

The response is **ACL-filtered server-side**: pins whose target the caller cannot see are silently omitted.

The endpoint returns a flat array — no pagination.

## Synopsis

```bash
freelo pins list --project <id> [--output <mode>]
```

## Options

| Flag              | Type / values               | Default | Purpose                       |
| ----------------- | --------------------------- | ------- | ----------------------------- |
| `--project <id>`  | positive integer            | —       | Target project id (required). |
| `--output <mode>` | `auto\|human\|json\|ndjson` | `auto`  | Output mode.                  |

No `--dry-run` — read commands have nothing to dry-run.

## Output schema

`freelo.pins.list/v1`. Envelope `data`:

```json
{
  "project_id": 100,
  "pins": [
    { "id": 1, "link": "https://example.com/spec", "title": "Spec doc" },
    { "id": 2, "link": "https://example.com/wiki", "title": "Wiki" }
  ]
}
```

Empty `pins: []` is valid (project has no visible pins).

## Examples

```bash
# JSON output
freelo pins list --project 100 --output json

# Human-readable table in a TTY
freelo pins list --project 100
```

## Errors

| Status  | Exit | Hint                                                                  |
| ------- | ---- | --------------------------------------------------------------------- |
| 401     | 3    | Auth credentials expired or invalid.                                  |
| 403     | 4    | Account does not have permission to read pinned items on the project. |
| 404     | 4    | Project not found. Run `freelo projects list` for ids.                |
| 429     | 6    | Rate-limited; retry after `Retry-After`.                              |
| 5xx     | 4    | Server error; retryable.                                              |
| Network | 5    | Connection failed.                                                    |
