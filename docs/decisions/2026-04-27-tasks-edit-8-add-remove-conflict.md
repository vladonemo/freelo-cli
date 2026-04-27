# Decision 8 — Same name in `--add-label` and `--remove-label` → `VALIDATION_ERROR`

**Run:** 2026-04-27-tasks-edit
**Phase:** Spec
**Agent:** orchestrator (delegated to architect)

**Question:** What does `--add-label urgent --remove-label urgent` do?

**Decision:** Reject with `VALIDATION_ERROR` (exit 2) at flag-parse time.

**Alternatives considered:**
- Order matters: process in CLI order. (Confusing — depends on flag order.)
- Always remove-then-add (label ends up on task).
- Always add-then-remove (label ends up off task).
- Reject (chosen).

**Rationale:** Order-dependent semantics are a footgun. Failing loud surfaces the user's intent ambiguity early. Easier than documenting a winner.
