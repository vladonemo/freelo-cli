# Decision 10 — No automatic rollback on partial failure

**Run:** 2026-04-27-tasks-edit
**Phase:** Spec
**Agent:** orchestrator (delegated to architect)

**Question:** If remove-labels succeeds but add-labels fails, do we automatically rollback?

**Decision:** No rollback. Surface the error verbatim. `applied_changes` reflects only what the wire confirmed.

**Alternatives considered:**
- Best-effort rollback (re-add what we removed).
- No rollback, but emit a warning envelope alongside the error.
- No rollback (chosen).

**Rationale:** Freelo doesn't expose transactional semantics. Reversing the half-applied state ourselves multiplies the failure surface (the rollback can fail too). Agents that need atomicity must manage state. The honest `applied_changes` field gives them what they need to reason.
