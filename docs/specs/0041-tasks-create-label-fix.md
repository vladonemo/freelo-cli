# 0041 — `tasks create --label` wire fix

| Meta | |
|---|---|
| Type | `fix` |
| Scope | `src/api/tasks-create.ts`, `src/commands/tasks/create.ts` (and the matching `data` schema in `src/api/schemas/task.ts`) |
| Origin | Bug report: live API rejects `freelo tasks create --label <name>` with `400 "Missing item 'uuid' in array."` |
| Envelope | `freelo.tasks.create/v1` → `freelo.tasks.create/v2` (see §6.1 — `data.would` retypes object → array) |
| Target version | v0.17.2 (patch) |
| Related skill | `.claude/skills/freelo-api/SKILL.md` (`Known quirks`, parallel update by `freelo-api-specialist`) |

---

## 1. Problem

`freelo tasks create --label <name>` is broken against the live Freelo API. The wire builder at `src/api/tasks-create.ts:41` emits

```json
{ "labels": [{ "name": "bug" }] }
```

inside the `POST /project/{p}/tasklist/{t}/tasks` body. The live API responds:

```
HTTP 400  body: { "error": "Missing item 'uuid' in array." }
```

The CLI surfaces this as a `FREELO_API_ERROR`, exit 4. The task is never created. This is a *create-time* regression only — `tasks edit --label` and `task-labels attach --name` are confirmed working (they hit a different endpoint that does accept name-mode). See §8 *Out of scope*.

The OpenAPI spec says `TaskLabelAddInput` is a `oneOf(uuid-mode | name-mode)` for both endpoints (`docs/api/freelo-api.yaml` :5139-5169). For the **create-task** endpoint, that is **fiction** — the live API requires `uuid` AND `name` AND `color` together on every entry. This is the v0.17.1 notifications-fix pattern repeating: when the wire disagrees with the spec, the wire wins.

---

## 2. Live-API evidence (probed today, base `https://api.freelo.io/v1`)

Treat as authoritative — no further probing required.

### 2.1 `POST /project/{p}/tasklist/{t}/tasks` — strict label shape

Each entry in `labels` requires all three fields together:

| Body sent | Live result |
|---|---|
| `[{name}]` | 400 `"Missing item 'uuid' in array."` |
| `[{name, color}]` | 400 `"Missing item 'uuid' in array."` |
| `[{uuid, name}]` | 400 `"Missing item 'color' in array."` |
| `[{uuid}]` | 400 `"Missing item 'name' in array."` |
| `[{uuid: NEW, name, color}]` | 200 — task created with a brand-new label |
| `[{uuid: EXISTING, name, color}]` | 200 — task created with the existing label (server matches by `uuid`) |

### 2.2 `POST /task-labels/add-to-task/{id}` — accepts name-mode

| Body sent | Live result |
|---|---|
| `[{name}]` | 200 — label created server-side, default colour `#77787a`, auto-uuid |
| `[{name, color: "#10aa40"}]` (valid) | 200 — label created with given colour |
| `[{name, color: "#aabbcc"}]` (invalid) | 400 `"Color #aabbcc of label is not a valid value"` |

This is the endpoint `addTaskLabels` already uses (`src/api/tasks-edit.ts:144`) and is the basis of the chosen fix.

### 2.3 `GET /project-labels/find-available`

Returns `{"labels":[]}` for the test user even when tasks have inline labels. **Project-labels and task-inline-labels are separate resources.** Cannot be used to resolve `name → uuid` for the create call.

### 2.4 `POST /task-labels` (R24's bulk-create)

Accepts name-only and returns `{"result":"success"}` — but the response **does not echo the created `uuid`**, and the new label does not appear in `find-available`. Useless as a uuid-resolution tool.

---

## 3. Decision matrix

