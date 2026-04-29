# Spec 0037 — R25 `freelo files upload`

**Run:** 2026-04-29-1210-r25-files-upload
**Tier:** Yellow
**Depends on:** R08 (auth/login — long shipped).
**First-of-its-kind:** multipart upload in the CLI. Ships `src/lib/multipart.ts` (roadmap.md:753) and `HttpClient.requestMultipart` (additive).

---

## 1. Problem & scope

R25 introduces the first multipart-body command in the CLI:

```
freelo files upload <path>... [--attach-to-task <id>] [--message <str>] [--dry-run]
```

It uploads one or more local files to Freelo via `POST /file/upload` and, optionally, posts a comment on a task that references each uploaded file via the documented `<a data-freelo-uuid="{uuid}">filename</a>` anchor (yaml :3876).

### Goals

- Wire-faithful coverage of `POST /file/upload` end-to-end (CLI → multipart helper → typed API wrapper → MSW-tested).
- Optional second-step "attach to task" via comment-creation (the only documented attach mechanism in the OpenAPI spec).
- Agent-safe writes: `--dry-run`, idempotent batch (each path is one upload — partial-failure semantics defined below), exit codes per Calibration §2.
- Ships the foundational `src/lib/multipart.ts` helper that R26/R27 (files list/download) will reuse.
- Lazy `ora` spinner for human TTY only — never imported on the agent path.
- Local size/type guards aligned with the documented API limit (100 MB).

### Non-goals (v1)

- **Re-uploading** an already-uploaded file. There is no API for "upload by hash"; every `freelo files upload` call uploads fresh bytes.
- **Resumable / chunked / parallel uploads.** Files are uploaded sequentially over one connection. A 100 MB cap is the documented hard limit (yaml :3873).
- **Attaching to anything other than a task** (descriptions, comments-on-comments, project-pinned). The roadmap signature only specifies `--attach-to-task`.
- **Reading file lists from stdin / NDJSON.** Paths are positional (`<path>...`); `--stdin` line-of-paths input can come in a follow-up.
- **MIME-type allowlist.** The API documents type checks but does not document the allowlist (yaml :3883). We pass MIME types through — server is the authority.
- **Bare `--attach-to-task` with no `--message`.** A comment requires `content` (yaml :2603). We synthesize a default message — see decision 03.
- **Reading from `-` (stdin).** Single-pass file uploads only; reading binary from stdin is fragile in cross-platform shells.

---

## 2. OpenAPI verification

Verified `docs/api/freelo-api.yaml` (canonical Freelo contract).

### 2.1 `POST /file/upload` (yaml :3867-3907) — multipart upload

- **Method/path:** `POST /file/upload`.
- **Body:** `multipart/form-data` — single field `file` (`type: string, format: binary`). JSON body is rejected.
- **Hard limit:** **100 MB** per upload (yaml :3873).
- **Side effect:** none — upload returns a UUID; **does NOT auto-attach** anywhere (yaml :3881).
- **Response (200):** `{ uuid: format: uuid }` (yaml :3905-3907).
- **Errors:** 400 on oversize / forbidden type (yaml :3883). Standard 401/429/5xx/network from `client.ts`.
- **Spec inconsistency:** the global `FileUpload` schema (yaml :5563-5572) requires `download_url` and `filename`. The upload endpoint's response schema (inline, yaml :3902-3907) returns only `uuid`. Decision 02 explains how we reconcile this.

### 2.2 `POST /task/{task_id}/comments` (yaml :2575-2617) — attach via comment

The only documented way to surface an uploaded file on a task (yaml :3876):

> Attaching an image to a comment: embed `<a data-freelo-uuid="{uuid}">caption</a>` in the comment content

