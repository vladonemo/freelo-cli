# freelo-cli

## 0.16.0

### Minor Changes

- 11e4888: R12.5 — `freelo tasks move --stdin` batch input. Move many tasks in one
  invocation, each row pointing at its own destination tasklist (and optionally
  project). Closes the gap between `tasks move` and the rest of the write
  surface that already supports batch.

  NDJSON in / NDJSON out, one envelope per row. Per-line shape:
  `{"id": <task_id>, "to_tasklist": <tasklist_id>, "to_project"?: <project_id>}`.

  - **Continue-on-error semantics** — a bad line does not abort the run; the
    exit code at end-of-run is the max of per-line exit codes (matches R09 /
    R11 batch precedent).
  - **Per-row idempotency** — a row whose `to_tasklist` matches the task's
    current tasklist returns `already_in_target_tasklist: true` (no POST).
  - **Per-row `to_project` assertion** — same post-move sanity check as
    single-mode `--to-project`, but per-row. Mismatch emits a `notice` on
    that line's envelope; exit stays 0 for that row.
  - **`--stdin` is mutex** with positional `<id>`, `--to-tasklist`, and
    `--to-project`. Combining them fails fast with `VALIDATION_ERROR`.

  **Schema delta (additive minor):** `freelo.tasks.move/v1` envelopes carry an
  optional `data.line_index` field in batch mode. Single-mode envelopes are
  **byte-identical** to R12 v1 (no `line_index`).

  No new dependencies. No changes to `src/lib/batch.ts` (existing primitives
  are already schema-generic).

- 6d28ecf: R12 — `freelo tasks move <id>` to relocate tasks across tasklists and
  (optionally) projects. New envelope schema: `freelo.tasks.move/v1`.

  The destination tasklist (`--to-tasklist <id>`) is required; the destination
  project is server-derived from it (cross-project moves work transparently).
  The optional `--to-project <id>` flag is a post-move sanity check — on
  mismatch the envelope carries a `notice` (exit stays 0).

  Idempotent: a task that is already in the target tasklist is skipped (no
  POST, no refresh GET) and the envelope returns
  `already_in_target_tasklist: true`. Reuses the shared idempotency helper
  shipped in R11.

  Single-id only in v1 — no `--ids` / `--stdin` batch input. Compose via
  `xargs` for batch workflows.

- 5e478b5: R13 — `freelo tasks delete <id>` to soft-delete tasks. **The first
  destructive command in the CLI** — gates every wire call behind a
  confirmation step.

  Three input shapes (mutex):

  - Positional: `freelo tasks delete 9012 9013 9014 --yes`
  - `--ids`: `freelo tasks delete --ids "9012,9013,9014" --yes`
  - `--stdin` NDJSON: `echo '{"id": 9012}' | freelo tasks delete --stdin --yes`

  Confirmation policy (new shared helper `src/lib/confirm.ts`, reused by every
  later destructive command):

  - `--yes` or `--dry-run` → unconditional bypass.
  - TTY without `--yes` → prompt once for the whole run (`Delete N task(s)?`,
    default no). Declined → `CONFIRMATION_REQUIRED` (exit 2).
  - **Non-TTY without `--yes` → fail closed** with `CONFIRMATION_REQUIRED`
    (exit 2) before any wire call. Agents and CI must opt in explicitly.

  Idempotent: a `DELETE /task/{id}` that returns 404 (the task was already
  deleted) is re-classified as a success envelope with
  `already_in_target_state: true`. The CLI does **not** pre-fetch via GET —
  the DELETE response is authoritative and `previous_state` is therefore
  `null` in v1.

  New envelope: `freelo.tasks.delete/v1`. New schema fields:

  - `task_id`, `previous_state` (always `null` in v1), `current_state`
    (always `'deleted'`), `already_in_target_state`, optional `would`
    (dry-run), optional `line_index` (`--stdin` batch).

  Batch (`--stdin`) supports continue-on-error semantics with max-of exit
  codes per R09/R11/R12.5 precedent.

  `@inquirer/prompts` import stays lazy (TTY-prompt branch only) — the
  agent cold path never pulls it in.

  `destructive: true` in the introspect entry — the first command to set
  this. Future destructive commands (`tasks archive`, `subtasks delete`,
  `comments delete`, `files delete`, `projects delete`, `tasklists delete`)
  will all reuse `confirmDestructive` byte-for-byte.

  No new dependencies.

