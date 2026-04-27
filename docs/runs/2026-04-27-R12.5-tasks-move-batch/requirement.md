# Requirement — R12.5 `freelo tasks move` batch input

**Run:** 2026-04-27-R12.5-tasks-move-batch
**Source:** `docs/roadmap.md` §R12.5
**Tier (pre-classified):** Yellow

## Verbatim requirement

Move many tasks in one invocation, each row pointing at its own destination tasklist (and optionally project). Closes the only remaining gap between `tasks move` and the rest of the write surface that already supports batch.

**Endpoints:** same as R12 — `POST /task/{task_id}/move/{tasklist_id}` per row.

**CLI:**
```
freelo tasks move --stdin [--dry-run]
# Each input line: {"id": <task_id>, "to_tasklist": <tasklist_id>, "to_project"?: <project_id>}
# Optional sugar (decide during /spec):
freelo tasks move --pairs <id>:<tasklist_id>,<id>:<tasklist_id>,...
```

**Ships with this slice:**
- Extension to `src/lib/batch.ts` to support per-row destination params, not just a shared `<id>` list. The existing `--ids` / `--stdin` reader assumes one target verb applied to many ids; this is the first command where each row carries its own arguments. Generalize the helper for future "two-id" writes.
- NDJSON row schema validated by zod before the first network call (fail-fast on malformed lines; emit row-index in error envelope).
- Idempotency contract preserved per row — moving a task to its current tasklist returns `already_in_target_state: true` for that envelope.
- Output schema: `freelo.tasks.move/v1` per row (no new schema; reuses R12).

**Open questions for `/spec`:**
1. Whether to ship `--pairs` sugar in addition to `--stdin`, or stdin-only.
2. Failure semantics: continue-on-error (current `--stdin` precedent) vs fail-fast. Default has been continue-on-error.
3. Whether `--to-project` makes sense as a global flag in batch mode (overriding per-row) or only per-row.

**Tier:** Yellow.
**Changeset:** `freelo-cli: minor`.
**Depends on:** R12.

## Run config

- run-id: `2026-04-27-R12.5-tasks-move-batch`
- branch: `feat/tasks-move-batch` (branch from current `main`)
- budgets: defaults — 30 min wall clock, 40 agent calls, 8 retries, 25 files
- allowNetwork: false (MSW only)
- autoShip: false