- **Path param:** `task_id` (integer).
- **Body:** `{ content: string, files?: FileUpload[] }`. We do NOT use `files[]` (it requires `download_url` we don't have). We use only `content` with embedded anchors.
- **First-comment quirk:** if a task has no comments yet, this call creates the task description instead (yaml :2589-2592). Documented; not a bug; v1 caller is responsible.
- **Response:** `Comment` (full schema). For our purposes we only need `id`.

This satisfies `--attach-to-task` end-to-end with two API calls per file (upload + comment). Decision 03 covers default message text.

---

## 3. CLI surface

### 3.1 Command tree (registered in `src/bin/freelo.ts`)

```
freelo files                                                          [parent — no meta]
  └─ upload   <path>... [--attach-to-task <id>] [--message <str>]
              [--dry-run] [--no-spinner]                              [meta: freelo.files.upload/v1]
```

Parent has description but no `meta` (mirrors `freelo labels` and `freelo task-labels`). `files` is the new resource group introduced by R25; R26 and R27 (list, download) will register additional leaves under it.

### 3.2 Flag specification

| Flag | Type | Required | Notes |
|---|---|---|---|
| `<path>` | variadic positional | yes (≥1) | Local file paths. Tilde expansion deferred to the shell. Globs are NOT expanded by the CLI — pass `**/*.png` and the shell expands. |
| `--attach-to-task <id>` | positive int | no | When set, the CLI posts a comment on the given task with `<a data-freelo-uuid="{uuid}">filename</a>` anchors for each successful upload. |
| `--message <str>` | string | no | Comment content prefix. Effective only with `--attach-to-task`. Without `--message`, the comment defaults to `"Attached: <a …>file1</a>, <a …>file2</a>"` (decision 03). With `--message`, the anchors are appended after a newline. |
| `--dry-run` | boolean | no | Skip the network. Envelope echoes one `would` per file plus, when `--attach-to-task` is set, a final `would` for the comment. |
| `--no-spinner` | boolean | no | Disable the lazy `ora` spinner even on a TTY. Useful when piping mixed stderr+stdout in shell wrappers. The spinner is also auto-disabled when `isInteractive()` returns false (decision 04). |

#### Argument validation

- Each `<path>` must:
  - exist and be a regular file (`fs.statSync`).
  - be ≤ 100 MB (yaml :3873; spec 0037 decision 05).
  - not be a directory (no recursive expansion in v1).
- `--attach-to-task` must be a positive integer (mirrors `--task` in task-labels).
- `--message` is free text; whitespace-only is rejected.

### 3.3 Output

Envelope schema: **`freelo.files.upload/v1`**.

```ts
type FilesUploadData = {
  uploaded: Array<{
    path: string;        // The input path (as supplied — not absolute).
    filename: string;    // basename(path).
    bytes: number;       // size at upload time.
    uuid: string;        // server-assigned UUID.
  }>;
  failed: Array<{
    path: string;
    error: { code: string; message: string };
  }>;
  count: { requested: number; uploaded: number; failed: number };
  attached?: {
    task_id: number;
    comment_id: number;       // from the comment-create response.
    file_uuids: string[];     // the uuids that ended up in the comment.
  };
  would?: Array<{ method: 'POST'; path: string; body: unknown }>;
};
```

Notes:
- The `failed` array supports per-path partial failure semantics — if one of three uploads fails, the other two are reported as `uploaded` and the command exits 4 with `failed[]` populated (matches the `ExitCodeAccumulator` pattern but inline — see §5.5).
- `attached` is only present on a successful comment-create (success of *all* uploads is NOT required — partial attach happens, the comment carries every successful uuid).
- `would` is an **array** (one per anticipated POST) only on `--dry-run`. It lives at `data.would`, not at the envelope top — same convention as task-labels (spec 0036 §3.3).
- `bytes` lets agents verify upload size matches local size pre-upload (audit trail).

### 3.4 Error paths & exit codes

| Scenario | Error class | Exit code |
|---|---|---|
| No paths supplied | `ValidationError` | 2 |
| Path does not exist | `ValidationError` | 2 |
| Path is a directory | `ValidationError` | 2 |
| Path > 100 MB | `ValidationError` | 2 |
| `--attach-to-task` non-positive / non-integer | `ValidationError` | 2 |
| `--message` whitespace-only | `ValidationError` | 2 |
| **Single** path: 4xx/5xx from server | `FreeloApiError` | 4 |
| **Multi-path**: any path errors | exit 4, `failed[]` populated, no thrown error | 4 |
| 401 anywhere | `FreeloApiError` AUTH_EXPIRED | 3 |
| 429 anywhere | `RateLimitedError` | 4 |
| Network failure on first upload | `NetworkError` | 5 |
| Comment-create fails after all uploads succeeded | `FreeloApiError` | 4 (envelope still includes `uploaded[]` so agents can recover) |

Per Calibration §2 the test plan (§7) MUST assert the `exitCode` for each typed-error path.

---

## 4. Files & module layout

### 4.1 New files

| File | Purpose |
|---|---|
| `src/lib/multipart.ts` | `buildFileMultipart(filePath)` — pure-ish helper that opens the file, builds an `undici` `FormData` with a `Blob` payload, and returns `{ body, filename, bytes, mime }`. **Roadmap.md:753.** |
| `src/api/files.ts` | Wire wrapper for `POST /file/upload`. Uses the new `requestMultipart` method on `HttpClient`. Local zod schema for `{ uuid }` response. Also re-exports a thin `createCommentForFiles` helper that wraps the existing `addCommentToTask` (already exported by `src/api/comments.ts`). |
| `src/api/schemas/file.ts` | Zod schemas: `FileUploadResponseSchema` (`{ uuid: uuid }`), `FilesUploadDataSchema`. ~50 LOC. |
| `src/commands/files.ts` | Parent registrar for `files` resource group. ~25 LOC. |
| `src/commands/files/upload.ts` | The leaf command. ~280 LOC. |
| `src/ui/human/files-upload.ts` | Human renderer. ~30 LOC. |
| `test/lib/multipart.test.ts` | Unit tests for the multipart helper. |
| `test/api/files.test.ts` | Wire-wrapper tests + MSW handlers verification. |
| `test/commands/files/upload.test.ts` | Command-level tests + exit codes. |
| `.changeset/<auto>.md` | Minor bump — new subcommand, new schema, additive client method. |

### 4.2 Modified files

| File | Change |
|---|---|
| `src/api/client.ts` | **Add** `HttpClient.requestMultipart(opts)` method. Reuses existing auth/error handling. Does NOT modify the existing `request()` method, retry logic, or rate-limit handling. The method intentionally does not retry (writes never retry per existing convention). |
| `src/bin/freelo.ts` | Lazy-import + register `files` parent. Mirrors `registerLabels` insertion. |
| `test/msw/handlers.ts` | Add `filesUploadHandlers` factory (uploadOk / uploadOversize / uploadServerError / matchesMultipartFile predicate variant) + extend existing `commentsAddHandlers` if needed (it already exposes `okWhenBody` — sufficient). |
| `README.md` | Auto-regen via `pnpm fix:readme` (introspection picks up `files upload`). |

Total new files: 6 src + 3 test + 1 changeset = **10 new**, **3 modified**, **1 README diff**. **14 file changes total — within budget (25).**

---

## 5. Behavioral details

### 5.1 Multipart helper (`src/lib/multipart.ts`)

```ts
import { FormData } from 'undici';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

export const FILE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024; // 100 MB (yaml :3873).
export const FILE_UPLOAD_FIELD_NAME = 'file';

export type MultipartFile = {
  body: FormData;
  filename: string;
  bytes: number;
};

/** Build a FormData body for a single file upload. Throws ValidationError on
 *  size violations, NetworkError on read failures (e.g. file vanished mid-run). */
export async function buildFileMultipart(absPath: string): Promise<MultipartFile> { ... }
```

Choices:
- Uses `readFile` (eager-load) rather than streaming. With a 100 MB cap and one upload at a time, the simplicity is worth more than the memory ceiling. Streaming via `undici`'s body iterator can come in a follow-up if real workloads need it.
- Uses `undici`'s `FormData` (native to Node 20+ via `globalThis.FormData` actually — but importing from `undici` is explicit and matches the roadmap's "undici FormData pattern" wording).
- Returns the pre-checked `bytes` so the command layer can attach it to the envelope.

