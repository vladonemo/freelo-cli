# 0022 — `freelo tasks move <id>` (R12)

**Status:** Accepted — ready for implementation
**Run:** 2026-04-27-1732-tasks-move
**Tier:** Yellow (additive new command + new envelope schema; fourth write slice; first
cross-tasklist write — reuses R11's idempotency helper and R09/R11's batch infra)
**Branch:** `feat/tasks-move`
**Cross-reference:** Patterns inherited from spec 0019 (R09 `tasks create` — write
infra: `dry-run.ts`, `batch.ts`, NDJSON streamer), spec 0020 (R10 `tasks edit` —
lookup-then-write pattern with `--project` dry-run escape hatch), and spec 0021
(R11 `tasks finish` / `tasks reopen` — pre-check GET + idempotency helper). The
endpoint shape, target-state semantics, and the "destination already correct →
no-op success" envelope contract follow R11's mold.

---

## 1. Problem

After R10/R11 an agent can create, edit, finish, and reopen tasks. R12 closes the
last big gap in the **inflight task lifecycle**: relocating a task between
tasklists, optionally crossing project boundaries. Common workflows that need this:

- Re-phasing within a project ("Backlog" → "In progress" → "Done" tasklists).
- Escalating between projects (support → engineering).
- Re-organizing multi-project tasks.

R12 ships **one** new command (`freelo tasks move`) plus a new envelope schema
(`freelo.tasks.move/v1`). It does NOT introduce new shared infra — every helper it
needs is already in tree (`getTaskDetail`, `checkIdempotency`, `ExitCodeAccumulator`,
`iterateLines`, `parseNdjsonLine`, `attachMeta`).

## 2. Background — what the API gives us

### 2.1 `POST /task/{task_id}/move/{tasklist_id}` (OpenAPI :1842-1891)

- **Path parameters** carry both the source task id AND the destination tasklist id.
- **Optional request body** (all fields default-friendly):
  - `work_reports_action: 'move_to_target_project' | 'keep_on_origin_project'` (default
    `move_to_target_project`).
  - `custom_fields_action: 'nothing' | 'delete_what_cant_be_keep' |
    'move_to_comments_what_cant_be_keep' | 'delete_all' | 'move_to_comments_all'`
    (default `nothing`).
  - `multi_project_task.source_tasklist_id` (integer, optional) — picks which
    project-instance to move when the task is multi-project.
- **Response:** `SuccessResponse` (`{ result: 'success', ... }` — no echo of the new
  tasklist).
- **Behavior notes from OpenAPI :1855-1859:**
  - "Target project is **derived from the `tasklist_id`**" (also confirmed by the
    sibling endpoint at OpenAPI :1906) — there is **no separate `project_id` body or
    query param**. The destination project is the project that owns the destination
    tasklist.
  - For multi-project tasks, `multi_project_task.source_tasklist_id` selects which
    instance moves. Out of scope for R12 (decision 1).
  - 403 if caller has no ACL on source tasklist's project.
- **Idempotency on move-to-current-tasklist:** OpenAPI is **silent** on this case.
  We treat it as unknown — pre-check via `GET /task/{id}` and short-circuit if
  `task.tasklist.id === toTasklist`. Same shape as R11 spec 0021 decision 1.

### 2.2 What about `--to-project`?

