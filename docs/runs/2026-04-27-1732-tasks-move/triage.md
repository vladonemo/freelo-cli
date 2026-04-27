# Triage — R12 `freelo tasks move <id>`

**Run:** 2026-04-27-1732-tasks-move
**Tier:** **Yellow**
**Branch:** `feat/tasks-move`

## Rationale

R12 is additive:

- **New user-visible command** (`freelo tasks move`) → Yellow trigger.
- **New envelope schema** `freelo.tasks.move/v1` (additive, distinct discriminant).
- **Minor changeset** (new public command + new schema string).
- **No auth / config / HTTP client / TLS / retry / redirect** changes.
- **No new dependencies.**
- **No breaking change** to existing envelope schemas, exit codes, or flag names.
- **No security-sensitive surface** (no secret storage, no auth flow, no config write).

Hits the Yellow column cleanly. No Red triggers (no breaking change, no `src/config/`
or `src/api/client.ts` touched, no major dep change, no auth/TLS work).

## Route flags

- `needsSecurityReview`: **false** — R12 doesn't touch auth/config/secrets.
- `requiresFreeloApi`: **false** for re-fetch — `docs/api/freelo-api.yaml` :1842-1891
  fully documents the endpoint, including all body fields (`work_reports_action`,
  `custom_fields_action`, `multi_project_task.source_tasklist_id`) and the path-vs-body
  parameter semantics. **`--to-project` is implied** by the destination tasklist
  ("Target project is derived from `tasklist_id`" — OpenAPI :1906) and is a CLI-side
  guard (refuse the move if the target tasklist's project doesn't match the requested
  `--to-project`).
- `preApprovedDeps`: `[]` — no new deps allowed.

## Risks observed at triage

1. **Cross-project semantics** — a destination tasklist's project may differ from the
   source task's project. The CLI should not require `--to-project`; when supplied, it
   serves as a **client-side assertion** that the target tasklist's project equals the
   requested one (else `VALIDATION_ERROR`). Architect to confirm via spec.
2. **Idempotency** — moving to the current tasklist is a no-op success
   (`already_in_target_state: true`), pre-check via `GET /task/{id}` and compare
   `data.tasklist.id`. Reuses `src/lib/idempotency.ts` from R11.
3. **Body field choices** — R12 ships the simplest case: cross-project with default
   `work_reports_action: 'move_to_target_project'` and `custom_fields_action: 'nothing'`.
   Non-default body fields are out of scope for v1 — defer to a follow-up R12.5 if
   needed.

## Pre-approved decisions (autonomous)

- Reuse `src/lib/idempotency.ts` (already available from R11).
- Reuse the per-id batch loop / NDJSON / exit-accumulator infra (already available
  from R09/R11).
- Reuse `getTaskDetail` for the pre-check GET.
- New file: `src/api/tasks-move.ts` for the wire wrapper.
- New file: `src/commands/tasks/move.ts` for the leaf command (parallels
  `src/commands/tasks/edit.ts` shape).
- New file: `src/ui/human/tasks-move.ts` for the human renderer.
- Schema lives alongside in `src/api/schemas/task.ts` as `TasksMoveDataSchema`.
