# Spec 0028 — `freelo comments add` — R17

**Status:** Draft → Implement
**Run:** 2026-04-28-1010-r17-comments-add
**Tier:** Yellow
**Roadmap:** R17 (`docs/roadmap.md`)
**Depends on:** R16 (`comments` command group; `CommentFullSchema`), R15 (`src/lib/input.ts`; editor/file/stdin pattern), R09 (`dryRunEnvelope`, write-command shape)

---

## 1. Problem

R16 lets an agent **read** comments (`GET /all-comments`). There is still no way to **post** one from the CLI — agents must hand-roll the HTTP request. R17 closes that gap with `freelo comments add`, the smallest end-to-end vertical slice for posting a comment to a task.

This is a daily-driver primitive — agents log progress, paste status updates, file questions. It must work under both interactive (TTY editor) and zero-prompt (env-driven, `--from-file` / `-` / `--message`) flows, mirror R15's input-source contract, and emit the standard agent-safe envelope (`schema`, `data.would` under `--dry-run`, structured errors).

## 2. API surface

### 2.1 `POST /task/{task_id}/comments`

`docs/api/freelo-api.yaml:2576-2617`. Body:

```yaml
required: [content]
properties:
  content: string
  files: FileUpload[]
```

Response: `Comment` (200). The envelope shape returned matches what R16 already validates as a `CommentFull`-ish object, but the singleton response from POST is not paginated and is described by `#/components/schemas/Comment` (loose; we accept and validate via a passthrough schema).

**Critical non-obvious behavior (yaml :2589-2592):**

> If the task has no comments yet, this call creates the task's **description** instead of a regular comment (`is_description=true` is auto-flipped). From the second comment onward this endpoint behaves like a normal comment.

We do **not** branch on this; the user-facing CLI calls it `comments add` regardless. The response's `is_description` field is surfaced verbatim in the envelope so agents can detect the flip after the fact. Help text and docs warn about it; agents who specifically want a description should use `freelo tasks description set` (R15).

`files[]` is **out of scope for v1** (multipart upload helper lands at R25). The CLI sends `{ content }` only.

### 2.2 `Comment` response schema (singleton)

OpenAPI `#/components/schemas/Comment`. We declare a new lean schema `CommentCreatedSchema` in `src/api/schemas/comment.ts` (alongside `CommentFullSchema`) — passthrough, with these fields:

```ts
{
  id: number | null;
  uuid: string | null;
  content: string;
  date_add: string;
  date_edited_at?: string | null;
  is_description?: boolean | null;     // critical — surfaces the auto-flip
  author?: UserBasic;
}
```

Optional fields are `.nullable().optional()` to match R16's tolerance posture. `.passthrough()` to forward-compat additions. Full coverage of `comments_reactions[]`, `files[]` etc. is out of scope for v1.

We do NOT reuse `CommentFullSchema` because:
- `CommentFull` requires `date_edited_at` (used by `--since`); singleton POST response may not include it on initial creation.
- `CommentFull` was designed for `/all-comments` rows that always have an entity-link block; the singleton POST response does not.
- A separate schema keeps R16's contract (which is observed by `--since` filtering) untouched.

## 3. CLI surface

```
freelo comments add --task <id>
                    (--message <str> | --from-file <path> | --editor | -)
                    [--dry-run]
                    [--output auto|human|json|ndjson]
```

### 3.1 Flags

| Flag | Type | Required | Notes |
|---|---|---|---|
| `--task <id>` | positive int | yes | Target task id. Parsed via `parsePositiveIntFlag` mirroring R16/R15. |
| `--message <str>` | string | one-of | Inline content. Mutex with the other three sources. |
| `--from-file <path>` | string | one-of | UTF-8 file read (delegates to `src/lib/input.ts`). |
| `--editor` | bool | one-of | Spawn `$VISUAL`/`$EDITOR` (TTY-only; delegates to `src/lib/input.ts`). |
| `-` (positional) | sentinel | one-of | Read stdin to EOF (delegates to `src/lib/input.ts`). |
| `--dry-run` | bool | optional | Skip the POST; envelope echoes the body that would have been sent. |

**Mutex rule:** exactly one of `--message`, `--from-file`, `--editor`, `-` is required. Zero or more-than-one → `ValidationError` exit 2.