- 4cb21ff: R14 — `freelo subtasks` (smart list). Two new commands under a brand-new
  top-level `subtasks` subcommand:

  - `freelo subtasks list --task <id> [--page N | --all]` — paginated read of
    one parent task's subtasks (taskchecks). Reuses R08's `SubtaskSchema` and
    the `fetchAllPages` infrastructure from R03.
  - `freelo subtasks add --task <id> --name <str> [--worker <id>] [--due YYYY-MM-DD]
[--dry-run] [--stdin]` — creates a subtask. Additive (not destructive); no
    confirmation gate.

  **Smart-vs-simple fallback (the headline UX feature).** Freelo's API auto-
  falls-back from a **smart taskcheck** (full task with worker / due date /
  tracking users) to a **simple taskcheck** (a checkbox row with only a name)
  when the parent's tasklist can't host smart ones (OpenAPI :2425). The CLI
  surfaces the resulting form in the response envelope:

  - `data.storage_form: 'smart' | 'simple'` — inferred from the response shape
    (any of `worker`, `due_date`, `state`, `tasklist`, `project` populated →
    `smart`; otherwise `simple`).
  - `data.input_ignored: ['worker', 'due']` — only present on the `simple`
    path AND only for fields the user actually set that the server discarded.

  The `freelo subtasks add --help` text explains this behavior (roadmap-
  mandated UX requirement).

  **Two new envelope schemas (additive surface):**

  - `freelo.subtasks.list/v1` — `{ task_id, subtasks: Subtask[] }` plus
    envelope-level `paging` and `rate_limit`.
  - `freelo.subtasks.add/v1` — `{ task_id, subtask?, storage_form?,
input_ignored?, would?, line_index? }`. `subtask` and `storage_form` are
    always present in live envelopes and absent in `--dry-run`.

  `--stdin` NDJSON batch mode for `subtasks add` mirrors R09 / R12.5 (per-line
  schema, continue-on-error, max-of exit codes, lazy client construction).
  Per-line `task` is rejected — `--task` is shared per-batch on the command
  line.

  No new dependencies. The wire wrapper for the existing `GET /task/{id}/subtasks`
  endpoint is reused as-is from R08 (`src/api/tasks.ts`); only the new POST
  wrapper, the storage-form inference helper, and CLI envelope-data schemas
  land in this slice.

- 48c27a3: R15 — `freelo tasks description` (get/set). Two new commands under a new
  nested `tasks description` subcommand:

  - `freelo tasks description get <id>` — print the rich-text description (the
    canonical body of a task). Reuses R08's `getTaskDescription` wire wrapper
    and `TaskCommentSchema`.
  - `freelo tasks description set <id> (--from-file <path> | --editor | -)
[--dry-run]` — replace the description (upsert; first call creates,
    subsequent call overwrites entirely with no history per the Freelo API
    contract). Content comes from one of three input sources, each mediated by
    the new shared `src/lib/input.ts` helper.

  **First introduction of the `src/lib/input.ts` helper** (per
  `docs/roadmap.md:686`). Generic and reusable: `readInput({ kind: 'file' |
'stdin' | 'editor', ... }) → { content, source }`. Future write commands
  (R17 `comments add`, R22 `reports edit`, etc.) will reuse the same input
  shape. Editor resolution: `$VISUAL` → `$EDITOR` → platform default
  (`notepad.exe` on win32, `vi` elsewhere); `--editor` is TTY-only and errors
  out cleanly in agent / CI environments.

  **Empty content is rejected at the command layer.** A successful `set` with
  empty content would silently clear the description — almost always a
  destructive accident. The command surfaces a `VALIDATION_ERROR` (exit 2)
  and points at `freelo tasks edit <id> --description ''` (R10) for the
  explicit clearing path.

  **Two new envelope schemas (additive surface):**

  - `freelo.tasks.description.get/v1` — `{ task_id, description: Comment }`.
    `description.id` / `.content` may be `null` on tasks with no description
    set (the API returns 200 with empty fields per OpenAPI :2015).
  - `freelo.tasks.description.set/v1` — `{ task_id, description?, source?,
byte_length, would? }`. `description` and `source` are always present in
    live envelopes and absent in `--dry-run`. `byte_length` is always
    present so agents can verify content size against their source.

  `set` is **`destructive: false`** — same precedent as R10 (`tasks edit
--description`). `--dry-run` is the safety net for upsert-class writes.

  No new runtime dependencies. The new wire wrapper (`setTaskDescription` in
  `src/api/tasks-description.ts`) reuses the existing `TaskCommentSchema`
  from R08; only the POST wrapper, the input helper, and CLI envelope-data
  schemas land in this slice. No `--files` / multipart support in v1 (R25
  multipart helper).

