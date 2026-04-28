# freelo time status

Print the caller's currently-running time tracking session, or `{ active: false }` when no timer is running. **Always exits 0** — "no active timer" is a normal state, not an error.

## Synopsis

```bash
freelo time status
```

No arguments, no flags. Reads the caller's own session — there is no session id; Freelo enforces one-active-timer-per-user.

## Idempotency

**N/A** — read-only.

## Envelope

`schema: "freelo.time.status/v1"`

The `data` field is a **discriminated union** keyed on `active`. Agents `switch` on the discriminant and the union narrows without nullish checks.

### Active session (HTTP 200)

```json
{
  "schema": "freelo.time.status/v1",
  "data": {
    "active": true,
    "session": {
      "uuid": "tt-uuid-12345",
      "started_at": "2026-04-28T10:00:00Z",
      "elapsed_seconds": 1738,
      "task": {
        "id": 4567,
        "name": "Investigate bug",
        "project": { "id": 11, "name": "Web" },
        "tasklist": { "id": 22, "name": "Backend" }
      },
      "note": "Investigating bug #4567",
      "is_billable": true,
      "is_cost_fixed": false,
      "labels": [{ "name": "bug" }],
      "cost": { "amount": "100", "currency": "CZK" },
      "project_setting": null
    }
  },
  "rate_limit": { "remaining": 40, "reset_at": "2026-04-28T20:30:00Z" }
}
```

Notes on the active shape:

- `started_at` is a CLI-friendly rename of the wire `date_reported` field.
- `elapsed_seconds` is **derived client-side** at envelope-build time. Negative values (clock skew between client and server, or a malformed `started_at`) clamp to `0`.
- `task` is `null` for general (taskless) work.
- `task.project` and `task.tasklist` are independently `null` if the task is not assigned to one.
- `cost` and `project_setting` are passthrough — they reflect what would land in a work report if you stopped the timer right now. Their inner shape is Freelo-defined and we don't promise it.

### No active timer (HTTP 204 No Content)

```json
{
  "schema": "freelo.time.status/v1",
  "data": { "active": false },
  "rate_limit": { "remaining": 40, "reset_at": "2026-04-28T20:30:00Z" }
}
```

The `session` field is **absent** in the inactive arm — agents can detect "nothing running" by checking `data.active === false` without ever indexing into `data.session`.

## Examples

### Branch on the discriminant

```bash
$ STATUS=$(freelo time status --output json)
$ ACTIVE=$(echo "$STATUS" | jq -r '.data.active')

$ if [ "$ACTIVE" = "true" ]; then
    TASK_ID=$(echo "$STATUS" | jq -r '.data.session.task.id // "none"')
    ELAPSED=$(echo "$STATUS" | jq -r '.data.session.elapsed_seconds')
    echo "Tracking task #$TASK_ID for $ELAPSED seconds."
  else
    echo "No active timer."
  fi
```

### Pretty-print elapsed time (human mode)

```bash
$ freelo time status
Tracking task #4567 "Investigate bug" for 28m 58s (started 2026-04-28T10:00:00Z) — "Investigating bug #4567".
```

```bash
$ freelo time status
No active timer.
```

### Verify before starting

```bash
# Idempotent "make sure I'm tracking task X":
$ STATUS=$(freelo time status --output json)
$ if [ "$(echo "$STATUS" | jq -r '.data.active')" = "false" ]; then
    freelo time start --task 4567
  elif [ "$(echo "$STATUS" | jq -r '.data.session.task.id')" != "4567" ]; then
    # R20: time edit will reassign without losing elapsed minutes.
    echo "Already tracking a different task; will switch via time edit (R20)."
  fi
```

## Errors

| Trigger         | code            | exit |
| --------------- | --------------- | ---- |
| GET 401         | `AUTH_EXPIRED`  | 3    |
| GET 5xx         | `SERVER_ERROR`  | 4    |
| HTTP 429        | `RATE_LIMITED`  | 6    |
| Network failure | `NETWORK_ERROR` | 5    |

**HTTP 204 is not an error.** The CLI translates it to `data.active: false` and exits 0.

## Non-goals

- **No `--watch` / live-clock mode.** The agent-first contract assumes the caller polls on its own schedule. Add a tiny shell loop if you want one.
- **No per-task or per-project totals.** That's a work-reports concern (`reports list` in R21).

## See also

- [`freelo time start`](./time-start.md) — start a timer.
- [Spec 0030](../specs/0030-time-start-status.md) — full design and decision log.
- [Roadmap R19 / R20 / R21 / R22](../roadmap.md) — full time-tracking sub-thread.
