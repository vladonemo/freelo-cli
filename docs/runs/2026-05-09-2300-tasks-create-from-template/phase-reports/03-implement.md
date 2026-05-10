# Phase 3 — Implement

**Branch:** `feat/tasks-create-from-template` (from `main`).

**Files created:**

- `src/api/schemas/task-create-from-template.ts` — zod response schema + CLI input + wire body + envelope `data` types.
- `src/api/tasks-create-from-template.ts` — `buildCreateTaskFromTemplateBody()`, `createTaskFromTemplatePath()`, `createTaskFromTemplate()`.
- `src/commands/tasks/create-from-template.ts` — `tasks create-from-template` leaf with all flags, validation, dry-run, hint mapping. ~330 lines, mirrors `src/commands/tasklists/create-from-template.ts`.
- `src/ui/human/tasks-create-from-template.ts` — human-mode renderer (live + dry-run shapes).

**Files modified:**

- `src/commands/tasks.ts` — added `import { registerCreateFromTemplate }` and call.

**Self-checks:**

- `pnpm typecheck` — clean (first run, no retries).
- `pnpm lint` — clean (first run, no retries).

**Retries:** 0.

**No pause triggered.**
