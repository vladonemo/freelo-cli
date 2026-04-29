# freelo labels rename

Rename, recolor, or flip privacy on an existing project label. Maps to Freelo's `POST /project-labels/{labelId}` endpoint.

> The wire verb is **POST**, not PATCH. The roadmap line said PATCH; the OpenAPI is authoritative. Same precedent as R18 `comments edit` and R20 `time edit`. (Spec 0035 decision 01.)

## Synopsis

```bash
freelo labels rename <id> [--name <str>] [--hex <color>]
                          [--is-private | --is-public] [--dry-run]
```

At least one of `--name`, `--hex`, `--is-private`, `--is-public` is required — empty edit fails fast with `VALIDATION_ERROR` (exit 2).

## Options

| Flag            | Type / values | Default | Purpose                                                                                                                                             |
| --------------- | ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<id>`          | positive int  | —       | **Required positional.** Numeric label id from `freelo labels list`.                                                                                |
| `--name <str>`  | string        | —       | New label name.                                                                                                                                     |
| `--hex <color>` | `#RRGGBB`     | —       | New label color in six-hex-digit form. Named `--hex` (not `--color`) to avoid collision with the global `--color <mode>` flag. _(See decision 11.)_ |
| `--is-private`  | bool          | false   | Flip the label to private. **Mutex** with `--is-public`.                                                                                            |
| `--is-public`   | bool          | false   | Flip the label to public. **Mutex** with `--is-private`.                                                                                            |
| `--dry-run`     | bool          | false   | Skip the POST; envelope echoes the body that would have gone on the wire.                                                                           |

`--output`, `--profile`, `-v`/`-vv`, `--request-id` are inherited global flags.

## Permissions

- The label owner can rename, recolor, or flip private↔public freely.
- Project managers may edit public labels under their projects but **may not** flip a public label private (server returns 403). The CLI surfaces the error verbatim.

## Envelope

`schema: "freelo.labels.rename/v1"`

```json
{
  "schema": "freelo.labels.rename/v1",
  "data": {
    "label_id": 12,
    "applied_changes": {
      "name": "Billable",
      "color": "#9b59b6",
      "is_private": false
    }
  },
  "rate_limit": { "remaining": 999, "reset_at": "..." }
}
```

`applied_changes` reflects **the user's intent**, not server-confirmed state — the server returns `{ result: 'success' }` only and does not echo the new label state. Same caveat as `freelo time edit` and `freelo reports edit`.

Dry-run adds `data.would: { method: "POST", path: "/project-labels/12", body: {...} }` and `dry_run: true` at the top level.

## Examples

### Recolor + rename in one call

```bash
$ freelo labels rename 12 --name "Billable" --hex "#9b59b6" --output json
{"schema":"freelo.labels.rename/v1","data":{"label_id":12,"applied_changes":{"name":"Billable","color":"#9b59b6"}}}
```

### Flip private → public (TTY)

```bash
$ freelo labels rename 12 --is-public
Renamed label #12 (is_private=false).
```

## Errors

| Trigger                                    | Code               | Exit |
| ------------------------------------------ | ------------------ | ---- |
| Empty edit (no change flag)                | `VALIDATION_ERROR` | 2    |
| `--is-private` and `--is-public` both set  | `VALIDATION_ERROR` | 2    |
| Bad `--hex` (e.g. `#abc`)                  | `VALIDATION_ERROR` | 2    |
| 401                                        | `AUTH_EXPIRED`     | 3    |
| 403 (ACL — e.g. flip public label private) | `FORBIDDEN`        | 4    |
| 404 (label gone — **not** idempotent)      | `NOT_FOUND`        | 4    |
| 5xx                                        | `SERVER_ERROR`     | 4    |
| 429                                        | `RATE_LIMITED`     | 6    |

## See also

- `freelo labels list` — discover label ids.
- `freelo labels delete` — global hard-delete (irreversible).
