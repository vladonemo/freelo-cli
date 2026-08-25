# 0061 — M01: `freelo comments delete`

**Run:** `2026-08-25-0813-comments-delete`
**Tier:** Yellow
**Roadmap:** `docs/roadmap-migration-2026-08.md` §M01 — supersedes `docs/roadmap.md` §R18.5 (queued 2026-04-28, unblocked by the 2026-08-24 API refresh).
**Depends on (all shipped):** R18 `comments edit`, R13 `tasks delete` / `src/lib/confirm.ts`, R09 `src/lib/batch.ts`.

---

## 1. Problem

The `comments` resource has three verbs today — `list` (R16), `add` (R17), `edit` (R18) — and no way to remove a
comment. A user who posts to the wrong task, pastes the wrong content, or leaks something they shouldn't have has
exactly one recourse from the terminal: `comments edit` the content into a redaction placeholder, leaving a visible
"edited" stub in the thread.

R18.5 specified the delete verb back on 2026-04-28 but was parked because `DELETE /comment/{comment_id}` was not in
the OpenAPI document — the Comments tag declared exactly three operations. The 2026-08-24 refresh (PR #112) added it
with `operationId: deleteComment`, so the slice is unblocked and needs no live probing.

## 2. Proposal

### 2.1 Surface

```
freelo comments delete [id...] [--ids <list>] [--stdin] [--dry-run] [--yes]
```

Structurally identical to `freelo tasks delete` (R13). Every flag below already exists elsewhere in the CLI with the
same meaning; **this slice introduces no new flag name and no new flag semantics.**

| Flag / arg  | Meaning                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| `[id...]`   | One or more numeric comment ids, variadic positional. Mutex with `--ids` and `--stdin`.                       |
| `--ids <list>` | Comma- or space-separated comment ids. Mutex with positional and `--stdin`.                                |
| `--stdin`   | NDJSON on stdin, one `{"id": <int>}` per line. Mutex with positional and `--ids`.                             |
| `--dry-run` | Skip every DELETE **and** the confirmation prompt. Envelope echoes the call that would have been made.         |
| `--yes` / `-y` | **Global flag** (registered on the root program, `src/bin/freelo.ts`). Bypasses the confirmation prompt.    |

There is **no `-` stdin sentinel** here. In `comments edit` the `-` positional means "read the *content* from stdin";
delete has no content, so `-` has nothing to denote and is rejected as a non-numeric id by the ordinary `<id>` parser.

### 2.2 Input-source matrix

Exactly one of `{positional [id...], --ids, --stdin}` must be supplied. Zero sources → `ValidationError`
(`No comment ids supplied.`, exit 2). More than one → `ValidationError` (`Pick exactly one input source: …`, exit 2).
An input source that resolves to zero ids (empty `--stdin`) is a **silent success, exit 0** — the R09/R11/R13 batch
convention.

### 2.3 Confirmation policy

Delegated wholesale to `confirmDestructive` (`src/lib/confirm.ts`), fired **once per run**, not once per id:

- `--yes` → proceed silently.
- `--dry-run` → proceed silently (no destructive effect to gate).
- TTY without `--yes` → prompt `Delete N comment(s)?`, default `false`. Decline → `ConfirmationError`, exit 2.
- Non-TTY without `--yes` → `ConfirmationError` immediately, exit 2, **no wire calls, no credential resolution**.

For `--stdin`, confirmation fires *after* stdin is buffered so an empty pipe never prompts, and it counts **lines**,
not valid rows — the user is consenting to "process the N lines I sent" (R13 decision 7).

### 2.4 Example invocations

Human, TTY, interactive confirm:

```console
$ freelo comments delete 4821993
? Delete 1 comment? (y/N) y
Deleted comment #4821993.
```

Agent, env-var auth, batch, explicit consent:

```console
$ FREELO_API_KEY=… FREELO_EMAIL=… freelo comments delete --ids "4821993,4821994" --yes --output json
{"schema":"freelo.comments.delete/v1","data":{"comment_id":4821993,"current_state":"deleted","already_in_target_state":false},"rate_limit":{"remaining":4998,"reset_at":"2026-08-25T09:00:00Z"}}
{"schema":"freelo.comments.delete/v1","data":{"comment_id":4821994,"current_state":"deleted","already_in_target_state":false},"rate_limit":{"remaining":4997,"reset_at":"2026-08-25T09:00:00Z"}}
```

Error path — the deletion window has closed:

```console
$ freelo comments delete 4700001 --yes --output json
{"schema":"freelo.error/v1","error":{"code":"FREELO_API_ERROR","message":"Comment 4700001 can no longer be deleted — Freelo's 15-minute deletion window since the comment was posted has expired.","errors":["Comment is too old to be deleted."],"http_status":400,"request_id":null,"retryable":false,"hint_next":"Freelo only allows a comment to be deleted within 15 minutes of posting (docs/api/freelo-api.yaml :3216-3217). Editing has no time limit — use `freelo comments edit 4700001 --message \"…\"` to redact the content instead.","docs_url":null}}
$ echo $?
4
```

## 3. API surface

`DELETE /comment/{comment_id}` — `operationId: deleteComment`, `docs/api/freelo-api.yaml` :3203-3232.
Verified against the cached spec text on 2026-08-25; no live call made (`allowNetwork: false`).

| Aspect       | Contract                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------- |
| Path param   | `comment_id`, `integer`, required                                                              |
| Request body | none                                                                                           |
| `200`        | `Comment deleted` — **no response schema declared** (unlike `editComment`, which returns a `Comment`) |
| `400`        | `The 15-minute deletion window has expired`                                                    |
| `404`        | `Comment not found or not owned by the caller`                                                 |

The yaml's own behavior notes (:3215-3217) confirm both roadmap claims verbatim:

> - ACL: only the comment's author can delete. Otherwise 404 is returned (not 403, to avoid leaking the existence of inaccessible comments).
> - **Time window:** a comment can be deleted only within **15 minutes** of being posted. After that the endpoint returns 400. (Editing a comment has no such time limit.)

Two consequences the design leans on:

- **Nothing server-derived to surface.** With no 200 body schema, the envelope's `data` can only echo the input and
  the verb's implied outcome. Same position `tasks delete` is in (`SuccessResponseSchema` is parsed defensively but
  never surfaced), so the wire wrapper mirrors `src/api/tasks-delete.ts` exactly.
- **400 has exactly one documented cause.** That makes it safe to name the cause in the error message rather than
  passing HTTP 400 through generically. The server's own `errors[]` array still rides along on the envelope, so if
  Freelo ever adds a second 400 cause the raw text remains visible and nothing is hidden.

## 4. Data model

### 4.1 New envelope schema — `freelo.comments.delete/v1`

Added to `src/api/schemas/comment.ts`:

```ts
export const CommentsDeleteDataSchema = z.object({
  comment_id: z.number().int(),
  current_state: z.literal('deleted'),
  already_in_target_state: z.boolean(),
  would: z
    .object({
      method: z.literal('DELETE'),
      path: z.string(),
      body: z.unknown(),
    })
    .optional(),
  line_index: z.number().int().min(0).optional(),
});
export type CommentsDeleteData = z.infer<typeof CommentsDeleteDataSchema>;
```

- `comment_id` — echoed input. Always present.
- `current_state` — `'deleted'`, derived from the verb (there is no other terminal state a delete can produce).
- `already_in_target_state` — **always `false` in v1.** Retained for cross-command uniformity: an agent looping
  `tasks delete` / `projects delete` / `labels delete` / `comments delete` reads one field shape everywhere. Typed
  `z.boolean()` rather than `z.literal(false)` deliberately, so that if Freelo ever gives us a way to distinguish
  "already deleted" from "not yours", widening the value is not a retype-breaking schema change. See §5.1.
- `would` — `--dry-run` only. Mirrors R09/R13/R15/R17.
- `line_index` — `--stdin` NDJSON rows only; **absent** for positional / `--ids` / single-id flows (R11/R13 contract).

`previous_state` is deliberately **not** carried. In `TasksDeleteData` it is a task-lifecycle enum that is hardcoded
`null` on the delete path anyway; comments have no lifecycle enum, so the field would be null-typed noise.

### 4.2 NDJSON input row

```ts
const BatchLineSchema = z.object({ id: z.number().int().positive() }).strict();
```

Byte-identical to R13's. `.strict()` so typo'd keys surface immediately.

## 5. Error cases

| Trigger                          | Class               | `code`                  | Exit | `retryable` | `hint_next`                                                          |
| -------------------------------- | ------------------- | ----------------------- | ---- | ----------- | -------------------------------------------------------------------- |
| Non-integer / `< 1` `<id>`        | `ValidationError`   | `VALIDATION_ERROR`      | 2    | false       | "`<id>` is the numeric comment id (from `freelo comments list`)."     |
| `--ids` empty after split         | `ValidationError`   | `VALIDATION_ERROR`      | 2    | false       | "`--ids` takes a comma- or space-separated list of numeric ids."      |
| Zero input sources                | `ValidationError`   | `VALIDATION_ERROR`      | 2    | false       | "Pass numeric ids positionally, or use `--ids`, or pipe NDJSON."      |
| Two+ input sources                | `ValidationError`   | `VALIDATION_ERROR`      | 2    | false       | "Combining input sources is ambiguous…"                               |
| Malformed NDJSON row              | `ValidationError`   | `VALIDATION_ERROR`      | 2    | false       | (from `parseNdjsonLine`)                                              |
| Non-TTY, no `--yes`               | `ConfirmationError` | `CONFIRMATION_REQUIRED` | 2    | false       | "Pass `--yes` to bypass the prompt, or run from a TTY."               |
| TTY, user declines                | `ConfirmationError` | `CONFIRMATION_REQUIRED` | 2    | false       | "Re-run with `--yes` to bypass the prompt."                           |
| **400 — window expired**          | `FreeloApiError`    | `FREELO_API_ERROR`      | 4    | false       | §5.2 — names the 15-minute rule and points at `comments edit`         |
| **404 — missing or not yours**    | `FreeloApiError`    | `NOT_FOUND`             | 4    | false       | §5.1 — plain not-found, ACL nuance in the hint only                   |
| 401                               | `FreeloApiError`    | `AUTH_EXPIRED`          | 3    | false       | (client default) "Run `freelo auth login`…"                           |
| 403 (defensive — yaml says 404)   | `FreeloApiError`    | `FORBIDDEN`             | 4    | false       | (client default)                                                      |
| 5xx                               | `FreeloApiError`    | `SERVER_ERROR`          | 4    | **true**    | (client default)                                                      |
| 429 past retry budget             | `RateLimitedError`  | `RATE_LIMITED`          | 6    | true        | (client default)                                                      |
| Socket failure                    | `NetworkError`      | `NETWORK_ERROR`         | 5    | true        | (client default)                                                      |

### 5.1 404 is an error, **not** idempotent-success — divergence from R13

`src/commands/tasks/delete.ts` :423-442 catches `NOT_FOUND` on DELETE and re-emits it as a success envelope with
`already_in_target_state: true`. **This command must not do that**, and the divergence is the single most important
design point in the slice.

For tasks, 404-on-delete has one meaning: the task is already gone, so reporting success is honest. For comments,
yaml :3216 makes 404 structurally ambiguous — it is returned both when the comment does not exist *and* when it
exists but belongs to someone else. Absorbing it would tell a user "deleted" about a colleague's comment that is
still sitting in the thread, and would tell an agent `exit 0` for an operation that had no effect. That is a silent
correctness failure, and it is exactly what the requirement forbids ("Surface this as a plain 'not found' error").

So: 404 propagates as `FreeloApiError` / `NOT_FOUND` / exit 4, with the message kept **plain** —
`Comment 4821993 not found.` — and the ACL nuance confined to `hint_next`:

> Comment 4821993 not found. It may not exist, or you may not be its author — Freelo returns 404 rather than 403 for
> comments you cannot access, so the two cases are indistinguishable from the API (docs/api/freelo-api.yaml :3215).

The message layer never says "forbidden" or "permission"; a caller pattern-matching on `code` sees `NOT_FOUND`, which
is exactly what the server said. `already_in_target_state` consequently stays `false` on every v1 code path.

### 5.2 400 is rewritten, not passed through

`FreeloApiError.fromResponse` maps any unclassified 4xx to `FREELO_API_ERROR` with the message
`Freelo API error (HTTP 400).` — a dead end for both humans and agents. The command layer rewrites it, following the
`rewriteEditCommentHint` precedent already living in `src/commands/comments/edit.ts` :618-633:

- **message:** `Comment <id> can no longer be deleted — Freelo's 15-minute deletion window since the comment was posted has expired.`
- **hint_next:** `Freelo only allows a comment to be deleted within 15 minutes of posting (docs/api/freelo-api.yaml :3216-3217). Editing has no time limit — use \`freelo comments edit <id> --message "…"\` to redact the content instead.`

