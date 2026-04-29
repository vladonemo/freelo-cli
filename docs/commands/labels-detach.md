# freelo labels detach

Detach one or more labels from a project. The label itself is preserved at the workspace level — it can always be re-attached. Maps to Freelo's `POST /project-labels/remove-from-project/{projectId}` endpoint (id-mode).

> The wire verb is **POST**, not DELETE. The roadmap line said DELETE; the OpenAPI is authoritative (`removeProjectLabelFromProject` is `post:`). (Spec 0035 decision 02.)

## Synopsis

```bash
freelo labels detach --project <id> --label <id>... [--dry-run]
freelo labels detach --project <id> --ids <list>     [--dry-run]
freelo labels detach --project <id> --stdin          [--dry-run]
```

## Options

| Flag              | Type / values         | Default | Purpose                                                                   |
| ----------------- | --------------------- | ------- | ------------------------------------------------------------------------- |
| `--project <id>`  | positive int          | —       | **Required.** Project to detach from.                                     |
| `--label <id>...` | positive int (repeat) | —       | One or more label ids. Mutex with `--ids` and `--stdin`.                  |
| `--ids <list>`    | comma/space list      | —       | Numeric label ids in a single string. Mutex with `--label` and `--stdin`. |
| `--stdin`         | bool                  | false   | NDJSON: one `{"label": <int>}` per line (`{"id": <int>}` also accepted).  |
| `--dry-run`       | bool                  | false   | Skip every POST; envelope echoes `data.would` per id.                     |

No `--yes` / no confirmation prompt — `detach` is non-destructive at the workspace level.

## Idempotency

Two-arm heuristic (spec 0035 decision 09):

1. **HTTP 404** — Label was not attached to the project. Envelope reports `already_in_target_state: true`, exit 0.
2. **Other non-2xx** — Hard error.

## Envelope

`schema: "freelo.labels.detach/v1"`

```json
{
  "schema": "freelo.labels.detach/v1",
  "data": {
    "project_id": 7,
    "label_id": 12,
    "previous_state": null,
    "current_state": "detached",
    "already_in_target_state": false
  },
  "rate_limit": { "remaining": 999, "reset_at": "..." }
}
```

`current_state` is `"detached"` (not `"deleted"` — the label is preserved). Dry-run adds `data.would: { method: "POST", path: "/project-labels/remove-from-project/7", body: { id: 12 } }` and `dry_run: true`. `--stdin` mode adds `data.line_index`.

## Examples

### Detach two labels — one is a no-op (404 → idempotent)

```bash
$ freelo labels detach --project 7 --label 12 --label 99999 --output ndjson
{"schema":"freelo.labels.detach/v1","data":{"project_id":7,"label_id":12,"previous_state":null,"current_state":"detached","already_in_target_state":false}}
{"schema":"freelo.labels.detach/v1","data":{"project_id":7,"label_id":99999,"previous_state":null,"current_state":"detached","already_in_target_state":true}}
```

(Label 99999 wasn't on project 7 — server returned 404, CLI re-classified as idempotent skip.)

### Pipe NDJSON

```bash
$ printf '{"label":12}\n{"label":13}\n' | \
    freelo labels detach --project 7 --stdin --output json
```

## Errors

| Trigger                                        | Code                 | Exit |
| ---------------------------------------------- | -------------------- | ---- |
| Missing `--project` / no input source          | `VALIDATION_ERROR`   | 2    |
| Multiple input sources                         | `VALIDATION_ERROR`   | 2    |
| Bad `--label` / `--project` (non-positive int) | `VALIDATION_ERROR`   | 2    |
| 401                                            | `AUTH_EXPIRED`       | 3    |
| 403                                            | `FORBIDDEN`          | 4    |
| 404                                            | (idempotent, exit 0) | 0    |
| 5xx                                            | `SERVER_ERROR`       | 4    |
| 429                                            | `RATE_LIMITED`       | 6    |

Batch fan-out is **continue-on-error**: a 5xx on one row doesn't abort the rest. The CLI exits with the highest exit code observed.

## See also

- `freelo labels attach` — attach (fetch-or-create) a label to a project.
- `freelo labels delete` — global hard-delete (different — destructive).
