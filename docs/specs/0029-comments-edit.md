# Spec 0029 — `freelo comments edit`

**Status:** Draft
**Owner:** orchestrator (run `2026-04-28-1309-r18-comments-edit-delete`)
**Roadmap:** R18 (post-resume scope: edit only; delete deferred to R18.5)
**Date:** 2026-04-28

## 1. Problem

R17 lets agents create comments on tasks (`POST /task/{id}/comments`). There is no command yet to **revise** an existing comment. The Freelo OpenAPI exposes one endpoint for that purpose — `POST /comment/{comment_id}` (operationId `editComment`, yaml :2619-2663) — and the v1 CLI must surface it with the same agent-safe write contract every other write command honors (`--dry-run`, batch input, mutex content sources, structured envelope, exit-code-first error path).

The original roadmap entry mentioned `PATCH /comment/{comment_id}` and a sibling `DELETE /comment/{comment_id}`. Triage confirmed the OpenAPI **disagrees on both**: the verb is POST (yaml :2634 — "POST for historical reasons, not PUT/PATCH"), and no `delete` operation exists on `/comment/{comment_id}`. Per `/resume Q1=A, Q2=A` (run `phase-reports/01-triage-resume.md`), this slice ships only `comments edit`; `comments delete` is deferred to R18.5 pending an OpenAPI confirmation.

## 2. Proposal

### 2.1 CLI surface

```
# Single id, content from one of four sources (mutex, exactly one):
freelo comments edit <id> --message <str>     [--dry-run]
freelo comments edit <id> --from-file <path>  [--dry-run]
freelo comments edit <id> --editor            [--dry-run]
freelo comments edit <id> -                   [--dry-run]   # `-` is the stdin sentinel

# Batch over comment ids — shared content from --message / --from-file / --editor:
freelo comments edit <id1> <id2> <id3> --message <str>     [--dry-run]
freelo comments edit --ids "1,2,3"     --message <str>     [--dry-run]
freelo comments edit --ids "1 2 3"     --from-file <path>  [--dry-run]

# Batch via NDJSON — varied content per row, each line `{"id": <int>, "content": <str>}`:
freelo comments edit --stdin                              [--dry-run]
```

### 2.2 Source mutex matrix

Exactly one **content source** must be chosen on non-stdin paths:

| Mode                       | Content source              | Mutex constraints                                     |
| -------------------------- | --------------------------- | ----------------------------------------------------- |
| Single positional `<id>`   | `--message` / `--from-file` / `--editor` / `-` | exactly-one-of (mirrors R17)                         |
| Variadic `<id>...` (≥2)    | `--message` / `--from-file` / `--editor`         | exactly-one-of; `-` (stdin sentinel) **rejected** (would conflict with --stdin batch read; see decision 1) |
| `--ids "a,b,c"`            | `--message` / `--from-file` / `--editor`         | exactly-one-of; `-` rejected (same reason)            |
| `--stdin` (NDJSON batch)   | per-row `content` from each line                 | content sources `--message` / `--from-file` / `--editor` / `-` **all rejected** (NDJSON owns content per row) |

**Mutex of input sources** (orthogonal to content sources): exactly one of {positional `<id>...`, `--ids`, `--stdin`} — same shape as R13 `tasks delete`.

Combining `<id>...` + `--ids` + `--stdin` → `VALIDATION_ERROR` (exit 2). Zero ids of any kind → `VALIDATION_ERROR` (exit 2) with hint pointing at the three input sources.

### 2.3 Endpoint

`POST /comment/{comment_id}` — `editComment` operationId — yaml :2619-2663:

```yaml
/comment/{comment_id}:
  post:
    tags: [Comments]
    summary: Edit an existing comment
    operationId: editComment
    parameters:
      - name: comment_id
        in: path
        required: true
        schema: { type: integer }
    requestBody:
      required: true
      content:
        application/json:
          schema:
            type: object
            required: [content]
            properties:
              content: { type: string }
              files:
                type: array
                items: { $ref: '#/components/schemas/FileUpload' }
    responses:
      '200':
        description: Comment updated
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Comment' }
```

Behavior notes from yaml :2631-2634 that drive the spec:

