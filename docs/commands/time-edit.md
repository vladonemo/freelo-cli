# freelo time edit

Edit the active time tracking session in flight — switch the tracked task or update the note without stopping and starting (R20).

> **Singleton per user.** The endpoint always targets the caller's own active session — there is no session id. When no timer is running, Freelo returns HTTP **409 Conflict** with `"Timetracking is not running."`; the CLI rewrites the hint to point at [`freelo time start`](./time-start.md).

## Synopsis

```bash
# Reassign the session to a different task
freelo time edit --task <id> [--note <str>] [--dry-run]

# Disassociate the session from any task (continue as general work)
freelo time edit --clear-task [--note <str>] [--dry-run]

# Update only the note
freelo time edit --note <str> [--dry-run]
```

**At least one** of `--task`, `--clear-task`, `--note` is required. An empty edit is a usage error (`VALIDATION_ERROR` exit 2) — see [Validation](#validation).

## Arguments / Options

| Flag           | Type             | Default | Purpose                                                                                                              |
| -------------- | ---------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `--task <id>`  | positive integer | unset   | Reassign the active session to this task id. Mutually exclusive with `--clear-task`.                                 |
| `--clear-task` | boolean          | false   | Disassociate the active session from any task — sends `task_id: null` on the wire. Mutually exclusive with `--task`. |
| `--note <str>` | string           | unset   | Update the active session note. Empty string is allowed (Freelo accepts it).                                         |
| `--dry-run`    | boolean          | false   | Skip the POST; envelope echoes the body that would have been sent.                                                   |

## Validation

The CLI rejects three input shapes at the command boundary, before any HTTP call:

- **Empty edit** (no flags supplied): `VALIDATION_ERROR` exit 2. Hint: pass at least one of `--task`, `--clear-task`, `--note`.
- **Mutex conflict** (`--task <id>` + `--clear-task`): `VALIDATION_ERROR` exit 2. Pick one.
- **Bad task id** (`--task abc`, `--task 0`, `--task -3`): `VALIDATION_ERROR` exit 2. Same parser as [`freelo time start --task`](./time-start.md).

## Why no `--started-at <ISO>` flag?

The roadmap proposed a `--started-at` flag for backdating an in-flight session, but the OpenAPI request body for `POST /timetracking/edit` documents only `task_id` and `note` — there is no `date_reported` / `started_at` field on the wire. Sending one would be guessing API behavior. Deferred to a follow-up slice (R20.5), mirroring the R19 → R19.5 pattern that introduced `--at` on `time start`. See spec 0032 decision 2.

## Idempotency

**N/A** — `time edit` is not absorbing-state. Every call is a fresh write; agents that retry on transient errors (5xx) get whatever the server's idempotency-on-write semantics provide.

## Output schema

`freelo.time.edit/v1` — additive, `/v1`.

### Live shape (`data`)

```jsonc
{
  "schema": "freelo.time.edit/v1",
  "data": {
    "uuid": "f...",
    "applied_changes": {
      "task_id": 4568,
      "note": "switched context",
    },
  },
  "rate_limit": { "remaining": 999, "reset_at": "..." },
}
```

`applied_changes` mirrors the wire body shape **exactly** — keys are present **only** when the user passed the corresponding flag:

- `--task 4568` → `applied_changes: { task_id: 4568 }`.
- `--clear-task` → `applied_changes: { task_id: null }`.
- `--note "..."` → `applied_changes: { note: "..." }`.
- Combinations include both keys.

Agents read `'task_id' in applied_changes` to know whether the user touched the task field at all (the `null` vs. `absent` distinction is meaningful — null means "explicitly disassociate", absent means "not changed").

### Dry-run shape

```jsonc
{
  "schema": "freelo.time.edit/v1",
  "dry_run": true,
  "data": {
    "applied_changes": { "task_id": 4568, "note": "switched context" },
    "would": {
      "method": "POST",
      "path": "/timetracking/edit",
      "body": { "task_id": 4568, "note": "switched context" },
    },
  },
}
```

`uuid` is **absent** in dry-run (no POST happened, no UUID issued).

## Examples

### Switch task

```bash
$ freelo time edit --task 4568 --output json
{"schema":"freelo.time.edit/v1","data":{"uuid":"f...","applied_changes":{"task_id":4568}},"rate_limit":{...}}
```

### Disassociate (continue as general work)

```bash
$ freelo time edit --clear-task --output json
{"schema":"freelo.time.edit/v1","data":{"uuid":"f...","applied_changes":{"task_id":null}}}
# Wire body: { "task_id": null }
```

### Update note only

```bash
$ freelo time edit --note "switched context" --output json
{"schema":"freelo.time.edit/v1","data":{"uuid":"f...","applied_changes":{"note":"switched context"}}}
```

### Combine task + note

```bash
$ freelo time edit --task 4568 --note "investigating bug #4568"
```

### Pre-stop note stamp (workaround for `time stop` not having `--note`)

```bash
$ freelo time edit --note "shipped" && freelo time stop
```

### No active session (the load-bearing edge)

```bash
$ freelo time edit --note "x"
# (stderr)
{"schema":"freelo.error/v1","error":{"code":"FREELO_API_ERROR","http_status":409,"hint_next":"No active time tracking session for your account. Use `freelo time start` to begin one.","retryable":false}}
# exit 4
```

### Mutex conflict

```bash
$ freelo time edit --task 4567 --clear-task
# (stderr)
{"schema":"freelo.error/v1","error":{"code":"VALIDATION_ERROR","message":"--task and --clear-task are mutually exclusive.","hint_next":"Pass --task <id> to reassign, or --clear-task to disassociate. Not both."}}
# exit 2
```

### Empty edit

```bash
$ freelo time edit
# exit 2 — VALIDATION_ERROR with a hint listing the three valid flags
```

### Dry-run

```bash
$ freelo time edit --task 4568 --note "dry" --dry-run --output json
{"schema":"freelo.time.edit/v1","dry_run":true,"data":{"applied_changes":{"task_id":4568,"note":"dry"},"would":{"method":"POST","path":"/timetracking/edit","body":{"task_id":4568,"note":"dry"}}}}
```

## Errors and exit codes

| Trigger                                  | Code               | Exit | Notes                                         |
| ---------------------------------------- | ------------------ | ---- | --------------------------------------------- |
| No flags / mutex conflict / bad `--task` | `VALIDATION_ERROR` | 2    | Caught at the command boundary, no HTTP call. |
| No active time tracking session          | `FREELO_API_ERROR` | 4    | HTTP 409. Hint points at `freelo time start`. |
| Auth (missing / expired credentials)     | `FREELO_API_ERROR` | 3    | HTTP 401.                                     |
| Server error (5xx)                       | `FREELO_API_ERROR` | 4    | `retryable: true`.                            |
| Network failure                          | `NETWORK_ERROR`    | 5    | DNS / connection refused / timeout.           |
| Rate limited                             | `RATE_LIMITED`     | 6    | Writes don't auto-retry.                      |

## OpenAPI vs roadmap discrepancies

This command resolves **three** roadmap-vs-OpenAPI discrepancies (recorded in spec 0032 decisions 2, 3, 8):

1. **Verb is POST, not PATCH.** The roadmap text says `PATCH /timetracking/edit`; OpenAPI yaml :2812 says `post:`. Per the orchestrator hard rule, OpenAPI wins.
2. **No `--started-at <ISO>`.** OpenAPI body has only `task_id` and `note`. Backdating mid-flight deferred to R20.5.
3. **Adds `--task` / `--clear-task`.** OpenAPI explicitly documents `task_id: null` as a meaningful body value (disassociate). Roadmap omitted both flags; we add them so agents can reassign / disassociate.

## See also

- [`freelo time start`](./time-start.md) — start a session.
- [`freelo time stop`](./time-stop.md) — finalize the active session as a work report.
- [`freelo time status`](./time-status.md) — read the active session.

## Required scopes

Standard Freelo API token (`FREELO_API_KEY` + `FREELO_EMAIL`). Token must belong to the same account that started the session.
