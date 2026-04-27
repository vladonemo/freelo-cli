---
'freelo-cli': minor
---

R14 — `freelo subtasks` (smart list). Two new commands under a brand-new
top-level `subtasks` subcommand:

- `freelo subtasks list --task <id> [--page N | --all]` — paginated read of
  one parent task's subtasks (taskchecks). Reuses R08's `SubtaskSchema` and
  the `fetchAllPages` infrastructure from R03.
- `freelo subtasks add --task <id> --name <str> [--worker <id>] [--due YYYY-MM-DD]
  [--dry-run] [--stdin]` — creates a subtask. Additive (not destructive); no
  confirmation gate.

**Smart-vs-simple fallback (the headline UX feature).** Freelo's API auto-
falls-back from a **smart taskcheck** (full task with worker / due date /
tracking users) to a **simple taskcheck** (a checkbox row with only a name)
when the parent's tasklist can't host smart ones (OpenAPI :2425). The CLI
surfaces the resulting form in the response envelope:

- `data.storage_form: 'smart' | 'simple'` — inferred from the response shape
  (any of `worker`, `due_date`, `state`, `tasklist`, `project` populated →
  `smart`; otherwise `simple`).
- `data.input_ignored: ['worker', 'due']` — only present on the `simple`
  path AND only for fields the user actually set that the server discarded.

The `freelo subtasks add --help` text explains this behavior (roadmap-
mandated UX requirement).

**Two new envelope schemas (additive surface):**

- `freelo.subtasks.list/v1` — `{ task_id, subtasks: Subtask[] }` plus
  envelope-level `paging` and `rate_limit`.
- `freelo.subtasks.add/v1` — `{ task_id, subtask?, storage_form?,
  input_ignored?, would?, line_index? }`. `subtask` and `storage_form` are
  always present in live envelopes and absent in `--dry-run`.

`--stdin` NDJSON batch mode for `subtasks add` mirrors R09 / R12.5 (per-line
schema, continue-on-error, max-of exit codes, lazy client construction).
Per-line `task` is rejected — `--task` is shared per-batch on the command
line.

No new dependencies. The wire wrapper for the existing `GET /task/{id}/subtasks`
endpoint is reused as-is from R08 (`src/api/tasks.ts`); only the new POST
wrapper, the storage-form inference helper, and CLI envelope-data schemas
land in this slice.
