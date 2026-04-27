# freelo comments list

Browse the global activity feed of comments across every project, task, document, file, and link the caller can see. Maps to Freelo's `GET /all-comments` endpoint with optional filters by project, target type, and time-window.

## Synopsis

```bash
freelo comments list [--project <id> ...] [--type <all|task|document|file|link>]
                     [--order-by <date_add|date_edited_at>] [--order <asc|desc>]
                     [--page N | --all] [--since YYYY-MM-DD]
```

## Options

| Flag                   | Type / values                                           | Default    | Purpose                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--project <id>`       | positive int (repeatable)                               | —          | Filter to comments under these projects (OR across ids). Maps to wire `projects_ids[]`.                                                                                                                             |
| `--type <kind>`        | enum: `all` \| `task` \| `document` \| `file` \| `link` | `all`      | Comment-target type. Maps to wire `type`.                                                                                                                                                                           |
| `--order-by <field>`   | enum: `date_add` \| `date_edited_at`                    | `date_add` | Sort field. Maps to wire `order_by`.                                                                                                                                                                                |
| `--order <dir>`        | enum: `asc` \| `desc`                                   | `desc`     | Sort direction. Maps to wire `order`.                                                                                                                                                                               |
| `--page <n>`           | 1-indexed positive int                                  | (omitted)  | Single-page mode. **Mutex** with `--all` and `--since`. CLI is 1-indexed (`--page 1` = first page); the wire is 0-indexed.                                                                                          |
| `--all`                | boolean                                                 | false      | Iterate every page client-side until exhausted. **Mutex** with `--page`. On mid-stream failure, emits a partial envelope + `notice`.                                                                                |
| `--since <YYYY-MM-DD>` | ISO date                                                | (none)     | **Client-side** post-filter: only comments with `date_add` (or `date_edited_at` when `--order-by date_edited_at`) `>= since`. **Mutex** with `--page N`. See [Client-side filtering](#client-side-filtering) below. |

`--output`, `--color`, `--profile`, `-v`/`-vv`, `--request-id` are inherited
global flags.

## Permissions

- API key with read access to whichever comments are returned. The endpoint is **ACL-filtered** — only comments on entities the caller can read are included.
- No special role required.

## Envelope

`schema: "freelo.comments.list/v1"`

```json
{
  "schema": "freelo.comments.list/v1",
  "data": {
    "applied_filters": {
      "projects": [11, 22],
      "type": "task",
      "order_by": "date_add",
      "order": "desc",
      "since": "2026-04-15"
    },
    "comments": [
      {
        "id": 9001,
        "uuid": "11111111-1111-1111-1111-111111111111",
        "content": "Fresh comment about the task",
        "date_add": "2026-04-25T10:00:00Z",
        "date_edited_at": "2026-04-25T10:00:00Z",
        "author": { "id": 7, "fullname": "Alice" },
        "task": { "id": 9012, "name": "Wire up the dashboard" },
        "tasklist": { "id": 50, "name": "Sprint A" },
        "project": { "id": 11, "name": "Apollo" }
      }
    ]
  },
  "paging": { "page": 0, "per_page": 25, "total": 137, "next_cursor": 1 },
  "rate_limit": { "remaining": 41, "reset_at": "2026-04-27T20:30:00Z" }
}
```

`applied_filters` echoes only the keys you explicitly set. Unset keys are
omitted (so a flagless invocation produces `applied_filters: {}`).

The `comments[]` array is the post-filtered set when `--since` is active —
items predating the cutoff are removed from the array but **`paging` still
reflects the wire response** (server-side counts), not the post-filter
length. This is intentional: agents should never see CLI-fabricated server
numbers.

### Comment shapes

Comments are typed by which entity-link block is non-null:

- **Task comments** carry `task: { id, name }` and usually `project` + `tasklist`.
- **Document comments** carry `document: { uuid, name }`.
- **File comments** carry `file: { uuid }` and (rarely) `files: [...]`.
- **Link comments** carry `link: { uuid, name }`.

Exactly one of these blocks is populated per row; the others are absent or
`null`. The CLI's human renderer derives a `TYPE` column from this
discriminator.

## Client-side filtering

`--since` is implemented client-side because Freelo's `/all-comments`
endpoint accepts no time-window query parameter. Three rules govern its
behavior:

1. **Mutex with `--page N`.** Mixing them gives a misleading count (a
   fixed page might contain 0 matches with no signal about whether older
   pages have more). Validation error at parse time → exit 2.
2. **Under `--all` (default `--order desc`):** iteration short-circuits
   the moment a page's last item predates the cutoff. The cost is
   bounded — you only fetch as far back as needed plus one terminal page.
3. **Under `--all --order asc`:** short-circuit is **disabled** (you'd
   be iterating away from older items, so a single old item near the top
   doesn't tell us the rest of the feed predates `since`). The CLI still
   post-filters every page individually but iterates to exhaustion.

Without `--all` (default-page or `--page 1` modes), `--since` post-filters
only the fetched page. For exhaustive `--since` results, always pair with
`--all`.

`--since` is parsed as `YYYY-MM-DD` and treated as midnight UTC.

## Examples

### Default (most-recent comments)

```bash
$ freelo comments list
ID    TYPE  PROJECT  TASK                  AUTHOR  DATE_ADD    CONTENT
9001  task  Apollo   Wire up the dashboard Alice   2026-04-25  Fresh comment about the task
9004  doc   Mercury  -                     Dana    2026-04-20  Doc comment
```

### Filter to one or more projects

```bash
$ freelo comments list --project 11 --project 22 --output json
{"schema":"freelo.comments.list/v1","data":{"applied_filters":{"projects":[11,22]},"comments":[...]},...}
```

### Recent activity since a date (exhaustive)

```bash
$ freelo comments list --all --since 2026-04-01 --output ndjson
{"schema":"freelo.comments.list/v1","data":{...},"paging":{...},"rate_limit":{...}}
```

### Compose with `tasks show`

Because `freelo comments list` does not (yet — see Limitations) accept a
`--task` filter, agents that want comments for a specific task can pipe
through `jq`:

```bash
$ freelo comments list --type task --all --output ndjson \
    | jq 'select(.data.comments[].task.id == 9012)'
