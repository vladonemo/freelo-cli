# Decision 12 — `applied_changes` shows what *succeeded*, not what was *requested*

**Run:** 2026-04-27-tasks-edit
**Phase:** Implement
**Agent:** implementer

**Question:** When a fan-out fails partway, does `applied_changes` show the user's intent or the actual wire state?

**Decision:** Wire state. The implementer threads accumulators that only get populated **after** the matching call succeeds.

**Alternatives considered:**
- Show user intent (mirror the flags).
- Show wire state (chosen).
- Show both (`requested` + `applied`).

**Rationale:** Honest accounting beats both alternatives. Agents that need user-intent can re-derive from the failed CLI invocation; honest wire state is what they cannot derive any other way.