### 5.2 `HttpClient.requestMultipart` (additive)

Signature:

```ts
async requestMultipart<S extends ZodTypeAny>(opts: {
  path: string;
  body: FormData;
  schema: S;
  signal?: AbortSignal;
  requestId?: string;
}): Promise<ApiResponse<z.output<S>>>;
```

Implementation:
- Builds the same Authorization header / User-Agent / Accept the existing `request()` does.
- Does NOT set `Content-Type` — `fetch` sets `multipart/form-data; boundary=…` automatically when you pass a `FormData` body.
- Method is hard-coded `POST`. (No GET/PUT/PATCH/DELETE multipart in the API surface.)
- Goes through the same 401/429/5xx/JSON-parse error paths as `request()` (refactored into a shared private helper `#parseErrorResponse` — pure additive, no behavior change to existing callers).
- **Does NOT retry on 429.** Writes never retry today (existing rule, see `client.ts` line 146-151). Multipart writes inherit the same.
- 200 → JSON-parse + zod-validate the response (the upload endpoint does return JSON despite the request being multipart — verified yaml :3899-3907).

Why additive (not "edit existing request"):
- The existing `request()` always JSON-stringifies the body. Multipart cannot share that path.
- Refactoring `request()` to branch on body shape would touch the GET retry loop, the 401 handling, etc. — exactly the Red-tier surface area we want to avoid.
- A new method is purely additive: no existing call signature changes, no existing test changes.

