# freelo tasks create

Create a task in a tasklist. The first write-class subcommand — also ships
the shared write infrastructure (`--dry-run`, `--stdin` NDJSON batching) used
by every later write command. Emits a stable `freelo.tasks.create/v2`
envelope.

## Synopsis

```bash
# Single task
freelo tasks create --tasklist <id> --name <str>
                    [--worker <id>]...
                    [--due <YYYY-MM-DD>]
                    [--priority low|normal|high]
                    [--label <name>]...
                    [--description <text> | --description-file <path>]
                    [--dry-run]

# Batch (NDJSON in → NDJSON out)
freelo tasks create --tasklist <id> --stdin [--dry-run] < tasks.ndjson
```

## Options

| Flag                        | Type / values                 | Default | Purpose                                                                                                                                                                                                                                                   |
| --------------------------- | ----------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--tasklist <id>`           | positive integer              | —       | **Required.** Target tasklist id. The project id is derived from this via a one-shot `GET /tasklist/{id}` lookup.                                                                                                                                         |
| `--name <str>`              | string                        | —       | Required in single mode; in `--stdin` batch mode each line carries its own `name` field.                                                                                                                                                                  |
| `--worker <id>`             | positive integer (repeatable) | unset   | Worker user id. Repeats are accepted for forward-compatibility with `tasks edit` but only the **first** id is sent on the wire (envelope adds a `notice`).                                                                                                |
| `--due <date>`              | `YYYY-MM-DD`                  | unset   | Due date. Sent as `YYYY-MM-DDT00:00:00Z` to match Freelo's `date-time` contract.                                                                                                                                                                          |
| `--priority <level>`        | `low`, `normal`, `high`       | unset   | Mapped to `priority_enum`: low → `l`, normal → `m`, high → `h`.                                                                                                                                                                                           |
| `--label <name>`            | string (repeatable)           | unset   | Label name. **Two-phase** (spec 0041): the create POST omits labels, then a single batched `POST /task-labels/add-to-task/<new-id>` attaches all requested names. On attach failure the task is still created; see `applied_labels.failed` for diagnosis. |
| `--description <text>`      | string                        | unset   | Inline description. Sent as `comment.content`. Mutex with `--description-file`.                                                                                                                                                                           |
| `--description-file <path>` | string (path)                 | unset   | Read the description from a UTF-8 file. **Single mode only** — rejected with `--stdin` (decision 5; path inputs are an attack surface in batch input).                                                                                                    |
| `--dry-run`                 | boolean                       | false   | Skip every POST. Envelope carries `dry_run: true` and a `data.would` array describing the call(s) that would have happened (one entry for the create, plus a second entry for the label attach when `--label` is set).                                    |
| `--stdin`                   | boolean                       | false   | Batch mode: read NDJSON from stdin (one task per line) and emit one envelope per line on stdout.                                                                                                                                                          |
| `--project <id>`            | positive integer              | unset   | Allowed **only** with `--dry-run`. Skips the tasklist→project lookup so a dry-run can run with zero HTTP calls.                                                                                                                                           |

`--output`, `--color`, `--profile`, `-v/-vv`, `--request-id` are inherited
global flags.

## Permissions

- API key with write permission on the target tasklist.
- The `worker` (if set) must be on the tasklist's
  [assignable-workers](./tasklists-show.md) list, else the API returns 403.
- Label attach uses the same key — no extra scope is required.

## Label attach (two-phase)

The Freelo `POST /project/{p}/tasklist/{t}/tasks` endpoint requires every
label entry to carry `{uuid, name, color}` together; name-only entries fail
with `HTTP 400 "Missing item 'uuid' in array."`. The CLI works around this by
splitting the operation in two:

1. **Create** the task with the body that omits `labels` entirely.
2. If the create succeeds AND `--label` was passed, **attach** the requested
   names with a single batched `POST /task-labels/add-to-task/<new-task-id>`.
   Freelo creates the labels server-side if they don't exist (default colour
   `#77787a`) or matches them by name when they do.

The total HTTP cost is two calls when `--label` is set, one call otherwise.
The attach call is a **single batched POST**, not one POST per name.

If the attach call fails, the task **is still created** (the create POST
already returned 200). The CLI surfaces this dual outcome:

- `data.task` is populated on **stdout** so agents can read `data.task.id` and
  follow up.
- `data.applied_labels.failed` lists every requested name with the root error
  details.
- A `freelo.error/v1` envelope lands on **stderr** with
  `context.task_id` and `context.requested_label_names` for diagnosis.
- The exit code is the attach error's exit code (typically `4` for HTTP
  errors, `5` for network failures, `6` for rate limits).

## Envelope (single mode)

`schema: "freelo.tasks.create/v2"`