**`--task` is a flag, not a positional**, mirroring `comments list`'s `--project <id>` / `--type <kind>` shape (R16). No positional `<task_id>` argument — the only positional this command accepts is the literal `-` sentinel for stdin.

### 3.2 Output schema: `freelo.comments.add/v1`

Envelope `data`:

```jsonc
{
  "task_id": 9012,
  "comment": Comment,                                  // server response; absent in --dry-run
  "source": "message" | "file" | "editor" | "stdin",   // which input produced the body; absent in --dry-run
  "byte_length": 1234,                                 // UTF-8 bytes of content sent (or that would be sent)
  "is_description": false,                             // pulled up from comment.is_description for easy access (false if absent); absent in --dry-run
  "would": {                                           // only in --dry-run
    "method": "POST",
    "path": "/task/9012/comments",
    "body": { "content": "..." }
  }
}
```

**Why pull `is_description` to the envelope top-level?** It's load-bearing — agents need a reliable, always-present boolean to branch on the description-flip case. Defaulting to `false` when the server omits the field gives a stable shape; `comment.is_description` is the raw passthrough.

### 3.3 Human renderer (`src/ui/human/comments-add.ts`)

- **Live success (regular comment):** `Added comment to task #9012 (1234 bytes from file).`
- **Live success (description flip):** `Added comment to task #9012 (1234 bytes from file). Note: this was the task's first comment, so it became the task description (use \`freelo tasks description set\` for explicit description writes).`
- **Dry-run:** `(dry-run) Would POST /task/9012/comments (1234 bytes from file).`

Sync renderer — no I/O, no lazy imports needed.

### 3.4 Help text

```
Add a single comment to a task. Content comes from one of four sources:
--message <str> (inline), --from-file <path>, --editor (TTY only), or - (stdin).

Note: if the target task has no prior comments, the API converts this into
the task's description instead of a regular comment. Use
`freelo tasks description set` to explicitly set the description.
```

## 4. Wire wrapper (`src/api/comments.ts` — extend)

Add to the existing R16 module:

```ts
export type AddCommentBody = {
  content: string;
};

export type AddCommentInput = {
  content: string;
};

export type AddCommentOpts = FetchOpts & {
  taskId: number;
  body: AddCommentBody;
};

export type AddCommentResult = {
  comment: CommentCreated;
  raw: ApiResponse<CommentCreated>;
};

export function addCommentPath(taskId: number): string {
  return `/task/${taskId}/comments`;
}

export function buildAddCommentBody(input: AddCommentInput): AddCommentBody {
  return { content: input.content };
}

export async function addComment(client: HttpClient, opts: AddCommentOpts): Promise<AddCommentResult> {
  const raw = await client.request({
    method: 'POST',
    path: addCommentPath(opts.taskId),
    body: opts.body,
    schema: CommentCreatedSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { comment: raw.data, raw };
}
```

Mirrors `setTaskDescription` byte-for-byte, swap `TaskCommentSchema` → `CommentCreatedSchema`, swap path.

## 5. Error mapping

Standard typed-error pipeline (R09/R15 precedent). Custom hint rewrites for resource-specific statuses:

| HTTP | Class | Exit | Hint rewrite |
|---|---|---|---|
| 401 | `FreeloApiError`(AUTH_EXPIRED) | 3 | default ("re-auth …") |
| 403 | `FreeloApiError`(FORBIDDEN) | 4 | "Account does not have permission to add comments to task `<id>`." |
| 404 | `FreeloApiError`(NOT_FOUND) | 4 | "Task `<id>` not found, or your account does not have access to it." |
| 422 | `FreeloApiError`(FREELO_API_ERROR) | 4 | default (server validation message) |
| 5xx | `FreeloApiError`(SERVER_ERROR) | 4 | default |
| 429 | `RateLimitedError`  | 6 | default |
| network | `NetworkError` | 5 | default |
| validation (CLI-side) | `ValidationError` | 2 | per-rule custom hints |

