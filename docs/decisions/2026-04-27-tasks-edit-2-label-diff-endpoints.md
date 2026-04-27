# Decision 2 — Label changes via diff endpoints, not edit-body `labels`

**Run:** 2026-04-27-tasks-edit
**Phase:** Spec
**Agent:** orchestrator (delegated to architect)

**Question:** The edit body whitelist (`POST /task/{id}`) accepts `labels[]`. Should R10 use it for label changes?

**Decision:** No. Use the explicit diff endpoints (`/task-labels/add-to-task/{id}`, `/remove-from-task/{id}`).

**Alternatives considered:**
- Use the edit-body `labels[]` to set the full label state (replace semantics).
- Use the diff endpoints exclusively (chosen).
- Mix: edit-body for replacements, diff endpoints for `--add-label`/`--remove-label` only.

**Rationale:** Keeps R10's surface symmetrical with R09 (where `--label` only adds). Keeps `applied_changes.labels_added` / `labels_removed` honest with explicit input names. A future `--set-labels` flag (idempotent replace) would use the edit-body path; defer until needed.
