# Decision 4 — Repeatable `--worker` accepts only the first id

**Run:** 2026-04-27-tasks-create
**Phase:** spec
**Agent:** orchestrator (acting as architect)

**Question:** Roadmap text shows `--worker <id>...` (variadic) but `TaskCreate.worker` is a single integer in the API contract. How to reconcile?

**Decision:** Accept repeats on the CLI; only the first id is sent on the wire; an envelope `notice` lists discarded ids.

**Alternatives considered:**
- Reject repeats with `ValidationError` — least-surprise but breaks the roadmap signature.
- Send all and let the server pick — the contract says single integer; this would be misuse.
- Drop the repeatability altogether — diverges from R10 which will have the variadic surface for assignment changes.

**Rationale:** Forward-compat with R10 + transparent to agents (notice carries the discarded ids). No silent data loss.
