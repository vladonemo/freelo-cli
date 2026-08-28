# Decision 3 — Envelope carries `count` and a conditional `project_id`

**Run:** 2026-08-25-1037-task-labels-find
**Phase:** spec
**Agent:** orchestrator (architect mandate)

**Question:** What goes in `freelo.task_labels.find/v1` beyond `labels[]`?

**Decision:** `{ labels, count, project_id? }`. `count` always present; `project_id` present only when `--project` was passed.

**Alternatives considered:**

- `labels[]` only, matching `freelo.labels.list/v1` exactly. Rejected: that would make the three sibling `task_labels.*` envelopes (create/attach/detach) the odd ones out — all three already carry `count`. Consistency within the resource group beat consistency with a different resource group.
- `project_id` always present, `null` when unscoped. Rejected: `null` vs. absent carries the same information here, and absent keeps the unscoped envelope minimal. The project's other envelopes use conditional spread for optional context fields.
- Add a `scoped: boolean`. Rejected: redundant — the presence of `project_id` already answers it.

**Rationale:** `count` saves every consumer a `.length` and is what the changeset tells scripts to branch on instead of the exit code. `project_id` exists so a consumer receiving an empty list can tell a scoped-and-empty result from an unscoped-and-empty one without re-reading argv — which matters precisely because the API refuses to explain *why* a list is empty (decision 4). No `paging`: the endpoint documents no pagination parameters.
