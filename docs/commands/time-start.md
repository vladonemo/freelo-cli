# freelo time start

Start a time tracking session — a "running work" record that converts into a finalized work report when stopped (R20).

> **Singleton per user.** Freelo enforces **at most one** active session per user account at any time. A second `time start` while a timer is already running returns HTTP **409 Conflict** with a friendly hint pointing at [`freelo time stop`](./time-stop.md) and [`freelo time edit`](./time-edit.md) (both R20). When possible, the hint also names the active task and start time so an agent can decide what to do without a follow-up call.

## Synopsis

```bash
# Start tracking on a task with an optional note
freelo time start --task <id> [--note <str>] [--at <ISO>] [--dry-run]

# Start a taskless ("general work") timer
freelo time start [--note <str>] [--at <ISO>] [--dry-run]
```

All flags are optional. Omitting `--task` is supported by the API and starts a general-work session not tied to any task. Omitting `--at` defers to the server's "now" default — the timer starts at the moment Freelo receives the request.

## Arguments / Options

| Flag           | Type             | Default | Purpose                                                                                                                            |
| -------------- | ---------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--task <id>`  | positive integer | unset   | Target task id. Omit for general (taskless) work.                                                                                  |
| `--note <str>` | string           | unset   | Optional note attached to the session. Persists into the resulting work report.                                                    |
| `--at <ISO>`   | ISO 8601 string  | unset   | Backdate the session start. Accepts UTC (`2026-04-28T09:00:00Z`), tz-offset (`...+02:00`), or bare date (`2026-04-28`). See below. |
| `--dry-run`    | boolean          | false   | Skip the POST; envelope echoes the body that would have been sent.                                                                 |

### Backdating sessions (`--at`)

Use `--at` when you forgot to start the timer at the real start time, or when an integration replays a "moved to in-progress" event after the fact.

- **Acceptance shape.** `--at` accepts any value `Date.parse()` accepts: full RFC 3339 / ISO 8601 timestamps, timestamps with tz offsets, and bare `YYYY-MM-DD` (treated as midnight UTC).
- **Wire normalization.** The CLI converts the input to **canonical UTC** (`YYYY-MM-DDTHH:MM:SSZ`, second precision) before sending. Whatever timezone you pass, Freelo receives a UTC string.
- **Validation.** Malformed input rejects with `VALIDATION_ERROR` (exit 2) and a hint pointing at the canonical shape. Timestamps more than 60 seconds in the future of your local clock are rejected as a clock-skew clamp — backdating into the future doesn't make sense for a session that's just starting.
- **No far-past bound.** The CLI does not impose a "no more than N days ago" limit. If Freelo's server validates the lower bound, it returns 400/422 and the CLI surfaces that as `FREELO_API_ERROR` (exit 4).
- **Wire cleanliness.** Omitting `--at` means the wire body has **no** `date_reported` key (not `null`). Server-side default behavior ("now") triggers off field absence.

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

### Backdate to a specific UTC time (forgot to start it)

```bash
$ freelo time start --task 4567 --at 2026-04-28T09:00:00Z
Started timer tt-uuid-12345 on task #4567.
```

### Backdate from a local time (auto-normalized to UTC)

```bash
$ freelo time start --task 4567 --at 2026-04-28T11:00:00+02:00 --dry-run --output json
{"schema":"freelo.time.start/v1","dry_run":true,"data":{"task_id":4567,"note":null,"would":{"method":"POST","path":"/timetracking/start","body":{"task_id":4567,"date_reported":"2026-04-28T09:00:00Z"}}}}
```

The wire body's `date_reported` is the UTC-canonical form, not your local-tz input.

### Backdate to a calendar day (00:00 UTC)

```bash
$ freelo time start --note "Catch-up" --at 2026-04-28
# Sends date_reported = 2026-04-28T00:00:00Z
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
| `--at` malformed / empty                     | `VALIDATION_ERROR` | 2    |
| `--at` more than 60 s in the future          | `VALIDATION_ERROR` | 2    |
| POST 401                                     | `AUTH_EXPIRED`     | 3    |
| POST 404 (task missing or no access)         | `NOT_FOUND`        | 4    |
| POST 409 (singleton — timer already running) | `FREELO_API_ERROR` | 4    |
| POST 5xx                                     | `SERVER_ERROR`     | 4    |
| HTTP 429                                     | `RATE_LIMITED`     | 6    |
| Network failure                              | `NETWORK_ERROR`    | 5    |

The 409 case is the load-bearing UX edge — the hint is the actionable next step (stop / edit). Agents should branch on `error.http_status === 409` to decide whether to call `time status`, `time stop`, or `time edit`.

## Non-goals

- **No batch / `--ids` / `--stdin`** — see Idempotency section above.
- **No `--at` echo on the live envelope `data`.** When `--at` is set, the effect is captured by the server's response and (in dry-run) by `data.would.body.date_reported`. Agents that want to confirm the backdate took effect can chain [`freelo time status`](./time-status.md) and read `started_at`.
- **No `--at` on `time edit`** in this slice — that lands in R20 if-and-when the spec calls for it.
- **No `time stop` / `time edit`** — those land in R20.

## See also

- [`freelo time status`](./time-status.md) — check the current timer state.
- [Spec 0030](../specs/0030-time-start-status.md) — original R19 design and decision log.
- [Spec 0031](../specs/0031-time-start-backdate.md) — R19.5 `--at` backdate flag.
- [Roadmap R19 / R19.5 / R20 / R21 / R22](../roadmap.md) — full time-tracking sub-thread.
