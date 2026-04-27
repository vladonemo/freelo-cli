---
'freelo-cli': minor
---

feat(commands): add `freelo tasks show <id>` with description, subtasks, and projects side-cars (R08)

Adds the natural follow-up to R07 — view one task's full detail, with optional
side-cars for the long-form description, the (paginated) subtask list, and the
multi-project membership block. Prerequisite for the Wave 2 write commands
(R09–R15) which need the full task shape to round-trip diffs.

Public envelope: `freelo.tasks.show/v1`.

```
freelo tasks show <id> [--with description,subtasks,projects]
```

Side-car semantics — every key follows the same "absent vs. present" convention:

- `data.task` — always present. From `GET /task/{id}`.
- `data.description` — present only when `--with description` is set; from
  `GET /task/{id}/description`. Tolerates empty descriptions (id/content null).
- `data.subtasks` — present only when `--with subtasks` is set; from
  `GET /task/{id}/subtasks?p=N` merged across pages via `fetchAllPages`. Empty
  list renders as `[]` (key present, empty array).
- `data.projects` — present only when `--with projects` is set. **Projected
  from the embedded `multi_project_task` block** in the already-fetched
  `TaskDetail` (decision 1) — no second HTTP call. May legitimately be `null`
  when the task is single-project (key present, value null — distinct from
  absent).

Why projection instead of a separate GET: the roadmap line for R08 named
`GET /task/{task_id}/projects` but that endpoint is **not documented** in
`docs/api/freelo-api.yaml` (only `POST` and `DELETE` exist on that path). The
documented `TaskDetail.multi_project_task` block answers the same agent
question. Forward-compatible: if Freelo ever publishes the GET, R08.x can
swap implementations without changing the envelope shape under
`data.projects`.

Also ships:

- `src/api/schemas/task.ts` — `TaskDetailSchema`, `SubtaskSchema`,
  `TaskCommentSchema`, `MultiProjectBlockSchema`, `TasksShowDataSchema`. Built
  from scratch (not extended from `TaskFull`/`TaskSummary`) because the
  field overlap is partial.
- `src/api/tasks.ts` — `getTaskDetail`, `getTaskDescription`, `getTaskSubtasks`
  HTTP wrappers, with `signal` / `requestId` plumbing matching R07.
- `src/ui/human/tasks-show.ts` — TTY renderer for the header block, the
  description block, the subtasks table, and the multi-project membership
  block (or `(single-project task)` note when null).
- 27 new command-level tests + 14 new wrapper tests covering happy paths,
  validation (no HTTP), every typed error class with exit-code assertion per
  Calibration §1-2, and the `PartialPagesError` mid-stream unwrap path for
  subtasks (Calibration §4 — every new try/catch arm has at least one test).
