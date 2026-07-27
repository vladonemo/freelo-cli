# 0059 — `FileBasicSchema` rejects Freelo's file DTO in `comments[].files[]`

**Status:** Root-caused (live repro captured) — plan approved, implementing
**Run:** 2026-07-27-1211-tasks-edit-validation
**Issue:** #105
**Type:** fix
**Changeset:** `patch`

> **Revision note (2026-07-27, resume).** §1-§5 of the original spec attributed the
> failure to an unknown `POST /task/{id}` response shape. That diagnosis was wrong and
> is superseded by the live repro in §2. The original text is preserved in git history
> (`6e7c79c`) and in `docs/runs/2026-07-27-1211-tasks-edit-validation/`; the refuted
> claims are catalogued in §3 rather than silently deleted.

---

## 1. Problem

`freelo tasks edit <id> --name "<new name>"` exits 4 with `VALIDATION_ERROR` for tasks
whose first comment carries a file attachment. The user gets a failure envelope for a
mutation that never even started.

## 2. Root cause (empirical)

The human ran the repro against the live API:

```
freelo tasks edit 18579501 --name "cli repro probe" -vv
```

stderr, verbatim:

```json
{"schema":"freelo.error/v1","error":{"code":"VALIDATION_ERROR","message":"Unexpected response shape from GET /task/18579501: [\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"number\",\n    \"received\": \"undefined\",\n    \"path\": [\n      \"comments\",\n      0,\n      \"files\",\n      0,\n      \"id\"\n    ],\n    \"message\": \"Required\"\n  }\n]","http_status":null,"request_id":"5f13fdc5-84b2-4d1e-9c6b-d6c7a5dbcf0d","retryable":false,"hint_next":null,"docs_url":null}
```

Reading it:

- **The failing call is `GET /task/{id}`**, not the POST. It is the unconditional
  pre-POST lookup at `src/commands/tasks/edit.ts:331`. The command aborts before any
  write — so the rename never happened and a retry is safe. (The `POST` in issue #105
  was the reporter's reconstruction of an uncaptured string; §3.)
- **The offending field is `comments[0].files[0].id`** — `expected: number,
  received: undefined`.
- **`FileBasicSchema` (`src/api/schemas/task.ts:266-273`) declares `id` and `uuid` as
  required.** Freelo's file DTO embedded in `comments[].files[]` carries no numeric
  `id`. Every task whose first comment has a file attachment fails validation.
- **Exactly one zod issue was reported for that object.** Zod reports every missing
  required key on an object, so `uuid` was present and valid — `id` is the sole
  blocker, and relaxing `id` alone is sufficient to make the body parse.

`tasks edit` is incidental. The defect is in the shared task-detail shape.

## 3. Refuted claims (kept for the audit trail)

| Claim | Source | Status |
|---|---|---|
| The failing request is `POST /task/{id}` | issue #105 | **Refuted** — repro says `GET`. Never a captured string; the issue states the zod list "has not been captured yet". |
| H1: POST returns something other than `TaskDetail` | issue #105 | **Refuted** — a real captured `POST /task/18579501` body validates against `TaskDetailSchema` (`VALIDATES: yes`). `docs/api/freelo-api.yaml:1713` is correct as written. |
| H2-H6: stringified ids / bare-string `state` / `labels[]` without `uuid` / out-of-enum `priority_enum` / partial `cost` | issue #105 | **Refuted** — each already absorbed by the current schema; the capture exercised all five. |
| Triage finding (a): "the GET passed, so the divergence is POST-specific" | `triage.md` | **Refuted** — the GET is precisely what failed. The inference was sound given the error string; the string was wrong. |
| Triage finding 2: `editTask()`'s parsed payload is never consumed | `triage.md` | **Still true**, but not the bug. Left alone — see §5. |

The POST response body omits `files` entirely, which is why only the GET fails. That
asymmetry is the whole reason the original static analysis went astray.

## 4. Fix

Bring `FileBasicSchema` in line with the module's own stated convention
(`src/api/schemas/task.ts:10-12`: *"Each non-required field is `.nullable().optional()`
because Freelo treats null and absent interchangeably"*) and with the two sibling
file-ref schemas written later, which already model this correctly:

- `src/api/schemas/comment.ts:62-66` — `FileFullRefSchema` = `{ uuid: z.string().nullable().optional() }.passthrough()`
- `src/api/schemas/note.ts:38-42` — `NoteFileRefSchema` = `{ uuid: z.string().nullable().optional() }.passthrough()`

`FileBasicSchema` is the outlier. `FileFullRefSchema` is the direct precedent: it sits
in the same position (the rich file object embedded in a comment) and requires nothing.

**The OpenAPI contract agrees.** `docs/api/freelo-api.yaml:5558-5569` declares
`FileBasic` with **no `required:` list at all** — every property is optional, and
`FileFull` (`:5571`, the schema actually referenced from `CommentWithFiles.files[]` at
`:5631`) `allOf`-extends it without adding one. So `id` and `uuid` were never required
by Freelo's own contract; our zod schema was simply stricter than the documented API.

That settles the "are we guessing the API?" question that made this run Red: we are not
widening a schema to chase a symptom, we are **removing a constraint we invented**. The
authoritative contract, the live wire behaviour, and both sibling schemas all agree with
each other and disagree only with `FileBasicSchema`.

```ts
const FileBasicSchema = z
  .object({
    id: z.number().int().nullable().optional(),
    uuid: z.string().nullable().optional(),
    filename: z.string().nullable().optional(),
    size: z.number().int().nullable().optional(),
  })
  .passthrough();
```

Both `id` and `uuid` are relaxed — see decision 1. No `z.unknown()`, no
`.catchall(z.any())`: the fields still validate *when present*, which is the whole
point of keeping a schema here.

## 5. Non-goals

- **Not** changing `editTask`'s validation semantics. The strict POST-response contract
  (`test/commands/tasks/edit.test.ts:930-948`, `editMalformed` → exit 4) stays exactly
  as-is; it was never implicated. Option B from `pause.md` is dropped.
- **Not** widening `TaskDetailSchema`'s other fields. The capture proved `state`,
  `labels[].uuid`, `priority_enum`, `cost`, and id types all validate today.
- **Not** the diagnostics work (`pause.md` option A2 — surfacing `rawBody` under
  `-vv`). Standalone-valuable and still worth doing, but it is Red-tier (touches
  `src/api/client.ts` + `src/errors/`, needs a security pass) and orthogonal to #105.
  Tracked separately.

## 6. Blast radius

`FileBasicSchema` has exactly two usages, both in `src/api/schemas/task.ts` (verified by
grep — no other module imports it, it is not exported):

| Site | Reached by |
|---|---|
| `:289` — `CommentWithFilesSchema.files[]` → `TaskDetailSchema.comments[].files[]` | `tasks show`, `tasks edit` (lookup GET **and** refresh GET), `tasks move` (pre-check GET and refresh GET) |
| `:422` — `TaskCommentSchema.files[]` | `GET /task/{id}/description` → `tasks description get`, `tasks description set` |

No renderer or command reads `file.id`: `src/ui/human/tasks-show.ts:68-70` only counts
`comments`, and the JSON path passes the parsed object straight through the envelope.
`tsc` is the authority — any fallout gets fixed in this change.

## 7. Envelope impact

None for bodies that already validated. `data.task` is emitted by passthrough; a file
object that previously carried a numeric `id` still carries it. The change only widens
what is *accepted*, so previously-crashing invocations now succeed. No envelope field is
removed, renamed, or retyped → **`patch`**, no `/v2` bump.

The one honest caveat, called out in the changeset and the PR body: consumers that read
`data.task.comments[].files[].id` were, before this change, guaranteed a number *or* a
hard failure. They now get `undefined` instead of a crash. That guarantee was
counterfeit — it was the bug.

---

## 8. Plan

No new dependencies. No new commands, flags, or envelope schemas.

### 8.1 Source

- [ ] `src/api/schemas/task.ts` — relax `FileBasicSchema.id` and `.uuid` to
      `.nullable().optional()`. Replace the bare declaration with a doc comment
      recording the repro, the two sibling precedents, and why the fields are not
      required. Single hunk; no other source file changes unless `tsc` says otherwise.

### 8.2 Fixtures — synthetic only (binding, see §9)

- [ ] `test/fixtures/tasks/show-task-9020-comment-file-no-id.json` — a `TaskDetail`
      whose `comments[0].files[0]` has `uuid` + `filename` + `size` and **no `id`**,
      the proven real-world shape. Second file entry keeps an `id` so both branches
      (present / absent) are exercised in one body. Placeholder content, synthetic ids
      and names.
The `:422` (`TaskComment`) body is **inlined** in `description-get.test.ts` rather than
given a fixture file — that suite already declares its bodies as local consts
(`FILLED_DESCRIPTION` / `EMPTY_DESCRIPTION`) and has no fixture loader. Following the
file's local convention beats importing machinery for one object.

### 8.3 Tests

No new MSW handlers: `tasksShowHandlers.detailOk(id, body)` and
`tasksShowHandlers.descriptionOk(id, body)` already accept arbitrary bodies.

- [ ] `test/commands/tasks/edit.test.ts` — regression describe block:
      lookup GET returns the no-`id` fixture → `tasks edit --name` exits **0**, the POST
      fires, `data.task` round-trips the file with `uuid` and without `id`.
      Plus the negative control: a body missing `comments[0].id` (a genuinely required
      key) still exits **4** — proving the relaxation is scoped, not a blanket
      loosening. Both assert exit codes (calibration §2).
- [ ] `test/commands/tasks/show.test.ts` — `tasks show` on the same fixture exits 0 and
      emits the file object intact.
- [ ] `test/commands/tasks/description-get.test.ts` — `GET /task/{id}/description`
      returning `files[0]` without `id` exits 0 (covers `:422` independently of
      `TaskDetailSchema`).
- [ ] Preserve `editMalformed` → exit 4 untouched.

### 8.4 Release + docs

- [ ] `.changeset/<name>.md` — `patch`, wording per §7 including the `files[].id`
      caveat.
- [ ] Docs: no user-facing surface change (no command, flag, or output-shape addition),
      so no `docs/commands/*.md` edit and no README autogen regeneration. `pnpm
      check:readme` still runs as a gate.

### 8.5 Rollout

Single landable slice. No feature flag, no migration.

### 8.6 Gates (calibration §3 — run on the clean committed tree)

`pnpm typecheck && pnpm lint && pnpm test:cov && pnpm build && pnpm check:readme`.
`test:cov`, not `test` — plain `pnpm test` does not enforce the branch-coverage
threshold that CI enforces.

## 9. Fixture hygiene (binding)

The real captured body contains live client data: `comments[].content` holds a
Slovak/Czech client conversation including a real domain and a third party's name, plus
real user ids and full names in `author` / `tracking_users`. CLAUDE.md forbids secrets
in fixtures and this is adjacent personal data.

Fixtures are **synthetic**: placeholder content strings, synthetic ids and names. Only
the JSON *types* and the key set that matter to the test are preserved — specifically a
`files[]` entry with `uuid` present and `id` absent. The real body does not land in
`test/fixtures/`, and it is not added to the run artifacts either.
