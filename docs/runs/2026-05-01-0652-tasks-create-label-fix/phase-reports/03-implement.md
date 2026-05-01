# Phase 3 — Implement

**Status:** ok
**Files modified:** 5 source / 1 doc / 3 test / 1 changeset
**Retries:** 0 (typecheck + lint pass on first pass)

## Summary

- Schema bump v1 → v2 in `src/api/schemas/task.ts`. Dropped `labels` from
  `CreateTaskBody`, added `CreateWouldEntrySchema`, `AppliedLabelFailureSchema`,
  retyped `would` to array, added `applied_labels`.
- Wire builder in `src/api/tasks-create.ts` no longer maps `labels` to the body.
- Command orchestration in `src/commands/tasks/create.ts`:
  - Single mode: post-create `addTaskLabels` call (when labels requested);
    dual-emit on attach failure (stdout success envelope, stderr error envelope,
    exit with attach error code).
  - Batch mode: per-line attach with the same dual-emit (success + error
    NDJSON lines on stdout, accumulator observes the exit code).
  - Dry-run: `data.would` is now an array; second entry only when labels
    requested, with `{new_task_id}` placeholder path.
- Human renderer learns "Attached labels: …" success line and the dry-run
  "+ attach labels: …" line.
