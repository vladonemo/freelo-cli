# Decision 3 — Empty edit (no flags) is `VALIDATION_ERROR`

**Run:** 2026-04-27-tasks-edit
**Phase:** Spec
**Agent:** orchestrator (delegated to architect)

**Question:** What does `freelo tasks edit 9012` (no other flags) do?

**Decision:** Reject with `VALIDATION_ERROR` (exit 2).

**Alternatives considered:**
- Silent no-op success (exit 0).
- Reject with `VALIDATION_ERROR` (chosen).

**Rationale:** Agents calling `edit` with no diff is almost always a bug — a malformed flag or missing argument upstream. Failing loud catches that earlier than a silent no-op would.
