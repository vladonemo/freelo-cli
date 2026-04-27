# 0020 — `freelo tasks edit <id>` (R10)

**Status:** Accepted — ready for implementation
**Run:** 2026-04-27-tasks-edit
**Tier:** Yellow (additive new command + new envelope schema; second write — reuses R09's shared infra)
**Branch:** `feat/tasks-edit`
**Cross-reference:** Patterns inherited from spec 0019 (R09 `tasks create`). API endpoint set differs (POST `/task/{id}` for the edit + `POST /task-labels/add-to-task/{id}` and `/remove-from-task/{id}` for label diff), but the CLI shape is intentionally aligned with R09.

---

## 1. Problem

After R09, an agent can **create** tasks but cannot edit them. R10 ships the partial-update verb, plus the label-diff sub-surface. With R10 in hand, an agent can re-assign work, change priority, push a due date, and adjust labels without a round-trip through the web UI. This is the second write slice — it borrows R09's shared infra (`src/lib/dry-run.ts`, write-flow conventions) **verbatim**. We add no new infra here; if a R09 helper doesn't fit, we don't bend a knee — we copy the create-style code path locally and accept the redundancy. The shared infra has not yet seen its second consumer; R10 is the first reuse moment, and we resist generalizing further until R11/R12 demand it.

## 2. Background — what the API gives us

### 2.1 `POST /task/{task_id}` — partial edit (OpenAPI :1690-1762)

The Freelo facade silently ignores any body key not in the documented whitelist (`array_intersect_key`). The whitelist is:

| Field | Type | Notes |
|---|---|---|
| `name` | string | |
| `worker` | int (user id) | `worker_id` is accepted as an alias (make.com HACK in the facade) — we send `worker` only |
| `due_date` | date-time | |
| `due_date_end` | date-time | out of scope for v1 (no roadmap flag) |
| `labels` | `TaskLabel[]` (full DTOs or UUID refs) | **NOT used here** — see 2.2 (we use the diff endpoints) |
| `priority_enum` | `'l' \| 'm' \| 'h' \| null` | passing `null` clears priority |
| `tracking_users_ids` / `add_tracking_users_ids` / `remove_tracking_users_ids` | int[] | out of scope for v1 |

**Verb:** the OpenAPI documents `POST /task/{task_id}` for the edit. The roadmap allows "PATCH … or the spec's edit verb" — we follow the OpenAPI (decision 1).

**Response:** `TaskDetail` (same shape as `GET /task/{id}` — already in `src/api/schemas/task.ts` from R08).

### 2.2 `POST /task-labels/add-to-task/{task_id}` (OpenAPI :2484-2528)
### 2.3 `POST /task-labels/remove-from-task/{task_id}` (OpenAPI :2530-2573)

Both take `{ labels: TaskLabelInput[] }`. Add-mode supports name-mode (`{ name }`, server defaults color to `#77787a`) — we use this. Remove-mode supports name-only mode (removes all labels with that name; aggressive). Both endpoints short-circuit on empty `labels[]` (no event, 200) — we still avoid calling them when there's nothing to add/remove (sub-second savings + zero noise).

### 2.4 Edit-then-diff order

Per the OpenAPI's edit-body section, `labels` may also be set as part of the edit body. We **do not** use that path for label changes (decision 2): R10 implements label changes only through the explicit `--add-label` / `--remove-label` diff endpoints, so the CLI surface matches the roadmap (`--add-label`, `--remove-label`) and behavior is symmetrical with R09 (where create's `--label` only adds). The `labels` whitelist field is left for a future `--set-labels` flag if the need ever appears.

## 3. Proposal

### 3.1 Subcommand signature

```
freelo tasks edit <id>
  [--name <str>]                 # rename
  [--worker <id>]                # repeatable; only first sent (matches create)
  [--due <YYYY-MM-DD>]           # ISO calendar date → wire YYYY-MM-DDT00:00:00Z
  [--priority low|normal|high]
  [--clear-priority]             # send priority_enum: null  (mutex with --priority)
  [--add-label <name>]...        # repeatable
  [--remove-label <name>]...     # repeatable
  [--dry-run]                    # no HTTP at all (no edit, no label diff)
  [--project <id>]               # dry-run-only escape hatch (matches create); NEVER required
```