- 6613b23: R16 — `freelo comments list`. The first command in a brand-new top-level
  `comments` subcommand:

  - `freelo comments list [--project <id> ...] [--type <all|task|document|file|link>]
[--order-by <date_add|date_edited_at>] [--order <asc|desc>]
[--page N | --all] [--since YYYY-MM-DD]` — paginated read of the global
    comment feed, ACL-filtered to whatever the caller can see. Maps to
    `GET /all-comments`.

  **One new envelope schema (additive surface):**

  - `freelo.comments.list/v1` — `{ applied_filters, comments: CommentFull[] }`
    plus envelope-level `paging` and `rate_limit`. `applied_filters` echoes
    only the keys the user explicitly set; `comments[]` includes all the
    documented `CommentFull` shape variants (task, document, file, link
    comments, discriminated by which entity-link block is non-null).

  **Client-side `--since` post-filter.** Freelo's `/all-comments` endpoint
  accepts no time-window query parameter, so `--since` is implemented
  client-side: under `--all` with the default `desc` order, iteration
  short-circuits the moment a fetched page's last item predates the cutoff.
  Under `--order asc`, the short-circuit is disabled and iteration continues
  to exhaustion (post-filtering each page individually). `--since` is mutex
  with `--page N` to avoid silent under-counting.

  **Out of scope for v1 (deferred):**

  - No `--task` flag. The original R16 roadmap entry mentioned
    `GET /task/{task_id}/comments`, but that endpoint is not in
    `docs/api/freelo-api.yaml` (only the POST counterpart is documented).
    Task-scoped listing is deferred until Freelo confirms the GET exists
    undocumented or adds it. Tracked as Open Question #1 in spec 0027.
  - No `--per-page`, `--cursor`, or `--fields` flags in v1 — all
    future-additive.

  No new dependencies. Reuses the standard pagination infrastructure
  (`fetchAllPages`, `pagingFromNormalized`, `PartialPagesError`) from R03 /
  R14, the `buildQuery` query-encoder from R07, and the `UserBasic` schema
  from R03.

## 0.15.0

### Minor Changes

- fd9f66e: feat(commands): R11 — `freelo tasks finish` and `freelo tasks reopen`

  Two new write commands for closing and re-opening tasks, plus the shared
  idempotency helper that R12+ reuse.

  - `freelo tasks finish <id>... [--ids a,b,c] [--stdin] [--dry-run]` —
    closes one or more tasks. Idempotent: tasks already finished are skipped
    via a pre-check `GET /task/{id}` before any POST.
  - `freelo tasks reopen <id>... [--ids a,b,c] [--stdin] [--dry-run]` —
    reopens finished tasks (wire endpoint `POST /task/{id}/activate`). Same
    surface, idempotent on already-active.
  - New shared helper `src/lib/idempotency.ts` (`checkIdempotency`) — pure
    predicate consumed by R11 and reserved for R12 (move), R13 (delete), and
    R14+ (archive, mark-read/unread, attach/detach-label).
  - New schemas (additive, no breaking changes): `freelo.tasks.finish/v1`
    and `freelo.tasks.reopen/v1`. Both share the same `data` payload shape
    (`task_id`, `previous_state`, `current_state`, `already_in_target_state`,
    `verb`, optional `would` for `--dry-run`, optional `line_index` for
    `--stdin`).
  - Three input sources (mutually exclusive): variadic `<id>...` positional,
    `--ids <comma-or-space list>`, or NDJSON via `--stdin`. Empty input is
    silent success. Single-id mode bubbles errors to stderr; multi-id mode
    emits per-id error envelopes interleaved with the success stream and
    exits with the highest exit code observed.
  - Pre-check refuses to act on `state: 'deleted'` tasks (`VALIDATION_ERROR`,
    exit 2) — the activate endpoint isn't symmetric with the project
    endpoint and won't undelete (per OpenAPI :1802).

  Schema bumps:

  - ADD `freelo.tasks.finish/v1`
  - ADD `freelo.tasks.reopen/v1`

  No existing envelope shape changed.

## 0.14.0

### Minor Changes

