# freelo tasks remind

Manage **your personal reminder** on a task. Reminders are per-user — they
ping the calling user only, not other workers on the task. Two leaf
subcommands:

- `freelo tasks remind set <id> --at <ISO>` — schedule (or overwrite) the
  caller's reminder.
- `freelo tasks remind clear <id>` — remove the caller's reminder.
  **Destructive**; requires `--yes` in non-TTY mode.

Both leaves are **single-id v1**. Batch (`--ids` / `--stdin`) is not
supported in this slice.

## Synopsis

```bash
freelo tasks remind set <id> --at <ISO> [--dry-run]
freelo tasks remind clear <id> [--yes] [--dry-run]
```

## `tasks remind set`

Schedules (or overwrites) the calling user's personal reminder on a task.
Non-destructive — Freelo upserts on a second call (overwrites the prior
`remind_at`).

### Options

| Flag         | Type / values       | Default | Purpose                                                                                                                                               |
| ------------ | ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<id>`       | positive int        | —       | Task id (numeric). Required.                                                                                                                          |
| `--at <iso>` | ISO 8601 / RFC 3339 | —       | UTC ISO 8601 timestamp when the reminder should fire. **Required.** Accepts timezone offsets and bare `YYYY-MM-DD`; normalized to UTC before sending. |
| `--dry-run`  | boolean             | false   | Skip the `POST /task/{id}/reminder`; envelope echoes the body that would have been sent.                                                              |

`--output`, `--color`, `--profile`, `-v/-vv`, `--request-id` are inherited
global flags.

### `--at` validation

The CLI parses `--at` permissively (anything `Date.parse()` accepts) and
canonicalizes to second-precision UTC `YYYY-MM-DDTHH:MM:SSZ` before sending.

| Input                              | Wire (`remind_at`)     | Notes                                         |
| ---------------------------------- | ---------------------- | --------------------------------------------- |
| `2099-01-01T09:00:00Z`             | `2099-01-01T09:00:00Z` | Already canonical; passed through             |
| `2099-01-01T11:00:00+02:00`        | `2099-01-01T09:00:00Z` | Timezone offset normalized to UTC             |
| `2099-04-28`                       | `2099-04-28T00:00:00Z` | Bare date → midnight UTC                      |
| `2099-01-01T09:00:00.500Z`         | `2099-01-01T09:00:00Z` | Milliseconds stripped                         |
| `not a date`                       | —                      | `ValidationError` (exit 2)                    |
| `1970-01-01T00:00:00Z` (>60 s ago) | —                      | `ValidationError` (exit 2) — clock-skew clamp |

The clamp rejects timestamps more than 60 s in the past — reminders only
make sense for upcoming instants. The 60 s tolerance window accommodates
NTP drift and integration-replay handoff lag.

### Envelope

`schema: freelo.tasks.remind.set/v1`

| Field       | Type           | Always present | Notes                                                                  |
| ----------- | -------------- | -------------- | ---------------------------------------------------------------------- |
| `task_id`   | int            | yes            | Echo of `<id>` positional.                                             |
| `task_name` | string \| null | live only      | From server response. `null` if server omits.                          |
| `remind_at` | string         | yes            | Canonical UTC ISO. Live: server response. Dry-run: input echo.         |
| `would`     | object         | dry-run only   | `{ method: 'POST', path: '/task/<id>/reminder', body: { remind_at } }` |

### Examples

```bash
# Schedule a reminder at 09:00 UTC tomorrow:
$ freelo tasks remind set 4567 --at 2099-01-01T09:00:00Z --output json
{"schema":"freelo.tasks.remind.set/v1","data":{"task_id":4567,"task_name":"Review PR","remind_at":"2099-01-01T09:00:00Z"}}

# Local time (CET) → normalized to UTC on the wire:
$ freelo tasks remind set 4567 --at 2099-01-01T11:00:00+02:00 --output json
# Wire body: { "remind_at": "2099-01-01T09:00:00Z" }

# Dry-run echoes the canonical body:
$ freelo tasks remind set 4567 --at 2099-01-01T09:00:00Z --dry-run --output json
{"schema":"freelo.tasks.remind.set/v1","dry_run":true,"data":{"task_id":4567,"remind_at":"2099-01-01T09:00:00Z","would":{"method":"POST","path":"/task/4567/reminder","body":{"remind_at":"2099-01-01T09:00:00Z"}}}}

