# Spec 0053 — `freelo tasks create-from-template` (R39, Wave 6)

**Status:** Draft
**Owner:** orchestrator (run `2026-05-09-2300-tasks-create-from-template`)
**Roadmap:** R39 (closes Wave 6)
**Date:** 2026-05-09
**Depends on:** R09 (`tasks create`, established the `tasks` write-flag conventions); spec 0047 (R34, `tasklists create-from-template` — sibling endpoint, same flag family).

## 1. Problem

Freelo lets account admins curate **template tasks** inside template projects (`state=3`). The web UI exposes a "create task from template" action; the matching REST endpoint is `POST /task/create-from-template/{template_id}` (`docs/api/freelo-api.yaml:2187-2253`). Today, agents and shell scripts cannot:

1. Drop a canonical "Kickoff checklist" or "Bug report" task into a project from a template, repeatably, without clicking through the web UI.
2. Pin date-anchored boilerplate (preset_date_from) on a project boot so floating template due-dates land relative to a fresh kickoff date.
3. Copy a single template task into multiple projects programmatically, e.g. as part of a `gh actions` workflow that bootstraps a project from a manifest.

R34 (spec 0047) already exposed the **tasklist-level** template copy. R39 closes the gap with the **task-level** template copy. R39 is the final slice in Wave 6.

## 2. Proposal

### 2.1 CLI surface (additive — one new leaf under `tasks`)

```
freelo tasks create-from-template <template_id> --source-task <id>
                                                 [--target-project <id>]
                                                 [--target-tasklist <id>]
                                                 [--date-start <YYYY-MM-DD>]
                                                 [--worker <id>]...
                                                 [--dry-run]
```

Single-id v1 (one POST per invocation). Mirrors spec 0047 byte-for-byte, with the only differences:

- The required body field is **`task_id`** (the source task inside the template), not `tasklist_id`. The CLI flag is therefore **`--source-task <id>`** (not `--source-tasklist`).
- The path is `/task/create-from-template/{template_id}` (not `/tasklist/...`).
- The response is `{ id, name, tasklist: { id, name } }` — a task with its embedded tasklist reference, not a tasklist-with-tasks.

Non-destructive: creates a new task. No `--yes` required. `--dry-run` mandatory per agent-safe contract.

### 2.2 Mismatch with the roadmap text

The roadmap line reads:

> `freelo tasks create-from-template <template_id> --tasklist <id> [--name <str>]`

The OpenAPI documents:

- Required body: `task_id` (the **source** task; the roadmap omits this entirely — fatal omission).
- Optional `target_project_id`, `target_tasklist_id`, `preset_date_from`, `users_ids`.
- **No `name` field** in the request body or response indicates name override. The endpoint copies the template task verbatim.

Reconciliation (decision 1 below): the roadmap's `--tasklist` becomes `--target-tasklist`. The required `--source-task` is added (it was the roadmap's omission). The `--name` flag is **dropped** — we do not invent fields. Mirrors R34 / spec 0047, which performed an identical reconciliation against a similarly-loose roadmap line.

### 2.3 Wire mapping

```
POST /task/create-from-template/{template_id}
Content-Type: application/json
{
  "task_id": <source-task-int>,           // required
  "target_project_id": <int>,             // optional
  "target_tasklist_id": <int>,            // optional
  "preset_date_from": "YYYY-MM-DD",       // optional
  "users_ids": [<int>, <int>, ...]        // optional
}
```

Response (yaml :2238-2252):

```jsonc
{
  "id": <int>,                            // new task id
  "name": "<str>",                        // new task name (copied from template)
  "tasklist": {
    "id": <int>,
    "name": "<str>"
  }
}
```

### 2.4 Output schema — `freelo.tasks.create-from-template/v1`

| Field             | Type                                          | Always present | Notes                                                 |
| ----------------- | --------------------------------------------- | -------------- | ----------------------------------------------------- |
| `template_id`     | int                                           | yes            | Echo of `<template_id>` positional.                   |
| `task`            | `{ id, name, tasklist: { id, name } }` \| undef | live success    | Parsed `TaskFromTemplate` (zod-validated).            |
| `would`           | `{ method, path, body }` \| undef             | dry-run        | Body echoes the wire body verbatim.                   |

Exactly one of `task` / `would` is set per envelope. Mirrors spec 0047's data shape (`template_id` + `tasklist | would`) one-for-one — only the leaf field name and inner shape differ.

### 2.5 Validation rules

