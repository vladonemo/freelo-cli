# Spec 0034 — R22 `freelo reports log` / `reports edit` / `reports delete`

**Slice:** R22 (writes for the work-reports resource)
**Run:** `2026-04-29-1200-r22-reports-write`
**Depends on:** R21 (spec 0033 — `freelo reports list`, `WorkReportFullSchema`,
the `reports` command tree).
**Adds:** three commands, three envelope schemas, four MSW handler families.
**Tier:** Yellow (additive new commands; one destructive).

---

## 1. Problem

R21 shipped read access to work reports. R22 closes the loop with the three
write paths: log a finalized work report directly on a task (bypassing the
live timer flow), amend an existing report, and remove one. Without these,
agents that consume `reports list` can't repair time data — they have to
fall back to the Freelo web UI or to the live timer (`time start` / `time
stop`), which is a poor fit for retroactive timesheet entry.

The slice is the **first to introduce a destructive command** on the
`reports` resource and the **first to support batch input on three different
write commands at once** in a single PR. The destructive command must reuse
the shared `confirmDestructive` helper (R13) and follow the same idempotency
discipline (`already_in_target_state` semantics from `src/commands/tasks/delete.ts`).

## 2. Proposal

Add three leaf commands under the existing `reports` command tree (R21,
spec 0033):

```
freelo reports log    --task <id>  --minutes <n>  [--date YYYY-MM-DD]  [--note <str>]  [--dry-run]  [--ids ...] [--stdin]
freelo reports edit   <id>         [--minutes <n>] [--note <str>] [--date YYYY-MM-DD]  [--dry-run]  [--ids ...] [--stdin]
freelo reports delete <id>...      [--yes] [--dry-run] [--ids ...] [--stdin]
```

Each binds 1-1 to the documented Freelo endpoint (see §4). Each emits a
versioned envelope (§3.3). Each is agent-safe per the conventions doc
(`--dry-run` on log/edit, `--yes` on delete, batch input across all three).

## 3. CLI surface

### 3.1 Subcommand registration

Extend `src/commands/reports.ts` to also call `registerLog`, `registerEdit`,
`registerDelete`. Update the parent description from R21's read-only blurb
to "browse, log, amend, and remove work reports". Each leaf is a sibling
of `list` (no nesting). Mirrors `time` and `tasks` shape.

### 3.2 `reports log` — flag set

| Flag                | Type             | Required | Purpose                                                                         |
| ------------------- | ---------------- | -------- | ------------------------------------------------------------------------------- |
| `--task <id>`       | positive integer | yes      | The numeric task id to log time against. Maps to URL path segment.              |
| `--minutes <n>`     | positive integer | yes      | The duration in whole minutes. Wire body field `minutes`.                       |
| `--date <YYYY-MM-DD>` | ISO date       | no       | Backdate the report. Wire body field `date_reported`. Defaults to server "today". |
| `--note <str>`      | string           | no       | Free-form note. Wire body field `note`. Empty string accepted by server.        |
| `--dry-run`         | boolean          | no       | Skip the POST; envelope echoes `would: { method, path, body }`.                 |
| `--ids <list>`      | string           | no       | (deferred — see §3.5) Comma-separated tasks; equivalent to `--stdin` with rows. |
| `--stdin`           | boolean          | no       | Read NDJSON rows `{ task, minutes, date?, note? }`. Mutex with single-mode flags. |

Single-mode is the default. Batch mode requires `--stdin` (or `--ids`, see
§3.5). `--cost` is **not** exposed in v1 — see decision 03.

### 3.3 `reports edit` — flag set

| Flag                | Type             | Required | Purpose                                                                       |
| ------------------- | ---------------- | -------- | ----------------------------------------------------------------------------- |
| `<id>`              | positive integer | yes      | Positional. The work-report id from `reports list`.                           |
| `--minutes <n>`     | positive integer | conditional | At least one of `--minutes` / `--note` / `--date` is required (empty edit rejected). |
| `--note <str>`      | string           | conditional | Empty string allowed.                                                         |
| `--date <YYYY-MM-DD>` | ISO date       | conditional | Wire body field `date_reported`.                                              |
| `--dry-run`         | boolean          | no       | Skip the POST; envelope echoes `would`.                                       |
| `--ids <list>`      | string           | no       | (deferred — see §3.5)                                                         |
| `--stdin`           | boolean          | no       | Read NDJSON rows `{ id, minutes?, note?, date? }`. Mutex with positional `<id>`. |

