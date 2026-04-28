# freelo comments edit

Overwrite the content of one or more existing comments. Wraps `POST /comment/{comment_id}` ([OpenAPI yaml :2619-2663](../api/freelo-api.yaml)) — the verb is **POST**, not PUT/PATCH (yaml :2634, "POST for historical reasons").

Edit is **non-destructive** — there is no confirmation prompt and no `--yes` flag. Edit is **not absorbing-state** — every successful POST returns the updated comment; two consecutive identical edits both report success.

## When to reach for this

- Fix a typo or update copy in a posted comment
- Bulk-update many comments with the same canned message (batch via `--ids`)
- Drive per-comment varied content from a script (batch via `--stdin` NDJSON)

## Synopsis

```bash
# Single id, content from one of four sources (mutex, exactly one):
freelo comments edit <id> --message <str>     [--dry-run]
freelo comments edit <id> --from-file <path>  [--dry-run]
freelo comments edit <id> --editor            [--dry-run]
freelo comments edit <id> -                   [--dry-run]   # `-` = stdin content (single-id only)

# Batch over comment ids — shared content from --message/--from-file/--editor:
freelo comments edit <id1> <id2> <id3> --message <str>     [--dry-run]
freelo comments edit --ids "1,2,3"     --message <str>     [--dry-run]

# Batch via NDJSON — varied content per row:
freelo comments edit --stdin < edits.ndjson                [--dry-run]
# Each line: {"id": <int>, "content": <str>}
```

Exactly **one** input source: positional `<id>...`, `--ids`, or `--stdin`. On non-stdin paths, exactly **one** content source: `--message`, `--from-file`, `--editor`, or `-`.

## Arguments / Options

| Flag                 | Type                              | Default | Purpose                                                                                                                       |
| -------------------- | --------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `<id>...`            | positive integer(s) (variadic)    | —       | One or more comment ids. Mutex with `--ids` and `--stdin`.                                                                    |
| `-` (positional)     | literal `-`                       | unset   | Read content from stdin. **Single id only** — cannot combine with multi-id positional or `--ids` (decision 1, spec 0029).     |
| `--ids <list>`       | comma- / space-separated integers | unset   | Batch ids in one flag. Mutex with positional `<id>` and `--stdin`.                                                            |
| `--stdin`            | boolean                           | false   | Read NDJSON from stdin (one `{"id": <int>, "content": <str>}` per line). Mutex with positional / `--ids` and content sources. |
| `--message <str>`    | string                            | unset   | Inline content. Mutex with `--from-file`, `--editor`, and `-`.                                                                |
| `--from-file <path>` | string                            | unset   | Read content from a UTF-8 file. Mutex with the other content sources.                                                         |
| `--editor`           | boolean                           | false   | Open `$VISUAL` / `$EDITOR` to edit content interactively. Requires a TTY. Mutex with the other content sources.               |
| `--dry-run`          | boolean                           | false   | Skip every POST; envelope echoes what would have been sent.                                                                   |

## Editor resolution

When you pass `--editor`, the editor command is resolved in this order (same as R15 / R17):

1. `$VISUAL`
2. `$EDITOR`
3. Platform default: `notepad.exe` on Windows, `vi` elsewhere.

`--editor` errors with `VALIDATION_ERROR` (exit 2) when stdin is not a TTY.

## Empty content rejected

