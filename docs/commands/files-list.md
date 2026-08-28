# freelo files list

Browse every directory, link, file, and document the caller can see across accessible projects, with optional filters by project and item type. Maps to Freelo's `GET /all-docs-and-files` endpoint.

## Synopsis

```bash
freelo files list [--project <id> ...] [--type doc|file|link|dir]
                  [--page N | --all]
```

## Options

| Flag             | Type / values                    | Default   | Purpose                                                                                                                                                                      |
| ---------------- | -------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--project <id>` | positive int (repeatable)        | —         | Filter to assets under these projects (OR across ids). Maps to wire `projects_ids[]`.                                                                                        |
| `--type <kind>`  | one of `doc`/`file`/`link`/`dir` | —         | Filter to one item type. CLI uses short forms; the wire enum (`document`/`file`/`link`/`directory`) is mapped at parse time. Single-valued — `--type` is **not** repeatable. |
| `--page <n>`     | 1-indexed positive int           | (omitted) | Single-page mode. **Mutex** with `--all`. CLI is 1-indexed (`--page 1` = first page); the wire is 0-indexed.                                                                 |
| `--all`          | boolean                          | false     | Iterate every page client-side until exhausted. **Mutex** with `--page`. On mid-stream failure, emits a partial envelope + `notice`.                                         |

`--output`, `--color`, `--profile`, `-v`/`-vv`, `--request-id` are inherited
global flags.

### `--type` mapping

| CLI value | Wire value  |
| --------- | ----------- |
| `doc`     | `document`  |
| `file`    | `file`      |
| `link`    | `link`      |
| `dir`     | `directory` |

The envelope's `applied_filters.type` carries the **wire form**, so an agent that round-trips through Freelo's REST gets a string it can pass straight through.

## Permissions

- API key with read access to the projects whose assets you want to see. The endpoint is **ACL-filtered** server-side — only items the caller can read are included.
- Without `--project`, the listing spans **every** project the caller can see — useful for cross-project library / backup workflows.

## Envelope

`schema: "freelo.files.list/v1"`

```json
{
  "schema": "freelo.files.list/v1",
  "data": {
    "applied_filters": {
      "projects": [11],
      "type": "document"
    },
    "items": [
      {
        "uuid": "aaaaaaaa-1111-1111-1111-111111111111",
        "name": "Architecture Notes",
        "author": { "id": 7, "fullname": "Alice" },
        "project": { "id": 11, "name": "Apollo" },
        "directory_uuid": null,
        "date_add": "2026-04-25T10:00:00Z",
        "order": 1,
        "type": "document",
        "size": 4096,
        "note": "Internal docs"
      }
    ]
  },
  "paging": { "page": 0, "per_page": 25, "total": 137, "next_cursor": 1 },
  "rate_limit": { "remaining": 41, "reset_at": "2026-04-29T20:30:00Z" }
}
```

`applied_filters` echoes only the keys you explicitly set. Unset keys are omitted (so a flagless invocation produces `applied_filters: {}`).

### Field reference

- **`uuid`** — server-assigned UUID; load-bearing identity. Use it for `freelo files download` (R27).
- **`name`** — human-readable display name. Nullable on some rows.
- **`type`** — one of `directory`, `link`, `file`, `document` (wire enum).
- **`author`** — who created the item.
- **`project`** — owning project context block.
- **`directory_uuid`** — parent directory's UUID, or `null` at project root.
- **`date_add`** — ISO timestamp the item was added.
- **`order`** — sort order within its container.
- **`filename`** / **`extension`** / **`mime_type`** / **`size`** — populated for `file` / `document` rows; null on `directory` / `link`.
- **`link`** / **`link_type`** — populated for `link` rows.
- **`items_count`** — populated for `directory` rows (count of children).
- **`note`** — optional free-text annotation.

## Examples

### Most-recent assets across every accessible project (default)

```bash
$ freelo files list
UUID      TYPE      NAME                PROJECT   AUTHOR  DATE        SIZE
aaaaaaaa… document  Architecture Notes  Apollo    Alice   2026-04-25  4.0 KB
bbbbbbbb… file      logo.png            Apollo    Alice   2026-04-20  2.4 MB
cccccccc… link      Project tracker     Mercury   Bob     2026-04-15  -
```

### Documents only, in one project

```bash
$ FREELO_API_KEY=$KEY FREELO_EMAIL=$EMAIL freelo files list \
    --project 235826 --type doc --output json
