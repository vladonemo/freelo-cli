# Triage — R30 projects archive/activate/delete

**Run:** 2026-05-09-0917-r30-projects-archive-activate-delete

## Tier: **Yellow**

## Rationale

Triggers (per `.claude/docs/autonomous-sdlc.md` § Risk tiers):

- **New user-visible commands** (additive): `projects archive`, `projects activate`, `projects delete` — three new leaves under an existing parent.
- **New envelope schemas** (additive, backwards-compatible): `freelo.projects.archive/v1`, `freelo.projects.activate/v1`, `freelo.projects.delete/v1`. No existing schema is touched.
- **Changeset:** `minor` (new commands).
- **No new dependencies.**
- **No auth, config, HTTP-client, TLS/retry/redirect changes.**
- **No breaking changes** (no existing flag/exit-code/envelope-field changes).

Yellow upper bound is uncomfortable because three commands in one slice is at the edge of "fits in one spec". Mitigation: the three commands share heavy cross-resource infrastructure (idempotency, confirm, dry-run, the same `getProjectDetail` pre-check pattern, the same wire-empty-body POST/DELETE), so they decompose naturally into:

- One shared transition module (`src/commands/projects/transition.ts`) for `archive` + `activate` (mirroring `tasks/transition.ts` for `finish` / `reopen`).
- One destructive module (`src/commands/projects/delete.ts`) mirroring `tasks/delete.ts`.
- One wire-wrapper file `src/api/projects-transition.ts` for the two POSTs and one wire-wrapper file `src/api/projects-delete.ts` for the DELETE.

The file count is roughly 2× a single absorbing-state slice, but the per-file complexity is the same as R11 / R13. If the architect agent decides the spec balloons past 600 lines, we pause; otherwise one spec is fine.

## Route flags

- `requiresFreeloApi`: false — the three endpoints are already documented in `docs/api/freelo-api.yaml` (verified at lines 557–581 for DELETE, 621–647 for archive, 649–674 for activate).
- `needsSecurityReview`: false — no auth/config/HTTP-client changes. (`projects delete` is destructive but reuses the audited R13 confirm helper unchanged.)
- `preApprovedDeps`: [] — no new deps expected.

## Reuse confirmed

- `src/lib/confirm.ts` (R13) — for `projects delete`.
- `src/lib/idempotency.ts` (R11) — for `projects archive` / `projects activate`.
- `src/lib/batch.ts` (R09) — for `--ids` / `--stdin` on all three.
- `src/lib/dry-run.ts` (R09) — for `--dry-run` on all three.
- `src/api/projects.ts` `getProjectDetail` (R04) — for the absorbing-state pre-check.
- `src/commands/tasks/transition.ts` (R11) — structural template for `projects/transition.ts`.
- `src/commands/tasks/delete.ts` (R13) — structural template for `projects/delete.ts`.

## OpenAPI verification

- `POST /project/{project_id}/archive` (yaml :621-647): empty body, 200 SuccessResponse, idempotent (per yaml :635 "calling it on an already archived project succeeds (200) without side effects").
- `POST /project/{project_id}/activate` (yaml :649-674): empty body, 200 SuccessResponse, dual semantics (un-archive AND un-delete, "if otherwise no-op returning 200" per yaml :662).
- `DELETE /project/{id}` (yaml :557-581): no body, 200 SuccessResponse, soft-delete (yaml :569 "POST /project/{id}/activate restores it").

## Decision: proceed to spec phase, single spec, single PR.