- `<template_id>` must be a positive integer; reject via `ValidationError` (exit 2). Hint: "Run `freelo projects list --scope templates` to find one."
- `--source-task <id>` is **required**. Missing → `ValidationError` (exit 2) with hint pointing at the body field name.
- `--source-task`, `--target-project`, `--target-tasklist`, `--worker` must each be a positive integer.
- `--date-start <YYYY-MM-DD>` must match `^\d{4}-\d{2}-\d{2}$` AND round-trip through `Date.parse` to catch `2026-02-30`-style nonsense (mirrors `parseDateStartFlag` in spec 0047).
- `--worker` is repeatable (Commander variadic accumulator pattern).

All validation lives in Commander parser callbacks AND a final `validateFlags(opts)` for "missing required" detection — same shape as spec 0047 §2.4.

### 2.6 Dry-run behavior

- No wire call.
- Envelope `dry_run: true`.
- `data.would.method = 'POST'`.
- `data.would.path = '/task/create-from-template/<template_id>'`.
- `data.would.body` echoes the assembled wire body — only the keys actually set are included (omit-undefined convention).

### 2.7 Hint mapping (4xx)

Mirrors spec 0047 §3.4:

- **400** mentioning `users_ids` → "Worker ids must be members of the template; check `freelo projects show <template>`."
- **400** mentioning `target_project_id` → "Target project id must reference a project the caller can access."
- **400** mentioning `target_tasklist_id` → "Target tasklist id must reference a tasklist inside the target project."
- **400** mentioning `task_id` → "Source task id must reference a task **inside** the template referenced by `<template_id>`."
- **400** generic → "Server-side validation rejected the request; review the message and adjust flags."
- **403** → "Account does not have permission to use this template."
- **404** → "Template not found. Run `freelo projects list --scope templates` to list valid ids."

### 2.8 Help text

```
Usage: freelo tasks create-from-template [options] <template_id>

Copy a single task from a project template into a target project.

Options:
  --source-task <id>           Source task id INSIDE the template (required, positive integer). Maps to body field `task_id`.
  --target-project <id>        Target project id (positive integer). Omit to land the copy in the same tasklist id as the template (rarely safe — see notes).
  --target-tasklist <id>       Target tasklist id (positive integer) inside the target project to land the copy in.
  --date-start <YYYY-MM-DD>    Anchor date for floating template due-dates. Maps to `preset_date_from`.
  --worker <id>                Template member user id to invite. Repeat for multiple workers.
  --dry-run                    Skip the POST; envelope echoes the body that would have been sent.
  -h, --help                   display help for command
```

### 2.9 Examples

```bash
# Minimal — copy the template's task #7 into a freshly-created project
$ freelo tasks create-from-template 50 --source-task 7
Created task #9100 (Kickoff checklist) from template #50 (in tasklist #200, "Onboarding").

# Land in an existing project + tasklist, with a date anchor:
$ freelo tasks create-from-template 50 --source-task 7 --target-project 100 --target-tasklist 200 --date-start 2026-09-01

# Dry-run (JSON):
$ freelo tasks create-from-template 50 --source-task 7 --dry-run --output json
{"schema":"freelo.tasks.create-from-template/v1","dry_run":true,"data":{"template_id":50,"would":{"method":"POST","path":"/task/create-from-template/50","body":{"task_id":7}}}}

# Live (JSON):
$ freelo tasks create-from-template 50 --source-task 7 --output json
{"schema":"freelo.tasks.create-from-template/v1","data":{"template_id":50,"task":{"id":9100,"name":"Kickoff checklist","tasklist":{"id":200,"name":"Onboarding"}}}}
```

## 3. Data model

### 3.1 New file: `src/api/schemas/task-create-from-template.ts`

```ts
import { z } from 'zod';

/**
 * `POST /task/create-from-template/{template_id}` response (yaml :2234-2252).
 *
 * Documented fields: `id`, `name`, `tasklist: { id, name }`. Apply the
 * project-wide `.passthrough()` + nullable.optional convention so future
 * Freelo additions are not silently dropped.
 */
const TasklistRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

export const TaskFromTemplateSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    tasklist: TasklistRefSchema,
  })
  .passthrough();

export type TaskFromTemplate = z.infer<typeof TaskFromTemplateSchema>;

/* ---- CLI input + wire body types ------------------------------------ */

export type CreateTaskFromTemplateInput = {
  templateId: number;
  /** Source task id INSIDE the template — body field `task_id`. */
  sourceTaskId: number;
  targetProjectId?: number;
  targetTasklistId?: number;
  /** ISO-8601 calendar date `YYYY-MM-DD`. Validated upstream. */
  dateStart?: string;
  workers?: readonly number[];
};

export type CreateTaskFromTemplateBody = {
  task_id: number;
  target_project_id?: number;
  target_tasklist_id?: number;
  preset_date_from?: string;
  users_ids?: number[];
};

/* ---- envelope `data` shape ----------------------------------------- */

export type TasksCreateFromTemplateData = {
  template_id: number;
  task?: TaskFromTemplate;
  would?: {
    method: 'POST';
    path: string;
    body: CreateTaskFromTemplateBody;
  };
};
```