- 3a173cd: R10 — `freelo tasks edit <id>`: partial update of a task's name, due date,
  worker, priority, plus name-mode label add/remove diff.

  The second write slice. Reuses R09's shared infra (`src/lib/dry-run.ts`,
  write-flow conventions) verbatim — no new shared helpers introduced.

  New files:

  - `src/commands/tasks/edit.ts` — Commander leaf, validation,
    fan-out orchestration (remove → add → edit → refresh).
  - `src/api/tasks-edit.ts` — `buildEditTaskBody` (pure body-builder),
    `editTask`, `addTaskLabels`, `removeTaskLabels` (label diff endpoints
    short-circuit when names is empty).
  - `src/ui/human/tasks-edit.ts` — single-task human renderer.
  - `docs/specs/0020-tasks-edit.md` — design + plan + 15 decision summaries.
  - `docs/commands/tasks-edit.md` — user docs.

  New envelope schema **`freelo.tasks.edit/v1`** (public contract — additive):

  ```json
  {
    "schema": "freelo.tasks.edit/v1",
    "data": {
      "task": { /* TaskDetail | null */ },
      "tasklist_id": 314,
      "project_id": 42,
      "applied_changes": {
        "edit": { "name": "...", "priority_enum": "h" },
        "labels_added": ["urgent"],
        "labels_removed": ["wontfix"]
      },
      "would": [ /* present in --dry-run; up to 3 entries */ ]
    },
    "rate_limit": { ... },
    "request_id": "...",
    "dry_run": true
  }
  ```

  CLI surface:

  ```
  freelo tasks edit <id>
                    [--name <str>] [--worker <id>]...
                    [--due YYYY-MM-DD]
                    [--priority low|normal|high | --clear-priority]
                    [--add-label <name>]... [--remove-label <name>]...
                    [--dry-run]
  ```

  Notes:

  - Edit verb is **POST `/task/{id}`** per OpenAPI :1690-1714 (the spec's
    documented partial-update verb).
  - Label changes go through the explicit `/task-labels/add-to-task/{id}`
    and `/remove-from-task/{id}` endpoints, NOT the edit-body `labels[]`
    field. This keeps `applied_changes.labels_added` / `labels_removed`
    honest and the surface symmetrical with R09.
  - Wire order: remove-labels → add-labels → edit-body → refresh GET. Fan-out
    is **not transactional**; on partial failure the CLI surfaces the error
    verbatim and `applied_changes` reflects only what the wire confirmed.
  - If every write succeeds but the post-edit refresh GET fails, the
    envelope is success (exit 0) with `data.task: null` and a `notice`
    explaining the freshness gap.
  - `--description` / `--description-file` deferred to R15
    (`tasks description set`); `<id>...` and `--stdin` deferred until a
    real batch use case appears.

  See `docs/specs/0020-tasks-edit.md` for the full design.

## 0.13.0

### Minor Changes

- 514f644: Add `freelo tasks create` (R09) — the first write-class subcommand. Creates a
  task in a tasklist with optional workers, labels, due date, priority, and
  description. Project id is derived from `--tasklist` automatically.

  Ships the shared write infrastructure reused by every later write command:

  - `src/lib/dry-run.ts` — `--dry-run` envelope builder (sets `dry_run: true`,
    splices `data.would = { method, path, body }`).
  - `src/lib/batch.ts` — NDJSON streamer (`iterateLines`, `parseNdjsonLine`,
    `ExitCodeAccumulator`). One envelope per input line on stdout, streamed as
    each line completes; the process exit code is the numerically highest
    per-line exit.
  - `src/api/tasks-create.ts` — `buildCreateTaskBody` (pure body-builder) and
    `createTask` (POST wrapper).

  New envelope schema **`freelo.tasks.create/v1`** (public contract):

  ```json
  {
    "schema": "freelo.tasks.create/v1",
    "data": {
      "task": { /* TaskCreated */ },
      "tasklist_id": 314,
      "project_id": 42,
      "line_index": 0,        // batch mode only
      "would": { ... }        // --dry-run only
    },
    "rate_limit": { ... },
    "request_id": "...",
    "dry_run": true            // --dry-run only
  }
  ```

  CLI surface:

  ```
  freelo tasks create --tasklist <id> --name <str>
                      [--worker <id>]... [--due YYYY-MM-DD]
                      [--priority low|normal|high] [--label <name>]...
                      [--description <text> | --description-file <path>]
                      [--dry-run]
  freelo tasks create --tasklist <id> --stdin [--dry-run] < tasks.ndjson
  ```

  Notes:

  - `--editor` and `--description-file` for batch mode are deferred to R15.
  - Repeatable `--worker` accepts repeats but only the first id is sent (with
    an envelope `notice` listing discarded ids); R10 will offer the proper
    "change assignment" verb.
  - See `docs/specs/0019-tasks-create.md` and the nine accompanying decisions
    under `docs/decisions/2026-04-27-tasks-create-*.md`.

## 0.12.0

### Minor Changes

