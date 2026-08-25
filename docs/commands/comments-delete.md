# freelo comments delete

Delete one or more comments. Destructive — every wire call is gated behind a
confirmation step (TTY prompt or `--yes` bypass).

Two Freelo-side rules make this command behave differently from every other
`delete` in the CLI. **Read them before scripting against it:**

- **15-minute window.** A comment can only be deleted within 15 minutes of
  being posted. After that the API refuses and the CLI reports a specific
  window-expired error. Editing has _no_ time limit — see
  [Workaround](#workaround-the-window-has-closed).
- **Author-only, and 404 is not idempotent.** Only the comment's author can
  delete it. Freelo returns `404` (not `403`) for someone else's comment, so
  that inaccessible comments aren't leaked. Because a 404 therefore means
  _either_ "no such comment" _or_ "not yours", this command reports it as an
  **error (exit 4)** — unlike [`tasks delete`](tasks-delete.md), which treats a
  404 as an idempotent already-deleted success.

Three input shapes:

- **Positional** — `freelo comments delete 4821993 4821994 --yes`
- **`--ids`** — `freelo comments delete --ids "4821993,4821994" --yes`
- **`--stdin`** (NDJSON) — pipe `{"id": <comment_id>}` rows in

## Synopsis

```bash
freelo comments delete <id>...        [--yes] [--dry-run]
freelo comments delete --ids "1,2,3"  [--yes] [--dry-run]
freelo comments delete --stdin        [--yes] [--dry-run]
# Per-line NDJSON: {"id": <comment_id>}
```

## Options

| Flag           | Type / values    | Default | Purpose                                                                                                                     |
| -------------- | ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `<id>...`      | positive integer | —       | One or more numeric comment ids. Mutex with `--ids` and `--stdin`.                                                          |
| `--ids <list>` | string           | unset   | Comma- or space-separated list of comment ids. Mutex with positional and `--stdin`.                                         |
| `--stdin`      | boolean          | false   | Read NDJSON from stdin, one `{"id": <int>}` per line. Mutex with positional and `--ids`.                                    |
| `--dry-run`    | boolean          | false   | Skip the `DELETE /comment/{id}` call AND the confirmation prompt. Envelope echoes the path that would have been called.     |
| `-y, --yes`    | boolean (global) | false   | Bypass the confirmation prompt. **Required** in non-TTY mode (otherwise the run fails closed with `CONFIRMATION_REQUIRED`). |

`--output`, `--color`, `--profile`, `-v/-vv`, `--request-id` are inherited
global flags.

Unlike [`comments edit`](comments-edit.md), the literal `-` is **not** accepted
as a positional. There it means "read the comment content from stdin"; delete
has no content, so `-` is rejected as an invalid id.

## Confirmation policy

The shared `confirmDestructive` helper (`src/lib/confirm.ts`) gates every
destructive command:

| Mode                            | `--yes`? | `--dry-run`? | Behaviour                                                                                          |
| ------------------------------- | -------- | ------------ | -------------------------------------------------------------------------------------------------- |
| Any                             | yes      | —            | Bypass; proceed silently to the DELETE.                                                            |
| Any                             | —        | yes          | Bypass; emit dry-run envelope; **no DELETE happens**.                                              |
| TTY (interactive shell)         | no       | no           | Prompt: `Delete N comments? (y/N)`. Default is **no**. Decline → `CONFIRMATION_REQUIRED` (exit 2). |
| **Non-TTY** (pipe / agent / CI) | no       | no           | Throw `CONFIRMATION_REQUIRED` (exit 2) **before any wire call**. Never hangs waiting on stdin.     |

Confirmation is **per-run, not per-id** — one prompt for the whole batch.

## Behavior

```
Input resolution:
  positional / --ids / --stdin → one of three sources, mutex-checked.

Confirmation gate (once for the whole run):
  --yes OR --dry-run → bypass.
  Non-TTY without --yes → throw CONFIRMATION_REQUIRED (exit 2).
  TTY without --yes → prompt; declined → CONFIRMATION_REQUIRED (exit 2).

For each id:
  --dry-run          → emit envelope with `would: { method: 'DELETE', path: '/comment/{id}', body: {} }`.
  Live DELETE 200    → emit success envelope.
  DELETE returns 400 → window-expired error (exit 4). NOT a generic "HTTP 400".
  DELETE returns 404 → not-found error (exit 4). NOT an idempotent success.
  Other HTTP error   → bubble (single-id) or per-line error envelope (multi/batch).
```

**No GET pre-check.** The command does not fetch the comment to inspect its age
or author before deleting — two round-trips on a destructive op isn't justified,
and the DELETE response is authoritative.

## Permissions

- API key belonging to **the comment's author**. Nobody else can delete a
  comment, not even a project manager.
- A comment you don't own returns `404` (`NOT_FOUND`, exit 4) — deliberately
  indistinguishable from a comment that doesn't exist.

## Envelope

`schema: "freelo.comments.delete/v1"`

Live success:

```json
{
  "schema": "freelo.comments.delete/v1",
  "data": {
    "comment_id": 4821993,
    "current_state": "deleted",
    "already_in_target_state": false
  },
  "rate_limit": { "remaining": 4998, "reset_at": "2026-08-25T09:00:00Z" },
  "request_id": "..."
}
```

Dry-run (no DELETE happens):

```json
{
  "schema": "freelo.comments.delete/v1",
  "dry_run": true,
  "data": {
    "comment_id": 4821993,
    "current_state": "deleted",
    "already_in_target_state": false,
    "would": { "method": "DELETE", "path": "/comment/4821993", "body": {} }
  }
}
```

`already_in_target_state` is **always `false`** here. The field exists so that
agents looping deletes across `tasks` / `projects` / `labels` / `comments` read
one field shape everywhere, but this command never absorbs a 404 into a success,
so it can never be `true`.

In **batch mode** (`--stdin`), each envelope carries an additional
`data.line_index` field (0-indexed across non-empty input lines). Single,
positional-multi, and `--ids` envelopes do **not** carry `line_index`.

## Examples

### Single comment

```bash
$ freelo comments delete 4821993 --yes
Deleted comment #4821993.

$ freelo comments delete 4821993 --yes --output json
{"schema":"freelo.comments.delete/v1","data":{"comment_id":4821993,"current_state":"deleted","already_in_target_state":false},"rate_limit":{...}}
```

### Multiple comments (positional)

```bash
$ freelo comments delete 4821993 4821994 --yes --output ndjson
{"schema":"freelo.comments.delete/v1","data":{"comment_id":4821993,"current_state":"deleted","already_in_target_state":false}}
{"schema":"freelo.comments.delete/v1","data":{"comment_id":4821994,"current_state":"deleted","already_in_target_state":false}}
```

### Dry-run (no destructive effect, no confirmation needed)

```bash
$ freelo comments delete 4821993 --dry-run --output json
{"schema":"freelo.comments.delete/v1","dry_run":true,"data":{"comment_id":4821993,"current_state":"deleted","already_in_target_state":false,"would":{"method":"DELETE","path":"/comment/4821993","body":{}}}}
$ echo $?
0
```

### Batch via `--stdin`

```bash
$ cat <<EOF | freelo comments delete --stdin --yes --output json
{"id": 4821993}
{"id": 4821994}
EOF
{"schema":"freelo.comments.delete/v1","data":{"comment_id":4821993,...,"line_index":0},...}
{"schema":"freelo.comments.delete/v1","data":{"comment_id":4821994,...,"line_index":1},...}
```

### Clean up your own just-posted comments

Because of the 15-minute window, the realistic composition is "undo what I just
posted" — filter `comments list` down to your own recent rows:

```bash
$ freelo comments list --type task --output ndjson \
  | jq -c 'select(.author.email == "me@example.cz") | {id: .id}' \
  | freelo comments delete --stdin --yes --output ndjson
```

### The 15-minute window has expired

```bash
$ freelo comments delete 4700001 --yes --output json
{"schema":"freelo.error/v1","error":{"code":"FREELO_API_ERROR","message":"Comment 4700001 can no longer be deleted — Freelo's 15-minute deletion window since the comment was posted has expired.","errors":["Comment is too old to be deleted."],"http_status":400,"retryable":false,"hint_next":"Freelo only allows a comment to be deleted within 15 minutes of posting (docs/api/freelo-api.yaml :3216-3217). Editing has no time limit — use `freelo comments edit 4700001 --message \"…\"` to redact the content instead.","docs_url":null}}
$ echo $?
4
```

### Someone else's comment (or a nonexistent one)

```bash
$ freelo comments delete 4821993 --yes --output json
{"schema":"freelo.error/v1","error":{"code":"NOT_FOUND","message":"Comment 4821993 not found.","http_status":404,"retryable":false,"hint_next":"It may not exist, or you may not be its author — Freelo returns 404 rather than 403 for comments you cannot access, so the two cases are indistinguishable from the API (docs/api/freelo-api.yaml :3215). Only a comment's own author can delete it.","docs_url":null}}
$ echo $?
4
```

Note the exit code is **4**, not 0. Scripts that loop over ids and tolerate
"already gone" must check for this explicitly — you cannot assume a 404 here
means the work is done.

### Confirmation in non-TTY without `--yes`

```bash
$ echo '{"id": 4821993}' | freelo comments delete --stdin --output json
{"schema":"freelo.error/v1","error":{"code":"CONFIRMATION_REQUIRED","message":"Delete 1 comment? Refusing in non-interactive mode without --yes.","retryable":false,"hint_next":"Pass --yes to bypass the prompt, or run from a TTY.","docs_url":null}}
$ echo $?
2
```

## Workaround: the window has closed

Once 15 minutes have passed the comment cannot be removed, but
[`comments edit`](comments-edit.md) has **no time limit**. To redact content:

```bash
$ freelo comments edit 4700001 --message "[removed]"
```

The comment stays in the thread as an edited stub — that's the best Freelo's API
allows after the window.

## Errors

| Trigger                                             | code                    | exit |
| --------------------------------------------------- | ----------------------- | ---- |
| `<id>` not a positive integer                       | `VALIDATION_ERROR`      | 2    |
| `--ids` empty / no source supplied                  | `VALIDATION_ERROR`      | 2    |
| Combining input sources (positional + `--ids` etc.) | `VALIDATION_ERROR`      | 2    |
| NDJSON line not valid JSON or missing/extra fields  | `VALIDATION_ERROR`      | 2    |
| Non-TTY without `--yes` (no `--dry-run`)            | `CONFIRMATION_REQUIRED` | 2    |
| TTY user declines the prompt                        | `CONFIRMATION_REQUIRED` | 2    |
| **DELETE 400 — 15-minute window expired**           | `FREELO_API_ERROR`      | 4    |
| DELETE 401                                          | `AUTH_EXPIRED`          | 3    |
| DELETE 403                                          | `FORBIDDEN`             | 4    |
| **DELETE 404 — missing or not your comment**        | `NOT_FOUND`             | 4    |
| DELETE 5xx                                          | `SERVER_ERROR`          | 4    |
| HTTP 429                                            | `RATE_LIMITED`          | 6    |
| Network failure                                     | `NETWORK_ERROR`         | 5    |

In batch mode, per-row failures emit `freelo.error/v1` envelopes on stdout and
the run-level exit is `max(per-row exit codes)`.

## Non-goals

- **No `--force`.** The 15-minute window is enforced server-side; there is
  nothing to override.
- **No restore.** Freelo exposes no un-delete endpoint for comments.
- **No bulk-by-filter delete.** Compose
  `freelo comments list --output ndjson | jq | freelo comments delete --stdin`.
- **No per-id confirmation prompt** in batch mode. One prompt per run is the
  contract.

See [spec 0061](../specs/0061-m01-comments-delete.md) for the design rationale,
including why a 404 is an error here and not an idempotent success.
