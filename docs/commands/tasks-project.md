# freelo tasks project

Manage a task's **multi-project membership** (UVVP — _Úkol Více Vlastních Projektů_).
Promotes a single-project task into a cross-team task by creating a child task
in another project, or rolls back an accidental cross-team assignment.

Two leaf subcommands:

- `freelo tasks project add <id> --tasklist <id>...` — add the task to one or
  more secondary projects.
- `freelo tasks project remove <id> --project <id>` — remove the task from a
  single secondary project. **Destructive**; requires `--yes` in non-TTY mode.

> **`add` takes `--tasklist`, not `--project`.** Freelo's `POST /task/{id}/projects`
> body shape requires a tasklist id; the project is derived from the tasklist
> server-side. Pass the numeric tasklist id from `freelo tasklists list --project <id>`.
> See spec 0052 decision 2.

> **Removing the task's primary project requires `freelo tasks delete <id>` instead.**
> Freelo returns `403 AclException` if you try to remove a task's primary project
> via this verb. The `remove` command surfaces this with a `hintNext` pointing at
> the right command.

## Synopsis

```bash
freelo tasks project add    <id> --tasklist <id>... [--dry-run]
freelo tasks project remove <id> --project  <id>   [--yes] [--dry-run]
```

## `tasks project add`

Adds the task to one or more secondary projects. Each `--tasklist` value
fans out to one POST; duplicate tasklist ids are silently deduplicated.

### Options

| Flag              | Type / values | Default | Purpose                                                                     |
| ----------------- | ------------- | ------- | --------------------------------------------------------------------------- |
| `<id>`            | positive int  | —       | Task id (numeric). Required.                                                |
| `--tasklist <id>` | positive int  | —       | Numeric tasklist id (repeatable). At least one required. Deduplicated.      |
| `--dry-run`       | boolean       | false   | Skip the POST(s); envelope echoes the collapsed body. One envelope (not N). |

`--output`, `--color`, `--profile`, `-v/-vv`, `--request-id` are inherited global flags.

### Wire mapping

`POST /task/{task_id}/projects` with body `{ "tasklist_id": <int> }`. With N
`--tasklist` values, the CLI issues N sequential POSTs (one body per request —
the OpenAPI spec does not document an array form).

### Envelope

`schema: freelo.tasks.project.add/v1`

| Field          | Type                                                                  | Always present | Notes                                                                                  |
| -------------- | --------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------- |
| `task_id`      | int                                                                   | yes            | Echo of `<id>` positional (the parent task).                                           |
| `tasklist_ids` | int[]                                                                 | yes            | Echo of `--tasklist`, deduplicated, length >= 1.                                       |
| `assignments`  | `{ tasklist_id: int; child_task_id: int; child_task_uuid: string }[]` | live only      | One entry per successful POST. Truncated on a mid-fan-out failure. Omitted on dry-run. |
| `would`        | `{ method: 'POST'; path: string; body: { tasklist_ids: int[] } }`     | dry-run only   | Collapsed wire echo — agents derive N round-trips by counting `tasklist_ids`.          |

### Examples

```bash
# Add a task to two more projects (one POST per --tasklist):
$ freelo tasks project add 4567 --tasklist 100 --tasklist 200 --output json
{"schema":"freelo.tasks.project.add/v1","data":{"task_id":4567,"tasklist_ids":[100,200],"assignments":[{"tasklist_id":100,"child_task_id":9001,"child_task_uuid":"abc-001"},{"tasklist_id":200,"child_task_id":9002,"child_task_uuid":"abc-002"}]}}

# Dry-run — single envelope, no per-tasklist call:
$ freelo tasks project add 4567 --tasklist 100 --tasklist 200 --dry-run --output json
{"schema":"freelo.tasks.project.add/v1","dry_run":true,"data":{"task_id":4567,"tasklist_ids":[100,200],"would":{"method":"POST","path":"/task/4567/projects","body":{"tasklist_ids":[100,200]}}}}

# Human mode (TTY):
$ freelo tasks project add 4567 --tasklist 100 --tasklist 200
Task #4567 added to 2 project(s) via tasklist(s) #100, #200.
```

## `tasks project remove`

Removes the task from a single **secondary** project. Reverses a prior
`tasks project add`. Single-id only; `--project` is not repeatable on `remove`.

