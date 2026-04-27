# Decision 4 — No `--stdin` NDJSON batch mode in v1

**Run:** 2026-04-27-tasks-edit
**Phase:** Spec
**Agent:** orchestrator (delegated to architect)

**Question:** R09 ships `--stdin` NDJSON batch mode. Should R10 follow suit?

**Decision:** No. Single-task only in v1.

**Alternatives considered:**
- Per-line `<id>` + per-line flags (NDJSON edits).
- Shared `<id>...` repeatable + same flags applied to every id.
- No batch mode (chosen).

**Rationale:** Both shapes are useful but pull in different directions. Roadmap doesn't call out batch for R10. A proper batch surface for `tasks edit` deserves a dedicated spec when a real use case appears. Defer until then.
