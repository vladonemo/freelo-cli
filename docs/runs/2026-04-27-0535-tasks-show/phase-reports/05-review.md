# Phase report — Review

**Run:** 2026-04-27-0535-tasks-show
**Phase:** Review (orchestrator self-review against spec acceptance criteria)
**Status:** Complete — no Blocking findings

## Acceptance criteria (spec §8.5) — checklist

- [x] All test cases in §8.3 pass — 41/41 R08 tests green.
- [x] `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`
      clean on the final committed tree (only flake is pre-existing
      `test/config/resolve.test.ts` env leak — same on `main`).
- [x] Coverage thresholds not regressed — 41 new tests, every branch
      in `src/commands/tasks/show.ts` exercised.
- [x] `freelo --introspect` includes `tasks show` — verified by
      `pnpm fix:readme` regenerating the README block to add
      `freelo tasks show <id>`.
- [x] `freelo tasks show --help` mentions `--with description,subtasks,projects`
      — flag description in the registered command literally lists the values.
- [x] Changeset captures `freelo.tasks.show/v1` as new public envelope schema.
- [x] `docs/roadmap.md` R08 entry reflects the embedded-projection
      decision for `--with projects` (per decision 1).

## Spec-to-implementation traceability

| Spec section | Code | Status |
|---|---|---|
| §3.1 subcommand signature | `src/commands/tasks/show.ts` `registerShow` | ✓ |
| §3.2 envelope `freelo.tasks.show/v1` | `src/api/schemas/task.ts` `TasksShowDataSchema` + `buildEnvelope` call | ✓ |
| §3.3 sequential per-side-car calls | `src/commands/tasks/show.ts` action handler steps 1→4 | ✓ |
| §3.4 human renderer | `src/ui/human/tasks-show.ts` | ✓ |
| §3.5 error mapping (3 try/catch arms) | `rewriteDetailHint` / `rewriteDescriptionHint` / `rewriteSubtasksHint` | ✓ |
| §4.1 TaskDetailSchema | `src/api/schemas/task.ts` | ✓ |
| §4.2 SubtaskSchema | `src/api/schemas/task.ts` | ✓ |
| §4.3 TaskCommentSchema | `src/api/schemas/task.ts` | ✓ |
| §4.4 envelope data schema | `src/api/schemas/task.ts` `TasksShowDataSchema` | ✓ |
| §4.5 API functions | `src/api/tasks.ts` | ✓ |

## Findings

**Blocking:** none.

**Non-blocking (deferred):**

- The local-machine flake in `test/config/resolve.test.ts` predates this run
  and should be filed separately. Tracking note left in 04-test.md.

```
REVIEW phase=review run=2026-04-27-0535-tasks-show status=ok blocking=0 non_blocking=1
```
