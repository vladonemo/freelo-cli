# freelo tasks estimate

Manage a task's **time estimate** (in minutes), either as the team-wide
total or as a per-user breakdown for capacity planning. Two leaf
subcommands:

- `freelo tasks estimate set <id> --minutes <n> [--user <id>]` — upsert an
  estimate.
- `freelo tasks estimate clear <id> [--user <id>]` — remove an estimate.
  **Destructive**; requires `--yes` in non-TTY mode.

The `--user <id>` flag toggles between the team-wide total and a single
user's per-user estimate. Both leaves are **single-id v1**. Batch
(`--ids` / `--stdin`) is not supported in this slice.

> **Per-user estimates are independent of the total.** Setting one does NOT
> update the other. Manage them separately. (Documented Freelo server
> behavior — `docs/api/freelo-api.yaml:2325`.)

## Synopsis

```bash
freelo tasks estimate set   <id> --minutes <n> [--user <id>] [--dry-run]
freelo tasks estimate clear <id>                [--user <id>] [--yes] [--dry-run]
```

## `tasks estimate set`

Sets (or upserts) a task's time estimate, in minutes. The server upserts
on every call — a second invocation with a new value overwrites the prior
one (no separate "update" verb needed).

### Options

| Flag            | Type / values | Default | Purpose                                                                                                            |
| --------------- | ------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `<id>`          | positive int  | —       | Task id (numeric). Required.                                                                                       |
| `--minutes <n>` | positive int  | —       | Estimate in minutes (>= 1). **Required.**                                                                          |
| `--user <id>`   | positive int  | —       | When present, sets a per-user estimate (independent of the total). When absent, sets the team-wide total estimate. |
| `--dry-run`     | boolean       | false   | Skip the `POST`; envelope echoes the body that would have been sent.                                               |

`--output`, `--color`, `--profile`, `-v/-vv`, `--request-id` are inherited
global flags.

### Wire mapping

| invocation                               | wire                                            |
| ---------------------------------------- | ----------------------------------------------- |
| `set <task> --minutes <n>`               | `POST /task/{task}/total-time-estimate`         |
| `set <task> --minutes <n> --user <user>` | `POST /task/{task}/users-time-estimates/{user}` |

Both variants send the same body: `{ "minutes": <n> }`.

### Envelope

`schema: freelo.tasks.estimate.set/v1`

| Field     | Type                | Always present | Notes                                                                                        |
| --------- | ------------------- | -------------- | -------------------------------------------------------------------------------------------- |
| `task_id` | int                 | yes            | Echo of `<id>` positional.                                                                   |
| `user_id` | int \| null         | yes            | `null` for total scope; numeric for per-user scope.                                          |
| `minutes` | int                 | yes            | Echo of `--minutes <n>`. (Server response is a generic success body without a minutes echo.) |
| `scope`   | `'total' \| 'user'` | yes            | Discriminator derived from `--user` presence.                                                |
| `would`   | object              | dry-run only   | `{ method: 'POST', path, body: { minutes } }`.                                               |

There is **no** `already_in_target_state` field on `set`. The OpenAPI does
not document a GET on either endpoint, so the wire cannot tell us whether
this call set a new value or replaced an existing one. Mirrors the R36
`share.created: null` decision (be honest about wire ambiguity).

### Examples

```bash
# Set a 2-hour total estimate:
$ freelo tasks estimate set 4567 --minutes 120 --output json
{"schema":"freelo.tasks.estimate.set/v1","data":{"task_id":4567,"user_id":null,"minutes":120,"scope":"total"}}

# Set a 90-minute per-user estimate for user #42:
$ freelo tasks estimate set 4567 --minutes 90 --user 42 --output json
{"schema":"freelo.tasks.estimate.set/v1","data":{"task_id":4567,"user_id":42,"minutes":90,"scope":"user"}}

# Dry-run echoes the canonical body:
$ freelo tasks estimate set 4567 --minutes 120 --dry-run --output json
{"schema":"freelo.tasks.estimate.set/v1","dry_run":true,"data":{"task_id":4567,"user_id":null,"minutes":120,"scope":"total","would":{"method":"POST","path":"/task/4567/total-time-estimate","body":{"minutes":120}}}}

# Compose with shell math: 1.5 hours = 90 minutes:
$ freelo tasks estimate set 4567 --minutes $((90)) --output json
```

### Errors

