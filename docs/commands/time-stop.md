# freelo time stop

Stop the active time tracking session and convert it into a finalized **work report** (R20).

> **Singleton per user.** The endpoint always targets the caller's own active session — there is no session id. When no timer is running, Freelo returns HTTP **409 Conflict** with `"Timetracking is not running."`; the CLI rewrites the hint to point at [`freelo time start`](./time-start.md).

## Synopsis

```bash
# Stop the active timer and emit the resulting work report.
freelo time stop [--dry-run]
```

No flags are required. The endpoint takes **no request body** per the OpenAPI spec — `time` and `note` data already attached to the active session via [`freelo time start`](./time-start.md) or [`freelo time edit`](./time-edit.md) are preserved into the resulting work report.

## Arguments / Options

| Flag        | Type    | Default | Purpose                                                                        |
| ----------- | ------- | ------- | ------------------------------------------------------------------------------ |
| `--dry-run` | boolean | false   | Skip the POST; envelope echoes the path that would have been called (no body). |

> **Why no `--note` flag?** The roadmap proposed `freelo time stop [--note <str>]`, but the OpenAPI spec for `/timetracking/stop` does not document a request body — sending one would be guessing API behavior. To stamp a final note before stopping, chain [`freelo time edit --note "..."`](./time-edit.md) immediately before `freelo time stop`. See spec 0032 decision 1.

## Idempotency

**N/A** — there's no "already stopped" absorbing state to hit. A second `time stop` immediately after the first returns 409 (no active session); the CLI surfaces it with the friendly hint, exit code 4.

## Output schema

`freelo.time.stop/v1` — additive, `/v1`.

### Live shape (`data`)

```jsonc
{
  "schema": "freelo.time.stop/v1",
  "data": {
    "work_report": {
      "id": 987,
      "date_add": "2026-04-28T15:30:00Z",
      "date_reported": "2026-04-28",
      "minutes": 42,
      "note": "WIP",
      "task": { "id": 4567, "name": "Investigate bug" },
      "cost": { "amount": "0", "currency": "CZK" },
      "worker": { "id": 1, "fullname": "agent" },
      "author": { "id": 1, "fullname": "agent" },
    },
  },
  "rate_limit": { "remaining": 999, "reset_at": "..." },
}
```

`task` and `cost` are `null` for general (taskless) work or when no cost was tracked. `worker` and `author` may be `null` on edge cases; the envelope normalizes the shape so agents see consistent keys.

### Dry-run shape

```jsonc
{
  "schema": "freelo.time.stop/v1",
  "dry_run": true,
  "data": {
    "would": {
      "method": "POST",
      "path": "/timetracking/stop",
      "body": null,
    },
  },
}
```

`work_report` is **absent** in dry-run mode (no POST happened, no report exists).

## Examples

### Basic

```bash
$ freelo time stop --output json
{"schema":"freelo.time.stop/v1","data":{"work_report":{"id":987,"minutes":42,"task":{"id":4567,"name":"Investigate bug"},...}},"rate_limit":{...}}
```

### No active session (the load-bearing edge)

```bash
$ freelo time stop --output json
# (stderr)
{"schema":"freelo.error/v1","error":{"code":"FREELO_API_ERROR","http_status":409,"hint_next":"No active time tracking session for your account. Use `freelo time start` to begin one.","retryable":false}}
# exit 4
```

### Two-call sequence: stamp a final note, then stop

```bash
$ freelo time edit --note "shipped" && freelo time stop
```

This is the workaround for the missing `--note` flag on `time stop` — see the OpenAPI discrepancy callout above.

### Dry-run

```bash
$ freelo time stop --dry-run --output json
{"schema":"freelo.time.stop/v1","dry_run":true,"data":{"would":{"method":"POST","path":"/timetracking/stop","body":null}}}
```

## Errors and exit codes

| Trigger                                | Code               | Exit | Notes                                                                         |
| -------------------------------------- | ------------------ | ---- | ----------------------------------------------------------------------------- |
| No active time tracking session        | `FREELO_API_ERROR` | 4    | HTTP 409. Hint points at `freelo time start`.                                 |
| Auth (missing / expired credentials)   | `FREELO_API_ERROR` | 3    | HTTP 401. Run `freelo auth login` (or set `FREELO_API_KEY` / `FREELO_EMAIL`). |
| Server error (5xx)                     | `FREELO_API_ERROR` | 4    | `retryable: true`. The endpoint accepts a manual retry from the agent.        |
| Network failure                        | `NETWORK_ERROR`    | 5    | DNS / connection refused / timeout.                                           |
| Rate limited (writes don't auto-retry) | `RATE_LIMITED`     | 6    | After Freelo's `Retry-After` window.                                          |

## See also

- [`freelo time start`](./time-start.md) — start a session (with optional `--at` backdate).
- [`freelo time edit`](./time-edit.md) — change task / note while running.
- [`freelo time status`](./time-status.md) — read the active session.

## Required scopes

Standard Freelo API token (`FREELO_API_KEY` + `FREELO_EMAIL`). Token must belong to the same account that started the session — the endpoint operates on the caller's own active session.