The CLI surface in the roadmap (`docs/roadmap.md` §R12) lists
`[--to-project <id>]` as an **optional** flag. Per the OpenAPI, the destination
project is **derived** from `--to-tasklist`, not sent on the wire. So `--to-project`
on the CLI is a **client-side assertion** — when supplied, the CLI fetches the
destination tasklist (via the same pre-check GET on the SOURCE task — no, that's
not right; we need a second source for the destination tasklist's project), and
**verifies** that the destination tasklist's project matches.

**Decision 2:** `--to-project` is a guard, not a wire param. The CLI verifies post-hoc
via the **post-move refresh GET** on the source task: if `--to-project` was supplied
and the post-move task's `project.id !== --to-project`, emit a `notice` on the
envelope (we cannot un-move; the move already succeeded). For dry-run, no second
fetch is feasible without a tasklist-detail GET (and that adds complexity for a guard
flag), so dry-run with `--to-project` simply records the assertion in the `would`
block as `expected_project_id` without verifying.

**Why not refuse the move when `--to-project` mismatches pre-move?** Because
verifying pre-move requires a second GET on the destination tasklist's project,
adding round-trip cost for what is ultimately a sanity-check flag. The post-move
notice surfaces the inconsistency clearly in the envelope without doubling the
read load. Agents that need pre-move verification can pre-fetch via
`freelo tasklists show --to-tasklist` (R06) and validate themselves.

### 2.3 State on the wire — what counts as "already in target"?

`TaskDetail.tasklist?.id` is the source of truth. Idempotent skip = the observed
`tasklist.id === toTasklist`.

Defensive: if `task.tasklist` is null/missing (Freelo's `passthrough()` may let it
through), we **cannot prove** the task is in the target tasklist. Treat that as
"not in target" and proceed with the POST; the API will 404 if the source isn't
addressable. Decision 3.

## 3. Proposal

### 3.1 Subcommand signature

```
freelo tasks move <id> --to-tasklist <id> [--to-project <id>] [--dry-run]
```

**No batch input flags in v1** (no `--ids`, no `--stdin`). Rationale: a single move
already carries two ids (source and destination); a batch move where each input
line carries `{ "id": <task_id>, "to_tasklist_id": <id> }` IS sensible but inflates
the spec, and roadmap R12 doesn't mention batch. **Decision 4** — single-id only
for v1; batch shape can land in R12.5 if a real user asks. The `<id>` positional is
**required** (single value, not variadic).

**Per-command `meta`:**

```ts
export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.move/v1',
  destructive: false,
};
```

`destructive: false` because move is **reversible** — the inverse move is the same
command with the original tasklist id. This matches R11's stance on finish/reopen.
Decision 5.

### 3.2 Envelope shape — `freelo.tasks.move/v1`

**Live success (move happened):**

```jsonc
{
  "schema": "freelo.tasks.move/v1",
  "data": {
    "task_id": 9012,
    "from_tasklist_id": 1100,
    "to_tasklist_id": 1200,
    "from_project_id": 42,
    "to_project_id": 42,
    "already_in_target_tasklist": false,
    "task": { /* refreshed TaskDetail (post-move GET) */ }
  },
  "rate_limit": { "remaining": 41, "reset_at": "..." },
  "request_id": "..."
}
```

**Already-in-target (no POST issued):**

```jsonc
{
  "schema": "freelo.tasks.move/v1",
  "data": {
    "task_id": 9012,
    "from_tasklist_id": 1200,
    "to_tasklist_id": 1200,
    "from_project_id": 42,
    "to_project_id": 42,
    "already_in_target_tasklist": true,
    "task": { /* TaskDetail from the pre-check GET */ }
  },
  "rate_limit": { "remaining": 39, "reset_at": "..." }
}
```

`from_tasklist_id === to_tasklist_id` and `task` is the **pre-check** detail (no
second GET). `from_project_id` and `to_project_id` are equal in this case (the
project couldn't have changed because the tasklist didn't move).

**Dry-run (POST always skipped; pre-check GET runs):**

```jsonc
{
  "schema": "freelo.tasks.move/v1",
  "dry_run": true,
  "data": {
    "task_id": 9012,
    "from_tasklist_id": 1100,
    "to_tasklist_id": 1200,
    "from_project_id": 42,
    "to_project_id": null,
    "already_in_target_tasklist": false,
    "task": { /* pre-check TaskDetail */ },
    "would": {
      "method": "POST",
      "path": "/task/9012/move/1200",
      "body": {}
    }
  }
}
```

In dry-run, `to_project_id` is **null** (we don't fetch the destination tasklist's
project; that's a R06-style call we'd rather not duplicate here). Decision 6.

If pre-check shows the task is already in the target tasklist AND `--dry-run` is
set, `would` is **omitted** (no POST would have run even live):

```jsonc
{
  "schema": "freelo.tasks.move/v1",
  "dry_run": true,
  "data": {
    "task_id": 9012,
    "from_tasklist_id": 1200,
    "to_tasklist_id": 1200,
    "from_project_id": 42,
    "to_project_id": 42,
    "already_in_target_tasklist": true,
    "task": { /* pre-check TaskDetail */ }
  }
}
```

### 3.3 The `--to-project` cross-project assertion

Three modes, ordered by safety:

1. **`--to-project` omitted** (most common): CLI does not assert anything. Move
   proceeds; `to_project_id` in the envelope is whatever the post-move refresh GET
   reports. Cross-project moves work transparently because the API derives the
   project from the destination tasklist.

2. **`--to-project <id>` supplied AND matches the post-move task's
   `project.id`**: silent confirmation. No `notice` on the envelope.

3. **`--to-project <id>` supplied AND mismatches the post-move task's
   `project.id`**: emit a `notice` like
   `"--to-project asserted 42 but post-move task is in project 99. Verify destination tasklist id and the project graph."`
   Exit code stays 0 (move succeeded).

**Why not exit non-zero on mismatch?** The move succeeded — the assertion is
**informational**. Forcing exit ≥ 1 would double-count the "this was unexpected"
signal: agents already see `to_project_id` in the envelope and can compare. The
`notice` makes it loud for humans without breaking automation.

**Dry-run with `--to-project`:** the assertion is recorded in `would.body` as a
descriptive comment-style key (we don't actually verify pre-move because that
requires fetching the destination tasklist; deferred). Decision 7.

### 3.4 Source-task pre-check & post-move refresh

```
1. Parse + validate flags → toTasklist, optional toProject, dryRun
2. Build HttpClient (env-first auth)
3. GET /task/{taskId}  →  observe `from.tasklist.id`, `from.project.id`
4. checkIdempotency<number>({ observed: from.tasklist.id, target: toTasklist })
   → already? skip POST, return success envelope (no second GET).
5. dry-run?  → emit dry-run envelope (no POST, no second GET).
6. POST /task/{taskId}/move/{toTasklist}
7. GET /task/{taskId}  → refreshed `TaskDetail` (post-move).
8. If --to-project supplied AND refreshed.project.id !== toProject:
     compose notice; emit envelope with notice.
   Else: emit envelope.
```

**Refresh GET:** mirrors R10 spec 0020 decision 11. On refresh failure, emit
success-with-notice (the move did succeed; the refresh just couldn't confirm the
new shape). The envelope's `task` is set to **null** in that path; `to_project_id`
is set to **null** as well; the notice tells the agent to re-fetch via
`freelo tasks show <id>`. Decision 8.

### 3.5 Field naming

- `task_id`: positive integer.
- `from_tasklist_id`: integer (nullable when pre-check task had no tasklist ref —
  defensive, matches R10's `tasklist_id`).
- `to_tasklist_id`: integer (always set; from `--to-tasklist`).
- `from_project_id`: integer or null.
- `to_project_id`: integer or null. Live success: post-move refresh's
  `task.project.id`. Idempotent: from pre-check (= `from_project_id`). Dry-run: null.
- `already_in_target_tasklist`: boolean. `true` ⇔ POST was skipped because pre-check
  showed the task already in the target tasklist.
- `task`: `TaskDetail | null`. Live: refreshed post-move detail. Idempotent: pre-check
  detail. Dry-run: pre-check detail. Refresh-GET-failed: null.
- `would`: present only in dry-run AND only when a POST would have run.

### 3.6 Example invocations

**Cross-tasklist within same project:**
```bash
$ freelo tasks move 9012 --to-tasklist 1200
Moved task #9012 from tasklist #1100 to tasklist #1200.

$ freelo tasks move 9012 --to-tasklist 1200 --output json
{"schema":"freelo.tasks.move/v1","data":{"task_id":9012,"from_tasklist_id":1100,"to_tasklist_id":1200,"from_project_id":42,"to_project_id":42,"already_in_target_tasklist":false,"task":{...}},"rate_limit":{...}}
```

**Already in target tasklist (idempotent skip):**
```bash
$ freelo tasks move 9012 --to-tasklist 1200 --output json
{"schema":"freelo.tasks.move/v1","data":{"task_id":9012,"from_tasklist_id":1200,"to_tasklist_id":1200,"from_project_id":42,"to_project_id":42,"already_in_target_tasklist":true,"task":{...}},"rate_limit":{...}}
$ echo $?
0
```

**Cross-project move with assertion:**
```bash
$ freelo tasks move 9012 --to-tasklist 5500 --to-project 99 --output json
{"schema":"freelo.tasks.move/v1","data":{"task_id":9012,"from_tasklist_id":1100,"to_tasklist_id":5500,"from_project_id":42,"to_project_id":99,"already_in_target_tasklist":false,"task":{...}}}
```

**Cross-project assertion mismatch:**
```bash
$ freelo tasks move 9012 --to-tasklist 5500 --to-project 42 --output json
{"schema":"freelo.tasks.move/v1","data":{...,"to_project_id":99},"notice":"--to-project asserted 42 but post-move task is in project 99. Verify destination tasklist id and the project graph."}
$ echo $?
0
```

**Dry-run:**
```bash
$ freelo tasks move 9012 --to-tasklist 1200 --dry-run --output json
{"schema":"freelo.tasks.move/v1","dry_run":true,"data":{"task_id":9012,"from_tasklist_id":1100,"to_tasklist_id":1200,"from_project_id":42,"to_project_id":null,"already_in_target_tasklist":false,"task":{...},"would":{"method":"POST","path":"/task/9012/move/1200","body":{}}}}
```

**Move on a deleted task (404):**
```bash
$ freelo tasks move 9012 --to-tasklist 1200
freelo: Not found (HTTP 404).
$ echo $?
4
```

### 3.7 Error → exit code mapping

| Cause                                                  | Code               | Exit |
| ------------------------------------------------------ | ------------------ | ---- |
| `<id>` not positive int                                | `VALIDATION_ERROR` | 2    |
| `--to-tasklist` missing                                | `VALIDATION_ERROR` | 2    |
| `--to-tasklist` not positive int                       | `VALIDATION_ERROR` | 2    |
| `--to-project` not positive int                        | `VALIDATION_ERROR` | 2    |
| `--to-tasklist` equals 0                               | `VALIDATION_ERROR` | 2    |
| Pre-check 401                                          | `AUTH_EXPIRED`     | 3    |
| Pre-check / POST 403                                   | `FORBIDDEN`        | 4    |
| Pre-check / POST 404                                   | `NOT_FOUND`        | 4    |
| Pre-check / POST 5xx                                   | `SERVER_ERROR`     | 4    |
| Pre-check / POST 422 / other 4xx                       | `FREELO_API_ERROR` | 4    |
| HTTP 429                                               | `RATE_LIMITED`     | 6    |
| Network failure                                        | `NETWORK_ERROR`    | 5    |
| Pre-check observes `state: 'deleted'` (refuse — d. 9)  | `VALIDATION_ERROR` | 2    |

Decision 9: pre-check observing `state.state === 'deleted'` short-circuits to a
clean `VALIDATION_ERROR` rather than letting the POST 404. Same rationale as R11
spec 0021 decision 14 — deterministic, test-stable, hint includes restoration
guidance.

### 3.8 Why NO batch in v1 (decision 4 expanded)

R09/R11 both ship batch input because their commands take a SINGLE wire-level id.
Move takes TWO ids: source task and destination tasklist. The natural batch shape
is NDJSON of `{ "id": <task>, "to_tasklist_id": <list> }` — but:

- The CLI surface in `docs/roadmap.md` §R12 doesn't mention batch.
- Multi-tasklist batch implies a 2-D lookup (different sources moving to different
  destinations) — different code path from R09/R11's "one verb, list of ids".
- A natural use case ("move all bugs from project A's `In progress` to project B's
  `In review`") is better served by `freelo tasks list` piped through `xargs -I{}
  freelo tasks move {} --to-tasklist 5500` — preserves observable per-id semantics
  without hiding 2-D inputs.
- If batch turns out to be in demand, R12.5 can add it without breaking the v1
  envelope (the schema's `data` shape doesn't change; we'd add `line_index` and
  emit one envelope per input row, identical to R09).

## 4. Data model — zod schemas

Add to `src/api/schemas/task.ts`:

```ts
/**
 * R12 — `freelo tasks move <id>` (spec 0022).
 *
 * Envelope `data` shape for `freelo.tasks.move/v1`. Single-id only in v1
 * (decision 4); no `line_index` field. Both source and destination ids appear
 * in the data block so agents can correlate without re-reading the request.
 */
export const TasksMoveDataSchema = z.object({
  task_id: z.number().int(),
  from_tasklist_id: z.number().int().nullable(),
  to_tasklist_id: z.number().int(),
  from_project_id: z.number().int().nullable(),
  to_project_id: z.number().int().nullable(),
  already_in_target_tasklist: z.boolean(),
  task: TaskDetailSchema.nullable().optional(),
  would: z
    .object({
      method: z.literal('POST'),
      path: z.string(),
      body: z.unknown(),
    })
    .optional(),
});

export type TasksMoveData = z.infer<typeof TasksMoveDataSchema>;
```

## 5. Edge cases

1. **Source task with no `tasklist` ref** (defensive — passthrough may let null
   through): `from_tasklist_id` is `null`. `already_in_target_tasklist` is `false`
   (we cannot prove equality with null). Move proceeds — the API decides.
2. **Source task with `state: 'deleted'`**: refuse with `VALIDATION_ERROR`,
   exit 2 (decision 9).
3. **`--to-tasklist` equals current tasklist** (i.e. `task.tasklist.id ===
   toTasklist`): idempotent success, `already_in_target_tasklist: true`, no POST.
4. **`--to-tasklist` equals current tasklist AND `--dry-run`**: dry-run envelope,
   `would` is **omitted** (no POST would have run).
5. **`--to-project` mismatch post-move**: emit `notice`, exit 0 (decision 2).
6. **Refresh GET fails post-move**: emit success-with-notice, `task: null`,
   `to_project_id: null` (decision 8).
7. **Move to a tasklist the caller can't see**: API returns 403 → `FORBIDDEN`,
   exit 4. We do NOT pre-check the destination tasklist (that would double the
   GET load for a guard).
8. **Pre-check 429 after retry-budget exhaustion**: `RATE_LIMITED`, exit 6.
9. **Network failure during pre-check or POST**: `NETWORK_ERROR`, exit 5.
10. **`--to-tasklist` and `--to-project` both supplied AND match**: silent — no
    notice (the assertion held).

## 6. Non-goals

- Batch input via `--ids` / `--stdin` (decision 4).
- `--work-reports-action` and `--custom-fields-action` flags (out of scope; defaults
  on the wire are sensible — `move_to_target_project` and `nothing`).
- `multi_project_task.source_tasklist_id` body field for multi-project task moves.
  Out — R38 (`tasks project add` / `relations`) is where multi-project work lives.
- Pre-move verification of `--to-project` (would require a destination tasklist
  detail GET; deferred to R12.5 if real-world usage shows demand).
- Confirmation prompt / `--yes` flag — move is reversible.
- Sweeping commands ("move all tasks matching X to Y").

## 7. Open questions

None. The OpenAPI is unambiguous on the move endpoint. The `--to-project` semantics
are a CLI design choice locked by decision 2 (post-hoc assertion via notice).

---

## Plan

### Files to create

| File                                            | Intent                                                                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/api/tasks-move.ts`                         | `moveTask(client, taskId, toTasklist, opts)`, `movePath(taskId, toTasklist)`. Thin wrapper around POST + `SuccessResponse`.  |
| `src/commands/tasks/move.ts`                    | `registerMove(tasks, getConfig, env)` — leaf command for `tasks move`.                                                       |
| `src/ui/human/tasks-move.ts`                    | Human renderer: `Moved task #ID from tasklist #FROM to tasklist #TO.` / idempotent skip / dry-run shapes.                    |
| `test/commands/tasks/move.test.ts`              | Vitest e2e — happy paths (cross-tasklist same project, cross-project, idempotent skip, dry-run), validation, HTTP errors.     |
| `test/fixtures/tasks/move-9012-tasklist-1100.json` | `TaskDetail` in tasklist 1100, project 42 (active state).                                                                  |
| `test/fixtures/tasks/move-9012-tasklist-1200.json` | `TaskDetail` post-move in tasklist 1200, project 42.                                                                       |
| `test/fixtures/tasks/move-9012-tasklist-5500-project-99.json` | `TaskDetail` cross-project: tasklist 5500, project 99.                                                          |
| `test/fixtures/tasks/move-9012-deleted.json`    | `TaskDetail` with `state.state = 'deleted'`.                                                                                 |
| `docs/commands/tasks-move.md`                   | User docs — usage, examples, idempotency note, cross-project semantics, `--to-project` assertion behavior.                   |
| `.changeset/r12-tasks-move.md`                  | `minor` changeset noting the new command and the new envelope schema.                                                        |

### Files to modify

| File                       | Change                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/api/schemas/task.ts`  | Add `TasksMoveDataSchema` + `TasksMoveData` at the bottom (R12 section).                                            |
| `src/commands/tasks.ts`    | Wire `registerMove` into the `tasks` subcommand tree.                                                               |
| `test/msw/handlers.ts`     | New `tasksMoveHandlers` factory: `moveOk(taskId, toTasklist)`, `moveForbidden(taskId, toTasklist)`, `moveNotFound`, `moveServerError`, `moveRateLimited`, `moveNetworkError`, `moveUnauthorized`. The pre-check + post-move refresh GETs reuse `tasksShowHandlers.detailOk(...)` etc. |
| `README.md`                | Regenerate the autogen Commands block via `pnpm fix:readme` after build.                                            |

### No new dependencies

Reuses `commander`, `zod`, `undici`-via-`HttpClient`, `vitest`, `msw` — all already
pinned. Reuses `src/lib/idempotency.ts` (R11) and existing `getTaskDetail`.

### Test strategy

- **Integration (`test/commands/tasks/move.test.ts`)** — Vitest + MSW. Mirrors R11
  `finish.test.ts` structure:
  - **Happy paths (5):** single id JSON; single id human; cross-project move (project
    changes); idempotent skip (already in target tasklist); idempotent skip + JSON.
  - **Dry-run (3):** single id, idempotent dry-run (no `would`), `--to-project`
    flag with dry-run (envelope echoes destination but `to_project_id: null`).
  - **Cross-project assertion (2):** match (no notice, exit 0); mismatch (notice
    present, exit 0).
  - **Validation (6):** non-numeric `<id>` (exit 2); zero `<id>` (exit 2); missing
    `--to-tasklist` (exit 2); non-numeric `--to-tasklist` (exit 2); zero
    `--to-tasklist` (exit 2); non-numeric `--to-project` (exit 2).
  - **HTTP errors (6):** pre-check 404 (`NOT_FOUND`, exit 4); pre-check 401
    (`AUTH_EXPIRED`, exit 3); POST 403 (`FORBIDDEN`, exit 4); POST 5xx
    (`SERVER_ERROR`, exit 4); POST 429 (`RATE_LIMITED`, exit 6); POST network
    (`NETWORK_ERROR`, exit 5).
  - **Edge cases (3):** deleted-task pre-check → `VALIDATION_ERROR` exit 2; refresh
    GET fails post-move → success with notice, `task: null`; pre-check task with no
    `tasklist` ref → `from_tasklist_id: null`, move proceeds.
  - **Introspect (1):** `tasks move` shows in `--introspect` with `output_schema:
    'freelo.tasks.move/v1'`, `destructive: false`.

Total target: ~26 integration tests. Coverage targets: 80% lines, 90% on
`src/api/` and `src/commands/`. Calibration §2: every typed error class triggered.
Calibration §4: refresh-GET catch arm has a dedicated test row.

### Rollout order

Single PR, single slice:

1. `src/api/schemas/task.ts` (extend with `TasksMoveDataSchema` + `TasksMoveData`)
2. `src/api/tasks-move.ts` (wire wrapper)
3. `src/ui/human/tasks-move.ts` (human renderer)
4. `src/commands/tasks/move.ts` (command logic)
5. `src/commands/tasks.ts` (wire-up)
6. `test/msw/handlers.ts` (new move handlers)
7. `test/fixtures/tasks/move-*.json` (fixtures)
8. `test/commands/tasks/move.test.ts` (e2e tests)
9. `docs/commands/tasks-move.md` (user docs)
10. Changeset + README regen (`pnpm fix:readme`)
11. CI gates (`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm
    check:readme`)

### Risks & mitigations

- **Risk:** the pre-check adds 2× request count for batch (same as R11). **Mitigation:**
  v1 is single-id only (decision 4), so pre-check + POST + refresh = 3 requests per
  invocation — bounded and predictable.
- **Risk:** `--to-project` mismatch is non-blocking (notice only). **Mitigation:**
  documented loudly in spec, docs, and human-renderer output. Agents already see
  `to_project_id` in the envelope and can compare programmatically.
- **Risk:** Plan drift — needs touching `src/api/client.ts` or adding a dep. **Mitigation:**
  if either, pause per autonomous-sdlc.md.
- **Risk:** Refresh GET adds latency (R10 already incurs this; carries through). **Mitigation:**
  acceptable — agents who don't care about post-move state can ignore `data.task`
  in the envelope; the cost is one round-trip for users who do.