### 3.2 New file: `src/api/tasks-create-from-template.ts`

Mirrors `src/api/tasklists-create-from-template.ts` one-for-one:

- `buildCreateTaskFromTemplateBody(input)` — pure mapper from camel-case input to snake-case body. Omits undefined fields. Empty `workers` array also omits `users_ids`.
- `createTaskFromTemplatePath(templateId)` — `/task/create-from-template/${templateId}`.
- `createTaskFromTemplate(client, opts)` — POST + zod validate; returns `{ task, raw }`.

### 3.3 New file: `src/commands/tasks/create-from-template.ts`

Mirrors `src/commands/tasklists/create-from-template.ts` (the closest precedent). Differences:

- `meta.outputSchema = 'freelo.tasks.create-from-template/v1'`.
- `--source-task` (not `--source-tasklist`).
- `validateFlags` checks `opts.sourceTask` not `opts.sourceTasklist`.
- `rewriteApiHint` adds the `task_id` and `target_tasklist_id` cases listed in §2.7.

### 3.4 New file: `src/ui/human/tasks-create-from-template.ts`

Two shapes:
- Live: `Created task #ID (NAME) from template #TID (in tasklist #TLID, "TLNAME").`
- Dry-run: `(dry-run) Would create task from template #TID (source task #SRC).` with sub-lines for non-default flags.

### 3.5 Modify: `src/commands/tasks.ts`

Add `import { registerCreateFromTemplate }` and call it from `register(...)`.

### 3.6 No changes to `src/api/schemas/task.ts`

