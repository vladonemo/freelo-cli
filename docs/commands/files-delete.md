# freelo files delete

Delete one or more files or documents/notes by UUID.

> The endpoint resolves **which kind** the UUID refers to, so one command covers both files and
> documents/notes. Deletion is a **soft delete** — the resource is marked deleted, not physically removed —
> and there is no undelete endpoint.

## Synopsis

```bash
freelo files delete [uuid...] [--ids <list>] [--stdin] [--dry-run] [--yes]
```

## Arguments

| Argument    | Notes                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[uuid...]` | One or more file or document UUIDs (from `freelo files list`). Validated locally as a strict 8-4-4-4-12 hex pattern before any network call. Mutually exclusive with `--ids` and `--stdin`. |

## Options

| Flag           | Type / values | Default | Purpose                                                                                                      |
| -------------- | ------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `--ids <list>` | string        | —       | Comma- or space-separated list of UUIDs. Mutex with positional `<uuid>` and `--stdin`.                       |
| `--stdin`      | bool          | false   | Read NDJSON from stdin, one `{"uuid": "<string>"}` per line. Mutex with positional and `--ids`.              |
| `--dry-run`    | bool          | false   | Skip every `DELETE` **and** the confirmation prompt. The envelope echoes the call that would have been made. |
| `--yes`, `-y`  | bool          | false   | **Global flag.** Bypasses the confirmation prompt. Required in non-TTY contexts (CI, pipes, agents).         |

Exactly one input source must be supplied. Zero sources is a usage error (exit 2); more than one is a usage
error (exit 2). An input source that resolves to zero UUIDs — an empty `--stdin` pipe — is a **silent
success**, exit 0.

There is no `-` stdin sentinel: delete has no content to read, so `-` is rejected as a malformed UUID.

## Confirmation

This command is destructive, so it goes through the shared confirmation gate:

| Situation           | Behavior                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `--yes`             | Proceeds silently.                                                                                    |
| `--dry-run`         | Proceeds silently — nothing is destroyed, so there is nothing to gate.                                |
| TTY, no `--yes`     | Prompts once for the whole run (`Delete 3 files or documents?`), defaulting to no. Declining exits 2. |
| Non-TTY, no `--yes` | Fails closed immediately: `CONFIRMATION_REQUIRED`, exit 2. No wire calls, no credential resolution.   |

The prompt fires **once per invocation**, not once per UUID. With `--stdin` it fires after the pipe has been
buffered, so an empty pipe never prompts.

## Permissions

You must be able to see the resource — the endpoint is ACL-checked server-side, and Freelo does not
distinguish "missing" from "not yours" (both are `404`). See the next section for why that matters here.

## Why a 404 is an error here, not an "already deleted" success

Most deletes in this CLI — `freelo tasks delete`, for instance — treat a `404` as an **idempotent success**
and report `already_in_target_state: true`. **`files delete` deliberately does not.** A `404` is a real
error, exit 4.

The reason is in Freelo's own API documentation for this endpoint: it returns `404` when no file or document
matches the UUID **or when the caller has no access to it**. Those are two very different realities behind
one status code:

- The resource is genuinely gone — absorbing this into a success would be correct.
- The resource exists and is perfectly fine, but lives in a project you can't see — absorbing this would
  print "deleted" and exit `0` for a document that is **still there, untouched**.

That second case is the one failure mode a delete command must never have, and it isn't hypothetical: a UUID
can easily be copied from a colleague, a wiki, or a CI log. So the CLI reports what it actually knows.

For the same reason the error message stays a plain not-found and never claims a permission problem — the
CLI genuinely cannot tell which case it hit. The ambiguity is spelled out in `hint_next`:

```json
{
  "schema": "freelo.error/v1",
  "error": {
    "code": "NOT_FOUND",
    "message": "File or document 00000000-0000-4000-8000-000000000000 not found.",
    "http_status": 404,
    "retryable": false,
    "hint_next": "It may not exist, it may already be deleted, or you may not have access to it — Freelo returns 404 rather than 403 for resources you cannot see, so the cases are indistinguishable from the API (docs/api/freelo-api.yaml :4504). Run `freelo files list` to see what is visible to you."
  }
}
```

One consequence worth knowing: passing the **same UUID twice** in one invocation reports the second as a
`404` error. That is the honest outcome given the above. De-duplicate upstream if you need tolerance.

See [spec 0064 §5.1](../specs/0064-m07-files-delete.md) for the full derivation.

## Envelope

`schema: "freelo.files.delete/v1"`

```json
{
  "schema": "freelo.files.delete/v1",
  "data": {
    "uuid": "3f7c1e2a-9b4d-4c8e-a1f0-6d5b8e2c7a41",
    "current_state": "deleted",
    "already_in_target_state": false
  },
  "rate_limit": { "remaining": 4998, "reset_at": "2026-08-28T21:00:00Z" }
}
```

| Field                     | Notes                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `uuid`                    | The UUID you asked to delete, echoed for trace correlation.                                                                 |
| `current_state`           | Always `"deleted"`.                                                                                                         |
| `already_in_target_state` | Always `false` in v1 — see the 404 section above. Present so agents can read one uniform field across every delete command. |
| `would`                   | Present only with `--dry-run`: `{ "method": "DELETE", "path": "/file/<uuid>", "body": {} }`.                                |
| `line_index`              | Present only in `--stdin` mode: the 0-based input line, so you can correlate output back to input.                          |

The envelope carries **no** `type` / `kind` field. The API resolves file-vs-document server-side and its
response says nothing about which it removed, so reporting a kind would be a guess. If you need to know what
a UUID points at, read `type` from `freelo files list` _before_ deleting.

One envelope is emitted per UUID.

## Examples

Delete a single document interactively:

```console
$ freelo files delete 3f7c1e2a-9b4d-4c8e-a1f0-6d5b8e2c7a41
? Delete 1 file or document? (y/N) y
Deleted file or document 3f7c1e2a-9b4d-4c8e-a1f0-6d5b8e2c7a41.
```

Check what a batch would do before committing to it:

```console
$ freelo files delete --ids "3f7c1e2a-9b4d-4c8e-a1f0-6d5b8e2c7a41,8a2b6c04-1e5f-4a9d-b3c7-2f8e0d1a4b56" \
    --dry-run --output json
{"schema":"freelo.files.delete/v1","data":{"uuid":"3f7c1e2a-9b4d-4c8e-a1f0-6d5b8e2c7a41","current_state":"deleted","already_in_target_state":false,"would":{"method":"DELETE","path":"/file/3f7c1e2a-9b4d-4c8e-a1f0-6d5b8e2c7a41","body":{}}},"dry_run":true}
{"schema":"freelo.files.delete/v1","data":{"uuid":"8a2b6c04-1e5f-4a9d-b3c7-2f8e0d1a4b56","current_state":"deleted","already_in_target_state":false,"would":{"method":"DELETE","path":"/file/8a2b6c04-1e5f-4a9d-b3c7-2f8e0d1a4b56","body":{}}},"dry_run":true}
```

Prune the build artifacts a pipeline uploaded, composing with `files list`:

```bash
freelo files list --project 372 --type file --output json \
  | jq -c '.data.items[] | select(.name | startswith("build-")) | {uuid}' \
  | freelo files delete --stdin --yes
