# Resume — 2026-04-27 22:50

**Paused at:** triage (Phase 1)
**Question:** Which shape should `freelo comments list` take, given the OpenAPI contract diverges from the R16 roadmap entry (no `GET /task/{task_id}/comments`, no task filter on `/all-comments`, no `since` query param)?
**Answer:** B
**Interpretation:** Ship `freelo comments list` mapped directly to `GET /all-comments` with flags `--project` (repeatable, → `projects_ids[]`), `--type <all|task|document|file|link>` (default `all`), `--order-by <date_add|date_edited_at>`, `--order <asc|desc>`, `--page N` / `--all`. Add a **client-side** `--since DATE` post-filter that stops pagination once `date_add < since` (server default order is `date_add desc`). Document explicitly: `--since` is client-side, requires `--all` or a single page, and is mutually exclusive with `--page N` (validation error if both set). Drop `--task` from this slice — defer task-scoping until Freelo confirms an undocumented GET or adds one. Re-enter from triage with the updated requirement; tier expected to drop from Red to Yellow (additive new command, additive schema, no auth/config touch).