The hint's pointer to `comments edit` is the actionable half: it is the real workaround, and the yaml explicitly notes
that editing carries no time limit.

`code`, `exitCode` (4), `retryable` (false), `errors[]`, `httpStatus`, and `requestId` are all preserved unchanged.
**No new `FreeloApiErrorCode` union member is introduced** — see decision 2.

## 6. Output

### 6.1 JSON / NDJSON

One `freelo.comments.delete/v1` envelope per id on stdout, carrying `rate_limit` from the response headers and
`request_id` when `--request-id` was supplied. Multi-id and `--stdin` runs emit one line per id in input order.

### 6.2 Human

New renderer `src/ui/human/comments-delete.ts`, two shapes:

- live success → `Deleted comment #4821993.`
- dry-run → `(dry-run) Would delete comment #4821993.`

No "was already deleted" shape: `already_in_target_state` is unreachable-true in v1 (§5.1), and adding a branch that
no test can exercise would be dead code and a coverage hole (calibration §4).

### 6.3 Batch error envelopes

Multi-id and `--stdin` runs use the standard per-item `freelo.error/v1` writer on **stdout**, with
`context.line_index` (stdin) or `context.input_index` (positional / `--ids`) plus `context.comment_id`. Processing
continues past a failed id; the highest exit code wins at end-of-loop (`ExitCodeAccumulator`). Single-id runs bubble
to the top-level handler so an agent sees exactly one envelope on **stderr**.

