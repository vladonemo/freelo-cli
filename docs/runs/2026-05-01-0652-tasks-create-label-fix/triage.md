# Triage — 2026-05-01-0652-tasks-create-label-fix

**Tier:** Yellow

## Rationale

Touches a public envelope contract: `freelo.tasks.create/v1 → /v2`.

- **Yellow signal**: `data.applied_labels` is added (additive field).
- **Red signal candidate**: `data.would` retypes object → array (breaking).
  Treated as Yellow because (1) the spec records the change as `patch` per
  pre-1.0 convention, (2) the v1 emit path was dead surface (only reachable
  via a code path that returns 400 from the live API), (3) human ratified by
  merging spec 0041 (PR #77).

## Route flags

- needsSecurityReview: false — no auth/config/HTTP-client-defaults touched.
- requiresFreeloApi: false — fixtures already exist in `docs/api/freelo-api.yaml`
  (the live wire shape was probed by hand and recorded in the spec).
- preApprovedDeps: [] — no new dependencies expected.

## Flow

Yellow: full pipeline → open PR → leave for human review.
Auto-merge NOT enabled.

## Files in scope

- `src/api/tasks-create.ts`
- `src/commands/tasks/create.ts`
- `src/api/schemas/task.ts` (the `data` schema for tasks-create)
- `src/ui/human/tasks-create.ts`
- `test/commands/tasks/create.test.ts` (extend)
- `test/api/tasks-create.test.ts` (extend)
- `test/msw/handlers.ts` (extend `tasksCreateHandlers`)
- `docs/commands/tasks-create.md`
- `.changeset/<new>.md`
- `README.md` (autogen Commands block — likely no diff for a fix)