The new `TaskFromTemplate` shape is narrow (3 fields). Keeping it in its own file avoids polluting the larger `task.ts` schema module — same choice spec 0047 made for `TasklistFromTemplate` (which is in `tasklist.ts` only because that file is the natural home for tasklist-shaped responses; tasks-create-from-template's response is a *task*, but a much thinner one than `TaskDetail`, so a sibling file is cleaner).

### 3.7 No changes to introspect-golden

The R39 introspect entry will be picked up by `pnpm fix:readme` regen in the doc phase. The golden snapshot test compares specific subtrees; verify by grep before commit.

## 4. Edge cases

| Edge case | Handling |
|---|---|
| `--source-task` missing | `ValidationError` exit 2 with hint pointing at body field `task_id`. |
| `<template_id>` non-positive (`abc`, `0`, `-1`) | `ValidationError` exit 2. |
| `--source-task 0` | `ValidationError` exit 2 (parsePositiveIntFlag rejects). |
| `--target-project` set, `--target-tasklist` omitted | Allowed (server decides whether to auto-create a tasklist; we don't enforce client-side combinations — mirrors spec 0047). |
| `--target-tasklist` set, `--target-project` omitted | Allowed (server may or may not accept; surfaced as 400 with hint mentioning `target_tasklist_id`). |
| `--worker` repeated | Commander accumulates into array; mapped to `users_ids`. |
| `--worker` empty (no flag) | `users_ids` omitted from body. |
| `--worker` duplicate ids | Sent verbatim (server dedupes if needed; we do not). |
| `--date-start 2026-13-40` | `ValidationError` exit 2 (round-trip mismatch). |
| `--date-start 2026/09/01` | `ValidationError` exit 2 (regex mismatch). |
| 400 with `task_id` mention | hintNext per §2.7. |
| 400 with `users_ids` mention | hintNext per §2.7. |
| 400 with `target_project_id` mention | hintNext per §2.7. |
| 400 with `target_tasklist_id` mention | hintNext per §2.7. |
| 400 generic | Generic server-side validation hint. |
| 401 | `AUTH_EXPIRED` exit 3 (top-level handler). |
| 403 | `FreeloApiError` exit 4 with permission hint. |
| 404 | `FreeloApiError` exit 4 with template-not-found hint. |
| 422 | `FreeloApiError` exit 4 (no special hint — surface server message). |
| 429 | `RATE_LIMITED` exit 6 retryable. |
| 5xx | `SERVER_ERROR` exit 4. |
| Network failure | `NETWORK_ERROR` exit 5. |
| `--dry-run` with all flags | `would.body` carries all five wire fields; envelope `dry_run: true`. |

## 5. Non-goals

- **No batch (`--ids` / `--stdin`).** Per-row `--source-task` would force NDJSON. Single-id v1; revisit in a hypothetical R39.5 if demand emerges.
- **No `--name` flag.** OpenAPI documents no rename-on-copy field. We do not invent fields (CLAUDE.md hard rule).
- **No client-side check that `--target-tasklist` belongs to `--target-project`.** Server enforces.
- **No envelope changes elsewhere.** No bumps to `freelo.tasks.create/v1` or `freelo.tasks.show/v1`.
- **No human-mode color highlighting.** Mirrors spec 0047 plain-text rendering.

## 6. Open questions

None. All decisions resolved in §7.

## 7. Decisions made autonomously

### Decision 1 — Reconcile the roadmap's `--tasklist [--name]` against the OpenAPI body

**Question:** Roadmap text says `--tasklist <id>` and `--name <str>`. OpenAPI documents body `{ task_id, target_project_id?, target_tasklist_id?, preset_date_from?, users_ids? }` and no `name` field. What's the CLI surface?

**Decision:**
- The required `--source-task <id>` flag is added (the OpenAPI's required `task_id` body field — completely missing from the roadmap line).
- The roadmap's `--tasklist` becomes `--target-tasklist <id>` (matches `target_tasklist_id` body field).
- A sibling `--target-project <id>` is added for parity with spec 0047.
- `--date-start <YYYY-MM-DD>` and `--worker <id>...` are added for parity with spec 0047 / spec 0044.
- The roadmap's `--name` is **dropped** entirely.

**Alternatives considered:**

- Take the roadmap line literally, send `{ tasklist_id, name }` → rejected; tasklist_id isn't a documented body field, name isn't either, and `task_id` is required. The literal call would 400 every time.
- Add `--name` as a CLI-only post-processing: copy first, then `tasks edit --name` → rejected; introduces a second wire call and a partial-failure mode the roadmap line never asked for. Outside scope.
- Rename `--source-task` to just `--task` → rejected; ambiguous with the positional `<template_id>` which is also "a template thing" but means the *project* template. `--source-task` mirrors spec 0047's `--source-tasklist` precedent letter-for-letter, which lowers cognitive load for users running both commands.

**Rationale:** Keep the roadmap as a *guide* — the OpenAPI is authoritative (CLAUDE.md "Never guess API behavior"). Spec 0047 / R34 made the identical reconciliation against the same roadmap-vs-OpenAPI gap; users picking up `tasks create-from-template` after `tasklists create-from-template` find an isomorphic surface.

### Decision 2 — Single endpoint, single command (no parent subcommand tree)

**Question:** Should `tasks create-from-template` be a parent like `tasks remind {set,clear}` or a flat leaf like `tasks create`?

**Decision:** Flat leaf. Single command directly under `tasks`.

**Alternatives considered:**

- Group with `tasks create` under a `tasks template` parent (`tasks template create <template_id>`) → rejected; only one operation here, parent without siblings is overkill. Spec 0047 also chose flat (`tasklists create-from-template`).
- Add it as a flag on `tasks create` (`--from-template <id> --source-task <id>`) → rejected; mode-flag overload on `tasks create` (R09) inflates that command's flag matrix; the wire endpoint is genuinely different.

**Rationale:** Mirror spec 0047's flat-leaf shape exactly. One-endpoint slices keep the surface minimum.

### Decision 3 — Reuse the spec-0047 hint-mapping pattern (`rewriteApiHint`) verbatim

**Question:** Where should the 4xx → `hintNext` mapping live?

**Decision:** Inline `rewriteApiHint(err)` helper in `src/commands/tasks/create-from-template.ts`, copy-shaped from `src/commands/tasklists/create-from-template.ts`. Same idiom, same cases, plus the new `task_id` and `target_tasklist_id` cases.

**Alternatives considered:**

- Extract a shared `rewriteCreateFromTemplateHint` into `src/lib/` → rejected; the two commands' hint sets overlap but are not identical (different field names). DRY-ing would either add a config-driven helper (over-engineered) or hide divergent strings (lossy). Two slim copies are easier to audit.
- Skip hint enrichment entirely, let `FreeloApiError` defaults handle it → rejected; the messages are the *most useful* part of error UX and they're easy to write.

**Rationale:** Same reasoning as spec 0047. Two files, two readable mappings, audit-friendly.

### Decision 4 — Path helper exposed (centralised so dry-run echoes the same string)

**Question:** Should `createTaskFromTemplatePath(templateId)` be a separate exported helper, or built inline?

**Decision:** Separate exported helper.

**Alternatives considered:**

- Build the path inline in both the wire wrapper and the dry-run code → rejected; two sources of truth, tiny but real risk of drift if the path ever changes.

**Rationale:** Mirrors the `createTasklistFromTemplatePath` precedent in spec 0047; same reasoning, same shape. Also lets the API-level unit test (`test/api/tasks-create-from-template.test.ts`) assert the path string in isolation.

### Decision 5 — `--worker` empty-array → omit `users_ids`

**Question:** When `--worker` is not passed at all (and Commander accumulator never fires), should the wire body include `users_ids: []` or omit the field?

**Decision:** Omit. Mirrors spec 0047 / R31 precedent.

**Alternatives considered:**

- Always include `users_ids: []` for shape stability → rejected; OpenAPI marks the field optional. Sending `[]` may or may not have side effects (e.g. wiping default invitees server-side); we do not test this, so we play safe and omit.

**Rationale:** Conservative omission is the established pattern. Empty array != absent in some Freelo endpoints (R31's experience).

## Plan

### Branch

`feat/tasks-create-from-template` (from `main`).

### Files to create

| Path                                                            | Intent                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `src/api/schemas/task-create-from-template.ts`                  | Zod response schema for `TaskFromTemplate` + envelope `data` types + CLI input + wire body types. |
| `src/api/tasks-create-from-template.ts`                         | `buildCreateTaskFromTemplateBody()` / `createTaskFromTemplatePath()` / `createTaskFromTemplate()` wire wrapper. |
| `src/commands/tasks/create-from-template.ts`                    | `tasks create-from-template <template_id>` leaf with all flags, validation, dry-run, hint mapping. |
| `src/ui/human/tasks-create-from-template.ts`                    | Human-mode renderer for live + dry-run.                                 |
| `test/api/tasks-create-from-template.test.ts`                   | **Mandatory per calibration §4** — covers `signal` / `requestId` opt-spread branches AND the body builder's omit-undefined branches. |
| `test/commands/tasks/create-from-template.test.ts`              | Integration tests with MSW: happy paths, dry-run, validation errors, API errors, introspect. |
| `test/fixtures/tasks/create-from-template-9100.json`            | Sample 200 response fixture.                                            |
| `docs/commands/tasks-create-from-template.md`                   | User-facing docs (synopsis, options table, examples, errors table).     |
| `.changeset/r39-tasks-create-from-template.md`                  | `freelo-cli: minor`.                                                    |

### Files to modify

| Path                              | Change                                                                  |
| --------------------------------- | ----------------------------------------------------------------------- |
| `src/commands/tasks.ts`           | Import + call `registerCreateFromTemplate(tasks, getConfig, env)`.      |
| `test/msw/handlers.ts`            | Add `tasksCreateFromTemplateHandlers` (12-handler set, copy-pasted from `tasklistsCreateFromTemplateHandlers`). |
| `README.md`                       | Autogen Commands block — `pnpm fix:readme` regenerates.                 |

### Files NOT modified

- `src/api/schemas/task.ts` — `TaskFromTemplate` is its own narrow shape; not added to the larger task schema module.
- `src/lib/` — no helper extraction (decision 3).
- `test/fixtures/introspect-golden.json` — verify by grep that the new leaf isn't in the golden's locked subset. If it is, regen via `pnpm fix:readme` (which regenerates the README's autogen block from a fresh introspect run).
- `src/api/client.ts`, `src/errors/handle.ts`, `src/config/**` — untouched (Yellow tier).

### New runtime dependencies

**None.**

### Test strategy

#### Unit tests — `test/api/tasks-create-from-template.test.ts` (mandatory per calibration §4)

Covers:

- `createTaskFromTemplatePath(50)` formats `/task/create-from-template/50`.
- `buildCreateTaskFromTemplateBody({ templateId, sourceTaskId })` → `{ task_id }` only.
- `buildCreateTaskFromTemplateBody({ ...all-fields })` → all five wire keys.
- `buildCreateTaskFromTemplateBody({ ...workers: [] })` → omits `users_ids`.
- `buildCreateTaskFromTemplateBody({ ...workers: [11, 22] })` → includes `users_ids: [11, 22]`.
- `createTaskFromTemplate(client, { templateId, body })` POSTs the body to the right path.
- **Branch-coverage hardening (the calibration §4 reason this file exists):**
  - `signal` is threaded through when defined.
  - `requestId` is threaded through when defined.
  - Both are absent from the request when not provided.

Pattern: fakeClient that records `request()` opts, no MSW. Copy `test/api/tasks-projects.test.ts`.

#### Integration tests — `test/commands/tasks/create-from-template.test.ts`

Use MSW (`tasksCreateFromTemplateHandlers`). Mirror `test/commands/tasklists/create-from-template.test.ts` structure:

**Happy paths:**

- Minimal: `<template_id>` + `--source-task` → JSON envelope, exit 0, schema `freelo.tasks.create-from-template/v1`, `data.task.id` populated.
- Every flag set: assert wire body via `okWhenBody` predicate — confirms body builder mapping is correct.
- Human mode: stdout contains `Created task #...` and `template #...`.

**Dry-run:**

- Minimal `--dry-run`: no HTTP, `dry_run: true`, `would.path = '/task/create-from-template/50'`, `would.body = { task_id: 7 }`, no `data.task`.
- `--dry-run` human mode: stdout contains `(dry-run)`, `template #50`, `source task #7`, sub-line for `+ target-project: 100`, `+ workers: 42`.

**Validation errors (every one asserts `exitCode: 2` per calibration §2):**

- Non-numeric `<template_id>` → `VALIDATION_ERROR`.
- Missing `--source-task` → `VALIDATION_ERROR` (message matches `/--source-task is required/`).
- `--source-task 0` → `VALIDATION_ERROR`.
- `--target-project abc` → `VALIDATION_ERROR`.
- `--target-tasklist 0` → `VALIDATION_ERROR`.
- Bad `--date-start` format (`2026/09/01`) → `VALIDATION_ERROR`.
- Nonsense calendar (`2026-02-30`) → `VALIDATION_ERROR`.
- `--worker abc` → `VALIDATION_ERROR`.

**API errors (every one asserts the documented exit code per calibration §2):**

- 400 with `task_id` reference → exit 4, hint mentions "Source task id".
- 400 with `users_ids` reference → exit 4, hint mentions "members of the template".
- 400 with `target_project_id` reference → exit 4, hint mentions "Target project id".
- 400 with `target_tasklist_id` reference → exit 4, hint mentions "Target tasklist id".
- 400 generic → exit 4, hint mentions "Server-side validation".
- 401 → exit 3 `AUTH_EXPIRED`.
- 403 → exit 4 with permission hint.
- 404 → exit 4 with template-not-found hint.
- 429 → exit 6 `RATE_LIMITED` retryable.
- 5xx → exit 4 `SERVER_ERROR`.
- Network failure → exit 5 `NETWORK_ERROR`.

**Introspection:**

- `freelo --introspect` lists `tasks create-from-template` with `output_schema: 'freelo.tasks.create-from-template/v1'` and `destructive: false`.

Total ~30 tests, ~700 lines (mirrors spec 0047's test file size).

#### Coverage callouts

- **Calibration §1:** test phase runs to completion before commit.
- **Calibration §2:** every error-class path asserts `exitCode` (`ValidationError` 2, `FreeloApiError` 4 / 3 for AUTH_EXPIRED, `RateLimitedError` 6, `NetworkError` 5).
- **Calibration §3:** five-gate before push (`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`).
- **Calibration §4 (R38 PR #96 finding):** `test/api/tasks-create-from-template.test.ts` covers both `signal`-defined and `requestId`-defined opt-spread branches in the new `src/api/tasks-create-from-template.ts`. Without this file, the new wrapper drops `src/api/**` branch coverage below the 80% threshold (same root cause as PR #96).
- **Calibration §7:** no new TTY-prompt code path here — `create-from-template` is non-destructive, no `confirmDestructive`.

#### Five-gate before push

`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme` must all pass on the **committed** tree before `git push -u`.

### Rollout

Single landable slice. Squash on PR merge:

`feat(commands): tasks create-from-template (R39)`

### Closes Wave 6

After this PR merges, all of R35–R39 are shipped and the roadmap entry can mark Wave 6 complete in a follow-up docs slice.
