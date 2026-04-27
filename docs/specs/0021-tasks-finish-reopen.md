# 0021 — `freelo tasks finish` / `tasks reopen` (R11)

**Status:** Accepted — ready for implementation
**Run:** 2026-04-27-1435-r11-tasks-finish-reopen
**Tier:** Yellow (additive new commands + new envelope schemas; third write slice — first absorbing-state writes; ships shared idempotency helper)
**Branch:** `feat/tasks-finish-reopen`
**Cross-reference:** Patterns inherited from spec 0019 (R09 `tasks create` — write infra: `dry-run.ts`, `batch.ts`, NDJSON streamer) and spec 0020 (R10 `tasks edit` — lookup-then-write pattern). API endpoints differ (POST `/task/{id}/finish`, POST `/task/{id}/activate`) and the verbs are **state transitions to absorbing states**, not partial updates — hence the new shared idempotency helper.

---

## 1. Problem

After R10 an agent can create and partially edit tasks. R11 closes the most basic state-transition loop: **finish** (close a task) and **reopen** (un-finish, i.e. `/task/{id}/activate`). With R11 in hand an agent can wire end-to-end "ticket closed in upstream tool → close it in Freelo" automations and mid-pipeline reverts. Beyond surfacing two leaf commands, R11 ships **`src/lib/idempotency.ts`** — the shared "already-in-target-state" handler that R12+ reuse for archive, mark-read/unread, attach/detach-label, delete-by-id.

## 2. Background — what the API gives us

### 2.1 `POST /task/{task_id}/finish` (OpenAPI :1815-1840)

- Empty request body. 200 returns `SuccessResponse` (`{ result: 'success', ... }` — no echo of the task state).
- Behavior: closes the task, stops any running timetracking on that task, emits `task_finished` webhook.
- Permissions: assignee / author / project manager. Otherwise 403 (`RoleActionForbiddenException`).
- **Idempotency on finish-of-finished:** the OpenAPI does NOT explicitly state the response on a task that is already finished. We treat this as an unknown — we do NOT fire a redundant POST. Decision 1: **pre-check state via `GET /task/{id}` before each POST**. This is unambiguous and uniform across both verbs. Cost: +1 GET per id (in batch: 2× the request count, but each verb is rare and the cost is bounded by R-L budget).

### 2.2 `POST /task/{task_id}/activate` (OpenAPI :1789-1813)

- Empty request body. 200 returns `SuccessResponse`.
- Behavior: moves a finished task back to active. **Already-active task → 200 without changes** (natural idempotency, OpenAPI :1802). **Deleted task → 404** (activate is NOT undelete; not symmetric with the project activate endpoint).
- Permissions: same role rules as `/finish`.

Both verbs share enough shape that the implementation is **one function with the verb as a parameter** (`finishOrActivate(client, taskId, verb)`), called from two thin command files. Decision 2: collapse the wire wrapper, keep the commands separate.

### 2.3 State on the wire — what counts as "finished" / "active"

