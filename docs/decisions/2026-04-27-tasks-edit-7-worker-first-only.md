# Decision 7 — Repeatable `--worker`, first-only on wire (matches R09)

**Run:** 2026-04-27-tasks-edit
**Phase:** Spec
**Agent:** orchestrator (delegated to architect)

**Question:** The edit body accepts a single `worker` integer. What does `--worker 17 --worker 23` do?

**Decision:** Send only the first id; surface a `notice` listing the discarded ids.

**Alternatives considered:**
- Reject with `VALIDATION_ERROR` on repeats.
- Send the last id (last-write-wins).
- Send only the first id with a notice (chosen).

**Rationale:** Mirrors R09's behavior (decision 4 of spec 0019). Forward-compat ergonomics. R24 (`task-labels`) and a future multi-assignee surface (if it ever lands) would inherit the same pattern.
