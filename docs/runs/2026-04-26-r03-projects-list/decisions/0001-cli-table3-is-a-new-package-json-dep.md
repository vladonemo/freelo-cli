# Decision 0001 — `cli-table3` is a new package.json dep

**Run:** 2026-04-26-r03-projects-list
**Phase:** triage
**Agent:** orchestrator

**Question:** The spec §0 says `cli-table3` is "already in `package.json`'s declared tech stack". Verifying `package.json` at HEAD (`6c4a2e8`) shows it is **not** in `dependencies`. Is this an undeclared blocker (Red) or a Yellow-tolerable additive dep?

**Decision:** Yellow-tolerable. Add `cli-table3` to `dependencies` in this slice; treat as pre-approved via `.claude/docs/tech-stack.md` declaration.

**Alternatives considered:**
- Pause and ask the human (rejected — spec resolution explicitly cited cli-table3 as the right tool for the job; tech-stack doc lists it; rationale already on record).
- Use a hand-rolled padded-row renderer instead (rejected — spec OQ#16 explicitly chose `cli-table3` over the auth-whoami padded-row pattern for tabular data).

**Rationale:** Tech-stack.md is the canonical dep allow-list; package.json being out of sync with it is a known drift, not a new approval gate. The spec already weighed and accepted the tradeoff. Yellow trigger "new non-security dependency" applies; this stays Yellow, not Red.