- 3fda583: feat(commands): add `freelo tasks show <id>` with description, subtasks, and projects side-cars (R08)

  Adds the natural follow-up to R07 — view one task's full detail, with optional
  side-cars for the long-form description, the (paginated) subtask list, and the
  multi-project membership block. Prerequisite for the Wave 2 write commands
  (R09–R15) which need the full task shape to round-trip diffs.

  Public envelope: `freelo.tasks.show/v1`.

  ```
  freelo tasks show <id> [--with description,subtasks,projects]
  ```

  Side-car semantics — every key follows the same "absent vs. present" convention:

  - `data.task` — always present. From `GET /task/{id}`.
  - `data.description` — present only when `--with description` is set; from
    `GET /task/{id}/description`. Tolerates empty descriptions (id/content null).
  - `data.subtasks` — present only when `--with subtasks` is set; from
    `GET /task/{id}/subtasks?p=N` merged across pages via `fetchAllPages`. Empty
    list renders as `[]` (key present, empty array).
  - `data.projects` — present only when `--with projects` is set. **Projected
    from the embedded `multi_project_task` block** in the already-fetched
    `TaskDetail` (decision 1) — no second HTTP call. May legitimately be `null`
    when the task is single-project (key present, value null — distinct from
    absent).

  Why projection instead of a separate GET: the roadmap line for R08 named
  `GET /task/{task_id}/projects` but that endpoint is **not documented** in
  `docs/api/freelo-api.yaml` (only `POST` and `DELETE` exist on that path). The
  documented `TaskDetail.multi_project_task` block answers the same agent
  question. Forward-compatible: if Freelo ever publishes the GET, R08.x can
  swap implementations without changing the envelope shape under
  `data.projects`.

  Also ships:

  - `src/api/schemas/task.ts` — `TaskDetailSchema`, `SubtaskSchema`,
    `TaskCommentSchema`, `MultiProjectBlockSchema`, `TasksShowDataSchema`. Built
    from scratch (not extended from `TaskFull`/`TaskSummary`) because the
    field overlap is partial.
  - `src/api/tasks.ts` — `getTaskDetail`, `getTaskDescription`, `getTaskSubtasks`
    HTTP wrappers, with `signal` / `requestId` plumbing matching R07.
  - `src/ui/human/tasks-show.ts` — TTY renderer for the header block, the
    description block, the subtasks table, and the multi-project membership
    block (or `(single-project task)` note when null).
  - 27 new command-level tests + 14 new wrapper tests covering happy paths,
    validation (no HTTP), every typed error class with exit-code assertion per
    Calibration §1-2, and the `PartialPagesError` mid-stream unwrap path for
    subtasks (Calibration §4 — every new try/catch arm has at least one test).

## 0.11.0

### Minor Changes

- d124392: feat(commands): add `freelo tasks list` across `/all-tasks` and per-tasklist active routes (R07)

  Adds the workhorse read for tasks across the projects you can see.
  The CLI dispatches to one of two Freelo endpoints based on the flag combo:

  - `GET /project/{p}/tasklist/{t}/tasks` when scoped to exactly one
    project + tasklist with no other filter.
  - `GET /all-tasks` for everything else, with bracketed-array filter
    composition (`projects_ids[]`, `with_labels[]`, `due_date_range[*]`).

  Public envelope: `freelo.tasks.list/v1` with `data.endpoint`,
  `data.entity_shape`, and `data.applied_filters` discriminators so
  agents can pin against route-specific entity shapes without guessing.

  Also ships:

  - `src/lib/query.ts` — typed param-map → URL query encoder (handles
    repeating arrays, bracketed objects, scalars, default-false omission).
    Reusable foundation for future write commands.
  - `src/api/tasks.ts` — typed wrappers for both endpoints.
  - `src/api/schemas/task.ts` — Zod schemas for `TaskSummary`,
    `TaskFull`, and `TaskFinished` (the third declared but not wired in
    v1; `tasklist-finished-tasks` route deferred to R07.5).
  - 47 new tests covering happy paths, filter encoding, validation,
    field projection, every typed error class (with exit-code
    assertion per Calibration §1-2), and `--all` mid-stream behaviour.

  Forward-compat: the envelope's `endpoint` discriminator already
  accepts `'tasklist-finished-tasks'` and `entity_shape` accepts
  `'task_finished'`, so the R07.5 finished-tasks slice is purely
  additive (no `/v2` envelope bump).

## 0.10.0

### Minor Changes

- 80803af: Add `freelo tasklists show <id> [--with assignable-workers]` for fetching a
  single tasklist's detail with an optional pool of users you can assign tasks
  to. The `--with assignable-workers` side-car returns a bare `UserBasic[]`
  array (one round-trip — the endpoint is not paginated) and is the natural
  companion to `freelo tasklists list`.

  Introduces the public envelope schema **`freelo.tasklists.show/v1`** with
  `data.tasklist` always present and `data.assignable_workers` present only
  when the side-car was requested (absent — not `null` — otherwise; agents
  detect via `'assignable_workers' in env.data`).

  Backed by `GET /tasklist/{id}` (always) and
  `GET /project/{project_id}/tasklist/{id}/assignable-workers` (under
  `--with assignable-workers`). The user supplies only the tasklist id; the
  command reads `project_id` from the first response to construct the
  side-car URL.

