# freelo files download

Download a file by UUID. Streams the binary body to a local path (atomic write) or to stdout. Refuses to overwrite an existing destination unless `--force` is set.

> First **binary-streaming** command in the CLI. The body is piped chunk-by-chunk into either a temp file (renamed atomically on success) or `process.stdout`. There is no JSON schema validation on the response body — only on the success metadata envelope.

## Synopsis

```bash
freelo files download <uuid> [-o <path>] [--stdout] [--force] [--no-spinner]
```

## Arguments

| Argument | Notes                                                                                                                                  |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `<uuid>` | UUID of the file to download (from `freelo files list`). Validated locally as a strict 8-4-4-4-12 hex pattern before any network call. |

## Options

| Flag                       | Type / values | Default | Purpose                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-o, --output-path <path>` | string        | —       | Local destination path. Mutex with `--stdout`. Path may be relative; resolved against `process.cwd()`. If the path resolves to an **existing directory**, the file is placed inside it using the inferred filename ([decision 10](../specs/0039-r27-files-download.md#decision-10)). Parent directory must exist. |
| `--stdout`                 | bool          | false   | Stream binary bytes to stdout. JSON envelope is emitted on **stderr** in non-human modes; human mode is silent on stderr.                                                                                                                                                                                         |
| `--force`                  | bool          | false   | Overwrite the destination if it already exists. Meaningless (and rejected as a usage error) with `--stdout`.                                                                                                                                                                                                      |
| `--no-spinner`             | bool          | false   | Disable the TTY progress spinner. Auto-disabled in CI / non-TTY / when `--stdout` is set.                                                                                                                                                                                                                         |

When neither `-o` nor `--stdout` is given, the destination is inferred:

1. **`Content-Disposition: attachment; filename="…"` header** from the response (RFC 6266; the RFC 5987 `filename*=UTF-8''…` percent-encoded form is also recognized).
2. The bare UUID + `.bin` extension as a fallback (e.g. `aaa-…-001.bin`).

The inferred filename has its directory components stripped (`/`, `\`, `..`, leading `.`) and is anchored at `process.cwd()` — a malicious server returning `Content-Disposition: filename="../../etc/passwd"` results in `./passwd`, never anything outside CWD. See [spec 0039 decision 06](../specs/0039-r27-files-download.md).

## Permissions

The caller must have access to a project the file is attached to. The download endpoint is ACL-checked server-side; missing access surfaces as `404` (the same as a missing file — Freelo does not distinguish).

## How `--stdout` interacts with `--output`

| Mode     | `--stdout` | Stdout           | Stderr                 |
| -------- | ---------- | ---------------- | ---------------------- |
| `auto`   | no         | envelope JSON    | (errors / spinner)     |
| `auto`   | yes        | **binary bytes** | envelope JSON          |
| `human`  | no         | one-line summary | (errors / spinner)     |
| `human`  | yes        | **binary bytes** | (silent — errors only) |
| `json`   | no         | envelope JSON    | (errors)               |
| `json`   | yes        | **binary bytes** | envelope JSON          |
| `ndjson` | no         | envelope JSON    | (errors)               |
| `ndjson` | yes        | **binary bytes** | envelope JSON          |

The split is the standard Unix convention: stdout carries the payload, stderr carries the metadata. Agents reading both streams reconstruct the full picture.

## Envelope

`schema: "freelo.files.download/v1"`

```json
{
  "schema": "freelo.files.download/v1",
  "data": {
    "uuid": "aaa00000-0000-0000-0000-000000000001",
    "destination": "/home/user/report.pdf",
    "bytes": 12345,
    "filename": "report.pdf",
    "content_type": "application/pdf",
    "overwrote": false
  },
  "rate_limit": { "remaining": 99, "reset_at": "2026-04-29T19:00:00Z" }
}
```

Field details:

- `uuid` — what you asked for, echoed for trace correlation.
- `destination` — `"stdout"` when `--stdout` was set; otherwise an absolute filesystem path.
- `bytes` — number of bytes actually written. May differ from the server's `Content-Length` header — many origins set `Content-Length` incorrectly when streaming. The CLI reports what it wrote, not what the server said.
- `filename` — server-provided value from `Content-Disposition` (raw — pre-sanitization, for trace correlation). `null` when the header is absent or has no recognizable filename parameter.
- `content_type` — server-provided MIME from `Content-Type`. `null` when absent.
- `overwrote` — `true` only when `-o` pointed to a pre-existing file and `--force` was set.

## Error envelope

`schema: "freelo.error/v1"` on `stderr` (in non-human modes).

| Scenario                                 | `code`             | `exit_code` |
| ---------------------------------------- | ------------------ | ----------- |
| Malformed UUID                           | `VALIDATION_ERROR` | 2           |
| `-o` and `--stdout` together             | `VALIDATION_ERROR` | 2           |
| `--force` with `--stdout`                | `VALIDATION_ERROR` | 2           |
| Destination already exists, no `--force` | `VALIDATION_ERROR` | 2           |
| Parent directory of `-o` does not exist  | `VALIDATION_ERROR` | 2           |
| 401 (auth)                               | `AUTH_EXPIRED`     | 3           |
| 403 / 404 / 5xx                          | `FREELO_API_ERROR` | 4           |
| 429                                      | `RATE_LIMITED`     | 6           |
| Mid-stream network failure               | `NETWORK_ERROR`    | 5           |

On a streaming network failure the temp file is removed (best-effort) and the destination is **not** modified. You can safely retry.

## Examples

```bash
# Default — write to ./<filename> from Content-Disposition (or <uuid>.bin)
freelo files download aaa00000-0000-0000-0000-000000000001 --output json
```

```bash
# Explicit destination (relative or absolute)
freelo files download aaa00000-0000-0000-0000-000000000001 \
  -o ./reports/q4.pdf --output json
```

```bash
# Stream to stdout — pipe to another tool. JSON envelope ends up on stderr.
freelo files download aaa00000-0000-0000-0000-000000000001 \
  --stdout 2>/dev/null | sha256sum
```

```bash
# Force overwrite an existing local file
freelo files download aaa00000-0000-0000-0000-000000000001 \
  -o ./report.pdf --force
```

## Notes

- **No retry on 429.** The download body is an unconsumed stream returned to the caller; retrying after partial consumption is fragile. The CLI surfaces `RateLimitedError` (exit 6) immediately and the agent retries the whole command. See [spec 0039 decision 05](../specs/0039-r27-files-download.md).
- **No partial / range downloads.** The OpenAPI spec does not document `Range` support. Single full-file fetch only.
- **Atomic write.** Files are written via a same-directory temp + rename. Mid-stream failures leave no `.tmp` remnants and never modify the destination.
- **Streaming, not buffered.** A 2 GB download uses constant memory.
- **`--stdout` and EPIPE.** When the consumer closes the pipe early (`| head -c 100`), the CLI treats `EPIPE` as a normal end-of-pipeline signal and exits 0.

## See also

- [`freelo files list`](./files-list.md) — discover UUIDs.
- [`freelo files upload`](./files-upload.md) — produce UUIDs.
- [`freelo files delete`](./files-delete.md) — remove a file or document by UUID.
- [Spec 0039](../specs/0039-r27-files-download.md) — full design doc.
