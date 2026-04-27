---
'freelo-cli': minor
---

feat(commands): add `freelo tasks list` across `/all-tasks` and per-tasklist active routes (R07)

Adds the workhorse read for tasks across the projects you can see.
The CLI dispatches to one of two Freelo endpoints based on the flag combo:

- `GET /project/{p}/tasklist/{t}/tasks` when scoped to exactly one
  project + tasklist with no other filter.
- `GET /all-tasks` for everything else, with bracketed-array filter
  composition (`projects_ids[]`, `with_labels[]`, `due_date_range[*]`).

Public envelope: `freelo.tasks.list/v1` with `data.endpoint`,
`data.entity_shape`, and `data.applied_filters` discriminators so
agents can pin against route-specific entity shapes without guessing.

Also ships:

- `src/lib/query.ts` — typed param-map → URL query encoder (handles
  repeating arrays, bracketed objects, scalars, default-false omission).
  Reusable foundation for future write commands.
- `src/api/tasks.ts` — typed wrappers for both endpoints.
- `src/api/schemas/task.ts` — Zod schemas for `TaskSummary`,
  `TaskFull`, and `TaskFinished` (the third declared but not wired in
  v1; `tasklist-finished-tasks` route deferred to R07.5).
- 47 new tests covering happy paths, filter encoding, validation,
  field projection, every typed error class (with exit-code
  assertion per Calibration §1-2), and `--all` mid-stream behaviour.

Forward-compat: the envelope's `endpoint` discriminator already
accepts `'tasklist-finished-tasks'` and `entity_shape` accepts
`'task_finished'`, so the R07.5 finished-tasks slice is purely
additive (no `/v2` envelope bump).