**At least one mutating flag is required** (decision 3). Calling `freelo tasks edit 9012` with no other flags returns `VALIDATION_ERROR` (exit 2) — empty edits are almost always a bug.

**Out of scope for R10 (deferred — log decisions, do not pause):**
- `--description` / `--description-file` — description editing lands in **R15** (`tasks description set`).
- `--editor` — same.
- `--due-end` / `--clear-due` — out of scope.
- `--tracking-users` add/remove/replace — out of scope.
- `--stdin` NDJSON batch — explicitly out of scope for v1 (decision 4); a batch story for `tasks edit` is delicate (per-line vs. shared `<id>` arg vs. shared other flags) and not on the roadmap. Defer until a real use case lands.
- `<id>...` repeatable positional — same reasoning; defer.

**Per-command `meta`:**

```ts
export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.edit/v1',
  destructive: false,
};
```

`destructive: false` — edit is reversible (re-run with the prior values). Idempotency is **not** automatic at the API level (no `If-Match` / version), but the operation is naturally idempotent for the supported fields: re-applying the same body lands the same end state. We do not invent a synthetic key.

### 3.2 Envelope shape — `freelo.tasks.edit/v1`

Live success:

```jsonc
{
  "schema": "freelo.tasks.edit/v1",
  "data": {
    "task": { /* TaskDetail — parsed-and-validated, full reload */ },
    "tasklist_id": 314,
    "project_id": 42,
    "applied_changes": {
      "edit": { "name": "Audit auth (v2)", "priority_enum": "h" },
      "labels_added": ["urgent"],
      "labels_removed": ["wontfix"]
    }
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-04-27T20:30:00Z" },
  "request_id": "..."
}
```

`applied_changes` echoes the **wire-side** diff that the CLI computed (snake-case keys, `priority_enum`, etc.). It is **always present** on success; absent fields signal "nothing was changed in this group". `applied_changes.edit` may be `{}` if only labels changed; `applied_changes.labels_added` / `labels_removed` are arrays — empty array means the group had no input. Agents key off `applied_changes.edit !== undefined` etc.

`--dry-run`:

```jsonc
{
  "schema": "freelo.tasks.edit/v1",
  "dry_run": true,
  "data": {
    "tasklist_id": 314,
    "project_id": 42,
    "applied_changes": { "edit": {...}, "labels_added": [...], "labels_removed": [...] },
    "would": [
      { "method": "POST", "path": "/task/9012", "body": { ... } },
      { "method": "POST", "path": "/task-labels/add-to-task/9012", "body": { "labels": [{"name": "urgent"}] } },
      { "method": "POST", "path": "/task-labels/remove-from-task/9012", "body": { "labels": [{"name": "wontfix"}] } }
    ]
  }
}
```

**Note the deviation from R09's `would`:** R10's `would` is an **array** of call descriptors (the edit may fan out across 1–3 endpoints), not a single object. R09's helper (`dryRunEnvelope`) types `would` as `Would` (single). We solve this by **constructing the envelope inline** in the edit command (same `dry_run: true` top-level discriminant; a different `data.would` shape). This is the correct minimal change — generalizing `dryRunEnvelope` for `Would | Would[]` would be premature; R10 is the only caller that needs an array. R11–R13 are likely single-call again. Decision 5.

`data.would` is **only** present in `--dry-run` envelopes. No `rate_limit`, no `request_id` on dry-run.

No batch mode in v1 → no `line_index` field (decision 4).

### 3.3 Field naming and rules