```json
{
  "schema": "freelo.tasks.create/v2",
  "data": {
    "task": {
      "id": 9012,
      "name": "Audit auth flow",
      "date_add": "2026-04-27T20:30:00Z",
      "due_date": "2026-04-30T00:00:00Z",
      "worker": { "id": 17, "fullname": "Jane Doe" },
      "priority_enum": "h",
      "labels": [{ "uuid": "...", "name": "blocker", "color": "#ff5555" }],
      "tracking_users": [{ "id": 17, "fullname": "Jane Doe" }],
      "subtasks": []
    },
    "tasklist_id": 314,
    "project_id": 42,
    "applied_labels": {
      "requested": ["blocker"],
      "attached": ["blocker"],
      "failed": []
    }
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-04-27T20:30:00Z" },
  "request_id": "..."
}
```

`data.task` validates against [`TaskCreatedSchema`](../api/schemas) — fields
beyond the documented surface are tolerated via `.passthrough()`.

`data.applied_labels` is **only present when `--label` was passed**. Its
`requested` mirrors the input names; `attached` lists the names the attach
call confirmed; `failed` is empty on success and carries one entry per
requested name when the attach failed.

## Envelope (`--dry-run`)

```json
{
  "schema": "freelo.tasks.create/v2",
  "dry_run": true,
  "data": {
    "tasklist_id": 314,
    "project_id": 42,
    "would": [
      {
        "method": "POST",
        "path": "/project/42/tasklist/314/tasks",
        "body": { "name": "Audit auth flow", "priority_enum": "h" }
      },
      {
        "method": "POST",
        "path": "/task-labels/add-to-task/{new_task_id}",
        "body": { "labels": [{ "name": "blocker" }] }
      }
    ]
  }
}
```

`data.would` is an **array** (bumped from a single object in `/v1`). The first
entry describes the create call; a second entry — only present when `--label`
was passed — describes the follow-up attach call. The path carries the
literal `{new_task_id}` placeholder because the new task id isn't known until
the create call returns.

No `rate_limit` (no calls happened). The startup-time `GET /tasklist/{id}`
lookup still runs unless `--project <id>` is supplied as a dry-run-only
escape hatch.

## Envelope (partial failure: create OK, attach failed)

```json
{
  "schema": "freelo.tasks.create/v2",
  "data": {
    "task": { "id": 9012, "name": "Audit auth flow" },
    "tasklist_id": 314,
    "project_id": 42,
    "applied_labels": {
      "requested": ["blocker"],
      "attached": [],
      "failed": [
        {
          "name": "blocker",
          "error_code": "SERVER_ERROR",
          "http_status": 502,
          "message": "Freelo API server error (HTTP 502)."
        }
      ]
    }
  },
  "notice": "Task created but label attach failed; task #9012 has no labels.",
  "rate_limit": { "remaining": 38, "reset_at": "2026-04-27T20:30:00Z" }
}
```

The success-shaped envelope above lands on **stdout**. A `freelo.error/v1`
envelope lands on **stderr** with `context.task_id: 9012` and
`context.requested_label_names: ["blocker"]`. Exit code is `4`
(`SERVER_ERROR`) — or `5` for a network failure, `6` for a rate-limit hit.

## Batch (`--stdin`) format

**Input.** NDJSON — one JSON object per line, lines `\n` or `\r\n` terminated,
blank lines skipped. Keys mirror the long-form CLI flags with kebab→snake
conversion (no `--`):

```jsonl
{ "name": "Audit auth", "worker": 17, "due": "2026-05-01", "priority": "high", "label": ["blocker"], "description": "Investigate the CSRF leak in v3." }
{ "name": "Backfill changelog", "label": ["docs", "chore"] }
```

Per-line rules:

- `name` is required (non-empty string); other fields optional.
- `tasklist` per line is **rejected** — pass `--tasklist` on the CLI.
- `description_file` per line is **rejected** — inline `description` instead.
- Unknown keys are rejected (`.strict()`).

**Output.** NDJSON — one envelope per input line, written **as the line
completes** (streamed, not buffered). Each line is either a
`freelo.tasks.create/v2` envelope (success, with `data.line_index`) or a
`freelo.error/v1` envelope (failure, with `error.context.line_index`).

When a per-line attach call fails, the line emits **two** NDJSON envelopes in
order: the success-shaped envelope (with `applied_labels.failed` populated and
the success-line `notice`), then a `freelo.error/v1` envelope tagged with
`context.task_id` and `context.requested_label_names`.

A failed line **does not abort the run.** The streamer continues processing
subsequent lines. The process exit code at end-of-stream is the **numerically
highest** per-line exit code:

| Exit | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | All lines succeeded.                                                    |
| 2    | At least one line failed validation; no HTTP failures.                  |
| 3    | Auth-expired (401).                                                     |
| 4    | API error (`FORBIDDEN`, `NOT_FOUND`, `SERVER_ERROR`, attach 4xx, etc.). |
| 5    | Network failure (no response) — including attach network failure.       |
| 6    | Rate-limited (429).                                                     |

If the startup-time `GET /tasklist/{id}` lookup fails, the run aborts before
opening the stream — emits one `freelo.error/v1` envelope and exits with the
underlying error class's exit code.

## Error envelopes

All errors flow through `freelo.error/v1`. Common cases:

| Trigger                                              | Code               | Exit  |
| ---------------------------------------------------- | ------------------ | ----- |
| Missing `--tasklist` / `--name`                      | `VALIDATION_ERROR` | 2     |
| Bad `--due`, `--priority`, `--label ""`              | `VALIDATION_ERROR` | 2     |
| `--description` and `--description-file` both set    | `VALIDATION_ERROR` | 2     |
| `--description-file` path missing or unreadable      | `VALIDATION_ERROR` | 2     |
| `--project` without `--dry-run`                      | `VALIDATION_ERROR` | 2     |
| Per-line bad JSON / unknown field / `tasklist` field | `VALIDATION_ERROR` | 2     |
| Tasklist 404 from startup lookup                     | `NOT_FOUND`        | 4     |
| Worker outside tasklist's assignable-workers (403)   | `FORBIDDEN`        | 4     |
| Create POST 5xx                                      | `SERVER_ERROR`     | 4     |
| Create POST 429                                      | `RATE_LIMITED`     | 6     |
| Create POST network failure                          | `NETWORK_ERROR`    | 5     |
| **Attach POST fails (any class)** — task IS created  | (attach class)     | 4/5/6 |

## Examples

**Create a single task (human mode).**

```bash
$ freelo tasks create --tasklist 314 --name "Audit auth flow" \
    --priority high --label blocker
Created task #9012 (Audit auth flow) in tasklist 314 (project 42).
Attached labels: blocker
```

**Create from an agent (JSON, env-var auth).**

```bash
$ FREELO_API_KEY=*** FREELO_EMAIL=bot@example.com \
    freelo tasks create --tasklist 314 --name "Backfill changelog" --output json
{"schema":"freelo.tasks.create/v2","data":{"task":{"id":9012,...},"tasklist_id":314,"project_id":42},"rate_limit":{...}}
```

**Dry-run before committing (with --label).**

```bash
$ freelo tasks create --tasklist 314 --name "Test" --label bug --dry-run --output json
{"schema":"freelo.tasks.create/v2","dry_run":true,"data":{"would":[{"method":"POST","path":"/project/42/tasklist/314/tasks","body":{"name":"Test"}},{"method":"POST","path":"/task-labels/add-to-task/{new_task_id}","body":{"labels":[{"name":"bug"}]}}],"tasklist_id":314,"project_id":42}}
```

**Batch from a generator.**

```bash
$ ./generate-tasks.sh | freelo tasks create --tasklist 314 --stdin --output ndjson
{"schema":"freelo.tasks.create/v2","data":{"task":{...,"id":9012},"tasklist_id":314,"project_id":42,"line_index":0},...}
{"schema":"freelo.error/v1","error":{"code":"VALIDATION_ERROR","message":"Line 2: name — name must be a non-empty string","context":{"line_index":1},...}}
{"schema":"freelo.tasks.create/v2","data":{"task":{...,"id":9013},"tasklist_id":314,"project_id":42,"line_index":2},...}
$ echo $?
2
```

## Notes

- **Repeatable `--worker` ergonomics.** Roadmap text shows `--worker <id>...`
  but `TaskCreate.worker` is a single integer in the API contract. Repeats
  are accepted for forward-compat with R10 (`tasks edit`), but only the first
  id is sent. The envelope's `notice` field lists the discarded ids.
- **`--editor` is deferred.** Terminal-editor description input is a better
  fit for `freelo tasks description set` (R15), where editor-shaped I/O is
  the natural primitive. R09 supports `--description <text>` and
  `--description-file <path>` only.
- **No idempotency key.** `POST` is non-idempotent — running this twice with
  the same body creates two tasks. Use `--dry-run` first if unsure.
- **Description-file in batch is rejected** (decision 5) to keep file-path
  inputs out of NDJSON streams; agents should pre-resolve to inline text.
- **Schema bump from `/v1` to `/v2`** (spec 0041): `data.would` retypes from
  a single object to an array; `data.applied_labels` is added. The `/v1`
  shape was only emitted on a code path that returned `400 "Missing item
'uuid' in array."`, so no working caller is affected.
