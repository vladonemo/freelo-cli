# Decision 2 — Defer `--started-at` on `time edit` to R20.5

**Run:** 2026-04-28-2100-r20-time-stop-edit
**Phase:** spec
**Agent:** orchestrator (architect role)

**Question:** Roadmap proposes `time edit [--started-at <ISO>]`. The OpenAPI body documents only `task_id` and `note`. Ship anyway, pause, or defer?
**Decision:** Defer to R20.5. Ship R20 with the documented edit body only.
**Alternatives considered:**
- Ship `--started-at` and POST `{ ..., date_reported: <ISO> }` — rejected; orchestrator hard rule against guessing API behavior.
- Pause and ask the human — rejected; the deferral path is direct precedent (R19 → R19.5).
- Drop `--started-at` permanently — rejected; backdating mid-flight is a real workflow.
**Rationale:** Mirror precedent. R19.5 introduced `--at` on `time start` after R19 shipped without it. R20.5 will do the same on `time edit`, contingent on either an OpenAPI update or a freelo-api-specialist fixture confirming the wire field name.