| Condition                                               | Error                             | Exit |
| ------------------------------------------------------- | --------------------------------- | ---- |
| `<id>` is non-numeric or `<= 0`                         | `ValidationError`                 | 2    |
| `--minutes` missing                                     | `ValidationError`                 | 2    |
| `--minutes <= 0` or non-integer                         | `ValidationError`                 | 2    |
| `--user` is non-numeric or `<= 0`                       | `ValidationError`                 | 2    |
| 401 (token invalid)                                     | `FreeloApiError` (`AUTH_EXPIRED`) | 3    |
| 403 (caller can't edit this task / user not assignable) | `FreeloApiError` (`FORBIDDEN`)    | 4    |
| 404 (task or user not found)                            | `FreeloApiError` (`NOT_FOUND`)    | 4    |
| 5xx                                                     | `FreeloApiError`                  | 4    |

## `tasks estimate clear`

Removes a task's time estimate. **Destructive** — Freelo recommends
re-creating immediately if you intended to update rather than clear (use
`set` for updates; the server upserts).

### Options

| Flag          | Type / values | Default | Purpose                                                                         |
| ------------- | ------------- | ------- | ------------------------------------------------------------------------------- |
| `<id>`        | positive int  | —       | Task id (numeric). Required.                                                    |
| `--user <id>` | positive int  | —       | When present, clears a per-user estimate. When absent, clears the team total.   |
| `--yes`       | boolean       | false   | Bypass the confirmation prompt. **Required in non-TTY mode** (e.g. CI, agents). |
| `--dry-run`   | boolean       | false   | Skip the `DELETE`; envelope echoes the path that would have been called.        |

### Confirmation policy (single-id flow)

Mirrors `tasks delete` (R13), `tasks remind clear` (R35), `tasks unshare`
(R36):

- `--yes` → unconditional proceed.
- `--dry-run` → unconditional proceed (no destructive effect).
- TTY without `--yes` → prompt; user declines → `ConfirmationError`
  (exit 2).
- Non-TTY without `--yes` → throw `ConfirmationError` (exit 2)
  immediately. Never prompts in non-TTY (would hang waiting on stdin).

The prompt copy is scope-aware:

- Total: `"Clear total time estimate on task #<id>?"`
- Per-user: `"Clear time estimate for user #<user> on task #<id>?"`

### Idempotency

The Freelo server returns 200 with `{ result: 'success' }` on `DELETE`
**even when no estimate existed** for the task (or for the user, in the
per-user case). The wire cannot distinguish "had an estimate, deleted it"
from "had no estimate, no-op".

The CLI surfaces this honestly:

- Live 200 → `already_in_target_state: false` (we don't know it was
  already cleared).
- Defensive 404 → `already_in_target_state: true` (forward-compat for if
  Freelo ever tightens the endpoint).

### Wire mapping

| invocation                   | wire                                              |
| ---------------------------- | ------------------------------------------------- |
| `clear <task>`               | `DELETE /task/{task}/total-time-estimate`         |
| `clear <task> --user <user>` | `DELETE /task/{task}/users-time-estimates/{user}` |

Both variants send no body.

### Envelope

`schema: freelo.tasks.estimate.clear/v1`

| Field                     | Type                | Always present | Notes                                                       |
| ------------------------- | ------------------- | -------------- | ----------------------------------------------------------- |
| `task_id`                 | int                 | yes            | Echo of `<id>` positional.                                  |
| `user_id`                 | int \| null         | yes            | `null` for total scope; numeric for per-user scope.         |
| `scope`                   | `'total' \| 'user'` | yes            | Discriminator derived from `--user` presence.               |
| `already_in_target_state` | boolean             | yes            | `true` only on the defensive 404 path; `false` on live 200. |
| `would`                   | object              | dry-run only   | `{ method: 'DELETE', path, body: {} }`                      |

### Examples

```bash
# Clear total estimate (TTY, prompts):
$ freelo tasks estimate clear 4567
? Clear total time estimate on task #4567? (y/N) y
{"schema":"freelo.tasks.estimate.clear/v1","data":{"task_id":4567,"user_id":null,"scope":"total","already_in_target_state":false}}

# Clear total estimate (agent-style):
$ freelo tasks estimate clear 4567 --yes --output json
{"schema":"freelo.tasks.estimate.clear/v1","data":{"task_id":4567,"user_id":null,"scope":"total","already_in_target_state":false}}

# Clear a per-user estimate:
$ freelo tasks estimate clear 4567 --user 42 --yes --output json
{"schema":"freelo.tasks.estimate.clear/v1","data":{"task_id":4567,"user_id":42,"scope":"user","already_in_target_state":false}}

# Defensive 404 (forward-compat path) → already_in_target_state: true
$ freelo tasks estimate clear 4567 --yes --output json
{"schema":"freelo.tasks.estimate.clear/v1","data":{"task_id":4567,"user_id":null,"scope":"total","already_in_target_state":true}}

# Dry-run (per-user) echoes the path that would have been called:
$ freelo tasks estimate clear 4567 --user 42 --dry-run --output json
{"schema":"freelo.tasks.estimate.clear/v1","dry_run":true,"data":{"task_id":4567,"user_id":42,"scope":"user","already_in_target_state":false,"would":{"method":"DELETE","path":"/task/4567/users-time-estimates/42","body":{}}}}
```

### Errors

| Condition                                     | Error                             | Exit |
| --------------------------------------------- | --------------------------------- | ---- |
| `<id>` is non-numeric or `<= 0`               | `ValidationError`                 | 2    |
| `--user` is non-numeric or `<= 0`             | `ValidationError`                 | 2    |
| Non-TTY without `--yes` (and not `--dry-run`) | `ConfirmationError`               | 2    |
| TTY without `--yes`, user declines            | `ConfirmationError`               | 2    |
| 401 (token invalid)                           | `FreeloApiError` (`AUTH_EXPIRED`) | 3    |
| 5xx                                           | `FreeloApiError`                  | 4    |

## Required Freelo permissions

Both leaves require **edit access to the task** (i.e. the calling user
must be a worker on the task or a project manager). Per-user estimates
additionally require the targeted `<user>` to be an assignable worker on
the task's tasklist; otherwise the server returns 403 / 404 (yaml :2326).

## Related

- `freelo tasks edit <id>` — change the task's metadata (title, due date,
  worker). Does not manage estimates.
- `freelo time entries list` — log actual time spent against a task (the
  _actual_ counterpart of these _estimate_ commands).

## Roadmap reference

R37 (Wave 6 — Advanced task surface). Spec:
[`docs/specs/0051-r37-tasks-estimate.md`](../specs/0051-r37-tasks-estimate.md).
