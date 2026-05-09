# Triage — R38 (`tasks project add/remove`, `tasks relations`, `tasks find-relations`)

**Run:** `2026-05-09-1200-r38-tasks-multiproject-relations`.
**Date:** 2026-05-09.

## Tier: **Yellow**

## Rationale

- New user-visible commands (4 leaves) → Yellow signal (autonomous-sdlc.md §Risk tiers).
- No auth, config, HTTP client default, or release tooling changes.
- No new runtime dependencies.
- No breaking changes to envelope schemas, exit codes, or flag names.
- 1 destructive command (`tasks project remove`) reuses R13/R35/R36/R37 confirm pattern — established precedent.
- Changeset will be `minor` (additive commands).
- No `src/config/`, no auth flow, no client default touches → not Red.
- The tasklist_id-vs-project_id divergence between roadmap and OpenAPI is a documented decision (mirrors R36 share-verb precedent), not a pause condition.

## Route flags

- `needsSecurityReview: false` — no auth/secret surface.
- `requiresFreeloApi: true` — the OpenAPI spec is authoritative for all four endpoints.
- `preApprovedDeps: []` — no new deps allowed; existing primitives suffice.

## File-count estimate (must stay <= 25)

- `src/api/schemas/task-projects.ts` (new) — 1
- `src/api/tasks-projects.ts` (new) — 2
- `src/api/schemas/task-relations.ts` (new) — 3
- `src/api/tasks-relations.ts` (new) — 4
- `src/commands/tasks/project.ts` (parent) — 5
- `src/commands/tasks/project/add.ts` — 6
- `src/commands/tasks/project/remove.ts` — 7
- `src/commands/tasks/relations.ts` — 8
- `src/commands/tasks/find-relations.ts` — 9
- `src/ui/human/tasks-project-add.ts` — 10
- `src/ui/human/tasks-project-remove.ts` — 11
- `src/ui/human/tasks-relations.ts` — 12
- `src/ui/human/tasks-find-relations.ts` — 13
- `test/commands/tasks/project-add.test.ts` — 14
- `test/commands/tasks/project-remove.test.ts` — 15
- `test/commands/tasks/relations.test.ts` — 16
- `test/commands/tasks/find-relations.test.ts` — 17
- `docs/commands/tasks-project.md` — 18
- `docs/commands/tasks-relations.md` — 19 (covers both relations and find-relations)
- `.changeset/r38-tasks-multiproject-relations.md` — 20
- modify: `src/commands/tasks.ts` (3 new register calls) — 21
- modify: `test/msw/handlers.ts` (4 new handler blocks) — 22
- modify: `README.md` (autogen via `pnpm fix:readme`) — 23
- spec: `docs/specs/0052-r38-tasks-multiproject-relations.md` — 24

24 files. Within budget.