```

### `--all` partial result on mid-stream failure

If `--all` succeeds for one or more pages then hits a 5xx, the partial
result is emitted on stdout with a `notice`, and the underlying error is
re-thrown to stderr. Agents resume from `paging.next_cursor`:

```bash
$ freelo comments list --all --output json
{"schema":"freelo.comments.list/v1","data":{"comments":[...50 rows...]},"paging":{"page":0,...,"next_cursor":1},"notice":"Partial result; iteration aborted at page 1."}
freelo: SERVER_ERROR (HTTP 503)
$ echo $?
4
```

## Errors

| Trigger                                               | code               | exit |
| ----------------------------------------------------- | ------------------ | ---- |
| `--project` non-positive / non-integer                | `VALIDATION_ERROR` | 2    |
| `--type` / `--order-by` / `--order` invalid value     | `VALIDATION_ERROR` | 2    |
| `--page` zero / negative / non-numeric                | `VALIDATION_ERROR` | 2    |
| `--page` and `--all` combined                         | `VALIDATION_ERROR` | 2    |
| `--since` invalid format / unreal date                | `VALIDATION_ERROR` | 2    |
| `--since` combined with `--page <n>`                  | `VALIDATION_ERROR` | 2    |
| GET 401                                               | `AUTH_EXPIRED`     | 3    |
| GET 403                                               | `FORBIDDEN`        | 4    |
| GET 404                                               | `NOT_FOUND`        | 4    |
| GET 5xx                                               | `SERVER_ERROR`     | 4    |
| HTTP 429 (after read-retry exhaustion)                | `RATE_LIMITED`     | 6    |
| Network failure                                       | `NETWORK_ERROR`    | 5    |
| Mid-stream failure on `--all` after at least one page | (inner cause)      | 4-6  |

## Limitations (v1)

- **No `--task` flag.** Freelo's OpenAPI contract does not document a
  `GET /task/{task_id}/comments` endpoint, only the POST counterpart for
  creation. Task-scoped listing is deferred until the API confirms the
  endpoint exists or adds it. Track in roadmap entry **R16**.
- **No `--per-page` flag.** Server controls page size (default 25).
- **No `--cursor <n>` flag.** Use `--page` (1-indexed) instead. Future-additive.
- **No `--fields` projection.** All `CommentFull` fields are returned.

See [spec 0027](../specs/0027-comments-list.md) for the full design rationale, the open question about task-scoped listing, and the mandatory-test list.