Hint rewriter: `rewriteAddCommentHint(err, taskId)` — local helper, not exported (mirrors R15's `rewriteSetHint`).

## 6. Idempotency

**N/A by design.** Each `POST /task/{id}/comments` creates a new comment row server-side; there is no natural-key dedupe. Two consecutive identical invocations create two identical comments. This is documented in the help text and in `docs/commands/comments-add.md` so users know the expected semantics.

We do not ship a client-side "did I already post this?" check — that would require persistent state and a hashing convention; out of scope. Agents that need at-most-once delivery should track their own request ids upstream.

## 7. Edge cases / decisions

### Decision 1 — `--message` empty string

**Question:** Should `freelo comments add --task 9012 --message ''` be allowed?

**Decision:** **Reject** with `ValidationError`. Same posture as R15's `tasks description set` (which rejects empty content for the same reason). An empty comment is never a useful intent; the server would 422 anyway.

**Rationale:** Fail fast at the CLI layer with a clear hint ("--message must be non-empty") before the wire round-trip. Mirrors R15 §3.3 / spec 0026 §5.7.

### Decision 2 — `--message` with a multi-line string

**Question:** Should `--message` strip / preserve trailing newlines?

**Decision:** **Preserve verbatim.** Whatever the shell hands us is sent as-is. No trim, no normalization.

**Rationale:** Same posture as R15's stdin path (`trimTrailingNewline: false`). The CLI is a transport, not an editor.

### Decision 3 — Surfacing `is_description`

**Question:** Where does the "this was a description flip" signal live in the envelope?

**Decision:** Two places:
1. `data.comment.is_description` — raw, may be `null` / absent (passthrough).
2. `data.is_description` — pulled-up boolean, **defaults to `false` when the server omits the field**.

**Rationale:** Agents reading the envelope shouldn't need to remember which key the server uses. The pulled-up field is a stable, always-present boolean. The raw field stays in `comment` for completeness.

### Decision 4 — Source enum: `'message'`

**Question:** Does the existing `SetDescriptionSourceSchema = z.enum(['file', 'editor', 'stdin'])` cover R17?

**Decision:** **Add a new enum** `AddCommentSourceSchema = z.enum(['message', 'file', 'editor', 'stdin'])` for R17. Do not modify R15's enum.

**Rationale:** R15 has no `--message` source; touching its enum is a schema bump for no reason. R17 owns its own enum, scoped to its own envelope.

### Decision 5 — `--message` does NOT route through `src/lib/input.ts`

**Question:** Should we extend `InputSource` with `{ kind: 'message', value: string }`?

**Decision:** **No.** `--message` is a pure pass-through (no I/O); handle it inline in the command. `src/lib/input.ts` stays focused on file/stdin/editor sources where I/O resolution + error mapping is non-trivial.

**Rationale:** Adding `'message'` to `InputSource` would force every R15-shaped consumer to handle a no-op kind. The cleaner split: pass-through values are inline, I/O sources are dispatched.

### Decision 6 — `--task` value of zero or negative

**Question:** Same as R15 — `parseTaskId` rejects.

**Decision:** Reject with `ValidationError` exit 2. Reuse the `parsePositiveIntFlag('--task', …)` helper pattern (literal copy from R16).

### Decision 7 — Help-text mention of the description flip

**Question:** Mention the auto-flip in `--help`?

**Decision:** **Yes**, one short line as shown in §3.4. Agents read help via `--introspect` / `freelo help --output json`, so the warning belongs in the surface. Full explanation lives in `docs/commands/comments-add.md`.

## 8. Non-goals

- File attachments (`files[]`). Lands at R25.
- Editing existing comments (`POST /comment/{id}`). Lands at R18.
- Deleting comments. Lands at R18.
- Batch input via `--stdin` NDJSON for multiple comments at once. R17 v1 ships single-comment only — adding NDJSON batch is straightforward additive follow-up.
- Tracking-user notification suppression flags. Out of scope.

## 9. Open questions

None remaining. The spec is implementable as drafted.

---

## Plan

### Files to create / modify

| File | Action | Intent |
|---|---|---|
| `src/api/schemas/comment.ts` | modify | Add `CommentCreatedSchema` + `CommentCreated` type (singleton response shape). Add `AddCommentSourceSchema` + `CommentsAddDataSchema` envelope-data shape. |
| `src/api/comments.ts` | modify | Add `AddCommentBody`, `AddCommentInput`, `AddCommentOpts`, `AddCommentResult`, `addCommentPath`, `buildAddCommentBody`, `addComment`. |
| `src/commands/comments/add.ts` | create | Leaf command. `outputSchema: 'freelo.comments.add/v1'`, `destructive: false`. |
| `src/commands/comments.ts` | modify | One import + one `registerAdd` call. |
| `src/ui/human/comments-add.ts` | create | Sync renderer (3 shapes: live regular, live description-flip, dry-run). |
| `test/msw/handlers.ts` | modify | Add `commentsAddHandlers` — `addOk`, `addOkWhenBody`, `addUnauthorized`, `addForbidden`, `addNotFound`, `addUnprocessable`, `addServerError`, `addRateLimited`, `addNetworkError`, `addOkAsDescription` (the auto-flip case). |
| `test/commands/comments/add.test.ts` | create | Mirrors `test/commands/tasks/description-set.test.ts` shape; covers happy paths × 4 sources, dry-run, validation, HTTP errors, introspect. |
| `docs/commands/comments-add.md` | create | User-facing docs page; two examples; description-flip warning. |
| `.changeset/r17-comments-add.md` | create | Minor bump; mention new schema `freelo.comments.add/v1`. |
| `README.md` | modify | Run `pnpm fix:readme` after build to refresh the autogen Commands block. |

**Total: 10 file touches** (well under the 25-file budget).

### Test strategy

All vitest + MSW. No new deps.

**Unit-level smoke (in `test/commands/comments/add.test.ts`):**
- `--message` happy path: source='message', byte_length matches `Buffer.byteLength`.
- `--from-file` happy path: source='file'.
- `-` (stdin) happy path with mocked stdin.
- `--editor` happy path with `FREELO_FAKE_EDITOR_*` (mirroring R15 fake-editor fixture pattern).

**Validation (every `ValidationError` path → exit 2 — Calibration §2):**
- No source flag at all → "exactly one".
- Two sources (`--message` + `--from-file`) → "Specify exactly one".
- `--editor` in non-TTY → "interactive".
- `--message ''` → "empty".
- `--from-file` with empty content → "empty".
- Missing `--task` → "required".
- `--task` non-numeric / zero / negative → "positive integer".

**HTTP errors (Calibration §2 — every typed error class triggered):**
- 401 → AUTH_EXPIRED exit 3
- 403 → FORBIDDEN exit 4 with permission hint
- 404 → NOT_FOUND exit 4 with "not found" hint
- 422 → FREELO_API_ERROR exit 4 (no resource-specific hint rewrite)
- 5xx → SERVER_ERROR exit 4
- 429 → RATE_LIMITED exit 6
- network → NETWORK_ERROR exit 5

**Description-flip case:**
- 200 with `is_description: true` in response → envelope's `data.is_description === true`; human renderer mentions the flip.
- 200 without `is_description` → envelope's `data.is_description === false`; human renderer is regular.

**Wire-body capture:**
- `addOkWhenBody` predicate captures the body; assert `{ content: <body> }` exact match.

**Dry-run:**
- No HTTP handler registered; `onUnhandledRequest: 'error'` would trip a real network call.
- Envelope: `dry_run: true`, `data.would.method === 'POST'`, `data.would.path === '/task/9012/comments'`, `data.would.body.content === <body>`.
- Live-only fields (`comment`, `source`, `is_description`) absent from `data` in dry-run.

**Introspect:**
- `freelo --introspect` lists `comments add` with `output_schema: 'freelo.comments.add/v1'` and `destructive: false`.

**Coverage targets** (per `.claude/docs/sdlc.md` Phase 4):
- 80% lines overall
- 90% on `src/api/comments.ts` and `src/commands/comments/add.ts`

### Rollout

Single landable PR. No multi-slice split required.

### Sequencing

1. Schemas (`src/api/schemas/comment.ts`) — additive; existing R16 schemas untouched.
2. Wire wrapper (`src/api/comments.ts`) — additive; existing `getAllComments` untouched.
3. Human renderer (`src/ui/human/comments-add.ts`) — pure function.
4. Command (`src/commands/comments/add.ts`) — wires the above.
5. Registration (`src/commands/comments.ts`) — one-line addition.
6. MSW handlers (`test/msw/handlers.ts`) — additive `commentsAddHandlers`.
7. Tests (`test/commands/comments/add.test.ts`) — full coverage matrix.
8. Docs (`docs/commands/comments-add.md`).
9. Changeset (`.changeset/r17-comments-add.md`).
10. README autogen refresh (`pnpm build && pnpm fix:readme`).

### No new dependencies

Confirmed: implementation reuses `commander`, `zod`, `undici` (via `client`), `src/lib/input.ts`, `src/lib/dry-run.ts`, `src/ui/envelope.ts` — all already in tree.