| Option | Strategy | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A** | Two-phase: `POST /tasks` without `labels`, then `POST /task-labels/add-to-task/{newId}` with `[{name}]` per label. | Reuses already-working wire (R24); preserves `--label <name>` UX; no workspace pollution; matches how the web UI must work. | Two HTTP calls instead of one; non-atomic — if create succeeds and attach fails, the task exists without the label. | **Chosen.** |
| **B** | Mint `uuid v4` client-side and send `{uuid, name, color: '#77787a'}` in the create body. | Atomic single call. | Server doesn't dedupe by name on this endpoint per probe — every invocation creates a *new* label. Pollutes the workspace. Probably wrong. | Rejected. |
| **C** | Drop `--label <name>`; require `--label-uuid <uuid>`. | Trivial. | Hostile UX — users would need to look UUIDs up out-of-band; breaks the existing flag. | Rejected. |

**Chosen: Option A.** Two extra round-trips per label is acceptable — partial-failure surface is bounded (task exists without the label, no corruption), and the failure is fully observable in the envelope.

---

## 4. Chosen approach (UX-level)

### 4.1 Single mode

`freelo tasks create --tasklist 42 --name "Fix the build" --label bug --label urgent`

1. Tasklist → project lookup (unchanged).
2. `POST /project/{p}/tasklist/{t}/tasks` with the body **without** `labels`. Other fields unchanged.
3. If labels were requested AND the task POST succeeded:
   - **Single batched call**: `POST /task-labels/add-to-task/{newTaskId}` with `{ labels: [{name: 'bug'}, {name: 'urgent'}] }`. One round-trip, not N. Mirrors `addTaskLabels` (`src/api/tasks-edit.ts:144`).
4. Build the success envelope (`freelo.tasks.create/v1`) including the new `applied_labels` field (§6). On attach failure, see §7.

Total live HTTP cost: 2 calls when `--label` is set, 1 call otherwise (same as today on the no-label path).

### 4.2 Batch mode (`--stdin` NDJSON)

Per-line: identical two-phase flow. A line's attach failure is a per-line failure (NDJSON error envelope on that line, exit-code accumulator observes it; the rest of the stream continues). Matches `runBatch` semantics in `src/commands/tasks/create.ts:409`.

### 4.3 Dry-run

Today the dry-run prints a single `would: { method, path, body }`. Under Option A, dry-run must describe **both** prospective calls. Two changes:

- `data.would` becomes an **array** (R10-style — see `EditWouldEntrySchema` at `src/api/schemas/task.ts:579`), not a single object. Order: create call first, attach call second (only present when `--label` was set).
- This is a **breaking change to dry-run output shape**. The envelope schema `freelo.tasks.create/v1` has `would` as a single object today. See §6 for the resolution (treat dry-run-only field shape change as additive *iff* we tolerate both shapes — but the spec mandates clean schemas, so we go to a v2 bump). **Decision: bump to `freelo.tasks.create/v2`.** See §6.

### 4.4 Concrete invocations

**TTY single (human):**
```sh
$ freelo tasks create --tasklist 42 --name "Fix the build" --label bug --label urgent
✓ created task #98765 "Fix the build" in tasklist 42 / project 11
✓ attached labels: bug, urgent
```

**Agent single (env auth, JSON):**
```sh
$ FREELO_API_KEY=… FREELO_EMAIL=… freelo tasks create \
    --tasklist 42 --name "Fix the build" --label bug --output json
{"schema":"freelo.tasks.create/v2","data":{"task":{"id":98765,"name":"Fix the build","labels":[{"uuid":"…","name":"bug","color":"#77787a"}]},"tasklist_id":42,"project_id":11,"applied_labels":{"requested":["bug"],"attached":["bug"],"failed":[]}},"rate_limit":{…},"request_id":null}
```

**Agent dry-run:**
```sh
$ freelo tasks create --tasklist 42 --project 11 --name X --label bug --dry-run --output json
{"schema":"freelo.tasks.create/v2","dry_run":true,"data":{"tasklist_id":42,"project_id":11,"would":[{"method":"POST","path":"/project/11/tasklist/42/tasks","body":{"name":"X"}},{"method":"POST","path":"/task-labels/add-to-task/{new_task_id}","body":{"labels":[{"name":"bug"}]}}]}}
```

