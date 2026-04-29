# Spec 0039 — `freelo files download` (R27)

**Run:** 2026-04-29-1826-r27-files-download
**Tier:** Yellow (with `client.ts` Yellow-with-asterisk note + security review)
**Roadmap:** R27 (`docs/roadmap.md:500-504`)
**Depends on:** R25 (`files upload` — `src/commands/files.ts` namespace, `src/api/files.ts`, `src/api/schemas/file.ts`), R26 (`files list` — sibling leaf for namespace registration pattern)

---

## 1. Problem

After R25 (upload) and R26 (list), agents can push assets to Freelo and
enumerate what's there. They still cannot **fetch** the bytes. R27 closes
that with the third leaf under `freelo files`:

```
freelo files download <uuid> [-o <path>] [--stdout] [--force]
```

R27 is the **first command in the CLI that streams a binary response body**
to a file or stdout. Every prior write/read returns JSON parsed against a
zod schema; download has no JSON to parse and the body can be arbitrarily
large.

## 2. OpenAPI verification

`docs/api/freelo-api.yaml:3835-3865` — `GET /file/{file_uuid}`:

- **Path:** `/file/{file_uuid}` (UUID v4 format).
- **Method:** GET.
- **Response 200:** `Content-Type: application/octet-stream`,
  `schema: { type: string, format: binary }`. Direct binary stream — **no
  redirect** documented.
- **Response 404:** file does not exist, was deleted, or caller has no access.
- **Header `Content-Disposition`:** the original filename (per docs prose at
  yaml:3848 — "Content-Disposition header carries the original filename").
- **Header `Content-Type`:** derived from stored MIME type (yaml:3848).

The OpenAPI spec is sufficient. **No pause for API behavior.** No 3xx
redirect handling, no JSON envelope on success, no schema-validated body.

### What we explicitly do **not** call

- `/file/upload` — that's R25.
- `/all-docs-and-files` — R26.
- No Range/partial-content support documented in the spec — full-file fetch
  only.

## 3. CLI surface

### 3.1 New leaf under existing `files` namespace

```
freelo files download <uuid> [-o <path>] [--stdout] [--force]
```

R26 already updated `src/commands/files.ts` to delegate to two leaves
(`registerUpload`, `registerList`). R27 adds `registerDownload` as the third
sibling. No change to `src/bin/freelo.ts` (`registerFiles` is already wired).

### 3.2 Flag reference

| Flag | Type / values | Default | Notes |
|---|---|---|---|
| `<uuid>` | UUID-shaped string (positional) | required | The `file_uuid` in the wire path. Validated as a UUID v4 (8-4-4-4-12 hex pattern); strict to keep agents honest. |
| `-o, --output-path <path>` | string | (inferred — see §3.3) | Local destination path. Mutex with `--stdout`. May be relative; resolved against `process.cwd()`. |
| `--stdout` | boolean | false | Pipe binary bytes to `process.stdout`. **Implies `--output json` is silently rerouted to stderr** so the binary on stdout stays clean (decision 03). Mutex with `-o`. |
| `--force` | boolean | false | Overwrite an existing file at `-o <path>` (or the inferred path). Without `--force`, an existing destination raises `ValidationError` (exit 2). Decision 02. |

`--output`, `--color`, `--profile`, `-v`, `--request-id` are inherited globals.