`TaskDetail.state` (already in `src/api/schemas/task.ts`, R08) is `{ id: number, state: 'active' | 'archived' | 'finished' | 'deleted' | 'template' }`. The `state.state` field is the source of truth. `state.id` is informational (Freelo's internal id; do NOT key off it).

For `tasks finish`: target = `'finished'`. Already-in-target if `task.state.state === 'finished'`. Refuse on `'deleted'` (a 404 from `/finish` would tell us the same thing later, but the pre-check makes the error unambiguous and saves the round-trip).

For `tasks reopen`: target = `'active'`. Already-in-target if `task.state.state === 'active'`. Refuse on `'deleted'` (the API returns 404; we can short-circuit). On `'archived'` / `'template'` we let the API decide and surface whatever 4xx comes back — those states are out of scope for v1 (decision 3).

## 3. Proposal

### 3.1 Subcommand signatures

Both commands take repeatable positional `<id>` arguments, plus the same flag set as R09's batch surface — modeled after the roadmap text:

```
freelo tasks finish <id>... [--ids <a,b,c>] [--stdin] [--dry-run]
freelo tasks reopen <id>... [--ids <a,b,c>] [--stdin] [--dry-run]
```

Sources of task ids (mutually exclusive, exactly one must resolve to ≥1 id):

1. **Variadic `<id>...` positional** — one or more numeric ids on the command line. The natural one-liner: `freelo tasks finish 9012 9013 9014`.
2. **`--ids <comma-separated>`** — comma-or-whitespace separated list. Decision 4: alias for the variadic positional, useful when caller already has a comma-list. Cannot be combined with positional `<id>...`.
3. **`--stdin`** — NDJSON, one `{ "id": <int> }` per line. Cannot be combined with positional or `--ids`.

If ZERO ids resolve (no positional, no `--ids`, `--stdin` reads zero lines): same convention as R09 batch — silent success exit 0 (decision 5).

`--dry-run`: skip every POST. **Pre-check GETs still run** — they are read-only and the dry-run envelope's `already_in_target_state` is more useful when it reflects the live state. Decision 6.

**Out of scope for R11 (deferred — log decisions, do not pause):**
- `--yes` / TTY confirmation prompts. `tasks finish` and `tasks reopen` are **reversible** in both directions, so neither is "destructive" in the sense `tasks delete` will be (R13). Decision 7 — `meta.destructive: false`.
- `--all-finished-in-tasklist` shortcut for reopen. Out.
- Filtering via `tasks list` piped output. Out — agents pipe `freelo tasks list ... | jq -r '.data.tasks[].id' | freelo tasks finish --stdin` (with NDJSON adapter, see §3.5).
- `--quiet` / suppressing per-id envelopes in batch. Out — every id always emits exactly one envelope (success or error).

**Per-command `meta`:**

```ts
// finish.ts
export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.finish/v1',
  destructive: false,
};

// reopen.ts
export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.reopen/v1',
  destructive: false,
};
```

### 3.2 Envelope shapes

Two new schemas: `freelo.tasks.finish/v1`, `freelo.tasks.reopen/v1`. They share the same `data` shape (only the `schema` discriminant differs), but we ship them as two distinct schemas so agents can route on `schema` alone. Decision 8.

**Live success (one id, single mode):**

```jsonc
{
  "schema": "freelo.tasks.finish/v1",
  "data": {
    "task_id": 9012,
    "previous_state": "active",
    "current_state": "finished",
    "already_in_target_state": false,
    "verb": "finish"
  },
  "rate_limit": { "remaining": 41, "reset_at": "..." },
  "request_id": "..."
}
```

**Already-in-target (no POST issued):**

```jsonc
{
  "schema": "freelo.tasks.finish/v1",
  "data": {
    "task_id": 9012,
    "previous_state": "finished",
    "current_state": "finished",
    "already_in_target_state": true,
    "verb": "finish"
  },
  "rate_limit": { "remaining": 39, "reset_at": "..." }
}
```

`already_in_target_state: true` means the **POST was skipped** because the pre-check showed the task already in the target state. `previous_state === current_state` in that case. The `rate_limit` block reflects the pre-check GET (the only HTTP call that ran).

**Dry-run (POST always skipped; pre-check GET runs unless --project-style escape hatch is used — but no such hatch in R11; we don't need it because the only "skipped" write is the pre-check anyway):**

```jsonc
{
  "schema": "freelo.tasks.finish/v1",
  "dry_run": true,
  "data": {
    "task_id": 9012,
    "previous_state": "active",
    "current_state": "active",
    "already_in_target_state": false,
    "verb": "finish",
    "would": { "method": "POST", "path": "/task/9012/finish", "body": {} }
  }
}
```

In dry-run, `current_state` === `previous_state` (because no POST happened). `already_in_target_state` reflects what we observed via GET — if the task is *already* in the target state, dry-run still emits `already_in_target_state: true` and **omits `would`** (no POST would have been made even live). Decision 9.

**Batch / NDJSON: one envelope per id**, identical to R09 batch shape. `data.line_index` is added when the source is `--stdin` (matches R09 convention); absent when source is positional or `--ids`. Decision 10.

**Error per id (validation, e.g. positional `<id>` is not a positive integer):**

Goes through the standard `freelo.error/v1` envelope. In batch mode (`--stdin` or multi-id sources) the `error.context.line_index` is included for `--stdin` only; for positional/--ids errors `error.context.input_index` is used (0-indexed across the resolved id list). Decision 11.

### 3.3 The shared idempotency helper — `src/lib/idempotency.ts`

This is the deliverable that survives beyond R11. R12 (move), R13 (delete), R14+ (archive, mark-read/unread, label diff, etc.) all need a way to short-circuit when the target state is already in effect. The helper's contract:

```ts
/**
 * The result of attempting a state transition. Pure, no I/O.
 *
 * `already_in_target_state: true` means the caller should NOT issue the write —
 * the observed state already satisfies the goal. `false` means proceed.
 *
 * Used by R11 (finish, reopen), R12 (move), R13 (delete-by-id), and R14+
 * (archive, activate, mark-read/unread, attach/detach-label).
 */
export type IdempotencyCheck<S extends string = string> = {
  alreadyInTargetState: boolean;
  observedState: S;
  targetState: S;
};

export function checkIdempotency<S extends string>(opts: {
  observedState: S;
  targetState: S;
  // Optional: equivalent states (e.g. for archive, both 'archived' and
  // 'archived_finished' might count as already-in-target). Default: identity.
  equivalents?: ReadonlySet<S>;
}): IdempotencyCheck<S>;
```

Pure function. The actual GET-the-task-and-feed-the-result step is per-resource (different endpoints, different schemas) — the helper does NOT fetch. Future post-hoc detection (parsing a 200-response shape for "no-op marker") can extend the same return type with an additional construction path; v1 only does pre-check. Decision 12.

**Why a helper at all if it's just two-line equality?** Three reasons: (1) the call site reads as a single semantic step rather than a comparison embedded in business logic; (2) the `equivalents` knob lets archive (R14) handle `'archived' | 'archived_finished'` cleanly; (3) the helper's return type IS the public envelope contract — adding a field there ripples through every consumer in a typed way.

### 3.4 Batch flow (positional, `--ids`, `--stdin`)

All three sources resolve to a list of ids before any HTTP call. The flow is:

```
1. Parse + validate input → ids: number[]   (or per-line errors stream out)
2. Resolve credentials, build HttpClient    (skipped if --dry-run AND zero ids — never happens here since we already short-circuited at step 1; otherwise client is built)
3. For each id (in order):
   a. GET /task/{id}  →  pre-check observedState
        - 404 → error envelope (NOT_FOUND, exit 4 cumulative)
        - 403 → error envelope (FORBIDDEN, exit 4)
        - 401 → error envelope (AUTH_EXPIRED, exit 3)
        - 5xx / network / 429 → error envelope, batch continues
   b. checkIdempotency → already? skip POST, emit success envelope with already_in_target_state: true
   c. else POST /task/{id}/{verb}
        - --dry-run: skip POST; emit dry-run envelope with `would` and current_state == previous_state
        - 200 → emit success envelope with current_state := target, previous_state := observed, already_in_target_state: false
        - 4xx/5xx → error envelope, batch continues
4. End of stream: exit code = highest of {0, 2, 3, 4, 5, 6} observed across all ids.
```

This mirrors R09 batch's exit-accumulator semantics. In single-id mode (one positional id and no `--stdin`), there is no "per-id" loop — but the same flow runs once. Failure of the single id propagates the per-id exit code unchanged.

### 3.5 NDJSON input shape (`--stdin`)

```jsonc
{ "id": 9012 }
{ "id": 9013 }
{ "id": "9014" }   // STRING form rejected — `id` must be a positive integer (decision 13)
```

Strict shape: `id` required, integer ≥ 1, no other keys. Unknown keys → ValidationError for that line, batch continues. Empty/blank lines skipped silently. Identical to R09's `iterateLines` + `parseNdjsonLine` infra.

### 3.6 Field naming

- `task_id`: integer.
- `previous_state` / `current_state`: lowercase string from `state.state` enum ('active' | 'archived' | 'finished' | 'deleted' | 'template'). Both are always present in success envelopes. In dry-run they're equal (no POST happened).
- `already_in_target_state`: boolean. `true` ⇔ POST was skipped because the target was already met.
- `verb`: literal `'finish'` or `'reopen'`. Lets a consumer decode the envelope without reading `schema`.
- `line_index` (only when source is `--stdin`): integer, 0-indexed.

### 3.7 Example invocations

**Single id:**
```bash
$ freelo tasks finish 9012
Finished task #9012 (was active).

$ freelo tasks finish 9012 --output json
{"schema":"freelo.tasks.finish/v1","data":{"task_id":9012,"previous_state":"active","current_state":"finished","already_in_target_state":false,"verb":"finish"},"rate_limit":{...}}
```

**Already finished (idempotent skip):**
```bash
$ freelo tasks finish 9012 --output json
{"schema":"freelo.tasks.finish/v1","data":{"task_id":9012,"previous_state":"finished","current_state":"finished","already_in_target_state":true,"verb":"finish"},"rate_limit":{...}}
$ echo $?
0
```

**Multiple positional:**
```bash
$ freelo tasks finish 9012 9013 9014 --output ndjson
{"schema":"freelo.tasks.finish/v1","data":{"task_id":9012,...}}
{"schema":"freelo.tasks.finish/v1","data":{"task_id":9013,...}}
{"schema":"freelo.tasks.finish/v1","data":{"task_id":9014,...}}
```

**`--ids`:**
```bash
$ freelo tasks finish --ids 9012,9013,9014 --output ndjson
... (same shape as above)
```

**`--stdin`:**
```bash
$ printf '{"id":9012}\n{"id":9013}\n' | freelo tasks finish --stdin --output ndjson
{"schema":"freelo.tasks.finish/v1","data":{"task_id":9012,"line_index":0,...}}
{"schema":"freelo.tasks.finish/v1","data":{"task_id":9013,"line_index":1,...}}
```

**Dry-run:**
```bash
$ freelo tasks finish 9012 --dry-run --output json
{"schema":"freelo.tasks.finish/v1","dry_run":true,"data":{"task_id":9012,"previous_state":"active","current_state":"active","already_in_target_state":false,"verb":"finish","would":{"method":"POST","path":"/task/9012/finish","body":{}}}}
```

**Reopen on a task that's already active (idempotent — natural, per OpenAPI :1802):**
```bash
$ freelo tasks reopen 9012 --output json
{"schema":"freelo.tasks.reopen/v1","data":{"task_id":9012,"previous_state":"active","current_state":"active","already_in_target_state":true,"verb":"reopen"},"rate_limit":{...}}
```

**Reopen on a deleted task (404):**
```bash
$ freelo tasks reopen 9012
freelo: Not found (HTTP 404).
$ echo $?
4
```

### 3.8 Error → exit code mapping

| Cause | Code | Exit |
|---|---|---|
| `<id>` not positive int (positional, `--ids`, NDJSON) | `VALIDATION_ERROR` | 2 |
| `--ids` AND `<id>...` together | `VALIDATION_ERROR` | 2 |
| `--stdin` AND positional/`--ids` | `VALIDATION_ERROR` | 2 |
| Pre-check 401 | `AUTH_EXPIRED` | 3 |
| Pre-check 403 / POST 403 | `FORBIDDEN` | 4 |
| Pre-check 404 / POST 404 | `NOT_FOUND` | 4 |
| Pre-check / POST 5xx | `SERVER_ERROR` | 4 |
| Pre-check / POST 422 | `FREELO_API_ERROR` | 4 |
| 429 (after budget on GET; immediate on POST) | `RATE_LIMITED` | 6 |
| Network failure | `NETWORK_ERROR` | 5 |
| Pre-check returns deleted/template (refuse) — finish only | `VALIDATION_ERROR` | 2 |

Rationale on the last row: pre-check observing `state.state === 'deleted'` is short-circuited to `VALIDATION_ERROR` (with hint "Task 9012 is deleted; restore it first or use a different id.") rather than letting the POST 404. This makes the failure deterministic and test-stable (decision 14).

In batch mode, the highest-exit-code-wins rule from R09 §3.5 applies verbatim.

## 4. Data model — zod schemas

Add to `src/api/schemas/task.ts`:

```ts
/** Task state values from `TaskDetail.state.state`. */
export type TaskState = 'active' | 'archived' | 'finished' | 'deleted' | 'template';

/**
 * R11 — `freelo tasks finish/v1` and `freelo tasks reopen/v1` (same data shape;
 * separate schema strings).
 *
 *   - `task_id`: integer
 *   - `previous_state`: state observed before the verb
 *   - `current_state`: state after the verb (== previous_state if skipped/dry-run)
 *   - `already_in_target_state`: true when the POST was skipped
 *   - `verb`: 'finish' | 'reopen'
 *   - `would`: present only in --dry-run AND only when a POST would have run
 *   - `line_index`: present only in --stdin batch
 */
export const TasksTransitionDataSchema = z.object({
  task_id: z.number().int(),
  previous_state: z.enum(['active', 'archived', 'finished', 'deleted', 'template']),
  current_state: z.enum(['active', 'archived', 'finished', 'deleted', 'template']),
  already_in_target_state: z.boolean(),
  verb: z.enum(['finish', 'reopen']),
  would: z
    .object({
      method: z.literal('POST'),
      path: z.string(),
      body: z.unknown(),
    })
    .optional(),
  line_index: z.number().int().nonnegative().optional(),
});

export type TasksTransitionData = z.infer<typeof TasksTransitionDataSchema>;
```

Two separate schema strings live in code: `freelo.tasks.finish/v1` and `freelo.tasks.reopen/v1`, but they share the `TasksTransitionData` type since the payload is identical.

## 5. Edge cases

1. **Task with no `state` block** (defensive — Freelo always emits it but `.passthrough()` lets nulls slip): treat `null`/missing as `'active'` for finish-target detection (active is the default), and surface a `notice` warning that state could not be confirmed. Decision 15.
2. **`<id>` repeated** (e.g. `freelo tasks finish 9012 9012`): emit two envelopes — the second will be `already_in_target_state: true` (idempotent). No dedupe at the CLI layer. Decision 16.
3. **`--stdin` with non-`{id: int}` lines**: per-line `VALIDATION_ERROR`, batch continues, exit ≥ 2.
4. **Network failure mid-batch**: per-id error envelope, batch continues, final exit ≥ 5.
5. **Pre-check rate-limited**: GET retry budget (3 attempts) applies — `HttpClient` already does that. Final 429 → exit 6.
6. **POST 200 but task state did NOT actually change** (race: concurrent edit): we still emit `current_state := target`. The CLI cannot prove a server-side anomaly without a refresh GET, and a refresh GET doubles every write's call count. Decision 17 — accept the cost; the state in the envelope is the **agent's intent**, not a re-verified observation.
7. **Worker-not-permitted (403) on POST after a successful GET**: emit error envelope normally; `previous_state` is *not* added to the error context (decision 18). Agents can re-issue `tasks show <id>` if they need it.

## 6. Non-goals

- No `--yes` / confirmation prompt — these verbs are reversible. R12+ destructive verbs (delete) will introduce that surface.
- No multi-project / cross-project disambiguation — `/task/{id}/finish` doesn't take a project context.
- No "finish-all-in-tasklist" / "reopen-all-finished" sweeping commands.
- No transaction / rollback semantics on partial batch failures. Each id is independent.
- No verbose progress bar for batches. The NDJSON stream IS the progress signal for agents.

## 7. Open questions

None. The OpenAPI is unambiguous on activate; finish's idempotency is sidestepped by the pre-check decision (decision 1). The pre-check approach was chosen explicitly to avoid future rework when Freelo eventually documents the finish-on-finished response shape.

---

## Plan

### Files to create

| File | Intent |
|---|---|
| `src/lib/idempotency.ts` | `checkIdempotency<S>({observedState, targetState, equivalents?})` — pure helper. |
| `src/api/tasks-transition.ts` | `finishTask(client, taskId, opts)`, `activateTask(client, taskId, opts)`, `transitionPath(verb, taskId)`. Thin wrappers around `client.request(POST, path, body: {}, schema: SuccessResponseSchema)`. |
| `src/commands/tasks/finish.ts` | `registerFinish(tasks, getConfig, env)` — leaf command for `tasks finish`. |
| `src/commands/tasks/reopen.ts` | `registerReopen(tasks, getConfig, env)` — leaf command for `tasks reopen`. |
| `src/commands/tasks/transition.ts` | Shared helpers used by `finish.ts` and `reopen.ts`: input parsing (positional + `--ids` + NDJSON), batch loop, single-id flow, envelope rendering. The two leaf files only register the Commander surface and pick the verb. |
| `src/ui/human/tasks-transition.ts` | Human renderer: `Finished task #ID (was active).` / `Reopened task #ID (was finished).` / `Task #ID was already finished.` / `(dry-run) Would finish task #ID.`. Shared by both verbs. |
| `test/commands/tasks/finish.test.ts` | Vitest e2e — happy paths, idempotency, dry-run, batch (positional + `--ids` + `--stdin`), validation, HTTP errors (401/403/404/429/5xx/network), introspect entry. |
| `test/commands/tasks/reopen.test.ts` | Same — focused tests, mostly thinner (the shared infra is exercised via finish.test.ts). |
| `test/lib/idempotency.test.ts` | Pure unit tests — equality, equivalents, type narrowing. |
| `test/fixtures/tasks/transition-9012-active.json` | `TaskDetail` with `state.state = 'active'`. |
| `test/fixtures/tasks/transition-9012-finished.json` | `TaskDetail` with `state.state = 'finished'`. |
| `docs/commands/tasks-finish.md` | User docs — usage, examples, idempotency note, state-deleted behavior. |
| `docs/commands/tasks-reopen.md` | Same for reopen. |
| `.changeset/r11-tasks-finish-reopen.md` | `minor` changeset noting the new commands and the new envelope schemas. |

### Files to modify

| File | Change |
|---|---|
| `src/api/schemas/task.ts` | Add `TasksTransitionDataSchema` + `TasksTransitionData` + `TaskState`. |
| `src/commands/tasks.ts` | Wire `registerFinish` and `registerReopen` into the `tasks` subcommand tree. |
| `test/msw/handlers.ts` | New `tasksTransitionHandlers` factory: `finishOk(taskId)`, `activateOk(taskId)`, `forbidden(verb, taskId)`, `notFound(verb, taskId)`, `unauthorized(verb, taskId)`, `serverError(verb, taskId, status?)`, `rateLimited(verb, taskId)`, `networkError(verb, taskId)`. The pre-check GET is served by the existing `tasksShowHandlers.detailOk(...)` / `detailNotFound` / `detailForbidden` / `detailServerError` factories — no new GET handlers needed. |
| `README.md` | Regenerate the autogen Commands block via `pnpm fix:readme` after build. |

### No new dependencies

Reuses `commander`, `zod`, `undici`-via-`HttpClient`, `vitest`, `msw` — all already pinned.

### Test strategy

- **Unit (`test/lib/idempotency.test.ts`):** identity case (alreadyInTargetState true), mismatch case (false), `equivalents` set narrows to true. ~6 cases.
- **Unit (could be integrated into integration tests):** zod parse of `TasksTransitionDataSchema` — happy + invalid (extra key, wrong enum); skip if covered by integration.
- **Integration (`test/commands/tasks/finish.test.ts`)** — Vitest + MSW. Mirrors R10's structure:
  - **Happy paths (5):** single id JSON; single id human; idempotent skip (already finished); positional 3 ids; `--ids 9012,9013`.
  - **Dry-run (3):** single id, positional 2 ids, idempotent dry-run (already finished — should NOT include `would`).
  - **Batch `--stdin` (4):** 3 valid lines; valid + bad-JSON + valid (per-line error, exit 2); valid + 422 (exit 4); empty stdin → silent exit 0.
  - **Validation (5):** non-numeric positional id (exit 2); zero positional id (exit 2); `--ids` + positional (exit 2); `--ids 0` (exit 2); `--stdin` + positional (exit 2).
  - **HTTP errors (5):** pre-check 404 (exit 4, `NOT_FOUND`); POST 403 (`FORBIDDEN`, exit 4); POST 429 (`RATE_LIMITED`, exit 6); POST network (`NETWORK_ERROR`, exit 5); POST 5xx (`SERVER_ERROR`, exit 4); pre-check 401 (`AUTH_EXPIRED`, exit 3).
  - **Idempotency edge cases (2):** already-finished + `--dry-run` (no `would`); deleted-task pre-check → `VALIDATION_ERROR` exit 2 with hint.
  - **Introspect (1):** `tasks finish` shows in `--introspect` with `output_schema: 'freelo.tasks.finish/v1'`, `destructive: false`.
- **Integration (`test/commands/tasks/reopen.test.ts`)** — thinner; ~10 cases focused on the verb-specific behavior:
  - Happy single, idempotent (already active per OpenAPI :1802), dry-run, positional batch, `--stdin`, deleted-task 404, POST 403, validation (non-int id), introspect entry.

Total target: ~30 integration tests + ~6 unit tests. Coverage targets: 80% lines, 90% on `src/api/` and `src/commands/`. Calibration §2: every typed error class triggered. Calibration §4: try/catch arms — the per-id catch in batch (mirrors R09's `toBaseError`), the pre-check error catch — each has a test row.

### Rollout order

Single PR, single slice. The change is small enough that we don't slice further:

1. `src/lib/idempotency.ts` + unit tests
2. `src/api/schemas/task.ts` (extend) + `src/api/tasks-transition.ts`
3. `src/ui/human/tasks-transition.ts`
4. `src/commands/tasks/transition.ts` (shared command logic)
5. `src/commands/tasks/finish.ts` + `src/commands/tasks/reopen.ts`
6. `src/commands/tasks.ts` (wire-up)
7. `test/msw/handlers.ts` (new transition handlers)
8. `test/fixtures/tasks/transition-*.json`
9. `test/commands/tasks/finish.test.ts` + `test/commands/tasks/reopen.test.ts`
10. `docs/commands/tasks-finish.md` + `docs/commands/tasks-reopen.md`
11. Changeset + README regen
12. CI gates (`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`)

### Risks & mitigations

- **Risk:** the pre-check adds ~2× latency for batch. **Mitigation:** acceptable for v1 — finish/reopen is a low-volume verb. If a real user hits it, R14+ can introduce a `--no-precheck` flag (default off) that swallows finish-on-finished errors silently. Logged in `docs/decisions/<run-id>-1-precheck.md`.
- **Risk:** `state.state` schema is not strict (it's `passthrough()`); if Freelo adds `'cancelled'` we'd hard-fail at `TasksTransitionDataSchema`. **Mitigation:** `TasksTransitionDataSchema` is **OUR envelope's schema**, not the wire schema. We map the wire's `state.state` defensively. If we observe an unknown wire state, we treat it as `'active'` (most permissive) and emit a `notice`. Decision 15 already covers this.
- **Risk:** Plan drift mid-implementation. **Mitigation:** if any of (a) `src/api/client.ts` change becomes necessary, (b) a new dep, (c) breaking schema needed → pause.
