# Requirement — R34 tasklists create / delete / create-from-template

R34 — `freelo tasklists create` / `tasklists delete` / `tasklists create-from-template` (Wave 5, FINAL slice).

Per `docs/roadmap.md` Wave 5 entry:

- **Endpoints (verify all three against `docs/api/freelo-api.yaml`):**
  - `POST /project/{id}/tasklists`
  - `DELETE /tasklist/{id}`
  - `POST /tasklist/create-from-template/{template_id}`
- **CLI surface (per roadmap):**
  - `freelo tasklists create --project <id> --name <str>`
  - `freelo tasklists delete <id> [--yes]`
  - `freelo tasklists create-from-template <template_id> --project <id> --name <str>`
- **Depends on:** R06 (`tasklists show`), R13 (`src/lib/confirm.ts`).
- **Tier expectation:** Yellow (additive commands; minor changeset).

## Run parameters

- allowNetwork: false (MSW only)
- autoShip: false
- budget: defaults (30 min wall clock, 40 agent calls, 8 retries, 25 files)

## Critical: verify ALL THREE OpenAPI body schemas before designing flags

(Drop any flag whose backing field isn't documented; mirror R29/R33 pattern.)

## Reuse — do not reintroduce

- `src/lib/confirm.ts` (R13)
- `src/lib/idempotency.ts` (R11) — surface `already_in_target_state` if delete-of-deleted is a 404 / no-op
- `src/lib/dry-run.ts` (R09) — `--dry-run` mandatory on all three
- Existing `tasklists` group registration in `src/commands/tasklists.ts`
- 400-with-`errors[]` hint pattern from R29/R32/R33

## Calibration §3 amendment (binding for this run)

Final pre-commit gate sequence MUST be:
`pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm fix:readme && pnpm check:readme`
with `pnpm build` IMMEDIATELY before `fix:readme`/`check:readme`, and no source edits in between.

## Last Wave 5 slice

PR body should note this. After merge, Wave 5 is done.
