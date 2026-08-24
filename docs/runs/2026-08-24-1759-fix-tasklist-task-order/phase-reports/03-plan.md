# Phase 3 — Plan

**Status:** complete, not executable
**Output:** `## Plan` section appended to `docs/specs/0060-tasklist-task-order.md`

Written despite the spec being blocked, so `/resume` executes a reviewed contract instead of
re-deriving one under time pressure. Every TODO is gated on the §11 resolution.

- **Slice 0** — resolve §11 (human / networked). Gates everything.
- **Slice 1** — code (Option B only): `src/api/tasks.ts` defaulted params + dead-branch collapse;
  conditionally `src/commands/tasks/list.ts` `applied_filters` overlay; conditionally the
  `freelo-api.yaml` `default:` correction. TODO-4 flags the partial-supply sub-case as
  decision-required.
- **Slice 2** — tests: request-shape assertions only, via the URL-capture pattern at
  `test/commands/tasks/list.test.ts:234-267`. A regression guard that `/all-tasks` stays unaffected.
- **Slice 3** — `docs/commands/tasks-list.md:60`, a `patch` changeset whose wording must not claim
  "fixes #108" unless OQ-2 supports it, and `pnpm check:readme` (no `fix:readme` needed — no
  command surface change).

**New dependencies:** none.
**Files projected to be touched:** 5 (well inside the 25-file budget).

Two hard ceilings recorded in the plan: MSW can assert the request the client emits but never the
order the server returns (spec §5.2); and no artifact may encode the unverified semantics
(decision 2).
