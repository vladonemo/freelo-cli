# Decision 5 — Project `WorkReport` to a stable subset on the envelope

**Run:** 2026-04-28-2100-r20-time-stop-edit
**Phase:** spec
**Agent:** orchestrator (architect role)

**Question:** Echo wire `WorkReport` shape, or project to a stable subset?
**Decision:** Project to `{ id, date_add, date_reported, minutes, note, task, cost, worker, author }` with inner refs tightened.
**Alternatives considered:**
- Pass wire shape through with `.passthrough()` — rejected; the envelope is a public contract.
- Minimal subset (`{ id, minutes, task }`) — rejected; agents would have to chain `reports show` (R21).
- `WorkReportFull` shape — rejected; `/timetracking/stop` returns the simpler `WorkReport`, not the `allOf` extension.
**Rationale:** Same trade-off R19's status envelope made — pick agent-actionable fields, normalize names, drop the rest. Future R21 will own its own envelope.