```

## Batch behavior

- **Single UUID**: the error bubbles normally — one error envelope on **stderr**, exit code from that error.
- **Multiple UUIDs** (`--ids`, several positionals, or `--stdin`): processing **continues past failures**.
  Successes and per-item `freelo.error/v1` envelopes are interleaved on **stdout** in input order, and the
  **highest** exit code wins at the end.

Per-item error envelopes carry a `context` object: `line_index` (from `--stdin`) or `input_index`
(positional / `--ids`), plus `uuid` when the item parsed.

```console
$ freelo files delete <good-uuid> <missing-uuid> --yes --output json
{"schema":"freelo.files.delete/v1","data":{"uuid":"<good-uuid>","current_state":"deleted","already_in_target_state":false},…}
{"schema":"freelo.error/v1","error":{"code":"NOT_FOUND","message":"File or document <missing-uuid> not found.",…,"context":{"input_index":1,"uuid":"<missing-uuid>"}}}
$ echo $?
4
```

## Exit codes

| Code | When                                                                                         |
| ---- | -------------------------------------------------------------------------------------------- |
| 0    | All deletions succeeded (or the input resolved to zero UUIDs).                               |
| 2    | Usage / validation error, or `CONFIRMATION_REQUIRED` (non-TTY without `--yes`, or declined). |
| 3    | `AUTH_EXPIRED` — credentials rejected (401).                                                 |
| 4    | API error, including `NOT_FOUND` (404), `FORBIDDEN` (403), rate limiting, and 5xx.           |

## See also

- [`freelo files list`](./files-list.md) — find the UUIDs you can delete, and their `type`.
- [`freelo files upload`](./files-upload.md) — the other half of the write surface.
- [`freelo files download`](./files-download.md) — take a copy before you delete.
- [spec 0064](../specs/0064-m07-files-delete.md) — design rationale.
