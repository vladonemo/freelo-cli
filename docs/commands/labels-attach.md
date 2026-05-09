# freelo labels attach

Attach one or more labels to a project. Each `--name` fans out to one POST. Maps to Freelo's `POST /project-labels/add-to-project/{projectId}` endpoint (data-mode).

> The endpoint is **fetch-or-create** server-side: a name that doesn't yet exist for the caller creates a new label; a name that already exists is re-used. The CLI cannot tell the two paths apart from the response (the server swallows `UniqueConstraintViolationException`), so the envelope **omits `already_in_target_state`** entirely (spec 0035 decision 08).

## Synopsis

```bash
freelo labels attach --project <id> --name <str>... [--palette <name> | --hex <#RRGGBB>]
                     [--private | --public] [--dry-run]
```

## Options

| Flag               | Type / values       | Default | Purpose                                                                                                                                                                                              |
| ------------------ | ------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--project <id>`   | positive int        | —       | **Required.** Numeric project id (target).                                                                                                                                                           |
| `--name <str>...`  | string (repeatable) | —       | One or more label names. Each fans out to one POST.                                                                                                                                                  |
| `--palette <name>` | palette name        | —       | Color applied **only when the server creates a new label**. Resolves a palette name (case-insensitive) to its canonical hex. **Mutex** with `--hex`. See [Palette](#palette). _(R24.5, spec 0048.)_  |
| `--hex <color>`    | `#RRGGBB`           | —       | Color applied **only when the server creates a new label**. Free-form six-digit hex; values outside the palette are silently snapped on the server. **Mutex** with `--palette`. _(See decision 11.)_ |
| `--private`        | bool                | true    | Attach as a private label (caller-only). **Mutex** with `--public`. Default per spec decision 06.                                                                                                    |
| `--public`         | bool                | false   | Attach as a public label. **Mutex** with `--private`.                                                                                                                                                |
| `--dry-run`        | bool                | false   | Skip every POST; envelope echoes `data.would` per name.                                                                                                                                              |

## Palette

Freelo's UI renders nine canonical hues; any hex outside the palette is silently snapped on the server. Prefer `--palette` over `--hex`.

| Name     | Hex       |
| -------- | --------- |
| `gray`   | `#77787A` |
| `aqua`   | `#15ACC0` |
| `blue`   | `#367FEE` |
| `green`  | `#10AA40` |
| `pink`   | `#CA3E99` |
| `purple` | `#9235E4` |
| `red`    | `#E9483A` |
| `orange` | `#F2830B` |
| `yellow` | `#E3B51E` |

`--palette` is case-insensitive. Unknown names fail fast with `VALIDATION_ERROR` (exit 2). `freelo labels attach --help` prints this table inline.

## Permissions

- 403 if the caller lacks project-manager rights when attaching a public label, or if the label is private and caller is not the owner.

## Why no `already_in_target_state`?

The wire body's response is the same `{ result: 'success' }` whether the label was newly created, newly attached, or was already attached. Without a server signal, an `already_in_target_state` field would be a guess. To keep the envelope honest, the field is **omitted** rather than always set to `false`. Agents that need ground truth can call `freelo labels list` before and after and diff.

## Envelope

`schema: "freelo.labels.attach/v1"`

```json
{
  "schema": "freelo.labels.attach/v1",
  "data": {
    "project_id": 7,
    "name": "Billable",
    "is_private": false,
    "color": "#9b59b6"
  },
  "rate_limit": { "remaining": 999, "reset_at": "..." }
}
```

One envelope per `--name`. Dry-run adds `data.would: { method: "POST", path: "/project-labels/add-to-project/7", body: {...} }` and `dry_run: true`.

## Examples

### Attach two labels by name (fetch-or-create)

```bash
$ freelo labels attach --project 7 --name "Billable" --name "On hold" \
    --hex "#9b59b6" --output ndjson
{"schema":"freelo.labels.attach/v1","data":{"project_id":7,"name":"Billable","is_private":true,"color":"#9b59b6"}}
{"schema":"freelo.labels.attach/v1","data":{"project_id":7,"name":"On hold","is_private":true,"color":"#9b59b6"}}
```

### Public label

```bash
$ freelo labels attach --project 7 --name "Billable" --public
Attached "Billable" to project #7.
```

### Attach with a palette color

```bash
$ freelo labels attach --project 7 --name "Bug" --palette red --output json
{"schema":"freelo.labels.attach/v1","data":{"project_id":7,"name":"Bug","is_private":true,"color":"#E9483A"}}
```

## Errors

| Trigger                                 | Code               | Exit |
| --------------------------------------- | ------------------ | ---- |
| Missing `--project` / `--name`          | `VALIDATION_ERROR` | 2    |
| `--private` and `--public` both set     | `VALIDATION_ERROR` | 2    |
| `--palette` and `--hex` both set        | `VALIDATION_ERROR` | 2    |
| Unknown `--palette <name>`              | `VALIDATION_ERROR` | 2    |
| Bad `--hex` (e.g. `#abc`)               | `VALIDATION_ERROR` | 2    |
| Bad `--project` (non-positive int)      | `VALIDATION_ERROR` | 2    |
| 401                                     | `AUTH_EXPIRED`     | 3    |
| 403 (ACL)                               | `FORBIDDEN`        | 4    |
| 404 (project gone — **not** idempotent) | `NOT_FOUND`        | 4    |
| 5xx                                     | `SERVER_ERROR`     | 4    |
| 429                                     | `RATE_LIMITED`     | 6    |

Batch fan-out is **continue-on-error**: a 5xx on the third name doesn't abort the fourth. The CLI exits with the highest exit code observed.

## See also

- `freelo labels detach` — remove a label from a project (idempotent).
- `freelo labels rename` — rename / recolor an existing label.
