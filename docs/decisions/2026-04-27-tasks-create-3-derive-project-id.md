# Decision 3 — Derive `project_id` from `--tasklist`

**Run:** 2026-04-27-tasks-create
**Phase:** spec
**Agent:** orchestrator (acting as architect)

**Question:** The Freelo endpoint requires both `project_id` and `tasklist_id` in the path. Should the CLI ask for both, or derive one?

**Decision:** Single `--tasklist <id>` flag; project id is derived via `GET /tasklist/{id}` at command startup (using the existing `getTasklistDetail` from R06).

**Alternatives considered:**
- Require both `--project` and `--tasklist`: simpler implementation, no startup HTTP. But forces users to remember/look-up two ids.
- Add `--project` as optional override: agents would have to compute it anyway.

**Rationale:** Tasklist ids are unique across Freelo; the project id is a deterministic function of the tasklist. Saving the user the lookup is a clean ergonomic win, costing one cheap GET. `--project` is retained as a `--dry-run` escape hatch (decision 8).