`--task` (re-parent) and `--cost` are **not** surfaced — out of scope per
roadmap CLI block.

### 3.4 `reports delete` — flag set

| Flag                | Type             | Required | Purpose                                                                          |
| ------------------- | ---------------- | -------- | -------------------------------------------------------------------------------- |
| `<id>...`           | positive integer | yes      | One or more positional work-report ids. Mutex with `--ids` and `--stdin`.        |
| `--ids <list>`      | string           | yes/alt  | Comma- or space-separated list. Mutex with positional and `--stdin`.             |
| `--stdin`           | boolean          | yes/alt  | Read NDJSON rows `{ id }`. Mutex with positional and `--ids`.                    |
| `--dry-run`         | boolean          | no       | Skip the DELETE and the confirmation prompt; envelope echoes `would`.            |
| `-y, --yes`         | boolean (global) | no       | Bypass confirmation. **Required** in non-TTY mode (otherwise exit 2).            |

Mirrors `tasks delete` byte-compat — same input shapes, same confirmation
policy, same idempotency envelope shape.

### 3.5 Batch input — design

- **`reports log --stdin`** accepts NDJSON rows of shape
  `{ task: int, minutes: int, date?: "YYYY-MM-DD", note?: string }`.
  Mirrors R12.5 (`tasks create --stdin`) and R20 patterns. Per-line
  `--task` and `--minutes` are required; per-line `--date` and `--note`
  are optional; unknown keys rejected via `.strict()`.
  Single-mode flags (`--task`, `--minutes`, `--date`, `--note`) are
  rejected when `--stdin` is set (mutex — keeps the call set unambiguous).
- **`reports edit --stdin`** accepts rows
  `{ id: int, minutes?: int, note?: string, date?: "YYYY-MM-DD" }`. At
  least one of `minutes` / `note` / `date` per row (empty per-row edit
  rejected). Single-mode positional `<id>` and flags are mutex with `--stdin`.
- **`reports delete --stdin`** accepts rows `{ id: int }`. Same as
  R13's `tasks delete --stdin`.

