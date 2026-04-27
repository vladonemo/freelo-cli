---
'freelo-cli': minor
---

R16 — `freelo comments list`. The first command in a brand-new top-level
`comments` subcommand:

- `freelo comments list [--project <id> ...] [--type <all|task|document|file|link>]
  [--order-by <date_add|date_edited_at>] [--order <asc|desc>]
  [--page N | --all] [--since YYYY-MM-DD]` — paginated read of the global
  comment feed, ACL-filtered to whatever the caller can see. Maps to
  `GET /all-comments`.

**One new envelope schema (additive surface):**

- `freelo.comments.list/v1` — `{ applied_filters, comments: CommentFull[] }`
  plus envelope-level `paging` and `rate_limit`. `applied_filters` echoes
  only the keys the user explicitly set; `comments[]` includes all the
  documented `CommentFull` shape variants (task, document, file, link
  comments, discriminated by which entity-link block is non-null).

**Client-side `--since` post-filter.** Freelo's `/all-comments` endpoint
accepts no time-window query parameter, so `--since` is implemented
client-side: under `--all` with the default `desc` order, iteration
short-circuits the moment a fetched page's last item predates the cutoff.
Under `--order asc`, the short-circuit is disabled and iteration continues
to exhaustion (post-filtering each page individually). `--since` is mutex
with `--page N` to avoid silent under-counting.

**Out of scope for v1 (deferred):**

- No `--task` flag. The original R16 roadmap entry mentioned
  `GET /task/{task_id}/comments`, but that endpoint is not in
  `docs/api/freelo-api.yaml` (only the POST counterpart is documented).
  Task-scoped listing is deferred until Freelo confirms the GET exists
  undocumented or adds it. Tracked as Open Question #1 in spec 0027.
- No `--per-page`, `--cursor`, or `--fields` flags in v1 — all
  future-additive.

No new dependencies. Reuses the standard pagination infrastructure
(`fetchAllPages`, `pagingFromNormalized`, `PartialPagesError`) from R03 /
R14, the `buildQuery` query-encoder from R07, and the `UserBasic` schema
from R03.
