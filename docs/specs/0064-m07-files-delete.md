# 0064 — M07: `freelo files delete`

**Run:** `2026-08-28-2039-files-delete`
**Tier:** Yellow (confirmed at triage, not inherited from the roadmap guess)
**Roadmap:** `docs/roadmap-migration-2026-08.md` §M07.
**Depends on (all shipped):** R25 `files upload`, R26 `files list`, R27 `files download`, R13 `tasks delete` / `src/lib/confirm.ts`, R09 `src/lib/batch.ts`, M01 `comments delete` (structural sibling).

---

## 1. Problem

The `files` group has three verbs today — `upload` (R25), `list` (R26), `download` (R27) — and no way to
remove anything. The surface is read/write asymmetric: a user can put a file into Freelo from the terminal
and take a copy back out, but the only way to get rid of one is the web UI.

That asymmetry bites hardest in exactly the situation where the terminal matters most. An agent or a CI
script that uploads a build artifact per run has no way to prune what it created; a user who uploads the
wrong document — or one containing something that shouldn't be there — has to leave the terminal to fix it.

`DELETE /file/{file_uuid}` has been in the OpenAPI document since the 2026-08-24 refresh (PR #112) with
`operationId: deleteDocOrFileByUuid`, so the slice needs no live probing.

## 2. Proposal

### 2.1 Surface

```
freelo files delete [uuid...] [--ids <list>] [--stdin] [--dry-run] [--yes]
```

Structurally identical to `freelo comments delete` (M01) and `freelo tasks delete` (R13). Every flag below
already exists elsewhere in the CLI with the same meaning; **this slice introduces no new flag name and no
new flag semantics.** The only shape difference from its two siblings is that ids are UUID strings, not
integers.

| Flag / arg     | Meaning                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `[uuid...]`    | One or more file/document UUIDs, variadic positional. Mutex with `--ids` and `--stdin`.             |
| `--ids <list>` | Comma- or space-separated UUIDs. Mutex with positional and `--stdin`.                               |
| `--stdin`      | NDJSON on stdin, one `{"uuid": "<string>"}` per line. Mutex with positional and `--ids`.            |
| `--dry-run`    | Skip every DELETE **and** the confirmation prompt. Envelope echoes the call that would have been made. |
| `--yes` / `-y` | **Global flag** (registered on the root program, `src/bin/freelo.ts`). Bypasses the confirmation prompt. |

There is **no `-` stdin sentinel**. Delete has no content to read from stdin, so `-` denotes nothing and is
rejected as a malformed UUID by the ordinary `<uuid>` parser. Same reasoning as M01.

### 2.2 Input-source matrix

Exactly one of `{positional [uuid...], --ids, --stdin}` must be supplied. Zero sources → `ValidationError`
(`No file UUIDs supplied.`, exit 2). More than one → `ValidationError` (`Pick exactly one input source: …`,
exit 2). An input source that resolves to zero UUIDs (empty `--stdin`) is a **silent success, exit 0** —
the R09/R11/R13/M01 batch convention.

### 2.3 Confirmation policy

Delegated wholesale to `confirmDestructive` (`src/lib/confirm.ts`), fired **once per run**, not once per
UUID:

- `--yes` → proceed silently.
- `--dry-run` → proceed silently (no destructive effect to gate).
- TTY without `--yes` → prompt `Delete N file(s) or document(s)?`, default `false`. Decline →
  `ConfirmationError`, exit 2.
- Non-TTY without `--yes` → `ConfirmationError` immediately, exit 2, **no wire calls, no credential
  resolution**.

For `--stdin`, confirmation fires *after* stdin is buffered so an empty pipe never prompts, and it counts
**lines**, not valid rows (R13 decision 7).

### 2.4 Example invocations

Human, TTY, interactive confirm:

```console
$ freelo files delete 3f7c1e2a-9b4d-4c8e-a1f0-6d5b8e2c7a41
? Delete 1 file or document? (y/N) y
Deleted file or document 3f7c1e2a-9b4d-4c8e-a1f0-6d5b8e2c7a41.
```

Agent, env-var auth, batch, explicit consent:

```console
$ FREELO_API_KEY=… FREELO_EMAIL=… freelo files delete \
    --ids "3f7c1e2a-9b4d-4c8e-a1f0-6d5b8e2c7a41,8a2b6c04-1e5f-4a9d-b3c7-2f8e0d1a4b56" --yes --output json
{"schema":"freelo.files.delete/v1","data":{"uuid":"3f7c1e2a-9b4d-4c8e-a1f0-6d5b8e2c7a41","current_state":"deleted","already_in_target_state":false},"rate_limit":{"remaining":4998,"reset_at":"2026-08-28T21:00:00Z"}}
{"schema":"freelo.files.delete/v1","data":{"uuid":"8a2b6c04-1e5f-4a9d-b3c7-2f8e0d1a4b56","current_state":"deleted","already_in_target_state":false},"rate_limit":{"remaining":4997,"reset_at":"2026-08-28T21:00:00Z"}}
```

Prune what a pipeline uploaded, via NDJSON:

```console
$ freelo files list --project 372 --type file --output json \
    | jq -c '.data.items[] | select(.name | startswith("build-")) | {uuid}' \
    | freelo files delete --stdin --yes
```

Error path — the UUID isn't there, or isn't yours:

```console
$ freelo files delete 00000000-0000-4000-8000-000000000000 --yes --output json
{"schema":"freelo.error/v1","error":{"code":"NOT_FOUND","message":"File or document 00000000-0000-4000-8000-000000000000 not found.","http_status":404,"request_id":null,"retryable":false,"hint_next":"It may not exist, it may already be deleted, or you may not have access to it — Freelo returns 404 rather than 403 for resources you cannot see, so the cases are indistinguishable from the API (docs/api/freelo-api.yaml :4504). Run `freelo files list` to see what is visible to you.","docs_url":null}}
$ echo $?
4
```

## 3. API surface

`DELETE /file/{file_uuid}` — `operationId: deleteDocOrFileByUuid`, `docs/api/freelo-api.yaml` :4492-4521.
Verified against the cached spec text on 2026-08-28; no live call made (`allowNetwork: false`).

| Aspect       | Contract                                                                        |
| ------------ | ------------------------------------------------------------------------------- |
| Path param   | `file_uuid`, `string`, `format: uuid`, required                                 |
| Request body | none                                                                            |
| `200`        | `File or document deleted` → `$ref: SuccessResponse`                            |
| `404`        | `No file or document found for the given UUID`                                  |

No other status is documented. In particular **there is no documented `400`** — so unlike M01, this slice
adds no 400-rewrite path (triage open concern 4). Inventing a message for an undocumented status would be
guessing at API behavior.

The yaml's own behavior notes (:4502-4504) are the load-bearing text for this design:

> - Soft-delete only — the resource is marked deleted, not physically removed.
> - Returns 404 if no file or document matches the UUID, **or the caller has no access to it**.

And :4497:

> Deletes a single **file** or **document/note** identified by its UUID. The endpoint resolves the resource
> type from the UUID automatically and soft-deletes it.

Three consequences the design leans on:

- **404 is ambiguous here.** See §5.1 — this is the slice's central decision.
- **Nothing server-derived to surface.** `SuccessResponse` is a bare `{ result: "success" }`-shaped
  envelope with no per-resource detail — notably no discriminator saying whether a *file* or a *document*
  was removed. The CLI therefore cannot report which kind it deleted, and must not pretend to (§4.2).
- **Soft-delete is invisible from the response.** The resource is marked deleted rather than purged, but the
  API exposes no undelete endpoint and no "deleted at" field on this response. `current_state: 'deleted'` is
  the honest report; the CLI does not claim the bytes are gone. Documented in the command's help text.

## 4. Data model

### 4.1 New envelope schema — `freelo.files.delete/v1`

Added to `src/api/schemas/file.ts`:

```ts
export const FilesDeleteDataSchema = z.object({
  /** The UUID we asked to delete (echoed for trace correlation). */
  uuid: z.string().min(1),
  current_state: z.literal('deleted'),
  /**
   * Always `false` in v1 — this command never absorbs a 404 into an idempotent
   * success (§5.1). Present for cross-command envelope consistency with
   * `freelo.tasks.delete/v1` and `freelo.comments.delete/v1` so agents can use
   * one branch for every delete.
   */
  already_in_target_state: z.boolean(),
  /** Present only on `--dry-run`. */
  would: z
    .object({ method: z.literal('DELETE'), path: z.string(), body: z.unknown() })
    .optional(),
  /** Present only in `--stdin` batch mode: the 0-based input line. */
  line_index: z.number().int().min(0).optional(),
});
```

Byte-for-byte the `freelo.comments.delete/v1` shape with `comment_id: number` → `uuid: string`. Keeping
`already_in_target_state` even though it is a constant `false` is deliberate: an agent scripting deletes
across resources gets one uniform field to read rather than a per-resource special case. M01 made the same
call.

### 4.2 What the envelope deliberately does not carry

No `type` / `kind` field. The endpoint resolves file-vs-document server-side and reports nothing about
which it found, so any such field would be a guess. An agent that needs the kind must read it from
`freelo files list` **before** deleting — which the response schema for `FileItem.type` already provides.

### 4.3 Wire-response schema

`SuccessResponseSchema` — a defensive `z.object({ result: z.string().nullable().optional() }).passthrough()`,
identical to the one in `src/api/comments-delete.ts` and `src/api/tasks-delete.ts`. Parsed so a malformed
2xx body still trips validation, never surfaced.

### 4.4 `--stdin` NDJSON line schema

```ts
const BatchLineSchema = z.object({ uuid: UuidStringSchema }).strict();
```

`.strict()` so a typo'd key (`{"id": …}`, `{"file_uuid": …}`) surfaces as a per-line error rather than being
silently ignored. The `uuid` value goes through the same 8-4-4-4-12 validation as the positional form, so a
malformed UUID never reaches the wire.

## 5. Edge cases

### 5.1 404 is an error, **not** idempotent success — the central decision

Every other delete in this CLI *except* M01's re-classifies a 404 on DELETE as success with
`already_in_target_state: true` (`src/lib/idempotency.ts`). **This command does not.** The requirement
correctly demanded this be re-derived from the endpoint's own documentation rather than copied from M01's
precedent, so here is the derivation.

The idempotency pattern is only sound when a 404 unambiguously means *"the resource is already in the
target state"*. `docs/api/freelo-api.yaml` :4504 states the opposite:

> Returns 404 if no file or document matches the UUID, **or the caller has no access to it.**

The endpoint therefore folds two distinct realities into one status code:

1. The resource genuinely doesn't exist (or was already soft-deleted) — absorbing this into success would be
   correct.
2. The resource exists and is fine, but is in a project the caller can't see — absorbing this would print
   `Deleted file or document <uuid>.` and exit 0 for a document that is **still sitting in someone else's
   project, untouched.**

Case 2 is not hypothetical for this endpoint: `files list` is project-scoped and a UUID can be copied from a
colleague, a wiki, a CI log, or another workspace. And the failure mode is exactly the one a delete command
must never have — reporting "removed" for something that was not removed. A cleanup script trusting exit 0
would tick the item off its list; a user auditing "did that leaked document actually go away?" would get a
false yes.

The reasoning is the same shape as M01's, but it is reached independently and rests on this endpoint's own
sentence, not on M01's. Freelo uses the ACL-hides-existence pattern on both endpoints; the yaml says so in
both places. Had :4504 read "returns 404 if no file or document matches the UUID" full stop, the ordinary
`src/lib/idempotency.ts` treatment would have been correct here and this spec would have specified it.

Consequences:

- No pre-check `GET` before the `DELETE`. A pre-check couldn't disambiguate either (the GET is behind the
  same ACL) and would double the request count for no information.
