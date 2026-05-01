# Decision 1 — Do not extract `addTaskLabels` to a neutral module

**Run:** 2026-05-01-0652-tasks-create-label-fix
**Phase:** plan
**Agent:** orchestrator

**Question:** Should `addTaskLabels` (currently in `src/api/tasks-edit.ts`) be
extracted to a neutral module (e.g. `src/api/task-labels.ts`) so
`tasks-create.ts` doesn't import from `tasks-edit.ts`?

**Decision:** No — keep it in `tasks-edit.ts`, import cross-module.

**Alternatives considered:**
- Extract to `src/api/task-labels.ts` (a new module).
- Inline a duplicate wire-builder in `tasks-create.ts`.

**Rationale:** The spec (§5.2) explicitly says "the implementer extracts
`addTaskLabels` into a more neutral home if it grows two callers' worth of
churn". Two callers IS the threshold but no churn is being added — both call
sites use the helper unchanged. Extracting now would be a refactor, not the
fix; the import edge `tasks-create.ts → tasks-edit.ts` is acceptable (both are
in `src/api/` and the function is single-purpose). Defer the extract until a
third caller appears.
