# Decision 1 — Defer `--task <id>` filter from R26 v1

**Run:** 2026-04-29-1756-r26-files-list
**Phase:** spec
**Agent:** orchestrator + architect

**Question:** The R26 roadmap line names a `--task <id>` filter for `freelo files list`, but `GET /all-docs-and-files` (the only documented list endpoint) accepts only `projects_ids[]`, `type`, and `p` per OpenAPI `:3925-3937`. There is no other documented endpoint for task-scoped doc/file listing. How should R26 v1 handle the missing capability?

**Decision:** Defer `--task <id>` from R26 v1. Implement the three filters the API supports (`--project`, `--type`, paging). Document the deferral in the spec's "Non-goals" section and in the `--help` text / doc page so agents reading the roadmap don't trip on the absence. Track as potential R26.5 if Freelo extends the endpoint.

**Alternatives considered:**
- **Pause the run.** Calibration §1 / autonomous-sdlc §"API behavior not in `docs/api/freelo-api.yaml`" lists this as a pause trigger. Considered but rejected: this isn't "guess the API" — it's "the API doesn't support a roadmap-named filter". Pausing every roadmap line that names an unimplementable filter would block 1-2 R-numbered slices indefinitely. R23 (labels list) hit the same shape (`--project` named, no attachment data on the wire) and chose to defer + document; that decision was logged and merged without complaint.
- **Walk per-task descriptions/comments to extract `<a data-freelo-uuid>` anchors.** Brittle (server-side rendering varies by markup mode), unbounded (one HTTP call per task, then per comment page), and out of scope for a thin list wrapper. Out.
- **Implement `--task` as a client-side post-filter on `--all`.** The output isn't queryable by task ID — `FileItem` carries `project` but not `task`. There's nothing to filter against client-side. Out.

**Rationale:** The roadmap is a planning artifact, not a contract with the API; deferring a flag the wire can't support is the correct read of "thin wrapper". The R23 precedent (defer `--project` because the API surfaced no attachment data) is the closest analog and was accepted at review. Pausing here would be cargo-culting Calibration §1 — that rule prohibits guessing endpoint shapes, not gracefully omitting un-implementable features.

The deferral is **discoverable**: the `--help` description, the doc page, the changeset, and the spec's Non-goals section all name the deferral and the cause (`endpoint does not surface a task filter`). Agents introspecting the CLI surface see exactly the three flags the wire supports.