## 7. Non-goals

- **No `--force` / window override.** The 15-minute limit is server-side; there is nothing to override.
- **No pre-flight GET** to check age or authorship before deleting. Two round-trips on a destructive op for
  information the DELETE response already gives us — R13 decision 4 rejected this and it applies unchanged.
- **No cascade or bulk-by-filter delete** (e.g. "delete every comment I made on task X"). Ids only.
- **No undo.** Freelo's delete is a soft-delete server-side but exposes no restore endpoint for comments.
- **No live API verification.** `allowNetwork: false`; the endpoint is fully documented and MSW covers the tests.

## 8. Open questions

None. The endpoint is fully documented, the CLI shape is prescribed by the roadmap slice, the two contestable
behaviors (404 policy, 400 message) are pre-answered by the requirement, and no new dependency is involved.

---

## Plan

### Files

| # | File | Action | Intent |
|---|------|--------|--------|
| 1 | `src/api/comments-delete.ts` | create | Wire wrapper: `deleteComment(client, commentId, opts)` + `deleteCommentPath(commentId)`. Mirrors `src/api/tasks-delete.ts`; tolerant `SuccessResponseSchema` with `.passthrough()`. Lives in its own file (not `comments.ts`) to match the `tasks-delete.ts` split and avoid a name collision with `editComment`'s neighbours. |
| 2 | `src/api/schemas/comment.ts` | modify | Append `CommentsDeleteDataSchema` + `CommentsDeleteData` (§4.1) with the doc comment explaining why `already_in_target_state` is permanently `false`. |
| 3 | `src/commands/comments/delete.ts` | create | The command. Structure copied from `src/commands/tasks/delete.ts`: `meta` (`destructive: true`), id parsers, `validateInputSources`, `runIdList`, `runBatchFromStdin`, `runOneId`, `writeBatchError`, `toBaseError`, `resolveYesFlag`. Adds `rewriteDeleteCommentError` for the 400/404 rewrites (§5.1, §5.2). **Removes** R13's 404-absorbing catch arm. |
| 4 | `src/commands/comments.ts` | modify | `import { registerDelete } from './comments/delete.js'` + call it; update the header comment that currently says delete is queued/unspecced. |
| 5 | `src/ui/human/comments-delete.ts` | create | Two-shape renderer (§6.2). |
| 6 | `test/msw/handlers.ts` | modify | Add `commentsDeleteHandlers`: `deleteOk`, `deleteNotFound` (404), `deleteWindowExpired` (400), `deleteUnauthorized` (401), `deleteForbidden` (403), `deleteServerError` (5xx), `deleteRateLimited` (429), `deleteNetworkError`. Mirrors `tasksDeleteHandlers` :1271+. |
| 7 | `test/commands/comments/delete.test.ts` | create | Full suite, §Tests below. |
| 8 | `docs/commands/comments-delete.md` | create | User doc, ≥2 realistic examples, the 15-minute window and author-only ACL called out prominently, cross-link to `comments-edit.md` as the workaround. |
| 9 | `README.md` | regenerate | `pnpm fix:readme` — new command must appear in the autogen block or `pnpm check:readme` fails CI (sdlc.md Phase 6). |
| 10 | `docs/roadmap.md` | modify | R18.5 → shipped, pointing at this spec. |
| 11 | `docs/roadmap-migration-2026-08.md` | modify | M01 → shipped, pointing at this spec. |
| 12 | `.changeset/<name>.md` | create | `minor`. Must call out the new `freelo.comments.delete/v1` schema (CLAUDE.md: schema bumps need a dedicated changeset line) **and** the 404-is-an-error divergence from other delete commands. |

