# Decision 6 — Always GET-after-write to refresh `data.task`

**Run:** 2026-04-27-tasks-edit
**Phase:** Spec / Implement
**Agent:** orchestrator (delegated to architect)

**Question:** `POST /task/{id}` returns `TaskDetail`. Do we use it directly or do an extra `GET /task/{id}` after?

**Decision:** Always GET-after-write.

**Alternatives considered:**
- Use the edit-POST response as `data.task` (saves one GET).
- Always GET-after-write (chosen).
- Conditionally GET only when label-diff endpoints were involved.

**Rationale:** Labels mutate out-of-band via the diff endpoints. The edit-POST's response wouldn't reflect those changes. Conditional refresh would give inconsistent freshness semantics. One extra GET per edit is cheap and gives agents a uniformly trustworthy `data.task`.
