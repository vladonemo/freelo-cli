# Decision 6 — `applied_changes` only carries keys the user actually passed

**Run:** 2026-04-28-2100-r20-time-stop-edit
**Phase:** spec
**Agent:** orchestrator (architect role)

**Question:** Should `applied_changes` always carry both `task_id` and `note` (with nulls for "not set"), or only the keys the user passed?
**Decision:** Only the keys the user passed. Mirrors the wire body shape exactly.
**Alternatives considered:**
- Always echo both with `null` for "not touched" — rejected; conflates "not touched" with "explicitly set to null" (decision 3 cares about the distinction).
**Rationale:** Wire-clean parity. Agents read `if ('task_id' in applied_changes)` to know if the user touched the task field.
