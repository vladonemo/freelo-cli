# freelo tasks unshare

Revoke the public share link on a task — invalidates any previously
shared URL immediately. **Destructive**: requires `--yes` in non-TTY
mode (otherwise the run fails closed).

The companion command is [`freelo tasks share`](./tasks-share.md), which
gets (or creates) the URL.

## Synopsis

```bash
freelo tasks unshare <id> [--yes] [--dry-run]
```

## Options

| Flag        | Type / values    | Default | Purpose                                                                                                                     |
| ----------- | ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `<id>`      | positive int     | —       | Task id (numeric). Required.                                                                                                |
| `--dry-run` | boolean          | false   | Skip the DELETE; envelope echoes the path that would have been called. No confirmation prompt fires.                        |
| `-y, --yes` | boolean (global) | false   | Bypass the confirmation prompt. **Required** in non-TTY mode (otherwise the run fails closed with `CONFIRMATION_REQUIRED`). |

## Wire mapping

```
DELETE /public-link/task/{task_id}
```

## Confirmation policy

Same as every other destructive command in the CLI (R13 / `tasks delete`):

| Mode                            | `--yes`? | `--dry-run`? | Behaviour                                                                                                         |
| ------------------------------- | -------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| Any                             | yes      | —            | Bypass; proceed silently to the DELETE.                                                                           |
| Any                             | —        | yes          | Bypass; emit dry-run envelope; **no DELETE happens**.                                                             |
| TTY (interactive shell)         | no       | no           | Prompt: `Revoke public share link on task #<id>?`. Default is **no**. Decline → `CONFIRMATION_REQUIRED` (exit 2). |
| **Non-TTY** (pipe / agent / CI) | no       | no           | Throw `CONFIRMATION_REQUIRED` (exit 2) **before any wire call**. Never hangs waiting on stdin.                    |

## Idempotency note

A live `200` always emits `already_in_target_state: false`. The Freelo
OpenAPI is silent on the no-link-yet case; if the server happens to
return `404` (forward-compat path, in case Freelo ever tightens the
endpoint), the CLI re-classifies it as `already_in_target_state: true`
rather than surfacing a confusing `NOT_FOUND` on a delete-of-nothing.

This means:

- Calling `unshare` on a task that has no public link returns success
  (whether the server collapses to 200 or 404 is invisible to the CLI
  caller — both end with success and the appropriate flag).
- Idempotent retries are safe: re-running `unshare <id>` after a
  successful unshare is a no-op success.

## Envelope

`schema: freelo.tasks.unshare/v1`

| Field                     | Type    | Always present | Notes                                                            |
| ------------------------- | ------- | -------------- | ---------------------------------------------------------------- |
| `task_id`                 | int     | yes            | Echo of `<id>` positional.                                       |
| `already_in_target_state` | boolean | yes            | `true` on the defensive 404 path; otherwise `false`.             |
| `would`                   | object  | dry-run only   | `{ method: 'DELETE', path: '/public-link/task/<id>', body: {} }` |

## Examples

```bash
# Revoke a share link (TTY, prompts):
$ freelo tasks unshare 4567
? Revoke public share link on task #4567? (y/N) y
{"schema":"freelo.tasks.unshare/v1","data":{"task_id":4567,"already_in_target_state":false}}

# Revoke (agent-style):
$ freelo tasks unshare 4567 --yes --output json
{"schema":"freelo.tasks.unshare/v1","data":{"task_id":4567,"already_in_target_state":false}}

# Re-running on an already-unshared task is a no-op success (defensive 404):
$ freelo tasks unshare 4567 --yes --output json
{"schema":"freelo.tasks.unshare/v1","data":{"task_id":4567,"already_in_target_state":true}}

# Dry-run: no DELETE, no prompt:
$ freelo tasks unshare 4567 --dry-run --output json
{"schema":"freelo.tasks.unshare/v1","dry_run":true,"data":{"task_id":4567,"already_in_target_state":false,"would":{"method":"DELETE","path":"/public-link/task/4567","body":{}}}}

# Non-TTY without --yes (pipe / agent / CI):
$ echo | freelo tasks unshare 4567
# stderr: CONFIRMATION_REQUIRED — Refusing in non-interactive mode without --yes. exit 2.

# Rotate the link in one shell:
$ freelo tasks unshare 4567 --yes && freelo tasks share 4567
```

## Permissions

- API key with edit access to the task. Revoking a public link is
  considered a metadata edit on the task.
- 401 → `AUTH_EXPIRED` (exit 3); 403 → `FORBIDDEN` (exit 4); 404 → does
  **not** error — re-classified as success with
  `already_in_target_state: true`.

## See also

- [`freelo tasks share`](./tasks-share.md) — get (or create) the link.
- [`freelo tasks delete`](./tasks-delete.md) — destructive command
  precedent for the confirmation policy.
