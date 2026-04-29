---
'freelo-cli': minor
---

R25 — `freelo files upload <path>... [--attach-to-task <id>] [--message <str>] [--dry-run] [--no-spinner]`. First multipart-body command in the CLI. Uploads one or more local files to Freelo via `POST /file/upload` and, optionally, posts a comment on a task that references each upload via the documented `<a data-freelo-uuid="UUID">filename</a>` anchor mechanism (yaml :3876).

```
freelo files upload <path>... [--attach-to-task <id>] [--message <str>]
                              [--dry-run] [--no-spinner]
```

**One new envelope schema (additive):**

- `freelo.files.upload/v1` — `data: { uploaded[], failed[], count, attached?, would? }`.

Per-path partial-failure semantics: when some uploads succeed and some fail, the command exits 4 with both arrays populated (and posts the comment with the surviving UUIDs if `--attach-to-task` is set). When zero succeed, the original typed error is re-thrown so single-path callers get the natural exit code.

**Wire bindings (OpenAPI `docs/api/freelo-api.yaml`):**

- Upload → `POST /file/upload` (yaml :3867) — `multipart/form-data` with a single `file` field. Hard 100 MB limit (yaml :3873). Response is `{ uuid }`.
- Attach → `POST /task/{task_id}/comments` (yaml :2575) — content embeds `<a data-freelo-uuid>` anchors. The OpenAPI spec contradicts itself on the `comments.files[]` field (the global `FileUpload` schema requires `download_url`, which the upload response does NOT return). The anchor approach is the documented fallback (spec 0037 decision 02).

**New shared helper:**

- `src/lib/multipart.ts` — `buildFileMultipart(absPath)` builds a `FormData` body via the global `FormData` (provided by undici under the hood in Node 20+). Local validation (existence, regular file, ≤100 MB) — typed `ValidationError` exit 2 on violation. **Reusable** by future R26 / R27 (`files list` / `files download`) if needed.

**Additive `HttpClient` method:**

- `HttpClient.requestMultipart(opts)` — does NOT touch the existing `request()` method. Same Authorization / User-Agent / 401 / 4xx / 5xx error mapping. `Content-Type` header is intentionally omitted — `fetch` sets it (with boundary) when the body is a `FormData` instance. Multipart writes do NOT retry on 429 (writes never retry today; multipart inherits the rule).

**Lazy `ora` spinner (TTY only):**

- `await import('ora')` is gated by `isInteractive() && !opts.noSpinner`. Auto-disabled in CI / non-TTY / piped output. `--no-spinner` is a hard override (decision 04).

**Filename safety:** filenames spliced into comment HTML are escaped (`<>&"'` → entities). Original (raw) filenames remain in `data.uploaded[].filename` for agent assertions (spec 0037 decision 09).

**Validation (each typed-error path has an exit-code test — Calibration §2):**

- Missing path / directory / oversize → `ValidationError` exit 2.
- `--attach-to-task` non-positive / non-integer → `ValidationError` exit 2.
- Whitespace-only `--message` → `ValidationError` exit 2.
- Upload 4xx/5xx → `FreeloApiError` exit 4.
- Upload 401 → `FreeloApiError` AUTH_EXPIRED exit 3.
- Upload 429 → `RateLimitedError`.
- Comment-create error after upload success → exit 4 (envelope still includes `uploaded[]` for recovery).

**Agent-safe contract reused:**

- `--dry-run` validates locally, emits envelope with `data.would` as an **array** (1..N+1 entries) — pluralization decision 10 vs. existing single-object `would`.
- Variadic positional `<path>...` instead of `--ids` / `--stdin` — file paths are fundamentally positional (decision per spec §1 non-goals).
- Sequential uploads (decision 08) — parallelism is one `--concurrency N` flag away if real workloads need it.

**Reviewer flag — additive change to `src/api/client.ts`:** the new `requestMultipart` method is purely additive (no signature, retry, auth, or default change to existing `request()`), but it does live in the file the autonomous-sdlc Red trigger lists by name. Spec 0037 decision 01 keeps this Yellow-tier; tagging here for visibility on PR review.

No new runtime dependencies — `undici` and `ora` were already pinned.