A POST with empty content would 422 server-side (the OpenAPI's request body declares `content` required and non-nullable). The CLI rejects empty content (any source — including `--message ''`, an empty file, or `"content": ""` in NDJSON) at the command layer with `VALIDATION_ERROR` (exit 2), before any wire round-trip.

## ACL / authorship

Per yaml :2631-2633, only the comment's author (or project owner / commander) can edit. A non-author edit returns **404** (not 403) — the API does this deliberately to avoid leaking the existence of inaccessible comments. The CLI's 404 hint names both possible causes ("not found, or your account does not have permission to edit it").

## Idempotency

**N/A by design.** Each `POST /comment/{id}` replaces the content; there is no "already in target state" semantics on edit. Two consecutive identical invocations both return success with the same response shape — neither is reported as `already_in_target_state`. If your workflow needs at-most-once delivery, track request ids upstream.

`--dry-run` is the safety net for "did I really mean to send this?".

## Envelope

`schema: "freelo.comments.edit/v1"`

### Live success (single id)

```json
{
  "schema": "freelo.comments.edit/v1",
  "data": {
    "comment_id": 1234567,
    "comment": {
      "id": 1234567,
      "uuid": "cmt-uuid-edit",
      "content": "<p>Updated content</p>",
      "date_add": "2026-04-28T10:00:00Z",
      "date_edited_at": "2026-04-28T11:00:00Z",
      "is_description": false,
      "author": { "id": 12345, "fullname": "Jane Doe" }
    },
    "source": "message",
    "byte_length": 22
  },
  "rate_limit": { "remaining": 98, "reset_at": "2026-04-28T20:30:00Z" }
}
```

### Live success (NDJSON batch row)

NDJSON envelopes carry `line_index` (0-indexed) and `source: "ndjson"`:

```json
{
  "schema": "freelo.comments.edit/v1",
  "data": {
    "comment_id": 1234567,
    "comment": { "...": "..." },
    "source": "ndjson",
    "byte_length": 32,
    "line_index": 0
  },
  "rate_limit": { "remaining": 97, "reset_at": "..." }
}
```

### Dry-run

```json
{
  "schema": "freelo.comments.edit/v1",
  "dry_run": true,
  "data": {
    "comment_id": 1234567,
    "byte_length": 13,
    "would": {
      "method": "POST",
      "path": "/comment/1234567",
      "body": { "content": "Status update" }
    }
  }
}
```

`comment` and `source` are **absent** in dry-run envelopes. `byte_length` is always present.

### Batch error envelope (per-row)

When a batch run has mixed successes and failures, each failed row emits a `freelo.error/v1` envelope with `context.input_index` (positional / `--ids`) or `context.line_index` (`--stdin`) plus `context.comment_id` when the row's id was parseable:

```json
{
  "schema": "freelo.error/v1",
  "error": {
    "code": "NOT_FOUND",
    "message": "Not found (HTTP 404).",
    "http_status": 404,
    "request_id": null,
    "retryable": false,
    "hint_next": "Comment 1234568 not found, or your account does not have permission to edit it (...)",
    "docs_url": null,
    "context": { "input_index": 1, "comment_id": 1234568 }
  }
}
```

The run exits with the **numerically highest** observed exit code (matches `tasks delete` / `tasks finish`). Ordering of stdout envelopes matches input order.

## Examples

### Quick inline edit (single id)

```bash
$ freelo comments edit 1234567 --message 'Updated: see PR #42 for the fix.'
Edited comment #1234567 (32 bytes from message).
```

### Bulk-rewrite from a file (shared content across ids)

```bash
$ cat > /tmp/closing-note.html <<'EOF'
<p>Closed by sprint-review on 2026-04-28.</p>
EOF

$ freelo comments edit --ids "1234567,1234568,1234569" --from-file /tmp/closing-note.html --output json
{"schema":"freelo.comments.edit/v1","data":{"comment_id":1234567,"comment":{"...":"..."},"source":"file","byte_length":47},"rate_limit":{"remaining":98,"reset_at":"..."}}
{"schema":"freelo.comments.edit/v1","data":{"comment_id":1234568,...},"rate_limit":{...}}
{"schema":"freelo.comments.edit/v1","data":{"comment_id":1234569,...},"rate_limit":{...}}
```

### Per-row varied content via NDJSON (agent-style)

```bash
$ cat > edits.ndjson <<'EOF'
{"id":1234567,"content":"Updated: see PR #42 for the fix."}
{"id":1234568,"content":"Reverted; root cause was upstream."}
EOF

$ FREELO_API_KEY=sk-... FREELO_EMAIL=agent@example.cz \
    freelo comments edit --stdin --output json < edits.ndjson
{"schema":"freelo.comments.edit/v1","data":{"comment_id":1234567,"comment":{...},"source":"ndjson","byte_length":32,"line_index":0},"rate_limit":{...}}
{"schema":"freelo.comments.edit/v1","data":{"comment_id":1234568,"comment":{...},"source":"ndjson","byte_length":34,"line_index":1},"rate_limit":{...}}
```

### Pipe content from another tool (single id)

```bash
$ git log --oneline -1 | freelo comments edit 1234567 -
Edited comment #1234567 (52 bytes from stdin).
```

### Dry-run preview before sending

```bash
$ freelo comments edit 1234567 --message 'Status update' --dry-run --output json
{"schema":"freelo.comments.edit/v1","dry_run":true,"data":{"comment_id":1234567,"byte_length":13,"would":{"method":"POST","path":"/comment/1234567","body":{"content":"Status update"}}}}
```

### Compose with `comments list` (find-then-edit)

```bash
$ freelo comments list --project 5678 --output json \
  | jq -r '.data.comments[] | select(.author.id == 12345) | .id' \
  | xargs -I {} freelo comments edit {} --message 'Author note: archived 2026-04.'
```

## Errors

| Trigger                                                             | code               | exit |
| ------------------------------------------------------------------- | ------------------ | ---- |
| `<id>` non-numeric / zero / negative (via `--ids`)                  | `VALIDATION_ERROR` | 2    |
| No ids supplied                                                     | `VALIDATION_ERROR` | 2    |
| Multiple input sources (positional + `--ids` / `--stdin`)           | `VALIDATION_ERROR` | 2    |
| `--stdin` combined with `--message` / `--from-file` / `--editor`    | `VALIDATION_ERROR` | 2    |
| No content source on non-stdin path                                 | `VALIDATION_ERROR` | 2    |
| Multiple content sources                                            | `VALIDATION_ERROR` | 2    |
| `-` combined with multiple ids (decision 1)                         | `VALIDATION_ERROR` | 2    |
| `--message ''` (empty) / empty file / NDJSON empty `content`        | `VALIDATION_ERROR` | 2    |
| `--from-file` ENOENT / EISDIR / EACCES                              | `VALIDATION_ERROR` | 2    |
| `--editor` in non-TTY                                               | `VALIDATION_ERROR` | 2    |
| NDJSON malformed line / missing `id` / strict-schema violation      | `VALIDATION_ERROR` | 2    |
| POST 401                                                            | `AUTH_EXPIRED`     | 3    |
| POST 403 (defensive — yaml says 404 on ACL)                         | `FORBIDDEN`        | 4    |
| POST 404 (comment missing OR caller is not the author / lacks role) | `NOT_FOUND`        | 4    |
| POST 422 / other 4xx                                                | `FREELO_API_ERROR` | 4    |
| POST 5xx                                                            | `SERVER_ERROR`     | 4    |
| POST 429                                                            | `RATE_LIMITED`     | 6    |
| Network failure                                                     | `NETWORK_ERROR`    | 5    |

In batch mode, each failed id emits its own `freelo.error/v1` envelope to stdout; the run exits with the **numerically highest** observed code.

## Non-goals

- **No `--files` / multipart attachment replacement** — the multipart helper lands at R25 (see [`docs/roadmap.md`](../roadmap.md)). Wire body sends only `content`; the existing attachment set on the comment is left untouched.
- **No `comments delete`** — deferred to R18.5 pending Freelo API confirmation that a delete endpoint exists. As of 2026-04-28, no `delete:` operation appears on `/comment/{comment_id}` in `docs/api/freelo-api.yaml`.
- **No description-flip awareness** — `comments edit` does not check or change `is_description` (only the original `comments add` POST can flip a comment to a description).
- **No `--yes` interaction** — edit is non-destructive; the global `--yes` flag is ignored here.

## See also

- [`freelo comments add`](./comments-add.md) (R17) — create a comment on a task.
- [`freelo comments list`](./comments-list.md) (R16) — read comments across projects.
- [`freelo tasks description set`](./tasks-description-set.md) (R15) — explicit description writes (uses the same input helper).
- [Spec 0029](../specs/0029-comments-edit.md) — full design and decision log.