### 5.3 Lazy `ora` spinner

Per CLAUDE.md "Lazy human deps": never import `ora` at the top of a command file. Pattern (mirrors `src/commands/auth/login.ts`):

```ts
let spinner: { start(): void; stop(): void; succeed(): void; fail(): void } | undefined;
if (isInteractive() && !opts.noSpinner) {
  const { default: ora } = await import('ora');
  spinner = ora({ text: `Uploading ${filename}…`, stream: process.stderr });
  spinner.start();
}
try {
  // upload
  spinner?.succeed?.();
} catch (err) {
  spinner?.fail?.();
  throw err;
}
```

Calibration #7 applies: the test for the TTY-spinner branch MUST clear `process.env.CI` for the duration. We intentionally do NOT add an integration test that exercises the spinner — instead we unit-test the gate logic in isolation (decision 06).

### 5.4 Size & type guards

- Size: enforce locally before opening the network. `stat(path).size > FILE_UPLOAD_MAX_BYTES` → `ValidationError` exit 2.
- Type: pass through. The CLI does not implement an allowlist. The server returns 400 if the type is forbidden; we surface that as `FreeloApiError` exit 4. (Decision 05 logs why.)

### 5.5 Multi-file partial-failure

- Files are uploaded **sequentially** in the order given. Sequential keeps the spinner messages legible and avoids a 4-file user spamming the server with parallel uploads.
- A failure on file N does NOT abort: file N's `path` + a typed error code goes into `failed[]`, file N+1 begins.
- After the loop:
  - If `failed.length === 0` → exit 0.
  - If `failed.length > 0 && uploaded.length > 0` → exit 4 (partial failure; envelope still emitted).
  - If `failed.length > 0 && uploaded.length === 0` → throw the **first** failure as a typed error (so single-path callers see the original error class & exit code).
- This matches the `ExitCodeAccumulator` pattern from R23 `labels attach`. Per spec 0035 decision 04 we inline rather than extract a shared helper for a single use.

### 5.6 `--attach-to-task` semantics

After all uploads complete (with at least one success), if `--attach-to-task <id>` is set:

1. Build comment content:
   - `--message` not set: `Attached: <a data-freelo-uuid="UUID1">name1</a>, <a data-freelo-uuid="UUID2">name2</a>`
   - `--message "<text>"` set: `<text>\n\nAttached: <a data-freelo-uuid="UUID1">name1</a>, …`
   - HTML-escape `name` values to defend against malicious filenames (`<>&"'` → entities).
2. POST `/task/{task_id}/comments` with `{ content }`.
3. On success, populate `data.attached.{task_id, comment_id, file_uuids}`.
4. On failure, the comment-create error becomes the command's exit error — but the envelope still includes the `uploaded[]` array so the agent can salvage the UUIDs and re-attach manually.

Edge case: zero successful uploads → skip the comment entirely (no point in creating an empty-anchor comment). `failed[]` carries the upload errors and the command exits 4 (per §5.5).

### 5.7 Dry-run

- Zero network. Each path is statted (size/type guards still run — dry-run validates locally too).
- Envelope `data.would` is an array:
  - One `{ method: 'POST', path: '/file/upload', body: { multipart: { file: '<basename>', bytes: <N> } } }` per path. (We do NOT echo file content. Just the descriptor.)
  - When `--attach-to-task` is set, append one `{ method: 'POST', path: '/task/<id>/comments', body: { content: '<rendered-message-with-PLACEHOLDER-uuids>' } }`. UUIDs are placeholdered as `00000000-0000-0000-0000-000000000000` because no upload has happened.
- `data.uploaded` and `data.failed` are empty in dry-run; `data.count` reflects the requested count only.
- Exit 0 always (validation already happened pre-dry-run gating).

### 5.8 No destructive prompt

