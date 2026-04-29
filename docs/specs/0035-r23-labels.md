# Spec 0035 — R23 `freelo labels` (project labels)

**Slice:** R23 (Wave 4 — labels read + write surface)
**Run:** `2026-04-29-1300-r23-labels`
**Depends on:** R04 (project-id parsing pattern), R13 (`tasks delete` —
confirmation + idempotency), R22 (multi-subcommand slice precedent
spec 0034).
**Adds:** five commands, five envelope schemas, one new API module
(`src/api/project-labels.ts`), one new schema module
(`src/api/schemas/project-label.ts`), one new MSW handler family.
**Tier:** Yellow (additive new commands; one destructive global delete;
no auth/HTTP-defaults change).

---

## 1. Problem

Project labels are how Freelo users organize projects across portfolios
(client / status / priority / "billable"). The CLI currently has no way
to see the caller's label inventory, rename or delete a label, or
attach/detach labels from projects without bouncing to the web UI. After
R23, an agent can:

- Enumerate the caller's labels (private + the public ones from
  accessible projects) — `freelo labels list`.
- Rename or recolor a label across every project that uses it —
  `freelo labels rename`.
- Hard-delete a label across the workspace — `freelo labels delete`.
- Attach one or more labels (by name, fetch-or-create) to a project —
  `freelo labels attach`.
- Detach one or more labels (by id) from a project — `freelo labels
  detach`.

This is the **third multi-subcommand write slice** (after R20 time and
R22 reports), so the patterns are stable. The two new wrinkles are
(a) `attach`'s fetch-or-create fan-out (`--name` repeating → N calls)
and (b) idempotency on the cross-project `detach` 404 arm.

## 2. Proposal

Introduce a new `labels` resource subcommand with five leaves:

```
freelo labels list                                                              [--output ...]
freelo labels rename <id> --name <str> [--color <hex>] [--is-private | --is-public] [--dry-run]
freelo labels delete <id>... [--ids <list>] [--stdin] [--yes] [--dry-run]
freelo labels attach --project <id> --name <str>... [--color <hex>] [--private | --public] [--dry-run]
freelo labels detach --project <id> --label <id>... [--ids <list>] [--stdin] [--dry-run]
```

Each binds 1-1 to its documented Freelo endpoint (§4). Each emits a
versioned envelope (§5). Each is agent-safe per the conventions doc:
`--dry-run` on every write, batch-input on the destructive paths,
non-TTY confirmation policy on `delete`. Reuses the existing wire
infrastructure (HTTP client, error taxonomy, envelope builder, dry-run
helper, batch helper, confirm helper).

### 2.1 Roadmap reconciliation (decisions 01-03)

Three roadmap-vs-OpenAPI discrepancies surfaced during triage. All are
resolved by following the OpenAPI (per the orchestrator hard rule
"don't guess the API"). Same precedent as R18 / R20 / R22.

- **`labels rename` verb is POST, not PATCH.** OpenAPI yaml :862
  defines the edit operation under `post:` for `/project-labels/{labelId}`.
  Roadmap line said PATCH. Decision 01 — ship POST.
- **`labels detach` verb is POST, not DELETE.** OpenAPI yaml :991
  defines `removeProjectLabelFromProject` under `post:`. Roadmap line
  said DELETE. Decision 02 — ship POST.
- **`labels list --project <id>` filter is deferred.** OpenAPI's
  `GET /project-labels/find-available` accepts no query parameters
  (yaml :847, no `parameters:` block) and the response items
  (`ProjectLabel` yaml :5025) carry no `attached_projects` /
  `project_ids` field. There is no documented surface for "labels
  attached to project X". Decision 03 — defer the `--project` flag to
  a future R23.5; ship `labels list` with no scoping in v1. Same
  pattern as R20.5 (`time edit --started-at`) and R12.5 (`tasks move
  --pairs`).

### 2.2 New roadmap-vs-API decisions

- **`labels rename` empty-edit policy.** Server documents `name` and
  `color` as both optional (yaml :889-895). CLI requires at least one
  of `--name` / `--color` / `--is-private` / `--is-public` to be set;
  empty edit fails fast with `ValidationError` (exit 2). Mirrors R20
  `time edit` and R22 `reports edit`. Decision 04.