**Note on `-o` short form**: `-o` is already implicitly free in this slice
because no global flag uses it. (`--output` for the global output mode is
its full long form; we deliberately don't shadow.) This is consistent with
`tsc -o`, `curl -o`, `wget -O`, etc.

### 3.3 Filename inference precedence (default destination)

When neither `--stdout` nor `-o` is given, the destination is resolved with
this precedence:

1. `Content-Disposition: attachment; filename="…"` header from the response
   (RFC 6266 with a tolerant regex — `filename*` UTF-8 form supported with
   percent-decode; `filename` ASCII fallback).
2. The bare UUID + `.bin` extension (e.g. `aaa-…-001.bin`).

Path is **always** resolved relative to `process.cwd()`. We do **not** look
at `mime_type` because the download endpoint doesn't return JSON metadata.

**Path traversal defense (decision 06):** the inferred filename has its
basename stripped of any directory components (`/`, `\`, `..`, leading `.`)
and is then re-anchored at `process.cwd()`. A malicious server returning
`Content-Disposition: attachment; filename="../../etc/passwd"` results in
the file being written to `./passwd` (or `./_unnamed_<uuid>.bin` if the
sanitized basename is empty). Tests cover this explicitly.

### 3.4 Output schema: `freelo.files.download/v1`

Envelope `data`:

```jsonc
{
  "uuid": "aaa00000-0000-0000-0000-000000000001",
  "destination": "stdout" | "/abs/path/to/written-file",
  "bytes": 12345,                              // bytes streamed
  "filename": "report.pdf" | null,             // server-provided (Content-Disposition)
  "content_type": "application/pdf" | null,    // server-provided (Content-Type)
  "overwrote": false                           // true if -o existed and --force was used
}
```

Envelope-level fields:

- `paging` — N/A; omitted.
- `rate_limit` — present (parsed from response headers).
- `request_id` — present when caller passed `--request-id`.

#### `--stdout` interaction with envelope (decision 03)

**Default behavior with `--stdout`:**
- The binary body is streamed to `process.stdout`.
- The success envelope is **rerouted to `process.stderr`** so it doesn't
  corrupt the stream.
- Agents using `--stdout` reading binary on stdout AND structured metadata
  on stderr is the documented contract.
- In `human` mode with `--stdout`, the renderer is suppressed entirely (no
  ASCII summary on stderr — `--stdout` is for piping, the human doesn't
  want chatter).

**Interaction matrix:**

| Mode | `--stdout` | Stdout | Stderr |
|---|---|---|---|
| `auto` (non-TTY) | no | envelope JSON (default behavior) | (errors/spinner) |
| `auto` (non-TTY) | yes | binary bytes | envelope JSON |
| `auto` (TTY) | no | human summary | (errors/spinner) |
| `auto` (TTY) | yes | binary bytes | (silent — errors only) |
| `json` | no | envelope JSON | (errors) |
| `json` | yes | binary bytes | envelope JSON |
| `human` | no | human summary | (errors) |
| `human` | yes | binary bytes | (silent — errors only) |
| `ndjson` | no | envelope JSON | (errors) |
| `ndjson` | yes | binary bytes | envelope JSON |

The error envelope on failure follows the existing convention (stderr in
all non-`human` modes; clean message to stderr in `human`).

### 3.5 Human renderer (default, no `--stdout`)

One-line summary printed to stdout in `human` mode:

```
Downloaded report.pdf (2.4 MB) → /home/user/report.pdf
```

When the destination is `stdout` (the `--stdout` path), the human renderer
is not invoked (per matrix above). When `Content-Disposition` is absent and
we used the UUID fallback, the inline filename is omitted:

```
Downloaded 2.4 MB → /home/user/aaa-…-001.bin
```

The bytes humanizer is the same mini-helper R26 inlined in
`src/ui/human/files-list.ts` (`humanizeBytes`). To avoid duplicating,
**decision 04** is to extract it into `src/lib/format.ts` as a one-line
shared helper. (Three callsites by the time R27 lands: R25's "uploaded N
bytes" line and the renderers in R26/R27. Consolidation cost is one new
file; ongoing cost of three copies is brittle.)

## 4. Data model

### 4.1 New envelope `data` schema

Appended to `src/api/schemas/file.ts`:

```ts
export const FilesDownloadDataSchema = z.object({
  uuid: z.string().min(1),
  destination: z.union([z.literal('stdout'), z.string().min(1)]),
  bytes: z.number().int().min(0),
  filename: z.string().min(1).nullable(),
  content_type: z.string().min(1).nullable(),
  overwrote: z.boolean(),
});
export type FilesDownloadData = z.infer<typeof FilesDownloadDataSchema>;
```

The schema is part of the public envelope contract; the **download
endpoint** itself returns binary bytes, **NOT JSON** — there is no Zod
schema for the response body. (Architectural exception called out below.)

### 4.2 New wire wrapper — `downloadFile`

Appended to `src/api/files.ts`:

```ts
export const FILE_DOWNLOAD_PATH = (uuid: string) =>
  `/file/${encodeURIComponent(uuid)}`;

export type DownloadFileOpts = FetchOpts & { uuid: string };

export type DownloadFileResult = {
  /** Async iterable of byte chunks. Caller pumps to a sink. */
  body: AsyncIterable<Uint8Array>;
  /** Total bytes, when Content-Length is set; null otherwise. */
  contentLength: number | null;
  /** Server-provided MIME, when set; null otherwise. */
  contentType: string | null;
  /** Server-provided filename (Content-Disposition), when set; null otherwise. */
  filename: string | null;
  /** Rate-limit + request-id metadata for the envelope. */
  raw: { rateLimit: RateLimit; requestId: string };
};

export async function downloadFile(
  client: HttpClient,
  opts: DownloadFileOpts,
): Promise<DownloadFileResult>;
```

The wrapper calls a new `HttpClient.requestBinary` method (§5.2), pulls the
response headers we care about, returns the body iterable for the command
to drain to a sink.

## 5. Behavioral details

### 5.1 `HttpClient.requestBinary` (additive)

Per Calibration §6 the spec must own this addition explicitly. Like R25's
`requestMultipart`, this is **purely additive** — a separate method that
shares the auth/error path but does NOT modify `request()`.

```ts
async requestBinary(opts: {
  path: string;
  signal?: AbortSignal;
  requestId?: string;
}): Promise<{
  body: AsyncIterable<Uint8Array>;
  contentLength: number | null;
  contentType: string | null;
  contentDisposition: string | null;
  rateLimit: RateLimit;
  requestId: string;
}>;
```

Implementation:

- Same Authorization (Basic) and User-Agent headers as `request()`.
- `Accept: */*` (binary endpoint — JSON Accept would mislead any future
  content negotiation).
- 401 / 4xx / 5xx error path: identical to `request()` — when the response
  is **not** 2xx, the body MAY be JSON (Freelo error envelope), so we
  attempt to parse it as JSON for `errors[]` extraction. On parse failure
  we fall through with a generic `FREELO_API_ERROR`.
- 429: `RateLimitedError` with no retry (writes-style behavior — same as
  multipart). Decision 05.
- 200: extract `Content-Type`, `Content-Length`, `Content-Disposition` from
  headers; return the body as an async-iterable. **Do NOT buffer.**
- Network failure: `NetworkError`.

The async-iterable comes from `Response.body` (a `ReadableStream<Uint8Array>`
from undici-backed `fetch`); we expose it via `[Symbol.asyncIterator]` so
the command layer can `for await (const chunk of body)`.

**Why not stream straight into a `Writable`?** Decoupling the HTTP layer
from the sink (file vs. stdout) keeps `client.ts` ignorant of `node:fs`
and process streams. Pure additive; no cross-cutting concerns.

### 5.2 GET /file/{uuid} retry behavior

The existing `request()` retries 429 on GETs with jittered backoff up to 3
attempts. **`requestBinary` does NOT retry** (decision 05):

- A retry would have to re-issue the request and re-pump the body — that's
  fine in principle.
- BUT `requestBinary` returns an unconsumed iterable; the **command** owns
  the consumption side. Wrapping retries around an iterable that may have
  been partially consumed is fragile.
- Alternative: buffer everything in `requestBinary` and retry around the
  buffered call. Rejected — defeats the point of streaming.
- Conclusion: 429 on download surfaces immediately as `RateLimitedError`
  (exit 6). The agent retries the whole command.

This is consistent with the existing rule "writes don't retry" — we extend
to "binary GETs don't retry either, for streaming reasons." Documented
explicitly.

### 5.3 Atomic file write

When writing to a file:

1. Resolve the destination path against `process.cwd()` and canonicalize
   (no `..` after `process.cwd()` for inferred filenames; explicit `-o`
   paths are NOT path-traversal-checked — the caller asked for that
   path on purpose, decision 06).
2. **EEXIST check**: if `fs.stat(destination)` resolves AND `--force` is
   not set → throw `ValidationError` exit 2 with `code:
   'DESTINATION_EXISTS'` and a hint.
3. Create the parent directory if it doesn't exist? **No** (decision 07).
   We refuse to write into a non-existent directory and surface the
   `ENOENT` from `fs.open` cleanly. Creating arbitrary directories is a
   surprise.
4. Open a temp file in the **same directory** as the destination
   (`<destination>.<rand>.tmp`). Same-directory ensures `rename` is
   atomic on POSIX (no cross-device hazard).
5. Pipe the response body to the temp file. Track bytes written.
6. On success: `fs.rename(temp, destination)` (atomic).
7. On error: `fs.unlink(temp)` (best-effort), re-throw the original error.

#### Error during stream

A network drop mid-stream throws `NetworkError`. The temp file is
unlinked. The destination is **not** modified — same as if the request
never started. Decision 08.

### 5.4 `--stdout` write path

When `--stdout` is set:

1. No EEXIST check; `--force` is irrelevant. `--force` with `--stdout`
   raises `ValidationError` (consistency check).
2. Pipe the response body directly to `process.stdout` (chunked). Track
   bytes streamed.
3. After the body completes, emit the success envelope to `process.stderr`
   (in any non-`human` mode). In `human` mode, suppress the renderer.
4. If a write to stdout fails (broken pipe — `EPIPE`), abort the request
   via the AbortSignal and exit cleanly (the consumer already closed).
   Same exit code 0 as success — broken pipe is a normal end-of-pipeline
   signal in shell composition.

### 5.5 Spinner

Lazy `ora` on TTY only when **not `--stdout`** (the spinner can't share
stdout — and stderr would interleave with the post-success envelope). We
render the spinner during the body drain when `Content-Length` is unknown;
when known we update text with progress. Auto-disabled when:

- `isInteractive() === false` (CI / pipes / agents)
- `--stdout` is set (overlapping outputs)
- `--no-spinner` is set (decision 09 — same as R25)

Calibration §7 applies if and only if a test exercises the
`isInteractive` path. We unit-test the gate decision (lib-level) to avoid
the TTY-prompt CI hazard, mirroring R25 decision 06.

### 5.6 UUID validation

Strict UUID regex pre-flight check:
`/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/`.

This rejects malformed UUIDs locally before opening a connection, mirrors
the OpenAPI spec format, and prevents a path-traversal vector via the
positional argument (a `..%2F..%2Fetc%2Fpasswd` would pass undecoded
through to the wire path otherwise — `encodeURIComponent` covers that
defensively too, but the strict UUID check makes the intent loud).

### 5.7 Symlink and special-file defense

`-o <path>` is taken at face value. We do NOT check if the destination is
a symlink; if the user pointed at one, they're responsible. The atomic
rename overwrites the symlink target on POSIX (with `--force`), which is
documented behavior. **We do refuse to write to `/dev/null`-style special
files implicitly** — by always opening with `O_EXCL` on the **temp** file
(not the destination). The destination is only touched via `rename`, which
follows symlinks but cannot create unexpected device writes through them
in the way an `open()` would.

If `-o` points to an existing **directory**, we treat the user as having
asked for "write under this directory using the inferred filename" — i.e.
we resolve `<dir>/<inferred_filename>` and proceed. This matches `wget`,
`curl -o` (well, sort of — `curl -O` more so), and is the most useful
default. Decision 10.

## 6. Edge cases

1. **404 from server** → `FreeloApiError` exit 4 with `code: 'NOT_FOUND'`.
2. **403 (no access)** → `FreeloApiError` exit 4 with `code: 'FORBIDDEN'`.
3. **401** → `FreeloApiError AUTH_REQUIRED` exit 4. (The CLI's existing
   convention — auth errors return exit 4, not 3, in current code.)
4. **429** → `RateLimitedError` exit 6 (writes-style — no retry).
5. **5xx** → `FreeloApiError` exit 4.
6. **Network drop mid-stream** → `NetworkError` exit 5; temp file unlinked.
7. **UUID malformed locally** → `ValidationError` exit 2, no network call.
8. **`-o` and `--stdout` together** → `ValidationError` exit 2 (mutex).
9. **`--force` with `--stdout`** → `ValidationError` exit 2 (irrelevant
   combination).
10. **Destination exists, no `--force`** → `ValidationError` exit 2 with
    `code: 'DESTINATION_EXISTS'`.
11. **Destination parent dir missing** → `NetworkError` is wrong; this is
    a local IO error — surface as `ValidationError` with hint to create
    the dir or pick a different `-o` path. Decision 11.
12. **Empty body (0 bytes from server)** → success, `bytes: 0`. Empty file
    is created.
13. **Server `Content-Length` mismatch** (says N bytes, sends fewer): we
    treat the body completing as success — many origins lie about
    `Content-Length`. We DO NOT verify. Decision 12.
14. **Server `Content-Disposition` parsing failures** (RFC 6266 has many
    edge cases) → fall through to UUID-based name. Best-effort.

## 7. Non-goals

- **Range / partial download** — not in OpenAPI.
- **Resume on failure** — would require Range + state tracking; not in v1.
- **Concurrent multi-UUID download** — single UUID at a time. Repeat
  invocations cover multi-file.
- **Decompression** — `Accept-Encoding` defaults to whatever `fetch` sets;
  we don't add `gzip` handling. Server should send raw bytes.
- **MIME/extension auto-corrections** — if the server says `text/csv` but
  the URL filename is `.txt`, we trust the server header for `content_type`
  in the envelope but do NOT rewrite the file extension.
- **Progress bars** — the spinner shows live activity; an actual progress
  bar would require `Content-Length` always being trusted (see edge case
  13). Out of scope.
- **`--stdin` UUID input / batch** — single UUID positional only. Batch
  download is a `xargs -L1 freelo files download` pattern; agents can
  parallelize externally.

## 8. Test plan (informs Phase 4)

Test file: `test/commands/files/download.test.ts` (~25 tests).
Pattern: `test/commands/files/upload.test.ts` for fs/temp setup.
Wire-wrapper tests: `test/api/files.test.ts` (extend existing file).

### 8.1 `test/api/files.test.ts` (extend; ~6 tests)

- `downloadFile` returns body iterable + Content-Type + Content-Length +
  Content-Disposition (filename parsed). 200 path.
- `downloadFile` 200 with no `Content-Disposition` → `filename: null`.
- `downloadFile` 200 with no `Content-Length` → `contentLength: null`.
- 401 → `FreeloApiError` (exit 4).
- 404 → `FreeloApiError` exit 4 with `httpStatus: 404`.
- 5xx → `FreeloApiError` exit 4.
- 429 → `RateLimitedError` exit 6 (no retry).
- Network error → `NetworkError` exit 5.

### 8.2 `test/commands/files/download.test.ts` (~17 tests)

#### Happy paths
- Default (no flags) → writes to inferred filename in CWD; envelope shape;
  exit 0.
- `-o <relpath>` → writes to relative path; envelope `destination` is
  absolute.
- `-o <abspath>` → writes to absolute path.
- `--stdout` → stdout receives bytes (verify Buffer.compare against
  fixture); stderr receives JSON envelope.
- `--stdout` in `human` mode → stdout receives bytes; stderr is silent
  (no human summary).
- Server `Content-Disposition: attachment; filename="report.pdf"` →
  inferred filename is `report.pdf`.
- Server omits `Content-Disposition` → inferred filename is `<uuid>.bin`.
- Server `Content-Disposition: attachment; filename="../etc/passwd"` →
  written to `./passwd` (path-traversal sanitized).
- Server `Content-Disposition: attachment; filename*=UTF-8''na%C3%AFve.txt`
  → percent-decoded UTF-8 filename `naïve.txt`. (One test for the RFC 6266
  `filename*` form.)
- Empty body (0 bytes) → 0-byte file created, exit 0.
- Human-mode renders the one-line summary (TTY simulated).
- Existing file at destination + `--force` → overwrites; envelope
  `overwrote: true`.

#### Validation paths (Calibration §2 exit-code coverage)
- Malformed UUID (`not-a-uuid`) → `ValidationError` exit 2.
- `-o` + `--stdout` → `ValidationError` exit 2.
- `--force` + `--stdout` → `ValidationError` exit 2.
- Existing file at destination + no `--force` → `ValidationError` exit 2
  (`code: 'DESTINATION_EXISTS'`).
- `-o` parent dir does not exist → `ValidationError` exit 2.

#### Error paths
- Server 404 → `FreeloApiError` exit 4; no file written.
- Server 429 → `RateLimitedError` exit 6; no file written.
- Network drop mid-stream → `NetworkError` exit 5; **temp file removed
  (verify `readdir` on parent dir contains no `.tmp` after).**
- Server 5xx → `FreeloApiError` exit 4.

### 8.3 Calibration §7 — TTY/CI

The download command does NOT prompt. Its only TTY-gated logic is the
spinner. We unit-test the gate decision at the `lib/env` level (already
covered) and otherwise run all command tests in non-TTY mode (`isTTY =
false`). **No test in this slice spoofs `isTTY = true` AND runs business
logic** — sidesteps Calibration §7 entirely. Test diff grep target: zero
matches for `isTTY.*true` in the download test file.

### 8.4 Calibration §4 — try/catch coverage

The new try/catch arms in the leaf are:
- `try { stat(dest) }` → existence check (catch is the "doesn't exist →
  proceed" path; happy + EEXIST tests cover both arms).
- `try { stream pump }` → write / network failure (success + mid-stream
  drop tests cover both arms).
- `try { unlink(temp) }` → best-effort cleanup (covered by mid-stream
  drop test asserting parent dir has no leftover `.tmp` files).

### 8.5 Coverage targets

- `src/commands/files/download.ts` ≥ 85% branch.
- `src/api/files.ts` (new code only — pre-existing coverage maintained):
  `downloadFile` ≥ 90% branch.
- `src/lib/format.ts` (new): every branch of `humanizeBytes` covered (one
  test file, ~6 cases).
- `src/api/client.ts` (new method only): `requestBinary` happy + error
  paths covered through `test/api/client.test.ts` extension OR via the
  `test/api/files.test.ts` integration. Targeting the latter for
  consolidation.

## 9. Examples (agent-style)

```bash
# Default — write to ./<filename> from Content-Disposition (or <uuid>.bin)
FREELO_API_KEY=$KEY FREELO_EMAIL=$EMAIL freelo files download \
  aaa00000-0000-0000-0000-000000000001 --output json

# Explicit destination
FREELO_API_KEY=$KEY FREELO_EMAIL=$EMAIL freelo files download \
  aaa00000-0000-0000-0000-000000000001 -o ./reports/q4.pdf --output json

# Stream to stdout — pipe to another tool, JSON envelope on stderr
FREELO_API_KEY=$KEY FREELO_EMAIL=$EMAIL freelo files download \
  aaa00000-0000-0000-0000-000000000001 --stdout 2>/dev/null | sha256sum

# Force overwrite
FREELO_API_KEY=$KEY FREELO_EMAIL=$EMAIL freelo files download \
  aaa00000-0000-0000-0000-000000000001 -o ./report.pdf --force
```

## 10. Wire-up checklist (informs Phase 6)

- New page: `docs/commands/files-download.md`.
- README autogen via `pnpm fix:readme`.
- Update `src/commands/files.ts` description: "Upload, list, and download
  project files. v1: upload + list + download (R25, R26, R27)."

---

## 11. Decision log

### Decision 01 — Spec is Yellow despite touching `src/api/client.ts`

Same shape as spec 0037 decision 01 (R25). `requestBinary` is purely
additive: new method, no change to `request()`, no change to retry/auth/
error path semantics for existing callers. The Red-trigger intent (gate
default transport behavior) is honored. PR body explicitly flags the
addition for human review.

### Decision 02 — Refuse to overwrite without `--force`

Refusing-by-default is the safer agent-first behavior:

- Agents retry idempotently. A retry that silently overwrites an existing
  download (perhaps from a successful concurrent run) destroys data.
- The cost is one flag (`--force`) for users who explicitly want to
  overwrite.
- `wget`'s default is to refuse and append a number suffix; `curl -o`
  overwrites silently. We pick the safer pole.

The error code is `DESTINATION_EXISTS` with `exitCode: 2` and
`hintNext: 'Pass --force to overwrite, or pick a different -o path.'`.

### Decision 03 — `--stdout` reroutes structured output to stderr

Three considered shapes:

- **A. Suppress envelope entirely with `--stdout`.** Rejected: agents
  using `--stdout` still need the metadata (final `bytes`, `request_id`,
  `rate_limit`).
- **B. Emit envelope to stderr.** Picked. Standard Unix split.
- **C. Inline envelope after the binary body on stdout.** Rejected: corrupts
  the binary and breaks any consumer treating stdout as the bytes.

The matrix in §3.4 is exhaustive. In `human` mode with `--stdout` we go
silent on stderr because the user is piping to a tool and chatter is noise.

### Decision 04 — Extract `humanizeBytes` to `src/lib/format.ts`

R25 inlined a `formatBytes` near the upload renderer; R26 inlined
`humanizeBytes` in `src/ui/human/files-list.ts`. R27 needs the same. Three
copies is the threshold to consolidate. New file:
`src/lib/format.ts`, exports `humanizeBytes(n)`. R26's renderer is updated
to import from there (one-line refactor; covered by existing tests). R25's
upload renderer (if it has one) gets the same one-liner.

The orchestrator and reviewer should verify this refactor is **truly
behavior-preserving** by running the existing R26 list tests after the
import change.

### Decision 05 — `requestBinary` does not retry 429

GETs in `request()` retry on 429 with jittered backoff. `requestBinary`
does not. Rationale:

- The body is an unconsumed `ReadableStream` returned to the caller;
  re-issuing the request after partial consumption is fragile.
- Buffering for retry defeats streaming.
- Agents can retry the whole command — that's the natural unit.

The behavior is documented in the help text and the `--help` output for
the leaf.

### Decision 06 — Sanitize `Content-Disposition` filename, but trust `-o`

Two threat models:

- Server is malicious / compromised. It sends
  `Content-Disposition: attachment; filename="../../../etc/passwd"`.
  **We sanitize.** Strip path components (`..`, `/`, `\`); re-anchor at
  `process.cwd()`.
- User passes `-o /etc/passwd`. **We don't sanitize.** The user knew
  exactly what they were doing.

This split matches the principle of authority: the user controls their
shell; the server is untrusted input.

### Decision 07 — Refuse to create missing parent directories

Auto-creating `mkdir -p` for `-o ./does-not-exist/file.bin` is convenient
but surprising. Agents that need it can `mkdir -p` first. The error from
`fs.open` is surfaced cleanly as `ValidationError` with hint:
`Create the parent directory and retry, or pick a different -o path.`

### Decision 08 — Mid-stream failure leaves no temp file

The temp file is opened in the same dir as the destination. On any
streaming error we `unlink` it (best-effort — if `unlink` itself fails,
log at warn-level via `pino` and continue). The destination is not
touched. Tests verify with `readdir(parentDir)` post-failure.

### Decision 09 — `--no-spinner` flag (mirrors R25)

Auto-disabled when `--stdout` is set (overlapping outputs), CI is set
(env), `isInteractive()` is false. The flag exists for the rare TTY
caller who pipes stderr through a wrapper. Lazy `ora` import gated by
`isInteractive() && !--no-spinner && !--stdout`.

### Decision 10 — `-o <existing-dir>` resolves to `<dir>/<inferred>`

If `-o` points to an existing directory, treat as `wget` does (and as
`curl -O --output-dir`): resolve the inferred filename inside that dir.
This is the most useful default. Tests cover one case.

### Decision 11 — Missing parent dir is `ValidationError`, not `NetworkError`

Local fs failures during write would naturally surface as low-level
`Error` from `node:fs`. We catch and rewrap as `ValidationError` with
exit 2 and a precise hint. Distinguishes "user input was wrong" (exit 2)
from "network blew up" (exit 5).

### Decision 12 — No `Content-Length` validation

The OpenAPI doesn't require `Content-Length`; many origins set it
incorrectly when streaming. Verifying it would create false positives.
The `bytes` we report in the envelope is **what we wrote**, not what the
server said. Documented.

### Decision 13 — Single-UUID-only, no batch in v1

Roadmap line is `<uuid>` (singular). Batch download via `xargs -L1` is
the documented Unix pattern. A future R27.5 could add `--ids`/`--stdin`
NDJSON input — additive, non-breaking.

### Decision 14 — Don't expose `download_url` from R26's `FileItem`

R26's `FileItem` schema permits a `link` field on link-typed rows but
the download endpoint operates on UUIDs only. We do not chain `list →
download` on `link.url` automatically; the user passes the UUID. Keeps
the command surface explicit.

---

## 12. Acceptance criteria

- [ ] `freelo files download <uuid>` registered and discoverable via
      `freelo --introspect`.
- [ ] `meta.outputSchema === 'freelo.files.download/v1'`,
      `meta.destructive === false`.
- [ ] All happy-path tests pass against MSW.
- [ ] Each typed-error path has an exit-code assertion (Calibration §2).
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build &&
      pnpm check:readme` green on the **committed** tree (Calibration §3).
- [ ] Changeset entry calls out `freelo.files.download/v1` and the
      additive `requestBinary` method.
- [ ] No new runtime dependencies in `package.json`.
- [ ] Coverage on `src/commands/files/download.ts` ≥ 85% branch;
      `src/lib/format.ts` ≥ 85% branch.
- [ ] Path-traversal test for `Content-Disposition` malicious filename.
- [ ] Mid-stream-failure test verifying no `.tmp` remnants.
- [ ] `--stdout` test verifying binary on stdout, JSON on stderr.
- [ ] PR body explicitly mentions the `client.ts` additive change for
      human review.
- [ ] Security review (security-auditor) clean — no Critical findings.

---

## Plan

### New files

- **`src/lib/format.ts`** — `humanizeBytes(n: number): string`. Pure;
  ~25 LOC.
- **`src/lib/filename.ts`** — `parseContentDisposition(header: string |
  null): string | null` and `sanitizeBasename(name: string): string`.
  Pure; ~50 LOC.
- **`src/ui/human/files-download.ts`** — one-liner renderer. ~20 LOC.
- **`src/commands/files/download.ts`** — leaf command. ~280 LOC.
- **`test/lib/format.test.ts`** — unit tests for `humanizeBytes`. ~30
  LOC.
- **`test/lib/filename.test.ts`** — unit tests for
  `parseContentDisposition` + `sanitizeBasename` (path-traversal!). ~80
  LOC.
- **`test/commands/files/download.test.ts`** — leaf integration tests.
  ~600 LOC.
- **`docs/commands/files-download.md`** — user doc page.
- **`.changeset/r27-files-download.md`** — minor: schema added +
  additive `requestBinary` method callout.

### Modified files

- **`src/api/client.ts`** — APPEND `requestBinary` method (~80 LOC).
  Existing `request()` and `requestMultipart` untouched.
- **`src/api/files.ts`** — APPEND `FILE_DOWNLOAD_PATH`, `DownloadFileOpts`,
  `DownloadFileResult`, `downloadFile()`. Existing exports untouched.
- **`src/api/schemas/file.ts`** — APPEND `FilesDownloadDataSchema`. Existing
  schemas untouched.
- **`src/commands/files.ts`** — register `registerDownload`. Two-line edit.
  Description updated.
- **`src/ui/human/files-list.ts`** — replace local `humanizeBytes` with
  import from `src/lib/format.ts`. Behavior-preserving (decision 04).
- **`test/msw/handlers.ts`** — APPEND `filesDownloadHandlers` factory:
  `downloadOk`, `downloadOkWithDisposition`, `downloadOkNoDisposition`,
  `downloadOkUtf8Disposition`, `downloadEmpty`, `downloadOkBigBuffer`,
  `notFound`, `unauthorized`, `forbidden`, `serverError`, `rateLimited`,
  `networkError`, `midStreamError`.
- **`test/api/files.test.ts`** — APPEND ~6 tests for `downloadFile`.
- **`README.md`** — autogen via `pnpm fix:readme`.

### File touch budget

- 9 new files (4 src + 1 doc + 3 test + 1 changeset)
- 7 modified files (5 src + 2 test) + 1 README diff

**Total: 17 file changes. Within budget (25).**

### Rollout order

1. Schemas (`schemas/file.ts`).
2. Format helper (`lib/format.ts`) + tests + import-refactor in R26
   renderer.
3. Filename helper (`lib/filename.ts`) + tests.
4. `HttpClient.requestBinary` (`api/client.ts`).
5. Wire wrapper (`api/files.ts` `downloadFile`).
6. MSW handlers.
7. Wire wrapper tests (`test/api/files.test.ts`).
8. Human renderer (`ui/human/files-download.ts`).
9. Leaf command (`commands/files/download.ts`).
10. Namespace registration (`commands/files.ts`).
11. Leaf tests (`test/commands/files/download.test.ts`).
12. `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
13. `pnpm fix:readme`.
14. Doc page (`docs/commands/files-download.md`).
15. Changeset (`.changeset/r27-files-download.md`).
16. Final committed-tree gate run.

### Risks / known gotchas

- **`humanizeBytes` consolidation.** The R26 list renderer must keep
  rendering identical bytes after the import refactor. The existing R26
  tests are the regression net; reviewer verifies they still pass.
- **`Content-Disposition` parsing.** RFC 6266 has many edge cases. We
  handle the two common forms (`filename="…"`, `filename*=UTF-8''…`)
  and fall through gracefully on anything weirder. Tests cover both
  forms + the malicious-filename path-traversal case.
- **MSW binary body.** MSW 2.x supports `HttpResponse` with `Blob` /
  `Uint8Array` / stream bodies. Test handlers will use `new HttpResponse(
  Buffer.from(...))` to ensure realistic byte-level streams.
- **Atomic rename across MSW dispatch.** Tests run in tmpdirs; the temp
  file and destination are colocated, so rename is always within the
  same dir. No cross-device hazard in tests.
- **`process.stdout.write()` for binary.** `process.stdout` is a stream
  in Node.js — writing `Uint8Array` chunks directly is supported. Tests
  spy on `process.stdout.write` and reconstruct the bytes via
  `Buffer.concat`.
- **EPIPE on stdout.** When the consumer closes the pipe early
  (`| head -c 100`), Node raises `EPIPE` from a pending stdout write.
  We catch and treat as success (decision §5.4). Test simulates by
  forcibly closing the spy after N bytes.
- **`isInteractive` already checks `CI`.** Per Calibration §7, no test
  in this slice forces `isTTY=true` while business logic runs.

### No new dependencies

`undici` (already pinned), `node:fs` / `node:fs/promises`, `node:path`,
`node:crypto` (for the temp-file random suffix). All built-in or already
used.