`--ids` is **not** implemented for `reports log` (no semantic meaning — log
needs minutes per row) and is implemented for `reports edit` only as a
path to multi-id no-op (every row needs at least one change flag, which
can't be different per id). Therefore in v1:

- `reports log`: `--stdin` only (no `--ids`).
- `reports edit`: `--stdin` only (no `--ids`).
- `reports delete`: positional, `--ids`, `--stdin` — full byte-compat with
  R13 `tasks delete`.

This narrows the diff while keeping the destructive command's batch surface
maximal.

## 4. API binding

### 4.1 `POST /task/{task_id}/work-reports` (yaml :3045-3093)

- Path: `/task/{task_id}/work-reports`. Encoded via `createReportPath(taskId)`.
- Body: `{ minutes: int, date_reported?: date, note?: string }`.
  CLI does not send `worker_id` (defaults to caller) or `cost` (server
  derives from rate × minutes — see decision 03).
- Response 200: `WorkReport` (yaml :5669-5698). Reuse the existing
  `WorkReportFullSchema` from R21 — it's a superset of `WorkReport` and
  successfully validates the smaller shape (`.passthrough()` on the
  embedded refs absorbs the missing `tasklist` block).
- 400 `WorkReportCanNotBeCreatedException` / `WorkerHasNoAccessToTasklistException`
  → `FreeloApiError` exit 4. No friendly hint rewriter in v1 (Freelo's
  message text is already explicit).

### 4.2 `POST /work-reports/{work_report_id}` (yaml :3095-3143)

- Path: `/work-reports/{work_report_id}`. Verb is **POST**, not PATCH —
  see decision 01.
- Body: `{ minutes?, note?, date_reported? }`. (CLI omits `task_id` and
  `cost` — out of scope.) At least one field must be present client-side
  (empty edit rejected with `ValidationError` exit 2).
- Response 200: `WorkReport`. Reuse `WorkReportFullSchema`.
- ACL: 404 (`NotFoundException`) when the caller is not author /
  owner / commander. The CLI does **not** rewrite this — agents see the
  raw `NOT_FOUND` exit 4 and can decide whether to treat it as missing or
  as forbidden.

### 4.3 `DELETE /work-reports/{work_report_id}` (yaml :3144-3171)

- Path: `/work-reports/{work_report_id}`. Reuses the same
  `editReportPath(id)` helper (same path).
- No body.
- Response 200: `SuccessResponse` (`{ result: "success" }`). Body is
  not surfaced — `current_state` is derived from the verb.
- Idempotency: four-arm heuristic per decision 02:
  1. 404 → `already_in_target_state: true`, exit 0.
  2. 400 + body text matches `/not found|does not exist/i` →
     `already_in_target_state: true`, exit 0.
  3. 400 + body contains `UserCannotDeleteWorkReport` → hard
     `FreeloApiError` exit 4 (ACL).
  4. Otherwise → re-throw `FreeloApiError`.

## 5. Envelope schemas

### 5.1 `freelo.reports.log/v1`

Live `data`:
```jsonc
{
  "schema": "freelo.reports.log/v1",
  "data": {
    "report": <WorkReportProjection>,
    "applied_input": { "task_id": 4567, "minutes": 90, "date_reported": "2026-04-25", "note": "WIP" }
  },
  "rate_limit": { "remaining": 999, "reset_at": "..." }
}
```

Dry-run `data`:
```jsonc
{
  "schema": "freelo.reports.log/v1",
  "dry_run": true,
  "data": {
    "applied_input": { ... },
    "would": { "method": "POST", "path": "/task/4567/work-reports", "body": { "minutes": 90, ... } }
  }
}
```

`WorkReportProjection` is the public-contract shape — same field set as
`TimeStopWorkReport` from spec 0032 (R20 reused for shape consistency
across the resource), with `id`, `date_add`, `date_reported`, `minutes`,
`note`, `task`, `cost`, `worker`, `author`. Defined in
`src/api/schemas/report.ts` as `ReportLogWorkReportSchema` (or simply
re-exported as `WorkReportProjection` for sharing).

`applied_input` is a flat echo of what the user passed — stable for
agent diffs. Mirrors `time.edit/v1`'s `applied_changes`.

In `--stdin` batch mode, each emitted envelope additionally carries
`data.line_index` (0-indexed across non-empty stdin lines). Mirrors
`tasks delete --stdin`.

### 5.2 `freelo.reports.edit/v1`

Live `data`:
```jsonc
{
  "schema": "freelo.reports.edit/v1",
  "data": {
    "report": <WorkReportProjection>,
    "applied_changes": { "minutes": 60, "note": "Updated" }
  },
  "rate_limit": { "remaining": 998, "reset_at": "..." }
}
```

Dry-run:
```jsonc
{
  "schema": "freelo.reports.edit/v1",
  "dry_run": true,
  "data": {
    "applied_changes": { "minutes": 60 },
    "would": { "method": "POST", "path": "/work-reports/9001", "body": { "minutes": 60 } }
  }
}
```

Same `line_index` rule for `--stdin` batch.

### 5.3 `freelo.reports.delete/v1`

Same shape as `freelo.tasks.delete/v1` modulo `task_id` → `report_id`:

```jsonc
{
  "schema": "freelo.reports.delete/v1",
  "data": {
    "report_id": 9001,
    "previous_state": null,
    "current_state": "deleted",
    "already_in_target_state": false
  },
  "rate_limit": { ... }
}
```

Dry-run:
```jsonc
{
  "schema": "freelo.reports.delete/v1",
  "dry_run": true,
  "data": {
    "report_id": 9001,
    "previous_state": null,
    "current_state": "deleted",
    "already_in_target_state": false,
    "would": { "method": "DELETE", "path": "/work-reports/9001", "body": {} }
  }
}
```

`current_state` is a string literal `"deleted"` (the only legal value in v1
— work reports have no archived/finished states).

## 6. zod schema design

`src/api/schemas/report.ts` (extend, do **not** duplicate):

- **Reuse** `WorkReportFullSchema` for parsing all three endpoints'
  responses. The R21 schema is permissive (every embedded ref
  `.passthrough()`, every leaf `.nullable().optional()`), so the leaner
  `WorkReport` (no `tasklist`) still validates without modification.
- **Add** `ReportProjectionSchema` — the public-contract projection. Same
  fields as `TimeStopWorkReportSchema` from spec 0032: tightened inner refs,
  no `.passthrough()`, all nullable fields normalized to `null`.
- **Add** `ReportsLogLiveDataSchema`, `ReportsLogDryRunDataSchema`,
  `ReportsEditLiveDataSchema`, `ReportsEditDryRunDataSchema`,
  `ReportsDeleteDataSchema` (mirrors `TasksDeleteDataSchema`).
- **Add** `ReportsLogAppliedInputSchema`, `ReportsEditAppliedChangesSchema`
  — the flat echoes carried on the live envelopes.

## 7. Edge cases & error matrix

| Trigger                                                                                  | Class                | Exit | Notes                                                                                |
| ---------------------------------------------------------------------------------------- | -------------------- | ---- | ------------------------------------------------------------------------------------ |
| `--minutes 0` / negative / non-int                                                       | `ValidationError`    | 2    | Pre-wire reject. Server may also reject but we fail fast.                            |
| `--date` not `YYYY-MM-DD` / invalid calendar date                                        | `ValidationError`    | 2    | Reuses R21 `parseDateFlag`.                                                          |
| `<id>` not positive integer                                                              | `ValidationError`    | 2    | Custom parser (not Commander's `InvalidArgumentError`).                              |
| `reports edit` with no change flag and no `<id>`-only path                               | `ValidationError`    | 2    | Empty edit; mirrors `time edit` policy.                                              |
| `reports log --stdin` with single-mode flags also set                                    | `ValidationError`    | 2    | Mutex error.                                                                         |
| `reports delete` non-TTY without `--yes` or `--dry-run`                                  | `ConfirmationError`  | 2    | Fail closed before any wire call.                                                    |
| `reports delete` TTY user declines prompt                                                | `ConfirmationError`  | 2    | Same code, different message.                                                        |
| Auth missing / 401                                                                       | `FreeloApiError`     | 3    | `AUTH_EXPIRED`.                                                                      |
| 403                                                                                      | `FreeloApiError`     | 4    | `FORBIDDEN`. (Freelo more often returns 404 to hide existence; rare path.)           |
| 404 on `reports edit`                                                                    | `FreeloApiError`     | 4    | `NOT_FOUND`. ACL-as-404 is documented.                                               |
| 404 on `reports delete`                                                                  | (success, idempotent)| 0    | `already_in_target_state: true`.                                                     |
| 400 on `reports delete`, body text contains "not found" / "does not exist"                | (success, idempotent)| 0    | `already_in_target_state: true`. Decision 02 arm 2.                                  |
| 400 on `reports delete`, body contains `UserCannotDeleteWorkReport`                       | `FreeloApiError`     | 4    | ACL hard error. Decision 02 arm 3.                                                   |
| 400 `WorkReportCanNotBeCreatedException` on `reports log`                                | `FreeloApiError`     | 4    | Other 4xx; bubbles unchanged.                                                        |
| 5xx                                                                                      | `FreeloApiError`     | 4    | `SERVER_ERROR`, `retryable: true`.                                                   |
| Network failure                                                                          | `NetworkError`       | 5    | DNS / refused / timeout.                                                             |
| 429                                                                                      | `RateLimitedError`   | 6    | After Freelo's `Retry-After` window.                                                 |

## 8. Non-goals

- No `--cost` flag on log / edit (decision 03).
- No `--task` re-parent flag on edit (out of scope per roadmap).
- No `--worker` flag on log (out of scope per roadmap; agent uses the
  caller's identity).
- No `--all` / pagination semantics (these are write commands).
- No client-side cache or batch-aware rate-limit pacing (single sequential
  calls, like every prior batch write).
- No money helper (`src/lib/money.ts`) in this slice (decision 03).

## 9. Examples

### 9.1 `reports log` (basic, agent JSON)

```bash
$ FREELO_API_KEY=... FREELO_EMAIL=... freelo reports log \
    --task 4567 --minutes 90 --note "Wired up the dashboard" --output json
{"schema":"freelo.reports.log/v1","data":{"report":{"id":7001,"minutes":90,"task":{"id":4567,"name":"..."},...},"applied_input":{"task_id":4567,"minutes":90,"note":"Wired up the dashboard"}},"rate_limit":{...}}
$ echo $?
0
```

### 9.2 `reports edit` (dry-run; agent uses to inspect call set first)

```bash
$ freelo reports edit 7001 --minutes 60 --dry-run --output json
{"schema":"freelo.reports.edit/v1","dry_run":true,"data":{"applied_changes":{"minutes":60},"would":{"method":"POST","path":"/work-reports/7001","body":{"minutes":60}}}}
```

### 9.3 `reports delete` (batch via stdin, agent-safe)

```bash
$ cat <<EOF | freelo reports delete --stdin --yes --output ndjson
{"id": 7001}
{"id": 7002}
{"id": 99999}
EOF
{"schema":"freelo.reports.delete/v1","data":{"report_id":7001,"current_state":"deleted","already_in_target_state":false,"line_index":0},...}
{"schema":"freelo.reports.delete/v1","data":{"report_id":7002,"current_state":"deleted","already_in_target_state":false,"line_index":1},...}
{"schema":"freelo.reports.delete/v1","data":{"report_id":99999,"current_state":"deleted","already_in_target_state":true,"line_index":2},...}
$ echo $?
0
```

(99999 didn't exist; the 404 was idempotent-skipped.)

## 10. Risks / known gotchas

- **400-vs-404 idempotency heuristic.** The body-text match is best-effort
  in v1. If Freelo changes the message, update the regex and capture a
  fixture. Decision 02.
- **`reports edit` on an invoiced project.** Edits may be silently rejected
  by the server with `WorkReportCanNotBeEditedException` (yaml :3111). v1
  surfaces this as a generic `FREELO_API_ERROR` exit 4 — agents see Freelo's
  message verbatim.
- **`reports edit --stdin` empty per-row edit.** Each row must carry at
  least one of `minutes` / `note` / `date`. Empty-edit rows fail per-line
  with `VALIDATION_ERROR` (exit 2 via the highest-of accumulator).

---

## Plan (Phase 3 input)

File-level TODOs. Each numbered item is a single commit-worthy unit
(though several may be squashed into one commit if the changeset stays
coherent).

### P0 — wire layer

1. **`src/api/reports.ts`** — extend with three exported functions and two
   path helpers:
   - `export const createReportPath = (taskId: number) => '/task/${taskId}/work-reports'`
   - `export const reportPath = (id: number) => '/work-reports/${id}'`
   - `export type CreateReportBody = { minutes, date_reported?, note? }`
   - `export type EditReportBody  = { minutes?, date_reported?, note? }`
   - `export function buildCreateReportBody(input)` — pure mapper
   - `export function buildEditReportBody(input)` — pure mapper
   - `export async function createReport(client, taskId, opts)` —
     POST, returns `{ report: WorkReportFull, raw }`
   - `export async function editReport(client, id, opts)` — POST,
     returns `{ report: WorkReportFull, raw }`
   - `export async function deleteReport(client, id, opts)` — DELETE,
     returns `{ raw }`. Schema is the local `SuccessResponseSchema`
     (mirrors `tasks-delete.ts`).

### P1 — schemas

2. **`src/api/schemas/report.ts`** — extend with:
   - `ReportProjectionSchema` (tightened from `WorkReportFullSchema`)
   - `ReportsLogAppliedInputSchema`, `ReportsEditAppliedChangesSchema`
   - `ReportsLogLiveDataSchema`, `ReportsLogDryRunDataSchema`
   - `ReportsEditLiveDataSchema`, `ReportsEditDryRunDataSchema`
   - `ReportsDeleteDataSchema` (mirrors `TasksDeleteDataSchema`)
   - `projectWorkReport(wire)` — pure projection function. Mirrors
     `projectWorkReport` from `src/commands/time/stop.ts:171-199` byte-
     for-byte modulo the type name. Exported here (not in `time/stop.ts`)
     so reports commands import it without dragging in a leaf-command
     module. Update `time/stop.ts` to re-export if the cross-module pull
     gets ugly; otherwise leave the existing copy alone.

### P2 — commands

3. **`src/commands/reports/log.ts`** — full leaf with single-mode and
   `--stdin` batch. Pattern: hybrid of `tasks/create.ts` (rich NDJSON
   batch) and `time/start.ts` (write with response projection).
4. **`src/commands/reports/edit.ts`** — single-mode positional + `--stdin`
   batch with rich rows. Empty-edit validation per spec §3.3.
5. **`src/commands/reports/delete.ts`** — full byte-compat with
   `tasks/delete.ts` modulo (a) idempotency four-arm heuristic, (b) field
   rename `task_id` → `report_id`, (c) human-renderer wording.

### P3 — wiring + UI

6. **`src/commands/reports.ts`** — add `registerLog`, `registerEdit`,
   `registerDelete` calls. Update parent description.
7. **`src/ui/human/reports-log.ts`** — human renderer: `Logged 90m on
   task #4567 (report #7001).` + dry-run variant.
8. **`src/ui/human/reports-edit.ts`** — `Edited report #7001 (...).`
9. **`src/ui/human/reports-delete.ts`** — `Deleted report #7001.` /
   `Report #7001 was already deleted.` / `(dry-run) Would delete report #7001.`

### P4 — MSW handlers

10. **`test/msw/handlers.ts`** — extend with a `workReportsWriteHandlers`
    family covering:
    - `createOk(report)`, `createOkWhenBody(predicate, report)`
    - `createBadRequest(msg, status?)`, `createUnauthorized()`,
      `createServerError(status?)`, `createRateLimited()`,
      `createNetworkError()`
    - `editOk(report)`, `editOkWhenBody(predicate, report)`
    - `editNotFound()`, `editServerError()`
    - `deleteOk()`, `deleteNotFound()` (404 — idempotent arm 1),
      `deleteBadRequestNotFound()` (400 + "not found" body — idempotent
      arm 2), `deleteBadRequestAcl()` (400 + `UserCannotDeleteWorkReport`
      — hard error arm 3), `deleteUnauthorized()`, `deleteServerError()`,
      `deleteRateLimited()`.

### P5 — tests

11. **`test/commands/reports/log.test.ts`** — happy paths (single-mode
    minimal / full / dry-run / `--stdin`), validation
    (every typed error has explicit exitCode assertion per Calibration §2),
    HTTP errors (401/400/5xx/network/429), schema-validation 200, batch
    continue-on-error, introspect entry.
12. **`test/commands/reports/edit.test.ts`** — same skeleton; empty-edit,
    `<id>` validation, change-flag round-trip, `--stdin` batch with
    per-row empty-edit rejection.
13. **`test/commands/reports/delete.test.ts`** — full coverage of the
    four idempotency arms (each with its own `it(...)`), confirmation
    policy in non-TTY, `--ids` / `--stdin` / positional, dry-run skips
    confirmation, introspect entry.

### P6 — docs + changeset

14. **`docs/commands/reports-log.md`** — full page (synopsis, flags,
    envelope, examples, error matrix). Mirrors `docs/commands/time-stop.md`
    structure.
15. **`docs/commands/reports-edit.md`** — same shape.
16. **`docs/commands/reports-delete.md`** — same shape; cross-link to
    `tasks-delete.md` for the confirmation policy table.
17. **`docs/getting-started.md`** — add `reports log` to the daily-driver
    section (right next to `time start` / `time stop`). It IS a sensible
    new-user entry point — "I worked 30 minutes Friday, log it" is more
    common than starting a live timer.
18. **`README.md`** — autogen block; run `pnpm fix:readme` and commit.
19. **`.changeset/<slug>.md`** — minor bump:
    `feat(commands): r22 — freelo reports log / reports edit / reports
    delete (POST /task/{id}/work-reports, POST/DELETE /work-reports/{id})`.
    Note the three new envelope schemas and the deferred roadmap PATCH→POST
    reconciliation.

### P7 — gates + PR

20. After every commit, on the **committed** tree:
    `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`.
21. Open PR (Yellow tier — no auto-merge). Body calls out the roadmap
    PATCH→POST reconciliation pending in a follow-up, the four-arm delete
    idempotency, and the deferred money helper.
