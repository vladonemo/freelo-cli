# Phase 04 — Implement

## Files written

### Source (10 new, 1 modified)

- `src/api/schemas/task-label.ts` — Zod schemas for the three envelope variants.
- `src/api/task-labels.ts` — wire wrappers + body builders.
- `src/ui/human/task-labels-create.ts` — human renderer.
- `src/ui/human/task-labels-attach.ts` — human renderer.
- `src/ui/human/task-labels-detach.ts` — human renderer.
- `src/commands/task-labels.ts` — parent registrar.
- `src/commands/task-labels/create.ts` — leaf.
- `src/commands/task-labels/attach.ts` — leaf.
- `src/commands/task-labels/detach.ts` — leaf.
- `src/bin/freelo.ts` — modified (added `registerTaskLabels`).

## Gates run during implement

- `pnpm typecheck` — clean (first try).
- `pnpm lint` — clean (first try).

No retries needed.
