---
'freelo-cli': minor
---

Add `freelo tasks create` (R09) — the first write-class subcommand. Creates a
task in a tasklist with optional workers, labels, due date, priority, and
description. Project id is derived from `--tasklist` automatically.

Ships the shared write infrastructure reused by every later write command:

- `src/lib/dry-run.ts` — `--dry-run` envelope builder (sets `dry_run: true`,
  splices `data.would = { method, path, body }`).
- `src/lib/batch.ts` — NDJSON streamer (`iterateLines`, `parseNdjsonLine`,
  `ExitCodeAccumulator`). One envelope per input line on stdout, streamed as
  each line completes; the process exit code is the numerically highest
  per-line exit.
- `src/api/tasks-create.ts` — `buildCreateTaskBody` (pure body-builder) and
  `createTask` (POST wrapper).

New envelope schema **`freelo.tasks.create/v1`** (public contract):

```json
{
  "schema": "freelo.tasks.create/v1",
  "data": {
    "task": { /* TaskCreated */ },
    "tasklist_id": 314,
    "project_id": 42,
    "line_index": 0,        // batch mode only
    "would": { ... }        // --dry-run only
  },
  "rate_limit": { ... },
  "request_id": "...",
  "dry_run": true            // --dry-run only
}
```

CLI surface:

```
freelo tasks create --tasklist <id> --name <str>
                    [--worker <id>]... [--due YYYY-MM-DD]
                    [--priority low|normal|high] [--label <name>]...
                    [--description <text> | --description-file <path>]
                    [--dry-run]
freelo tasks create --tasklist <id> --stdin [--dry-run] < tasks.ndjson
```

Notes:

- `--editor` and `--description-file` for batch mode are deferred to R15.
- Repeatable `--worker` accepts repeats but only the first id is sent (with
  an envelope `notice` listing discarded ids); R10 will offer the proper
  "change assignment" verb.
- See `docs/specs/0019-tasks-create.md` and the nine accompanying decisions
  under `docs/decisions/2026-04-27-tasks-create-*.md`.