## 0.9.0

### Minor Changes

- ece5235: Add `freelo tasklists show <id> [--with assignable-workers]` for fetching a
  single tasklist's detail with an optional pool of users you can assign tasks
  to. The `--with assignable-workers` side-car returns a bare `UserBasic[]`
  array (one round-trip — the endpoint is not paginated) and is the natural
  companion to `freelo tasklists list`.

  Introduces the public envelope schema **`freelo.tasklists.show/v1`** with
  `data.tasklist` always present and `data.assignable_workers` present only
  when the side-car was requested (absent — not `null` — otherwise; agents
  detect via `'assignable_workers' in env.data`).

  Backed by `GET /tasklist/{id}` (always) and
  `GET /project/{project_id}/tasklist/{id}/assignable-workers` (under
  `--with assignable-workers`). The user supplies only the tasklist id; the
  command reads `project_id` from the first response to construct the
  side-car URL.

## 0.8.1

### Patch Changes

- f79ebfb: R05.5 hardening — three real-world bugs reproduced on `freelo-cli@0.7.0` and
  `0.8.0` against a live Freelo account on 2026-04-26:

  - **Schema:** `UserBasic.fullname` is now `.nullable().optional()`. Live
    Freelo can return user objects without a fullname (deleted users,
    externally-invited pending users, system actors). The strict schema
    rejected these payloads. Same defensive sweep extends to
    `WorkerWithHourRate.fullname` and `HourRate.{amount,currency,is_fixed}`.
  - **Schema:** `Currency.amount` (used by `ProjectFull.real_cost`,
    `ProjectFull.budget`, `TasklistFull.budget`, `TasklistFull.real_cost`)
    now accepts both string and number. Live Freelo returns `amount` as a
    number on multiple endpoints; the prior `z.string()` rejected every
    affected response. The schema normalizes numeric input to a canonical
    string so the public envelope contract (`Currency.amount: string`)
    stays stable.
  - **Errors:** Round-2 fix for the Windows libuv `UV_HANDLE_CLOSING`
    assertion on exit. The 0.5.1 `dispatcher.close()` fix was incomplete —
    on Windows it still tripped on any zod-validation failure exit. We now
    use `dispatcher.destroy()` (forceful) bounded by a 250 ms timeout race,
    and defer `process.exit` via `setImmediate` so libuv has one
    event-loop tick to finalize close callbacks before the synchronous exit.

  No envelope schema bumps. Inbound parser is widened in all three cases;
  output envelope is unchanged.

## 0.8.0

### Minor Changes

- 53a7875: Add `freelo tasklists list [--project <id>]` for browsing tasklists, with the
  same `--page` / `--all` / `--cursor` / `--fields` / `--output` semantics as
  `freelo projects list`.

  Introduces the public envelope schema **`freelo.tasklists.list/v1`** with a
  `data.scope: 'project' | 'all'` discriminator and `data.project_id` echo. Both
  modes back onto the documented `GET /all-tasklists` endpoint
  (`?projects_ids[]=<id>` for the per-project filter).

## 0.7.0

### Minor Changes

- 354555f: Add `freelo projects show <id> [--with workers]`, the second slice of Wave 1
  (R04). Single-resource fetch with optional side-cars; introduces the `--with`
  flag plumbing every later show-style command will inherit.

  New public envelope schema: `freelo.projects.show/v1`. The `data.project`
  payload is the rich `ProjectDetail` shape (extends `ProjectFull` with
  embedded `tasklists[*].tasks` and `workers[*].hour_rate`). When `--with
workers` is set, `data.workers` carries the canonical paginated worker list
  (`UserBasic[]`, no `hour_rate`); absent otherwise.

  `<id>` validates as a positive integer before any HTTP call. Unknown
  `--with` values exit 2 with a `hint_next` listing valid values. 404 and
  403 from `/project/{id}` map to `FREELO_API_ERROR` (exit 4) with friendlier
  hints distinguishing "not found / no access" from "no permission".

  **`--with labels` not shipped.** The original roadmap promised it, but
  Freelo's documented API has no per-project labels read endpoint; only
  workspace-scoped labels are exposed. Tracked as a non-goal in spec 0013;
  will land when Freelo exposes the endpoint or we audit a real account for
  an undocumented one.