- Snake-case in wire & envelope (`tasklist_id`, `project_id`, `priority_enum`, `due_date`, `labels_added`, `labels_removed`).
- `data.task` is the parsed `TaskDetail` shape (already in `src/api/schemas/task.ts`). It carries the **post-edit** state — i.e., the result of a fresh `GET /task/{id}` after the edit applied. **Why a fresh GET:** the edit endpoint *does* return `TaskDetail`, but **labels are altered out-of-band** by the add/remove endpoints. If any label diff was applied, a single GET-after-write is the only way to deliver a correct, agent-trustworthy `task` payload. We always do the GET on success — even when only the edit body changed — so the envelope's `task` field has uniform freshness semantics. Decision 6.
- `applied_changes.edit` is **the body sent to `POST /task/{id}`** verbatim (after CLI→wire mapping). Empty object `{}` when no edit body was sent.
- `applied_changes.labels_added` / `labels_removed` are the **input names** the user passed (not the server's resolved UUIDs — those are visible in `data.task.labels[]`).
- Top-level keys agents may key off: `schema`, `data.task.id`, `data.task.labels`, `data.applied_changes`, `dry_run`, `data.tasklist_id`, `data.project_id`. None removed/renamed in subsequent v1 revisions.

### 3.4 Repeatable `--worker` (matches R09)

The edit body accepts a single `worker`. We accept `--worker <id>` repeated for forward-compat but **only the first occurrence is sent**, with the same `notice` envelope field as R09: `"--worker repeated; only the first id was used. Discarded: <ids>."` Decision 7.

### 3.5 Label diff semantics

- `--add-label foo` → name-mode add (`{ labels: [{ name: 'foo' }] }`), server defaults color to `#77787a`. If a label with the same name already exists on the task, the API short-circuits (idempotent). **Names are case-sensitive** server-side (OpenAPI :2501) — we do not normalize case.
- `--remove-label foo` → name-mode remove (`{ labels: [{ name: 'foo' }] }`). **Aggressive** — removes every label matching that name regardless of color (OpenAPI :2548). We document this clearly in `--help`.
- Same-name in both `--add-label` AND `--remove-label`: rejected with `ValidationError` at flag-parse time (decision 8). Otherwise the add-then-remove order would matter and the surface gets confusing fast. Symmetric: empty after trim → `ValidationError`.
- **Order on the wire:** remove-first, then add. Rationale: if a user has `wontfix` and asks `--add-label wontfix --remove-label fixme` we want both to apply. If we add-then-remove and an add fails partway, we leave the task in a weird state. Remove-first leaves the safer half-state on a fan-out failure. Decision 9.

### 3.6 Atomicity and partial failure

The edit fans out across up to 3 HTTP calls (edit body + remove labels + add labels). The Freelo API does **not** offer transactional semantics. Our policy:

1. Run remove-labels (if any) → on failure, stop, surface `FreeloApiError`. The task is unchanged on the wire.
2. Run add-labels (if any) → on failure, **task already lost the removed labels** but never gained the new ones. We surface `FreeloApiError`. The user sees a precise message ("removed `wontfix` succeeded; failed to add `urgent`: 422 — `Unsupported color`"). No automatic rollback — agents that need atomicity must manage state themselves. Decision 10.
3. Run edit body (if any) → same story. Surface the error verbatim.
4. After all succeed → `GET /task/{id}` to refresh. If the GET fails, we still emit the success envelope but with `task: null` and a `notice` explaining the freshness gap. Decision 11.

The order **remove → add → edit** keeps the simplest surface: errors abort, partial successes are observable through `applied_changes`. The implementer must keep `applied_changes` honest — only list what *actually* succeeded. Decision 12.

The dry-run case skips all four steps; `applied_changes` shows the **planned** diff and `would[]` shows the **planned** call set.

### 3.7 Example invocations

**Human (TTY):**
```bash
$ freelo tasks edit 9012 --name "Audit auth (v2)" --priority high --add-label urgent
Edited task #9012: name, priority, labels (+urgent).
```

**Agent (JSON, env-var auth):**
```bash
$ FREELO_API_KEY=*** FREELO_EMAIL=bot@example.com \
  freelo tasks edit 9012 --priority high --remove-label wontfix --output json
{"schema":"freelo.tasks.edit/v1","data":{"task":{...},"applied_changes":{"edit":{"priority_enum":"h"},"labels_added":[],"labels_removed":["wontfix"]},"tasklist_id":314,"project_id":42}, "rate_limit":{...}}
```

**Dry-run:**
```bash
$ freelo tasks edit 9012 --name "X" --add-label urgent --dry-run --output json
{"schema":"freelo.tasks.edit/v1","dry_run":true,"data":{"would":[{"method":"POST","path":"/task/9012","body":{"name":"X"}},{"method":"POST","path":"/task-labels/add-to-task/9012","body":{"labels":[{"name":"urgent"}]}}],"applied_changes":{"edit":{"name":"X"},"labels_added":["urgent"],"labels_removed":[]},"tasklist_id":314,"project_id":42}}
```

Note: dry-run still uses the project lookup (one GET against `/task/{id}` to derive `tasklist_id`/`project_id`). With `--project N` plus `--dry-run`, we **also** skip that lookup (decision 13 — escape hatch for offline/CI). Without `--project`, dry-run does **one** GET (`/task/{id}` → reads `tasklist.id` and `project.id` from the embedded refs). This is structurally cheaper than R09's lookup (one GET instead of two — no separate tasklist GET needed since `TaskDetail` already carries `tasklist`/`project` refs).

**Error (no flags):**
```bash
$ freelo tasks edit 9012
freelo: At least one of --name, --worker, --due, --priority, --clear-priority, --add-label, --remove-label is required.
$ echo $?
2
```

## 4. Errors

| Trigger | Class | code | exitCode | retryable | hint_next |
|---|---|---|---|---|---|
| `<id>` not a positive integer | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "<id> is the numeric task id from `freelo tasks list`." |
| No mutating flags set | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "Pass at least one of --name, --worker, --due, --priority, --clear-priority, --add-label, --remove-label." |
| `--worker` not positive integer | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--worker is the numeric user id." |
| `--due` not ISO date | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--due must be in YYYY-MM-DD format." |
| `--priority` not in enum | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--priority must be one of: low, normal, high." |
| `--priority` AND `--clear-priority` | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "Pick either --priority or --clear-priority, not both." |
| `--add-label ""` (empty after trim) | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--add-label cannot be empty." |
| `--remove-label ""` (empty after trim) | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--remove-label cannot be empty." |
| Same name in both `--add-label` and `--remove-label` | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "Label '<name>' is in both --add-label and --remove-label; pick one." |
| `--name ""` (empty) | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--name cannot be empty (use --clear-priority or similar to clear other fields)." |
| `--project` without `--dry-run` | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--project is only valid with --dry-run." |
| HTTP 401 (anywhere) | `FreeloApiError` (auth-expired) | `AUTH_EXPIRED` | 3 | false | "Re-authenticate with `freelo auth login`." |
| HTTP 403 on edit / labels (worker not assignable, ACL on label set) | `FreeloApiError` | `FORBIDDEN` | 4 | false | "Confirm the worker is on the tasklist's assignable-workers list (`freelo tasklists show ...`)." |
| HTTP 404 on `GET /task/{id}` lookup or POST `/task/{id}` | `FreeloApiError` | `FREELO_API_ERROR` | 4 | false | "Confirm task id; you may not have access." |
| HTTP 422 on POST `/task/{id}` (server-side rejected) | `FreeloApiError` | `FREELO_API_ERROR` | 4 | false | server message passed through |
| HTTP 422 on label add (e.g., `Unsupported color`) | `FreeloApiError` | `FREELO_API_ERROR` | 4 | false | server message passed through |
| HTTP 429 (any call) | `RateLimitedError` | `RATE_LIMITED` | 6 | true | "Retry after `retry_after` seconds." |
| HTTP 5xx (any call) | `FreeloApiError` | `FREELO_API_ERROR` | 4 | true | "Retry; if it persists, check Freelo status." |
| Network failure | `NetworkError` | `NETWORK_ERROR` | 5 | true | (existing) |
| Schema parse failure on `TaskDetail` | `FreeloApiError` (validation path) | `FREELO_API_ERROR` | 4 | false | "Server response did not match the expected shape." |
| Post-edit refresh GET fails | success envelope with `task: null`, `notice` | n/a | 0 | n/a | (decision 11) |

**Calibration §2:** every typed error class triggered by R10 has at least one exit-code-asserting test (see §6 Plan): `ValidationError` (multiple cases), `FreeloApiError` (404 on lookup, 403 on edit, 422 on label add, schema fail), `NetworkError` (one case), `RateLimitedError` (429 on edit).

## 5. Data model — zod schemas

Reuse:
- `TaskDetailSchema` (R08, src/api/schemas/task.ts) for the edit response and the post-edit refresh.
- `UserBasicSchema`, `TaskLabelSchema` (R07/R08).

New types in `src/api/schemas/task.ts`:

```ts
/** CLI-side input for the edit body builder. All fields optional. */
export type EditTaskInput = {
  name?: string;
  due?: string;                          // YYYY-MM-DD
  worker?: number;
  priority?: 'low' | 'normal' | 'high';  // mapped to 'l'|'m'|'h'
  clearPriority?: true;                  // mutex with priority above
};

/** Wire shape of the POST /task/{id} body (subset of OpenAPI :1717-1755). */
export type EditTaskBody = {
  name?: string;
  due_date?: string;
  worker?: number;
  priority_enum?: 'l' | 'm' | 'h' | null;
};

/** Envelope `data` shape for `freelo.tasks.edit/v1`. */
export const TasksEditDataSchema = z.object({
  task: TaskDetailSchema.nullable().optional(),
  tasklist_id: z.number().int().nullable(),
  project_id: z.number().int().nullable(),
  applied_changes: z.object({
    edit: z.record(z.string(), z.unknown()),
    labels_added: z.array(z.string()),
    labels_removed: z.array(z.string()),
  }),
  would: z.array(z.object({
    method: z.literal('POST'),
    path: z.string(),
    body: z.unknown(),
  })).optional(),
});
export type TasksEditData = z.infer<typeof TasksEditDataSchema>;
```

`buildEditTaskBody(input: EditTaskInput): EditTaskBody` is a pure function (in `src/api/tasks-edit.ts`), unit-testable without MSW.

`editTask(client, opts)` calls `POST /task/{id}` with `EditTaskBody` and validates the response through `TaskDetailSchema`.
`addTaskLabels(client, taskId, names)` and `removeTaskLabels(client, taskId, names)` POST to the diff endpoints. These return generic `SuccessResponse` (`{ result: 'success' }` per OpenAPI), which we don't need to expose — only rate-limit headers ride through.

## 6. Edge cases

- **No-op edit + label diff that's already in target state**: the API will still apply (or no-op silently); we still return success with `applied_changes` echoing what we requested. Don't try to pre-flight (a GET-then-diff would double the cost for marginal value).
- **`--dry-run`** without `--project`: one GET (the task lookup) runs, no POST. Same fail-fast behavior as R09: a 404 on the GET emits a single error envelope and exits 1, no further calls.
- **`--dry-run` + `--project`**: zero HTTP calls (decision 13).
- **`--worker` repeated**: only first sent; envelope carries a `notice`.
- **`--add-label` repeated with duplicates**: dedupe (case-sensitively) before sending. Same for `--remove-label`. Decision 14.
- **Trailing whitespace on `--name`**: preserved (Freelo treats `"foo "` and `"foo"` as different — same convention as R09 labels).
- **Empty effective edit body** (e.g. only `--add-label` set): we **skip** the POST `/task/{id}` call entirely. The label-only path does the diff endpoints + the post-action refresh GET only. Decision 15.
- **Label diff happens but edit body is empty**: same — skip the edit POST.
- **All flags set, all label-diff endpoints called, refresh fails**: success envelope with `task: null`, `applied_changes` accurate, `notice` explains the gap (decision 11).
- **Network failure mid-fan-out**: surfaced verbatim as `NetworkError`. The user knows from `applied_changes` what *was attempted*; they don't get a partial-success envelope (we throw before emitting any envelope). Calibration §4: each catch arm in the fan-out has a test.
- **SIGINT mid-fan-out**: handled via `signal` plumbing on `HttpClient`; in-flight call aborts → 130, no envelope.
- **No `paging`**: writes don't paginate.

## 7. Non-goals (R10 explicit out-of-scope)

- `--description` / `--description-file` / `--editor` (deferred to R15).
- `--due-end`, `--clear-due`, `--clear-name` (no clean OpenAPI signal for clearing name; --due-end has no roadmap flag).
- `--tracking-users` add/remove/replace.
- Repeatable `<id>` positional (multi-task batch).
- `--stdin` NDJSON batch mode.
- Setting full label DTOs (`--add-label-color #ff5555`, `--add-label-uuid …`). Name-only in v1.
- Label-diff via the edit-body's `labels[]` field (we use the explicit diff endpoints — decision 2).
- Server-side ACL pre-flight (we let the API tell us via 403).
- Automatic rollback on partial failure (decision 10).

## 8. Open questions

None. Every open scope-affecting question above has been resolved as a logged decision (decisions 1–15, in `docs/decisions/2026-04-27-tasks-edit-N-...md`).

## 9. Decisions log (autonomous)

1. **Edit verb is POST, not PATCH** — per OpenAPI :1690-1714. Roadmap says "PATCH … or the spec's edit verb" — we follow the spec.
2. **Label changes via diff endpoints, not edit-body `labels`** — keeps R10's surface symmetrical with create's `--label` (which only adds), and keeps the `data.applied_changes` shape stable. Future `--set-labels` (idempotent replace) would use the edit-body's `labels[]` if it ever lands.
3. **Empty edit (no flags) is `VALIDATION_ERROR`** — agents calling edit with no diff is almost always a bug. Alternative: silent no-op success. Chose fail-loud.
4. **No `--stdin` batch mode in v1** — defer until a real use case lands. The batch surface for "edit each row with the same set of changes" is delicate (per-line vs. shared) and not on the roadmap.
5. **`would` is `Would[]` here, single `Would` in R09** — different shape, justified by fan-out. Don't generalize `dryRunEnvelope` until R11/R12 force it.
6. **Always GET-after-write to refresh `task`** — labels mutate out-of-band; uniform freshness keeps `data.task` agent-trustworthy.
7. **Repeatable `--worker`, first-only on wire** — same as R09 for ergonomic alignment.
8. **Same name in `--add-label` and `--remove-label` → `VALIDATION_ERROR`** — order would matter and the surface gets confusing.
9. **Wire order: remove-labels → add-labels → edit-body → refresh** — leaves the safer half-state on a fan-out failure.
10. **No automatic rollback on partial failure** — surface the error; let the agent reason about state. Rollback is a complex feature; v1 keeps the surface honest with `applied_changes`.
11. **Refresh-GET failure → success envelope with `task: null` + `notice`** — the user's mutations succeeded; only the freshness read failed. Don't promote that to a full failure.
12. **`applied_changes` shows what *succeeded*, not what was *requested*** — the implementer must thread accumulators through the fan-out so on-error envelopes never overstate.
13. **`--project` as dry-run escape hatch** — same as R09. `--project` without `--dry-run` → `VALIDATION_ERROR`.
14. **Dedupe `--add-label` / `--remove-label` repeats case-sensitively** — Freelo treats them as distinct, so we must too.
15. **Skip the edit POST when no edit fields are set (label-only mode)** — saves a no-op API call.

(Decisions are written individually to `docs/decisions/2026-04-27-tasks-edit-<n>-<slug>.md` files at implementation time so each is independently grep-able. The summaries above are the index.)

---

## Plan

> **Plan rule:** the plan is the contract. If implementation deviates, update the plan first.

### 10. File-level TODOs

#### New files

1. **`src/api/tasks-edit.ts`** — pure body builder + thin wire wrappers:
   - `buildEditTaskBody(input: EditTaskInput): EditTaskBody` — pure, mirrors R09.
   - `editTask(client, opts: { taskId, body, requestId? }): Promise<{ task: TaskDetail, raw: ApiResponse<TaskDetail> }>` — POST `/task/{id}`, validates via `TaskDetailSchema`.
   - `addTaskLabels(client, taskId, names: string[], opts?): Promise<{ raw: ApiResponse<{ result: 'success' }> }>` — POST `/task-labels/add-to-task/{id}` with `{ labels: [{ name }, …] }`. Validates against a tiny `SuccessResponseSchema` (or `z.object({}).passthrough()`). Skips the call entirely if `names` is empty (returns a synthetic empty result).
   - `removeTaskLabels(client, taskId, names: string[], opts?)` — symmetric.
   - `editTaskPath(taskId)` / `addLabelsPath(taskId)` / `removeLabelsPath(taskId)` — string helpers reused by `--dry-run` to populate `would[].path`.
2. **`src/commands/tasks/edit.ts`** — Commander leaf. Mirrors structural shape of `src/commands/tasks/create.ts`. Owns:
   - flag parsing & validation (positional `<id>`, all flags above)
   - `at-least-one-flag` rule
   - tasklist→project derivation via `GET /task/{id}` (uses existing `getTaskDetail` from R08)
   - dry-run vs. live envelope build (inline `would[]` array)
   - human renderer call
   - fan-out orchestration: remove-labels → add-labels → edit-body → refresh-GET
3. **`src/ui/human/tasks-edit.ts`** — single-task human renderer:
   - Live success: `Edited task #<id>: <comma-list of changed groups>.`
   - Dry-run: `(dry-run) Would edit task #<id>: <changed groups>.`
4. **`test/commands/tasks/edit.test.ts`** — vitest + MSW. Covers (one named test per row):
   - **happy paths**
     - minimal: only `--name` → JSON envelope, schema string, exit 0
     - every editable field: body sent on the wire matches the builder mapping
     - `--clear-priority` → `priority_enum: null` on the wire
     - `--add-label` → POST /task-labels/add-to-task with `{ labels: [{ name }] }`
     - `--remove-label` → POST /task-labels/remove-from-task with `{ labels: [{ name }] }`
     - `--add-label X --remove-label Y --name Z` → wire order: remove → add → edit → refresh GET (assert via call counter)
     - `--worker` repeated → first-only on wire + `notice` in envelope
     - `--add-label foo --add-label foo` → dedupe, single label sent
     - human-mode renders the success line
     - label-only edit (no edit-body flags) → POST `/task/{id}` is **NOT called** (decision 15)
   - **dry-run**
     - `--dry-run`: lookup runs, no POST, envelope carries `dry_run: true` + `would[]` array
     - `--dry-run` + `--project`: no HTTP at all
   - **validation (every typed `ValidationError` arm — calibration §2)**
     - `<id>` not positive integer → exit 2
     - no flags set → `VALIDATION_ERROR` exit 2
     - `--worker` 0 → exit 2
     - bad `--due` → exit 2
     - bad `--priority` → exit 2
     - `--priority` AND `--clear-priority` → exit 2
     - `--name ""` → exit 2
     - `--add-label ""` → exit 2
     - `--remove-label ""` → exit 2
     - same label in both add & remove → exit 2
     - `--project` without `--dry-run` → exit 2
   - **api**
     - 404 from lookup GET → `FREELO_API_ERROR` exit 4, no further calls
     - 403 from edit POST → `FREELO_API_ERROR` exit 4
     - 422 from edit POST → `FREELO_API_ERROR` exit 4
     - 422 from add-labels POST after a successful remove-labels → exit 4 (label-only edit)
     - 429 from edit POST → `RATE_LIMITED` exit 6
     - schema parse failure on edit response → `FREELO_API_ERROR` exit 4
   - **network / interruption**
     - fetch throws on the edit POST → `NETWORK_ERROR` exit 5
   - **post-edit refresh failure**
     - all writes succeed, refresh GET 500s → success envelope with `task: null`, `notice`, exit 0 (decision 11)
   - **introspect**
     - `freelo --introspect` includes `tasks edit` with `output_schema: 'freelo.tasks.edit/v1'`, `destructive: false`
   - **calibration §4 try/catch arms**: each catch arm in the fan-out (lookup catch → exits early; edit-POST catch → throws verbatim; remove-labels catch; add-labels catch; refresh-GET catch → success-with-notice path) has a dedicated test row above
5. **`test/lib/tasks-edit-builder.test.ts`** — pure unit tests for `buildEditTaskBody` mapping (priority enum mapping, date format, undefined-field omission, `clearPriority` → null, all-empty input → `{}`).
6. **`test/api/tasks-edit.test.ts`** — pure unit tests for the api wrappers using a mocked `HttpClient`:
   - `editTask` posts to the right path with the right body
   - `addTaskLabels(taskId, [])` returns a synthetic empty result without calling the client
   - `addTaskLabels(taskId, ['a','b'])` posts with `{ labels: [{ name: 'a' }, { name: 'b' }] }`
   - `removeTaskLabels(taskId, [])` short-circuits like add
7. **`test/fixtures/tasks/detail-9012-edited.json`** — scrubbed `TaskDetail` post-edit response. Reuse the R08 fixture shape.
8. **`.changeset/<random-hash>.md`** — `freelo-cli: minor` — "Add `freelo tasks edit <id>` (R10). Partial update of name, due date, worker, priority, plus label add/remove diff. New envelope schema `freelo.tasks.edit/v1` (additive — public contract)."

#### Modified files

9. **`src/api/schemas/task.ts`** — append `EditTaskInput` / `EditTaskBody` types and `TasksEditDataSchema` / `TasksEditData`. No changes to existing R07 / R08 / R09 types.
10. **`src/commands/tasks.ts`** — register the new `edit` leaf (one new line + one import).
11. **`README.md`** — autogen Commands block — regenerated by `pnpm fix:readme` in the doc phase. **Do not hand-edit.**
12. **`docs/commands/tasks-edit.md`** — VitePress page: synopsis, flags, examples (single edit, label diff, dry-run), link to envelope schema.
13. **`docs/specs/0020-tasks-edit.md`** — this file.

#### No-touch (paranoia checklist)

- `src/config/**` — none.
- `src/api/client.ts` — none.
- `src/bin/freelo.ts` — none. Top-level handler already supports the new commands automatically.
- `src/lib/dry-run.ts` — none. We construct the multi-`would` envelope inline.
- `src/lib/batch.ts` — none. R10 has no batch mode.
- `src/errors/*` — no new error classes.

### 11. Dependencies

**No new runtime deps. No new dev deps.** `zod`, `commander`, `undici` (via `client.ts`) cover the surface.

### 12. Test strategy

- **Unit** layer: `src/api/tasks-edit.ts` (`buildEditTaskBody`, `addTaskLabels` / `removeTaskLabels` short-circuit). No I/O. Fast.
- **Integration** layer: `test/commands/tasks/edit.test.ts` boots the program end-to-end with MSW handlers. Asserts: stdout content (envelope shape), exit code, MSW-recorded request body and call order for the fan-out.
- **Coverage targets** (project-wide thresholds in `vitest.config.ts`): 80% lines / 90% on `src/api/` and `src/commands/`. Calibration §4: each new try/catch arm has a dedicated test row.
- **Snapshot use**: only for human-mode renderer; reviewed on update.
- **Fixture rule**: synthetic ids/names; reuse R08-style `TaskDetail` fixture.

### 13. Slicing

R10 is one slice (~700 LOC including tests). No need to subdivide.

### 14. Implementation order

1. Add `EditTaskInput` / `EditTaskBody` / `TasksEditDataSchema` types to `src/api/schemas/task.ts` (no logic — just shape).
2. Write `src/api/tasks-edit.ts`. Unit-test the body builder + label wrappers.
3. Write `src/ui/human/tasks-edit.ts`. Trivial; co-test inline.
4. Write `src/commands/tasks/edit.ts`. Integration-test against MSW.
5. Wire into `src/commands/tasks.ts`.
6. `pnpm typecheck && pnpm lint && pnpm test --coverage && pnpm build && pnpm check:readme` on a clean tree (calibration §3).
7. Hand off to test-writer for any gaps; then code-reviewer; then doc-writer (regenerates README block via `pnpm fix:readme`).
8. Add changeset, commit, push, open PR (Yellow → no auto-merge).

### 15. Risk callouts for the implementer

- **Calibration §1** — if interrupted, run **every** remaining phase before pushing. No shortcut.
- **Calibration §2** — every typed error class in §4 must have an exit-code-asserting test.
- **Calibration §3** — gates run on the **committed** tree post-commit, not the working tree.
- **Calibration §4** — try/catch arms in the fan-out each get a test row.
- **Calibration §6** — branch from a clean `main`, not from whatever HEAD happens to be.
- **Fan-out orchestration** — keep the order remove → add → edit → refresh strictly. Use `applied_changes` accumulators that only get populated **after** the matching call succeeds.
- **`would[]` array shape** — do **not** generalize `src/lib/dry-run.ts`'s `Would` type. Build the dry-run envelope inline. R11/R12 will tell us if/when we need a multi-call shared helper.

ARCHITECT run=2026-04-27-tasks-edit status=ok spec=docs/specs/0020-tasks-edit.md open_questions=0 new_deps=0
