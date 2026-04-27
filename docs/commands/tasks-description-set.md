# freelo tasks description set

Replace a task's rich-text description (upsert — first call creates,
subsequent call **overwrites** entirely; no append, no history). Content
comes from one of three input sources:

- `--from-file <path>` — read a UTF-8 file
- `--editor` — open `$VISUAL` / `$EDITOR` (or platform default) interactively
- `-` (positional sentinel) — read from stdin

This is the first command to use the shared `src/lib/input.ts` helper;
future write commands (`comments add`, `reports edit`) will reuse the same
input shape.

## Synopsis

```bash
# From a file
freelo tasks description set <id> --from-file <path> [--dry-run]

# Interactive (TTY required)
freelo tasks description set <id> --editor [--dry-run]

# From stdin (the literal `-`)
freelo tasks description set <id> - [--dry-run]
```

Exactly one input source must be specified. `<id>` is required; the input
sentinel `-` is positional (after `<id>`).

## Arguments / Options

| Argument / Flag      | Type             | Default | Purpose                                                                                                     |
| -------------------- | ---------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `<id>`               | positive integer | —       | Task id. Required.                                                                                          |
| `<input>` (`-`)      | literal `-`      | unset   | Read content from stdin. Mutex with `--from-file` and `--editor`.                                           |
| `--from-file <path>` | string           | unset   | Read content from a UTF-8 file. Mutex with `--editor` and `-`.                                              |
| `--editor`           | boolean          | false   | Open `$VISUAL` / `$EDITOR` to edit content interactively. Requires a TTY. Mutex with `--from-file` and `-`. |
| `--dry-run`          | boolean          | false   | Skip the POST; envelope echoes the body that would have been sent.                                          |

## Editor resolution

The editor command is resolved in this order:

1. `$VISUAL` (POSIX convention — takes precedence)
2. `$EDITOR`
3. Platform default: `notepad.exe` on Windows, `vi` elsewhere.

Empty env values are treated as unset. The chosen command is split on
whitespace (no shell parsing) — so `EDITOR='code --wait'` works for VS
Code, `EDITOR='subl -w'` for Sublime, and so on.

`--editor` errors out with `VALIDATION_ERROR` (exit 2) when stdin is not a
TTY. In agent / CI environments, pipe content via `-` or use
`--from-file <path>` instead.

## Empty content is rejected

A successful `set` with empty content would silently clear the task's
description, which is almost always a destructive accident. The command
rejects this with `VALIDATION_ERROR` (exit 2) and points you at
`freelo tasks edit <id> --description ''` (R10) — the explicit clearing
path.

## Envelope

`schema: "freelo.tasks.description.set/v1"`

### Live success

```json
{
  "schema": "freelo.tasks.description.set/v1",
  "data": {
    "task_id": 9012,
    "description": {
      "id": 999001,
      "content": "<p>Updated body</p>",
      "date_add": "2026-04-27T12:00:00Z",
      "files": []
    },
    "source": "file",
    "byte_length": 24
  },
  "rate_limit": { "remaining": 40, "reset_at": "2026-04-27T20:30:00Z" }
}
```

### Dry-run

```json
{
  "schema": "freelo.tasks.description.set/v1",
  "dry_run": true,
  "data": {
    "task_id": 9012,
    "byte_length": 24,
    "would": {
      "method": "POST",
      "path": "/task/9012/description",
      "body": { "content": "<p>Updated body</p>" }
    }
  }
}
```

`description` and `source` are **absent** in dry-run envelopes — the CLI
does not synthesise a "would-be" `Comment` shape. `byte_length` is always
present (so agents can verify the content size against their source file
without parsing `would.body`).

## Examples

### Set from a file

```bash
$ cat > /tmp/desc.html <<EOF
<h2>Acceptance criteria</h2>
<ul><li>Logs in via OIDC</li><li>Stores no PII at rest</li></ul>
EOF

$ freelo tasks description set 9012 --from-file /tmp/desc.html
Updated description for task #9012 (104 bytes from file).
```

### Edit interactively

```bash
$ EDITOR='code --wait' freelo tasks description set 9012 --editor
# (VS Code opens with current description pre-populated; save and close)
Updated description for task #9012 (412 bytes from editor).
```

### Pipe via stdin

```bash
$ echo '<p>Quick fix</p>' | freelo tasks description set 9012 -
Updated description for task #9012 (16 bytes from stdin).
```

### Dry-run before writing

```bash
$ freelo tasks description set 9012 --from-file /tmp/desc.html --dry-run --output json
{"schema":"freelo.tasks.description.set/v1","dry_run":true,"data":{"task_id":9012,"byte_length":104,"would":{"method":"POST","path":"/task/9012/description","body":{"content":"<h2>Acceptance criteria</h2>..."}}}}
```

### Compose with `tasks list` to bulk-update

```bash
$ freelo tasks list --label kickoff --output json \
  | jq -r '.data.tasks[].id' \
  | while read TASK_ID; do
      echo '<p>Reviewed for kickoff readiness ✓</p>' \
        | freelo tasks description set "$TASK_ID" -
    done
```

## Errors

| Trigger                                                      | code               | exit |
| ------------------------------------------------------------ | ------------------ | ---- |
| `<id>` non-numeric / non-positive                            | `VALIDATION_ERROR` | 2    |
| No source flag                                               | `VALIDATION_ERROR` | 2    |
| Two source flags                                             | `VALIDATION_ERROR` | 2    |
| `--from-file` with missing file (`ENOENT`)                   | `VALIDATION_ERROR` | 2    |
| `--from-file` pointing at a directory (`EISDIR`)             | `VALIDATION_ERROR` | 2    |
| `--from-file` unreadable (`EACCES` / `EPERM`)                | `VALIDATION_ERROR` | 2    |
| `--editor` in non-TTY                                        | `VALIDATION_ERROR` | 2    |
| `--editor` exits non-zero / killed by signal                 | `VALIDATION_ERROR` | 2    |
| `--editor` editor command cannot be launched                 | `VALIDATION_ERROR` | 2    |
| Empty content (any source)                                   | `VALIDATION_ERROR` | 2    |
| Unexpected positional after `<id>` (anything other than `-`) | `VALIDATION_ERROR` | 2    |
| POST 401                                                     | `AUTH_EXPIRED`     | 3    |
| POST 403                                                     | `FORBIDDEN`        | 4    |
| POST 404 (task missing)                                      | `NOT_FOUND`        | 4    |
| POST 5xx / 422                                               | `FREELO_API_ERROR` | 4    |
| HTTP 429                                                     | `RATE_LIMITED`     | 6    |
| Network failure                                              | `NETWORK_ERROR`    | 5    |

## Non-goals

- **No `--files` / multipart attachments** in v1 — the multipart upload
  helper lands at R25 (see `docs/roadmap.md`).
- **No batch input** (`--ids` / `--stdin` NDJSON of `{id, content}`) —
  single-mode only in v1. The shared `src/lib/input.ts` reads **content**
  from one source; mass-replication of the same body across many tasks
  is tracked for a future slice.
- **No append / patch semantics** — the Freelo API endpoint is upsert-only
  (overwrites entirely). To preserve existing content, use `--editor` (the
  current body is pre-populated) or fetch via `freelo tasks description
get` and concatenate locally.
- **No confirmation gate.** Despite the upsert overwrite, the command is
  not flagged destructive — the same precedent as `tasks edit
--description` (R10). `--dry-run` is the safety net.

See [spec 0026](../specs/0026-tasks-description.md) for the full design,
the editor-resolution decision log, and the mandatory test list.