- No `src/lib/idempotency.ts` import in this slice.
- `already_in_target_state` is structurally present but unreachable-true in v1 (§4.1).
- Pinned by a **regression test** asserting exit 4 + `code: 'NOT_FOUND'` on a 404, so that a future
  "let's make all the deletes consistent" refactor fails loudly instead of silently regressing this.

### 5.2 404 message wording

The message stays a **plain** not-found: `File or document <uuid> not found.` It never says "forbidden" or
"permission" — the CLI genuinely cannot tell which case it hit, and asserting either would be a fabrication.
The ACL nuance lives in `hint_next` only, which is where a human or agent looks after the headline. Same
discipline as M01 (`src/commands/comments/delete.ts` :494-502).

### 5.3 Partial failure in batch mode

Mirrors R09/R11/R13/M01 exactly, unchanged:

- **Single-UUID runs**: the error bubbles to the top-level handler → one error envelope on **stderr**, exit
  = that error's code.
- **Multi-UUID runs** (`--ids`, multi-positional, `--stdin`): per-item `freelo.error/v1` envelopes on
  **stdout** interleaved in input order with the successes, processing continues, and the **highest** exit
  code wins at end-of-loop via `ExitCodeAccumulator`.
- Batch error envelopes carry `context.line_index` (stdin) or `context.input_index` (positional/`--ids`),
  plus `context.uuid` when the item parsed.

