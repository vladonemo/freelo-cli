# freelo task-labels create

Bulk-create task-label definitions in the caller's account. Maps to Freelo's `POST /task-labels` endpoint.

> The endpoint is **fetch-or-create** server-side (case-sensitive on `name`): a name that doesn't yet exist is created; an existing name is re-used. The API does not report new vs. reused, so the CLI cannot either. Re-running with the same names is a safe no-op.

## Synopsis

```bash
freelo task-labels create --name <str>... [--palette <name> | --hex <#RRGGBB>] [--dry-run]
```

## Options

| Flag               | Type / values       | Default | Purpose                                                                                                                                                                               |
| ------------------ | ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name <str>...`  | string (repeatable) | —       | **Required.** One or more label names. Each `--name` becomes one entry in the bulk POST.                                                                                              |
| `--palette <name>` | palette name        | —       | Color applied to every `--name` in this call. Resolves a palette name (case-insensitive) to its canonical hex. **Mutex** with `--hex`. See [Palette](#palette). _(R24.5, spec 0048.)_ |
| `--hex <color>`    | `#RRGGBB`           | —       | Color applied to every `--name`. Free-form six-digit hex; values outside the palette are silently snapped on the server. **Mutex** with `--palette`. _(Spec 0036 decision 02 / 04.)_  |
| `--dry-run`        | bool                | false   | Skip the POST; envelope echoes the wire body in `would`.                                                                                                                              |

`--output`, `--profile`, `-v`/`-vv`, `--request-id` are inherited global flags.

## Palette

Freelo's UI renders nine canonical hues; any hex outside the palette is silently snapped on the server. Prefer `--palette` over `--hex` so the resolved color matches the UI exactly.

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

`--palette` is case-insensitive (`red`, `Red`, `RED` all resolve to `#E9483A`). Unknown names fail fast with `VALIDATION_ERROR` (exit 2); the error's `hint_next` enumerates the nine accepted values. `freelo task-labels create --help` prints this table inline.

## Permissions

- The caller account scope is implicit. No explicit project ACL — task-labels live at the account level.

## Envelope

`schema: "freelo.task_labels.create/v1"`

```json
{
  "schema": "freelo.task_labels.create/v1",
  "data": {
    "labels": [
      { "name": "Bug", "color": "#E9483A" },
      { "name": "Wip", "color": "#E9483A" }
    ],
    "count": 2
  },
  "rate_limit": { "remaining": 999, "reset_at": "..." }
}
```

`labels` reflects the user's intent (the same names + color that went on the wire), not server-confirmed state. The server returns `{ result: 'success' }` only.

Dry-run adds `data.would: { method: "POST", path: "/task-labels", body: {...} }` and `dry_run: true` at the top level.

## Examples

### Create two task-labels with a palette color

```bash
$ freelo task-labels create --name "Bug" --name "Wip" --palette red --output json
{"schema":"freelo.task_labels.create/v1","data":{"labels":[{"name":"Bug","color":"#E9483A"},{"name":"Wip","color":"#E9483A"}],"count":2}}
```

### Free-form hex

```bash
$ freelo task-labels create --name "Custom" --hex "#9b59b6"
Created or matched 1 task label.
```

### Dry-run

```bash
$ freelo task-labels create --name "Bug" --palette green --dry-run --output json
{"schema":"freelo.task_labels.create/v1","dry_run":true,"data":{"labels":[{"name":"Bug","color":"#10AA40"}],"count":1,"would":{"method":"POST","path":"/task-labels","body":{"labels":[{"name":"Bug","color":"#10AA40"}]}}}}
```

## Errors

| Trigger                          | Code               | Exit |
| -------------------------------- | ------------------ | ---- |
| Missing `--name`                 | `VALIDATION_ERROR` | 2    |
| Empty `--name` (whitespace only) | `VALIDATION_ERROR` | 2    |
| `--palette` and `--hex` both set | `VALIDATION_ERROR` | 2    |
| Unknown `--palette <name>`       | `VALIDATION_ERROR` | 2    |
| Bad `--hex` (e.g. `#abc`)        | `VALIDATION_ERROR` | 2    |
| 401                              | `AUTH_EXPIRED`     | 3    |
| 5xx                              | `SERVER_ERROR`     | 4    |
| 429                              | `RATE_LIMITED`     | 6    |

## See also

- `freelo task-labels attach` — attach a task-label to one or more tasks.
- `freelo task-labels detach` — detach a task-label.
