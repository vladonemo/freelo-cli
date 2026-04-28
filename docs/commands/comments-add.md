# freelo comments add

Post a single comment to a task. Content comes from one of four input sources, exactly one of which is required:

- `--message <str>` — inline pass-through (no I/O)
- `--from-file <path>` — read a UTF-8 file
- `--editor` — open `$VISUAL` / `$EDITOR` (or platform default) interactively
- `-` (positional sentinel) — read from stdin

Reuses the shared `src/lib/input.ts` helper introduced by R15 (`tasks description set`); `--message` is a fourth source layered on top for one-liner ergonomics.

## ⚠️ First-comment auto-flip

If the target task has **no prior comments**, the Freelo API converts this POST into the task's **description** instead of a regular comment ([API yaml :2589-2592](../api/freelo-api.yaml)). The CLI surfaces this via `data.is_description: true` in the envelope and a hint in the human-mode message. If you want to set a description explicitly, use [`freelo tasks description set`](./tasks-description-set.md) (R15) — it's the right primitive for that intent.

## Synopsis

```bash
# Inline message (one-liner)
freelo comments add --task <id> --message <str> [--dry-run]

# From a file
freelo comments add --task <id> --from-file <path> [--dry-run]

# Interactive (TTY required)
freelo comments add --task <id> --editor [--dry-run]

# From stdin (the literal `-`)
freelo comments add --task <id> - [--dry-run]
```

`--task` is required. Exactly one input source must be specified.

## Arguments / Options

| Flag                 | Type             | Default | Purpose                                                                                                               |
| -------------------- | ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `--task <id>`        | positive integer | —       | Target task id. Required.                                                                                             |
| `--message <str>`    | string           | unset   | Inline comment content. Mutex with `--from-file`, `--editor`, and `-`.                                                |
| `--from-file <path>` | string           | unset   | Read content from a UTF-8 file. Mutex with `--message`, `--editor`, and `-`.                                          |
| `--editor`           | boolean          | false   | Open `$VISUAL` / `$EDITOR` to edit content interactively. Requires a TTY. Mutex with `--message`, `--from-file`, `-`. |
| `<input>` (`-`)      | literal `-`      | unset   | Read content from stdin. Mutex with `--message`, `--from-file`, `--editor`.                                           |
| `--dry-run`          | boolean          | false   | Skip the POST; envelope echoes the body that would have been sent.                                                    |

## Editor resolution

When you pass `--editor`, the editor command is resolved in this order (same as R15):

1. `$VISUAL` (POSIX convention — takes precedence)
2. `$EDITOR`
3. Platform default: `notepad.exe` on Windows, `vi` elsewhere.

Empty env values are treated as unset. The chosen command is split on whitespace (no shell parsing) — so `EDITOR='code --wait'` works for VS Code, `EDITOR='subl -w'` for Sublime, and so on.

`--editor` errors out with `VALIDATION_ERROR` (exit 2) when stdin is not a TTY. In agent / CI environments, pipe content via `-`, use `--from-file <path>`, or pass `--message <str>` directly.

## Idempotency

**N/A by design.** Each `POST /task/{id}/comments` creates a new comment row server-side; there is no natural-key dedupe. Two consecutive identical invocations create two identical comments. If your workflow needs at-most-once delivery, track request ids upstream — the CLI does not retry on success.

`--dry-run` is the safety net for "did I really mean to post this?".

## Empty content is rejected

A successful POST with empty content would create a noise comment that the server would 422 anyway. The CLI rejects empty content (any source — including `--message ''`) at the command layer with `VALIDATION_ERROR` (exit 2), before any wire round-trip.

## Envelope

`schema: "freelo.comments.add/v1"`

### Live success (regular comment)

```json
{
  "schema": "freelo.comments.add/v1",
  "data": {
    "task_id": 9012,
    "comment": {
      "id": 7654321,
      "uuid": "cmt-uuid-abc",
      "content": "<p>Hello world</p>",
      "date_add": "2026-04-28T10:00:00Z",
      "date_edited_at": "2026-04-28T10:00:00Z",
      "is_description": false,
      "author": { "id": 12345, "fullname": "Jane Doe" }
    },
    "source": "message",
    "byte_length": 18,
    "is_description": false
  },
  "rate_limit": { "remaining": 40, "reset_at": "2026-04-28T20:30:00Z" }
}
```

### Live success (auto-flip to description)

When the target task has no prior comments, the API responds with `is_description: true`:

```json
{
  "schema": "freelo.comments.add/v1",
  "data": {
    "task_id": 9012,
    "comment": { "is_description": true, "content": "<p>First note</p>", "...": "..." },
    "source": "message",
    "byte_length": 17,
    "is_description": true
  }
}
```

`data.is_description` is **always present** in live envelopes (defaults to `false` when the server omits the field) so agents can branch on a stable boolean without checking key presence. The raw `comment.is_description` mirrors whatever the server returned (may be `null` / absent on passthrough).

