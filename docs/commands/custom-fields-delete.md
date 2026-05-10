# freelo custom-fields delete

**Soft-delete** one or more custom-field definitions. Existing task values
of these fields are **preserved server-side** and hidden until the field
is restored via `freelo custom-fields restore`.

**Destructive.** Requires `--yes` (non-TTY) or interactive confirmation
(TTY). Non-TTY without `--yes` fails closed with `CONFIRMATION_REQUIRED`
(exit 2) — never hangs.

## Synopsis

```bash
freelo custom-fields delete <uuid>... [--ids <list>] [--stdin] [--yes] [--dry-run]
```

Pick exactly one input source: positional `<uuid>...`, `--ids <list>`, or
`--stdin` (NDJSON `{"uuid": "..."}` per line).

## Options

| Flag           | Type / values        | Default | Purpose                                                                          |
| -------------- | -------------------- | ------- | -------------------------------------------------------------------------------- |
| `<uuid>...`    | UUID list            | —       | One or more positional uuids. Mutex with `--ids` and `--stdin`.                  |
| `--ids <list>` | comma- or whitespace | —       | Inline list of uuids. Mutex with positional and `--stdin`.                       |
| `--stdin`      | flag                 | off     | Read NDJSON from stdin: `{"uuid": "..."}` per line. Mutex with the above.        |
| `--yes` (`-y`) | flag (global)        | off     | Skip confirmation. Required in non-TTY for the command to proceed.               |
| `--dry-run`    | flag                 | off     | Skip the DELETE per uuid. No confirmation prompt fires. Envelope echoes `would`. |

## Wire mapping

`DELETE /custom-field/delete/{uuid}` (yaml :4138-4166).

No body. Response: `{ "result": "success" }` (200).

## Envelope

`schema: freelo.custom-fields.delete/v1` (one envelope per uuid).

| Field                     | Type        | Always present | Notes                                                  |
| ------------------------- | ----------- | -------------- | ------------------------------------------------------ |
| `uuid`                    | string      | yes            | The uuid acted on.                                     |
| `previous_state`          | `null`      | yes            | Reserved (always null v1).                             |
| `current_state`           | `'deleted'` | yes            | Constant.                                              |
| `already_in_target_state` | boolean     | yes            | True iff 404-as-idempotent skip.                       |
| `would`                   | `Would`     | dry-run only   | Method/path/body that would be sent.                   |
| `line_index`              | int         | `--stdin` only | Per-line correlation in NDJSON batch mode (0-indexed). |

## Idempotency

Single-arm 404 heuristic (decision 3, mirrors `freelo labels delete`):

1. **HTTP 404** → `already_in_target_state: true`, exit 0. The field was
   already gone (or never existed).
2. **Any other non-2xx** → re-throw the typed `FreeloApiError`.

This means a script can safely re-run `delete` on the same uuids without
worrying about which ones were already processed in a prior run.

## Validation

| Input                                      | Behaviour                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| No input source                            | `ValidationError` exit 2 — "No custom-field uuids supplied."               |
| Two or more input sources                  | `ValidationError` exit 2 — "Pick exactly one input source ..."             |
| Malformed positional uuid                  | `ValidationError` exit 2 (UUID regex).                                     |
| Malformed uuid in `--ids`                  | `ValidationError` exit 2.                                                  |
| Malformed uuid in NDJSON                   | Per-line `freelo.error/v1` envelope on stdout, exit 2 at end of run.       |
| Empty `--stdin`                            | Silent success, exit 0.                                                    |
| Non-TTY without `--yes` and no `--dry-run` | `ConfirmationError` (`CONFIRMATION_REQUIRED`) exit 2 BEFORE any wire call. |

## Confirmation policy

- `--yes` → unconditional proceed.
- `--dry-run` → unconditional proceed (no destructive effect).
- TTY without `--yes` → interactive prompt: `Delete N custom field(s)?`
  Default is **no**; Enter aborts.
- Non-TTY without `--yes` → `ConfirmationError` exit 2 immediately.

The prompt fires **once** for the whole batch (not once per uuid).

## HTTP error mapping

| Status             | Exit | Behaviour                                          |
| ------------------ | ---- | -------------------------------------------------- |
| `200`              | 0    | Success envelope.                                  |
| `404`              | 0    | Idempotent skip — `already_in_target_state: true`. |
| `401` AUTH_EXPIRED | 3    | (top-level handler)                                |
| `403`              | 4    | (project-commander role required)                  |
| `429` RATE_LIMITED | 6    | (retryable; honour `Retry-After`)                  |
| `5xx`              | 4    | (server error; transient)                          |
| Network failure    | 5    | NETWORK_ERROR.                                     |

In multi-uuid runs, per-uuid envelopes are emitted to **stdout** as the
operation progresses. The exit code is the **highest** code observed (POSIX
"most severe failure dominates"; matches every other batch command).

## Examples

```bash
# Single positional with --yes (agents)
$ freelo custom-fields delete "11111111-..." --yes
{"schema":"freelo.custom-fields.delete/v1","data":{"uuid":"11111111-...","current_state":"deleted","already_in_target_state":false,...}}

# Multi positional
$ freelo custom-fields delete "11111111-..." "22222222-..." --yes
# (one envelope per uuid on stdout)

# --ids
$ freelo custom-fields delete --ids "uuid-a,uuid-b,uuid-c" --yes

# --stdin NDJSON (idempotent re-run friendly)
$ cat ids.ndjson | freelo custom-fields delete --stdin --yes

# Dry-run
$ freelo custom-fields delete "11111111-..." --dry-run
{"schema":"freelo.custom-fields.delete/v1","data":{"uuid":"11111111-...","would":{"method":"DELETE","path":"/custom-field/delete/11111111-...","body":{}},...},"dry_run":true}

# Human mode (TTY default)
$ freelo custom-fields delete "11111111-..." --yes --output human
Deleted custom field 11111111….

# Idempotent re-delete
$ freelo custom-fields delete "11111111-..." --yes --output human
Already deleted: custom field 11111111….
```

## Required Freelo permissions

- **Project commander** role on the field's project. 403 otherwise.

## Related commands

- `freelo custom-fields restore <uuid>` — undo a soft-delete.
- `freelo custom-fields list --project <id>` — discover live (non-deleted) uuids.
- `freelo custom-fields create` — define a replacement.