- `files` replaces the **full** attachment set (not a delta). v1 omits `files` from the wire body — multipart helper lands at R25.
- ACL: only the comment's author (or project owner / commander) can edit. Otherwise the API returns **404** `NotFoundException` (not 403) to avoid leaking the existence of inaccessible comments. The CLI surfaces 404 with a hint that names both possible causes.
- The verb is **POST**, not PUT/PATCH (yaml :2634, explicit). The CLI mirrors that on the wire and in the `would.method` of dry-run envelopes. Roadmap §R18 is updated in the same PR to drop the PATCH wording (decision 6).

## 3. Design

### 3.1 Files — new and modified

#### New

- `src/commands/comments/edit.ts` — leaf command. Mirrors R13 `src/commands/tasks/delete.ts` for the batch shape and R17 `src/commands/comments/add.ts` for the content-source mutex. Lazy credential resolution; per-id loop with `ExitCodeAccumulator`; per-row NDJSON parser.
- `src/ui/human/comments-edit.ts` — pure renderer, three shapes (live, dry-run, batch row).
- `test/commands/comments/edit.test.ts` — full integration suite (happy paths, mutex, validation, HTTP errors, batch positional, batch `--ids`, batch `--stdin` NDJSON, introspect).
- `docs/commands/comments-edit.md` — user-facing docs page (two realistic examples + envelope schema + error table).
- `.changeset/<random>.md` — `freelo-cli: minor` changeset entry.

#### Modified

