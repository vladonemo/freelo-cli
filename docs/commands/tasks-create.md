# freelo tasks create

Create a task in a tasklist. The first write-class subcommand — also ships
the shared write infrastructure (`--dry-run`, `--stdin` NDJSON batching) used
by every later write command. Emits a stable `freelo.tasks.create/v1`
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

| Flag                        | Type / values                 | Default | Purpose                                                                                                                                                    |
| --------------------------- | ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--tasklist <id>`           | positive integer              | —       | **Required.** Target tasklist id. The project id is derived from this via a one-shot `GET /tasklist/{id}` lookup.                                          |
| `--name <str>`              | string                        | —       | Required in single mode; in `--stdin` batch mode each line carries its own `name` field.                                                                   |
| `--worker <id>`             | positive integer (repeatable) | unset   | Worker user id. Repeats are accepted for forward-compatibility with `tasks edit` but only the **first** id is sent on the wire (envelope adds a `notice`). |
| `--due <date>`              | `YYYY-MM-DD`                  | unset   | Due date. Sent as `YYYY-MM-DDT00:00:00Z` to match Freelo's `date-time` contract.                                                                           |
| `--priority <level>`        | `low`, `normal`, `high`       | unset   | Mapped to `priority_enum`: low → `l`, normal → `m`, high → `h`.                                                                                            |
| `--label <name>`            | string (repeatable)           | unset   | Each name becomes a `TaskLabelAddInput { name }` (Freelo creates or matches the label by name; default color `#77787a`).                                   |
| `--description <text>`      | string                        | unset   | Inline description. Sent as `comment.content`. Mutex with `--description-file`.                                                                            |
| `--description-file <path>` | string (path)                 | unset   | Read the description from a UTF-8 file. **Single mode only** — rejected with `--stdin` (decision 5; path inputs are an attack surface in batch input).     |
| `--dry-run`                 | boolean                       | false   | Skip the POST. Envelope carries `dry_run: true` and a `data.would` block describing the call that would have happened.                                     |
| `--stdin`                   | boolean                       | false   | Batch mode: read NDJSON from stdin (one task per line) and emit one envelope per line on stdout.                                                           |
| `--project <id>`            | positive integer              | unset   | Allowed **only** with `--dry-run`. Skips the tasklist→project lookup so a dry-run can run with zero HTTP calls.                                            |

`--output`, `--color`, `--profile`, `-v/-vv`, `--request-id` are inherited
global flags.

## Permissions

- API key with write permission on the target tasklist.
- The `worker` (if set) must be on the tasklist's
  [assignable-workers](./tasklists-show.md) list, else the API returns 403.

## Envelope (single mode)

`schema: "freelo.tasks.create/v1"`

```json
{
  "schema": "freelo.tasks.create/v1",
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
    "project_id": 42
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-04-27T20:30:00Z" },
  "request_id": "..."
}
```

`data.task` validates against [`TaskCreatedSchema`](../api/schemas) — fields
beyond the documented surface are tolerated via `.passthrough()`.

## Envelope (`--dry-run`)

```json
{
  "schema": "freelo.tasks.create/v1",
  "dry_run": true,
  "data": {
    "tasklist_id": 314,
    "project_id": 42,
    "would": {
      "method": "POST",
      "path": "/project/42/tasklist/314/tasks",
      "body": { "name": "Audit auth flow", "priority_enum": "h" }
    }
  }
}
```

No `rate_limit` (the create call didn't happen). The startup-time
`GET /tasklist/{id}` lookup still runs unless `--project <id>` is supplied as
a dry-run-only escape hatch.

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
`freelo.tasks.create/v1` envelope (success, with `data.line_index`) or a
`freelo.error/v1` envelope (failure, with `error.context.line_index`).

A failed line **does not abort the run.** The streamer continues processing
subsequent lines. The process exit code at end-of-stream is the **numerically
highest** per-line exit code:

| Exit | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| 0    | All lines succeeded.                                        |
| 2    | At least one line failed validation; no HTTP failures.      |
| 3    | Auth-expired (401).                                         |
| 4    | API error (`FORBIDDEN`, `NOT_FOUND`, `SERVER_ERROR`, etc.). |
| 5    | Network failure (no response).                              |
| 6    | Rate-limited (429).                                         |

If the startup-time `GET /tasklist/{id}` lookup fails, the run aborts before
opening the stream — emits one `freelo.error/v1` envelope and exits with the
underlying error class's exit code.

## Error envelopes

All errors flow through `freelo.error/v1`. Common cases:

| Trigger                                              | Code               | Exit |
| ---------------------------------------------------- | ------------------ | ---- |
| Missing `--tasklist` / `--name`                      | `VALIDATION_ERROR` | 2    |
| Bad `--due`, `--priority`, `--label ""`              | `VALIDATION_ERROR` | 2    |
| `--description` and `--description-file` both set    | `VALIDATION_ERROR` | 2    |
| `--description-file` path missing or unreadable      | `VALIDATION_ERROR` | 2    |
| `--project` without `--dry-run`                      | `VALIDATION_ERROR` | 2    |
| Per-line bad JSON / unknown field / `tasklist` field | `VALIDATION_ERROR` | 2    |
| Tasklist 404 from startup lookup                     | `NOT_FOUND`        | 4    |
| Worker outside tasklist's assignable-workers (403)   | `FORBIDDEN`        | 4    |
| 5xx                                                  | `SERVER_ERROR`     | 4    |
| 429                                                  | `RATE_LIMITED`     | 6    |
| Network failure                                      | `NETWORK_ERROR`    | 5    |

## Examples

**Create a single task (human mode).**

```bash
$ freelo tasks create --tasklist 314 --name "Audit auth flow" \
    --priority high --label blocker
Created task #9012 (Audit auth flow) in tasklist 314 (project 42).
```

**Create from an agent (JSON, env-var auth).**

```bash
$ FREELO_API_KEY=*** FREELO_EMAIL=bot@example.com \
    freelo tasks create --tasklist 314 --name "Backfill changelog" --output json
{"schema":"freelo.tasks.create/v1","data":{"task":{"id":9012,...},"tasklist_id":314,"project_id":42},"rate_limit":{...}}
```

**Dry-run before committing.**

```bash
$ freelo tasks create --tasklist 314 --name "Test" --dry-run --output json
{"schema":"freelo.tasks.create/v1","dry_run":true,"data":{"would":{"method":"POST","path":"/project/42/tasklist/314/tasks","body":{"name":"Test"}},"tasklist_id":314,"project_id":42}}
```

**Batch from a generator.**

```bash
$ ./generate-tasks.sh | freelo tasks create --tasklist 314 --stdin --output ndjson
{"schema":"freelo.tasks.create/v1","data":{"task":{...,"id":9012},"tasklist_id":314,"project_id":42,"line_index":0},...}
{"schema":"freelo.error/v1","error":{"code":"VALIDATION_ERROR","message":"Line 2: name — name must be a non-empty string","context":{"line_index":1},...}}
{"schema":"freelo.tasks.create/v1","data":{"task":{...,"id":9013},"tasklist_id":314,"project_id":42,"line_index":2},...}
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
