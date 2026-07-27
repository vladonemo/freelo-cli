# freelo-cli

## 0.20.1

### Patch Changes

- c994248: fix(api): accept comment file attachments that carry no `id` (#105)

  `freelo tasks edit <id>` failed with `VALIDATION_ERROR` (exit 4) for any task
  whose first comment has a file attachment:

  ```
  Unexpected response shape from GET /task/<id>:
  [{ code: "invalid_type", expected: "number", received: "undefined",
     path: ["comments", 0, "files", 0, "id"], message: "Required" }]
  ```

  The failing call was the **lookup `GET /task/{id}`** that `tasks edit` issues
  before writing — so the edit aborted before any mutation. Issue #105 reported
  this as a `POST` failure; that was a reconstruction of an uncaptured error
  string, and all six hypotheses it ranked were wrong. A real captured
  `POST /task/{id}` body validates fine.

  The actual cause: the internal file schema behind `TaskDetail.comments[].files[]`
  and `GET /task/{id}/description` declared `id` and `uuid` as required, but
  Freelo's embedded file DTO carries no numeric `id`. Both fields are now
  `.nullable().optional()`, matching the two sibling file-ref schemas
  (`FileFullRefSchema`, `NoteFileRefSchema`) and this module's own stated
  convention. Fields still validate when present.

  Freelo's OpenAPI contract agrees: `FileBasic` declares no required properties
  at all, so this removes a constraint the CLI invented rather than widening one
  the API asked for.

  Fixes `tasks show`, `tasks edit`, `tasks move`, and `tasks description get`
  on affected tasks.

  **Envelope:** no field removed, renamed, or retyped — `data.task` output is
  byte-identical for bodies that already validated, so no `/v2` bump. One caveat
  for consumers: `data.task.comments[].files[].id` was previously guaranteed to
  be a number _or_ the command hard-failed. It may now be absent. That guarantee
  was counterfeit — it was the bug.

## 0.20.0

### Minor Changes

- 7cd5e25: feat(commands): `custom-fields types` and `custom-fields list` (R40)

  Two new read-only subcommands under a new top-level `custom-fields` parent
  — the first slice of Wave 7 (custom fields, notes, pinned items):

  - `freelo custom-fields types` — list the server-curated catalog of
    custom-field type definitions (`text`, `number`, `enum`). Wire:
    `GET /custom-field/get-types`.
  - `freelo custom-fields list --project <id>` — list all custom-field
    definitions configured on a project, plus an `is_commander` boolean
    signalling whether the caller can call the R41+ mutation endpoints
    on that project. Wire: `GET /custom-field/find-by-project/{project_id}`.

  Both leaves are pure GETs with no `--dry-run`, no `--yes`, no destructive
  behaviour.

  Schemas added (additive):

  - `freelo.custom-fields.types/v1` — `{ types: { uuid, name }[] }`.
  - `freelo.custom-fields.list/v1` — `{ project_id, custom_fields[], is_commander }`.

  R41 (create / rename / delete / restore), R42 (value set / clear), and R43
  (enum CRUD) build on this parent in later slices.

- d6feccb: feat(commands): `custom-fields create` / `rename` / `delete` / `restore` (R41)

  Four new subcommands under the existing `custom-fields` parent — the second
  slice of Wave 7 (custom fields, notes, pinned items):

  - `freelo custom-fields create --project <id> --name <str> --type <type-uuid> [--uuid <uuid>] [--dry-run]`
    — define a custom field on a project. Single-shot, non-destructive.
    Wire: `POST /custom-field/create/{project_id}`.
  - `freelo custom-fields rename <uuid> --name <str> [--dry-run]` — rename a
    custom-field definition. Single-shot, non-destructive. Wire:
    `POST /custom-field/rename/{uuid}` (verb is **POST**, not PATCH — the
    OpenAPI spec is authoritative; same precedent as `labels rename`).
  - `freelo custom-fields delete <uuid>... [--ids <list>] [--stdin] [--yes] [--dry-run]`
    — soft-delete one or more custom-field definitions. **Destructive** —
    requires `--yes` (non-TTY) or interactive confirmation (TTY). Idempotent:
    404 → `already_in_target_state: true`, exit 0. Batch via positional /
    `--ids` / `--stdin` (NDJSON). Wire: `DELETE /custom-field/delete/{uuid}`.
  - `freelo custom-fields restore <uuid>... [--ids <list>] [--stdin] [--dry-run]`
    — restore one or more soft-deleted custom-field definitions.
    Non-destructive (no `--yes`). Idempotent: 404 → `already_in_target_state:
true`, exit 0 (the OpenAPI conflates "doesn't exist" with "was never
    soft-deleted"; both map to the active end-state). Live success carries
    the full `custom_field` server response. Wire: `POST /custom-field/restore/{uuid}`.

  Schemas added (additive):

  - `freelo.custom-fields.create/v1` — `{ project_id, custom_field?, would? }`.
  - `freelo.custom-fields.rename/v1` — `{ uuid, applied_changes: { name? }, would? }`.
  - `freelo.custom-fields.delete/v1` — `{ uuid, previous_state: null, current_state: 'deleted', already_in_target_state, would?, line_index? }`.
  - `freelo.custom-fields.restore/v1` — `{ uuid, previous_state: null, current_state: 'active', already_in_target_state, custom_field?, would?, line_index? }`.

  Reuses the established R13 destructive-op primitives (`confirmDestructive`,
  `iterateLines` / `parseNdjsonLine` / `ExitCodeAccumulator`, `dryRunEnvelope`,
  `Would`) and the R40 wire wrappers / zod schemas / parent registrar.

  R42 (value set / clear) and R43 (enum CRUD) round out Wave 7 in later slices.

- 13a6dc1: feat(commands): `custom-fields value set` and `custom-fields value clear` (R42)

  Two new subcommands under the `custom-fields` parent — the first writeable
  surface for custom fields (Wave 7, second slice):

  - `freelo custom-fields value set --task <id> --field <uuid> (--value <str>|--enum <uuid>)`
    — upsert a custom-field value on a task. Dispatches between the scalar
    endpoint (`POST /custom-field/add-or-edit-value`, snake_case body) and the
    enum endpoint (`POST /custom-field/add-or-edit-enum-value`, camelCase body)
    based on the `--value` / `--enum` mutex.
  - `freelo custom-fields value clear --task <id> --field <uuid>` — clear a
    value. Destructive; gates on `--yes` (non-TTY) or interactive prompt (TTY).
    Performs a read-then-delete (`GET /task/{task_id}` → resolve `value_uuid`
    → `DELETE /custom-field/delete-value/{uuid}`) because the DELETE endpoint
    identifies values by their value-uuid, not by field-uuid.

  Idempotency for `value clear` (two arms):

  1. Read-back finds no value for the field → `already_in_target_state: true`,
     no DELETE issued.
  2. Read-back finds a value but DELETE returns 404 (race condition) →
     `already_in_target_state: true`.

  Both new commands support `--dry-run`. Batch input is via `--stdin` NDJSON
  only (each job carries multiple fields, so a positional list doesn't fit).

  Schemas added (additive):

  - `freelo.custom-fields.value-set/v1` — `{ task_id, field_uuid, kind: 'scalar'|'enum',
value_uuid, value, previous_value_uuid, would?, line_index? }`.
  - `freelo.custom-fields.value-clear/v1` — `{ task_id, field_uuid, value_uuid,
previous_state: 'set'|'absent', current_state: 'absent', already_in_target_state,
would?, line_index? }`.

  R41 (field create / rename / delete / restore) and R43 (enum CRUD) build on
  the same parent in later slices.

- 0e3d2ff: feat(commands): `custom-fields enum list / add / rename / delete` (R43)

  Four new subcommands under a new `custom-fields enum` sub-parent — the third
  slice of Wave 7 (enum-option management on enum-typed custom fields):

  - `freelo custom-fields enum list --field <uuid>` — list the enum options
    defined on an enum field. Wire: `GET /custom-field-enum/get-for-custom-field/{uuid}`.
  - `freelo custom-fields enum add --field <uuid> --value <str>` — add a new
    enum option. Wire: `POST /custom-field-enum/create/{uuid}`.
  - `freelo custom-fields enum rename <enum_uuid> --value <str>` — rename
    (relabel) an existing enum option; uuid preserved so existing task values
    keep resolving. Wire: `PATCH /custom-field-enum/change/{uuid}`.
  - `freelo custom-fields enum delete <enum_uuid>... [--force] [--yes]` —
    delete one or more enum options. Default refuses if the option is in use
    (returns 400 with a `--force` hint). `--force` switches to
    `DELETE /custom-field-enum/force-delete/{uuid}` which cascades, clearing
    referencing task values. Both endpoints are 404-idempotent (single-arm,
    mirrors `custom-fields delete` from R41). Supports batch via positional /
    `--ids` / `--stdin` NDJSON.

  Schemas added (additive):

  - `freelo.custom-fields.enum-list/v1` — `{ field_uuid, options: { uuid, value }[] }`.
  - `freelo.custom-fields.enum-add/v1` — `{ field_uuid, option: { uuid, value } }`.
  - `freelo.custom-fields.enum-rename/v1` — `{ enum_uuid, applied_changes: { value } }`.
  - `freelo.custom-fields.enum-delete/v1` — `{ enum_uuid, force, previous_state, current_state, already_in_target_state, line_index?, would? }`.

  Closes the third gap in Wave 7. R44 (`notes` + `pins`) is the final slice.

- 0933556: feat(commands): `notes` and `pins` (R44)

  Seven new subcommands across two new top-level command parents — the **final
  slice of Wave 7**, closing the wave with R44 merged.

  **`notes`** (project-level rich-text notes; share storage with documents internally):

  - `freelo notes create --project <id> --name <str> [--content ...|--from-file ...|--editor|-]`
    — create a project note. Content is optional (name-only notes are valid).
    Wire: `POST /project/{id}/note`.
  - `freelo notes show <id>` — fetch a single note (full detail, including
    embedded files/comments). Wire: `GET /note/{id}`.
  - `freelo notes edit <id> [--name ...] [--content ...|--from-file ...|--editor|-]`
    — overwrite name and/or content. Wire: `POST /note/{id}` (verb is POST per
    Freelo's OpenAPI; the roadmap PATCH was incorrect). When only `--content` is
    supplied, the CLI issues a transparent `GET /note/{id}` first to fetch the
    current name, because the wire body requires `name`.
  - `freelo notes delete <id>... [--ids ...|--stdin] [--yes] [--dry-run]` —
    soft-delete (destructive, batch). Wire: `DELETE /note/{id}`. **API quirk:**
    the DELETE response is the deleted Note's last state, not a SuccessResponse
    — the CLI surfaces this on `data.note` for audit-log use cases. 404-idempotent
    (single-arm).

  **`pins`** (project-level pinned items — links, tasks, documents, files):

  - `freelo pins list --project <id>` — list all pinned items, ACL-filtered
    server-side. Wire: `GET /project/{id}/pinned-items`.
  - `freelo pins add --project <id> --link <url> [--title ...]` — pin a URL.
    Wire field is `link` (not `url`), matching Freelo exactly. Server-side
    dispatcher: internal-resource URLs are fetch-or-create idempotent;
    external URLs always create a new pin.
  - `freelo pins remove <id>... [--ids ...|--stdin] [--yes] [--dry-run]` —
    remove pins (destructive, batch). Wire: `DELETE /pinned-item/{id}`.
    Underlying targets unaffected. 404-idempotent (single-arm).

  **Schemas added (additive — no existing schema changed):**

  - `freelo.notes.create/v1` — `{ project_id, note?, byte_length, source }`.
  - `freelo.notes.show/v1` — `{ note }`.
  - `freelo.notes.edit/v1` — `{ note_id, note?, applied_changes, source, byte_length }`.
  - `freelo.notes.delete/v1` — `{ note_id, note?, previous_state, current_state, already_in_target_state, line_index?, would? }`.
  - `freelo.pins.list/v1` — `{ project_id, pins[] }`.
  - `freelo.pins.add/v1` — `{ project_id, pin?, applied_link, applied_title?, would? }`.
  - `freelo.pins.remove/v1` — `{ pin_id, previous_state, current_state, already_in_target_state, line_index?, would? }`.

  **Notable scope decision:** `notes list` is **NOT** included — Freelo's
  documented OpenAPI has no project-scoped notes/documents listing endpoint.
  The gap is documented in spec 0058 §5; reserved for R45+ when an endpoint
  becomes available.

  Closes Wave 7 (custom fields + notes + pinned items).

## 0.19.0

### Minor Changes

- f43aa1b: Add `freelo tasks remind set` / `tasks remind clear` (R35).

  **Surface (additive — no breaking change):**

  ```
  freelo tasks remind set <id> --at <ISO> [--dry-run]
  freelo tasks remind clear <id> [--yes] [--dry-run]
  ```

  Each leaf wraps one Freelo endpoint:

  - `set` → `POST /task/{task_id}/reminder` with `{ remind_at: <UTC ISO> }`.
    Upsert semantics on the server (a second call overwrites the prior
    `remind_at`). Required flag.
  - `clear` → `DELETE /task/{task_id}/reminder`. Destructive; reuses the
    shared `confirmDestructive` gate from R13 — `--yes` bypasses, TTY without
    `--yes` prompts, non-TTY without `--yes` fails closed with
    `CONFIRMATION_REQUIRED` (exit 2).

  **`--at` validation:**

  - Permissive RFC 3339 / ISO 8601 acceptance (full UTC, tz-offsets, bare
    date, milliseconds). Canonicalized to second-precision UTC
    `YYYY-MM-DDTHH:MM:SSZ` before sending.
  - Rejects timestamps more than 60 s in the past (clock-skew clamp) — a
    past reminder is meaningless. The 60 s tolerance accommodates NTP drift
    and integration-replay handoff lag.
  - Sibling helper to R19.5's `parseIsoTimestampFlag` (which clamps the
    _future_ direction for backdating); both share the
    `ISO_TIMESTAMP_FUTURE_SKEW_MS` constant.

  **Output schemas (new):**

  - `freelo.tasks.remind.set/v1` — `{ task_id, task_name?, remind_at, would? }`.
  - `freelo.tasks.remind.clear/v1` — `{ task_id, already_in_target_state, would? }`.

  **Idempotency note for `clear`:** the server returns 200 even when no
  reminder existed (yaml :2125), so the wire cannot distinguish "had a
  reminder" from "had no reminder". Live 200 always emits
  `already_in_target_state: false`; a defensive 404 (forward-compat path) is
  re-classified as `already_in_target_state: true`.

  Single-id v1; batch (`--ids` / `--stdin`) deferred to a future R35.5 if
  demand emerges. Spec: `docs/specs/0049-r35-tasks-remind.md`.

- bbe77a6: feat(commands): tasks share / unshare — public share link for a task (R36)

  Two new subcommands:

  - `freelo tasks share <id>` — get (or create) a public, unauthenticated URL
    that lets anyone holding the link view the task read-only. Idempotent on
    the wire — first call mints the URL, subsequent calls return the same
    one. Output schema: `freelo.tasks.share/v1`.
  - `freelo tasks unshare <id>` — revoke the public link. Destructive; reuses
    the shared confirmation gate (`--yes` / TTY prompt; non-TTY without
    `--yes` fails closed with `CONFIRMATION_REQUIRED` exit 2). Idempotent:
    a defensive 404 (no-link-existed) is re-classified as
    `already_in_target_state: true`. Output schema:
    `freelo.tasks.unshare/v1`.

  Both leaves support `--dry-run`. Single-id v1 (no batch).

  New envelope schemas: `freelo.tasks.share/v1`, `freelo.tasks.unshare/v1`.

  Wire endpoints: `GET /public-link/task/{id}`, `DELETE /public-link/task/{id}`
  (per the OpenAPI spec — note the GET verb on share, which Freelo treats as
  a "GET that creates").

- cfcbd5c: Add `freelo tasks estimate set` / `tasks estimate clear` (R37).

  **Surface (additive — no breaking change):**

  ```
  freelo tasks estimate set   <id> --minutes <n> [--user <id>] [--dry-run]
  freelo tasks estimate clear <id>                [--user <id>] [--yes] [--dry-run]
  ```

  Each leaf wraps one of four Freelo endpoints, with the `--user <id>` flag
  acting as a path toggle between team-wide and per-user estimates:

  - `set` (without `--user`) →
    `POST /task/{task_id}/total-time-estimate` with `{ minutes: <n> }`.
  - `set --user <id>` →
    `POST /task/{task_id}/users-time-estimates/{user_id}` with `{ minutes: <n> }`.
  - `clear` (without `--user`) →
    `DELETE /task/{task_id}/total-time-estimate`.
  - `clear --user <id>` →
    `DELETE /task/{task_id}/users-time-estimates/{user_id}`.

  `set` is non-destructive — the server upserts on every call (yaml :2267,
  :2324). `--minutes` is required; positive integer (>= 1).

  `clear` is destructive; reuses the shared `confirmDestructive` gate from
  R13 / R35 / R36 — `--yes` bypasses, TTY without `--yes` prompts, non-TTY
  without `--yes` fails closed with `CONFIRMATION_REQUIRED` (exit 2). The
  prompt copy is scope-aware: `"Clear total time estimate on task #<id>?"`
  or `"Clear time estimate for user #<user> on task #<id>?"`.

  Per-user estimates are independent of the total: setting a per-user value
  does NOT update the total (yaml :2325). The CLI does not aggregate.

  **Output schemas (new):**

  - `freelo.tasks.estimate.set/v1` —
    `{ task_id, user_id (null|int), minutes, scope ('total'|'user'), would? }`.
  - `freelo.tasks.estimate.clear/v1` —
    `{ task_id, user_id (null|int), scope, already_in_target_state, would? }`.

  The `scope` field is a discriminator derived from `--user` presence so
  agents can branch without parsing the wire path.

  **Idempotency note for `clear`:** the server returns 200 even when no
  estimate existed (yaml :2299, :2362), so the wire cannot distinguish "had
  an estimate" from "had no estimate". Live 200 always emits
  `already_in_target_state: false`; a defensive 404 (forward-compat path)
  is re-classified as `already_in_target_state: true`. Mirrors R13 / R35 /
  R36 precedent.

  Single-id v1; batch (`--ids` / `--stdin`) deferred to a future R37.5 if
  demand emerges. Spec: `docs/specs/0051-r37-tasks-estimate.md`.

- e3a914a: Add `freelo tasks project add` / `remove` and `freelo tasks relations` / `find-relations` (R38).

  **Surface (additive — no breaking change):**

  ```
  freelo tasks project add    <id> --tasklist <id>... [--dry-run]
  freelo tasks project remove <id> --project  <id>   [--yes] [--dry-run]
  freelo tasks relations      <id>
  freelo tasks find-relations --task <id>...
  ```

  Four new leaves across two distinct surfaces:

  **Multi-project membership (UVVP — `tasks project add` / `remove`).** Promotes a
  single-project task into a cross-team task by creating a child task in another
  project, or rolls back an accidental cross-team assignment.

  - `add` → `POST /task/{id}/projects` with body `{ tasklist_id: <int> }`. Note:
    the body takes `tasklist_id`, **not** `project_id` — Freelo derives the project
    from the tasklist server-side. The CLI flag is named `--tasklist <id>` to match
    the wire reality (the roadmap text said `--project <id>...`, but the OpenAPI
    is authoritative; mirrors R36 share-verb precedent). `--tasklist` is
    repeatable; each value fans out to one POST. Duplicates are silently
    deduplicated. Non-destructive.
  - `remove` → `DELETE /task/{id}/projects/{project_id}`. Single-id only;
    destructive, reuses the shared `confirmDestructive` gate from R13 / R35 / R36
    / R37. **Removing the task's _primary_ project requires `freelo tasks delete <id>`
    instead** — Freelo returns `403 AclException` otherwise; the CLI surfaces this
    with a `hintNext`.

  **Task relations (`tasks relations` / `find-relations`).** Read-only typed
  cross-references between tasks (`blocked_by`, `blocks`, `related_to`,
  `duplicate_of`).

  - `relations <id>` → `GET /task/{id}/relations`. Single task; empty array on no
    relations is a valid 200.
  - `find-relations --task <id>...` → `POST /tasks/relations` with body
    `{ task_ids: [<int>, ...] }`. Bulk; 1–100 ids per call (CLI enforces the cap
    client-side as `ValidationError`). **Inaccessible tasks are silently omitted**
    from the response by Freelo — agents diff `data.task_ids` against
    `data.tasks[*].task_id` to detect this.

  > Despite the verb being `POST`, **`find-relations` is read-only** — the
  > OpenAPI documents no endpoint to create or delete relations. Use the Freelo
  > web UI to manage relations; use the CLI to query them.

  **Output schemas (new):**

  - `freelo.tasks.project.add/v1` —
    `{ task_id, tasklist_ids: int[], assignments?: { tasklist_id, child_task_id, child_task_uuid }[], would? }`.
  - `freelo.tasks.project.remove/v1` —
    `{ task_id, project_id, already_in_target_state, would? }`.
  - `freelo.tasks.relations/v1` —
    `{ task_id, relations: TaskRelation[] }` (read-only — no `would`).
  - `freelo.tasks.find-relations/v1` —
    `{ task_ids: int[], tasks: { task_id, relations }[] }` (read-only — no `would`).

  **Idempotency note for `project remove`:** A 404 response is **the documented
  "task not in this project" signal** (yaml :1985) — re-classified as
  `already_in_target_state: true`. A 403 response is **not** re-classified — it
  is the documented "primary-project removal attempt" signal (yaml :1984) and
  surfaces as `FreeloApiError` exit 4 with a `hintNext` pointing at `tasks delete`.

  **`add` does not surface `already_in_target_state`** — wire ambiguity (mirrors
  R37 `set` / R23 `labels attach` precedent). On a mid-fan-out failure, the
  envelope's `assignments` array is truncated to the entries completed before the
  failure.

  **`relations` and `find-relations` do not support `--dry-run`** — read-only
  operations have no side effect to skip; a dry-run envelope on a pure GET is a
  no-op surprise.

  Single-id v1 across all four leaves (with repeatable `--tasklist` / `--task`
  flags where applicable). Batch via `--ids` / `--stdin` is not supported in this
  slice. Spec: `docs/specs/0052-r38-tasks-multiproject-relations.md`.

- 61a4449: Add `freelo tasks create-from-template` (R39 — closes Wave 6).

  **Surface (additive — no breaking change):**

  ```
  freelo tasks create-from-template <template_id> --source-task <id>
                                                   [--target-project <id>]
                                                   [--target-tasklist <id>]
                                                   [--date-start <YYYY-MM-DD>]
                                                   [--worker <id>]...
                                                   [--dry-run]
  ```

  Copies a single task out of a project template into a target tasklist (or a
  freshly-created project, when `--target-project` is omitted). Sibling of
  `freelo tasklists create-from-template` (R34) — same flag family, different
  endpoint.

  **Endpoint:** `POST /task/create-from-template/{template_id}` (`docs/api/freelo-api.yaml:2187-2253`).

  **Wire body:**

  - `task_id` (required) — id of the **source task INSIDE the template**, mapped from the CLI flag `--source-task`. The roadmap's `--tasklist <id>` flag was a typo; the OpenAPI requires `task_id`. Mirrors the R34 reconciliation against a similarly-loose roadmap line.
  - `target_project_id`, `target_tasklist_id`, `preset_date_from`, `users_ids` are optional, mirror the spec-0047 flag mapping (`--target-project`, `--target-tasklist`, `--date-start`, `--worker`).

  **The roadmap's `--name` flag was dropped** — the OpenAPI documents no rename-on-copy field; we do not invent fields (`CLAUDE.md` hard rule).

  **Output schema (new):** `freelo.tasks.create-from-template/v1` —
  `{ template_id, task?: { id, name, tasklist: { id, name } }, would? }`.
  Exactly one of `task` / `would` is set per envelope.

  **Hint mapping for 4xx:**

  - 400 mentioning `task_id` → "Source task id must reference a task INSIDE the template..."
  - 400 mentioning `users_ids` → "Worker ids must be members of the template..."
  - 400 mentioning `target_project_id` / `target_tasklist_id` → respective hints.
  - 403 → permission hint.
  - 404 → "Template not found. Run `freelo projects list --scope templates`..."

  Non-destructive (creates a task — no destructive effects). `--dry-run`
  supported per the agent-safe-writes contract; no `--yes` required.

  Single-id v1. Batch (`--ids` / `--stdin`) is not supported. Spec:
  `docs/specs/0053-r39-tasks-create-from-template.md`.

  This slice **closes Wave 6**: R35–R39 are now all shipped.

## 0.18.0

### Minor Changes

- 200dcf4: Add `--palette <name>` flag on three label-write commands (R24.5).

  **Surface (additive — no breaking change):**

  ```
  freelo labels rename       <id> [--name <str>] [--palette <name> | --hex <#RRGGBB>] ...
  freelo labels attach       --project <id> --name <str>... [--palette <name> | --hex <#RRGGBB>] ...
  freelo task-labels create  --name <str>... [--palette <name> | --hex <#RRGGBB>] ...
  ```

  Nine palette names map to Freelo's canonical hues, locked at build time:

  | Name   | Hex       |
  | ------ | --------- |
  | gray   | `#77787A` |
  | aqua   | `#15ACC0` |
  | blue   | `#367FEE` |
  | green  | `#10AA40` |
  | pink   | `#CA3E99` |
  | purple | `#9235E4` |
  | red    | `#E9483A` |
  | orange | `#F2830B` |
  | yellow | `#E3B51E` |

  **Behavior:**

  - `--palette` and `--hex` are mutually exclusive (`ValidationError`, exit 2; `hintNext` lists the nine names).
  - `--palette` is case-insensitive; unknown names fail closed with `ValidationError`.
  - `--hex` validation unchanged (`^#[0-9a-fA-F]{6}$`).
  - Both flags resolve to the same wire field `color: "#RRGGBB"`. Dry-run envelope's `would.body.color` carries the resolved hex regardless of which flag was used.
  - Each command's `--help` lists the palette table inline (Commander long-description block).

  **No envelope schema change.** No `freelo.<resource>.<op>/v2` bump. No API call change. Pure client-side discovery layer on top of R23 + R24, surfacing Freelo's fixed nine-color palette by name. New shared helper `src/lib/label-color.ts` is the single source of truth.

  No new dependencies.

- 82ae974: Add `freelo projects archive` / `projects activate` / `projects delete` (R30) — second slice of Wave 5 project admin.

  **Surface:**

  ```
  freelo projects archive  <id>... [--ids "a,b,c"] [--stdin] [--dry-run]
  freelo projects activate <id>... [--ids "a,b,c"] [--stdin] [--dry-run]
  freelo projects delete   <id>... [--ids "a,b,c"] [--stdin] [--yes] [--dry-run]
  ```

  **Envelope contracts:** three new schemas (all additive — public contract):

  - `freelo.projects.archive/v1` — `data: { project_id, current_state: "archived" }`
  - `freelo.projects.activate/v1` — `data: { project_id, current_state: "active" }`
  - `freelo.projects.delete/v1` — `data: { project_id, current_state: "deleted", already_in_target_state }`

  `archive` and `activate` are absorbing-state writes — server-side idempotency means re-calling on an already-target project succeeds with a normal 200. `delete` is destructive (reuses the R13 `confirmDestructive` helper) and re-classifies a 404 as idempotent already-deleted (mirrors `tasks delete`). Soft-delete is reversible via `projects activate`.

  All three commands support `--dry-run`, positional `<id>...`, `--ids "a,b,c"`, and `--stdin` NDJSON. No GET pre-check on the wire path (decision 1 in spec 0043) — agents that need observed previous state should call `freelo projects show` first.

- b8b21fa: Add `freelo projects create-from-template` (R31) — third slice of Wave 5 project admin.

  **Surface:**

  ```
  freelo projects create-from-template <template_id> --name <str>
    [--owner-id <id>] [--currency <CZK|EUR|USD>] [--date-start <YYYY-MM-DD>]
    [--layout <rows|kanban>] [--worker <id>]... [--dry-run]
  ```

  **Envelope contract:** new schema `freelo.projects.create-from-template/v1` (additive — public contract). Carries `data.template_id` (always) plus either `data.project: { id, name, owner?, currency_iso? }` on live success or `data.would: { method, path, body }` on `--dry-run`.

  Every flag maps to a documented field in the OpenAPI request body for `POST /project/create-from-template/{template_id}`: `name`, `project_owner_id`, `currency_iso`, `preset_date_from`, `general_settings.layout`, `users_ids`. Reuses Wave 2 shared write infra (`--dry-run`) and R29's body-builder / hint-rewriter patterns. Single-shot only in v1; `--stdin` NDJSON intentionally deferred (project creation is rare).

- edfac24: Add `freelo projects create` (R29) — first slice of Wave 5 project admin.

  **Surface:**

  ```
  freelo projects create --name <str> --currency <CZK|EUR|USD> [--project-owner-id <id>] [--dry-run]
  ```

  **Envelope contract:** new schema `freelo.projects.create/v1` (additive — public contract). Carries `data.project: { id, name }` on live success or `data.would: { method, path, body }` on `--dry-run`.

  Reuses Wave 2 shared write infra (`--dry-run`). Single-shot only in v1; NDJSON batch (`--stdin`) intentionally deferred. `--date-start` flag from the roadmap is dropped because the documented `POST /projects` body has no start-date field — tracked as a future R29.5 if Freelo adds it.

- bf79ae3: Add `freelo projects invite` (R33) — fifth slice of Wave 5 project admin.

  **Surface:**

  ```
  freelo projects invite --project <id>...
                         [--user <id>...] [--email <addr>...]
                         [--dry-run]
  ```

  `--project` is required and repeatable. `--user` and `--email` are **not** mutually exclusive — the wire body accepts both arrays in one call (decision 2; differs from R32 `workers remove` which routes to two different endpoints). At least one of `--user` / `--email` must be non-empty.

  **Envelope contract (additive — public contract):**

  - New schema `freelo.projects.invite/v1` — `data: { projects_ids, users_ids?, emails?, result?, would? }`.
    - `users_ids` / `emails` echoed only when supplied (post-dedup, in input order).
    - `result` present on live success — surfaces all four wire buckets (`newly_invited_users_to_projects`, `newly_created_users`, `newly_invited_users`, `removed_users_from_projects`) for agent inspection.
    - `would` present on `--dry-run`. Mutually exclusive with `result`.

  Wire endpoint (per OpenAPI :3417-3498):

  - `POST /users/manage-workers` — body `{ projects_ids: number[], users_ids?: number[], emails?: string[] }`.

  Single bulk POST: one invocation = one HTTP call across all three input dimensions. Unknown emails trigger user creation server-side (via the documented "newly_created_users" response bucket).

  Reuses the `--dry-run` helper (R09) and the repeatable-flag dedup pattern from R32. No `confirmDestructive` gate — invite is additive. No new dependencies.

  **Out of scope for v1:** `--acl-tasklist` (body field not documented in the OpenAPI schema, only mentioned in description prose; tracked as R33.5), `--stdin` / NDJSON batch (endpoint is itself array-typed across three dimensions).

- bc90b43: Add `freelo projects workers list` and `freelo projects workers remove` (R32) — fourth slice of Wave 5 project admin.

  **Surface:**

  ```
  freelo projects workers list   --project <id> [--page N | --all] [--fields <list>]
  freelo projects workers remove --project <id>
                                 ( --user <id>... | --email <addr>... )
                                 [--yes] [--dry-run]
  ```

  `--user` and `--email` are mutually exclusive (different endpoints), each is repeatable into a single atomic POST.

  **Envelope contracts (additive — public contract):**

  - New schema `freelo.projects.workers.list/v1` — `data: { project_id, workers: UserBasic[] }`, plus standard `paging` and `rate_limit`.
  - New schema `freelo.projects.workers.remove/v1` — `data: { project_id, removed_by: 'ids'|'emails', count, users_ids?, users_emails?, would? }`. `removed_by` is the discriminant; the matching sibling array is present on live success and on `--dry-run`. `would` is set only on `--dry-run`.

  Wire endpoints (per OpenAPI :583-619, :676-757):

  - `GET  /project/{id}/workers?p=N` — paginated; reuses the R04 wrapper `getProjectWorkers` plus the R03 `fetchAllPages` helper.
  - `POST /project/{id}/remove-workers/by-ids` — body `{ users_ids: number[] }`.
  - `POST /project/{id}/remove-workers/by-emails` — body `{ users_emails: string[] }`.

  Both remove endpoints are atomic — the server fails the whole request if any single user can't be removed (no partial removal). The CLI does not map any HTTP error to `already_in_target_state: true` (the API behavior on re-call is not documented as idempotent; surfacing server errors as-is is the safer default).

  Reuses `confirmDestructive` (R13) and the `--dry-run` helper (R09); no new dependencies.

- d6eccb3: Add `freelo tasklists create` and `freelo tasklists create-from-template` (R34, partial) — final write surface for the `tasklists` group, modulo the deferred `delete` (R34.5).

  **Surface:**

  ```
  freelo tasklists create --project <id> --name <str> [--budget <str>] [--dry-run]
  freelo tasklists create-from-template <template_id> --source-tasklist <id> [--target-project <id>] [--target-tasklist <id>] [--date-start <YYYY-MM-DD>] [--worker <id>]... [--dry-run]
  ```

  **Envelope contracts:** two new schemas (additive — public contract):

  - `freelo.tasklists.create/v1` — carries `data.project_id` plus `data.tasklist: { id, name, budget? }` on live success or `data.would: { method, path, body }` on `--dry-run`.
  - `freelo.tasklists.create-from-template/v1` — carries `data.template_id` plus `data.tasklist: { id, name, tasks }` on live success or `data.would: { method, path, body }` on `--dry-run`.

  `--budget` is a verbatim digits-only string in base units (`"100000"` = 1000.00 of the project's currency) — no client-side parsing to avoid float drift. The `create-from-template` flag set is redesigned against the documented OpenAPI body (`tasklist_id`, `target_project_id?`, `target_tasklist_id?`, `preset_date_from?`, `users_ids?`) and intentionally does not match the roadmap's pre-OpenAPI shape.

  `tasklists delete` is **deferred to R34.5**: `DELETE /tasklist/{id}` is not documented in `docs/api/freelo-api.yaml` as of 2026-05-09. Mirrors R29.5 / R33.5 deferral pattern (drop the surface whose OpenAPI backing isn't there; capture as a follow-up R-slice).

## 0.17.3

### Patch Changes

- 31aead3: fix(api): tolerate `minutes` as a wire string on `GET /task/{id}`

  Live Freelo API returns `minutes` as a JSON string (e.g. `"130"`) on
  `GET /task/{id}` for tasks with logged time, contradicting the OpenAPI
  spec which types it as an integer. `freelo tasks show <id>` failed with
  `VALIDATION_ERROR` whenever the task had any minutes logged.

  `TaskDetailSchema.minutes` (and the nested `TimeEstimateSchema` /
  `UserTimeEstimateSchema` that live on the same response) now accept
  either string or number and coerce to a number. Same divergence pattern
  as `CurrencySchema.amount`, which already handles wire-string amounts.

  Other endpoints carrying a `minutes` field (`/work-reports`,
  `/all-projects`, etc.) were probed live and consistently return numbers,
  so their schemas are unchanged.

- e0ce419: fix(errors): Windows libuv UV_HANDLE_CLOSING crash on the error-exit path (round 3)

  The crash kept resurfacing after rounds 1 and 2 even with `dispatcher.destroy()`
  plus a `setImmediate` hop. Empirically on Windows 11 + Node 24, it takes about
  100 ms of wall-clock time after `dispatcher.destroy()` resolves before libuv
  has finished closing its internal async handles. Phase rotation alone — even
  50 `setImmediate` hops — does not clear it; only real time does.

  `exitDeferred` now sets `process.exitCode = code` synchronously and schedules
  `process.exit` via `setTimeout` with a 200 ms fallback (overrideable via
  `FREELO_EXIT_DELAY_MS`). When the loop drains naturally before the fallback
  fires (the common case after `dispatcher.destroy()` and a flushed envelope
  write), the process exits cleanly with the right code and `process.exit` never
  runs. Otherwise the fallback fires after libuv has had time to finalize.

  The bug shipped because the integration test in
  `test/integration/windows-libuv-exit.test.ts` uses a localhost HTTP stub —
  which doesn't reproduce the production case (TLS to api.freelo.io leaves more
  internal async handles mid-close at exit). A new unit test in
  `test/errors/handle.test.ts` asserts the round-3 contract directly: that
  `process.exitCode` is set before any `process.exit` call.

  No public surface change — the `freelo.error/v1` envelope and exit codes are
  identical.

## 0.17.2

### Patch Changes

- 1c80794: fix(commands): tasks create --label now decomposes into create-then-attach,
  fixing the live-API 400 "Missing item 'uuid' in array."

  The `POST /project/{p}/tasklist/{t}/tasks` endpoint requires every label
  entry to carry `{uuid, name, color}` together; name-mode is rejected. The
  CLI now creates the task without labels, then issues a single batched
  `POST /task-labels/add-to-task/<new-id>` for the requested names. Total
  HTTP cost is two calls when `--label` is set, one call otherwise. On
  attach failure the task is still created; `applied_labels.failed` carries
  the diagnostic and a `freelo.error/v1` envelope lands on stderr.

  Schema `freelo.tasks.create/v2` bumped — `data.would` retyped from object
  to array (in --dry-run output, to describe both prospective calls);
  `data.applied_labels` added to surface attach success/failure per label
  name. The /v1 envelope was only emitted on a code path that returned 400,
  so no working caller is affected.

## 0.17.1

### Patch Changes

- 35e7e4e: fix(api): notifications — match real Freelo wire shape

  Two divergences between the published OpenAPI spec and the live Freelo API
  were caught after R28 shipped:

  - `GET /all-notifications?only_unread=...` requires the string `"1"` / `"0"`,
    not the documented boolean. The server silently ignored `true` so
    `freelo notifications list --unread` returned the same list as without
    the flag.
  - The mark endpoints are `/notification/{id}/mark-read` and `/mark-unread`,
    not `/mark-as-read` / `/mark-as-unread` as the spec says. The longer
    paths returned 200 but did not flip the flag.

  Both verified against Freelo's official MCP server
  (github.com/freeloapp/mcp). The cached OpenAPI yaml has been corrected
  and a "known quirks" entry added to the freelo-api skill.

## 0.17.0

### Minor Changes

- 6cfcd3b: R17 — `freelo comments add`. Post a single comment to a task without leaving the terminal. Second leaf under the `comments` subcommand (R16 added `list`).

  ```
  freelo comments add --task <id>
                      (--message <str> | --from-file <path> | --editor | -)
                      [--dry-run]
  ```

  **Four input sources, exactly-one-required:**

  - `--message <str>` — inline pass-through (one-liners).
  - `--from-file <path>` — read a UTF-8 file.
  - `--editor` — open `$VISUAL` / `$EDITOR` (TTY-only).
  - `-` (positional) — read stdin to EOF.

  The file / editor / stdin paths reuse `src/lib/input.ts` (R15); `--message` is layered on inline. Mutex enforced — zero or two-of-four sources fail with `VALIDATION_ERROR` (exit 2). Empty content is rejected at the command layer before any wire round-trip.

  **One new envelope schema (additive surface):**

  - `freelo.comments.add/v1` — `{ task_id, comment, source, byte_length, is_description, would? }`. `comment` / `source` / `is_description` are present in live envelopes, absent in `--dry-run`; `would` is the inverse. `byte_length` is always present.

  **Server-side auto-flip surfaced to agents.** When the target task has no prior comments, the Freelo API converts this POST into the task's **description** instead of a regular comment (per `docs/api/freelo-api.yaml:2589-2592`). The CLI does not branch on this — it surfaces the flip via `data.is_description: true` (always present, defaults to `false`) so agents can detect-after-the-fact, and the human-mode message points at `freelo tasks description set` for explicit description writes.

  **Idempotency: N/A by design.** Each POST creates a new comment row; there is no natural-key dedupe. Two consecutive identical invocations create two identical comments. `--dry-run` is the safety net.

  **Out of scope for v1:**

  - No `--files` / multipart attachments — multipart upload helper lands at R25.
  - No batch input (`--ids` / `--stdin` NDJSON of `{task_id, content}`) — single-comment-per-invocation only.
  - No edit / delete — those land at R18.

  No new dependencies. Reuses `commander`, `zod`, `undici` (via the shared HTTP client), `src/lib/input.ts`, `src/lib/dry-run.ts`, and `src/ui/envelope.ts`.

- 409a784: R18 — `freelo comments edit`. Overwrite the content of one or more existing comments without leaving the terminal. Third leaf under the `comments` subcommand (after R16 `list`, R17 `add`).

  ```
  freelo comments edit <id>...                           # variadic positional
  freelo comments edit --ids "1,2,3"                     # batch flag
  freelo comments edit --stdin                           # NDJSON {id, content} per row
                       (--message <str> | --from-file <path> | --editor | -)
                       [--dry-run]
  ```

  Wraps `POST /comment/{comment_id}` (OpenAPI `editComment`, yaml :2619-2663). The verb is **POST**, not PUT/PATCH — yaml :2634 documents this explicitly: "POST for historical reasons, not PUT/PATCH."

  **Three input sources (mutex), four content sources (mutex on non-stdin paths):**

  - Input: positional `<id>...` / `--ids` / `--stdin` (NDJSON `{id, content}` per row).
  - Content (non-stdin paths): `--message <str>` / `--from-file <path>` / `--editor` / `-` (stdin sentinel, single-id only).
  - `--stdin` owns per-row content — combining it with a content source is rejected.

  Reuses `src/lib/input.ts` (R15), `src/lib/batch.ts` (R09), `src/lib/dry-run.ts` (R09).

  **One new envelope schema (additive surface):**

  - `freelo.comments.edit/v1` — `{ comment_id, comment?, source?, byte_length, line_index?, would? }`. `comment` and `source` are present in live envelopes and absent on `--dry-run`; `would` is the inverse; `line_index` rides on `--stdin` rows; `byte_length` is always present.

  **Edit is non-destructive and not absorbing-state.** No `--yes` interaction (no confirmation prompt). No `already_in_target_state` field (every successful POST returns the updated comment). Two consecutive identical edits both report success.

  **Per yaml :2631-2633, ACL violations on edit return 404, not 403** — to avoid leaking comment existence. The CLI's 404 hint surfaces both possible causes ("not found, or your account does not have permission").

  **Roadmap correction:**

  - §R18 corrected to drop the `PATCH` mention and the `comments delete` clause. Slice title renamed to `R18 — \`freelo comments edit\``.
  - New `R18.5 — \`freelo comments delete\` (queued)`entry added — endpoint **not in`docs/api/freelo-api.yaml`** as of 2026-04-28; first action is `freelo-api-specialist` confirmation against a live test account.

  **Out of scope for v1:**

  - No `--files` / multipart attachment replacement — multipart helper lands at R25. Wire body sends only `content`; existing attachments are left untouched per yaml :2632.
  - No `comments delete` — deferred to R18.5.

  No new dependencies.

- 6c533b4: R19 — `freelo time start` / `freelo time status`. Start a time-tracking session on a task (or general work), and check the current state of the running timer. First slice in Wave 3's time-tracking sub-thread, and first command under the new top-level `time` resource.

  ```
  freelo time start [--task <id>] [--note <str>] [--dry-run]
  freelo time status
  ```

  Wraps `POST /timetracking/start` (OpenAPI `startTimeTracking`, yaml :2729-2778) and `GET /timetracking/status` (OpenAPI `getTimeTrackingStatus`, yaml :2863-2944).

  **Singleton per user.** Freelo enforces "at most one active timer per user account". A second `time start` while one is already running returns HTTP **409 Conflict**. The CLI catches the 409, performs an opportunistic `GET /timetracking/status` follow-up to enrich `hint_next` with the active task and start time ("already tracking X since Y" — the explicit ship condition from the roadmap), and falls back to a generic `time stop` / `time edit` (R20) pointer if the follow-up fails.

  **204 No Content is not an error.** `time status` returns HTTP 204 when no timer is running. The CLI translates that into a discriminated-union envelope (`{ active: false }`) with exit 0. Agents `switch` on `data.active` to branch on the timer state without nullish checks.

  **Two new envelope schemas (additive surface):**

  - `freelo.time.start/v1` — `{ uuid, task_id, note }` on live, `{ task_id, note, would }` on `--dry-run` (no synthesized uuid).
  - `freelo.time.status/v1` — discriminated union on `data.active`:
    - `{ active: true, session: { uuid, started_at, elapsed_seconds, task, note, is_billable, is_cost_fixed, labels, cost, project_setting } }`
    - `{ active: false }`

  `started_at` is a CLI-friendly rename of the wire `date_reported`; `elapsed_seconds` is derived client-side at envelope-build time and clamped at 0 for clock skew.

  **Shared HTTP client extension** (`src/api/client.ts`): added a 204-No-Content branch that feeds `null` to the configured zod schema. Pure addition — no existing schema accepts `null`, so no caller changes behavior. First documented use is `GET /timetracking/status`; future 204 endpoints inherit it.

  **Batch input (`--ids` / `--stdin`) is N/A** for `time start`: a successful batch could never have more than one row, since the second start would 409. Documented in spec 0030 §2.1 / decision 5.

  **Out of scope for this slice:**

  - `time stop`, `time edit` — R20.
  - `reports list` (work reports), `reports log` — R21 / R22.
  - `--at <timestamp>` backdate flag on start — Freelo supports it via `date_reported`, but the CLI doesn't surface it yet. Most workflows want "now".

  No new dependencies.

- 3bc38f9: R19.5 — `freelo time start --at <ISO>`. New optional flag that backdates the session's start timestamp via the API's `date_reported` body field (yaml :2744). Useful when you forgot to start the timer at the real start time, or when an integration replays a "moved to in-progress" event after the fact.

  ```
  freelo time start --task <id> [--note <str>] [--at <ISO>] [--dry-run]
  ```

  **Acceptance.** `--at` accepts any value `Date.parse()` accepts: full RFC 3339 / ISO 8601 timestamps, timestamps with timezone offsets, and bare `YYYY-MM-DD` (treated as midnight UTC). The CLI canonicalizes everything to second-precision UTC `YYYY-MM-DDTHH:MM:SSZ` before sending — one wire shape regardless of input.

  **Validation (exit 2, `VALIDATION_ERROR`):**

  - Malformed input → rejects with a hint pointing at the canonical shape.
  - Inputs more than 60 seconds in the future → rejects as a clock-skew clamp. Backdating into the future doesn't make sense for a session that's just starting.
  - **No client-side lower bound.** If Freelo's server rejects a far-past timestamp, the CLI surfaces that as `FREELO_API_ERROR` (exit 4) — we mirror server behavior and don't invent stricter rules.

  **Wire cleanliness.** Omitting `--at` means the body has **no** `date_reported` key (not `null`). Wire diffs against R19 fixtures stay byte-identical for the unchanged path.

  **Schema unchanged.** Output envelope `freelo.time.start/v1` is **not** bumped — this is a pure input addition. No `--at` echo on live `data`; agents that want to confirm the backdate took effect chain `freelo time status` and read `started_at`.

  **`--dry-run` already works.** When `--at` is also passed, `data.would.body.date_reported` reflects the canonicalized UTC string.

  No new dependencies. New helper `parseIsoTimestampFlag` in `src/lib/iso-timestamp.ts` for any future timestamp-aware flag (e.g. R20's `time edit`).

- 0822c5e: R20 — `freelo time stop` / `freelo time edit`. Finish the time-tracking surface: stop the active session and convert it into a finalized work report; edit the active session in flight to switch tracked task or update the note. Closes Wave 3's time-tracking sub-thread.

  ```
  freelo time stop [--dry-run]
  freelo time edit [--task <id>] [--clear-task] [--note <str>] [--dry-run]
  ```

  Wraps `POST /timetracking/stop` (OpenAPI `stopTimeTracking`, yaml :2780-2809) and `POST /timetracking/edit` (OpenAPI `editTimeTracking`, yaml :2811-2861).

  **No-active-session 409 is the load-bearing UX.** Both endpoints return HTTP 409 with `"Timetracking is not running."` when no session is active. The CLI catches `FreeloApiError(httpStatus: 409)` on either command and rewrites `hint_next` to `"No active time tracking session for your account. Use \`freelo time start\` to begin one."` Symmetric to R19's already-running 409 hint.

  **Two new envelope schemas (additive surface):**

  - `freelo.time.stop/v1` — `data.work_report: { id, date_add, date_reported, minutes, note, task, cost, worker, author }` on live; `data.would: { method, path, body: null }` on `--dry-run`. The wire `WorkReport` shape is projected to a stable subset; inner refs are tightened (we own the public contract) and `passthrough` is dropped.
  - `freelo.time.edit/v1` — `data: { uuid, applied_changes }` on live; `data.applied_changes` mirrors the wire body shape exactly so agents can read `'task_id' in applied_changes` to know whether the user touched the task field. Keys present iff the corresponding flag was passed.

  **`time edit` adds `--task` / `--clear-task` mutex.** OpenAPI's edit body documents `task_id: null` as a meaningful "disassociate from task" value (continue as general work). The CLI exposes both directions: `--task <id>` to reassign, `--clear-task` to disassociate. Mutually exclusive — both supplied → `VALIDATION_ERROR` exit 2. The roadmap omitted both flags; we add them so agents can drive the documented capability.

  **Empty edit is a usage error.** `freelo time edit` with no flags → `VALIDATION_ERROR` exit 2. Catches typos and accidental flag drops at the boundary, before the network call. Mirrors R10 `tasks edit` precedent.

  **Three OpenAPI-vs-roadmap discrepancies resolved.** (See spec 0032 §1, §6, decisions 1, 2, 8.)

  1. **`time edit` is POST, not PATCH.** The roadmap text says `PATCH /timetracking/edit`; OpenAPI yaml :2812 says `post:`. Per the orchestrator hard rule "follow the OpenAPI spec when it contradicts the roadmap", we ship POST.
  2. **No `--note` on `time stop`.** The roadmap proposed it, but the OpenAPI spec for `/timetracking/stop` documents no request body. Sending one would be guessing API behavior. Workaround: chain `freelo time edit --note "..." && freelo time stop`.
  3. **No `--started-at <ISO>` on `time edit`.** Same shape as #2 — OpenAPI body has only `task_id` and `note`. Deferred to a follow-up slice (R20.5), mirroring the R19 → R19.5 deferral pattern for `--at` on `time start`.

  **Batch input (`--ids` / `--stdin`) is N/A** for both commands: singleton-per-user precludes batch, same as R19.

  **Out of scope for this slice:**

  - `--note` on `time stop` (decision 1).
  - `--started-at <ISO>` on `time edit` (decision 2 — deferred to R20.5).
  - `reports list` (work reports) — R21.
  - Retroactive work-report logging without timer — R22.

  No new dependencies.

- 7450ab4: R21 — `freelo reports list`. First read surface for the **work-reports** (time-entries) resource group: paginated list of every finalized work report the caller can see, with filters by task / project / worker and a `date_reported` window.

  ```
  freelo reports list [--task <id> ...] [--project <id> ...] [--worker <id> ...]
                      [--from YYYY-MM-DD] [--to YYYY-MM-DD]
                      [--page N | --all]
  ```

  Wraps `GET /work-reports` (OpenAPI `getWorkReports`, yaml :2947-3043).

  **New envelope schema (additive surface):** `freelo.reports.list/v1` — `data: { applied_filters, reports: WorkReportFull[] }`. `applied_filters` echoes only keys the user explicitly set (mirrors `comments list` precedent).

  **Filter mapping (1-1 wire equivalents):**

  - `--task <id>` (repeatable) → `tasks_ids[]`
  - `--project <id>` (repeatable) → `projects_ids[]`
  - `--worker <id>` (repeatable) → `users_ids[]`
  - `--from <YYYY-MM-DD>` → `date_reported_range[date_from]` (inclusive)
  - `--to <YYYY-MM-DD>` → `date_reported_range[date_to]` (inclusive)
  - `--page N` (1-indexed) → wire `p=N-1`. Mutex with `--all`.
  - `--all` → iterate `?p=0,1,…` until exhausted. Mutex with `--page`.

  **One OpenAPI-vs-roadmap discrepancy resolved.** (See spec 0033 §2 and decision 1.)

  The R21 roadmap line names `GET /task/{task_id}/work-reports` as a second endpoint, but `docs/api/freelo-api.yaml` documents only `POST` at that path (used by R22 to create work reports). Per the orchestrator hard rule "API behavior not in `docs/api/freelo-api.yaml` → don't guess the API" — and matching the R16 (`comments list`) precedent — R21 ships against the global `GET /work-reports` only, with `--task` mapped to the documented `tasks_ids[]` filter. A potential R21.5 (task-scoped GET) is queued if/when the OpenAPI surfaces such an endpoint.

  **Out of scope for this slice (deferred to follow-ups):**

  - `--label <uuid>` (`tasks_labels[]` server-side filter).
  - `--currency` (server defaults to CZK).
  - `--with-own-taskless` (load-bearing implicit caller scope).
  - `--fields` projection.
  - Task-scoped GET endpoint (decision 1 above).
  - Logging / editing / deleting work reports — R22.

  No new dependencies.

- e8abf40: R22 — `freelo reports log` / `reports edit` / `reports delete`. Closes the write loop on the **work-reports** resource group (R21 shipped read).

  ```
  freelo reports log    --task <id> --minutes <n> [--date YYYY-MM-DD] [--note <str>] [--dry-run] [--stdin]
  freelo reports edit   <id>        [--minutes <n>] [--note <str>] [--date YYYY-MM-DD]  [--dry-run] [--stdin]
  freelo reports delete <id>...     [--ids "1,2,3"] [--stdin] [--yes] [--dry-run]
  ```

  **New envelope schemas (additive):**

  - `freelo.reports.log/v1` — `data: { report, applied_input, line_index? }`.
  - `freelo.reports.edit/v1` — `data: { report, applied_changes, line_index? }`.
  - `freelo.reports.delete/v1` — `data: { report_id, previous_state, current_state, already_in_target_state, would?, line_index? }`. Mirrors `freelo.tasks.delete/v1` byte-for-byte modulo the field rename.

  **Wire bindings (OpenAPI `docs/api/freelo-api.yaml`):**

  - `reports log` → `POST /task/{task_id}/work-reports` (yaml :3045-3093).
  - `reports edit` → **`POST /work-reports/{id}`** (yaml :3095-3143). Note: verb is **POST**, not PATCH — the roadmap text was wrong; same trap as R18 (comments-edit) and R20 (time-edit). The roadmap line will be reconciled in a separate follow-up doc PR after this slice merges. Spec 0034 decision 01.
  - `reports delete` → `DELETE /work-reports/{id}` (yaml :3144-3171).

  **Destructive command — confirmation policy:** `reports delete` is the second destructive command in the CLI (after `tasks delete`). It reuses `confirmDestructive` byte-for-byte: TTY prompt by default, `--yes` to bypass, non-TTY without `--yes` fails closed with `CONFIRMATION_REQUIRED` exit 2.

  **Four-arm idempotency on delete (spec 0034 decision 02):**

  1. HTTP 404 → `already_in_target_state: true`, exit 0.
  2. HTTP 400 with body matching `/not found|does not exist/i` → idempotent skip, exit 0.
  3. HTTP 400 containing `UserCannotDeleteWorkReport` → hard `FREELO_API_ERROR` (ACL stays observable), exit 4.
  4. Other non-2xx → re-throw `FreeloApiError`.

  Each arm has dedicated test coverage (Calibration §4) plus a direct unit test of the `isIdempotentDeleteSkip` helper.

  **Out of scope for this slice (deferred to follow-ups):**

  - `--cost` flag on log / edit. Per roadmap, money helper (`src/lib/money.ts` for cents-as-string encoding) deferred until `--cost` ships. Spec 0034 decision 03.
  - `--task` re-parent flag on edit (out of scope per roadmap CLI block).
  - `--worker` flag on log (caller's identity is used; delegated logging is a future slice).

  **Agent-safe contract reused everywhere:**

  - `--dry-run` on log / edit / delete (`would: { method, path, body }` in envelope).
  - Batch input: `reports log --stdin` and `reports edit --stdin` accept rich NDJSON rows (`{task, minutes, date?, note?}` and `{id, minutes?, note?, date?}` respectively); `reports delete` supports positional / `--ids` / `--stdin` byte-compat with `tasks delete`.
  - Continue-on-error in batches: bad rows emit `freelo.error/v1` envelopes with `context.line_index`; run-level exit is `max(per-row codes)`.

  No new dependencies.

- 7426315: R23 — `freelo labels list` / `labels rename` / `labels delete` / `labels attach` / `labels detach`. Adds the project-labels resource group (read + full write surface) in one slice.

  ```
  freelo labels list                                                              [--output ...]
  freelo labels rename <id>           [--name <str>] [--hex <color>] [--is-private | --is-public] [--dry-run]
  freelo labels delete <id>...        [--ids "1,2,3"] [--stdin] [--yes] [--dry-run]
  freelo labels attach --project <id> --name <str>... [--hex <color>] [--private | --public] [--dry-run]
  freelo labels detach --project <id> --label <id>... [--ids "1,2,3"] [--stdin]    [--dry-run]
  ```

  **Five new envelope schemas (additive):**

  - `freelo.labels.list/v1` — `data: { labels: ProjectLabel[] }`.
  - `freelo.labels.rename/v1` — `data: { label_id, applied_changes }` (intent, not server-confirmed state — same caveat as `time edit` / `reports edit`).
  - `freelo.labels.delete/v1` — `data: { label_id, previous_state, current_state: "deleted", already_in_target_state, would?, line_index? }`.
  - `freelo.labels.attach/v1` — `data: { project_id, name, is_private, color?, would? }`. **Notably no `already_in_target_state`** — see decision 08 below.
  - `freelo.labels.detach/v1` — `data: { project_id, label_id, previous_state, current_state: "detached", already_in_target_state, would?, line_index? }`.

  **Wire bindings (OpenAPI `docs/api/freelo-api.yaml`):**

  - `labels list` → `GET /project-labels/find-available` (yaml :833).
  - `labels rename` → **`POST /project-labels/{labelId}`** (yaml :862). Verb is **POST**, not PATCH — the roadmap text was wrong; same trap as R18 / R20 / R22. (Spec 0035 decision 01.)
  - `labels delete` → `DELETE /project-labels/{labelId}` (yaml :905).
  - `labels attach` → `POST /project-labels/add-to-project/{projectId}` (yaml :934, data-mode).
  - `labels detach` → **`POST /project-labels/remove-from-project/{projectId}`** (yaml :991). Verb is **POST**, not DELETE — roadmap was wrong. (Spec 0035 decision 02.)

  **`labels delete` is GLOBAL hard-delete** (yaml :917 — "hard delete of the global label, not a detach from one project"). The TTY confirmation copy says **"Delete N labels GLOBALLY (across all projects)?"** so a human user has a clear scope signal. (Decision 10.) Confirmation policy mirrors `tasks delete` / `reports delete` byte-for-byte: TTY prompt; non-TTY requires `-y` / `--yes` or fails closed with `CONFIRMATION_REQUIRED` exit 2.

  **Idempotency:**

  - `labels delete` — two-arm matrix (decision 09): 404 → `already_in_target_state: true`, exit 0; otherwise re-throw. (No documented 400 fallback for already-deleted on this endpoint.)
  - `labels detach` — same two-arm matrix: 404 → `already_in_target_state: true`, exit 0.
  - `labels attach` — server swallows `UniqueConstraintViolationException` server-side, so the CLI cannot distinguish first-attach from re-attach. The envelope **omits `already_in_target_state` entirely** rather than guess. Agents needing ground truth can call `labels list` before/after and diff. (Decision 08.)

  Each typed-error path has dedicated test coverage (Calibration §1-2) plus direct unit tests of both `isIdempotentDeleteSkip` and `isIdempotentDetachSkip` matrices (Calibration §4).

  **Roadmap-vs-API reconciliations (deferred surface):**

  - `labels list --project <id>` — **deferred**. The documented endpoint accepts no query parameters and `ProjectLabel` carries no `attached_projects` field. Tracked as future slice R23.5. (Spec 0035 decision 03.) Same precedent as R20.5 (`--started-at`) and R12.5 (`--pairs`).
  - `labels attach` id-mode body — **deferred**. v1 surfaces only data-mode (`--name <str>`, fetch-or-create). (Decision 07.)
  - `labels detach` data-mode (by name) — **deferred**. v1 surfaces only id-mode. (Spec §8 non-goals.)
  - No batch input on `labels rename` in v1 (would require rich NDJSON shape).

  **Flag-name decision: `--hex` instead of `--color` for `rename` / `attach` (decision 11).** The spec called for `--color <hex>`, but the CLI's root program already defines a global `--color <mode>` flag (auto/never/always) for output colorization. Commander shadows: when both root and subcommand register the same flag name, the root wins regardless of registration order, so the subcommand's `--color <hex>` would silently absorb into the root flag. Renaming the subcommand flag to `--hex <color>` removes the ambiguity without breaking any other command. The wire-body field is still `color` and the envelope field is still `color` / `applied_changes.color` — the rename is purely lexical at the CLI layer.

  **Agent-safe contract reused everywhere:**

  - `--dry-run` on every write (`would: { method, path, body }` in envelope).
  - Batch input: `delete` and `detach` support positional / `--ids` / `--stdin`; `attach` fans out one POST per `--name`.
  - Continue-on-error in batches: bad rows emit `freelo.error/v1` envelopes with `context.line_index` (or `input_index`); run-level exit is `max(per-row codes)`.
  - Default `is_private: true` for `attach` (matches Freelo web UI default — labels are per-user-private unless explicitly shared). Decision 06.

  No new dependencies.

- efcb1d4: R24 — `freelo task-labels create` / `task-labels attach` / `task-labels detach`. Adds the **task-labels** resource group — a sibling of R23's `freelo labels` (project-labels) but a separate Freelo concept: per-account label palette attached/detached to/from individual tasks, identified by UUID and matched by name+color.

  ```
  freelo task-labels create --name <str>...                                       [--hex <color>] [--dry-run]
  freelo task-labels attach --task <id> (--name <str>|--uuid <id>)...             [--hex <color>] [--dry-run]
  freelo task-labels detach --task <id> (--name <str>|--uuid <id>)...             [--hex <color>] [--dry-run]
  ```

  **Three new envelope schemas (additive):**

  - `freelo.task_labels.create/v1` — `data: { labels: TaskLabelEntry[]; count; would? }`.
  - `freelo.task_labels.attach/v1` — `data: { task_id; labels: TaskLabelEntry[]; count; would? }`.
  - `freelo.task_labels.detach/v1` — `data: { task_id; labels: TaskLabelEntry[]; count; would? }`.

  `TaskLabelEntry = { uuid?: string; name?: string; color?: string }`. Each command emits exactly one envelope per invocation (one bulk POST, no per-name fan-out — the API is bulk-by-design).

  **Wire bindings (OpenAPI `docs/api/freelo-api.yaml`):**

  - `task-labels create` → `POST /task-labels` (yaml :2446) — server-side fetch-or-create on `name` (case-sensitive). API does not report new vs. reused.
  - `task-labels attach` → `POST /task-labels/add-to-task/{task_id}` (yaml :2484). Each entry is a `TaskLabelAddInput` `oneOf` — UUID-mode (`{ uuid }`) or name-mode (`{ name, color?, uuid? }`). Mixed within one call supported.
  - `task-labels detach` → **`POST /task-labels/remove-from-task/{task_id}`** (yaml :2530). Verb is **POST**, not DELETE — roadmap text was wrong, OpenAPI is authoritative (spec 0036 decision 01; same trap as R23). Each entry is a `TaskLabelRemoveInput` `oneOf` — UUID, name-only (aggressive — removes any color), or name+color (precise).

  **Server-side idempotency** — `detach` returns 200 even when the label isn't on the task. No two-arm 404 heuristic needed at the CLI (different shape than R23 `labels detach`).

  **Flag-name decision: `--hex` instead of `--color` for all three subcommands (spec 0036 decision 02).** Mirrors R23's spec 0035 decision 11 — the CLI's root program already defines a global `--color <mode>` flag, so the subcommand uses `--hex <color>` to avoid the shadow. The wire field and envelope field are still `color`; the rename is purely lexical at the CLI layer.

  **`--hex` semantics differ slightly per subcommand:**

  - `create` — applied to every `--name` entry (one color per call; per-name colors require separate invocations — decision 04).
  - `attach` — applied to every `--name` entry; `--uuid` entries ignore `--hex` (server uses the existing label's color).
  - `detach` — when present, every `--name` entry upgrades from name-only mode → name+color mode (precise removal). `--uuid` entries ignore `--hex`.

  **Idempotency caveats:**

  - `create` and `attach` are server-side fetch-or-create. The API does not report which were new vs. reused, so the CLI cannot surface that distinction. Re-running with the same args is safe — it's a no-op.
  - `detach` — server already-idempotent. Detaching a label that isn't on the task is 200 success.

  **Validation (each typed-error path has an exit-code test — Calibration §2):**

  - Missing `--name` and `--uuid` (attach/detach) or `--name` (create) → `ValidationError` exit 2.
  - `--task` non-positive / non-integer → `ValidationError` exit 2.
  - `--hex` not `#RRGGBB` → `ValidationError` exit 2.
  - `--uuid` not uuid-shaped → `ValidationError` exit 2.
  - Server 4xx/5xx → `FreeloApiError` exit 4 (e.g. 400 "Unsupported color (X) provided.").

  **Agent-safe contract reused:**

  - `--dry-run` on every leaf — envelope carries `would: { method: 'POST', path, body }`.
  - Mixed selectors (`--name` + `--uuid`) supported on attach/detach in one call.
  - No `--stdin` in v1 (decision 03 — small surface; can be added later if real workloads need it).
  - No destructive prompt on `detach` — label definitions persist after detach (only the assignment is removed).

  No new dependencies.

- 13b1a8f: R25 — `freelo files upload <path>... [--attach-to-task <id>] [--message <str>] [--dry-run] [--no-spinner]`. First multipart-body command in the CLI. Uploads one or more local files to Freelo via `POST /file/upload` and, optionally, posts a comment on a task that references each upload via the documented `<a data-freelo-uuid="UUID">filename</a>` anchor mechanism (yaml :3876).

  ```
  freelo files upload <path>... [--attach-to-task <id>] [--message <str>]
                                [--dry-run] [--no-spinner]
  ```

  **One new envelope schema (additive):**

  - `freelo.files.upload/v1` — `data: { uploaded[], failed[], count, attached?, would? }`.

  Per-path partial-failure semantics: when some uploads succeed and some fail, the command exits 4 with both arrays populated (and posts the comment with the surviving UUIDs if `--attach-to-task` is set). When zero succeed, the original typed error is re-thrown so single-path callers get the natural exit code.

  **Wire bindings (OpenAPI `docs/api/freelo-api.yaml`):**

  - Upload → `POST /file/upload` (yaml :3867) — `multipart/form-data` with a single `file` field. Hard 100 MB limit (yaml :3873). Response is `{ uuid }`.
  - Attach → `POST /task/{task_id}/comments` (yaml :2575) — content embeds `<a data-freelo-uuid>` anchors. The OpenAPI spec contradicts itself on the `comments.files[]` field (the global `FileUpload` schema requires `download_url`, which the upload response does NOT return). The anchor approach is the documented fallback (spec 0037 decision 02).

  **New shared helper:**

  - `src/lib/multipart.ts` — `buildFileMultipart(absPath)` builds a `FormData` body via the global `FormData` (provided by undici under the hood in Node 20+). Local validation (existence, regular file, ≤100 MB) — typed `ValidationError` exit 2 on violation. **Reusable** by future R26 / R27 (`files list` / `files download`) if needed.

  **Additive `HttpClient` method:**

  - `HttpClient.requestMultipart(opts)` — does NOT touch the existing `request()` method. Same Authorization / User-Agent / 401 / 4xx / 5xx error mapping. `Content-Type` header is intentionally omitted — `fetch` sets it (with boundary) when the body is a `FormData` instance. Multipart writes do NOT retry on 429 (writes never retry today; multipart inherits the rule).

  **Lazy `ora` spinner (TTY only):**

  - `await import('ora')` is gated by `isInteractive() && !opts.noSpinner`. Auto-disabled in CI / non-TTY / piped output. `--no-spinner` is a hard override (decision 04).

  **Filename safety:** filenames spliced into comment HTML are escaped (`<>&"'` → entities). Original (raw) filenames remain in `data.uploaded[].filename` for agent assertions (spec 0037 decision 09).

  **Validation (each typed-error path has an exit-code test — Calibration §2):**

  - Missing path / directory / oversize → `ValidationError` exit 2.
  - `--attach-to-task` non-positive / non-integer → `ValidationError` exit 2.
  - Whitespace-only `--message` → `ValidationError` exit 2.
  - Upload 4xx/5xx → `FreeloApiError` exit 4.
  - Upload 401 → `FreeloApiError` AUTH_EXPIRED exit 3.
  - Upload 429 → `RateLimitedError`.
  - Comment-create error after upload success → exit 4 (envelope still includes `uploaded[]` for recovery).

  **Agent-safe contract reused:**

  - `--dry-run` validates locally, emits envelope with `data.would` as an **array** (1..N+1 entries) — pluralization decision 10 vs. existing single-object `would`.
  - Variadic positional `<path>...` instead of `--ids` / `--stdin` — file paths are fundamentally positional (decision per spec §1 non-goals).
  - Sequential uploads (decision 08) — parallelism is one `--concurrency N` flag away if real workloads need it.

  **Reviewer flag — additive change to `src/api/client.ts`:** the new `requestMultipart` method is purely additive (no signature, retry, auth, or default change to existing `request()`), but it does live in the file the autonomous-sdlc Red trigger lists by name. Spec 0037 decision 01 keeps this Yellow-tier; tagging here for visibility on PR review.

  No new runtime dependencies — `undici` and `ora` were already pinned.

- 283f980: R26 — `freelo files list`. Browse every directory, link, file, and document the caller can see across accessible projects, with optional filters by project and item type. Second leaf under the `files` subcommand (R25 added `upload`).

  ```
  freelo files list [--project <id> ...] [--type doc|file|link|dir]
                    [--page N | --all]
  ```

  **Three filters mapped to the Freelo wire:**

  - `--project <id>` — repeatable, OR semantics; maps to `projects_ids[]`.
  - `--type <kind>` — CLI short forms (`doc`/`file`/`link`/`dir`) mapped to the wire enum (`document`/`file`/`link`/`directory`). Single-valued per the OpenAPI.
  - `--page <n>` (1-indexed CLI → 0-indexed wire) / `--all` (mutex) — same paging convention as R16 / R21.

  **One new envelope schema (additive surface):**

  - `schema 'freelo.files.list/v1' added` — `{ applied_filters: { projects?, type? }, items: FileItem[] }`. `applied_filters.type` carries the **wire form** so agents round-tripping to Freelo's REST get a string they can pass straight through.

  **`--task <id>` deferred** (decision logged at `docs/decisions/2026-04-29-1756-r26-files-list-1-defer-task.md`). The roadmap names the flag, but `GET /all-docs-and-files` does not accept any task-scoped query parameter per `docs/api/freelo-api.yaml:3925-3937` — only `projects_ids[]`, `type`, and `p`. No alternative task-scoped doc/file listing endpoint is documented. Tracked as potential R26.5; same shape of decision as R23 (which deferred `--project` for the same class of reason). The `--help` description, the doc page, and this changeset all name the deferral so agents reading the roadmap don't trip on the absence.

  **Out of scope for v1:**

  - No `--mime` / `--extension` / `--name` filters (not server-side; client post-filter on `--all` is future-additive).
  - No `--directory <uuid>` filter (`directory_uuid` is on the response shape but not in the wire query parameter list).
  - No `--per-page` (server-controlled).
  - No `--fields` projection (R03 ships the helper but R16 / R21 don't surface it; staying parity).
  - No write surface — upload is R25, download will be R27.

  No new dependencies. Reuses `commander`, `zod`, `undici` (via the shared HTTP client), `src/api/pagination.ts` (`fetchAllPages`, `pagingFromNormalized`, `PartialPagesError`), `src/lib/query.ts`, `src/ui/envelope.ts`, `src/ui/table.ts`. The `getAllDocsAndFiles` wire wrapper appends to the existing R25 `src/api/files.ts`; `FileItemSchema` and friends append to `src/api/schemas/file.ts`.

- d89b52f: feat(commands): r27 — `freelo files download <uuid> [-o <path>] [--stdout] [--force]`.

  - New leaf under the existing `files` namespace. Streams the binary body of `GET /file/{file_uuid}` to a local file (atomic temp + rename) or to `process.stdout`.
  - New envelope schema: `freelo.files.download/v1` (additive — `uuid`, `destination`, `bytes`, `filename`, `content_type`, `overwrote`).
  - Additive `HttpClient.requestBinary` method on `src/api/client.ts` — companion to `request()` and `requestMultipart()`. Does **not** retry on 429 (decision 05). Does not modify the existing `request()` / `requestMultipart()` code paths or their error / auth / rate-limit semantics.
  - New shared helpers: `src/lib/format.ts` (`humanizeBytes`, consolidated from R26's renderer) and `src/lib/filename.ts` (`parseContentDisposition`, `sanitizeBasename` — RFC 6266 + path-traversal defense).
  - Path-traversal-safe filename inference: a malicious `Content-Disposition: filename="../../etc/passwd"` is sanitized to a bare basename anchored at `process.cwd()`. Explicit `-o <path>` is taken at face value (user intent).
  - Refuse to overwrite an existing destination unless `--force` is set; non-TTY callers get a clean `VALIDATION_ERROR` exit 2 instead of silent data loss.
  - `--stdout` reroutes the success envelope to stderr so binary on stdout stays clean. Human mode is silent on stderr in this combination (no chatter when piping to a tool).
  - Lazy `ora` spinner on TTY (auto-disabled when `--stdout` / CI / non-TTY / `--no-spinner`).

- 71eab0c: R28 — `freelo notifications list` / `read` / `unread`. First slice in the notifications sub-thread; gives agents a typed, paginated, idempotent surface over the Freelo notification feed.

  ```
  freelo notifications list   [--unread] [--page N | --all] [--project <id>...] [--type <s>...]
  freelo notifications read   <id>... | --ids <list> | --stdin | --all-unread   [--dry-run]
  freelo notifications unread <id>... | --ids <list> | --stdin                  [--dry-run]
  ```

  Wraps three Freelo endpoints:

  - `GET /all-notifications` — paginated list (yaml :3619-3694).
  - `POST /notification/{id}/mark-as-read` — flip `is_unread → false` (yaml :3696-3724).
  - `POST /notification/{id}/mark-as-unread` — flip `is_unread → true` (yaml :3726-3753).

  **Three new envelope schemas (additive surface):**

  - `freelo.notifications.list/v1` — `{ applied_filters, items: Notification[] }` plus `paging` and `rate_limit`.
  - `freelo.notifications.read/v1` — per-id `{ notification_id, posted: true }` (or `{ notice: 'No unread notifications.', data: {} }` for empty `--all-unread`).
  - `freelo.notifications.unread/v1` — per-id `{ notification_id, posted: true }`.

  **Server-side idempotent.** Both write endpoints return 200 on already-in-state. There is no `GET /notification/{id}` endpoint, so the CLI cannot pre-check current state per id and never emits `already_in_target_state` — agents that need that signal must observe `is_unread` via `notifications list` before/after.

  **Agent-safe writes.** Every write supports `--dry-run` (echoes wire path in `data.would`), `<id>...` positional + `--ids` + `--stdin` NDJSON batch, and per-id error envelopes in batch mode (highest exit code wins). No destructive prompt — marking-as-read is reversible (use `unread` to revert).

  **`--all-unread` on `read`** drains the unread feed: lists every unread notification client-side (paged), then POSTs `mark-as-read` for each id. Per-id failures continue with the rest. Empty unread set emits a single `notice` envelope (decision 06). With `--dry-run`, the list call still runs (so the user sees what _would_ be POSTed); the per-id POSTs do not. **No `--yes` gate** — the operation is reversible (decision 02).

  **v1 list filters surfaced:** `--unread` (→ `only_unread=true`), `--project` (→ `projects_ids[]`, repeatable), `--type` (→ `notification_types[]`, repeatable). Wire-only filters omitted in v1 (decision 04): `users_ids[]`, `teams_uuids[]`, `order`. Add later if real workloads ask.

  No new dependencies. No security review trigger.

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