```

### All files across two projects, paginated client-side

```bash
$ freelo files list --project 11 --project 22 --type file --all --output json
```

### Build a library index with `jq`

```bash
$ freelo files list --type doc --all --output json \
    | jq -r '.data.items[] | [.project.name, .name, .uuid] | @tsv'
Apollo    Architecture Notes    aaaaaaaa-1111-1111-1111-111111111111
Mercury   Onboarding            eeeeeeee-5555-5555-5555-555555555555
```

### `--all` partial result on mid-stream failure

If `--all` succeeds for one or more pages then hits a 5xx, the partial result is emitted on stdout with a `notice`, and the underlying error is re-thrown to stderr. Agents resume from `paging.next_cursor`:

```bash
$ freelo files list --all --output json
{"schema":"freelo.files.list/v1","data":{"items":[...50 rows...]},"paging":{"page":0,"next_cursor":1},"notice":"Partial result; iteration aborted at page 1."}
freelo: SERVER_ERROR (HTTP 503)
$ echo $?
4
```

## Errors

| Trigger                                               | code               | exit |
| ----------------------------------------------------- | ------------------ | ---- |
| `--project` non-positive int / non-numeric            | `VALIDATION_ERROR` | 2    |
| `--type` not in `{doc, file, link, dir}`              | `VALIDATION_ERROR` | 2    |
| `--page` zero / negative / non-numeric                | `VALIDATION_ERROR` | 2    |
| `--page` and `--all` combined                         | `VALIDATION_ERROR` | 2    |
| GET 401                                               | `AUTH_EXPIRED`     | 3    |
| GET 403                                               | `FORBIDDEN`        | 4    |
| GET 404                                               | `NOT_FOUND`        | 4    |
| GET 5xx                                               | `SERVER_ERROR`     | 4    |
| HTTP 429 (after read-retry exhaustion)                | `RATE_LIMITED`     | 6    |
| Network failure                                       | `NETWORK_ERROR`    | 5    |
| Server returns a malformed `FileItem` row             | `VALIDATION_ERROR` | 4    |
| Mid-stream failure on `--all` after at least one page | (inner cause)      | 4-6  |

## Limitations (v1)

- **No `--task <id>` filter.** The roadmap line for R26 names a `--task <id>` flag, but `GET /all-docs-and-files` does not accept any task-scoped query parameter — only `projects_ids[]`, `type`, and `p` per the OpenAPI contract. No alternative task-scoped doc/file listing endpoint is documented. Tracked as potential R26.5; if you need task-attached files today, the practical workaround is to filter by `--project` and intersect with task data client-side.
- **No `--mime <type>` / `--extension <ext>` / `--name <pattern>` filters.** The wire endpoint does not surface these as server-side filters; client-side post-filter on `--all` is a future-additive option.
- **No `--directory <uuid>` filter.** `directory_uuid` is on the response shape but not in the documented query parameter list.
- **Multi-value `--type` not supported.** The wire enum is single-valued per the OpenAPI; pass one filter at a time.
- **No `--per-page` flag.** Server controls page size.
- **No `--fields` projection.** All `FileItem` fields are returned.
- **No write surface.** Upload is `freelo files upload` (R25). Download is `freelo files download` (R27). Deletion is [`freelo files delete`](./files-delete.md) (M07) — it takes the `uuid` values this command returns.

See [spec 0038](../specs/0038-r26-files-list.md) for the full design rationale, the deferral decision for `--task`, and the mandatory-test list.
