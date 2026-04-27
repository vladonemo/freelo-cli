# freelo tasks edit

Partially update a task: rename, reassign worker, change priority or due
date, and add or remove labels. Emits a stable `freelo.tasks.edit/v1`
envelope.

## Synopsis

```bash
freelo tasks edit <id>
                  [--name <str>]
                  [--worker <id>]...
                  [--due <YYYY-MM-DD>]
                  [--priority low|normal|high]
                  [--clear-priority]
                  [--add-label <name>]...
                  [--remove-label <name>]...
                  [--dry-run]
```

At least one mutating flag is required. An empty edit (`freelo tasks edit
9012` with nothing else) is rejected with `VALIDATION_ERROR` (exit 2) — empty
edits are almost always a bug.

## Options

| Flag                    | Type / values                 | Default | Purpose                                                                                                                                                             |
| ----------------------- | ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<id>`                  | positive integer              | —       | **Required.** Numeric task id from `freelo tasks list`.                                                                                                             |
| `--name <str>`          | non-empty string              | unset   | New task name.                                                                                                                                                      |
| `--worker <id>`         | positive integer (repeatable) | unset   | New assignee user id. Repeats are accepted for forward-compatibility but only the **first** id is sent on the wire (envelope adds a `notice`).                      |
| `--due <date>`          | `YYYY-MM-DD`                  | unset   | New due date. Sent as `YYYY-MM-DDT00:00:00Z` to match Freelo's `date-time` contract.                                                                                |
| `--priority <level>`    | `low`, `normal`, `high`       | unset   | New priority. Mapped to `priority_enum` (low → `l`, normal → `m`, high → `h`). Mutex with `--clear-priority`.                                                       |
| `--clear-priority`      | boolean                       | false   | Clear the priority (sends `priority_enum: null`). Mutex with `--priority`.                                                                                          |
| `--add-label <name>`    | string (repeatable)           | unset   | Add a label by name. Repeats are deduplicated case-sensitively. Server defaults the color to `#77787a` for new labels.                                              |
| `--remove-label <name>` | string (repeatable)           | unset   | Remove a label by name. **Aggressive — removes every label with that name regardless of color.** Pass the UUID via `freelo task-labels detach` (R24) for precision. |
| `--dry-run`             | boolean                       | false   | Skip every POST. Envelope carries `dry_run: true` and a `data.would[]` array describing the calls that would have happened.                                         |
| `--project <id>`        | positive integer              | unset   | Allowed **only** with `--dry-run`. Skips the lookup `GET /task/{id}` so a dry-run can run with zero HTTP calls.                                                     |

`--output`, `--color`, `--profile`, `-v/-vv`, `--request-id` are inherited
global flags.

## Behavior

The edit fans out across up to four endpoints in this order:

1. `POST /task-labels/remove-from-task/{id}` — only if `--remove-label` was passed.
2. `POST /task-labels/add-to-task/{id}` — only if `--add-label` was passed.
3. `POST /task/{id}` — only if a non-label flag was passed.
4. `GET /task/{id}` — always, to refresh `data.task` with the post-edit state.

The order is **not transactional.** If a downstream call fails, the upstream
calls have already taken effect on the wire — the CLI surfaces the error
verbatim with `FreeloApiError`. Agents needing atomicity must reconcile
state themselves. The `data.applied_changes` block in error envelopes never
overstates: only changes that the wire confirmed are listed there.

If every write succeeds but the post-edit refresh `GET /task/{id}` fails,
the envelope is still `success` (exit 0) with `data.task: null` and a
`notice` explaining the freshness gap.

## Permissions

- API key with write permission on the task.
- The new `worker` (if set) must be on the tasklist's
  [assignable-workers](./tasklists-show.md) list, else the API returns 403.
- Label-diff endpoints honor the caller's project ACL.

## Envelope

`schema: "freelo.tasks.edit/v1"`

```json
{
  "schema": "freelo.tasks.edit/v1",
  "data": {
    "task": {
      "id": 9012,
      "name": "Audit auth flow (v2)",
      "date_edited_at": "2026-04-27T20:35:00Z",
      "due_date": "2026-05-01T00:00:00Z",
      "priority_enum": "h",
      "worker": { "id": 17, "fullname": "Jane Doe" },
      "labels": [{ "uuid": "lbl-3", "name": "urgent", "color": "#77787a" }],
      "project": { "id": 42, "name": "Site redesign" },
      "tasklist": { "id": 314, "name": "Backend QA" }
    },
    "tasklist_id": 314,
    "project_id": 42,
    "applied_changes": {
      "edit": {
        "name": "Audit auth flow (v2)",
        "due_date": "2026-05-01T00:00:00Z",
        "priority_enum": "h"
      },
      "labels_added": ["urgent"],
      "labels_removed": ["wontfix"]
    }
  },
  "rate_limit": { "remaining": 39, "reset_at": "2026-04-27T20:35:00Z" },
  "request_id": "..."
}
```

