---
"freelo-cli": minor
---

feat(commands): r27 — `freelo files download <uuid> [-o <path>] [--stdout] [--force]`.

- New leaf under the existing `files` namespace. Streams the binary body of `GET /file/{file_uuid}` to a local file (atomic temp + rename) or to `process.stdout`.
- New envelope schema: `freelo.files.download/v1` (additive — `uuid`, `destination`, `bytes`, `filename`, `content_type`, `overwrote`).
- Additive `HttpClient.requestBinary` method on `src/api/client.ts` — companion to `request()` and `requestMultipart()`. Does **not** retry on 429 (decision 05). Does not modify the existing `request()` / `requestMultipart()` code paths or their error / auth / rate-limit semantics.
- New shared helpers: `src/lib/format.ts` (`humanizeBytes`, consolidated from R26's renderer) and `src/lib/filename.ts` (`parseContentDisposition`, `sanitizeBasename` — RFC 6266 + path-traversal defense).
- Path-traversal-safe filename inference: a malicious `Content-Disposition: filename="../../etc/passwd"` is sanitized to a bare basename anchored at `process.cwd()`. Explicit `-o <path>` is taken at face value (user intent).
- Refuse to overwrite an existing destination unless `--force` is set; non-TTY callers get a clean `VALIDATION_ERROR` exit 2 instead of silent data loss.
- `--stdout` reroutes the success envelope to stderr so binary on stdout stays clean. Human mode is silent on stderr in this combination (no chatter when piping to a tool).
- Lazy `ora` spinner on TTY (auto-disabled when `--stdout` / CI / non-TTY / `--no-spinner`).