### Dependencies

**None.** No new runtime dep, no dep bump, no dep removal. Everything reused: `confirmDestructive` (R13),
`ExitCodeAccumulator` / `iterateLines` / `parseNdjsonLine` (R09), `buildEnvelope` (R01), `attachMeta` (R02.5).

### Tests

Integration, via MSW, in `test/commands/comments/delete.test.ts`. Each row states what it proves.

**Happy paths**
1. Single positional id + `--yes` → one `freelo.comments.delete/v1` envelope, `current_state: 'deleted'`, exit 0.
2. Multi positional + `--yes` → two envelopes, input order preserved, exit 0.
3. `--ids "a,b"` + `--yes` → same as (2); proves the flag parser.
4. `--stdin` NDJSON + `--yes` → envelopes carry `line_index` 0,1.
5. Single-id envelope has **no** `line_index` key — R11/R13 byte-compat.
6. Envelope carries `rate_limit` from response headers.

**Dry-run**
7. `--dry-run` without `--yes` in non-TTY → exit 0, `would: {method:'DELETE', path:'/comment/<id>'}`, `dry_run: true`, and **zero** requests hit MSW.

**Confirmation (calibration §7 — clear `process.env.CI`, don't just spoof `isTTY`)**
8. Non-TTY, no `--yes` → `ConfirmationError`, `code: CONFIRMATION_REQUIRED`, **exit 2**, zero requests.
9. TTY (with `CI` deleted) + mocked `@inquirer/prompts.confirm` returning `false` → exit 2, zero requests.
10. TTY + confirm returns `true` → proceeds, exit 0.
11. Confirmation fires **once** for an N-id run, not N times.
12. Empty `--stdin` → exit 0, no prompt, no requests.

**The two load-bearing error surfaces**
13. **400** → exit 4, `code: FREELO_API_ERROR`, message contains `15-minute`, `hint_next` mentions `comments edit`,
    server `errors[]` still present. Proves §5.2.
14. **404** → exit 4, `code: NOT_FOUND`, `already_in_target_state` is **not** emitted as a success envelope
    (i.e. stdout carries no `freelo.comments.delete/v1` line). Proves the R13 divergence in §5.1 — this is the
    regression test that stops a future refactor from "restoring consistency" with `tasks delete`.
15. 404 message does **not** contain "forbidden" / "permission" / "403"; hint *does* explain the ACL nuance.
    Proves the requirement's "plain not-found, not a permission error" clause.

**Remaining typed-error coverage (calibration §2 — every class, asserting its exit code)**
16. 401 → `AUTH_EXPIRED`, exit 3.
17. 403 → `FORBIDDEN`, exit 4.
18. 500 → `SERVER_ERROR`, exit 4, `retryable: true`.
19. 429 past budget → `RATE_LIMITED`, exit 6 (`RateLimitedError.exitCode`, `src/errors/rate-limited-error.ts` :16 — **not** 5; 5 is `NetworkError`).
20. Network failure → `NETWORK_ERROR`, exit 5.

**Validation (all exit 2)**
21. Non-numeric `<id>`; 22. `<id>` of `0`; 23. zero input sources; 24. positional + `--ids` together;
25. `--stdin` + positional together; 26. NDJSON row with an extra key (`.strict()`); 27. NDJSON row with `id: "5"`.

**Batch semantics**
28. Mixed batch (ok, 404, ok) → both successes emitted, one `freelo.error/v1` on stdout with
    `context.input_index` + `context.comment_id`, exit 4 (max-of), and the run does not abort early.
29. Same for `--stdin`, asserting `context.line_index`.

**Human output**
30. `--output human` live → `Deleted comment #<id>.`; dry-run → `(dry-run) Would delete comment #<id>.`

**Introspection**
31. `freelo --introspect` lists `comments delete` with `destructive: true` and `outputSchema: 'freelo.comments.delete/v1'`.

Coverage target: `src/commands/**` and `src/api/**` ≥ 90% lines / ≥ 85% branches (the CI thresholds). Every `catch`
arm added by file 3 has a row above (calibration §4).

### Rollout

Single landable slice — ~600 lines including tests, well under the 400-line *source* threshold that would force
splitting. One commit, one PR, `minor` changeset.

### Gates before push (calibration §3 — on the committed tree)

`pnpm typecheck && pnpm lint && pnpm test:cov && pnpm build && pnpm check:readme`.
`test:cov`, not `test` — plain `pnpm test` does not enforce the branch-coverage threshold that CI enforces.

---

```
ARCHITECT run=2026-08-25-0813-comments-delete status=ok spec=docs/specs/0061-m01-comments-delete.md open_questions=0 new_deps=0
```