Uploading is creating, not destroying — no `--yes`, no `confirmDestructive`. Comment-create on a task is non-destructive (you can `freelo comments edit` later). **Calibration #7 (CI/TTY-prompt gotcha) does NOT apply** to the upload command itself, but DOES apply to the spinner gate. We unit-test the gate in `test/lib/multipart.test.ts` env-style (decision 06) — no integration test needs to spoof TTY+CI.

---

## 6. Conventions touched

- **New `HttpClient` method**: additive only. No existing behavior changed. **Flagged in PR body** for human review (see triage Yellow-with-asterisk note).
- **Error classes**: `ValidationError`, `FreeloApiError`, `NetworkError`, `RateLimitedError` — all existing.
- **Envelope contract**: one new schema `freelo.files.upload/v1`. Additive `vN`. Changeset minor.
- **Lazy-load policy**: `ora` is `await import`ed behind `isInteractive() && !opts.noSpinner`. ESLint rule against top-level imports of human-UX deps continues to pass.
- **ESM-only**: every relative import has `.js`. Uses `node:fs/promises`, `node:path` (built-ins).
- **No new dependencies**. `undici` and `ora` are both already in `package.json`.

---

## 7. Test plan

Coverage targets per project policy: ≥85% branch on `src/commands/**`. Test count target: **~28 tests** across 3 files.

### 7.1 `test/lib/multipart.test.ts` (~6 tests)

- `buildFileMultipart` returns FormData with a `file` field and the basename as filename.
- Reports the correct byte count (write a 1024-byte file, assert `bytes === 1024`).
- Throws `ValidationError` (exit 2) when path > `FILE_UPLOAD_MAX_BYTES`.
- Throws `ValidationError` when path doesn't exist.
- Throws `ValidationError` when path is a directory.
- Empty file (0 bytes) is accepted (no minimum).

### 7.2 `test/api/files.test.ts` (~5 tests)

- `uploadFile` builds correct multipart body, MSW asserts presence of the `file` form field, returns the parsed `{ uuid }`.
- 400 oversize from server → `FreeloApiError` exit 4.
- 401 from server → `FreeloApiError` AUTH_EXPIRED exit 3.
- 5xx → `FreeloApiError` SERVER_ERROR exit 4 retryable.
- Malformed 200 (missing uuid) → `FreeloApiError` VALIDATION_ERROR exit 4.

### 7.3 `test/commands/files/upload.test.ts` (~17 tests)

#### Happy paths
- Single path → 1 upload → exit 0, envelope shape with `uploaded[0].uuid`.
- Multiple paths → N uploads in order → `count.uploaded === N`.
- `--attach-to-task <id>` after 1 upload → 1 comment-create → `data.attached.task_id` set.
- `--attach-to-task <id> --message "look"` → comment content begins with "look\n\nAttached: ...".
- Default message format with no `--message` → "Attached: <a …>name</a>".
- HTML-escapes filename containing `<` `>` `&` (write file `attack<x>.txt`, assert content has `&lt;x&gt;`).
- `--dry-run` → no network call (handler-counter check), `data.would` array length matches expected POST count, default message includes UUID placeholder.
- Human output renders count line.

#### Validation (Calibration §2 exit-code coverage)
- No paths → `ValidationError` exit 2.
- Path doesn't exist → `ValidationError` exit 2.
- Path is a directory → `ValidationError` exit 2.
- Path > 100 MB (mock `stat` to return 100 MB+1) → `ValidationError` exit 2.
- `--attach-to-task 0` → `ValidationError` exit 2.
- `--attach-to-task abc` → `ValidationError` exit 2.
- `--message "   "` → `ValidationError` exit 2.

#### Error paths
- Single path: 5xx upload → `FreeloApiError` exit 4.
- Multi path with one 5xx: exit 4, `uploaded[]` has the survivors, `failed[]` has the 5xx, comment NOT posted only when zero uploads succeeded — when ≥1 succeeds, the comment IS posted with the surviving UUIDs (decision 07).
- Comment-create 4xx after upload success → exit 4, envelope includes `uploaded[]` for recovery, no `attached` field.

### 7.4 Calibration §7 — TTY prompt code path

The `ora` spinner is gated by `isInteractive()`. We do **not** integration-test the spinner-on path (its visual output is not part of the contract). Instead, the upload command unit tests run with `process.stdout.isTTY = false` (default in `beforeEach`) so the spinner branch never executes. This sidesteps the CI/TTY trap entirely. **Test diff grep target:** zero matches for `isTTY.*true` in test files (verified pre-submit).

### 7.5 Calibration §4 — try/catch coverage