### Dry-run

```json
{
  "schema": "freelo.comments.add/v1",
  "dry_run": true,
  "data": {
    "task_id": 9012,
    "byte_length": 18,
    "would": {
      "method": "POST",
      "path": "/task/9012/comments",
      "body": { "content": "<p>Hello world</p>" }
    }
  }
}
```

`comment`, `source`, and `is_description` are **absent** in dry-run envelopes — the CLI does not synthesise a would-be response. `byte_length` is always present.

## Examples

### Quick inline comment

```bash
$ freelo comments add --task 9012 --message 'Reviewed and approved.'
Added comment to task #9012 (22 bytes from message).
```

### Multi-line content from a file

```bash
$ cat > /tmp/note.html <<EOF
<p>Status update:</p>
<ul><li>API integration: done</li><li>Tests: in review</li></ul>
EOF

$ freelo comments add --task 9012 --from-file /tmp/note.html
Added comment to task #9012 (84 bytes from file).
```

### Interactive editor

```bash
$ EDITOR='code --wait' freelo comments add --task 9012 --editor
# (VS Code opens; save and close to commit the comment)
Added comment to task #9012 (412 bytes from editor).
```

### Pipe from another command

```bash
$ git log --oneline -5 | freelo comments add --task 9012 -
Added comment to task #9012 (293 bytes from stdin).
```

### Dry-run before writing

```bash
$ freelo comments add --task 9012 --message 'Status update' --dry-run --output json
{"schema":"freelo.comments.add/v1","dry_run":true,"data":{"task_id":9012,"byte_length":13,"would":{"method":"POST","path":"/task/9012/comments","body":{"content":"Status update"}}}}
```

### Bulk-comment from a tasklist (compose with `tasks list`)

```bash
$ freelo tasks list --tasklist 4321 --output json \
  | jq -r '.data.tasks[].id' \
  | while read TASK_ID; do
      freelo comments add --task "$TASK_ID" --message 'Stand-up: still on track.'
    done
```

### Detect the description-flip case

```bash
$ ENV=$(freelo comments add --task 9012 --message 'Hello' --output json)
$ if [ "$(echo "$ENV" | jq -r '.data.is_description')" = "true" ]; then
    echo "Note: this became a description, not a comment."
  fi
```

## Errors

| Trigger                                          | code               | exit |
| ------------------------------------------------ | ------------------ | ---- |
| `--task` missing / non-numeric / zero / negative | `VALIDATION_ERROR` | 2    |
| No source flag                                   | `VALIDATION_ERROR` | 2    |
| Two or more source flags                         | `VALIDATION_ERROR` | 2    |
| `--message ''` (empty string)                    | `VALIDATION_ERROR` | 2    |
| `--from-file` with missing file (`ENOENT`)       | `VALIDATION_ERROR` | 2    |
| `--from-file` pointing at a directory (`EISDIR`) | `VALIDATION_ERROR` | 2    |
| `--from-file` unreadable (`EACCES` / `EPERM`)    | `VALIDATION_ERROR` | 2    |
| `--from-file` empty file                         | `VALIDATION_ERROR` | 2    |
| `--editor` in non-TTY                            | `VALIDATION_ERROR` | 2    |
| `--editor` exits non-zero / killed by signal     | `VALIDATION_ERROR` | 2    |
| `--editor` editor command cannot be launched     | `VALIDATION_ERROR` | 2    |
| Unexpected positional (anything other than `-`)  | `VALIDATION_ERROR` | 2    |
| POST 401                                         | `AUTH_EXPIRED`     | 3    |
| POST 403                                         | `FORBIDDEN`        | 4    |
| POST 404 (task missing or no access)             | `NOT_FOUND`        | 4    |
| POST 5xx / 422                                   | `FREELO_API_ERROR` | 4    |
| HTTP 429                                         | `RATE_LIMITED`     | 6    |
| Network failure                                  | `NETWORK_ERROR`    | 5    |

## Non-goals

- **No `--files` / multipart attachments** in v1 — the multipart upload helper lands at R25 (see [`docs/roadmap.md`](../roadmap.md)).
- **No batch input** (`--ids` / `--stdin` NDJSON of `{task_id, content}`) — single-comment-per-invocation only in v1.
- **No edit / delete** — those land at R18.
- **No description-set short-circuit** — even though the API auto-flips the first comment to a description, the CLI does not detect-and-redirect. Use [`freelo tasks description set`](./tasks-description-set.md) when you specifically mean to write a description.

## See also

- [`freelo comments list`](./comments-list.md) (R16) — read comments.
- [`freelo tasks description set`](./tasks-description-set.md) (R15) — explicit description writes.
- [Spec 0028](../specs/0028-comments-add.md) — full design and decision log.