`data.task` validates against the
[`TaskDetailSchema`](./tasks-show.md#envelope) — same shape as `tasks show`.

## Envelope (`--dry-run`)

```json
{
  "schema": "freelo.tasks.edit/v1",
  "dry_run": true,
  "data": {
    "task": null,
    "tasklist_id": 314,
    "project_id": 42,
    "applied_changes": {
      "edit": { "name": "X" },
      "labels_added": ["urgent"],
      "labels_removed": []
    },
    "would": [
      {
        "method": "POST",
        "path": "/task-labels/add-to-task/9012",
        "body": { "labels": [{ "name": "urgent" }] }
      },
      { "method": "POST", "path": "/task/9012", "body": { "name": "X" } }
    ]
  }
}
```

Note that `data.would` is an **array** (the edit fan-out hits up to three
endpoints), unlike `tasks create`'s single-call `data.would` object.

## Examples

### Rename and bump priority

```bash
$ freelo tasks edit 9012 --name "Audit auth (v2)" --priority high
Edited task #9012: name, priority.
```

### Label diff (add and remove in one call)

```bash
$ FREELO_API_KEY=*** FREELO_EMAIL=bot@example.com \
  freelo tasks edit 9012 --add-label urgent --remove-label wontfix --output json
{"schema":"freelo.tasks.edit/v1","data":{"task":{...},"applied_changes":{"edit":{},"labels_added":["urgent"],"labels_removed":["wontfix"]},...}}
```

### Reassign

```bash
$ freelo tasks edit 9012 --worker 17 --output json
{"schema":"freelo.tasks.edit/v1","data":{"task":{...,"worker":{"id":17,...}},"applied_changes":{"edit":{"worker":17},...}}}
```

### Clear priority

```bash
$ freelo tasks edit 9012 --clear-priority
Edited task #9012: priority.
```

### Dry-run before applying

```bash
$ freelo tasks edit 9012 --add-label urgent --priority high --dry-run --output json
{"schema":"freelo.tasks.edit/v1","dry_run":true,"data":{"would":[{"method":"POST","path":"/task-labels/add-to-task/9012","body":{"labels":[{"name":"urgent"}]}},{"method":"POST","path":"/task/9012","body":{"priority_enum":"h"}}],"applied_changes":{"edit":{"priority_enum":"h"},"labels_added":["urgent"],"labels_removed":[]},...}}
```

## Errors

| Trigger                                         | code               | exit |
| ----------------------------------------------- | ------------------ | ---- |
| `<id>` not a positive integer                   | `VALIDATION_ERROR` | 2    |
| No mutating flag set                            | `VALIDATION_ERROR` | 2    |
| Same name in `--add-label` and `--remove-label` | `VALIDATION_ERROR` | 2    |
| `--priority` AND `--clear-priority`             | `VALIDATION_ERROR` | 2    |
| `--project` without `--dry-run`                 | `VALIDATION_ERROR` | 2    |
| HTTP 401 (any call)                             | `AUTH_EXPIRED`     | 3    |
| HTTP 403 (any call)                             | `FORBIDDEN`        | 4    |
| HTTP 404 on lookup                              | `NOT_FOUND`        | 4    |
| HTTP 422 on edit / label add                    | `FREELO_API_ERROR` | 4    |
| HTTP 429                                        | `RATE_LIMITED`     | 6    |
| HTTP 5xx                                        | `SERVER_ERROR`     | 4    |
| Network failure                                 | `NETWORK_ERROR`    | 5    |
| Schema parse failure on edit response           | `FREELO_API_ERROR` | 4    |

## Non-goals (R10 v1)

- `--description` / `--description-file` — deferred to R15
  (`tasks description set`).
- `--due-end`, `--clear-due`, `--clear-name` — out of scope.
- `--tracking-users` add/remove/replace — out of scope.
- `<id>...` repeatable positional / `--stdin` NDJSON batch — out of scope; a
  proper batch surface for `tasks edit` deserves a dedicated spec when a real
  use case appears.
- Setting full label DTOs (color, UUID) on `--add-label` — name-mode only in
  v1; use [`task-labels`](./tasks-list.md#related) when it lands (R24).

See [spec 0020](../specs/0020-tasks-edit.md) for the full design including
decisions log.