- **`labels rename` exposes `is_private` toggle.** OpenAPI documents
  `is_private` on the body (yaml :896). Surface as a mutex
  `--is-private` / `--is-public` pair, consistent with `--task` /
  `--clear-task` from R20. Roadmap line did not list this; we
  surface it because the wire supports it and toggling
  private↔public is a natural label-management workflow. Additive;
  decision 05.
- **`labels attach` `--private` / `--public` selector.** Wire body in
  data-mode requires `is_private` (yaml :978 — "Required in data
  mode"). Roadmap CLI did not surface this; CLI defaults to
  `is_private: true` (matches Freelo web UI default — labels are
  per-user-private unless explicitly shared) and exposes `--public`
  to flip. Decision 06.
- **`labels attach` is by-name (data mode) only.** OpenAPI `:944`
  documents two mutually exclusive modes — by-id (refers to existing
  label) and by-data (fetch-or-create). The roadmap line uses
  `--name <str>...` (repeating) which is unambiguously the
  fetch-or-create path. By-id mode is **not** surfaced in v1 — agents
  who want id-based attach should use the underlying API directly or
  wait for a future flag. Decision 07.
- **`labels attach` envelope's "already_in_target_state".** Server
  swallows `UniqueConstraintViolationException` server-side and
  returns 200 with no signal whether the label was newly attached or
  already attached (yaml :952). CLI cannot reliably set
  `already_in_target_state` for `attach`. Per spec, the envelope
  **omits the field entirely** for attach (consistent with non-
  absorbing-state writes like `tasks create`). Decision 08.
- **`labels detach` 404 is idempotent.** OpenAPI yaml :1005 says
  detaching a label that's not attached returns 404
  (`ITagForRemoveFromProjectFetcher` → `NotFoundException`). Per
  R11/R13/R22 precedent, the CLI catches HTTP 404 and emits
  `already_in_target_state: true` with exit 0. Two-arm heuristic
  (no 400 fallback — the OpenAPI doesn't document a 400 path).
  Decision 09.
- **`labels delete` is GLOBAL hard-delete.** OpenAPI yaml :917 calls
  this out explicitly: "hard delete of the global label, not a detach
  from one project". User-facing confirmation copy says `Delete N
  labels GLOBALLY (across all projects)?` so a TTY user has a clear
  signal of scope. Decision 10.

## 3. CLI surface

### 3.1 Subcommand registration

New `src/commands/labels.ts` registers a parent `labels` command with
description `"Manage project labels — list, rename, delete, attach to
projects, detach."`. It calls `registerList`, `registerRename`,
`registerDelete`, `registerAttach`, `registerDetach`. Mirrors
`src/commands/reports.ts` shape. The parent command has no own
subcommand action.

### 3.2 `labels list` — flag set

| Flag           | Type     | Required | Purpose                                                                        |
| -------------- | -------- | -------- | ------------------------------------------------------------------------------ |
| `--fields a,b` | string   | no       | Same projection helper as other list commands.                                 |
| (output flags) | (global) | no       | `--output`, `--profile`, etc.                                                  |

No `--project`, no `--page` / `--all`, no `--include-private` /
`--include-public` filters in v1. The endpoint returns one flat array.

### 3.3 `labels rename` — flag set

| Flag             | Type             | Required    | Purpose                                                                       |
| ---------------- | ---------------- | ----------- | ----------------------------------------------------------------------------- |
| `<id>`           | positive integer | yes         | Positional. Numeric label id from `labels list`.                              |
| `--name <str>`   | string           | conditional | New label name. At least one of name/color/private toggle required.           |
| `--color <hex>`  | hex (`#RRGGBB`)  | conditional | New color. Server pattern `^#[0-9a-fA-F]{6}$`. Pre-validated client-side.     |
| `--is-private`   | boolean          | conditional | Flip to private. Mutex with `--is-public`.                                    |
| `--is-public`    | boolean          | conditional | Flip to public. Mutex with `--is-private`.                                    |
| `--dry-run`      | boolean          | no          | Skip the POST; envelope echoes `would: { method, path, body }`.               |

No batch input on rename in v1 (per-row would need rich rows like
R22 `reports edit --stdin`; not in roadmap surface). Only single-id.

### 3.4 `labels delete` — flag set

Byte-compat with `tasks delete` and `reports delete`:

| Flag              | Type             | Required | Purpose                                                                          |
| ----------------- | ---------------- | -------- | -------------------------------------------------------------------------------- |
| `<id>...`         | positive integer | yes/alt  | One or more positional label ids. Mutex with `--ids` / `--stdin`.                |
| `--ids <list>`    | string           | yes/alt  | Comma- or space-separated. Mutex with positional / `--stdin`.                    |
| `--stdin`         | boolean          | yes/alt  | NDJSON rows `{ id }`. Mutex with positional / `--ids`.                           |
| `--dry-run`       | boolean          | no       | Skip the DELETE and the confirmation prompt.                                     |
| `-y, --yes`       | boolean (global) | no       | Bypass confirmation. Required in non-TTY mode.                                   |

### 3.5 `labels attach` — flag set

| Flag              | Type             | Required | Purpose                                                                                |
| ----------------- | ---------------- | -------- | -------------------------------------------------------------------------------------- |
| `--project <id>`  | positive integer | yes      | Numeric project id (target).                                                           |
| `--name <str>...` | string (repeat)  | yes      | One or more label names. Each fans out to one POST. **Fetch-or-create** server-side.   |
| `--color <hex>`   | hex (`#RRGGBB`)  | no       | Color applied to all newly created labels. Existing labels keep their color (server).  |
| `--private`       | boolean          | no       | Default: `is_private: true`. Mutex with `--public`.                                    |
| `--public`        | boolean          | no       | Sets `is_private: false`. Mutex with `--private`.                                      |
| `--dry-run`       | boolean          | no       | Skip every POST; envelope echoes `would` per name.                                     |

Each name → one envelope (one per call). Fan-out is sequential
(continue-on-error per row), mirroring how other batch commands
handle per-row failures. No `--stdin` in v1 (the rows would need
shape `{ name, is_private?, color? }` which we can add later).

### 3.6 `labels detach` — flag set

| Flag              | Type             | Required | Purpose                                                                          |
| ----------------- | ---------------- | -------- | -------------------------------------------------------------------------------- |
| `--project <id>`  | positive integer | yes      | Project to detach from.                                                          |
| `--label <id>...` | positive integer | yes/alt  | One or more label ids (repeating flag). Mutex with `--ids` / `--stdin`.          |
| `--ids <list>`    | string           | yes/alt  | Comma- or space-separated. Mutex with `--label` / `--stdin`.                     |
| `--stdin`         | boolean          | yes/alt  | NDJSON rows `{ label }` (or `{ id }` accepted). Mutex with positional / `--ids`. |
| `--dry-run`       | boolean          | no       | Skip every POST; envelope echoes `would` per id.                                 |

No `--yes` — `detach` is **not** destructive at the workspace level
(label is preserved). The label can always be re-attached.

## 4. API binding

### 4.1 `GET /project-labels/find-available` (yaml :833)

- Path: `/project-labels/find-available`. No query params.
- Response 200: `{ label: ProjectLabel[] }` (yaml :855 — note the
  singular outer key holding an array; same anomaly as `data: { labels: [] }`
  patterns elsewhere).
- Schema: parse with `FindAvailableLabelsResponseSchema` then return
  `{ labels: ProjectLabel[] }` to callers.
- Pagination: none — server returns all entries in one shot.

### 4.2 `POST /project-labels/{labelId}` (yaml :862, edit)

- Verb: POST (decision 01).
- Body: `{ name?, color?, is_private? }`. All optional server-side;
  CLI rejects empty edit (decision 04).
- Color pattern: server-validated `^#[0-9a-fA-F]{6}$` (yaml :895).
  CLI pre-validates with the same regex.
- Response 200: `SuccessResponse` (`{ result: 'success' }`). Body
  carries no echo of the new state. CLI envelope reflects
  `applied_changes` (the user's intent), NOT a server-confirmed
  state.

### 4.3 `DELETE /project-labels/{labelId}` (yaml :905)

- Verb: DELETE.
- No body.
- Response 200: `SuccessResponse`.
- Idempotency: same shape as R22 `reports delete` four-arm but
  simpler. The OpenAPI does not document a 400 fallback for
  "already deleted"; only 404 is observable. So the CLI uses a
  **two-arm heuristic**:
  1. HTTP 404 → `already_in_target_state: true`, exit 0.
  2. Otherwise → re-throw `FreeloApiError`.

### 4.4 `POST /project-labels/add-to-project/{projectId}` (yaml :934)

- Verb: POST.
- Body (data-mode): `{ name: string, is_private: boolean, color?: string }`.
  CLI does not surface id-mode (decision 07).
- Response 200: `SuccessResponse`.
- ACL: 403 if caller lacks project-manager rights for public labels,
  or if the label is private and caller is not the owner (yaml :953).
- Idempotency: server swallows `UniqueConstraintViolationException`
  (yaml :952) when label is already on project — caller cannot
  distinguish first-attach from re-attach. CLI omits
  `already_in_target_state` from the envelope (decision 08).

### 4.5 `POST /project-labels/remove-from-project/{projectId}` (yaml :991)

- Verb: POST (decision 02).
- Body (id-mode): `{ id: number }`. CLI uses id-mode only — `--label
  <id>` is the only surface; data-mode (by name) would require
  re-resolving names client-side, out of scope v1.
- Response 200: `SuccessResponse`.
- Idempotency: 404 when the label isn't attached to the project
  (yaml :1005). CLI catches and emits `already_in_target_state: true`,
  exit 0 (decision 09).

## 5. Envelope schemas

All schemas live in `src/api/schemas/project-label.ts`.

### 5.1 `freelo.labels.list/v1`

```jsonc
{
  "schema": "freelo.labels.list/v1",
  "data": {
    "labels": [
      { "id": 12, "name": "Billable", "color": "#9b59b6", "is_private": false,
        "users_id": 42, "usage_count": 7, "can_be_public": true, "can_be_edited": true }
    ]
  },
  "rate_limit": { "remaining": 999, "reset_at": "..." }
}
```

No `paging` (single-shot endpoint).

### 5.2 `freelo.labels.rename/v1`

Live `data`:
```jsonc
{
  "schema": "freelo.labels.rename/v1",
  "data": {
    "label_id": 12,
    "applied_changes": { "name": "Billable", "color": "#9b59b6", "is_private": false }
  },
  "rate_limit": { ... }
}
```

Dry-run:
```jsonc
{
  "schema": "freelo.labels.rename/v1",
  "dry_run": true,
  "data": {
    "label_id": 12,
    "applied_changes": { "name": "Billable" },
    "would": { "method": "POST", "path": "/project-labels/12", "body": { "name": "Billable" } }
  }
}
```

`applied_changes` carries only fields the user passed; mirrors
`time edit` and `reports edit` for parallelism.

### 5.3 `freelo.labels.delete/v1`

Mirrors `freelo.reports.delete/v1` modulo the field rename
`report_id` → `label_id` and `current_state` literal `"deleted"`.

```jsonc
{
  "schema": "freelo.labels.delete/v1",
  "data": {
    "label_id": 12,
    "previous_state": null,
    "current_state": "deleted",
    "already_in_target_state": false
  },
  "rate_limit": { ... }
}
```

Dry-run adds `would: { method: "DELETE", path: "/project-labels/12", body: {} }`.
`line_index` added in `--stdin` mode (matches R22).

### 5.4 `freelo.labels.attach/v1`

One envelope per `--name`:
```jsonc
{
  "schema": "freelo.labels.attach/v1",
  "data": {
    "project_id": 7,
    "name": "Billable",
    "is_private": false,
    "color": "#9b59b6"
  },
  "rate_limit": { ... }
}
```

Note **no `already_in_target_state`** (decision 08). Dry-run adds
`would: { method: "POST", path: "/project-labels/add-to-project/7", body: {...} }`.

### 5.5 `freelo.labels.detach/v1`

Mirrors `labels.delete/v1` but with both ids:
```jsonc
{
  "schema": "freelo.labels.detach/v1",
  "data": {
    "project_id": 7,
    "label_id": 12,
    "previous_state": null,
    "current_state": "detached",
    "already_in_target_state": false
  },
  "rate_limit": { ... }
}
```

`current_state` literal `"detached"` (not `"deleted"`). Dry-run +
`line_index` rules same as `delete`.

## 6. zod schema design

### 6.1 New file `src/api/schemas/project-label.ts`

- `ProjectLabelSchema` — wire shape (yaml :5025-5044). All fields
  `.nullable().optional()` per the project's permissive policy
  (R05.5 lessons): `id`, `name`, `color`, `is_private`, `users_id`,
  `usage_count`, `can_be_public`, `can_be_edited`. `.passthrough()`
  on the outer object so future fields don't break parsing.
- `FindAvailableLabelsResponseSchema` — `{ label: ProjectLabel[] }`
  with `.passthrough()`.
- Per-envelope `data` schemas:
  - `LabelsListDataSchema` (`{ labels: ProjectLabel[] }`)
  - `LabelsRenameDataSchema` (live + dry-run discriminated by
    `dry_run`)
  - `LabelsDeleteDataSchema` (mirrors `ReportsDeleteDataSchema`)
  - `LabelsAttachDataSchema`
  - `LabelsDetachDataSchema`
- Type exports for each `Data` schema.

### 6.2 New file `src/api/project-labels.ts`

Wire wrappers. Mirrors `src/api/reports.ts` shape:

- `findAvailableLabels(client, opts)` → `{ labels, raw }`
- `editLabelPath(id)` / `deleteLabelPath(id)` (same path, different
  verbs)
- `attachLabelPath(projectId)` / `detachLabelPath(projectId)`
- Body types: `EditProjectLabelBody`, `AttachProjectLabelBody`,
  `DetachProjectLabelBody`
- Body builders: pure mappers omitting unset keys
- Wire functions: `editProjectLabel`, `deleteProjectLabel`,
  `attachLabelToProject`, `detachLabelFromProject` — each takes
  `client`, ids, opts; returns `{ raw }` (or `{ raw, ... }` where
  applicable)

## 7. Edge cases & error matrix

| Trigger                                                                | Class               | Exit | Notes                                                                                  |
| ---------------------------------------------------------------------- | ------------------- | ---- | -------------------------------------------------------------------------------------- |
| `<id>` not positive integer (rename / delete)                          | `ValidationError`   | 2    | Custom parser, NOT Commander's `InvalidArgumentError` (Calibration #2).                |
| `--project` not positive integer (attach / detach)                     | `ValidationError`   | 2    | Same.                                                                                  |
| `--label` (detach) not positive integer                                | `ValidationError`   | 2    | Same.                                                                                  |
| `--color` not `^#[0-9a-fA-F]{6}$`                                      | `ValidationError`   | 2    | Pre-wire reject. Server pattern same.                                                  |
| `labels rename` empty edit (no flags)                                  | `ValidationError`   | 2    | Decision 04.                                                                           |
| `labels rename --is-private --is-public`                               | `ValidationError`   | 2    | Mutex.                                                                                 |
| `labels attach --private --public`                                     | `ValidationError`   | 2    | Mutex.                                                                                 |
| `labels delete` with multiple input sources                            | `ValidationError`   | 2    | Mirrors `reports delete`.                                                              |
| `labels delete` non-TTY without `--yes` (and not `--dry-run`)          | `ConfirmationError` | 2    | Fail closed.                                                                           |
| `labels delete` TTY user declines prompt                               | `ConfirmationError` | 2    | Same code, different message.                                                          |
| Auth 401                                                               | `FreeloApiError`    | 3    | `AUTH_EXPIRED`.                                                                        |
| 403 (private label, not owner; or public-label without manager rights) | `FreeloApiError`    | 4    | `FORBIDDEN`. No friendly hint rewriter v1.                                             |
| 404 on `labels rename` / `labels delete` (label gone)                  | `FreeloApiError`    | 4    | Hard error on rename. **Idempotent** on delete (decision below).                       |
| 404 on `labels delete`                                                 | (success, idem.)    | 0    | `already_in_target_state: true`.                                                       |
| 404 on `labels detach`                                                 | (success, idem.)    | 0    | `already_in_target_state: true`.                                                       |
| 404 on `labels attach` (project gone)                                  | `FreeloApiError`    | 4    | NOT idempotent — project missing is a hard input error.                                |
| 5xx                                                                    | `FreeloApiError`    | 4    | `SERVER_ERROR`, `retryable: true`.                                                     |
| Network failure                                                        | `NetworkError`      | 5    | DNS / refused / timeout.                                                               |
| 429                                                                    | `RateLimitedError`  | 6    | After Freelo's `Retry-After`.                                                          |
| Schema validation fails on response                                    | `ValidationError`   | 2    | Bad Freelo response — agents see the parse error.                                      |

Every typed-error class above gets at least one explicit exit-code
assertion test (Calibration #2).

## 8. Non-goals

- No `--project` filter on `labels list` v1 (decision 03 — deferred).
- No id-mode on `labels attach` v1 (decision 07).
- No name-mode on `labels detach` v1 (data-mode lookup is server-side
  and ambiguous when caller has multiple labels with the same name in
  different is-private states).
- No batch input on `labels rename` (out of roadmap surface; `--stdin`
  with rich rows can land later).
- No coloring of an existing label via `attach` — server reuses the
  existing label as-is (yaml :943: "fetch-or-create … re-uses"). The
  `--color` only applies when a new label is created; CLI passes it
  unconditionally and lets the server decide.
- No `--yes` on `labels rename` / `labels attach` / `labels detach`
  (only `delete` is destructive at the workspace level).
- No `--include-private` / `--include-public` filter on list v1.

## 9. Examples

### 9.1 Inventory (agent JSON)

```bash
$ FREELO_API_KEY=... FREELO_EMAIL=... freelo labels list --output json
{"schema":"freelo.labels.list/v1","data":{"labels":[{"id":12,"name":"Billable","color":"#9b59b6","is_private":false,...}]},"rate_limit":{...}}
```

### 9.2 Rename + recolor

```bash
$ freelo labels rename 12 --name "Billable" --color "#9b59b6" --output json
{"schema":"freelo.labels.rename/v1","data":{"label_id":12,"applied_changes":{"name":"Billable","color":"#9b59b6"}},"rate_limit":{...}}
```

### 9.3 Delete (TTY confirms)

```bash
$ freelo labels delete 12 13
Delete 2 labels GLOBALLY (across all projects)? [y/N] y
Deleted label #12.
Deleted label #13.
```

### 9.4 Attach by name (fetch-or-create fan-out)

```bash
$ freelo labels attach --project 7 --name "Billable" --name "On hold" --color "#9b59b6" --output ndjson
{"schema":"freelo.labels.attach/v1","data":{"project_id":7,"name":"Billable","is_private":true,"color":"#9b59b6"},"rate_limit":{...}}
{"schema":"freelo.labels.attach/v1","data":{"project_id":7,"name":"On hold","is_private":true,"color":"#9b59b6"},"rate_limit":{...}}
```

### 9.5 Detach (idempotent)

```bash
$ freelo labels detach --project 7 --label 12 --label 99999 --output ndjson
{"schema":"freelo.labels.detach/v1","data":{"project_id":7,"label_id":12,"previous_state":null,"current_state":"detached","already_in_target_state":false},...}
{"schema":"freelo.labels.detach/v1","data":{"project_id":7,"label_id":99999,"previous_state":null,"current_state":"detached","already_in_target_state":true},...}
```

(Label 99999 wasn't on project 7 — 404 → idempotent skip.)

## 10. Risks / known gotchas

- **`attach` echoes intent, not ground truth.** Server doesn't tell us
  whether we re-used a label or created one. The envelope reflects
  the user's input; if the agent needs to know which path the server
  took, it must call `labels list` before and after and diff (added
  to the doc page as a footnote).
- **`rename` `applied_changes` is intent, not ground truth.** Server
  returns `{ result: 'success' }`, no echo of the new label state.
  Same caveat as edit-shaped writes elsewhere (`time edit`, `reports
  edit`).
- **`is_private` toggle on rename has ACL coupling.** Per yaml :874,
  ACL on edit applies — the label owner can flip private↔public, but
  a project manager editing a public label may not be able to flip
  it private. Server returns 403 when blocked; CLI surfaces verbatim.
- **`--color` validation.** Both client- and server-side enforce
  `^#[0-9a-fA-F]{6}$`. Three-digit shorthands (`#abc`) fail
  client-side with `ValidationError` exit 2.
- **No batch on `attach` per name pre-validation.** If `--name`
  appears 5 times and the 3rd POST 5xx's, the first two succeeded.
  CLI emits 2 success envelopes + 1 error envelope + 2 more (continue-
  on-error semantics, like other batch writes). Final exit code is
  the `ExitCodeAccumulator` highest-of.

---

## Plan (Phase 3 input)

File-level TODOs. Each numbered item is a single commit-worthy unit.
Several may be squashed into one commit if the changeset stays
coherent.

### P0 — wire layer

1. **`src/api/schemas/project-label.ts`** (new) — `ProjectLabelSchema`,
   `FindAvailableLabelsResponseSchema`, plus the five envelope `Data`
   schemas (`LabelsListDataSchema`, `LabelsRenameDataSchema`,
   `LabelsDeleteDataSchema`, `LabelsAttachDataSchema`,
   `LabelsDetachDataSchema`) and their inferred TS types.
2. **`src/api/project-labels.ts`** (new) — path helpers
   (`editLabelPath`, `attachLabelsPath`, `detachLabelsPath`), body
   types (`EditProjectLabelBody`, `AttachProjectLabelBody`,
   `DetachProjectLabelBody`), pure body builders, and the five wire
   functions: `findAvailableLabels`, `editProjectLabel`,
   `deleteProjectLabel`, `attachLabelToProject`,
   `detachLabelFromProject`. Each function takes `client`, ids, opts;
   returns `{ raw }` (or `{ raw, labels }` for list).

### P1 — commands

3. **`src/commands/labels/list.ts`** (new) — full leaf, `findAvailableLabels`
   call + envelope. Mirrors a stripped-down version of
   `commands/reports/list.ts` (no pagination, no filters).
4. **`src/commands/labels/rename.ts`** (new) — single-id POST. Empty-
   edit validation. Dry-run helper. Mirrors `commands/reports/edit.ts`
   minus batch.
5. **`src/commands/labels/delete.ts`** (new) — full byte-compat with
   `commands/reports/delete.ts` modulo (a) two-arm idempotency (404
   only), (b) field rename `report_id` → `label_id`, (c) confirmation
   message uses "GLOBALLY (across all projects)" copy.
6. **`src/commands/labels/attach.ts`** (new) — one POST per `--name`,
   continue-on-error fan-out, dry-run, no confirmation prompt.
7. **`src/commands/labels/detach.ts`** (new) — one POST per `--label`
   id, two-arm idempotency on 404, dry-run, batch via `--label
   <id>` repeating + `--ids` + `--stdin`.
8. **`src/commands/labels.ts`** (new) — parent registration; calls
   the five `register*` functions.

### P2 — wiring + UI

9. **`src/bin/freelo.ts`** — register `labels` parent.
10. **`src/ui/human/labels-list.ts`** (new) — table renderer
    (id, name, color, is_private, usage_count). Lazy `cli-table3` per
    convention.
11. **`src/ui/human/labels-rename.ts`** (new) — `Renamed label #12 to
    "Billable".` / dry-run variant / `applied_changes` summary line.
12. **`src/ui/human/labels-delete.ts`** (new) — `Deleted label #12.` /
    `Label #12 was already deleted.` / dry-run.
13. **`src/ui/human/labels-attach.ts`** (new) — `Attached "Billable"
    to project #7.` / dry-run.
14. **`src/ui/human/labels-detach.ts`** (new) — `Detached label #12
    from project #7.` / `Label #12 was not attached to project #7.` /
    dry-run.

### P3 — MSW handlers

15. **`test/msw/handlers.ts`** — extend with a `projectLabelsHandlers`
    family: `findAvailableOk(labels)`, `findAvailableUnauthorized()`,
    `findAvailableServerError()`, `findAvailableRateLimited()`,
    `findAvailableNetworkError()`, `editOk()`, `editForbidden()`,
    `editNotFound()`, `editServerError()`, `editRateLimited()`,
    `deleteOk()`, `deleteNotFound()` (idempotent), `deleteForbidden()`,
    `deleteServerError()`, `attachOk()`, `attachOkWhenBody(predicate)`,
    `attachForbidden()`, `attachNotFound()` (project gone — hard error),
    `attachServerError()`, `detachOk()`, `detachOkWhenBody(predicate)`,
    `detachNotFound()` (idempotent), `detachServerError()`.

### P4 — tests

16. **`test/commands/labels/list.test.ts`** — happy path (multiple
    labels), empty array, schema-validation failure, 401 (exit 3),
    5xx (exit 4), network (exit 5), 429 (exit 6), introspect entry.
17. **`test/commands/labels/rename.test.ts`** — happy paths
    (--name, --color, --is-private, --is-public, all together,
    dry-run), validation errors (exit 2 for each: bad id, bad color,
    empty edit, mutex), 404 hard error (exit 4), forbidden (exit 4),
    introspect entry.
18. **`test/commands/labels/delete.test.ts`** — full coverage of the
    two idempotency arms (404 → success; other → throw), dry-run
    skips confirm, non-TTY without `--yes` → exit 2 ConfirmationError,
    `--ids` / `--stdin` / positional path each tested, batch
    continue-on-error, introspect entry. Calibration #4: every new
    `try/catch` arm has at least one assertion.
19. **`test/commands/labels/attach.test.ts`** — single-name, multi-name
    fan-out (each name → its own envelope), `--public` / `--private`
    mutex, `--color` validation, dry-run echoes one `would` per name,
    forbidden / not-found, batch continue-on-error, introspect entry.
20. **`test/commands/labels/detach.test.ts`** — single-id, multi-id
    via `--label` repeat / `--ids` / `--stdin`, 404 idempotent
    (already_in_target_state: true), dry-run, batch continue-on-error,
    introspect entry.

### P5 — docs + changeset

21. **`docs/commands/labels-list.md`** (new) — synopsis, flags,
    envelope, examples, error matrix. Mirrors
    `docs/commands/reports-list.md` structure.
22. **`docs/commands/labels-rename.md`** (new).
23. **`docs/commands/labels-delete.md`** (new) — cross-link to
    `tasks-delete.md` for confirmation policy table; call out
    "GLOBALLY" scope explicitly.
24. **`docs/commands/labels-attach.md`** (new) — explain
    fetch-or-create + the "no `already_in_target_state`" caveat.
25. **`docs/commands/labels-detach.md`** (new) — explain idempotent
    404 arm.
26. **`README.md`** — autogen block; run `pnpm fix:readme`.
27. **`.changeset/<slug>.md`** — `feat(commands): r23 — freelo labels
    list / rename / delete / attach / detach (find-available, POST
    edit, DELETE, POST add/remove)`. Note the three roadmap-vs-API
    reconciliations (PATCH→POST, DELETE→POST, --project deferred) and
    the five new envelope schemas.

### P6 — gates + PR

28. After every commit, on the **committed** tree:
    `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`.
29. Open PR (Yellow tier — no auto-merge). Body calls out:
    - 3 OpenAPI reconciliations (decisions 01-03).
    - 2 deferred behaviors (`--project` filter on list, id-mode on
      attach).
    - The "no already_in_target_state on attach" decision (08).
    - Five new envelope schemas (changeset notes).
