# Phase report — Implement

**Run:** 2026-04-27-0535-tasks-show
**Phase:** Implement (resumed from prior session)
**Status:** Complete

## Outputs

### Commit a39f414 — `feat(api): add TaskDetail, Subtask, TaskComment schemas and task-detail HTTP wrappers`

- `src/api/schemas/task.ts` — `TaskDetailSchema`, `SubtaskSchema`,
  `TaskCommentSchema`, `MultiProjectBlockSchema`, `TasksShowDataSchema`.
- `src/api/tasks.ts` — `getTaskDetail`, `getTaskDescription`,
  `getTaskSubtasks` HTTP wrappers.
- `test/msw/handlers.ts` — `tasksShowHandlers` factory namespace
  (detail / description / subtasks variants + mid-stream failure).
- `test/api/tasks-show.test.ts` — 14 wrapper tests.
- `test/fixtures/tasks/show-*.json` — 5 fixtures.

### Commit c062be9 — `feat(commands): add 'freelo tasks show <id>' …`

- `src/commands/tasks/show.ts` — leaf command with `parseTaskId`,
  `parseWithFlag`, sequential side-car orchestration, three `try/catch`
  arms with hint rewriting, `PartialPagesError` unwrap for
  mid-stream subtasks failures.
- `src/commands/tasks.ts` — registers `show` alongside `list`.
- `src/ui/human/tasks-show.ts` — TTY renderer.

## Resume notes

Prior session left two untracked files in WIP state. They were inspected
and verified to conform to the plan; only one defensive fix was applied:

- `src/ui/human/tasks-show.ts` — extracted `formatUserLabel(user)` helper
  to avoid the `String({})` -> `[object Object]` footgun the linter
  flagged via `@typescript-eslint/no-base-to-string` (worker / author
  fallback when `fullname` is missing). No behavioral change at runtime
  for well-formed inputs (the schemas guarantee `id: number` so the
  String() path never ran on a real object — but the lint rule
  prevents the latent footgun).

```
IMPLEMENTER phase=implement run=2026-04-27-0535-tasks-show status=ok files_added=8 files_modified=2 retries=0
```
