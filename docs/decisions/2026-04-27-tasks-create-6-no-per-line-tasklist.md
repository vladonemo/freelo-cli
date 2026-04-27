# Decision 6 — Per-line `tasklist` field rejected

**Run:** 2026-04-27-tasks-create
**Phase:** spec
**Agent:** orchestrator (acting as architect)

**Question:** Should NDJSON lines override `--tasklist`?

**Decision:** No. Lines that carry a `tasklist` key fail with `ValidationError` for that line.

**Alternatives considered:**
- Allow per-line override: pure ergonomic upside but forces a project-id lookup per unique tasklist id, complicating startup.
- Silently ignore the `tasklist` key on a line: data loss, surprising.

**Rationale:** Keeps the project-id lookup deterministic (one at startup) and the contract clean. Mixed-tasklist batches are a v2 question.