## 0.6.0

### Minor Changes

- 6065f80: Drop the `keytar` dependency. `tokens.json` (mode `0600`, in the platform-appropriate
  config directory) is now the sole persistent token store. Env-var auth
  (`FREELO_API_KEY` + `FREELO_EMAIL`) remains the recommended path and is unchanged.

  This eliminates the `prebuild-install@7.1.3` deprecation warning on `npm install`
  and removes the only native binding from the dep tree, making Windows/Linux installs
  binary-free.

  **Behavior change for existing keychain users.** If you previously stored a token in
  the OS keychain (Mac Keychain Access, Windows Credential Manager, libsecret), you'll
  need to re-run `freelo auth login` on first use after upgrade — the token will land
  in `tokens.json`. The old keychain entry persists harmlessly until you remove it
  manually.

  The `FREELO_NO_KEYCHAIN` environment variable is no longer recognized (it was a
  keychain-skip toggle and there is no longer a keychain). Setting it has no effect.

### Patch Changes

- 6065f80: Fix `freelo projects list` against real Freelo accounts on Windows.

  - Schema parser now tolerates `null` on every optional field of project
    response schemas (Freelo returns `client: null`, `tasklists: null`, etc.,
    alongside absent fields). Inbound parser only — envelope schema
    `freelo.projects.list/v1` is unchanged. Repo-wide policy added: every
    optional API response field is also nullable.
  - Top-level error handler now drains undici's global dispatcher before
    `process.exit`, preventing a libuv `UV_HANDLE_CLOSING` assertion
    (`src\\win\\async.c:76`) on Windows when sockets are still being torn down.

## 0.5.1

### Patch Changes

- a24f462: Fix `freelo projects list` against real Freelo accounts on Windows.

  - Schema parser now tolerates `null` on every optional field of project
    response schemas (Freelo returns `client: null`, `tasklists: null`, etc.,
    alongside absent fields). Inbound parser only — envelope schema
    `freelo.projects.list/v1` is unchanged. Repo-wide policy added: every
    optional API response field is also nullable.
  - Top-level error handler now drains undici's global dispatcher before
    `process.exit`, preventing a libuv `UV_HANDLE_CLOSING` assertion
    (`src\\win\\async.c:76`) on Windows when sockets are still being torn down.

## 0.5.0

### Minor Changes

- f122dde: Add `freelo projects list` for paginated project listing across five scopes.

  This is the first command that talks to the Freelo API beyond `auth whoami`.
  Selectable via `--scope owned|invited|archived|templates|all` (default `owned`),
  with `--page N` / `--all` / `--cursor <n>` (mutually exclusive) for pagination
  and `--fields a,b,c` for top-level field projection.

  Introduces the `freelo.projects.list/v1` envelope. The `data` payload carries
  an `entity_shape` discriminator (`with_tasklists` for the four sparser scopes,
  `full` for `--scope all`), the resolved `scope`, and the `projects[]` array.
  The envelope's `paging` field is always present — the `/projects` endpoint is
  synthesized as a single page so agents do not need to special-case scopes.

  Adds shared infrastructure used by every future list command: `src/api/pagination.ts`
  (`NormalizedPage`, `fetchAllPages`, `projectFields`) and `src/ui/table.ts` (lazy
  `cli-table3` renderer for human mode).

  Schema commitment: `freelo.projects.list/v1` is a public contract. Field
  removal, rename, or retype is breaking.

## 0.4.0

### Minor Changes

- f3f8cd0: Include the `help` subcommand in `freelo --introspect` (and in `freelo help --output json`) `data.commands`. Previously omitted by design; now enumerated symmetrically with every other public command, with `output_schema: "freelo.introspect/v1"` (self-referential — `freelo help --output json` emits exactly that envelope). Additive content change to the `freelo.introspect/v1` envelope; no shape change. README autogen Commands block regenerated to include the new row. (Spec 0008.)

## 0.3.2

### Patch Changes

- df4463a: Backfill `README.md` to reflect the commands shipped in 0.3.1 (auth login/logout/whoami,
  config list/get/set/unset/profiles/use/resolve, plus `--introspect` and `help --output json`),
  replacing the stale "early scaffold — only `freelo --version` exists" status line. The
  Commands section is now generated from a live `freelo --introspect` envelope and verified
  in CI by `pnpm check:readme` so it can never drift again.

## 0.3.1

### Patch Changes