### 5.4 Duplicate UUIDs in one invocation

Not de-duplicated. The first DELETE succeeds; the second returns 404 and is reported as an error (per §5.1).
This is the honest outcome given §5.1 and matches M01. De-duplicating would be a silent input rewrite, and
the alternative (absorbing the second 404) is precisely what §5.1 rules out. Callers who want tolerance can
de-dupe upstream — `jq -c 'unique_by(.uuid)'` in the pipeline example.

### 5.5 Credentials and `--dry-run`

`--dry-run` never resolves credentials and never constructs an HTTP client — there is no wire call to
authenticate. Mirrors M01 and `comments edit`. In `--stdin` mode the client is built lazily on the first
valid line, so an all-malformed pipe never touches the keychain.

### 5.6 Error-status pass-through

`401` → `AUTH_EXPIRED` exit 3, `403` → `FORBIDDEN` exit 4, `429` → `RATE_LIMITED`, `5xx` → retryable exit 4,
network failure → `NetworkError`. All standard `src/api/client.ts` behavior, untouched. Only 404 gets
message/hint rewriting, and that rewriting preserves `code`, `exitCode`, `retryable`, `errors[]`,
`httpStatus` and `requestId` — it is presentation, never re-classification.

## 6. UX

### 6.1 Help text

The command description must state the three things a user can't infer from the name: that it handles
documents/notes as well as files, that deletion is a soft-delete, and that a 404 is reported as an error
rather than as an idempotent success (because that differs from `tasks delete`, which sits two commands
away in the same CLI).