The new `try/catch (err)` block in the multi-path loop adds a new branch. Tests §7.3 ("Multi path with one 5xx") cover the catch arm. The `requestMultipart` 401/429/4xx/5xx error paths reuse the existing private `#parseErrorResponse` helper — no NEW catch arms in `client.ts` other than the multipart-specific `try { fetch() }` wrapper, which is symmetrical to the existing one. Test §7.2 hits each.

---

## 8. Open questions

None resolvable only by humans. Spec inconsistencies in OpenAPI are reconciled in §2 + decision 02. Default-message wording is decided in decision 03. Sequential vs parallel uploads is a decision (08, sequential) rather than an open question.

---

## 9. Acceptance criteria

- [ ] `freelo files upload <path>` registered and discoverable via `freelo --introspect`.
- [ ] All happy-path tests pass against MSW.
- [ ] Each typed-error path has an exit-code assertion (Calibration §2).
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme` green on the **committed** tree (Calibration §3).
- [ ] Changeset entry calls out `freelo.files.upload/v1` and the additive `requestMultipart` method.
- [ ] No new runtime dependencies in `package.json`.
- [ ] Coverage on `src/commands/files/**` ≥ 85% branch; `src/lib/multipart.ts` ≥ 85% branch.
- [ ] PR body explicitly mentions the `client.ts` additive change for human review.

---

## 10. Decision log

### Decision 01 — Spec is Yellow despite touching `src/api/client.ts`

The Red trigger "Touches src/api/client.ts" exists to gate changes to default transport behavior (retry, auth, redirect). `requestMultipart` is purely additive: no existing method signature changes, no shared mutable state, no behavior change to `request()`. The intent of the rule is honored. We tier Yellow and **flag it in the PR body** for human review (autonomous-sdlc.md "small UX choices… flag for review in PR body" pattern).

### Decision 02 — `--attach-to-task` uses comment-creation, not the contradicted `FileUpload` schema

The OpenAPI spec contradicts itself: `POST /file/upload` returns `{ uuid }` (yaml :3905) but the `FileUpload` schema used by comment/description endpoints requires `download_url` (yaml :5563). We have no `download_url` from the upload response; we cannot fabricate one.

The **only** documented attach mechanism is the `<a data-freelo-uuid="{uuid}">caption</a>` anchor in comment content (yaml :3876). We therefore implement `--attach-to-task` as: upload all files → POST a comment whose `content` embeds those anchors. We do NOT populate `comments.files[]`. This is the literal documented contract.

If the comment-creation endpoint actually accepts `files: [{ uuid }]` despite the schema saying `download_url`, our content-anchor approach still works — we're just not using a separately-documented field. If a future API change makes `download_url` resolvable from the upload response, R26 (`files list` exposes `download_url`) is the natural place to add a `--use-files-array` flag.

### Decision 03 — Default attach-to-task message wording

When `--message` is not supplied with `--attach-to-task`, we synthesize:

```
Attached: <a data-freelo-uuid="UUID1">filename1</a>, <a data-freelo-uuid="UUID2">filename2</a>
```

Alternatives considered:
- Empty content + `files[]` array: rejected (decision 02).
- Empty content + just anchors: comment endpoint requires non-empty `content` per yaml :2603.
- Just file UUIDs as bare text: not actionable in the Freelo UI.

The `Attached: ` prefix was chosen for parity with how existing Freelo email notifications phrase attachments in CS/SK locales (informally observed; if a maintainer prefers `Files: ` we change it in a one-line follow-up).

### Decision 04 — `--no-spinner` flag

The spinner is auto-disabled when `isInteractive()` returns false (CI, pipes, agent invocations). We add `--no-spinner` for the rare case where a TTY user pipes stderr through a wrapper that mangles ANSI control sequences. Cheap, additive, no-cost flag.

### Decision 05 — 100 MB local guard, no MIME allowlist

The OpenAPI documents a 100 MB hard limit (yaml :3873) and a vague "forbidden types" check (yaml :3883). We enforce 100 MB locally to avoid wasting an upload round-trip. We do NOT enforce a type allowlist locally because:
- The allowlist is undocumented.
- Hand-coding it from observation risks false negatives (denying legal types).
- The server is the authority; surface the 400 cleanly and let the user retry with a different file.

### Decision 06 — No integration test for spinner-on path

The spinner is a UX nicety, not part of the agent contract. Testing it requires spoofing `process.stdout.isTTY` AND clearing `process.env.CI` (Calibration #7) AND mocking `ora`. The complexity-to-value ratio is bad. We unit-test the helper that decides whether to spawn the spinner (`isInteractive() && !opts.noSpinner`) at the gate layer, not the spinner itself. The lazy `await import('ora')` line is exercised in `test/commands/auth/login.test.ts` already (existing coverage).

### Decision 07 — Multi-path attach with partial upload failure

When some uploads fail and some succeed AND `--attach-to-task` is set, we still post a comment with the surviving UUIDs (and emit `failed[]` so the agent knows what didn't make it). Alternative: skip the comment unless all succeed. Rejected because:
- Partial-success comments are still useful (the agent can post the failures separately).
- "All-or-nothing" semantics would require either rolling back successful uploads (no API for that) or surfacing zero state on success (more confusing).
- Symmetry with R23's `labels attach` per-item batch model.

If zero uploads succeeded, we skip the comment (no point) and exit 4 with `failed[]`.

### Decision 08 — Sequential uploads, not parallel

Parallel uploads would speed up multi-file invocations but:
- The spinner output becomes interleaved garbage.
- Error attribution is harder ("file 2 of 4 failed" requires tracking original positions).
- The 100 MB cap and typical user file counts (1–10) make sequential plenty fast.
- A `--concurrency N` flag is a one-liner follow-up if real workloads need it.

### Decision 09 — Filename HTML-escaping

A user uploads `pwn<script>.txt`. If we embed the basename verbatim into a comment body that Freelo renders as HTML (yaml :2582 says "HTML / plain text"), we ship XSS into the workspace. We HTML-escape `<>&"'` in the basename before splicing into the `<a>` anchor. The original filename stays in `data.uploaded[i].filename` (raw, for agents to assert against).

### Decision 10 — `data.would` is an array, not a single object

Existing single-POST commands (task-labels, labels) put a single `would: { method, path, body }` at `data.would`. R25 makes 1 to N+1 POSTs per invocation (N uploads + maybe 1 comment), so a single object would be ambiguous. We use an array. Consumers reading `would.method` will see undefined and can adapt; this is a new schema (`freelo.files.upload/v1`) — no backwards-compatibility concern.

---

## 11. Plan (file-level TODOs)

### Step 1 — Schemas (no deps)

**File:** `src/api/schemas/file.ts` (new, ~60 LOC)
- Export `FileUploadResponseSchema` = `z.object({ uuid: z.string().uuid() }).passthrough()`.
- Export `FileUploadResponse` type alias.
- Export `FilesUploadDataSchema` (envelope `data` shape) and `FilesUploadData` type.
- Export `FILE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024` (re-export from multipart.ts to avoid circular imports — see step 2).

### Step 2 — Multipart helper (no deps on api)

**File:** `src/lib/multipart.ts` (new, ~80 LOC)
- Export `FILE_UPLOAD_MAX_BYTES`, `FILE_UPLOAD_FIELD_NAME`.
- Export `MultipartFile` type.
- Export `async buildFileMultipart(absPath: string): Promise<MultipartFile>`:
  - `await stat(absPath)` — throw `ValidationError` on `ENOENT` / not-a-file.
  - Size check: throw `ValidationError` if `> FILE_UPLOAD_MAX_BYTES`.
  - `await readFile(absPath)` → `Buffer`.
  - Build `FormData` with `Blob` constructed from the buffer (set `type: 'application/octet-stream'`).
  - Return `{ body, filename: basename(absPath), bytes }`.

### Step 3 — Extend `HttpClient` with `requestMultipart`

**File:** `src/api/client.ts` (modify)
- Add `requestMultipart<S>` method (~70 LOC). Does NOT touch `request()`.
- Extract a small private helper `#parseErrorResponse(response, requestId)` if the diff is cleaner that way (otherwise inline). Pure refactor — no behavior change. If the refactor would touch existing call sites' branch coverage (Calibration §4), inline instead.
- The method shape mirrors `request()` but:
  - No body JSON-stringify.
  - No Content-Type header (let `fetch` set the boundary).
  - No 429-retry loop (writes don't retry).
  - 200 → JSON-parse → schema-validate.

### Step 4 — Wire wrapper

**File:** `src/api/files.ts` (new, ~60 LOC)
- `export const FILE_UPLOAD_PATH = '/file/upload';`
- `export type UploadFileOpts = FetchOpts & { multipart: MultipartFile };`
- `export async function uploadFile(client, opts): Promise<{ raw: ApiResponse<FileUploadResponse>; uuid: string; filename: string; bytes: number }>` — calls `requestMultipart` and re-shapes the result for the command layer.

### Step 5 — Human renderer

**File:** `src/ui/human/files-upload.ts` (new, ~40 LOC)
- One-liner renderer that prints `Uploaded N file(s): name1 (UUID1), name2 (UUID2)` plus a `Attached to task X (comment Y)` line if `attached` is set; plus a `Failed: name (msg)` line per failure.

### Step 6 — Parent registrar

**File:** `src/commands/files.ts` (new, ~25 LOC) — mirrors `src/commands/labels.ts`.

### Step 7 — Leaf command

**File:** `src/commands/files/upload.ts` (new, ~280 LOC):
- Argument validation: positional `<path>...` collected via Commander's variadic argument syntax.
- Input parsers: `parseTaskIdFlag`, `parseMessageFlag` (whitespace-only rejected).
- Action handler:
  - Resolve absolute paths, validate each (existence, file, size). Bail early on first invalid path with `ValidationError`.
  - If `--dry-run`, build the would-array and emit envelope. Exit 0.
  - Otherwise, build credentials & client.
  - Loop over paths sequentially, with the `ora` spinner gated by `isInteractive() && !opts.noSpinner`:
    - For each: call `buildFileMultipart` + `uploadFile`. On success, push to `uploaded[]`. On failure (typed error), push to `failed[]`.
  - If `--attach-to-task` is set AND `uploaded.length >= 1`: build comment content with HTML-escaped names, call `addCommentToTask`, populate `attached`.
  - Emit envelope. If `failed.length > 0` and `uploaded.length === 0`, throw the first error so the typed-error class propagates. Else if `failed.length > 0`, set process exit code to 4 (the existing pattern from `src/commands/labels/attach.ts`).

### Step 8 — Wire into root

**File:** `src/bin/freelo.ts` (modify): add `registerFiles` import + call after `registerTaskLabels`.

### Step 9 — MSW handlers

**File:** `test/msw/handlers.ts` (modify): export `filesUploadHandlers` with `uploadOk(uuid?)`, `uploadOkWhenMultipart(predicate)`, `uploadOversize()`, `uploadServerError(status?)`, `uploadAuthExpired()`.

### Step 10 — Tests

- `test/lib/multipart.test.ts` (new, ~120 LOC) — pure helper tests with real fs in a tmp dir.
- `test/api/files.test.ts` (new, ~150 LOC) — wire wrapper through MSW.
- `test/commands/files/upload.test.ts` (new, ~450 LOC) — happy paths, validation, error paths.

### Step 11 — Doc autogen + changeset

- `pnpm fix:readme` — captures `files upload` in the Commands block.
- `.changeset/<auto>.md` — minor bump:
  ```
  feat(commands): r25 — `freelo files upload <path>... [--attach-to-task <id>]`.

  - New envelope schema: `freelo.files.upload/v1`
  - New shared helper: `src/lib/multipart.ts` (undici FormData)
  - Additive `HttpClient.requestMultipart` method (no change to existing `request()`)
  - Lazy `ora` progress spinner on TTY (auto-disabled in CI / piped output / `--no-spinner`)
  ```

### Step 12 — Local gates on the committed tree

After `git commit`:
```
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm check:readme
```
All five must pass before push. Calibration §3 enforces this.

### Order of work

1. schemas (file.ts) — no deps
2. multipart.ts — no deps on api/, just node fs and undici
3. client.ts requestMultipart — additive
4. api/files.ts — uses client + schemas + multipart
5. human renderer — type-only deps
6. command leaf — uses everything above
7. parent registrar
8. wire into bin/freelo.ts
9. typecheck/lint loop (early — catches type errors before tests)
10. msw handlers (test/msw/handlers.ts)
11. tests (lib → api → commands)
12. test loop
13. coverage check
14. doc autogen
15. changeset
16. local gates on committed tree

### File touch budget

- 6 new src files
- 3 new test files
- 1 changeset
- 3 modified files (`client.ts`, `bin/freelo.ts`, `test/msw/handlers.ts`)
- 1 README diff (auto)

**Total: 14 file changes. Well within budget (25).**

### No new dependencies. No security review trigger.
