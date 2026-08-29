# freelo tasklists edit

Partially update an existing tasklist — rename it, adjust its budget or time
fund, manage followers and the default worker, and reorder it within its
project. Emits a stable `freelo.tasklists.edit/v1` envelope.

Only the flags you pass are changed; everything else is left untouched.

## Synopsis

```bash
freelo tasklists edit <id> [--name <str>]
                          [--budget <amount> | --clear-budget]
                          [--time-budget-minutes <n> | --clear-time-budget]
                          [--worker <id> | --clear-worker]
                          [--tracking-users <id> ... | --clear-tracking-users]
                          [--should-change-existing-tasks]
                          [--priority <n>]
                          [--dry-run] [--yes]
```

At least one mutating flag is required. `--should-change-existing-tasks` alone
does not count.

## Options

| Flag                             | Type / values                               | Purpose                                                                                                                                                       |
| -------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<id>`                           | positive integer                            | Tasklist id (from `freelo tasklists list`).                                                                                                                   |
| `--name <str>`                   | non-empty string                            | Rename the tasklist. Whitespace-only exits 2.                                                                                                                 |
| `--budget <amount>`              | digits-only string                          | Budget in **minor currency units**, e.g. `100000` for 1000.00. Decimals are rejected. Mutex with `--clear-budget`.                                            |
| `--clear-budget`                 | flag                                        | Remove the budget (sends `null`). Mutex with `--budget`.                                                                                                      |
| `--time-budget-minutes <n>`      | integer >= 0                                | Time fund in whole minutes. **`0` is a real value** (a zero fund), not a clear. Mutex with `--clear-time-budget`.                                             |
| `--clear-time-budget`            | flag                                        | Remove the time fund (sends `null`). Mutex with `--time-budget-minutes`.                                                                                      |
| `--worker <id>`                  | positive integer                            | Set the tasklist's default worker. Mutex with `--clear-worker`.                                                                                               |
| `--clear-worker`                 | flag                                        | Remove the default worker (sends `null`). Mutex with `--worker`.                                                                                              |
| `--tracking-users <id>`          | positive integer, **repeatable**            | Follower user id. Pass the flag once per user; the ids you give **replace the whole follower set**. Mutex with `--clear-tracking-users`.                      |
| `--clear-tracking-users`         | flag                                        | Remove all followers (sends `[]`). Mutex with `--tracking-users`.                                                                                             |
| `--should-change-existing-tasks` | flag                                        | Also apply the follower change to **every existing task** in the tasklist. Requires a follower flag, and requires `--yes` (or a TTY confirmation). See below. |
| `--priority <n>`                 | positive integer                            | Move the tasklist to **position** `n` within its project (1 = first). **Ordering, not importance.** See below.                                                |
| `--dry-run`                      | flag                                        | Skip the POST. The envelope echoes the body that _would_ have gone on the wire. Also skips the confirmation prompt.                                           |
| `--yes` / `-y`                   | flag (global)                               | Bypass the confirmation prompt for `--should-change-existing-tasks`.                                                                                          |
| `--output <mode>`                | `auto` (default), `human`, `json`, `ndjson` | `auto` resolves to `json` on a non-TTY, `human` otherwise. Inherited global flag.                                                                             |
| `--profile <name>`               | string                                      | Credential profile to use. Inherited global flag.                                                                                                             |
| `--request-id <uuid>`            | string                                      | Override the auto-generated request ID.                                                                                                                       |

All validation runs before any HTTP call.

## `--priority` is a position, not an importance level

This is the **third** distinct meaning of "priority" in the Freelo API, and the
easiest to get wrong:

| Where                                     | Meaning                                                |
| ----------------------------------------- | ------------------------------------------------------ |
| `tasklists edit --priority <n>`           | **This one.** Position of the tasklist in its project. |
| `tasks edit --priority low\|normal\|high` | Task importance (`priority_enum` on the wire).         |
| `tasks list --order-by priority`          | Sort key, again positional.                            |

`--priority 1` moves the tasklist to the top of its project. Other tasklists
shift by one to fill the gap. Values past the end are clamped to the last
position by the server — that is not an error. Passing `high` here exits 2.

## Partial success: `priority_applied`

The reorder is applied **outside** the transaction that commits every other
field. Freelo can therefore save your rename, budget, followers and worker
while failing the reorder — and it reports this with a `priorityApplied: false`
in the response.

The CLI surfaces that as a **successful (exit 0)** envelope with
`data.priority_applied: false` plus a `notice`:

```jsonc
{
  "schema": "freelo.tasklists.edit/v1",
  "data": {
    "tasklist_id": 9001,
    "priority_requested": true,
    "priority_applied": false,
    "applied_changes": { "name": "Renamed", "priority": 3 },
  },
  "notice": "Tasklist updated, but the priority reorder was NOT applied ... Retry the reorder alone with: freelo tasklists edit 9001 --priority 3",
}
```

**Agents: branch on `data.priority_applied`, not on the exit code.** The exit
code is 0 because everything else committed; retrying the whole command would
needlessly re-apply the other fields (and could re-fire
`--should-change-existing-tasks`). Retry only the priority:

```bash
freelo tasklists edit 9001 --priority 3
```

`data.priority_requested` disambiguates the two ways `priority_applied` can be
`true`: the reorder succeeded, or no reorder was asked for. Both fields are
present on **every** response.

## `--should-change-existing-tasks` is confirmation-gated

`--tracking-users` / `--clear-tracking-users` on their own change the
**tasklist's** followers — one row, low blast radius, no confirmation.

Adding `--should-change-existing-tasks` propagates that change to **every
existing task** in the tasklist. Freelo returns no record of which tasks it
touched, so the change cannot be reviewed or reversed afterwards. The CLI
therefore applies the same gate it uses for destructive commands:

- `--yes` → proceed.
- `--dry-run` → proceed without prompting (nothing happens).
- TTY without `--yes` → confirmation prompt, defaulting to No.
- **Non-TTY without `--yes` → exits 2 with `CONFIRMATION_REQUIRED`.**

No other flag combination on this command is gated.

## Endpoint called

`POST /tasklist/{tasklist_id}/edit`

Request body — only keys you set are sent:

```jsonc
{
  "name": "Sprint 12",
  "budget": "100000", // null clears
  "time_budget_minutes": 480, // null clears; 0 is a real value
  "priority": 1,
  "tracking_users_ids": [12, 34], // [] clears
  "should_change_existing_tasks": true,
  "worker_id": 77, // null clears
}
```

Response body is `{ "priorityApplied": boolean }` — and nothing else. There is
no tasklist entity in the response, which is why this command does **not** do a
follow-up read. Use [`freelo tasklists show`](./tasklists-show.md) to see the
post-edit state.

## Envelope

`schema: "freelo.tasklists.edit/v1"`

Live success:

```jsonc
{
  "schema": "freelo.tasklists.edit/v1",
  "data": {
    "tasklist_id": 9001,
    "priority_requested": false,
    "priority_applied": true,
    "applied_changes": { "name": "QA checklist", "budget": "100000" },
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-08-29T10:30:00Z" },
  "request_id": "...",
}
```

`--dry-run`:

```jsonc
{
  "schema": "freelo.tasklists.edit/v1",
  "dry_run": true,
  "data": {
    "tasklist_id": 9001,
    "priority_requested": false,
    "priority_applied": true,
    "applied_changes": { "name": "Preview", "budget": null },
    "would": {
      "method": "POST",
      "path": "/tasklist/9001/edit",
      "body": { "name": "Preview", "budget": null },
    },
  },
}
```

`data.tasklist_id`, `data.priority_requested`, `data.priority_applied` and
`data.applied_changes` are always present. `data.would` is present only under
`--dry-run`. None of the documented fields are removed, renamed, or retyped
within `v1`; new fields are additive only.

## Examples

### Rename

```bash
$ freelo tasklists edit 9001 --name "QA checklist (v2)"
Updated tasklist #9001.
  + name: QA checklist (v2)
```

### Set a budget and time fund

```bash
$ freelo tasklists edit 9001 --budget 100000 --time-budget-minutes 480
Updated tasklist #9001.
  + budget: 100000 (minor units, e.g. 100000 = 1000.00)
  + time budget: 480 min
```

### Clear the budget and the default worker

```bash
$ freelo tasklists edit 9001 --clear-budget --clear-worker
Updated tasklist #9001.
  + budget: cleared
  + default worker: cleared
```

### Move to the top of its project

```bash
$ freelo tasklists edit 9001 --priority 1
Updated tasklist #9001.
  + position in project: 1 (ordering, not importance)
```

### Replace followers and push the change to every existing task

```bash
$ freelo tasklists edit 9001 --tracking-users 12 --tracking-users 34 \
    --should-change-existing-tasks --yes
Updated tasklist #9001.
  + followers: #12, #34
  + follower change propagated to EVERY existing task in the tasklist
```

### Preview a wide change before running it

```bash
$ freelo tasklists edit 9001 --clear-tracking-users --should-change-existing-tasks \
    --dry-run --output json
{"schema":"freelo.tasklists.edit/v1","dry_run":true,"data":{"tasklist_id":9001,"priority_requested":false,"priority_applied":true,"applied_changes":{"tracking_users_ids":[],"should_change_existing_tasks":true},"would":{"method":"POST","path":"/tasklist/9001/edit","body":{"tracking_users_ids":[],"should_change_existing_tasks":true}}}}
```

## Errors and exit codes

| Trigger                                                  | Exit  | Code                    | Notes                                                    |
| -------------------------------------------------------- | ----- | ----------------------- | -------------------------------------------------------- |
| Non-positive / non-numeric `<id>`                        | 2     | `VALIDATION_ERROR`      |                                                          |
| No mutating flag passed                                  | 2     | `VALIDATION_ERROR`      | Lists the accepted flags.                                |
| `--name` empty or whitespace-only                        | 2     | `VALIDATION_ERROR`      |                                                          |
| `--budget` not digits-only (e.g. `100.50`)               | 2     | `VALIDATION_ERROR`      | Hint names the minor-units convention.                   |
| `--time-budget-minutes` negative or non-integer          | 2     | `VALIDATION_ERROR`      | `0` is accepted.                                         |
| `--worker` / `--tracking-users` not a positive integer   | 2     | `VALIDATION_ERROR`      |                                                          |
| `--priority` not a positive integer                      | 2     | `VALIDATION_ERROR`      | Hint disambiguates position vs. importance.              |
| Any set/clear mutex pair passed together                 | 2     | `VALIDATION_ERROR`      | e.g. `--budget` + `--clear-budget`.                      |
| `--should-change-existing-tasks` without a follower flag | 2     | `VALIDATION_ERROR`      |                                                          |
| `--should-change-existing-tasks`, non-TTY, no `--yes`    | 2     | `CONFIRMATION_REQUIRED` | Fails closed. No HTTP call is made.                      |
| HTTP 400                                                 | 4     | `FREELO_API_ERROR`      | Hint names the budget encoding.                          |
| HTTP 401                                                 | 3     | `AUTH_EXPIRED`          | Hint suggests `freelo auth login`.                       |
| HTTP 403                                                 | 4     | `FORBIDDEN`             | Hint mentions permission to edit this tasklist.          |
| HTTP 404                                                 | 4     | `FREELO_API_ERROR`      | Tasklist not found or not visible.                       |
| HTTP 429                                                 | 6     | `RATE_LIMITED`          | Retryable.                                               |
| HTTP 5xx                                                 | 4     | `SERVER_ERROR`          | Retryable.                                               |
| Network failure                                          | 5     | `NETWORK_ERROR`         |                                                          |
| 200 response missing `priorityApplied`                   | 4     | `VALIDATION_ERROR`      | Contract break; fails fast rather than assuming a value. |
| `priorityApplied: false`                                 | **0** | —                       | **Not an error.** See "Partial success" above.           |

## Required Freelo permissions

Caller must be a project manager or higher on the tasklist's project. A 403
indicates the account lacks the necessary role.

## Notes and intentional gaps

- **`--budget` is a verbatim string in minor units.** `"100000"` = 1000.00 of
  the project's currency. The CLI does not parse or normalize it — the string
  is passed through unchanged to avoid float-precision drift. Decimal strings
  are rejected client-side because Freelo answers them with a bare 400.
- **Follower ids without access are silently dropped by Freelo.** The API
  filters out users who cannot see the tasklist and does **not** report which
  ones it removed. The response carries no follower echo, so the CLI cannot
  detect this either. Verify with
  [`freelo tasklists show`](./tasklists-show.md) if it matters.
- **No batch input.** Unlike the delete commands, `tasklists edit` takes a
  single `<id>` and has no `--ids` / `--stdin`. Applying one identical body to
  many tasklists is rarely meaningful here (and is self-contradictory for
  `--priority`, which is positional). Per-resource NDJSON batching is a
  possible future slice.
- **No post-edit read.** The endpoint returns no entity, and
  `GET /tasklist/{id}` does not include `budget`, so a refresh would not
  confirm the most interesting field anyway.
- **Idempotent.** Re-running the same edit re-applies the same values and
  succeeds.

## Related commands

- [`freelo tasklists show`](./tasklists-show.md) — read one tasklist's detail.
- [`freelo tasklists list`](./tasklists-list.md) — discover tasklist ids.
- [`freelo tasklists create`](./tasklists-create.md) — create a new tasklist.
- [`freelo tasks edit`](./tasks-edit.md) — edit a task (note its `--priority` means importance).
