# freelo files upload

Upload one or more local files to Freelo. Returns a UUID per file. Optionally posts a comment on a task that references the uploaded files via the documented `<a data-freelo-uuid>` anchor mechanism.

> First multipart-body command in the CLI. Uses Node's built-in `FormData` and `fetch`. The OpenAPI spec documents a hard 100 MB limit per upload (yaml :3873) — the CLI enforces it locally so you don't waste a 100 MB egress to learn the server says 400.

## Synopsis

```bash
freelo files upload <path>... [--attach-to-task <id>] [--message <str>]
                              [--dry-run] [--no-spinner]
```

## Arguments

| Argument    | Notes                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<path>...` | One or more local file paths. Each must exist, be a regular file, and be ≤ 100 MB. **Globs are NOT expanded by the CLI** — your shell expands `**/*.png` before the CLI sees the argv. |

## Options

| Flag                    | Type / values    | Default | Purpose                                                                                                                                                                                                                                                           |
| ----------------------- | ---------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--attach-to-task <id>` | positive int     | —       | Numeric task id. After uploads succeed, posts a comment on this task whose content embeds `<a data-freelo-uuid="UUID">filename</a>` anchors for each uploaded file. This is the **only documented attach mechanism** — see "Why a comment, not `files[]`?" below. |
| `--message <str>`       | non-empty string | —       | Comment content prefix when `--attach-to-task` is set. The CLI appends `\n\nAttached: <a …>name</a>, …` after your message. Without `--message`, a default `Attached: …` comment is synthesized (spec 0037 decision 03).                                          |
| `--dry-run`             | bool             | false   | Skip every POST. Envelope echoes one `would` per planned upload (and one for the comment, if `--attach-to-task` is set). Local validation still runs (existence, size).                                                                                           |
| `--no-spinner`          | bool             | false   | Disable the TTY progress spinner. The spinner is also auto-disabled in CI / non-TTY / piped output regardless of this flag.                                                                                                                                       |

## Permissions

- The caller must have access to a project the file ends up in (no explicit upload ACL — uploads return a UUID; the file becomes visible only when referenced from a comment / description / pin).
- `--attach-to-task` requires comment-create permission on the target task.

## Why a comment, not `files[]`?

The OpenAPI spec is internally inconsistent:

- `POST /file/upload` returns `{ uuid }` (yaml :3905).
- The global `FileUpload` schema used by `comments.files[]` requires `download_url` and `filename` (yaml :5563), which the upload response does not provide.
- The `/file/upload` description (yaml :3876) explicitly documents a different attach mechanism: embed `<a data-freelo-uuid="{uuid}">caption</a>` in comment content.

The CLI implements the documented anchor approach — see [spec 0037 decision 02](../specs/0037-r25-files-upload.md). If a future API change makes `download_url` resolvable from the upload response, R26 (`files list` exposes `download_url`) is the natural place to add a `--use-files-array` flag.

## Envelope

`schema: "freelo.files.upload/v1"`

```json
{
  "schema": "freelo.files.upload/v1",
  "data": {
    "uploaded": [
      {
        "path": "report.pdf",
        "filename": "report.pdf",
        "bytes": 12345,
        "uuid": "11111111-1111-1111-1111-111111111111"
      }
    ],
    "failed": [],
    "count": { "requested": 1, "uploaded": 1, "failed": 0 },
    "attached": {
      "task_id": 4711,
      "comment_id": 99812,
      "file_uuids": ["11111111-1111-1111-1111-111111111111"]
    }
  },
  "rate_limit": { "remaining": 999, "reset_at": "2026-04-29T12:00:00Z" }
}
```

Field notes:

- `uploaded[]` and `failed[]` carry per-path entries — `count` is a triple `{ requested, uploaded, failed }` as a renderer convenience.
- `attached` is present **only** when `--attach-to-task` is set AND the comment-create succeeded.
- On `--dry-run`, `data.would` is an **array** of POST descriptors (1 to N+1 entries — one per upload, plus an optional comment-create). It is an array (not a single object) because R25 makes 1..N+1 POSTs per invocation — see [spec 0037 decision 10](../specs/0037-r25-files-upload.md).
- `rate_limit` reflects the most recent successful HTTP response (last upload or the comment-create).

## Examples

### Upload a single file

```bash
$ freelo files upload report.pdf --output json
{
  "schema": "freelo.files.upload/v1",
  "data": {
    "uploaded": [{ "path": "report.pdf", "filename": "report.pdf", "bytes": 23456, "uuid": "abc..." }],
    "failed": [],
    "count": { "requested": 1, "uploaded": 1, "failed": 0 }
  }
}
```

### Upload multiple files and attach to a task

```bash
$ freelo files upload diagram.svg report.pdf --attach-to-task 4711 \
    --message "Sprint review handoff" --output human
Uploaded 2 files:
  diagram.svg (e5f6g7h8-…, 4.5 KB)
  report.pdf (a1b2c3d4-…, 12.3 KB)
Attached to task 4711 (comment 99812).
```

### Dry-run a multi-file attach

```bash
$ freelo files upload a.txt b.txt --attach-to-task 4711 --dry-run --output json
{
  "schema": "freelo.files.upload/v1",
  "dry_run": true,
  "data": {
    "uploaded": [],
    "failed": [],
    "count": { "requested": 2, "uploaded": 0, "failed": 0 },
    "would": [
      { "method": "POST", "path": "/file/upload", "body": { "multipart": { "file": "a.txt", "bytes": 12 } } },
      { "method": "POST", "path": "/file/upload", "body": { "multipart": { "file": "b.txt", "bytes": 34 } } },
      { "method": "POST", "path": "/task/4711/comments", "body": { "content": "Attached: <a data-freelo-uuid=\"00000000-0000-0000-0000-000000000000\">a.txt</a>, …" } }
    ]
  }
}
```

The `00000000-…` UUIDs are placeholders; the real UUIDs are only known after a live upload.

### Multi-file partial failure

When some paths upload successfully and others fail, the command exits **4** with both arrays populated. If `--attach-to-task` is set, the comment is still posted with the surviving UUIDs:

```bash
$ freelo files upload good.txt bad.txt --attach-to-task 4711 --output json
{
  "schema": "freelo.files.upload/v1",
  "data": {
    "uploaded": [{ "path": "good.txt", "uuid": "abc...", "bytes": 4, "filename": "good.txt" }],
    "failed": [{ "path": "bad.txt", "error": { "code": "SERVER_ERROR", "message": "Freelo API server error (HTTP 500)." } }],
    "count": { "requested": 2, "uploaded": 1, "failed": 1 },
    "attached": { "task_id": 4711, "comment_id": 99812, "file_uuids": ["abc..."] }
  }
}
$ echo $?
4
```

If **zero** uploads succeed, the command throws the original typed error (so single-path callers see the natural exit code routing — 3 for `AUTH_EXPIRED`, 4 for `SERVER_ERROR`, etc.).

## Exit codes

| Exit | When                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------- |
| 0    | All uploads OK; comment (if requested) OK.                                                                      |
| 2    | Local validation failed (missing path, directory, oversize, bad flag).                                          |
| 3    | Auth expired (`AUTH_EXPIRED` from any HTTP call).                                                               |
| 4    | Server error on upload or comment-create; partial-failure on multi-path; malformed response.                    |
| 5    | Network failure on the **first** upload (subsequent network failures land in `failed[]` and surface as exit 4). |

## Filename safety

The CLI HTML-escapes `<>&"'` in filenames before splicing them into the `<a data-freelo-uuid>` anchor. A file named `pwn<script>.txt` produces `pwn&lt;script&gt;.txt` in the comment body — Freelo's HTML renderer sees text, not script. The original (unescaped) filename remains in `data.uploaded[].filename` for agent assertions.

## See also

- [`freelo comments add`](comments-add.md) — adds a comment to a task without uploading files.
- Roadmap entry: R25 in [`docs/roadmap.md`](../roadmap.md).
- Spec: [0037-r25-files-upload](../specs/0037-r25-files-upload.md).