# Validation: missing --at:
$ freelo tasks remind set 4567
# stderr: VALIDATION_ERROR — --at is required. exit 2.

# Validation: --at in the past:
$ freelo tasks remind set 4567 --at 1970-01-01T00:00:00Z
# stderr: VALIDATION_ERROR — --at is in the past. exit 2.
```

## `tasks remind clear`

Removes the calling user's personal reminder. **Destructive** — gates the
`DELETE /task/{id}/reminder` behind the shared confirmation helper
(`src/lib/confirm.ts`, R13).

### Options

| Flag        | Type / values    | Default | Purpose                                                                                                                     |
| ----------- | ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `<id>`      | positive int     | —       | Task id (numeric). Required.                                                                                                |
| `--dry-run` | boolean          | false   | Skip the DELETE; envelope echoes the path that would have been called. No confirmation prompt fires.                        |
| `-y, --yes` | boolean (global) | false   | Bypass the confirmation prompt. **Required** in non-TTY mode (otherwise the run fails closed with `CONFIRMATION_REQUIRED`). |

### Confirmation policy

Same as every other destructive command in the CLI (R13 / `tasks delete`):

| Mode                            | `--yes`? | `--dry-run`? | Behaviour                                                                                               |
| ------------------------------- | -------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| Any                             | yes      | —            | Bypass; proceed silently to the DELETE.                                                                 |
| Any                             | —        | yes          | Bypass; emit dry-run envelope; **no DELETE happens**.                                                   |
| TTY (interactive shell)         | no       | no           | Prompt: `Clear reminder on task #<id>?`. Default is **no**. Decline → `CONFIRMATION_REQUIRED` (exit 2). |
| **Non-TTY** (pipe / agent / CI) | no       | no           | Throw `CONFIRMATION_REQUIRED` (exit 2) **before any wire call**. Never hangs waiting on stdin.          |

### Idempotency note

The Freelo server returns `200` with `SuccessResponse` even when no
reminder was set on the task (yaml :2125). The wire **cannot** distinguish
"had a reminder, deleted it" from "had no reminder, no-op" by status
alone. Consequently:

- A live `200` always emits `already_in_target_state: false` — we don't
  pretend to know what we don't know.
- A defensive `404` (forward-compat path, in case Freelo ever tightens the
  endpoint) is re-classified as `already_in_target_state: true`.

Agents that need pre-clear state should fetch it explicitly before
calling `clear`.

### Envelope

`schema: freelo.tasks.remind.clear/v1`

| Field                     | Type    | Always present | Notes                                                                |
| ------------------------- | ------- | -------------- | -------------------------------------------------------------------- |
| `task_id`                 | int     | yes            | Echo of `<id>` positional.                                           |
| `already_in_target_state` | boolean | yes            | `true` only on the defensive 404 path; otherwise `false` (see note). |
| `would`                   | object  | dry-run only   | `{ method: 'DELETE', path: '/task/<id>/reminder', body: {} }`        |

### Examples

```bash
# Clear a reminder (TTY, prompts):
$ freelo tasks remind clear 4567
? Clear reminder on task #4567? (y/N) y
{"schema":"freelo.tasks.remind.clear/v1","data":{"task_id":4567,"already_in_target_state":false}}

# Clear a reminder (agent-style):
$ freelo tasks remind clear 4567 --yes --output json
{"schema":"freelo.tasks.remind.clear/v1","data":{"task_id":4567,"already_in_target_state":false}}

# Dry-run: no DELETE, no prompt:
$ freelo tasks remind clear 4567 --dry-run --output json
{"schema":"freelo.tasks.remind.clear/v1","dry_run":true,"data":{"task_id":4567,"already_in_target_state":false,"would":{"method":"DELETE","path":"/task/4567/reminder","body":{}}}}

# Non-TTY without --yes (pipe / agent / CI):
$ echo | freelo tasks remind clear 4567
# stderr: CONFIRMATION_REQUIRED — Refusing in non-interactive mode without --yes. exit 2.
```

## Permissions

- API key with edit access to the task. The reminder operations are
  per-user; you can only manage your own reminders.
- 401 → `AUTH_EXPIRED` (exit 3); 403 → `FORBIDDEN` (exit 4); 404 → either
  `NOT_FOUND` (exit 4) on `set`, or success-with-`already_in_target_state`
  on `clear`.

## See also

- `freelo tasks show <id>` — view a task's metadata.
- `freelo tasks edit <id>` — partial task update (R10).
