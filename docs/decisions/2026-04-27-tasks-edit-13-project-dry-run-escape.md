# Decision 13 — `--project` as dry-run escape hatch (matches R09)

**Run:** 2026-04-27-tasks-edit
**Phase:** Spec
**Agent:** orchestrator (delegated to architect)

**Question:** Dry-run still does one GET (the lookup). Can we let users skip it?

**Decision:** Allow `--project <id>` only with `--dry-run`. Without `--dry-run`, `--project` → `VALIDATION_ERROR`.

**Alternatives considered:**
- Always allow `--project` (skip the lookup).
- Only allow with `--dry-run` (chosen).
- Never allow `--project`.

**Rationale:** Same as R09 (decision 8 of spec 0019). The lookup is structurally cheap; the project id should always be derived from the task. The escape hatch matters only for offline/CI dry-runs where any HTTP is unwelcome. Forbidding it outside `--dry-run` keeps the live path's invariants tight.
