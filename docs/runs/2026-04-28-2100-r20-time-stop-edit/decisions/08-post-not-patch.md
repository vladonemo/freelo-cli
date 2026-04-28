# Decision 8 — Implement `time edit` as POST (per OpenAPI), not PATCH (per roadmap)

**Run:** 2026-04-28-2100-r20-time-stop-edit
**Phase:** triage / spec
**Agent:** orchestrator

**Question:** Roadmap says `PATCH /timetracking/edit`. OpenAPI says `post:`. Which to implement?
**Decision:** POST. Follow the OpenAPI spec.
**Alternatives considered:**
- PATCH per roadmap — rejected; OpenAPI is authoritative per orchestrator hard rules.
- Pause and ask the human — rejected; orchestrator instructions explicitly prescribe the resolution: "If the OpenAPI spec contradicts the roadmap, follow the OpenAPI spec and note the discrepancy."
**Rationale:** Direct rule application. Documented in spec §1, §6, triage.md, and the changeset.
