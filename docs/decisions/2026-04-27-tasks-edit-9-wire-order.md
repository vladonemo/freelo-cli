# Decision 9 — Wire order: remove → add → edit → refresh

**Run:** 2026-04-27-tasks-edit
**Phase:** Spec
**Agent:** orchestrator (delegated to architect)

**Question:** When all four endpoints are involved, what's the wire order?

**Decision:** remove-labels → add-labels → edit-body → refresh-GET.

**Alternatives considered:**
- edit-body first (the "core" change).
- add-then-remove (additions before subtractions).
- remove-then-add-then-edit (chosen).

**Rationale:** Removing first means a partial-failure on add leaves the task in a "fewer labels" state — strictly safer than adding first and failing on remove (which would leave the task with extras). Edit body last means a 422 on the body doesn't waste rate-limit on the GET refresh.
