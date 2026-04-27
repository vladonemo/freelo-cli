# freelo tasks description get

Print one task's rich-text description (the canonical body of the task —
what shows in the Freelo UI as the long-form description above the comment
thread).

## Synopsis

```bash
freelo tasks description get <id>
```

## Arguments

| Argument | Type             | Notes                                                    |
| -------- | ---------------- | -------------------------------------------------------- |
| `<id>`   | positive integer | Task id from `freelo tasks list` or `freelo tasks show`. |

`--output`, `--color`, `--profile`, `-v/-vv`, `--request-id` are inherited
global flags.

## Permissions

- API key with read access to the task. Without permission, `GET` returns
  403 (`FORBIDDEN`, exit 4) with a hint mentioning `permission`.
- The task must exist (or 404 → `NOT_FOUND`, exit 4).

## Empty descriptions

The Freelo API returns 200 even for tasks with no description set —
`data.description.id` and `data.description.content` will be `null` in
that case. The CLI does not synthesise a "missing" sentinel; consumers
should read `data.description.content` and treat `null` / `""` as "no
description".

## Envelope

`schema: "freelo.tasks.description.get/v1"`

### Success

```json
{
  "schema": "freelo.tasks.description.get/v1",
  "data": {
    "task_id": 9012,
    "description": {
      "id": 999001,
      "content": "<p>Task body — rich text.</p>",
      "date_add": "2026-04-27T10:00:00Z",
      "files": []
    }
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-04-27T20:30:00Z" }
}
```

### Empty description

```json
{
  "schema": "freelo.tasks.description.get/v1",
  "data": {
    "task_id": 9012,
    "description": { "id": null, "content": null, "date_add": null, "files": [] }
  }
}
```

## Examples

### Read a description

```bash
$ freelo tasks description get 9012
Task #9012 description:
<p>Task body — rich text.</p>
Updated 2026-04-27T10:00:00Z
```

### Pipe to a Markdown converter

```bash
$ freelo tasks description get 9012 --output json | jq -r .data.description.content | pandoc -f html -t markdown
```

### Detect "no description set"

```bash
$ HAS_DESC=$(freelo tasks description get 9012 --output json | jq '.data.description.content != null and .data.description.content != ""')
$ echo "Task has description: $HAS_DESC"
```

## Errors

| Trigger                           | code               | exit |
| --------------------------------- | ------------------ | ---- |
| `<id>` non-numeric / non-positive | `VALIDATION_ERROR` | 2    |
| 401                               | `AUTH_EXPIRED`     | 3    |
| 403                               | `FORBIDDEN`        | 4    |
| 404                               | `NOT_FOUND`        | 4    |
| 5xx                               | `SERVER_ERROR`     | 4    |
| 429                               | `RATE_LIMITED`     | 6    |
| Network failure                   | `NETWORK_ERROR`    | 5    |

See [spec 0026](../specs/0026-tasks-description.md) for the full design,
the wire details, and the mandatory test list.