Note: in dry-run the second `would.path` carries the placeholder `{new_task_id}` because the new task id isn't known yet. This is documented in help text and human renderer.

**Error path (attach 5xx after successful create):**
```sh
$ freelo tasks create --tasklist 42 --name "Fix the build" --label bug --output json
{"schema":"freelo.tasks.create/v2","data":{"task":{"id":98765,…},"tasklist_id":42,"project_id":11,"applied_labels":{"requested":["bug"],"attached":[],"failed":[{"name":"bug","error_code":"FREELO_API_ERROR","http_status":502,"message":"Bad Gateway"}]}},"notice":"Task created but label attach failed; task #98765 has no labels.","rate_limit":{…}}
# exit 4
```

---

## 5. Wire-shape contract changes

### 5.1 `buildCreateTaskBody` (`src/api/tasks-create.ts:26`)

`labels` is **dropped from the wire body entirely**. The pure builder takes a body that no longer carries labels; the command layer carries the label list out-of-band and dispatches the second call after the first succeeds.

Concretely the `CreateTaskBody` type at `src/api/schemas/task.ts:501` loses its `labels?: { name: string }[]` field. The `CreateTaskInput` keeps `labels?: readonly string[]` (CLI input shape unchanged). The mapping at `src/api/tasks-create.ts:40-42` is removed.

### 5.2 New helper in `src/api/tasks-create.ts`

A thin wrapper that does the second call. We **reuse** `addTaskLabels` from `src/api/tasks-edit.ts:144` rather than duplicating wire code — the body shape and skip-when-empty semantics are identical. The reuse decision is the only cross-module concern; the implementer extracts `addTaskLabels` into a more neutral home if it grows two callers' worth of churn (see Plan).

### 5.3 No change to `tasks-edit.ts` or `task-labels.ts`

Neither file touches the broken endpoint. They stay as they are.

---

## 6. Envelope schema changes

### 6.1 Schema bump: `freelo.tasks.create/v1` → `freelo.tasks.create/v2`

Decision: **bump** because `data.would` changes from a single object to an array (`EditWouldEntry[]`-style). Per `.claude/docs/conventions.md` §Output schemas, retyping a field is breaking. Single-object→array would silently break consumers that destructure `data.would.path`.

`/v1` is preserved in the codebase as a literal type (not removed) so that any future regression test referencing it still compiles. `/v1` is no longer emitted by the runtime.

### 6.2 New fields in `data` (additive on top of v1's other shape)

```ts
TasksCreateData = {
  task?: TaskCreated;          // unchanged — present in success, absent in dry-run
  tasklist_id: number;
  project_id: number | null;
  // CHANGED: was a single `{method,path,body}` object in v1; now array.
  would?: Array<{ method: 'POST'; path: string; body: unknown }>;
  // NEW: present in live mode whenever --label was passed (or [] when not).
  applied_labels?: {
    requested: string[];                  // input names, post-dedupe-as-emitted-by-CLI (verbatim, no trim)
    attached: string[];                   // names that the attach call confirmed
    failed: Array<{
      name: string;
      error_code: string;                 // BaseError.code (e.g. FREELO_API_ERROR)
      http_status: number | null;
      message: string;
    }>;
  };
  line_index?: number;          // unchanged
};
```

`applied_labels` is **absent** when `--label` was not passed (single AND batch modes). When it IS present:
- Live success path with all attaches OK: `requested` and `attached` equal, `failed` is empty.
- Live success path with attach failure: `requested` lists everything; because the attach is a *single* batched call, the failure mode is all-or-nothing — either all names land in `attached` or all land in `failed`. We do not synthesize per-name failure; the `failed[*].error_code` repeats once per requested name with the same root error. (Decision: callers can read `attached.length === 0` for "everything failed" and don't need per-name granularity that the wire doesn't provide.)
- Dry-run: absent; the prospective `would[1].body.labels` is the source of truth.

### 6.3 Changeset call-out

Required line in the changeset:
```
schema `freelo.tasks.create/v2` bumped — `data.would` retyped from object to array; `data.applied_labels` added.
```

