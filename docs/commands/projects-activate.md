# freelo projects activate

Activate (un-archive **or** un-delete) one or more Freelo projects. The
endpoint is a single entry point for both transitions: an archived project
becomes active, a soft-deleted project is restored to active, and an
already-active project is a 200 no-op.

Activate is **idempotent on the server**.

## Synopsis

```bash
freelo projects activate <id>... [--ids "a,b,c"] [--stdin] [--dry-run]
```

## Options

Same as [`freelo projects archive`](./projects-archive.md). The only
differences are the schema discriminant (`freelo.projects.activate/v1`),
the wire path (`/project/{id}/activate`), and the resulting `current_state`
(`active`).

## Endpoint called

`POST /project/{id}/activate`

Empty request body. Response is a generic success envelope; the CLI does not
surface the wire body.

## Envelope

`schema: "freelo.projects.activate/v1"`

Live success:

```jsonc
{
  "schema": "freelo.projects.activate/v1",
  "data": {
    "project_id": 9001,
    "current_state": "active",
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-05-09T20:30:00Z" },
}
```

Successful activation surfaces `current_state: "active"` regardless of which
transition the server actually performed (un-archive vs. un-delete vs.
already-active no-op). Agents that need the prior state should call
`freelo projects show` first.

`--dry-run`:

```jsonc
{
  "schema": "freelo.projects.activate/v1",
  "dry_run": true,
  "data": {
    "project_id": 9001,
    "current_state": "active",
    "would": { "method": "POST", "path": "/project/9001/activate", "body": {} },
  },
}
```

## Examples

### Restore one project

```bash
$ freelo projects activate 9001
Activated project #9001.
```

### Batch — agent style

```bash
$ printf '{"id":9001}\n{"id":9002}\n' | \
    freelo projects activate --stdin --output json
{"schema":"freelo.projects.activate/v1","data":{"project_id":9001,"current_state":"active","line_index":0},...}
{"schema":"freelo.projects.activate/v1","data":{"project_id":9002,"current_state":"active","line_index":1},...}
```

## Errors and exit codes

Same matrix as [`projects archive`](./projects-archive.md), with one extra
notable case:

| Trigger                            | Exit | Code               | Notes                                                                 |
| ---------------------------------- | ---- | ------------------ | --------------------------------------------------------------------- |
| `PlanExceededException` (HTTP 422) | 4    | `FREELO_API_ERROR` | The plan's project cap is reached; archive a different project first. |

Plan-cap rejection only applies to `activate` — restoring a project counts
against the calling account's plan limit.

## Required Freelo permissions

Project-admin (owner / commander).

## Notes and intentional gaps

- **No GET pre-check.** As with `archive`, the CLI does not fetch state first.
  The envelope omits `previous_state`.
- **Activation of an already-active project succeeds quietly.** This makes the
  command safe to call as part of automation that wants to ensure-active.

## Related commands

- [`freelo projects archive`](./projects-archive.md) — move a project to the archived state.
- [`freelo projects delete`](./projects-delete.md) — soft-delete a project.
- [`freelo projects show`](./projects-show.md) — read state before/after.
