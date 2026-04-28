# freelo time start

Start a time tracking session — a "running work" record that converts into a finalized work report when stopped (R20).

> **Singleton per user.** Freelo enforces **at most one** active session per user account at any time. A second `time start` while a timer is already running returns HTTP **409 Conflict** with a friendly hint pointing at [`freelo time stop`](./time-stop.md) and [`freelo time edit`](./time-edit.md) (both R20). When possible, the hint also names the active task and start time so an agent can decide what to do without a follow-up call.

## Synopsis

```bash
# Start tracking on a task with an optional note
freelo time start --task <id> [--note <str>] [--dry-run]

# Start a taskless ("general work") timer
freelo time start [--note <str>] [--dry-run]
```

Both flags are optional. Omitting `--task` is supported by the API and starts a general-work session not tied to any task.

## Arguments / Options

| Flag           | Type             | Default | Purpose                                                                         |
| -------------- | ---------------- | ------- | ------------------------------------------------------------------------------- |
| `--task <id>`  | positive integer | unset   | Target task id. Omit for general (taskless) work.                               |
| `--note <str>` | string           | unset   | Optional note attached to the session. Persists into the resulting work report. |
| `--dry-run`    | boolean          | false   | Skip the POST; envelope echoes the body that would have been sent.              |

## Idempotency

**N/A** — singleton per user. The endpoint enforces "exactly one active timer per user account"; the CLI surfaces a 409 with a typed hint instead of pretending the second start succeeded.

There is no `--ids` / `--stdin` batch mode for this command: a successful batch could never have more than one row, since the second start would 409. See [spec 0030 §2.1](../specs/0030-time-start-status.md) decision 5.

## Envelope

`schema: "freelo.time.start/v1"`

### Live success

```json
{
  "schema": "freelo.time.start/v1",
  "data": {
    "uuid": "tt-uuid-12345",
    "task_id": 4567,
    "note": "Investigating bug #4567"
  },
  "rate_limit": { "remaining": 40, "reset_at": "2026-04-28T20:30:00Z" }
}
```

`task_id` and `note` echo your flags. They are `null` when the corresponding flag was omitted (so agents can read them without checking key presence).

### Dry-run

```json
{
  "schema": "freelo.time.start/v1",
  "dry_run": true,
  "data": {
    "task_id": 4567,
    "note": "Investigating bug #4567",
    "would": {
      "method": "POST",
      "path": "/timetracking/start",
      "body": { "task_id": 4567, "note": "Investigating bug #4567" }
    }
  }
}
```

The `uuid` field is **absent** in dry-run envelopes — no POST happened, no UUID exists.

## Examples

### Start a timer on a task

```bash
$ freelo time start --task 4567 --note "Investigating bug #4567"
Started timer tt-uuid-12345 on task #4567 with note "Investigating bug #4567".
```

### Start a general-work (taskless) timer

```bash
$ freelo time start --note "Standup + planning"
Started timer tt-uuid-67890 on no task with note "Standup + planning".
```

### Verify what would be sent

```bash
$ freelo time start --task 4567 --dry-run --output json
{"schema":"freelo.time.start/v1","dry_run":true,"data":{"task_id":4567,"note":null,"would":{"method":"POST","path":"/timetracking/start","body":{"task_id":4567}}}}
```

### Singleton conflict (already tracking)

```bash
$ freelo time start --task 4567 --output json
{"schema":"freelo.error/v1","error":{"code":"FREELO_API_ERROR","message":"Freelo API error (HTTP 409).","http_status":409,"hint_next":"A time tracking session is already running (started 2026-04-28T10:00:00Z on task #999 \"Other task\"). Use `freelo time stop` to finalize it as a work report, or `freelo time edit` to reassign the task / note (R20).","retryable":false,"docs_url":null}}
# exit code: 4
```

The hint is enriched via an opportunistic `GET /timetracking/status` follow-up. If that follow-up fails (e.g. 5xx), the hint falls back to a generic `time stop` / `time edit` pointer.

### Compose with [`time status`](./time-status.md)

```bash
# Start a timer only if one isn't already running.
$ STATUS=$(freelo time status --output json)
$ if [ "$(echo "$STATUS" | jq -r '.data.active')" = "false" ]; then
    freelo time start --task 4567 --note "Picking up where I left off"
  fi
```

## Errors

| Trigger                                      | code               | exit |
| -------------------------------------------- | ------------------ | ---- |
| `--task` non-numeric / zero / negative       | `VALIDATION_ERROR` | 2    |
| POST 401                                     | `AUTH_EXPIRED`     | 3    |
| POST 404 (task missing or no access)         | `NOT_FOUND`        | 4    |
| POST 409 (singleton — timer already running) | `FREELO_API_ERROR` | 4    |
| POST 5xx                                     | `SERVER_ERROR`     | 4    |
| HTTP 429                                     | `RATE_LIMITED`     | 6    |
| Network failure                              | `NETWORK_ERROR`    | 5    |

The 409 case is the load-bearing UX edge — the hint is the actionable next step (stop / edit). Agents should branch on `error.http_status === 409` to decide whether to call `time status`, `time stop`, or `time edit`.

## Non-goals

- **No batch / `--ids` / `--stdin`** — see Idempotency section above.
- **No `--at <timestamp>` backdate flag** in v1 — the API supports `date_reported` but the CLI doesn't surface it yet. Most workflows want "now".
- **No `time stop` / `time edit`** — those land in R20.

## See also

- [`freelo time status`](./time-status.md) — check the current timer state.
- [Spec 0030](../specs/0030-time-start-status.md) — full design and decision log.
- [Roadmap R19 / R20 / R21 / R22](../roadmap.md) — full time-tracking sub-thread.
