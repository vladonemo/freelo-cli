# 0023 — `freelo tasks move --stdin` batch input (R12.5)

**Status:** Accepted — ready for implementation
**Run:** 2026-04-27-R12.5-tasks-move-batch
**Tier:** Yellow (additive surface on existing command; touches cross-cutting
`src/lib/batch.ts`; reuses `freelo.tasks.move/v1` envelope schema)
**Branch:** `feat/tasks-move-batch`
**Cross-reference:** Extends spec 0022 (R12 `tasks move <id>` — single-id flow,
pre-check + idempotency + post-move refresh). Inherits batch patterns from spec 0019
(R09 `tasks create --stdin` — startup-time error vs. per-line error split,
`ExitCodeAccumulator` + deferred-exit, `freelo.error/v1` with `context.line_index`)
and spec 0021 (R11 `tasks finish --stdin` — per-line schema validation, lazy
client construction inside the loop, in-order interleaved parse/run).

---

## 1. Problem

R12 ships `freelo tasks move <id> --to-tasklist <id>` for a single move. R09 and
R11 both ship `--stdin` NDJSON batch input. R12 currently doesn't — it's the **only
write command in the surface that lacks batch input**.

Common workflows that need batch:

- "Re-organize the backlog": move 30 tasks at once, each to a different destination
  tasklist (some to "In progress", some to "Blocked", some to a sibling project).
- "Cross-project escalation sweep": move multiple support tasks into engineering's
  triage tasklist, one row per task.
- Composing with `freelo tasks list ... --output ndjson | jq ... | freelo tasks move
  --stdin` — agents already use this pattern with R09/R11.

R12.5 closes this gap. It introduces the **first "two-id" write** in the surface:
each input row carries `{id, to_tasklist, to_project?}` (i.e. each row chooses its
own destination), unlike R09/R11 where every row applies the same verb to a
different `id`.

## 2. Background — what we already have

### 2.1 R12 single-id flow (spec 0022)

`runMove(taskId, toTasklistId, opts, ...)` in `src/commands/tasks/move.ts`:
1. Pre-check `GET /task/{id}` — observe `from_tasklist_id`, `from_project_id`,
   `state`.
2. Refuse on `state === 'deleted'` (`VALIDATION_ERROR`, exit 2).
3. Idempotency check (`fromTasklistId === toTasklistId` → skip POST, no refresh).
4. Dry-run path — emit envelope with `would`, no POST, no refresh.
5. POST `/task/{id}/move/{tasklist_id}`.
6. Refresh `GET /task/{id}` — capture post-move `to_project_id`.
7. `--to-project` post-hoc assertion — `notice` on mismatch (exit stays 0).

This whole flow stays the wire-level contract for R12.5; the batch layer wraps
it.

### 2.2 Batch infra

- `src/lib/batch.ts`: `iterateLines(stream)`, `parseNdjsonLine(line, idx, schema)`,
  `ExitCodeAccumulator`. All three are already used by R09 and R11.