### 6.4 Help-text bump

`freelo tasks create --help` learns one new line under `--label`:

> Each name maps to a separate `POST /task-labels/add-to-task/<new-id>` call after the task is created. On attach failure, the task is still created; see `applied_labels.failed` for diagnosis.

---

## 7. Error model — partial failure

Two distinct failure shapes:

### 7.1 Create POST fails

Identical to today: `FreeloApiError` propagates, no envelope, exit 4. No labels attached (we never got a task id). Nothing changes here.

### 7.2 Create POST succeeds, attach POST fails

This is the new partial-failure case. Decision:

- **Exit code: 4** (one of the wire calls failed). Matches `FreeloApiError.exitCode` defaults; the attach error is the dominant failure.
- **stdout receives a success-shaped envelope** (so agents can read `data.task.id` to follow up) but with `applied_labels.failed` populated and `applied_labels.attached` empty.
- **`notice` field** on the envelope: `"Task created but label attach failed; task #{id} has no labels."`. The notice slot already exists on the envelope (used by R09's worker-discard notice — see `src/commands/tasks/create.ts:386`).
- **stderr emits a structured error envelope** (`freelo.error/v1`) for the attach failure, with `context: { task_id, requested_label_names }`. This is a deliberate dual-emit: stdout carries the success state of the task, stderr carries the diagnostic for the attach.

Rationale: an agent that did `freelo tasks create … && freelo tasks edit "$id" …` needs `data.task.id` to exist. Hiding it inside an error envelope (which conventionally lives on stderr) would force the agent to parse stderr, which is anti-pattern. The dual emit is similar to how R10 (`tasks edit`) handles the post-edit refresh-GET failure (see `src/api/schemas/task.ts:606` and spec 0020 decision 11).

### 7.3 Batch mode partial failure

Per-line. The success envelope or the error envelope goes on the *single* output stream (NDJSON), keyed by `line_index`. Attach failure on a line emits one NDJSON line carrying the success envelope with `applied_labels.failed` populated AND a separate NDJSON error envelope right after it (in that order). `ExitCodeAccumulator` observes 4. Rest of the stream continues. Matches `writeBatchError` patterns at `src/commands/tasks/create.ts:601`.

### 7.4 Validation pre-flight

Empty `--label` value already fails via `collectNonEmptyString` (`src/commands/tasks/create.ts:77`). Unchanged.

---

## 8. Out of scope

- **`tasks edit --label <name>`** — uses `addTaskLabels` already; probe data confirms it works. No fix.
- **`task-labels attach --name <name>`** — same wire as above. No fix.
- **`project-labels` CRUD** — separate resource group, separate (intact) wire.
- **Dedup-by-name on the create endpoint.** We're not trying to be smart about whether a name already exists in the workspace. The post-create attach call handles that server-side (creates if missing, reuses if present, per probe).
- **Synthetic per-name failure attribution.** When the single batched attach fails, we report all requested names as `failed` with the same root error. We don't fan out to N calls for finer attribution.
- **OpenAPI patches.** `docs/api/freelo-api.yaml` stays as-is. The skill doc records the quirk.

---

## 9. Open questions

None. Probe data is conclusive on every behavioural question. The remaining knobs (schema bump, exit code on partial failure, single-vs-N attach calls) are design decisions, not unknowns — recorded above.

---

## 10. Test plan

All under `vitest` + MSW. New / extended files:

- `test/api/tasks-create.test.ts` — pure-builder coverage that `labels` is no longer in the body; existing assertions for other fields preserved.
- `test/commands/tasks/create.test.ts` — full command tests with MSW. Parametrised matrix:

| Scenario | Create POST | Attach POST | Expected envelope schema | `applied_labels.attached` | `applied_labels.failed` | Exit |
|---|---|---|---|---|---|---|
| No `--label` | 200 | (not called) | v2 | (absent) | (absent) | 0 |
| 1 label, attach OK | 200 | 200 | v2 | `["bug"]` | `[]` | 0 |
| 2 labels, attach OK | 200 | 200 (batched) | v2 | `["bug","urgent"]` | `[]` | 0 |
| Attach 400 invalid | 200 | 400 | v2 + stderr error | `[]` | both names | 4 |
| Attach 502 | 200 | 502 | v2 + stderr error | `[]` | both names | 4 |
| Create 400 | 400 | (not called) | error | n/a | n/a | 4 |
| Dry-run no `--project` | (not called; lookup runs) | (not called) | v2 dry-run, `would` array length 2 | n/a | n/a | 0 |
| Dry-run `--project` no labels | (not called) | (not called) | v2 dry-run, `would` array length 1 | n/a | n/a | 0 |
| Batch 3 lines, line 2 attach fails | per-line | per-line | NDJSON: success, success+error, success | per line | per line | 4 |

For each row: assert (a) human output on simulated TTY, (b) JSON envelope shape on non-TTY, (c) stderr error envelope where applicable. Mirror the `testing-patterns` skill conventions used by R09 today.

MSW handlers:
- Existing `POST /project/:p/tasklist/:t/tasks` handler stays (now asserts NO `labels` field in body).
- New handler for `POST /task-labels/add-to-task/:id` parametrised by per-test reply factory (200, 400, 502).

Snapshot the human renderer's two new lines (`✓ attached labels: …`, `notice: …`).

Coverage target unchanged (90% on `src/api/` and `src/commands/`).

---

## 11. Version target

**v0.17.2 — patch.** The fix repairs broken behaviour against the live API. The schema bump to `/v2` is mechanically a public-contract change, but per pre-1.0 convention (and because v1 is *only* emitted on a code path that returns 400) we treat it as a patch — no v1 caller can be working today. The changeset entry calls out the schema bump explicitly so consumers can audit if they want.

If the maintainer disagrees and prefers v0.18.0 (minor) for the schema bump, that's a one-character changeset edit; flag in review.

---

ARCHITECT run=manual status=ok spec=docs/specs/0041-tasks-create-label-fix.md open_questions=0 new_deps=0

---

## Plan

Implementation slice — single PR, single commit (fix). No new deps, no plan
deviations from §3 strategy A. Ordered by dependency.

### Files to modify

1. **`src/api/schemas/task.ts`** — schema bump.
   - Drop `labels?: { name: string }[]` from `CreateTaskBody` type.
   - Retype `TasksCreateDataSchema.would` from
     `z.object({...}).optional()` to `z.array(z.object({...})).optional()`
     (mirrors `EditWouldEntrySchema[]` at line 579).
   - Add `applied_labels` field to `TasksCreateDataSchema`:
     ```ts
     applied_labels: z.object({
       requested: z.array(z.string()),
       attached: z.array(z.string()),
       failed: z.array(z.object({
         name: z.string(),
         error_code: z.string(),
         http_status: z.number().int().nullable(),
         message: z.string(),
       })),
     }).optional(),
     ```
   - `TasksCreateData` type re-derives from the bumped schema.

2. **`src/api/tasks-create.ts`** — wire-builder cleanup.
   - Drop the `if (input.labels !== undefined …) body.labels = …` block at L40-42.
   - Update the JSDoc comment block at L17-22 to remove the `labels` mention.
   - No new helper here — we reuse `addTaskLabels` from `src/api/tasks-edit.ts:144`.
     (Decision A: do NOT extract `addTaskLabels` to a neutral file. Two callers
      is below the spec's stated extract threshold, and the existing import
      from `tasks-create.ts → tasks-edit.ts` is a one-line change vs. a
      cross-file refactor that touches every call site. Logged in decisions.)

3. **`src/commands/tasks/create.ts`** — orchestration changes.
   - `SCHEMA` constant: `'freelo.tasks.create/v1'` → `'freelo.tasks.create/v2'`.
   - `meta.outputSchema`: same bump.
   - Single mode (`runSingle`):
     - After successful `createTask`, if `opts.label` non-empty AND non-dry-run:
       - Import `addTaskLabels` from `../../api/tasks-edit.js`.
       - Wrap the call in try/catch. On success: `applied_labels = { requested, attached: requested, failed: [] }`.
       - On `BaseError`: build `applied_labels.failed = requested.map(name => ({name, error_code, http_status, message}))`,
         set `notice = "Task created but label attach failed; task #${id} has no labels."`,
         build the success envelope on stdout (with `applied_labels` populated), then re-throw via
         a new helper that emits a stderr error envelope but suppresses
         `handleTopLevelError`'s own envelope emission.
       - Pattern for "stdout success + stderr error + non-zero exit": emit the
         success envelope synchronously to stdout first, then call a new
         helper `emitStderrError(typed, mode)` that mirrors
         `buildErrorEnvelopeInternal` from `src/errors/handle.ts` and writes
         to `stderr`, then `await drainDispatcher()` and `await exitDeferred(typed.exitCode)`.
   - Dry-run path:
     - `data.would` becomes an array. When `opts.label` is non-empty, push a
       second entry `{ method: 'POST', path: '/task-labels/add-to-task/{new_task_id}', body: { labels: requested.map(name => ({ name })) } }`.
     - Use the new `dryRunEnvelopeArray` helper (or inline construction). See
       Decision B below — we'll inline-construct since the abstraction would
       exist for one caller; dry-run-helper stays as is for other callers.
   - Batch mode (`runBatch`): same shape — per-line label attach happens after
     `createTask` succeeds; per-line failure emits the dual envelope (success on
     line N, then error envelope on line N+? — per-line success + error stays
     keyed to `line_index`).

4. **`src/lib/dry-run.ts`** — extend to support an array `would`.
   - Decision B: instead of inlining, add a sibling helper
     `dryRunEnvelopeArray<T>` that takes `would: Would[]` and splices into
     `data.would`. Keeps the dry-run abstraction unified. Old `dryRunEnvelope`
     stays untouched for R10/R11/R12/R13 callers (they're R10 array-style or
     R11 object-style; nothing else needs to change because this slice only
     affects R09's tasks-create).
   - Wait — checking: R10 (`tasks edit`) already has an array `would`.
     It uses inline construction (see `src/commands/tasks/edit.ts` — verify in
     implement). Pattern is established. Decision B (revised): inline-construct
     in `tasks/create.ts`, do NOT add a new helper. `dryRunEnvelope` is for
     single-call dry-runs (R11/R12/R13); R10 and R09-after-this-fix construct
     manually. Keeps the helper surface small.

5. **`src/ui/human/tasks-create.ts`** — render two new lines.
   - `renderTasksCreateHuman` learns to:
     - Append `Attached labels: bug, urgent.` line when `applied_labels.attached.length > 0`.
     - Append `Notice: ${notice}` line when notice is set (driven by envelope, not data).
     - Note: notice is on the envelope, not data. The renderer takes data only;
       the writer code in `create.ts` `writeEnvelope` will pull `env.notice` and
       append it as a separate line. Mirrors existing patterns.
   - For dry-run: show two `would` lines (or summarize "(dry-run) Would create
     task in tasklist X (project Y); plus label attach for: bug, urgent.")
     — keep it short, the renderer is one-liner-style today.
   - `renderBatchLineSuccessHuman` reuses; same data shape applies.

6. **`test/msw/handlers.ts`** — extend `tasksCreateHandlers`.
   - No new entries needed in `tasksCreateHandlers` (the create endpoint already
     has `ok`, `okWhenBody`, `forbidden`, `serverError`, `networkError`, etc.).
   - Reuse `tasksEditHandlers.addLabelsOk(taskId)`, `addLabelsOkWhenBody(taskId, predicate)`,
     `addLabelsUnprocessable(taskId, message)` for the new attach call.
   - Add **new** `tasksEditHandlers.addLabelsServerError(taskId, status)` and
     `tasksEditHandlers.addLabelsNetworkError(taskId)` if not already present
     (verify in implement; the spec test plan needs 502 and network failure).

7. **`test/api/tasks-create.test.ts`** — assert no `labels` in body.
   - Update the existing builder tests to assert `body.labels === undefined`
     even when `input.labels` is supplied (the field is dropped from the wire).
   - The pure builder still accepts `input.labels` (it's a no-op for the wire);
     remove the field from `CreateTaskInput`? No — `CreateTaskInput` keeps
     `labels?: readonly string[]` so the command code can still pass through.
     The builder ignores it. Per spec §5.1.

8. **`test/commands/tasks/create.test.ts`** — extend with §10 matrix.
   - Update existing assertions: `'freelo.tasks.create/v1'` → `/v2` everywhere.
   - The `every flag` test (L224-273) must NOT expect `labels: [...]` in the
     create body anymore. Rewrite the predicate:
       `expect(body.labels).toBeUndefined()` AND verify the SECOND call lands
       on `/task-labels/add-to-task/9012` with `{labels: [{name: 'blocker'}, {name: 'qa'}]}`.
   - New scenarios per spec §10:
     - 1 label, attach OK → exit 0, applied_labels populated, attached=[name].
     - 2 labels, attach OK → one batched call, attached=both names.
     - Attach 422 invalid → exit 4, applied_labels.failed populated, stdout has success envelope, stderr has error envelope.
     - Attach 502 → exit 4, retryable=true on the stderr error envelope.
     - Dry-run with --label: `data.would` length 2.
     - Dry-run without --label: `data.would` length 1.
     - Batch 3 lines, line 2 attach 502: NDJSON output is success / success+error / success, exit 4.
     - The two existing dry-run tests must update to read `would[0]` (array, not object).
   - Introspect test (L1048): `output_schema` now `freelo.tasks.create/v2`.

9. **`docs/commands/tasks-create.md`** — schema bump + new section.
   - `schema: "freelo.tasks.create/v1"` → `/v2` (4 occurrences).
   - New section "Label attach (two-phase)" explaining the two-call flow.
   - Updated dry-run example with `would` as an array.
   - Add `applied_labels` fields to the success envelope example.
   - New row in the "Error envelopes" table for partial failure.
   - Help-text snippet for `--label` updated per spec §6.4.

10. **`.changeset/tasks-create-label-fix.md`** — patch entry per spec §11.
    ```
    ---
    'freelo-cli': patch
    ---

    fix(commands): tasks create --label now decomposes into create-then-attach,
    fixing the live-API 400 "Missing item 'uuid' in array."

    Schema `freelo.tasks.create/v2` bumped — `data.would` retyped from object to
    array (in --dry-run output); `data.applied_labels` added to surface attach
    success/failure per label name. The /v1 envelope was only emitted on a code
    path that returned 400, so no working caller is affected.
    ```

11. **`README.md`** autogen block — run `pnpm fix:readme`. Likely no diff
    (the command list is unchanged; only the schema string changes, which the
    README block doesn't enumerate).

### New dependencies

None. Pre-approved list from triage: `[]`. No surprises.

### Test strategy

- **Unit (`test/api/tasks-create.test.ts`)**: pure builder — verify `labels`
  is dropped from the wire body even when present in input.
- **Integration (`test/commands/tasks/create.test.ts`)**: full matrix per
  spec §10. MSW for both endpoints. Coverage target unchanged (90% on
  `src/commands/`).
- **Human renderer**: new line for `Attached labels: …`, one assertion in
  the existing happy-path human-mode test.
- **Per Calibration §2**: every error path asserts the exit code via the
  captured `process.exit`. Specifically the new partial-failure case asserts
  exit 4 explicitly.
- **Per Calibration §4**: any new try/catch arm in `create.ts` is exercised
  by at least one test (attach 4xx, attach 5xx, attach network).
- **Per Calibration §3**: after commit, run the full gate
  (`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`)
  on the committed tree before push.

### Rollout order

Single landable slice. The fix is small enough (≤10 source files including
tests) and the schema bump is intentional, so no staging is needed.

PLAN run=2026-05-01-0652-tasks-create-label-fix status=ok files=11 new_deps=0 retries=0