- `src/api/comments.ts` — add `editComment(client, opts)`, `editCommentPath(commentId)`, `buildEditCommentBody(input)`, types `EditCommentBody`, `EditCommentInput`, `EditCommentOpts`, `EditCommentResult`. Same shape as `addComment` but on a different path; reuses `CommentCreatedSchema`.
- `src/api/schemas/comment.ts` — add `CommentsEditDataSchema`, `CommentsEditData`, and `EditCommentSourceSchema` (alias / reuse of R17's `AddCommentSourceSchema` enum — see decision 4).
- `src/commands/comments.ts` — wire `registerEdit(comments, getConfig, env)` after `registerAdd`.
- `test/msw/handlers.ts` — add `commentsEditHandlers` (8 mocks: `editOk`, `editOkWhenBody`, `editUnauthorized`, `editForbidden`, `editNotFound`, `editUnprocessable`, `editServerError`, `editRateLimited`, `editNetworkError`).
- `docs/roadmap.md` — §R18 endpoint+CLI rewrite (decision 6); new R18.5 queued entry.
- `README.md` — autogen Commands block regenerated by `pnpm fix:readme`.

### 3.2 Envelope schema — `freelo.comments.edit/v1`

`data` shape (same field-presence convention as R17):

```ts
{
  comment_id: number;          // always present (path param echo)
  comment?: CommentCreated;    // present on live success; ABSENT on --dry-run
  source?: 'message' | 'file' | 'editor' | 'stdin' | 'ndjson';
                                // present on live; ABSENT on --dry-run
  byte_length: number;          // always present (UTF-8 byte length of content sent / would-be-sent)
  line_index?: number;          // present in `--stdin` per-row envelopes only (0-indexed)
  would?: {                     // present in --dry-run only (mirrors R09/R13/R15/R17)
    method: 'POST';
    path: string;
    body: { content: string };
  };
}
```

Top-level envelope fields (managed by `buildEnvelope` / `dryRunEnvelope`):

- `schema: "freelo.comments.edit/v1"` — always
- `dry_run: true` — only on `--dry-run`
- `rate_limit` — present on every live envelope (per-id in batch); absent on dry-run and on per-row error envelopes
- `request_id` — only when `--request-id` was passed
- `notice` — only when batch carries a notice (none expected in v1)

In **batch mode** (positional `<id>...` with ≥2 ids, `--ids` with ≥2 ids, or `--stdin`), each id emits a **separate envelope line** to stdout — the same NDJSON-stream-of-envelopes shape R11/R13 already use. Per-id errors emit a `freelo.error/v1` envelope with `error.context.input_index` (positional / `--ids`) or `error.context.line_index` (`--stdin`); the run finishes with the highest-of exit codes (decision 5).

### 3.3 Human renderer (TTY)

Three shapes:

```
# Live single:
Edited comment #1234567 (47 bytes from message).

# Live batch row (one line per id):
Edited comment #1234567 (47 bytes from message).
Edited comment #1234568 (47 bytes from message).

# Dry-run:
(dry-run) Would POST /comment/1234567 (47 bytes).
```

No TTY-only lazy imports beyond what the existing renderer infra already pulls in (`chalk` is lazy via `src/ui/render.ts`).

### 3.4 Decision log (this spec)

#### Decision 1 — `-` (stdin sentinel) is **single-id only**

In R17, `-` means "read content from stdin" with a single `--task` target. For R18, with batch over ids, allowing `-` simultaneously with positional `<id>...` (≥2) or `--ids` would force the same content onto every id (semantically fine) but allowing `-` with `--stdin` is impossible — both want stdin. To keep the rule simple and unambiguous, `-` is **rejected when count of ids > 1**, regardless of input source. Rationale: explicit > clever; `--from-file <(some-cmd)` is the POSIX escape hatch when bulk-content-from-stdin is genuinely needed.

#### Decision 2 — NDJSON row schema

Each line: `{"id": <positive int>, "content": <non-empty string>}` (strict — no extra keys; consistent with R13's `BatchLineSchema` style).

Why `content` per row (not optional): the v1 CLI does not have a "shared content + per-row id" stdin variant — that's what `--ids` is for. Mixing modes adds complexity for ~zero ergonomic gain.

#### Decision 3 — Empty content rejected at command layer (mirrors R17)

`--message ''`, an empty file, an editor save with no content, or an NDJSON row with `content: ""` → `VALIDATION_ERROR` (exit 2) **before** any wire round-trip. Server would 422 anyway (yaml's request body schema requires `content`), and pre-rejecting saves a round-trip and gives a cleaner agent-readable hint.

#### Decision 4 — Reuse R17's `AddCommentSourceSchema`, add `'ndjson'` variant

R17's `AddCommentSourceSchema` is `'message' | 'file' | 'editor' | 'stdin'`. R18 needs all four PLUS `'ndjson'` (when content came from a `--stdin` batch row). Rather than rename R17's enum, R18 declares a new `EditCommentSourceSchema` that is a strict superset.

This keeps R17's contract bytewise stable (no envelope schema change for R17) and keeps the source field discriminator-friendly for agents.

#### Decision 5 — Batch error semantics: highest-of exit code (mirrors R11/R13)

When a multi-id run has a mix of successes and failures, each line emits its own success or `freelo.error/v1` envelope to stdout, and the run exits with the **numerically highest** error code observed. A run with one 404 and one 5xx exits 4 (FREELO_API_ERROR / NOT_FOUND); with one 401 and one 422, exits 4; with one 401 and one 429, exits 6. This matches `tasks delete`'s `ExitCodeAccumulator` pattern.

#### Decision 6 — Roadmap touch-up rides with the PR (no precursor)

`docs/roadmap.md` §R18 currently says `PATCH /comment/{comment_id}` and `DELETE /comment/{comment_id}`. Per the resume payload, the touch-up is one PR (this slice's PR) — not a precursor. Specifically:

- Replace the §R18 `**Endpoints:**` line with: `**Endpoints:** \`POST /comment/{comment_id}\` (note: "POST for historical reasons, not PUT/PATCH" per OpenAPI :2634).`
- Drop the `comments delete` clause from the §R18 CLI block; rename the slice title to `R18 — \`freelo comments edit\``.
- Append a queued §R18.5 entry — `R18.5 — \`freelo comments delete\` (queued)` — that records: endpoint NOT in `docs/api/freelo-api.yaml` as of 2026-04-28; first action is to verify with `freelo-api-specialist` against a live test account; until then, no command shipped.

#### Decision 7 — `--dry-run` skips ALL HTTP, including for batch

Same as every prior write: dry-run is the contract for "did I really mean to do this?". For batch dry-run, every id emits its own dry-run envelope (with its own `would`) — no single coalesced envelope. This matches R13's per-id dry-run output and lets agents diff "what would have been sent for each id" line-by-line.

### 3.5 Edge cases

- **404 on edit**: per yaml :2633, ACL violations also return 404 (to avoid leaking comment existence). The CLI's hint for 404 names both possible causes: "Comment {id} not found, or your account does not have permission to edit it."
- **422 on edit**: server-side validation (e.g. content too long, malformed HTML). Surfaced as `FREELO_API_ERROR` (exit 4) with the server's `errors` array passed through verbatim.
- **403 on edit**: per yaml :2633 we should _not_ see a 403 from this endpoint, but the CLI's HTTP client maps 403 → `FORBIDDEN` (exit 4) generically. We test the path defensively (Calibration §2 — every typed error class touched needs an exit-code assertion).
- **401 on edit**: `AUTH_EXPIRED` (exit 3). Standard.
- **5xx**: `SERVER_ERROR` (exit 4). Standard.
- **429**: `RATE_LIMITED` (exit 6). Standard.
- **Network failure**: `NETWORK_ERROR` (exit 5). Standard.
- **NDJSON malformed line**: `VALIDATION_ERROR` (exit 2) per row, emitted as a `freelo.error/v1` envelope with `context.line_index`. Run continues; exit-accumulator captures.
- **Empty `--stdin`**: silent success (matches R09/R11/R13 batch convention). Exit 0.
- **`--editor` non-TTY**: `VALIDATION_ERROR` (exit 2), via `src/lib/input.ts`.

## 4. API surface (wire layer)

### 4.1 New module additions to `src/api/comments.ts`

```ts
export type EditCommentBody = {
  content: string;
};

export type EditCommentInput = {
  content: string;
};

export type EditCommentOpts = FetchOpts & {
  commentId: number;
  body: EditCommentBody;
};

export type EditCommentResult = {
  comment: CommentCreated;        // reuses R17's response shape — same `Comment` schema in OpenAPI
  raw: ApiResponse<CommentCreated>;
};

export async function editComment(
  client: HttpClient,
  opts: EditCommentOpts,
): Promise<EditCommentResult>;

export function editCommentPath(commentId: number): string; // → `/comment/{id}`

export function buildEditCommentBody(input: EditCommentInput): EditCommentBody;
```

Identical pattern to `addComment` byte-for-byte; only the path and operation name differ.

### 4.2 Schema additions to `src/api/schemas/comment.ts`

```ts
export const EditCommentSourceSchema = z.enum(['message', 'file', 'editor', 'stdin', 'ndjson']);
export type EditCommentSource = z.infer<typeof EditCommentSourceSchema>;

export const CommentsEditDataSchema = z.object({
  comment_id: z.number().int(),
  comment: CommentCreatedSchema.optional(),
  source: EditCommentSourceSchema.optional(),
  byte_length: z.number().int().nonnegative(),
  line_index: z.number().int().nonnegative().optional(),
  would: z
    .object({
      method: z.literal('POST'),
      path: z.string(),
      body: z.object({ content: z.string() }),
    })
    .optional(),
});
export type CommentsEditData = z.infer<typeof CommentsEditDataSchema>;
```

`CommentCreatedSchema` is reused — the OpenAPI's `editComment` response (yaml :2657-2663) is the same `Comment` schema as `createComment`'s response. No new response schema needed.

## 5. Examples

### 5.1 Quick inline edit (single id)

```bash
$ freelo comments edit 1234567 --message 'Updated: see PR #42 for the fix.'
Edited comment #1234567 (32 bytes from message).
```

### 5.2 Batch edit shared content (multiple ids, same body)

```bash
$ freelo comments edit --ids "1234567,1234568,1234569" --message 'Closed by sprint review.' --output json
{"schema":"freelo.comments.edit/v1","data":{"comment_id":1234567,"comment":{...},"source":"message","byte_length":24,"is_description":false},"rate_limit":{"remaining":98,"reset_at":"..."}}
{"schema":"freelo.comments.edit/v1","data":{"comment_id":1234568,...},"rate_limit":{...}}
{"schema":"freelo.comments.edit/v1","data":{"comment_id":1234569,...},"rate_limit":{...}}
```

### 5.3 NDJSON batch (varied content per row)

```bash
$ cat edits.ndjson
{"id":1234567,"content":"Updated: see PR #42 for the fix."}
{"id":1234568,"content":"Reverted; root cause was in upstream."}

$ FREELO_API_KEY=sk-... FREELO_EMAIL=agent@example.cz \
    freelo comments edit --stdin --output json < edits.ndjson
{"schema":"freelo.comments.edit/v1","data":{"comment_id":1234567,"comment":{...},"source":"ndjson","byte_length":32,"line_index":0},"rate_limit":{...}}
{"schema":"freelo.comments.edit/v1","data":{"comment_id":1234568,"comment":{...},"source":"ndjson","byte_length":38,"line_index":1},"rate_limit":{...}}
```

### 5.4 Dry-run before sending

```bash
$ freelo comments edit 1234567 --message 'Status update' --dry-run --output json
{"schema":"freelo.comments.edit/v1","dry_run":true,"data":{"comment_id":1234567,"byte_length":13,"would":{"method":"POST","path":"/comment/1234567","body":{"content":"Status update"}}}}
```

### 5.5 Agent-style invocation (env-var auth + `--output json`)

```bash
FREELO_API_KEY=sk-test FREELO_EMAIL=agent@example.cz \
  freelo comments edit 1234567 --from-file ./fix-note.html --output json | \
  jq -r '.data.comment.uuid'
```

## 6. Edge cases / non-goals

### 6.1 Non-goals (v1)

- **No `--files` / multipart attachment replacement** — yaml says `files` replaces the full set; the multipart helper lands at R25. Wire body omits `files` field.
- **No partial body** — `content` is required by the OpenAPI; the CLI rejects empty content. We do not allow editing only the file set.
- **No `--description` flag** — there is no separate description field on `Comment`; `is_description` is a server-derived boolean only, not a write target. (Use `freelo tasks description set` for descriptions.)
- **No `comments delete`** — deferred to R18.5 pending a confirmed delete endpoint.

### 6.2 Idempotency stance

`comments edit` is **not** an absorbing-state write — every successful POST replaces content; two consecutive identical POSTs produce two identical-content states (one for each call) but the API has no "already in target state" semantics. So:

- **No `already_in_target_state` field** in the envelope (unlike `tasks finish` / `tasks delete`).
- **No GET pre-check** — the POST is the source of truth.
- **Two consecutive identical edits** both return success; the second is a no-op effectively but the envelope reports it as a regular success.

Per the resume payload, `src/lib/idempotency.ts` is **not** wired by this slice.

### 6.3 Confirmation stance

Edit is **non-destructive**. No `--yes` flag interaction in this slice; `src/lib/confirm.ts` is **not** invoked. The global `--yes` flag remains usable on the root program but is ignored here.

## 7. Test plan

Coverage target: 90% on the new files. Calibration §2 — every typed error class touched gets an exit-code assertion. Calibration §4 — every new try/catch arm has a test row.

### 7.1 Test file: `test/commands/comments/edit.test.ts`

Mirrors `test/commands/comments/add.test.ts` for the single-id paths and `test/commands/tasks/delete.test.ts` for the batch paths.

Cases (organized as `describe` blocks):

**Happy paths (single id):**

1. `--message`: exit 0, envelope shape, `source: 'message'`, `byte_length` matches.
2. `--from-file`: source `'file'`, `byte_length` matches file size.
3. `--dry-run`: no POST (MSW `onUnhandledRequest:'error'` would trip), `dry_run: true`, `would.method === 'POST'`, `would.path === '/comment/1234567'`, `comment` and `source` ABSENT, `byte_length` present.
4. Wire body capture: `commentsEditHandlers.editOkWhenBody` predicate captures `{ content: <body> }` with no `files` field.
5. Human mode: `Edited comment #1234567 (… bytes from message).`
6. Human mode dry-run: `(dry-run) Would POST /comment/1234567 …`.

**Batch happy paths:**

7. Variadic `<id>...` with `--message`: 3 NDJSON envelopes on stdout, all exit 0.
8. `--ids "1,2,3"` with `--from-file`: 3 envelopes, `source: 'file'` on each, `byte_length` matches file.
9. `--stdin` NDJSON: 2 envelopes with `source: 'ndjson'`, `line_index: 0` and `line_index: 1`, varied `byte_length` per row.
10. Batch dry-run (`--ids "1,2"` + `--message body --dry-run`): 2 dry-run envelopes, no POST.
11. Batch single id (`--ids "1"` + `--message body`): single-id mode (1 envelope, errors bubble).

**Validation:**

12. Missing `<id>`: `VALIDATION_ERROR` exit 2, hint mentions positional / `--ids` / `--stdin`.
13. Non-numeric `<id>`: `VALIDATION_ERROR` exit 2, hint "positive integer".
14. Zero `<id>`: `VALIDATION_ERROR` exit 2.
15. Negative `<id>`: `VALIDATION_ERROR` exit 2.
16. No content source on single id: `VALIDATION_ERROR` exit 2 ("exactly one").
17. No content source on batch: `VALIDATION_ERROR` exit 2.
18. `--message` + `--from-file`: `VALIDATION_ERROR` exit 2 ("exactly one").
19. `--message` + `--editor`: `VALIDATION_ERROR` exit 2.
20. `-` + `--message`: `VALIDATION_ERROR` exit 2.
21. `-` with multiple ids (`<id1> <id2> -`): `VALIDATION_ERROR` exit 2 (decision 1).
22. `-` with `--ids "1,2"`: `VALIDATION_ERROR` exit 2 (decision 1).
23. `--stdin` + `--message`: `VALIDATION_ERROR` exit 2 (NDJSON owns content).
24. `--stdin` + `--from-file`: `VALIDATION_ERROR` exit 2.
25. Positional `<id>` + `--ids`: `VALIDATION_ERROR` exit 2 (input source mutex).
26. Positional `<id>` + `--stdin`: `VALIDATION_ERROR` exit 2.
27. `--ids ""` (empty): `VALIDATION_ERROR` exit 2 (no ids).
28. `--message ''` (empty): `VALIDATION_ERROR` exit 2 ("empty").
29. `--from-file` ENOENT: `VALIDATION_ERROR` exit 2 ("not found").
30. `--from-file` empty file: `VALIDATION_ERROR` exit 2 ("empty").
31. `--editor` non-TTY: `VALIDATION_ERROR` exit 2 ("interactive").
32. NDJSON malformed line (not JSON): `freelo.error/v1` per-row envelope with `context.line_index`, exit 2.
33. NDJSON line missing `id`: per-row error, exit 2.
34. NDJSON line with `content: ""`: per-row error (empty content), exit 2.
35. NDJSON line with `id: 0`: per-row error.
36. NDJSON empty stdin: silent success exit 0.

**HTTP errors (single id, mirrors R17):**

37. 401: `AUTH_EXPIRED` exit 3.
38. 403: `FORBIDDEN` exit 4 (defensive; yaml says 404 instead).
39. 404: `NOT_FOUND` exit 4 with hint mentioning permission AND missing comment.
40. 422: `FREELO_API_ERROR` exit 4 (no resource-specific hint rewrite for 422).
41. 5xx: `SERVER_ERROR` exit 4.
42. 429: `RATE_LIMITED` exit 6.
43. Network: `NETWORK_ERROR` exit 5.

**Batch HTTP-error mix:**

44. Mixed batch: 2 ids, one 200 + one 404 → exit 4, two stdout envelopes (one success + one `freelo.error/v1`).
45. NDJSON batch: 2 lines, line 0 yields 401, line 1 yields 200 → exit 3 (highest of accumulator… wait, 4>3 — verify; since only one error fired, exit should be 3).

Actually the highest-exit-of rule means the run exits with `max(observed)`. For mixed-401-and-200 the exit is 3.

**Introspect:**

46. `freelo --introspect` lists `comments edit` with `output_schema: 'freelo.comments.edit/v1'`, `destructive: false`.

### 7.2 Unit tests

No new pure-helper functions warrant unit tests beyond the integration coverage — `buildEditCommentBody` and `editCommentPath` are trivial pass-throughs (R17 set the precedent of folding their tests into the integration suite).

### 7.3 MSW handler additions (`test/msw/handlers.ts`)

```ts
export const commentsEditHandlers = {
  editOk(commentId, body),
  editOkWhenBody(commentId, predicate, response),
  editUnauthorized(commentId),
  editForbidden(commentId),
  editNotFound(commentId),
  editUnprocessable(commentId, message?),
  editServerError(commentId, status?),
  editRateLimited(commentId),
  editNetworkError(commentId),
};
```

Same shape as `commentsAddHandlers`; just the path differs (`POST /comment/{id}` vs `POST /task/{id}/comments`).

## 8. Open questions

**None.** The resume payload (`Q1=A, Q2=A`) closed the two original ambiguities. Spec is self-contained against `docs/api/freelo-api.yaml:2619-2663` and prior slices' precedents (R09, R11, R13, R15, R17).

## 9. References

- `docs/api/freelo-api.yaml:2619-2663` — `editComment` operation (canonical contract)
- `docs/api/freelo-api.yaml:2634` — explicit "POST for historical reasons, not PUT/PATCH" note
- `docs/api/freelo-api.yaml:2631-2633` — ACL semantics (404 on non-author edit attempts)
- `docs/specs/0028-comments-add.md` — R17 sister spec; envelope shape and source mutex precedent
- `docs/specs/0026-tasks-description.md` — R15 origin of `src/lib/input.ts`
- `docs/specs/0024-tasks-delete.md` — R13 batch + ExitCodeAccumulator precedent
- `docs/specs/0021-tasks-finish-reopen.md` — R11 NDJSON batch precedent
- `docs/runs/2026-04-28-1309-r18-comments-edit-delete/phase-reports/01-triage.md` — Yellow tier confirmation
- `docs/runs/2026-04-28-1309-r18-comments-edit-delete/phase-reports/01-triage-resume.md` — `Q1=A, Q2=A` interpretation

---

## Plan

(Generated immediately after spec — phase 3.)

### Files to create

- [ ] `src/commands/comments/edit.ts` — leaf command. Single + batch modes; mutex enforcement; dry-run; per-id loop; lazy client.
- [ ] `src/ui/human/comments-edit.ts` — pure renderer (live + batch row + dry-run shapes).
- [ ] `test/commands/comments/edit.test.ts` — full integration suite (cases 1–46).
- [ ] `docs/commands/comments-edit.md` — user docs (synopsis + envelope + 2+ examples + error table).
- [ ] `.changeset/<random-name>.md` — `freelo-cli: minor`. Title: "freelo comments edit (R18)".

### Files to modify

- [ ] `src/api/comments.ts` — append `editComment` / `editCommentPath` / `buildEditCommentBody` + types (mirror `addComment` block).
- [ ] `src/api/schemas/comment.ts` — append `EditCommentSourceSchema`, `CommentsEditDataSchema`, types.
- [ ] `src/commands/comments.ts` — `import { registerEdit } …; registerEdit(comments, getConfig, env);`
- [ ] `test/msw/handlers.ts` — append `commentsEditHandlers` (8 mocks, mirror `commentsAddHandlers`).
- [ ] `docs/roadmap.md` — §R18 endpoint+CLI rewrite (decision 6); add §R18.5 queued entry.
- [ ] `README.md` — autogen Commands block (regenerated by `pnpm fix:readme` after build).

### No new dependencies

All needed helpers exist: `commander`, `zod`, `src/lib/input.ts` (R15), `src/lib/batch.ts` (R09), `src/lib/dry-run.ts` (R09), `src/ui/envelope.ts` (R01), `src/api/client.ts` (R01), `src/errors/handle.ts` (R01).

### Test strategy

- **Integration only** (Vitest + MSW). All 46 cases above run inside `test/commands/comments/edit.test.ts`. No separate unit tests — `editComment` and `buildEditCommentBody` are trivial pass-throughs covered by the integration assertions on path and wire body.
- MSW serves all HTTP responses; `onUnhandledRequest: 'error'` catches dry-run regressions.
- Coverage target: 90% on `src/commands/comments/edit.ts`, 90% on `src/ui/human/comments-edit.ts`, ≥85% on the appended block of `src/api/comments.ts`.

### Rollout order (single-PR slice)

1. `src/api/schemas/comment.ts` (additive types)
2. `src/api/comments.ts` (`editComment` + helpers; no breaking change)
3. `src/ui/human/comments-edit.ts`
4. `src/commands/comments/edit.ts`
5. `src/commands/comments.ts` (wire)
6. `test/msw/handlers.ts` (mocks)
7. `test/commands/comments/edit.test.ts` (full suite)
8. `docs/commands/comments-edit.md`
9. `docs/roadmap.md` (§R18 rewrite + §R18.5)
10. `pnpm fix:readme` → commit regenerated `README.md` block
11. `pnpm changeset` → `freelo-cli: minor`

### Gates (Calibration §3 — run AFTER commit on clean tree)

```
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme
```

All five must pass before push.

### CI matrix

Standard: Node 20 + 22 × Ubuntu / macOS / Windows. Branch protection on `main` enforces all 7 status checks (matrix + `check README autogen`).