- `parseNdjsonLine` is **schema-generic** — it accepts any `ZodTypeAny` and returns
  `LineParseResult<z.output<S>>`. R12.5 just supplies a richer per-line schema
  (`{id, to_tasklist, to_project?}` instead of R09's single `{id}`).

The roadmap requirement says "Generalize `src/lib/batch.ts` for per-row destination
params". After review, **the existing helpers are already general enough** — they
operate on lines and zod schemas, not on a fixed shape. The "generalization" the
roadmap refers to is at the **command-level orchestration** layer (the per-line
loop in the command file): R09/R11 each have their own bespoke loop, and R12.5's
loop is structurally similar but with a different per-line shape.

**Decision 1 (architect, autonomous):** **Do NOT** add a new helper to `src/lib/batch.ts`.
The existing primitives (`iterateLines`, `parseNdjsonLine`, `ExitCodeAccumulator`)
already cover what R12.5 needs. The "first two-id write" is realized at the
command-orchestration layer, not at the library layer. A premature helper extraction
across R09 + R11 + R12.5 is a refactor unto itself; defer until a 4th batch command
asks for it.

This decision **slightly diverges** from the roadmap text but does not change UX,
scope, or the contract. It avoids touching cross-cutting code unnecessarily — and
calibration §4 warns about untested branches in cross-cutting helpers. Keeping
`src/lib/batch.ts` unchanged means R09 and R11 cannot regress.

### 2.3 R09 / R11 batch shape (precedent)

Both commands stream-buffer stdin, parse each line, and run per-line in input order.
On failure they emit a `freelo.error/v1` envelope with `context.line_index` (R09)
or `context.{line_index, task_id}` (R11). The exit-code accumulator takes the max
across all lines; the run defers exit through `drainDispatcher + exitDeferred`.

R12.5 follows the **R11 model** (lazy client, in-order interleaved parse/run, success +
error envelopes both go to stdout in order, deferred exit at end-of-loop).

## 3. Proposal

### 3.1 Subcommand signature

```
freelo tasks move --stdin [--dry-run] [--to-project <id>]
# Per-line NDJSON: {"id": <task_id>, "to_tasklist": <tasklist_id>, "to_project"?: <project_id>}
```

**Mutex:** `--stdin` is mutually exclusive with the existing positional `<id>` and
`--to-tasklist` flag (which become single-mode-only). Specifying any combination
fails with `VALIDATION_ERROR` (exit 2) at flag-validation time.

**`--to-project` outside `--stdin`:** unchanged — single-mode post-hoc assertion
(spec 0022 §3.3).

**`--to-project` inside `--stdin`:** Decision 3 below.

**Decision 2 (autonomous, log):** ship **`--stdin` only**, no `--pairs` sugar.

  - The `--stdin` shape is the documented agent contract; a `--pairs` flag would be
    convenience for shells but adds ambiguity (what if someone passes both?
    `42:1200,42:1300` — does the first row's `--dry-run` apply to all? what about
    `--to-project`?). Better to keep one input source.
  - Run config (resume answer) said "stdin-only unless architect finds strong
    precedent". No precedent in R09/R11 (neither ships `--pairs`).
  - Logged as decision 1 in run dir.

**Decision 3 (autonomous, log):** `--to-project` is **per-row only** in batch
mode. A command-line `--to-project` while `--stdin` is set is **rejected** at
flag-validation time with `VALIDATION_ERROR` (exit 2).

  - Run config said "per-row only, follow R12 precedent".
  - The CLI-level `--to-project` is a guard / assertion (spec 0022 §3.3); making
    it batch-global would mean every row asserts the same project, which is
    confusing when rows can target different projects.
  - Per-row shape `{"to_project": ...}` lets agents choose freely per row.
  - Logged as decision 2 in run dir.

**Decision 4 (autonomous, log):** **continue-on-error** failure semantics across
batch lines (matches R09 / R11 precedent). The exit code is the max of all per-line
exit codes (`ExitCodeAccumulator.observe` model).

  - Single per-line failure does NOT abort the run; the rest of the lines still
    process.
  - Exit code at end is the highest observed (validation 2 < auth 3 < forbidden/4xx
    4 < network 5 < rate 6).
  - Logged as decision 3 in run dir.

**Per-command `meta`:** unchanged from R12.

```ts
export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.move/v1',
  destructive: false,
};
```

### 3.2 Per-line NDJSON schema

```ts
const BatchLineSchema = z
  .object({
    id: z.number().int().positive(),
    to_tasklist: z.number().int().positive(),
    to_project: z.number().int().positive().optional(),
  })
  .strict();
```

**Strict mode** (matches R09): unknown keys reject the line with a precise
`Line N: ...` `VALIDATION_ERROR`. Agents get fail-fast feedback on schema drift.

**Why `to_tasklist` and `to_project` (not `--to-tasklist` / `--to-project` long
form):** snake_case keys mirror the existing envelope output (`to_tasklist_id`,
`to_project_id`). The `_id` suffix is dropped to keep the shape compact and to
match what agents already pipe (R12 envelope's `data` block does NOT prefix every
key with `_id` either when context is clear). Decision 5 (autonomous): keep keys
short — `to_tasklist`, `to_project`.

  - Alternative was `to_tasklist_id`, `to_project_id` (matching envelope output
    fields). Rejected: stdin shape and envelope output need not be symmetric. R09
    uses `due` (not `due_at`), `worker` (not `worker_id`); R11 uses `id` (not
    `task_id`). Short keys win.

### 3.3 Envelope shape — `freelo.tasks.move/v1` (additive `line_index`)

The existing `TasksMoveData` schema (in `src/api/schemas/task.ts` lines 702-719)
gets one **additive optional field**: `line_index?: number`. Per the working
agreement on schemas, this is a **minor / additive** change — not a version bump.

```ts
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
  /** R12.5 — only set when the row came from `--stdin`. 0-indexed. */
  line_index: z.number().int().min(0).optional(),
});
```

**Single-mode envelopes never carry `line_index`** — preserving exact R12 v1 shape
for existing callers. **Batch-mode (`--stdin`) envelopes always carry `line_index`**.

**Per-line error envelopes** use the same `freelo.error/v1` shape that R09 and R11
emit, augmented with `context.line_index` (and `context.task_id` when the line
parsed but a downstream call failed).

### 3.4 Streaming flow (`--stdin`)

```
1. Parse + validate flags (reject single-mode flags + --to-project alongside --stdin).
2. Buffer stdin (matches R09/R11 — small inputs, line-oriented).
3. Empty stdin → silent success exit 0 (matches R09/R11).
4. For each line in input order:
   a. Parse via `parseNdjsonLine(line, i, BatchLineSchema)`.
      - Failure → emit `freelo.error/v1` with `context.line_index: i`; observe
        VALIDATION_ERROR exit 2; continue.
   b. Build (lazy) HttpClient on first valid line.
   c. Run the R12 single-id flow (`runMoveOne(...)` extracted from `runMove`):
      - GET /task/{id} pre-check.
      - Refuse if deleted.
      - Idempotency check vs. row's `to_tasklist`.
      - If --dry-run → emit envelope (no POST, no refresh).
      - Else POST + refresh.
      - --to-project assertion if row has `to_project`.
      - Emit envelope on stdout (always with `line_index: i`).
   d. On any thrown BaseError → emit `freelo.error/v1` with
      `context: { line_index: i, task_id }`; observe its exitCode; continue.
5. Defer-exit at max accumulated code (drainDispatcher + exitDeferred).
```

**Lazy client:** matches R11 — credential resolution waits until the first valid
line. A stdin of all-bad-JSON never hits the keychain or env-var resolver.

**In-order parse + run (no two-pass loop):** matches R11 §3.5 — output stream order
mirrors stdin order, so a parse error at line 3 of 10 appears between lines 2 and 4
of stdout, not at the top. (R09 originally had this bug; R11 fixed it; R12.5
inherits the fix.)

### 3.5 Refactoring `runMove` for reuse

Spec 0022's `runMove(taskId, toTasklistId, opts, appConfig, env)` builds the client
internally. R12.5 needs the per-line flow to **accept a pre-built client** (lazy
client, shared across rows). Extract:

```ts
async function runMoveOne(
  taskId: number,
  toTasklistId: number,
  toProjectAssertion: number | undefined,
  dryRun: boolean,
  client: HttpClient,
  appConfig: PartialAppConfig,
  lineIndex: number | undefined,  // undefined → single-mode (no line_index in envelope)
): Promise<void>
```

The current `runMove` becomes a thin wrapper that builds the client and calls
`runMoveOne(... , undefined)`. Behavior in single mode is **byte-identical** —
`line_index` is omitted when `lineIndex === undefined`. R12 tests must keep passing
unmodified.

### 3.6 Example invocations

**Batch via stdin:**
```bash
$ cat <<EOF | freelo tasks move --stdin --output json
{"id": 9012, "to_tasklist": 1200}
{"id": 9013, "to_tasklist": 1200}
{"id": 9014, "to_tasklist": 5500, "to_project": 99}
EOF
{"schema":"freelo.tasks.move/v1","data":{"task_id":9012,"from_tasklist_id":1100,"to_tasklist_id":1200,"from_project_id":42,"to_project_id":42,"already_in_target_tasklist":false,"task":{...},"line_index":0},"rate_limit":{...}}
{"schema":"freelo.tasks.move/v1","data":{"task_id":9013,"from_tasklist_id":1100,"to_tasklist_id":1200,"from_project_id":42,"to_project_id":42,"already_in_target_tasklist":false,"task":{...},"line_index":1},"rate_limit":{...}}
{"schema":"freelo.tasks.move/v1","data":{"task_id":9014,"from_tasklist_id":1100,"to_tasklist_id":5500,"from_project_id":42,"to_project_id":99,"already_in_target_tasklist":false,"task":{...},"line_index":2},"rate_limit":{...}}
$ echo $?
0
```

**Batch with idempotent skip:**
```bash
$ echo '{"id": 9012, "to_tasklist": 1200}' | freelo tasks move --stdin --output json
{"schema":"freelo.tasks.move/v1","data":{"task_id":9012,"from_tasklist_id":1200,"to_tasklist_id":1200,"from_project_id":42,"to_project_id":42,"already_in_target_tasklist":true,"task":{...},"line_index":0},"rate_limit":{...}}
$ echo $?
0
```

**Batch with one bad line (continue-on-error):**
```bash
$ cat <<EOF | freelo tasks move --stdin --output json
{"id": 9012, "to_tasklist": 1200}
not-json
{"id": 9013, "to_tasklist": 1200}
EOF
{"schema":"freelo.tasks.move/v1","data":{"task_id":9012,...,"line_index":0},...}
{"schema":"freelo.error/v1","error":{"code":"VALIDATION_ERROR","message":"Line 2 is not valid JSON: ...","http_status":null,"request_id":null,"retryable":false,"hint_next":"Each line must be a complete JSON object terminated by a newline.","docs_url":null,"context":{"line_index":1}}}
{"schema":"freelo.tasks.move/v1","data":{"task_id":9013,...,"line_index":2},...}
$ echo $?
2
```

**Batch with mixed errors (HTTP 404 on one, success on another):**
```bash
$ cat <<EOF | freelo tasks move --stdin --output json
{"id": 9012, "to_tasklist": 1200}
{"id": 99999, "to_tasklist": 1200}
EOF
{"schema":"freelo.tasks.move/v1","data":{"task_id":9012,...,"line_index":0},...}
{"schema":"freelo.error/v1","error":{"code":"NOT_FOUND","http_status":404,"context":{"line_index":1,"task_id":99999},...}}
$ echo $?
4
```

**Batch dry-run:**
```bash
$ echo '{"id": 9012, "to_tasklist": 1200}' | freelo tasks move --stdin --dry-run --output json
{"schema":"freelo.tasks.move/v1","dry_run":true,"data":{"task_id":9012,"from_tasklist_id":1100,"to_tasklist_id":1200,"to_project_id":null,"already_in_target_tasklist":false,"task":{...},"would":{"method":"POST","path":"/task/9012/move/1200","body":{}},"line_index":0}}
```

**Reject `--stdin` + `<id>`:**
```bash
$ echo '...' | freelo tasks move 9012 --stdin
freelo: --stdin is mutex with positional <id>, --to-tasklist, and --to-project; pick one input source.
$ echo $?
2
```

### 3.7 Error → exit code mapping (batch)

| Cause                                                       | Code               | Per-line | Run-level exit |
| ----------------------------------------------------------- | ------------------ | -------- | -------------- |
| `--stdin` combined with `<id>` / `--to-tasklist` / `--to-project` | `VALIDATION_ERROR` | n/a      | 2 (startup; no NDJSON output)  |
| Empty stdin (no lines)                                      | (silent)           | n/a      | 0              |
| Line is not valid JSON                                      | `VALIDATION_ERROR` | exit 2   | 2 (or higher if other lines fail worse) |
| Line schema fails (`id` missing, wrong type, unknown key)   | `VALIDATION_ERROR` | exit 2   | 2              |
| Line `id` non-positive                                      | `VALIDATION_ERROR` | exit 2   | 2              |
| Line `to_tasklist` non-positive                             | `VALIDATION_ERROR` | exit 2   | 2              |
| Pre-check 404 on a line                                     | `NOT_FOUND`        | exit 4   | 4              |
| Pre-check 401 on a line                                     | `AUTH_EXPIRED`     | exit 3   | 3              |
| POST 403 on a line                                          | `FORBIDDEN`        | exit 4   | 4              |
| POST 5xx on a line                                          | `SERVER_ERROR`     | exit 4   | 4              |
| POST 429 on a line                                          | `RATE_LIMITED`     | exit 6   | 6              |
| Network error on a line                                     | `NETWORK_ERROR`    | exit 5   | 5              |
| Pre-check observes `state: 'deleted'` on a line             | `VALIDATION_ERROR` | exit 2   | 2              |

Run-level exit = `max(per-line exit codes)`. POSIX-standard "highest severity wins".

## 4. Data model — schema delta

```diff
 export const TasksMoveDataSchema = z.object({
   task_id: z.number().int(),
   from_tasklist_id: z.number().int().nullable(),
   to_tasklist_id: z.number().int(),
   from_project_id: z.number().int().nullable(),
   to_project_id: z.number().int().nullable(),
   already_in_target_tasklist: z.boolean(),
   task: TaskDetailSchema.nullable().optional(),
   would: z.object({...}).optional(),
+  line_index: z.number().int().min(0).optional(),
 });
```

This is **additive minor** per the working-agreements contract. The changeset will
explicitly call out the schema delta.

## 5. Edge cases

1. **Empty stdin** → silent exit 0 (matches R09/R11).
2. **Stdin with only blank lines** → `iterateLines` skips blanks; same as empty stdin.
3. **Single-line stdin** → identical to a one-row batch; no special-casing.
4. **Mixed parse errors and successes** → output stream interleaves in input order
   (R11 fix carries through).
5. **A row with `to_tasklist` matching the task's current tasklist** → idempotent
   skip on that line (`already_in_target_tasklist: true`, no POST, no refresh GET).
6. **A row with `to_project` matching post-move project** → no notice on that line.
7. **A row with `to_project` mismatching post-move project** → notice on that line's
   envelope; exit code stays 0 for that line (assertion-only).
8. **A row whose `id` points to a deleted task** → per-line VALIDATION_ERROR exit 2;
   continue with next line.
9. **All lines fail** → run exits with max code; no successful envelopes were emitted.
10. **--stdin + --dry-run + --to-project mismatch** → no notice (matches R12 §3.3);
    only live moves can verify post-move project.
11. **A line with `to_project` set + `--dry-run`** → `to_project_id` stays null in
    envelope (no destination tasklist fetch in dry-run); no notice.
12. **Credential resolution failure** → if it happens on the first valid line,
    that line's envelope is `freelo.error/v1` with the resolver's typed error;
    the loop continues to subsequent lines (which will hit the same lazy resolver
    and fail again — same shape, repeated). This matches R11 (decision 16). The
    overall exit code is the max of those per-line failures.

## 6. Non-goals

- `--pairs <id>:<list>,<id>:<list>` sugar (decision 2).
- Global `--to-project` in batch mode (decision 3).
- Fail-fast `--abort-on-error` flag (decision 4 — continue-on-error is the only
  semantic).
- Server-side parallelism / pipelining (sequential in input order — matches R09/R11).
- Generalizing `src/lib/batch.ts` with a new helper (decision 1 — defer until 4th
  command).
- New envelope schema version (additive `line_index` is minor under
  `freelo.tasks.move/v1`).
- Confirmation prompt / `--yes` (move is reversible; matches R12).
- Multi-project `multi_project_task.source_tasklist_id` body field (deferred to R38).

## 7. Open questions

None. The three open questions in roadmap §R12.5 are resolved by autonomous
decisions 2, 3, 4 (above). All defaults track run-config defaults and R09/R11
precedent.

---

## Plan

### Files to create

| File | Intent |
| --- | --- |
| `docs/specs/0023-tasks-move-batch.md` | This spec. |
| `test/fixtures/tasks/move-9013-tasklist-1100.json` | Second source-tasklist task fixture for multi-row batch tests (id 9013, tasklist 1100, project 42). |
| `test/fixtures/tasks/move-9013-tasklist-1200.json` | Second post-move fixture (id 9013, tasklist 1200, project 42). |
| `.changeset/r12-5-tasks-move-stdin.md` | `freelo-cli: minor` — new `--stdin` batch input on `tasks move`; additive `line_index` field on `freelo.tasks.move/v1`. |

### Files to modify

| File | Change |
| --- | --- |
| `src/api/schemas/task.ts` | Add optional `line_index` field to `TasksMoveDataSchema`. Doc-comment update. |
| `src/commands/tasks/move.ts` | Add `--stdin` option (and route `runBatch` → `runMoveOne`); add `--to-project` mutex check when `--stdin` set; refactor `runMove` to delegate to `runMoveOne(... , lineIndex: undefined)` so single-mode behavior is unchanged. Add per-line schema, batch loop (mirrors R11). |
| `test/commands/tasks/move.test.ts` | Add `freelo tasks move --stdin` describe blocks: happy multi-row, idempotent skip in batch, dry-run batch, parse-error continue-on-error, HTTP 404 continue, mutex rejection. ~10 new tests. |
| `test/msw/handlers.ts` | Reuse existing `tasksMoveHandlers`; no factory changes needed (handlers are id+tasklist parameterized already). May add a `moveOk(9013, 1200)` registration in tests directly. |
| `docs/commands/tasks-move.md` | Add `## Batch input via --stdin` section with examples, NDJSON shape, and continue-on-error note. |
| `README.md` | Auto-regen via `pnpm fix:readme` after `pnpm build` — `tasks move` flag list in the autogen block updates with `--stdin`. |

### No new dependencies

Uses `commander`, `zod`, `vitest`, `msw` — all already pinned.
Reuses `src/lib/batch.ts` (`iterateLines`, `parseNdjsonLine`, `ExitCodeAccumulator`)
and `src/lib/idempotency.ts`.

### Test strategy

Vitest + MSW. New tests in `test/commands/tasks/move.test.ts`:

**Happy paths (3):**
- Single-line stdin (one row) → identical envelope shape to single-mode + `line_index: 0`.
- Multi-row stdin (3 rows: same project, idempotent skip, cross-project) → 3 envelopes
  in input order, each with sequential `line_index`.
- Dry-run batch (2 rows, both with `would` blocks).

**Continue-on-error (2):**
- Parse error at line 2 of 3 → 3 stdout envelopes (success, error, success); exit 2.
- HTTP 404 at line 2 of 3 → 3 stdout envelopes (success, error, success); exit 4.

**`--to-project` per-row (2):**
- Match → no notice on that line.
- Mismatch → notice on that line; exit 0.

**Mutex / validation (3):**
- `--stdin` + positional `<id>` → exit 2 with VALIDATION_ERROR.
- `--stdin` + `--to-tasklist` → exit 2 with VALIDATION_ERROR.
- `--stdin` + global `--to-project` → exit 2 with VALIDATION_ERROR.

**Per-line schema validation (3):**
- Line missing `id` → VALIDATION_ERROR per-line; exit 2.
- Line missing `to_tasklist` → VALIDATION_ERROR per-line; exit 2.
- Unknown extra key → VALIDATION_ERROR per-line (zod `.strict()`); exit 2.

**Edge cases (2):**
- Empty stdin → silent exit 0.
- Deleted-task pre-check on one line, success on another → mixed envelopes.

**Introspect (1):**
- `tasks move --introspect` shows `--stdin` flag.

Total target: **~16 new tests** atop R12's existing ~26. Coverage targets: 80%
lines, 90% on `src/api/` and `src/commands/`.

**Calibration §2 alignment:** every typed error class is triggered:
- `ValidationError` (parse error, mutex, schema, deleted task)
- `FreeloApiError` / `NOT_FOUND` (404 line)
- `RateLimitedError` (429 line — covered indirectly via R12 single-mode tests if
  not added; will add a 429 batch line if budget allows)
- `NetworkError` (network failure on a line — will add)
- `AuthExpiredError` (401 on a line)

**Calibration §4 alignment:** the new per-line catch arm in `runBatchFromStdin`
gets coverage in continue-on-error tests (parse, validation, HTTP). The lazy
client construction inside the loop is one new branch — covered by the multi-row
happy path test.

### Rollout order

Single PR, single slice:

1. `src/api/schemas/task.ts` — additive `line_index` field.
2. `src/commands/tasks/move.ts` — refactor to extract `runMoveOne`; add `--stdin`,
   batch loop, mutex validation. Single-mode behavior MUST stay byte-identical.
3. `test/commands/tasks/move.test.ts` — extend with R12.5 tests; existing R12 tests
   must keep passing without modification.
4. New fixtures (`move-9013-*.json`).
5. `docs/commands/tasks-move.md` — append batch section.
6. Changeset (`.changeset/r12-5-tasks-move-stdin.md`).
7. `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm fix:readme && pnpm check:readme`.
8. Commit, push, open PR.

### Risks & mitigations

- **Risk:** `runMove` refactor breaks single-mode tests. **Mitigation:** keep
  `runMove(taskId, toTasklistId, opts, ...)` as a thin wrapper that calls
  `runMoveOne(... , lineIndex: undefined)`; existing tests don't change.
- **Risk:** `line_index: 0` accidentally appearing in single-mode envelopes. **Mitigation:**
  spread it conditionally only when `lineIndex !== undefined`.
- **Risk:** Per-line `VALIDATION_ERROR` envelope shape drifts from R09/R11.
  **Mitigation:** factor out `writeBatchError` similar to transition.ts (or copy
  the same shape verbatim — the err schema is `freelo.error/v1` regardless).
- **Risk:** A row with `to_project` global flag confuses users post-launch. **Mitigation:**
  hard-rejected at flag-validation; help text says "per-row only in --stdin mode".
- **Risk:** Calibration §3 — local gates pass but CI red. **Mitigation:** run all
  five gates on the committed tree before push.
