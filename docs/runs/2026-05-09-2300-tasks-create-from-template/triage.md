# Triage — R39 `tasks create-from-template`

**Tier:** Yellow

## Rationale

- Additive: new subcommand `freelo tasks create-from-template`, new envelope schema `freelo.tasks.create-from-template/v1`.
- No touch to `src/config/`, `src/api/client.ts`, `src/errors/handle.ts`, release tooling, TLS/retry/redirect defaults.
- No new runtime dependency.
- No removed/renamed/retyped existing fields → no schema break.
- Single endpoint. Single command. Smallest Wave 6 slice.
- Direct precedent exists: spec 0047 (`tasklists create-from-template`) — same endpoint family, same CLI shape pattern, same hint-mapping.

## Triggers matched

| Trigger | Status |
|---|---|
| New user-visible command (additive) | yes → Yellow |
| Changeset: minor | yes → Yellow |

## Triggers NOT matched (would have escalated)

- No auth/config/client touch → not Red.
- No breaking change → not Red.
- No new dependency → not Red.

## Route flags

- `requiresFreeloApi`: **true** — body shape mismatch between roadmap (`--tasklist`, `--name`) and OpenAPI (`task_id` required, `target_project_id`, `target_tasklist_id`, `preset_date_from`, `users_ids` optional). Spec phase must reconcile (precedent: R34 spec 0047 did exactly this for the sibling endpoint).
- `needsSecurityReview`: **false** — no auth surface, no secrets, no shell-out, no path traversal vectors.
- `preApprovedDeps`: `[]` — no new deps expected.

## Pre-approved decisions for the autonomous flow

- Recreate the spec-0047 surface for the sibling endpoint (`--source-task` instead of `--source-tasklist`, plus the same `--target-project` / `--target-tasklist` / `--date-start` / `--worker` flags). The roadmap's `--tasklist <id>` becomes `--target-tasklist`. The roadmap's `--name` is **dropped** — OpenAPI documents no `name` body field for this endpoint, and we never invent fields (CLAUDE.md hard rule).
- New file pair: `src/api/tasks-create-from-template.ts` + `src/api/schemas/task-create-from-template.ts`.
- Mandatory: `test/api/tasks-create-from-template.test.ts` exercising `signal` + `requestId` opt-spread branches (calibration §4 — repeat of R38 PR #96 fix).