### 6.2 Human renderer — `src/ui/human/files-delete.ts`

Two shapes, gated on `data.would`:

- Live success: `Deleted file or document <uuid>.`
- Dry-run: `(dry-run) Would delete file or document <uuid>.`

The phrase "file or document" is deliberate and slightly awkward: the endpoint won't tell us which one it
removed (§4.2), and `Deleted file <uuid>.` would be a plain untruth roughly whenever the UUID pointed at a
note. There is deliberately **no** "was already deleted" branch — `already_in_target_state` is
unreachable-true in v1, so a third branch would be dead code and a permanent coverage hole (calibration §4).

## 7. Non-goals

- **No `--recursive` / directory deletion.** `FileItem.type` includes `directory`, but the endpoint
  documents only file and document/note resolution. Whether passing a directory UUID cascades, errors, or
  orphans children is undocumented — guessing is out of bounds (autonomous-sdlc: "API behavior not in
  `freelo-api.yaml` → pause"). Out of scope; revisit if the API documents it.
- **No undelete/restore.** Soft-delete implies one might exist, but no such endpoint is documented.
- **No `--force` to skip the confirmation.** `--yes` is the established global flag for that; a second
  spelling would be surface bloat.
- **No filter-based bulk delete** (`--project`, `--type`). Composing `files list` with `--stdin` covers it
  (§2.4) without putting a "delete everything matching this filter" footgun in one flag.
- **No `already_in_target_state: true` path.** §5.1.

## 8. Open questions

None. The one genuinely open design question at intake — the 404 idempotency policy — is resolved in §5.1
from the endpoint's own documentation (`docs/api/freelo-api.yaml` :4504), which answers it unambiguously.
No question requires a human decision, so the run proceeds without a pause.

---

## Plan

**Phase:** 2 (plan). The plan is the contract — implementation deviating from it updates this section first.

### 9.1 Files to create

| File | Intent |
| --- | --- |
| `src/api/files-delete.ts` | Wire wrapper. `deleteFilePath(uuid)` + `deleteFile(client, uuid, opts)`. Defensive `SuccessResponseSchema` parse, never surfaced. No 404 special-casing — errors bubble. Mirrors `src/api/comments-delete.ts`. |
| `src/commands/files/delete.ts` | Command leaf: `registerDelete(parent, getConfig, env)`. Input parsing (UUID), source mutex, confirmation gate, single/multi/stdin dispatch, dry-run, 404 message rewrite, envelope + batch-error writers. Mirrors `src/commands/comments/delete.ts`. |
| `src/ui/human/files-delete.ts` | `renderFilesDeleteHuman(data)` — two branches (§6.2). |
| `test/commands/files/delete.test.ts` | End-to-end suite (§9.4). |
| `docs/commands/files-delete.md` | User docs page (§9.6). |
| `.changeset/*.md` | `minor` — new command + new envelope schema. |

### 9.2 Files to modify

| File | Change |
| --- | --- |
| `src/api/schemas/file.ts` | Append `FilesDeleteDataSchema` / `FilesDeleteData` (§4.1) under a new `M07` section header. Purely additive — no existing schema touched. |
| `src/commands/files.ts` | Import + call `registerDelete(files, getConfig, env)`; widen the group description from "Upload, list, and download" to include delete. |
| `test/msw/handlers.ts` | Append `filesDeleteHandlers` (§9.5). Additive. |
| `docs/roadmap-migration-2026-08.md` | Mark M07 shipped with spec + run links, matching the M01/M04/M08 format. |
| `README.md` | Autogen Commands block via `pnpm fix:readme` (never hand-edited). |
| `docs/commands/files-list.md`, `docs/commands/files-download.md` | One cross-reference line each to the new page, if a "See also" section already exists there. |

Budget check: 12 files, well under the 25-file cap.

### 9.3 New dependencies

**None.** Everything needed is already in the tree: `zod`, `commander`, `src/lib/confirm.ts`,
`src/lib/batch.ts`, `src/ui/envelope.ts`, `src/errors/*`. `src/lib/idempotency.ts` is deliberately **not**
used (§5.1).

### 9.4 Test strategy

`test/commands/files/delete.test.ts`, structured on `test/commands/comments/delete.test.ts` (same
`captureOutput` / `runCli` harness, same MSW lifecycle).

Unit-level (no I/O):
- `renderFilesDeleteHuman` — both branches, asserted directly so the dry-run copy is covered without a CLI round-trip.

Integration (MSW), grouped:

1. **Happy paths** — single positional; two positionals; `--ids`; `--stdin`; all with `--yes`. Assert
   envelope `schema`, `data.uuid`, `current_state`, `already_in_target_state === false`, exit 0. Assert
   `line_index` present in `--stdin` mode and **absent** in single mode (R11/R13 byte-compat).
2. **`--dry-run`** — no wire call (MSW `onUnhandledRequest: 'error'` proves it), no confirmation prompt even
   non-TTY without `--yes`, `data.would.method === 'DELETE'`, `data.would.path === '/file/<uuid>'`,
   `dry_run: true`, exit 0.
3. **404 regression (§5.1) — the load-bearing rows.** Assert exit **4**, `code: 'NOT_FOUND'`, message is
   exactly the plain not-found (`File or document <uuid> not found.`), message does **not** match
   `/forbidden|permission/i`, `hint_next` **does** mention access, and — the anti-refactor pin — that the
   payload is a `freelo.error/v1` envelope, **not** a success envelope with `already_in_target_state: true`.
4. **Confirmation policy** — non-TTY without `--yes` → `CONFIRMATION_REQUIRED`, exit 2, and **zero** requests
   reach MSW; `--dry-run` without `--yes` non-TTY → proceeds. TTY-decline path asserted at the
   `confirmDestructive` level via its `isInteractive` injection point (no global `isTTY` spoofing needed →
   calibration §7 footgun avoided entirely; if any test does spoof `isTTY`, it must `delete process.env.CI`).
5. **Validation (exit 2, `ValidationError`)** — malformed positional UUID; malformed `--ids` entry; empty
   `--ids`; two sources at once; zero sources; NDJSON line missing `uuid`; NDJSON line with an extra key
   (`.strict()`); NDJSON malformed JSON; NDJSON `uuid` failing the regex.
6. **Empty inputs** — empty `--stdin` → exit 0, no output, no prompt, no wire call.
7. **HTTP error matrix** — 401 → exit 3 `AUTH_EXPIRED`; 403 → exit 4 `FORBIDDEN`; 500 → exit 4 retryable;
   429 → `RATE_LIMITED`; network error → `NetworkError`. Calibration §2: every typed error class this slice
   can raise gets a row asserting its exit code.
8. **Batch semantics** — mixed matrix (ok / 404 / 500) via `deleteMatrix`: successes and per-item error
   envelopes both on stdout, input order preserved, `context.input_index` (positional) vs
   `context.line_index` (stdin) vs `context.uuid`, exit = max observed.
9. **Calibration §4** — every new `catch` arm has a row: the `rewriteDeleteFileError` 404 branch, its
   pass-through branch (a 500 keeps its generic message), and both batch per-item catches.
10. **Introspect** — `freelo --introspect` lists `files delete` with `destructive: true` and
    `outputSchema: 'freelo.files.delete/v1'`.

Coverage target: ≥90% on the new `src/commands/` and `src/api/` files, ≥80% lines overall. Verified with
`pnpm test:cov` (not bare `pnpm test` — only `test:cov` enforces the branch threshold CI gates on).

### 9.5 MSW handlers to add

`filesDeleteHandlers` in `test/msw/handlers.ts`, keyed on UUID strings rather than numeric ids:
`deleteOk`, `deleteNotFound` (404), `deleteUnauthorized` (401), `deleteForbidden` (403),
`deleteServerError` (5xx), `deleteRateLimited` (429, `Retry-After: 0`), `deleteNetworkError`, and
`deleteMatrix(Record<string, number>)` for mixed-batch rows. Direct analogue of `commentsDeleteHandlers`
(`test/msw/handlers.ts` :6349-6432). No 400 handler — the endpoint documents none (§3).

### 9.6 Documentation

- `docs/commands/files-delete.md`: synopsis, flag table, ≥2 realistic examples (interactive single delete;
  agent batch prune via `files list | jq | --stdin`), a **Soft delete** note, a **Why a 404 is an error here**
  note cross-linking §5.1, and the Freelo-side permission note (you must be able to see the resource).
- `pnpm fix:readme` after `pnpm build` to regenerate the autogen Commands block; commit the result.
- Mark M07 shipped in `docs/roadmap-migration-2026-08.md`.

### 9.7 Rollout order

One landable slice; each step leaves the tree green.

1. Schema (`src/api/schemas/file.ts`) + wire wrapper (`src/api/files-delete.ts`).
2. Human renderer + command leaf + registration in `src/commands/files.ts`.
3. `pnpm lint && pnpm typecheck`.
4. MSW handlers + test suite; `pnpm test:cov`.
5. Docs + changeset + `pnpm fix:readme`.
6. Commit, then re-run the full gate on the **committed** tree (calibration §3):
   `pnpm typecheck && pnpm lint && pnpm test:cov && pnpm build && pnpm check:readme`. Push only when all pass.