### Options

| Flag             | Type / values | Default | Purpose                                                                                 |
| ---------------- | ------------- | ------- | --------------------------------------------------------------------------------------- |
| `<id>`           | positive int  | —       | Task id (numeric). Required.                                                            |
| `--project <id>` | positive int  | —       | Numeric id of the **secondary** project to remove the task from. Required.              |
| `--yes` / `-y`   | boolean       | false   | Bypass the confirmation prompt. **Required in non-TTY mode** — fails closed otherwise.  |
| `--dry-run`      | boolean       | false   | Skip the DELETE and confirmation; envelope echoes the path that would have been called. |

### Wire mapping

`DELETE /task/{task_id}/projects/{project_id}`. No body.

### Envelope

`schema: freelo.tasks.project.remove/v1`

| Field                     | Type    | Always present | Notes                                                                                                                                            |
| ------------------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `task_id`                 | int     | yes            | Echo of `<id>` positional.                                                                                                                       |
| `project_id`              | int     | yes            | Echo of `--project <id>`.                                                                                                                        |
| `already_in_target_state` | boolean | yes            | `true` on the 404 path (Freelo's documented "task not in this project" signal — first-class idempotency). `false` on live 200. Dry-run: `false`. |
| `would`                   | object  | dry-run only   | `{ method: 'DELETE'; path; body: {} }`.                                                                                                          |

### Confirmation policy

Mirrors all other destructive commands (R13 / R35 / R36 / R37):

- `--yes` → unconditional proceed.
- `--dry-run` → unconditional proceed (no destructive effect).
- TTY without `--yes` → prompt `Remove task #<id> from project #<project_id>?`. Decline → `ConfirmationError` (exit 2).
- Non-TTY without `--yes` → throw `ConfirmationError` (exit 2) immediately.

### Idempotency

Live 200 always emits `already_in_target_state: false` (we cannot tell from the
wire whether the link existed). A 404 response is **the documented "task not in
this project" signal** (yaml :1985) and is re-classified as
`already_in_target_state: true`.

A 403 response is **not** re-classified — it is the documented "primary-project
removal attempt" signal (yaml :1984). The CLI surfaces it as `FreeloApiError`
exit 4 with a `hintNext` pointing at `freelo tasks delete <id>`.

### Examples

```bash
# Remove from a secondary project (TTY prompts):
$ freelo tasks project remove 4567 --project 42
? Remove task #4567 from project #42? (y/N) y
{"schema":"freelo.tasks.project.remove/v1","data":{"task_id":4567,"project_id":42,"already_in_target_state":false}}

# Already removed → idempotent success:
$ freelo tasks project remove 4567 --project 42 --yes --output json
{"schema":"freelo.tasks.project.remove/v1","data":{"task_id":4567,"project_id":42,"already_in_target_state":true}}

# 403 on primary-project removal:
$ freelo tasks project remove 4567 --project 1 --yes
freelo: Forbidden (HTTP 403).
  hint: Removing a task entirely (incl. its primary project) requires `freelo tasks delete <id>`. This endpoint only removes a task from a SECONDARY project.
# exit 4

# Dry-run:
$ freelo tasks project remove 4567 --project 42 --dry-run --output json
{"schema":"freelo.tasks.project.remove/v1","dry_run":true,"data":{"task_id":4567,"project_id":42,"already_in_target_state":false,"would":{"method":"DELETE","path":"/task/4567/projects/42","body":{}}}}

# Non-TTY without --yes — fails closed:
$ freelo tasks project remove 4567 --project 42
freelo: --yes required in non-TTY mode (or pipe input).
# exit 2
```

## Required Freelo permissions

The caller must have access to:

- The task's **primary** project (to invoke either verb).
- Each target tasklist's project for `add` (Freelo derives the project from
  the tasklist).
- The secondary project for `remove`.

Cross-project visibility is the whole point of the multi-project feature, so
typical usage means the caller has access to both ends already.

## Related commands

- `freelo tasks delete <id>` — remove the task entirely (incl. its primary project).
- `freelo tasks show <id>` — inspect a task's `multi_project_task` block to see existing memberships.
- `freelo tasklists list --project <id>` — discover tasklist ids for `add`.