- 0ff0392: Fix `freelo help <parent-group> --output json` so it returns the introspect
  envelope scoped to the parent's subtree instead of failing with
  `VALIDATION_ERROR: Unknown command '<parent>'` exit 2.

  Previously the filter did an exact-match against `commands[].name`, but the
  introspect data only stores leaves — so any non-leaf path (`help config`,
  `help auth`) errored out. The filter now matches both leaves and parent-group
  prefixes, returning every leaf under the requested subtree. Existing leaf and
  unknown-path behavior is unchanged. The `freelo.introspect/v1` envelope schema
  is unchanged (no schema bump).

## 0.3.0

### Minor Changes

- e5cf9d1: Add `freelo --introspect` and `freelo help --output json` (R02.5).

  Agents and CI scripts can now enumerate the entire CLI surface programmatically — every command, flag, argument, output schema, and `destructive` boolean — as a single `freelo.introspect/v1` envelope. The introspector walks the live Commander tree, so future commands light up automatically with no hand-maintained list.

  - `freelo --introspect` — single JSON envelope to stdout, one line, exit 0. Loads no human-UX dependencies.
  - `freelo help --output json` — agent-friendly alias for the full envelope.
  - `freelo help <command...> --output json` — scoped to a single leaf.
  - Every leaf command file now exports `meta: CommandMeta` (`{ outputSchema, destructive }`), type-checked at compile time.

  New envelope schema: `freelo.introspect/v1`. No existing schemas changed.

## 0.2.0

### Minor Changes

- 4f308dd: feat(config): add full `freelo config` command tree (R02)

  New subcommands: `config list`, `config get`, `config set`, `config unset`,
  `config profiles`, `config use`, `config resolve`.

  **Store schema bump v1 → v2** (additive migration, read-on-load, no write-back):

  - Adds a `defaults` map for output/color/verbose overrides.
  - Old v1 stores are silently migrated in memory; the file is only rewritten on
    the next mutating command.

  **RC file support** (`.freelorc`, `.freelorc.json`, `.freelorc.yaml`):

  - Slotted between environment variables and the conf store.
  - Unknown keys and inline API tokens are rejected with exit 2 (`corrupt-rc`).

  **`ProfileSource` extended** with the new `'rc'` literal.

  **New envelope schemas (public contract)**:

  - `freelo.config.list/v1`
  - `freelo.config.get/v1`
  - `freelo.config.set/v1`
  - `freelo.config.unset/v1`
  - `freelo.config.profiles/v1`
  - `freelo.config.use/v1`
  - `freelo.config.resolve/v1`

  **New runtime dependency**: `cosmiconfig@^9.0.0` for project-level rc file discovery (JSON + YAML).

  **`ProfileSource` extended** with the new `'generated'` literal for runtime-minted values (e.g. auto-generated request IDs).

## 0.1.0

### Minor Changes

- b59956e: R01: Auth commands + agent-first substrate

  Adds `freelo auth login`, `freelo auth logout`, and `freelo auth whoami`
  together with the cross-cutting infrastructure every later slice inherits.

  **New envelope schemas (public contract):**

  - `freelo.auth.login/v1` — result of `freelo auth login`
  - `freelo.auth.logout/v1` — result of `freelo auth logout`
  - `freelo.auth.whoami/v1` — result of `freelo auth whoami`
  - `freelo.error/v1` — structured error envelope on stderr for all failures

  **Global flags** now available on every subcommand:
  `--output auto|human|json|ndjson`, `--color auto|never|always`,
  `--profile <name>`, `-v`/`-vv` verbosity, `--request-id <uuid>`,
  `-y`/`--yes`.

  **Env-first auth** — `FREELO_API_KEY` + `FREELO_EMAIL` bypass the keychain
  entirely. `FREELO_NO_KEYCHAIN=1` forces the fallback file store.

  **Agent-first output** — `--output auto` defaults to `json` when stdout is
  not a TTY; human renderers and spinners are loaded lazily and never executed
  on agent paths.

  **Security:** bumped `undici` from 7.4.0 to >=7.24.0 to resolve 3 High
  advisories (HTTP request smuggling GHSA-2mjp-6q6p-2qxm, CRLF injection via
  upgrade GHSA-4992-7rv2-5pvq, and WebSocket length overflow GHSA-f269-vfmq-vjvj)
  plus 3 Moderate and 1 Low.

- 019c9e8: Initial scaffold of the Freelo CLI: TypeScript + ESM project skeleton, build via tsup, ESLint 9 flat config, Prettier, Vitest with v8 coverage and MSW wired in, Husky + lint-staged + commitlint enforcing Conventional Commits, Changesets for release management, and GitHub Actions CI matrix on Node 20/22 across Linux/macOS/Windows. Ships a single `freelo` binary that responds to `freelo --version` (and `-V`) by printing the package version.
